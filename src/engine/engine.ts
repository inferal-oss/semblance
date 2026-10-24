import type { NamedNode, Quad, Quad_Graph } from '@rdfjs/types'
import { H, NS, PROV, RDF_TYPE, SEM } from '../ns.ts'
import { type Delta, mint, owningFocus, quadKey } from '../rdf.ts'
import type { GraphStore } from '../store/types.ts'
import { createContext, type FnRule, type RuleContext } from './context.ts'
import { loadRules, type Rule, type Selection, selectRules, superclasses } from './rules.ts'

export interface EngineOptions {
  modality: string
  layers?: Iterable<string>
  prefer?: 'sparql' | 'function'
  functions?: Record<string, FnRule>
  /** Record PROV-O provenance for every derived node (see ontology/layers/provenance.ttl). */
  provenance?: boolean
  /** Evaluate a SPARQL rule once for all dirty foci when at least this many are dirty. */
  bulkThreshold?: number
  /** Distinguishes engines sharing a store; names the derived graph. */
  name?: string
  /** Further named graphs rules read as input (e.g. the change-log LDES). */
  inputGraphs?: string[]
}

export interface EngineStats {
  /** Time and evaluations per rule IRI (bulk evaluations count once). */
  byRule: Map<string, { runs: number; ms: number }>
  ruleRuns: number
  queries: number
  bulkQueries: number
  fnCalls: number
  derivedAdded: number
  derivedRemoved: number
}

type Listener = (delta: Delta) => void

const warn = (msg: string) => console.warn(`[semblance] ${msg}`)

/**
 * Member-wise rules (sem:forEach) evaluate per (focus, member); the pair is keyed
 * as "focus member" (a space never occurs in an IRI).
 */
const SEP = ' '
const focusOf = (key: string) => {
  const i = key.indexOf(SEP)
  return i < 0 ? key : key.slice(0, i)
}
const memberOf = (key: string) => {
  const i = key.indexOf(SEP)
  return i < 0 ? undefined : key.slice(i + 1)
}

/** Triples about a focus that never invalidate it: its placement and its provenance. */
const isPlacementOrProvenance = (p: string) => p.startsWith(H.ns) || p.startsWith(NS.ord) || p.startsWith(NS.prov) || p === SEM.orderKey

/**
 * Incremental, stratified projection of a component graph into RDF/HTML.
 *
 * Each (rule, focus) pair owns an output set. When input or derived triples
 * change, the affected pairs are marked dirty and re-evaluated in stratum
 * order; their outputs are diffed, reference-counted (two rules may assert the
 * same triple) and written to this engine's derived graph. Net changes of a
 * run are reported to listeners as one delta.
 */
export class Engine {
  readonly graph: NamedNode
  /** The PROV-O software agent standing for this projection. */
  readonly agent: NamedNode
  readonly stats: EngineStats = { byRule: new Map(), ruleRuns: 0, queries: 0, bulkQueries: 0, fnCalls: 0, derivedAdded: 0, derivedRemoved: 0 }
  private readonly allRules: Rule[]
  private rules: Rule[] = []
  private strata: number[] = []
  private selection: Selection
  private readonly functions: Record<string, FnRule>
  private readonly provenance: boolean
  private readonly bulkThreshold: number
  private readonly graphs: Quad_Graph[]
  private readonly supers: (cls: string) => Set<string>
  private ctx: RuleContext

