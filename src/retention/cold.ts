// Cold graphs (docs/RETENTION.md §6.2): graphs the app can fetch again (its own Turtle, a page's file),
// unloaded under memory pressure when nothing shown needs them, and back when a page needs them.
//
// The host registers the graphs it can fetch again as it loads them (`load`, or `prepare` and
// `arrived` around a change that adds them with other graphs). Each is a ret:ColdGraph node in
// urn:semblance:retention with its state (ret:Loaded, ret:Unloaded, ret:Kept) and size, which the
// Memory tool lists. The pressure effect asks `unload` in step 3, beside offloading history.
//
// - Provenance. Every file's triples go into the default graph, so the effect keeps what it needs to
//   take one file's out again and no more: a graph's blank nodes are labelled by the graph and their
//   order in its text (`parse`), so its text read again gives the very triples the store holds; a
//   triple stated by more than one graph (or by the store before the graph came) is counted, and
//   leaves only with the last that states it.
// - In use. A graph is in use while one of the nodes it types is shown or placed in a projection
//   (demand, or a child in the rendered tree), while where we are is a place that needs it (a
//   location value with ret:needs, for a page that reads cold graphs without showing their nodes),
//   or while the host says the page shown needs it (a static build's index of the graphs each page
//   needs). A graph that states what a person owns or what the whole app reads (an instance of a
//   class, or a property, marked ret:keepsGraph: a per:Policy, a stream, a command the palette
//   lists) is kept, never unloaded.
// - What a person changed stays. Unloading removes the graph's own statements that are still there;
//   what the person (or an effect) added about its nodes is left alone, and what they removed is
//   remembered, so the graph comes back as it was when it left.
// - Back. A change that moves to a place that needs it brings it back in that change (Runtime.
//   onBeforeApply), so the page renders with it, as on a fresh visit. A node of it placed in a
//   projection (a page that shows it is shown, through a switch, a tab, a link followed) brings it
//   back at the end of the change, before the host patches the page: no empty page is ever shown.
//   So does a page the host says needs it. Rules and reactions it defines leave with it and join
//   again with it, as with any graph loaded later (Engine.process, EventBus).
//
// It costs what the graph holds, to unload and to load again, and nothing on an interaction but a
// look at the change's added objects and the rendered tree's new children.
import type { Quad, Term } from '@rdfjs/types'
import { DataFactory, Parser } from 'n3'
import { H, NS, RETENTION_GRAPH } from '../ns.ts'
import { quadKey } from '../rdf.ts'
import type { Runtime } from '../runtime.ts'
import type { GraphStore } from '../store/types.ts'

const RET = NS.ret
const RDF_TYPE = NS.rdf + 'type'
const declaresNeeds = (q: Quad) => q.predicate.value === NS.ret + 'needs'
const declaresPlaces = (q: Quad) => q.predicate.value === NS.nav + 'property' || q.predicate.value === NS.nav + 'subject'

/** The node that stands for a cold graph, by the name the host fetches it by. */
export const coldGraphIri = (name: string) => 'urn:semblance:graph:' + name

export type ColdState = 'loaded' | 'unloaded' | 'kept'

export interface ColdGraphsOptions {
  /** A graph's text by its name (the host's loader: a module, a fetch). */
  fetch(name: string): string | Promise<string>
  /** The graphs the page shown needs, where the host knows it (a static build's index): kept, and brought back. */
  needs?(): readonly string[] | undefined
  /** After a graph came back outside a change the host patches for (its text was fetched). */
  onChange?(): void
  /** The clock (ms). */
  now?(): number
}

interface Cold {
  name: string
  node: string
  state: ColdState
  size: number
  /** The named nodes it types: shown or placed, they keep it; placed while it is out, they bring it back. */
  subjects: string[]
  /** While unloaded: its statements that were gone when it left (a person changed them), not put back. */
  missing?: Set<string>
  /** When it was last seen in use (ms). */
  used: number
  loading?: Promise<void>
}

/** FNV-1a, base 36: a short stable key. */
const hash = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

export class ColdGraphs {
  private readonly graphs = new Map<string, Cold>()
  /** Statements of a triple beyond one, where more than one graph (or the store before) states it. */
  private readonly shares = new Map<string, number>()
  /** The nodes of unloaded graphs, by node: placed, they bring their graph back. */
  private readonly watched = new Map<string, Cold>()
  /** Graphs to bring back at the end of the change. */
  private readonly wanted = new Set<Cold>()
  private readonly prefixes = new Map<string, string>()
  private pending: Record<string, Quad[]> | undefined
  private runtime?: Runtime
  private queued = false
  /** The last host needs taken in (an array the host keeps while its page is the same). */
  private lastNeeds?: readonly string[]