  private rulesByClass = new Map<string, Rule[]>()
  private followers = new Map<string, Rule[]>()
  /** focus -> classes that have rules */
  private types = new Map<string, Set<string>>()
  /** object -> followed predicate -> subjects */
  private links = new Map<string, Map<string, Set<string>>>()
  private outputs = new Map<Rule, Map<string, Map<string, Quad>>>()
  /** Traced reads of function rules: subject -> rule -> focus -> predicates read ('*' = any). */
  private readers = new Map<string, Map<Rule, Map<string, Set<string>>>>()
  /** The inverse, to retract a pair's previous reads: rule -> focus -> subjects. */
  private readsOf = new Map<Rule, Map<string, string[]>>()
  private refs = new Map<string, { q: Quad; n: number }>()
  private dirty = new Map<number, Map<Rule, Set<string>>>()
  /** Member-wise rules: rule -> focus -> member keys with output (to retract them). */
  private memberKeys = new Map<Rule, Map<string, Set<string>>>()
  private current = -Infinity
  /** The (rule, focus) whose output is being committed: its own writes never re-dirty it. */
  private committing?: { rule: Rule; focus: string }
  /** Evaluations per (rule, focus) in the current run, to catch rules that never settle. */
  private evaluations = new Map<string, number>()
  private pending = { add: new Map<string, Quad>(), remove: new Map<string, Quad>() }
  private listeners: Listener[] = []
  /**
   * Demand-driven evaluation: when set, (rule, focus) pairs whose focus is not
   * demanded (e.g. not shown) are parked instead of evaluated, until resume().
   */
  demand?: (focus: string) => boolean
  private deferred = new Map<Rule, Set<string>>()
  /** While warming, parked work is evaluated regardless of demand. */
  private warming = false

  constructor(
    readonly store: GraphStore,
    opts: EngineOptions,
  ) {
    const f = store.factory
    this.graph = f.namedNode('urn:semblance:derived:' + (opts.name ?? 'main'))
    this.agent = f.namedNode('urn:semblance:projection:' + (opts.name ?? 'main'))
    this.graphs = [f.defaultGraph(), ...(opts.inputGraphs ?? []).map((g) => f.namedNode(g)), this.graph]
    this.functions = opts.functions ?? {}
    this.provenance = opts.provenance ?? false
    this.bulkThreshold = opts.bulkThreshold ?? 16
    this.supers = superclasses(store)
    this.allRules = loadRules(store)
    this.selection = { modality: opts.modality, layers: new Set(opts.layers ?? []), prefer: opts.prefer ?? 'sparql', sparql: store.sparql }
    this.ctx = createContext(store, this.graphs, opts.modality)
    this.activate(selectRules(this.allRules, this.selection, warn))
  }

  get activeRules(): readonly Rule[] {
    return this.rules
  }

  /** Active rules that currently produce output for at least one focus. */
  rulesInUse(): Rule[] {
    return this.rules.filter((r) => (this.outputs.get(r)?.size ?? 0) > 0)
  }

  /** Number of distinct derived triples currently asserted. */
  get derivedSize(): number {
    return this.refs.size
  }

  /** Sizes of the engine's bookkeeping, for leak checks: all must stay bounded by what is derived. */
  footprint(): Record<string, number> {
    let outputs = 0
    for (const byFocus of this.outputs.values()) outputs += byFocus.size
    let readers = 0
    for (const byRule of this.readers.values()) for (const foci of byRule.values()) readers += foci.size
    let readsOf = 0
    for (const byFocus of this.readsOf.values()) readsOf += byFocus.size
    let deferred = 0
    for (const foci of this.deferred.values()) deferred += foci.size
    let members = 0
    for (const byOwner of this.memberKeys.values()) for (const keys of byOwner.values()) members += keys.size
    return { refs: this.refs.size, outputs, readerSubjects: this.readers.size, readers, readsOf, deferred, members, types: this.types.size, links: this.links.size }
  }

  onChange(listener: Listener): () => void {
    this.listeners.push(listener)
    return () => (this.listeners = this.listeners.filter((l) => l !== listener))
  }

  /** Initial projection of everything already in the store. */
  start(): void {
    this.reindex()
    for (const [focus, classes] of this.types) for (const cls of classes) for (const r of this.rulesFor(cls)) this.markFocus(r, focus)
    this.run()
  }

  /** Propagate a change that has already been applied to the store's default graph. */
  process(delta: Delta): void {
    for (const q of delta.remove) this.propagate(q, -1)
    for (const q of delta.add) this.propagate(q, 1)
    this.run()
  }

  /** Whether any undemanded work is parked. */
  get hasDeferred(): boolean {
    for (const foci of this.deferred.values()) if (foci.size) return true
    return false
  }