  constructor(
    readonly store: GraphStore,
    readonly opts: ColdGraphsOptions,
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now()
  }

  /**
   * A graph's triples, as this effect loads them: its blank nodes labelled by the graph and their
   * order in the text, so reading the same text again gives the same triples.
   */
  parse(name: string, text: string): Quad[] {
    const f = this.store.factory
    let prefix = 'cg' + hash(name)
    while (this.prefixes.has(prefix) && this.prefixes.get(prefix) !== name) prefix += 'x'
    this.prefixes.set(prefix, name)
    const blanks = new Map<string, Term>()
    const term = (t: Term): Term => {
      if (t.termType === 'NamedNode') return f.namedNode(t.value)
      if (t.termType === 'Literal') return f.literal(t.value, t.language || f.namedNode(t.datatype.value))
      if (t.termType !== 'BlankNode') return t
      let b = blanks.get(t.value)
      if (!b) blanks.set(t.value, (b = DataFactory.blankNode(`${prefix}_${blanks.size}`)))
      return b
    }
    return new Parser({ format: 'text/turtle' }).parse(text).map((q) => f.quad(term(q.subject as Term), term(q.predicate as Term), term(q.object as Term)))
  }

  /** Graphs added to the store now, before any projection: what they share is counted, and they are registered. */
  load(graphs: Record<string, Quad[]>): void {
    this.prepare(graphs)
    for (const qs of Object.values(graphs)) for (const q of qs) if (!this.store.has(q)) this.store.add(q)
    this.arrived()
  }