  /**
   * Evaluate parked work regardless of demand, in small slices, for at most
   * `budgetMs` (e.g. in idle time): hidden views become ready before they are
   * shown, and interactions never pay for them. Returns whether work remains.
   */
  warm(budgetMs: number, slice = 16): boolean {
    if (!this.demand) return false
    const until = performance.now() + budgetMs
    this.warming = true
    try {
      while (performance.now() < until) {
        let picked = 0
        for (const [rule, foci] of this.deferred) {
          for (const focus of foci) {
            foci.delete(focus)
            this.markDirty(rule, focus)
            if (++picked >= slice) break
          }
          if (picked >= slice) break
        }
        if (!picked) break
        this.run()
      }
    } finally {
      this.warming = false
    }
    return this.hasDeferred
  }

  /** Evaluate parked pairs whose focus is now demanded. Returns whether anything ran. */
  resume(): boolean {
    if (!this.demand) return false
    let any = false
    for (const [rule, foci] of this.deferred) {
      for (const focus of foci) {
        if (this.demand(focusOf(focus)) || !this.isInstance(focus, rule)) {
          foci.delete(focus)
          this.markDirty(rule, focus)
          any = true
        }
      }
    }
    if (any) this.run()
    return any
  }

  /**
   * Switch modality, layers or implementation preference. Rules that are no
   * longer selected retract their output; every selected rule is re-evaluated
   * (kept rules may read what the retracted ones produced) and diffing keeps
   * the resulting delta minimal.
   */
  reconfigure(sel: Partial<Selection>): void {
    this.selection = { ...this.selection, ...sel }
    if (sel.modality) this.ctx = createContext(this.store, this.graphs, sel.modality)
    const after = selectRules(this.allRules, this.selection, warn)
    // Swapping modality or implementations can change every output: re-evaluate all.
    // Otherwise (layers) only added rules run; rules reading what changed are
    // re-run by ordinary propagation (traced reads, sem:readsMinted).
    const full = sel.modality !== undefined || sel.prefer !== undefined
    const before = new Set(this.rules)
    const kept = new Set(full ? [] : after.filter((r) => before.has(r)))
    for (const r of this.rules) if (!kept.has(r)) for (const focus of [...(this.outputs.get(r)?.keys() ?? [])]) this.commit(r, focus, [])
    for (const r of this.rules) if (!kept.has(r)) this.outputs.delete(r), this.memberKeys.delete(r)
    // Keep what the retractions dirtied for rules that stay; drop the rest.
    for (const byRule of this.dirty.values()) for (const r of [...byRule.keys()]) if (!kept.has(r)) byRule.delete(r)
    this.activate(after)
    this.reindex()
    for (const [focus, classes] of this.types) for (const c of classes) for (const r of this.rulesFor(c)) if (!kept.has(r)) this.markFocus(r, focus)
    this.run()
  }

  /** Which rule produced a derived node, and for which focus. */
  explain(node: string): { rule: string; focus: string } | undefined {
    for (let focus = owningFocus(node); ; focus = owningFocus(focus)) {
      for (const [rule, byFocus] of this.outputs) {
        const keys = rule.forEach ? [...(this.memberKeys.get(rule)?.get(focus) ?? [])] : [focus]
        for (const key of keys) for (const q of byFocus.get(key)?.values() ?? []) if (q.subject.value === node) return { rule: rule.iri, focus }
      }
      if (owningFocus(focus) === focus) return undefined
    }
  }

  /** Remove everything this engine derived from the store. */
  dispose(): void {
    for (const { q } of this.refs.values()) this.store.delete(q)
    this.refs.clear()
    this.outputs.clear()
  }

  // --- rule bookkeeping ------------------------------------------------------

  private activate(rules: Rule[]) {
    this.rules = rules
    this.strata = [...new Set(rules.map((r) => r.stratum))].sort((a, b) => a - b)
    this.rulesByClass.clear()
    this.followers.clear()
    for (const r of rules) for (const p of r.follows) this.followers.set(p, [...(this.followers.get(p) ?? []), r])
    for (const r of rules) {
      if (r.kind === 'function' && !this.functions[r.fn!]) throw new Error(`No function registered for "${r.fn}" (rule <${r.iri}>)`)
      if (r.kind === 'sparql' && !this.store.sparql) throw new Error(`Store "${this.store.kind}" cannot run SPARQL rule <${r.iri}>`)
      if (r.kind === 'sparql' && r.forEach) throw new Error(`Member-wise (sem:forEach) rules must be functions (rule <${r.iri}>)`)
    }
  }