  /**
   * Graphs about to be added, with `others` (what else the same change adds): what they share with
   * the store, each other and those is counted. Register them with `arrived` once all of it is in.
   */
  prepare(graphs: Record<string, Quad[]>, others: Iterable<Quad> = []): void {
    const batch = new Map<string, { q: Quad; n: number }>()
    for (const qs of Object.values(graphs)) {
      const seen = new Set<string>()
      for (const q of qs) {
        if (q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode') continue
        const k = quadKey(q)
        if (seen.has(k)) continue
        seen.add(k)
        const e = batch.get(k)
        if (e) e.n++
        else batch.set(k, { q, n: 1 })
      }
    }
    // What else the change adds, looked at by subject first (most of it states nothing these do).
    const subjects = new Set<string>()
    for (const { q } of batch.values()) subjects.add(q.subject.value)
    const alsoOthers = new Set<string>()
    for (const q of others) {
      if (!subjects.has(q.subject.value)) continue
      const k = quadKey(q)
      if (batch.has(k)) alsoOthers.add(k)
    }
    for (const [k, { q, n }] of batch) {
      const total = n + (this.store.has(q) ? 1 : 0) + (alsoOthers.has(k) ? 1 : 0)
      if (total > 1) this.shares.set(k, (this.shares.get(k) ?? 0) + total - 1)
    }
    this.pending = { ...this.pending, ...graphs }
  }

  /** The graphs `prepare` was told of are in the store: registered, as loaded. */
  arrived(): void {
    const graphs = this.pending ?? {}
    this.pending = undefined
    const now = this.now()
    for (const [name, qs] of Object.entries(graphs)) {
      const subjects = new Set<string>()
      for (const q of qs) if (q.predicate.value === RDF_TYPE && q.subject.termType === 'NamedNode') subjects.add(q.subject.value)
      const g: Cold = { name, node: coldGraphIri(name), state: 'loaded', size: qs.length, subjects: [...subjects], used: now }
      this.graphs.set(name, g)
      this.record(g)
    }
  }

  /** Each registered graph and its state. */
  list(): { name: string; state: ColdState; size: number }[] {
    return [...this.graphs.values()].map(({ name, state, size }) => ({ name, state, size }))
  }

  /** How many graphs are unloaded now. */
  get unloadedCount(): number {
    let n = 0
    for (const g of this.graphs.values()) if (g.state === 'unloaded') n++
    return n
  }

  /**
   * Follow the runtime: a node of an unloaded graph placed in a projection, or a page the host says
   * needs it, brings it back at the end of the change. Returns a stop.
   */
  attach(runtime: Runtime): () => void {
    this.runtime = runtime
    const stops = runtime.projections.map((p) =>
      p.engine.onChange((d) => {
        if (!this.watched.size) return
        for (const q of d.add) {
          if (q.predicate.value !== H.hasChild) continue
          const g = this.watched.get(q.object.value)
          if (g) this.wanted.add(g)
        }
        // A change with no input (a refresh, idle time): at the next microtask.
        if (this.wanted.size && !this.queued) {
          this.queued = true
          queueMicrotask(() => {
            this.queued = false
            this.bringBack()
          })
        }
      }),
    )
    // A move to a place that needs some: in the same change.
    const stopBefore = runtime.onBeforeApply((d) => this.beforeApply(d))
    // At the end of each change, before the host patches the page.
    const stopInput = runtime.onInput(() => {
      if (this.recordLater.size) {
        const done = [...this.recordLater]
        this.recordLater.clear()
        for (const g of done) this.record(g)
      }
      this.bringBack()
    })
    return () => {
      for (const s of stops) s()
      stopBefore()
      stopInput()
      this.runtime = undefined
    }
  }

  /** Whether a node is shown or placed in a projection. */
  private shown(node: string): boolean {
    for (const p of this.runtime?.projections ?? []) {
      const demand = p.engine.demand
      if (!demand || demand(node) || p.index.nodes.get(node)?.parents.size) return true
    }
    return false
  }

  /** What the host's page needs, of what is unloaded, is wanted. */
  private needed(): Set<string> {
    const needs = new Set(this.opts.needs?.() ?? [])
    for (const n of this.here()) needs.add(n)
    return needs
  }

  /** Bring back what was wanted: at once where its text is at hand, else when it is fetched. */
  private bringBack(): void {
    const runtime = this.runtime
    if (!runtime || runtime.ended) return
    const needs = this.opts.needs?.()
    if (needs && needs !== this.lastNeeds) {
      this.lastNeeds = needs
      for (const n of needs) {
        const g = this.graphs.get(n)
        if (g?.state === 'unloaded') this.wanted.add(g)
      }
    }
    // A graph that comes back may place nodes of another.
    for (let round = 0; this.wanted.size && round < 16; round++) {
      const now = [...this.wanted]
      this.wanted.clear()
      for (const g of now) void this.bring(g)
    }
  }

  /** Bring a graph back by its name (if it is out): its triples, but for what a person had removed. */
  reload(name: string): Promise<void> | void {
    const cold = this.graphs.get(name)
    if (cold) return this.bring(cold)
  }

  private bring(cold: Cold): Promise<void> | void {
    if (cold.state !== 'unloaded') return
    if (cold.loading) return cold.loading
    const text = this.opts.fetch(cold.name)
    if (typeof text === 'string') return this.reloadWith(cold, text)
    cold.loading = text.then(
      (t) => {
        cold.loading = undefined
        this.reloadWith(cold, t)
        this.opts.onChange?.()
      },
      (e) => {
        cold.loading = undefined
        console.warn(`[semblance] could not load ${cold.name} again`, e)
      },
    )
    return cold.loading
  }

  private reloadWith(g: Cold, text: string) {
    const runtime = this.runtime
    if (!runtime || runtime.ended || g.state !== 'unloaded') return
    runtime.apply({ add: this.restore(g, text), remove: [] })
    this.record(g)
  }

  /** A graph's triples to add again (it is loaded from now on): its text's, but for what a person had removed. */
  private restore(g: Cold, text: string): Quad[] {
    const missing = g.missing ?? new Set<string>()
    const add: Quad[] = []
    for (const q of this.parse(g.name, text)) {
      const k = quadKey(q)
      if (missing.has(k)) continue
      // Stated again by something else meanwhile: counted, so it outlives this graph.
      if (this.store.has(q)) {
        if (q.subject.termType !== 'BlankNode' && q.object.termType !== 'BlankNode') this.shares.set(k, (this.shares.get(k) ?? 0) + 1)
        continue
      }
      add.push(q)
    }
    g.missing = undefined
    g.state = 'loaded'
    g.used = this.now()
    for (const s of g.subjects) if (this.watched.get(s) === g) this.watched.delete(s)
    return add
  }

  /** Places (location values) and the graphs they need (ret:needs; '*' for ret:AllColdGraphs). */
  private placeNeeds?: Map<string, Set<string>>
  private places(): Map<string, Set<string>> {
    if (this.placeNeeds) return this.placeNeeds
    const f = this.store.factory
    const out = new Map<string, Set<string>>()
    const prefix = coldGraphIri('')
    for (const q of this.store.match(null, f.namedNode(RET + 'needs'), null, f.defaultGraph())) {
      const o = q.object.value
      const name = o === RET + 'AllColdGraphs' ? '*' : o.startsWith(prefix) ? o.slice(prefix.length) : undefined
      if (name === undefined) continue
      let s = out.get(q.subject.value)
      if (!s) out.set(q.subject.value, (s = new Set()))
      s.add(name)
    }
    return (this.placeNeeds = out)
  }

  /** "subject property" of each location dimension (nav:subject, nav:property). */
  private dimensionKeys?: Set<string>
  private dimensions(): Set<string> {
    if (this.dimensionKeys) return this.dimensionKeys
    const f = this.store.factory
    const dg = f.defaultGraph()
    const out = new Set<string>()
    for (const q of this.store.match(null, f.namedNode(NS.nav + 'property'), null, dg)) {
      const s = this.store.match(q.subject as never, f.namedNode(NS.nav + 'subject'), null, dg)[0]?.object
      if (s) out.add(s.value + ' ' + q.object.value)
    }
    return (this.dimensionKeys = out)
  }

  /** The graphs (by name, '*' for all) that where we are needs: the location's values in effect (nav:Dimension). */
  private here(moving?: Map<string, string>): Set<string> {
    const places = this.places()
    const out = new Set<string>()
    if (!places.size) return out
    const f = this.store.factory
    const dg = f.defaultGraph()
    const nav = (p: string) => f.namedNode(NS.nav + p)
    const value = (dim: Term) => {
      const s = this.store.match(dim as never, nav('subject'), null, dg)[0]?.object
      const p = this.store.match(dim as never, nav('property'), null, dg)[0]?.object
      if (!s || !p) return undefined
      return moving?.get(s.value + ' ' + p.value) ?? this.store.match(s as never, p as never, null, dg)[0]?.object.value
    }
    // A dimension is in effect while its parent's value is the one it is for (nav:parent, nav:when).
    const inEffect = (dim: Term, depth = 0): boolean => {
      const parent = this.store.match(dim as never, nav('parent'), null, dg)[0]?.object
      if (!parent || depth > 8) return true
      const when = this.store.match(dim as never, nav('when'), null, dg)[0]?.object.value
      return (when === undefined || value(parent) === when) && inEffect(parent, depth + 1)
    }
    for (const q of this.store.match(null, nav('property'), null, dg)) {
      const v = value(q.subject)
      const need = v === undefined ? undefined : places.get(v)
      if (need && inEffect(q.subject)) for (const n of need) out.add(n)
    }
    return out
  }

  /**
   * A change that moves to a place that needs cold graphs (a location value with ret:needs) brings
   * those that are out back in the same change, so the page renders with them, as on a fresh visit.
   */
  private beforeApply(delta: { add: Quad[]; remove: Quad[] }): Quad[] | undefined {
    if (delta.add.some(declaresNeeds) || delta.remove.some(declaresNeeds)) this.placeNeeds = undefined
    if (delta.add.some(declaresPlaces) || delta.remove.some(declaresPlaces)) this.dimensionKeys = undefined
    if (!this.watched.size) return undefined
    const places = this.places()
    if (!places.size) return undefined
    // Where the change moves to: the location's values it sets (nav:Dimension), then what is in effect there.
    const dimensions = this.dimensions()
    let moving: Map<string, string> | undefined
    for (const q of delta.add) {
      const k = q.subject.value + ' ' + q.predicate.value
      if (dimensions.has(k)) (moving ??= new Map()).set(k, q.object.value)
    }
    if (!moving) return undefined
    const wanted = this.here(moving)
    if (!wanted.size) return undefined
    const add: Quad[] = []
    for (const g of this.graphs.values()) {
      if (g.state !== 'unloaded' || !(wanted.has('*') || wanted.has(g.name))) continue
      const text = this.opts.fetch(g.name)
      // Not at hand: it comes back when fetched, after the change.
      if (typeof text !== 'string') {
        this.wanted.add(g)
        continue
      }
      add.push(...this.restore(g, text))
      this.recordLater.add(g)
    }
    return add
  }
  /** Graphs that came back inside a change: their state is written at its end. */
  private readonly recordLater = new Set<Cold>()

  /** Whether one of a graph's nodes is shown or placed in a projection, or the host's page needs it. */
  private inUse(g: Cold, needs: Set<string>): boolean {
    if (needs.has(g.name) || needs.has('*')) return true
    for (const s of g.subjects) if (this.shown(s)) return true
    return false
  }

  /** The classes and properties a graph that states them (an instance, a use) is kept for (ret:keepsGraph). */
  private keeps(): Set<string> {
    const f = this.store.factory
    return new Set(this.store.match(null, f.namedNode(RET + 'keepsGraph'), null, f.defaultGraph()).filter((q) => q.object.value === 'true').map((q) => q.subject.value))
  }

  /**
   * Unload what is not in use (step 3 of pressure): at Critical every cold graph nothing shown needs,
   * at Elevated those nothing has needed for `after` ms. All of it leaves as one change (the engines
   * read their rules again at most once). Returns how many triples left.
   */
  async unload(level: 'elevated' | 'critical', after = 60_000): Promise<number> {
    const runtime = this.runtime
    if (!runtime || runtime.ended) return 0
    const now = this.now()
    const needs = this.needed()
    const candidates: Cold[] = []
    for (const g of this.graphs.values()) {
      if (g.state !== 'loaded' || g.loading) continue
      if (this.inUse(g, needs)) g.used = now
      else if (level === 'critical' || now - g.used >= after) candidates.push(g)
    }
    if (!candidates.length) return 0
    const texts = await Promise.all(candidates.map((g) => this.opts.fetch(g.name)))
    if (runtime.ended) return 0
    const keeps = this.keeps()
    const remove: Quad[] = []
    const changed: Cold[] = []
    candidates.forEach((g, i) => {
      // (Something may have shown it, or brought it back, while its text was fetched.)
      if (g.state !== 'loaded' || this.inUse(g, needs)) return
      const quads = this.parse(g.name, texts[i]!)
      changed.push(g)
      if (quads.some((q) => keeps.has(q.predicate.value) || (q.predicate.value === RDF_TYPE && keeps.has(q.object.value)))) {
        g.state = 'kept'
        return
      }
      const missing = new Set<string>()
      for (const q of quads) {
        const key = quadKey(q)
        if (!this.store.has(q)) {
          missing.add(key)
          continue
        }
        const shared = this.shares.get(key) ?? 0
        if (shared > 0) {
          // Another graph states it too: it stays, with one statement fewer.
          if (shared === 1) this.shares.delete(key)
          else this.shares.set(key, shared - 1)
          continue
        }
        remove.push(q)
      }
      g.missing = missing
      g.state = 'unloaded'
      for (const s of g.subjects) this.watched.set(s, g)
    })
    runtime.transaction(() => {
      if (remove.length) runtime.apply({ add: [], remove })
      for (const g of changed) this.record(g)
    })
    return remove.length
  }

  /** The graph's node and state, in urn:semblance:retention. */
  private record(g: Cold) {
    const f = this.store.factory
    const nn = (iri: string) => f.namedNode(iri)
    const graph = nn(RETENTION_GRAPH)
    const node = nn(g.node)
    const state = nn(RET + g.state[0]!.toUpperCase() + g.state.slice(1))
    const remove = this.store.match(node, nn(RET + 'state'), null, graph).filter((q) => !q.object.equals(state))
    const add: Quad[] = []
    if (!this.store.match(node, nn(RDF_TYPE), nn(RET + 'ColdGraph'), graph).length) {
      add.push(f.quad(node, nn(RDF_TYPE), nn(RET + 'ColdGraph'), graph), f.quad(node, nn(RET + 'source'), f.literal(g.name), graph), f.quad(node, nn(RET + 'size'), f.literal(String(g.size), nn(NS.xsd + 'integer')), graph))
    }
    if (!this.store.match(node, nn(RET + 'state'), state, graph).length) add.push(f.quad(node, nn(RET + 'state'), state, graph))
    if (!add.length && !remove.length) return
    if (this.runtime && !this.runtime.ended) this.runtime.write(RETENTION_GRAPH, { add, remove })
    else {
      for (const q of remove) this.store.delete(q)
      for (const q of add) this.store.add(q)
    }
  }
}