  /** Rebuild the instance and follow-link indexes from the input and derived graphs. */
  private reindex() {
    const f = this.store.factory
    this.types.clear()
    this.links.clear()
    for (const g of this.graphs) {
      for (const q of this.store.match(null, f.namedNode(RDF_TYPE), null, g)) this.index(q, 1)
      for (const p of this.followers.keys()) for (const q of this.store.match(null, f.namedNode(p), null, g)) this.index(q, 1)
    }
  }

  private rulesFor(cls: string): Rule[] {
    let rs = this.rulesByClass.get(cls)
    if (!rs) {
      const supers = this.supers(cls)
      this.rulesByClass.set(cls, (rs = this.rules.filter((r) => supers.has(r.target))))
    }
    return rs
  }

  private isInstance(focus: string, rule: Rule): boolean {
    const classes = this.types.get(focusOf(focus))
    if (classes) for (const c of classes) if (this.supers(c).has(rule.target)) return true
    return false
  }

  private watched(rule: Rule, focus: string, predicate: string): boolean {
    if (rule.watches) return rule.watches.has(predicate)
    const fn = rule.kind === 'function' ? this.functions[rule.fn!] : undefined
    return fn?.watches ? fn.watches(this.ctx, this.store.factory.namedNode(focus)).has(predicate) : true
  }

  private markDirty(rule: Rule, focus: string) {
    if (rule.stratum < this.current) {
      throw new Error(`Stratification violation: stratum ${this.current} invalidated <${rule.iri}> (stratum ${rule.stratum}) for <${focus}>`)
    }
    let byRule = this.dirty.get(rule.stratum)
    if (!byRule) this.dirty.set(rule.stratum, (byRule = new Map()))
    let foci = byRule.get(rule)
    if (!foci) byRule.set(rule, (foci = new Set()))
    foci.add(focus)
  }

  /** Dirty a rule for a focus: for a member-wise rule, every current and previous member. */
  private markFocus(rule: Rule, focus: string) {
    if (!rule.forEach) return this.markDirty(rule, focus)
    const f = this.store.factory
    for (const g of this.graphs) {
      for (const q of this.store.match(f.namedNode(focus), f.namedNode(rule.forEach), null, g)) {
        if (q.object.termType === 'NamedNode') this.markDirty(rule, focus + SEP + q.object.value)
      }
    }
    for (const key of this.memberKeys.get(rule)?.get(focus) ?? []) this.markDirty(rule, key)
  }

  /** Whether a member-wise pair's link (`focus forEach member`) still holds. */
  private linked(rule: Rule, key: string): boolean {
    const member = memberOf(key)
    if (!rule.forEach || member === undefined) return true
    const f = this.store.factory
    const [s, p, o] = [f.namedNode(focusOf(key)), f.namedNode(rule.forEach), f.namedNode(member)]
    return this.graphs.some((g) => this.store.match(s, p, o, g).length > 0)
  }

  // --- change propagation ----------------------------------------------------

  /** Keep the instance and follow-link indexes current. */
  private index(q: Quad, sign: 1 | -1) {
    const s = q.subject.value
    const p = q.predicate.value
    if (p === RDF_TYPE && this.rulesFor(q.object.value).length) {
      let classes = this.types.get(s)
      if (sign > 0) {
        if (!classes) this.types.set(s, (classes = new Set()))
        classes.add(q.object.value)
      } else if (classes) {
        classes.delete(q.object.value)
        if (!classes.size) this.types.delete(s)
      }
    }
    if (this.followers.has(p) && q.object.termType === 'NamedNode') {
      const o = q.object.value
      let byPred = this.links.get(o)
      if (!byPred) this.links.set(o, (byPred = new Map()))
      let subjects = byPred.get(p)
      if (!subjects) byPred.set(p, (subjects = new Set()))
      if (sign > 0) subjects.add(s)
      else {
        subjects.delete(s)
        if (!subjects.size) byPred.delete(p)
        if (!byPred.size) this.links.delete(o)
      }
    }
  }

  private propagate(q: Quad, sign: 1 | -1) {
    const s = q.subject.value
    const p = q.predicate.value
    // Removing a type: dirty its rules while the instance is still indexed, so
    // they re-run, find the focus gone, and retract their output.
    if (p === RDF_TYPE) for (const r of this.rulesFor(q.object.value)) this.markFocus(r, s)
    if (sign < 0) this.index(q, sign)
    // A rule never reads its focus's own placement (where a parent put it) or
    // provenance, so those triples about a focus don't invalidate it.
    const classes = isPlacementOrProvenance(p) ? undefined : this.types.get(s)
    if (classes) {
      for (const c of classes) {
        for (const r of this.rulesFor(c)) {
          // A member link touches only that member's evaluation.
          if (r.forEach === p) {
            if (q.object.termType === 'NamedNode') this.markDirty(r, s + SEP + q.object.value)
          } else if (this.watched(r, s, p)) this.markFocus(r, s)
        }
      }
    }
    const back = this.links.get(s)
    if (back) {
      for (const [fp, subjects] of back) {
        for (const r of this.followers.get(fp) ?? []) {
          for (const x of subjects) if (this.isInstance(x, r) && this.watched(r, x, p)) this.markFocus(r, x)
        }
      }
    }
    // Function rules that read this subject (traced) re-run if they read this predicate.
    const readers = this.readers.get(s)
    if (readers) {
      for (const [r, foci] of readers) {
        if (r.stratum < this.current) continue
        for (const [focus, preds] of foci) {
          if (this.committing?.rule === r && this.committing.focus === focus) continue
          if (preds.has('*') || preds.has(p)) this.markDirty(r, focus)
        }
      }
    }
    // Rules that read what was minted under their focus (e.g. the tooltip layer)
    // re-run when a lower stratum changes it.
    const owner = owningFocus(s)
    if (owner !== s) {
      const ownerClasses = this.types.get(owner)
      if (ownerClasses) {
        for (const c of ownerClasses) for (const r of this.rulesFor(c)) if (r.readsMinted && r.stratum > this.current) this.markFocus(r, owner)
      }
    }
    if (sign > 0) this.index(q, sign)
  }

  // --- evaluation ------------------------------------------------------------

  private run() {
    try {
      for (const stratum of this.strata) {
        this.current = stratum
        for (let batch = this.dirty.get(stratum); batch?.size; batch = this.dirty.get(stratum)) {
          this.dirty.set(stratum, new Map())
          for (const [rule, foci] of batch) this.evaluate(rule, foci)
        }
      }
    } finally {
      this.current = -Infinity
      this.evaluations.clear()
    }
    const { add, remove } = this.pending
    if (!add.size && !remove.size) return
    this.pending = { add: new Map(), remove: new Map() }
    const delta = { add: [...add.values()], remove: [...remove.values()] }
    for (const l of this.listeners) l(delta)
  }

  private evaluate(rule: Rule, foci: Set<string>) {
    const t = performance.now()
    try {
      this.evaluateAll(rule, foci)
    } finally {
      const entry = this.stats.byRule.get(rule.iri) ?? { runs: 0, ms: 0 }
      entry.runs += rule.kind === 'sparql' && foci.size >= this.bulkThreshold ? 1 : foci.size
      entry.ms += performance.now() - t
      this.stats.byRule.set(rule.iri, entry)
    }
  }

  private evaluateAll(rule: Rule, foci: Set<string>) {
    if (this.demand && !this.warming) {
      // Park undemanded foci (retractions always run, so nothing stale stays visible).
      let parked = this.deferred.get(rule)
      for (const focus of [...foci]) {
        if (this.isInstance(focus, rule) && !this.demand(focusOf(focus))) {
          if (!parked) this.deferred.set(rule, (parked = new Set()))
          parked.add(focus)
          foci.delete(focus)
        }
      }
      if (!foci.size) return
      for (const focus of foci) parked?.delete(focus)
    }
    if (rule.kind === 'sparql' && foci.size >= this.bulkThreshold) {
      const groups = this.bulk(rule)
      for (const focus of foci) this.commit(rule, focus, this.isInstance(focus, rule) ? (groups.get(focus) ?? []) : [])
      return
    }
    for (const focus of foci) this.commit(rule, focus, this.isInstance(focus, rule) && this.linked(rule, focus) ? this.evaluateOne(rule, focus) : [])
  }

  private evaluateOne(rule: Rule, focus: string): Quad[] {
    this.stats.ruleRuns++
    if (rule.kind === 'function') {
      this.stats.fnCalls++
      const trace = new Map<string, Set<string>>()
      this.ctx.trace = trace
      try {
        const f = this.store.factory
        const member = memberOf(focus)
        return this.functions[rule.fn!]!(this.ctx, f.namedNode(focusOf(focus)), member === undefined ? undefined : f.namedNode(member))
      } finally {
        this.ctx.trace = undefined
        this.recordReads(rule, focus, trace)
      }
    }
    this.stats.queries++
    return this.construct(rule, rule.queryParts!.join('<' + focus + '>'))
  }

  /** Drop a (rule, focus) pair's traced reads. */
  private forgetReads(rule: Rule, focus: string) {
    const byFocus = this.readsOf.get(rule)
    for (const subject of byFocus?.get(focus) ?? []) {
      const byRule = this.readers.get(subject)
      const foci = byRule?.get(rule)
      if (!foci) continue
      foci.delete(focus)
      if (!foci.size) byRule!.delete(rule)
      if (!byRule!.size) this.readers.delete(subject)
    }
    byFocus?.delete(focus)
  }

  /** Replace a (rule, focus) pair's traced reads. */
  private recordReads(rule: Rule, focus: string, trace: Map<string, Set<string>>) {
    this.forgetReads(rule, focus)
    let byFocus = this.readsOf.get(rule)
    if (!byFocus) this.readsOf.set(rule, (byFocus = new Map()))
    trace.delete(focusOf(focus)) // the focus's own triples are covered by its self-watch
    if (!trace.size) return
    byFocus.set(focus, [...trace.keys()])
    for (const [subject, preds] of trace) {
      let byRule = this.readers.get(subject)
      if (!byRule) this.readers.set(subject, (byRule = new Map()))
      let foci = byRule.get(rule)
      if (!foci) byRule.set(rule, (foci = new Map()))
      foci.set(focus, preds)
    }
  }

  private bulk(rule: Rule): Map<string, Quad[]> {
    this.stats.bulkQueries++
    const groups = new Map<string, Quad[]>()
    for (const q of this.construct(rule, rule.queryParts!.join('?this'))) {
      const focus = owningFocus(q.subject.value)
      let g = groups.get(focus)
      if (!g) groups.set(focus, (g = []))
      g.push(q)
    }
    return groups
  }

  private construct(rule: Rule, query: string): Quad[] {
    try {
      return this.store.construct(query, this.graphs)
    } catch (e) {
      throw new Error(`SPARQL rule <${rule.iri}> failed: ${(e as Error).message}`)
    }
  }

  private commit(rule: Rule, focus: string, quads: Quad[]) {
    const pair = rule.iri + ' ' + focus
    const n = (this.evaluations.get(pair) ?? 0) + 1
    this.evaluations.set(pair, n)
    if (n > 100) throw new Error(`Rule <${rule.iri}> does not settle for <${focus}>: its output keeps invalidating itself`)
    let byFocus = this.outputs.get(rule)
    if (!byFocus) this.outputs.set(rule, (byFocus = new Map()))
    const prev = byFocus.get(focus)
    const next = new Map<string, Quad>()
    const f = this.store.factory
    for (const q of quads) {
      if (q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode') {
        throw new Error(`Rule <${rule.iri}> emitted a blank node for <${focus}>; mint IRIs instead`)
      }
      next.set(quadKey(q), q)
    }
    if (this.provenance && next.size) for (const p of this.provenanceOf(rule, focus, quads)) next.set(quadKey(p), p)
    this.committing = { rule, focus }
    try {
      if (prev) for (const [k, q] of prev) if (!next.has(k)) this.release(k, q)
      for (const [k, q] of next) if (!prev?.has(k)) this.retain(k, q)
    } finally {
      this.committing = undefined
    }
    if (next.size) byFocus.set(focus, next)
    else {
      byFocus.delete(focus)
      // A pair with nothing to show no longer needs to hear about what it read,
      // unless it is still an instance (its next input may produce output).
      if (!this.isInstance(focus, rule) || !this.linked(rule, focus)) this.forgetReads(rule, focus)
    }
    if (rule.forEach && memberOf(focus) !== undefined) {
      let byOwner = this.memberKeys.get(rule)
      if (!byOwner) this.memberKeys.set(rule, (byOwner = new Map()))
      const owner = focusOf(focus)
      let keys = byOwner.get(owner)
      if (next.size) {
        if (!keys) byOwner.set(owner, (keys = new Set()))
        keys.add(focus)
      } else if (keys) {
        keys.delete(focus)
        if (!keys.size) byOwner.delete(owner)
      }
    }
  }

  /**
   * PROV-O for one (rule, focus) evaluation: an activity that used the focus
   * and the nodes the rule follows, carried out by this projection with the
   * rule as its plan. Nodes the output types were generated by the activity;
   * other nodes it wrote to (decorations) were influenced by it.
   */
  private provenanceOf(rule: Rule, focus: string, quads: Quad[]): Quad[] {
    const f = this.store.factory
    const nn = (iri: string) => f.namedNode(iri)
    const g = this.graph
    const local = rule.iri.slice(Math.max(rule.iri.lastIndexOf('#'), rule.iri.lastIndexOf('/')) + 1)
    const member = memberOf(focus)
    focus = focusOf(focus)
    const activity = nn(mint(focus, 'prov-' + encodeURIComponent(local) + (member === undefined ? '' : '-' + encodeURIComponent(member))))
    const association = nn(activity.value + '-association')
    const out = [
      f.quad(activity, nn(RDF_TYPE), nn(PROV.Activity), g),
      f.quad(activity, nn(PROV.wasAssociatedWith), this.agent, g),
      f.quad(this.agent, nn(RDF_TYPE), nn(PROV.SoftwareAgent), g),
      f.quad(activity, nn(PROV.qualifiedAssociation), association, g),
      f.quad(association, nn(RDF_TYPE), nn(PROV.Association), g),
      f.quad(association, nn(PROV.agent), this.agent, g),
      f.quad(association, nn(PROV.hadPlan), nn(rule.iri), g),
      f.quad(activity, nn(PROV.used), nn(focus), g),
      ...(member === undefined ? [] : [f.quad(activity, nn(PROV.used), nn(member), g)]),
    ]
    for (const p of rule.follows) {
      for (const q of this.store.match(nn(focus), nn(p), null)) if (q.object.termType === 'NamedNode') out.push(f.quad(activity, nn(PROV.used), q.object, g))
    }
    // Text nodes and attribute occurrences are covered by their element's provenance.
    const generated = new Set<string>()
    const minor = new Set<string>()
    for (const q of quads) {
      if (q.predicate.value !== RDF_TYPE || q.subject.value === focus) continue
      if (q.object.value === H.Text || q.object.value === H.Attribute) minor.add(q.subject.value)
      else generated.add(q.subject.value)
    }
    const touched = new Set(quads.map((q) => q.subject.value).filter((s) => !minor.has(s)))
    for (const s of touched) {
      if (s === focus) continue
      out.push(f.quad(nn(s), nn(generated.has(s) ? PROV.wasGeneratedBy : PROV.wasInfluencedBy), activity, g))
    }
    return out
  }

  private retain(key: string, q: Quad) {
    const ref = this.refs.get(key)
    if (ref) return void ref.n++
    const f = this.store.factory
    const stored = q.graph.equals(this.graph) ? q : f.quad(q.subject, q.predicate, q.object, this.graph)
    this.store.add(stored)
    this.refs.set(key, { q: stored, n: 1 })
    this.stats.derivedAdded++
    if (!this.pending.remove.delete(key)) this.pending.add.set(key, stored)
    this.propagate(stored, 1)
  }

  private release(key: string, _q: Quad) {
    const ref = this.refs.get(key)!
    if (--ref.n) return
    this.store.delete(ref.q)
    this.refs.delete(key)
    this.stats.derivedRemoved++
    if (!this.pending.add.delete(key)) this.pending.remove.set(key, ref.q)
    this.propagate(ref.q, -1)
  }
}
