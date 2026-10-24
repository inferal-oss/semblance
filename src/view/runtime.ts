// Maintained views (docs/IVM.md): queries whose results are kept up to date from the
// changes to their inputs, one tick per transaction of the Runtime. Phase 1 maintains
// aggregates over LDES members (stream-aggregate plans); any other view is recomputed
// from scratch when its inputs change, and says so (iv:fallback).
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import { createContext, type RuleContext } from '../engine/context.ts'
import { NS, PROV, RDF_TYPE, SEM } from '../ns.ts'
import { prefixesFor } from '../prefixes.ts'
import { type Delta, mint, owningFocus, parseDuration, quadKey, termKey } from '../rdf.ts'
import type { GraphStore } from '../store/types.ts'
import { accSize, accumulate, type Group, newGroup, result } from './aggregate.ts'
import type { FnView, StreamAggregatePlan, ViewCompiler, ViewPlan, ViewSource } from './plan.ts'
import { recognizer, TREE_MEMBER } from './recognize.ts'
import { Terms } from './terms.ts'
import { ZSet } from './zset.ts'

export const IV = 'https://semblance.dev/ns/view#'
/** Where materialized views keep their output, their plans and their figures. */
export const VIEW_GRAPH = 'urn:semblance:views'

export interface ViewClock {
  now(): number
  /** Run `fn` at clock time `at`; returns a cancel function. */
  schedule(at: number, fn: () => void): () => void
}

/** The wall clock. Timers only where there is a page to update (browsers); elsewhere expiry waits for the next tick. */
export const systemClock = (): ViewClock => ({
  now: () => Date.now(),
  schedule(at, fn) {
    if (typeof requestAnimationFrame === 'undefined') return () => {}
    const t = setTimeout(fn, Math.max(0, at - Date.now()))
    return () => clearTimeout(t)
  },
})

/** A clock tests move by hand. */
export class ManualClock implements ViewClock {
  private pending: { at: number; fn: () => void }[] = []
  constructor(public t = Date.parse('2026-01-01T00:00:00Z')) {}
  now = () => this.t
  schedule(at: number, fn: () => void) {
    const p = { at, fn }
    this.pending.push(p)
    return () => (this.pending = this.pending.filter((x) => x !== p))
  }
  advance(ms: number): void {
    this.t += ms
    for (const p of this.pending.filter((x) => x.at <= this.t)) {
      this.pending = this.pending.filter((x) => x !== p)
      p.fn()
    }
  }
}

export interface ViewFigures {
  ticks: number
  /** Rows processed: member rows entering or leaving, groups updated, output rows. */
  rowsIn: number
  rowsOut: number
  ms: number
  /** The last tick that did work for this view. */
  lastRows: number
  lastMs: number
}

/** Totals over every view (the status bar and the cost tests read these). */
export interface ViewTotals {
  ticks: number
  rowsIn: number
  /** Rows of operator state now held. */
  state: number
  ms: number
}

export interface ViewDelta {
  /** SELECT views: rows that appeared (+) or went (-). */
  rows?: ZSet<Map<string, Term>>
  /** CONSTRUCT views: their own output's change. */
  quads?: ZSet<Quad>
}

export interface ViewHandle {
  readonly iri: string
  readonly strategy: 'incremental' | 'recompute'
  readonly fallback?: string
  readonly figures: ViewFigures
  /** The current result. */
  rows(): Map<string, Term>[]
  quads(): Quad[]
  /** Net change per tick; `replay` first delivers the current result as one change. */
  subscribe(fn: (d: ViewDelta) => void, opts?: { replay?: boolean }): () => void
  footprint(): Record<string, number>
}

export interface ViewOptions {
  /** The graphs a view reads besides the default graph (the runtime's input graphs). */
  graphs: string[]
  functions?: Record<string, FnView>
  compiler?: ViewCompiler
  clock?: ViewClock
}

const warn = (msg: string) => console.warn(`[semblance] ${msg}`)

export class ViewRuntime {
  readonly graph: NamedNode
  readonly terms = new Terms()
  readonly totals: ViewTotals = { ticks: 0, rowsIn: 0, state: 0, ms: 0 }
  /** Compare every view with a from-scratch evaluation after every tick, and refuse fallbacks (tests). */
  strict = false
  clock: ViewClock
  /** Called when a window's next expiry is due: the runtime runs a tick with no input. */
  onTimer?: () => void
  /**
   * Whether a component is shown (the runtime asks its projections). A view with
   * iv:whileShown is maintained only while that component - or, for a class, one of its
   * instances - is shown; otherwise it is suspended, and rebuilt when it is shown again.
   */
  shown?: (component: string) => boolean
  private views = new Map<string, MaintainedView>()
  private refs = new Map<string, { q: Quad; n: number }>()
  private dataset: Set<string>
  private graphs: Term[]
  private started = false
  private prefer: 'sparql' | 'function' = 'sparql'
  private timer?: { at: number; cancel: () => void }
  private ctx: RuleContext

  constructor(
    readonly store: GraphStore,
    private readonly opts: ViewOptions,
  ) {
    const f = store.factory
    this.graph = f.namedNode(VIEW_GRAPH)
    this.graphs = [f.defaultGraph(), ...opts.graphs.map((g) => f.namedNode(g))]
    this.dataset = new Set(['', ...opts.graphs])
    this.clock = opts.clock ?? systemClock()
    this.ctx = createContext(store, [...this.graphs, this.graph] as never, '', [])
  }

  get isStarted(): boolean {
    return this.started
  }

  view(iri: string): ViewHandle | undefined {
    return this.views.get(iri)
  }

  all(): ViewHandle[] {
    return [...this.views.values()]
  }

  /** Compile every iv:View in the store and evaluate it; returns the change to the view graph (already applied). */
  start(prefer: 'sparql' | 'function' = 'sparql'): Delta {
    this.started = true
    this.prefer = prefer
    const out = new ZSet<Quad>()
    const f = this.store.factory
    for (const q of this.store.match(null, f.namedNode(RDF_TYPE), f.namedNode(IV + 'View'))) {
      if (q.subject.termType === 'NamedNode') this.define(q.subject.value, out)
    }
    const now = this.clock.now()
    for (const v of this.views.values()) {
      if (this.demanded(v)) out.plus(v.initial(now))
      else v.suspended = true
    }
    const delta = this.sink(out)
    this.check(now)
    this.reschedule()
    return delta
  }

  /** One tick: the consolidated change of the input graphs. Returns the view graph's change (applied). */
  tick(delta: Delta): Delta {
    if (!this.started) return { add: [], remove: [] }
    const t = performance.now()
    const now = this.clock.now()
    const changes = { add: delta.add.filter((q) => this.dataset.has(q.graph.value)), remove: delta.remove.filter((q) => this.dataset.has(q.graph.value)) }
    const out = new ZSet<Quad>()
    // A view's own triples (its query, its window) changed: compile it again.
    const redefine = new Set<string>()
    for (const q of [...changes.add, ...changes.remove]) {
      if (q.subject.termType !== 'NamedNode') continue
      if (q.predicate.value === RDF_TYPE && q.object.value === IV + 'View') redefine.add(q.subject.value)
      else if (this.views.has(q.subject.value)) redefine.add(q.subject.value)
      else for (const v of this.views.values()) if (v.window === q.subject.value) redefine.add(v.iri)
    }
    for (const iri of redefine) {
      this.views.get(iri)?.drop(out)
      this.views.delete(iri)
      if (this.store.match(this.store.factory.namedNode(iri), this.store.factory.namedNode(RDF_TYPE), this.store.factory.namedNode(IV + 'View')).length) {
        this.define(iri, out)
        out.plus(this.views.get(iri)!.initial(now))
      }
    }
    let worked = false
    for (const v of this.views.values()) {
      if (redefine.has(v.iri) || v.suspended) continue
      if (v.whileShown && !this.demanded(v)) {
        v.suspended = true
        continue
      }
      const d = v.step(changes, now)
      if (d) out.plus(d), (worked = true)
    }
    const result = this.sink(out)
    if (worked || redefine.size) {
      this.totals.ticks++
      this.totals.ms += performance.now() - t
    }
    this.check(now)
    this.reschedule()
    return result
  }

  /** Rebuild suspended views whose component is shown again; returns the view graph's change (applied). */
  resume(): Delta {
    const out = new ZSet<Quad>()
    const now = this.clock.now()
    for (const v of this.views.values()) {
      if (!v.suspended || !this.demanded(v)) continue
      v.suspended = false
      out.plus(v.rebuild(now))
    }
    if (!out.size) return { add: [], remove: [] }
    const delta = this.sink(out)
    this.check(now)
    this.reschedule()
    return delta
  }

  private demanded(v: MaintainedView): boolean {
    if (!v.whileShown || !this.shown) return true
    const f = this.store.factory
    const instances = this.store.match(null, f.namedNode(RDF_TYPE), f.namedNode(v.whileShown))
    return (instances.length ? instances.map((q) => q.subject.value) : [v.whileShown]).some((c) => this.shown!(c))
  }

  /** What every view holds (soak tests). */
  footprint(): Record<string, number> {
    const out: Record<string, number> = { views: this.views.size, refs: this.refs.size, terms: this.terms.size }
    for (const v of this.views.values()) for (const [k, n] of Object.entries(v.footprint())) out[k] = (out[k] ?? 0) + n
    return out
  }

  /**
   * The figures of views marked iv:measured, as triples on each view (idle time: the
   * runtime writes them; views never read the view graph, so this cannot feed back).
   * A from-scratch evaluation is timed at most every `sampleMs` for comparison.
   */
  figures(sampleMs = 2000): Delta {
    const f = this.store.factory
    const nn = (p: string) => f.namedNode(p)
    const now = this.clock.now()
    const add: Quad[] = []
    const remove: Quad[] = []
    const set = (s: NamedNode, p: string, o: Term) => {
      const old = this.store.match(s, nn(p), null, this.graph)
      if (old.length === 1 && old[0]!.object.equals(o)) return
      remove.push(...old)
      add.push(f.quad(s, nn(p), o, this.graph))
    }
    const int = (n: number) => f.literal(String(Math.round(n)), nn(NS.xsd + 'integer'))
    const dec = (n: number) => f.literal(n.toFixed(3), nn(NS.xsd + 'decimal'))
    for (const v of this.views.values()) {
      const s = nn(v.iri)
      if (this.store.match(s, nn(IV + 'measured'), null).every((q) => q.object.value !== 'true')) continue
      set(s, IV + 'stateRows', int(v.stateRows()))
      set(s, IV + 'ticks', int(v.figures.ticks))
      set(s, IV + 'lastRows', int(v.figures.lastRows))
      set(s, IV + 'lastMs', dec(v.figures.lastMs))
      set(s, IV + 'meanMs', dec(v.figures.ticks ? v.figures.ms / v.figures.ticks : 0))
      if (this.store.sparql && (v.sampledAt === undefined || now - v.sampledAt >= sampleMs)) {
        v.sampledAt = now
        const t = performance.now()
        const n = v.fromScratch(now).length
        set(s, IV + 'scratchMs', dec(performance.now() - t))
        set(s, IV + 'scratchRows', int(n))
        set(s, IV + 'inputRows', int(v.inputRows()))
      }
    }
    return { add, remove }
  }

  private define(iri: string, out: ZSet<Quad>) {
    const f = this.store.factory
    const nn = (p: string) => f.namedNode(p)
    const s = nn(iri)
    const one = (node: Term, p: string) => this.store.match(node as NamedNode, nn(p), null)[0]?.object
    const select = one(s, SEM.select)?.value
    const construct = one(s, SEM.construct)?.value
    const fn = one(s, SEM.function)?.value
    const strategy = one(s, IV + 'strategy')?.value
    const windowNode = one(s, IV + 'window')
    let window: ViewSource['window']
    if (windowNode) {
      const range = one(windowNode, IV + 'range')?.value
      const ms = range ? parseDuration(range) : undefined
      if (ms === undefined) warn(`<${iri}>: iv:window needs an iv:range duration`)
      else window = { rangeMs: ms, timeBy: one(windowNode, IV + 'timeBy')?.value }
    }
    const source: ViewSource = {
      iri,
      form: construct ? 'construct' : 'select',
      query: construct ?? select ?? '',
      prefixes: prefixesFor(this.store),
      over: one(s, IV + 'over')?.value,
      window,
    }
    const fnView = fn ? this.opts.functions?.[fn] : undefined
    if (fn && !fnView) throw new Error(`No view function registered for "${fn}" (<${iri}>)`)
    let plan: ViewPlan
    const useFn = fnView && (!this.store.sparql || this.prefer === 'function' || !source.query)
    const sparqlPlan = this.store.sparql && source.query ? (this.opts.compiler ?? recognizer).compile(source, this.runner()) : undefined
    if (useFn) plan = this.fnPlan(fnView!, source, sparqlPlan)
    else if (sparqlPlan) plan = sparqlPlan
    else {
      warn(`<${iri}> has no implementation this store can run; skipped`)
      return
    }
    if (plan.kind === 'recompute') {
      const note = `<${iri}> is recomputed from scratch: ${plan.reason}`
      if (this.strict || strategy === IV + 'Incremental') throw new Error(note)
      warn(note)
    }
    const view = new MaintainedView(this, iri, plan, windowNode?.termType === 'NamedNode' ? windowNode.value : undefined)
    view.whileShown = one(s, IV + 'whileShown')?.value
    this.views.set(iri, view)
    out.plus(view.planQuads())
  }

  /** A function view's plan: the function's evaluators, the SPARQL view's oracle if it has one. */
  private fnPlan(fn: FnView, source: ViewSource, sparql: ViewPlan | undefined): StreamAggregatePlan {
    const f = this.store.factory
    const timeBy = source.window ? (source.window.timeBy ?? (fn.stream ? this.runner().timestampPath(fn.stream) : undefined)) : undefined
    return {
      kind: 'stream-aggregate',
      form: source.form,
      stream: fn.stream,
      streamVar: fn.streamVar,
      memberVar: fn.memberVar,
      groupBy: fn.groupBy,
      aggregates: fn.aggregates,
      window: source.window && timeBy ? { rangeMs: source.window.rangeMs, timeBy } : undefined,
      local: (batch) => {
        const out = new Map<string, Map<string, Term>[]>()
        for (const { stream, member } of batch) {
          const rows = fn.local(this.ctx, stream, member)
          for (const r of rows) {
            r.set(fn.memberVar, member)
            if (fn.streamVar) r.set(fn.streamVar, stream)
          }
          if (rows.length) out.set(stream.value + ' ' + member.value, rows)
        }
        return out
      },
      output: fn.output ? (row) => fn.output!(this.ctx, row).map((q) => f.quad(q.subject, q.predicate, q.object, this.graph)) : undefined,
      reference: sparql?.kind === 'stream-aggregate' ? sparql.reference : sparql?.kind === 'recompute' ? () => sparql.query : undefined,
      algebra: { local: `function ${fn.local.name || 'local'}`, group: `Group((${fn.groupBy.map((v) => '?' + v).join(' ')}), ${fn.aggregates.map((a) => `${a.fn} AS ?${a.as}`).join(', ')})`, output: fn.output ? 'function' : undefined },
    }
  }

  runner() {
    const prefixes = prefixesFor(this.store)
    const f = this.store.factory
    return {
      select: (q: string) => this.store.select(prefixes + '\n' + q, this.graphs as never),
      construct: (q: string) => this.store.construct(prefixes + '\n' + q, this.graphs as never).map((x) => f.quad(x.subject, x.predicate, x.object, this.graph)),
      timestampPath: (stream: string) => this.store.match(f.namedNode(stream), f.namedNode(NS.ldes + 'timestampPath'), null)[0]?.object.value,
    }
  }

  /** Members of a stream (or of every stream) now, in the views' dataset. */
  members(stream: string | undefined, member?: string): { stream: NamedNode; member: NamedNode }[] {
    const f = this.store.factory
    const out: { stream: NamedNode; member: NamedNode }[] = []
    const seen = new Set<string>()
    for (const g of this.graphs) {
      for (const q of this.store.match(stream ? f.namedNode(stream) : null, f.namedNode(TREE_MEMBER), member ? f.namedNode(member) : null, g as never)) {
        if (q.object.termType !== 'NamedNode' || q.subject.termType !== 'NamedNode') continue
        const k = q.subject.value + ' ' + q.object.value
        if (!seen.has(k)) seen.add(k), out.push({ stream: q.subject, member: q.object })
      }
    }
    return out
  }

  timestamp(member: NamedNode, timeBy: string): number | undefined {
    for (const g of this.graphs) {
      const t = this.store.match(member, this.store.factory.namedNode(timeBy), null, g as never)[0]?.object
      if (!t) continue
      const n = Number(t.value)
      return Number.isNaN(n) ? Date.parse(t.value) : n
    }
    return undefined
  }

  /** Apply a change of view output (weights) to the store through reference counts. */
  private sink(out: ZSet<Quad>): Delta {
    const add: Quad[] = []
    const remove: Quad[] = []
    const f = this.store.factory
    for (const [k, q0, w] of out.entries()) {
      const q = q0.graph.equals(this.graph) ? q0 : f.quad(q0.subject, q0.predicate, q0.object, this.graph)
      const ref = this.refs.get(k)
      const n = (ref?.n ?? 0) + w
      if (n < 0) throw new Error(`view output went negative for ${k}`)
      if (!ref && n > 0) {
        this.refs.set(k, { q, n })
        if (!this.store.has(q)) this.store.add(q), add.push(q)
      } else if (ref && n === 0) {
        this.refs.delete(k)
        if (this.store.has(ref.q)) this.store.delete(ref.q), remove.push(ref.q)
      } else if (ref) ref.n = n
    }
    let state = 0
    for (const v of this.views.values()) state += v.stateRows()
    this.totals.state = state
    return { add, remove }
  }

  /** Strict mode: every view equals its from-scratch evaluation. */
  private check(now: number) {
    if (!this.strict || !this.store.sparql) return
    for (const v of this.views.values()) {
      if (v.suspended) continue
      const problem = v.compare(now)
      if (problem) throw new Error(`View <${v.iri}> differs from a from-scratch evaluation: ${problem}`)
    }
  }

  private reschedule() {
    let next: number | undefined
    for (const v of this.views.values()) {
      const at = v.nextExpiry()
      if (at !== undefined && (next === undefined || at < next)) next = at
    }
    if (next === this.timer?.at) return
    this.timer?.cancel()
    this.timer = undefined
    if (next === undefined) return
    const at = next
    this.timer = { at, cancel: this.clock.schedule(at, () => {
      if (this.timer?.at === at) this.timer = undefined
      this.onTimer?.()
    }) }
  }
}

/** A member's cached contribution: its rows (as interned ids), its timestamp, whether it is in the window. */
interface MemberState {
  rows: number[][]
  t?: number
  inWindow: boolean
}

const rowKey = (ids: readonly number[]) => ids.join(',')

class MaintainedView implements ViewHandle {
  readonly figures: ViewFigures = { ticks: 0, rowsIn: 0, rowsOut: 0, ms: 0, lastRows: 0, lastMs: 0 }
  sampledAt?: number
  /** iv:whileShown: maintained only while this component (or an instance of this class) is shown. */
  whileShown?: string
  suspended = false
  private members = new Map<string, MemberState>()
  /** Member IRI -> its (stream, member) keys, to find the partitions a changed triple belongs to. */
  private byMember = new Map<string, Set<string>>()
  private memberRows = 0
  private groups = new Map<string, Group>()
  /** Each group's emitted row and, for CONSTRUCT views, its triples. */
  private emitted = new Map<string, { row: Map<string, Term>; quads: Quad[] }>()
  /** Window: (timestamp, member key) in time order. */
  private order: { t: number; key: string }[] = []
  private recomputed?: Map<string, Quad> | Map<string, Map<string, Term>>
  private listeners: ((d: ViewDelta) => void)[] = []
  private slots: string[]
  private readonly activity: NamedNode

  constructor(
    private readonly rt: ViewRuntime,
    readonly iri: string,
    readonly plan: ViewPlan,
    readonly window?: string,
  ) {
    this.slots = plan.kind === 'stream-aggregate' ? [...plan.groupBy, ...plan.aggregates.map((a) => a.slot).filter((s) => s !== '*')] : []
    this.activity = rt.store.factory.namedNode(mint(iri, 'activity'))
  }

  get strategy() {
    return this.plan.kind === 'recompute' ? ('recompute' as const) : ('incremental' as const)
  }

  get fallback() {
    return this.plan.kind === 'recompute' ? this.plan.reason : undefined
  }

  /** The plan as data: the view's strategy, its operators, and its PROV-O activity. */
  planQuads(): ZSet<Quad> {
    const f = this.rt.store.factory
    const nn = (p: string) => f.namedNode(p)
    const g = this.rt.graph
    const v = nn(this.iri)
    const out = new ZSet<Quad>()
    const t = (s: NamedNode, p: string, o: Term) => {
      const q = f.quad(s, nn(p), o, g)
      out.add(quadKey(q), q)
    }
    t(v, IV + 'strategy', nn(IV + (this.plan.kind === 'recompute' ? 'Recompute' : 'Incremental')))
    t(this.activity, RDF_TYPE, nn(PROV.Activity))
    t(this.activity, PROV.used, v)
    if (this.plan.kind === 'recompute') {
      t(v, IV + 'fallback', f.literal(this.plan.reason))
      return out
    }
    const p = this.plan
    if (p.stream) t(this.activity, PROV.used, nn(p.stream))
    const ops: [string, string, string?][] = [
      ['Partition', p.algebra.local, '?' + p.memberVar],
      ...(p.window ? ([['Expire', `Window(${p.window.rangeMs} ms on <${p.window.timeBy}>)`]] as [string, string][]) : []),
      ['Group', p.algebra.group],
      ...(p.algebra.output ? ([['Sink', p.algebra.output]] as [string, string][]) : []),
    ]
    let prev: NamedNode | undefined
    ops.forEach(([kind, algebra, key], i) => {
      const op = nn(mint(this.iri, `op-${i + 1}`))
      t(v, IV + 'operator', op)
      t(op, RDF_TYPE, nn(IV + 'Operator'))
      t(op, IV + 'kind', nn(IV + kind))
      t(op, IV + 'algebra', f.literal(algebra))
      if (key) t(op, IV + 'partitionKey', f.literal(key))
      if (prev) t(op, IV + 'input', prev)
      prev = op
    })
    return out
  }

  /** Evaluate from the current inputs (start, or after a redefinition). */
  initial(now: number): ZSet<Quad> {
    if (this.plan.kind === 'recompute') return this.recompute(true) ?? new ZSet()
    const touched = new Set(this.rt.members(this.plan.stream).map((m) => m.stream.value + ' ' + m.member.value))
    return this.update(touched, now, true) ?? new ZSet()
  }

  /** One tick; undefined when the view had nothing to do. */
  step(changes: Delta, now: number): ZSet<Quad> | undefined {
    if (this.plan.kind === 'recompute') return changes.add.length || changes.remove.length ? this.recompute(false) : undefined
    const p = this.plan
    // Members whose partition changed: membership, or a triple of the member or of a node minted under it.
    const touched = new Set<string>()
    const byMember = this.byMember
    for (const q of [...changes.remove, ...changes.add]) {
      if (q.predicate.value === TREE_MEMBER && q.object.termType === 'NamedNode' && (!p.stream || q.subject.value === p.stream)) {
        touched.add(q.subject.value + ' ' + q.object.value)
        continue
      }
      if (q.subject.termType !== 'NamedNode') continue
      for (let s = q.subject.value; ; ) {
        for (const k of byMember.get(s) ?? []) touched.add(k)
        const o = owningFocus(s)
        if (o === s) break
        s = o
      }
    }
    const expiring = p.window && this.order.length && this.order[0]!.t < now - p.window.rangeMs
    if (!touched.size && !expiring) return undefined
    return this.update(touched, now, false)
  }

  private update(touched: Set<string>, now: number, initial: boolean): ZSet<Quad> | undefined {
    const p = this.plan as StreamAggregatePlan
    const t0 = performance.now()
    const terms = this.rt.terms
    const f = this.rt.store.factory
    let rows = 0
    const dirty = new Set<string>()
    const enter = (st: MemberState, w: 1 | -1) => {
      for (const r of st.rows) {
        const gk = rowKey(r.slice(0, p.groupBy.length))
        let g = this.groups.get(gk)
        if (!g) {
          const ids = r.slice(0, p.groupBy.length)
          ids.forEach((id) => terms.retain(id))
          this.groups.set(gk, (g = newGroup(ids, p.aggregates)))
        }
        g.rows += w
        p.aggregates.forEach((a, i) => accumulate(terms, a, g!.accs[i]!, a.slot === '*' ? 0 : r[this.slots.indexOf(a.slot)]!, w))
        dirty.add(gk)
        rows++
      }
    }
    const release = (st: MemberState) => {
      for (const r of st.rows) for (const id of r) terms.release(id)
    }
    // Which touched members still belong, and what they contribute now.
    const current = new Map<string, { stream: NamedNode; member: NamedNode }>()
    for (const key of touched) {
      const i = key.indexOf(' ')
      const stream = key.slice(0, i)
      const member = key.slice(i + 1)
      if (this.rt.members(stream, member).length) current.set(key, { stream: f.namedNode(stream), member: f.namedNode(member) })
    }
    const evaluated = current.size ? p.local([...current.values()]) : new Map<string, Map<string, Term>[]>()
    const cutoff = p.window ? now - p.window.rangeMs : -Infinity
    for (const key of touched) {
      const old = this.members.get(key)
      const cur = current.get(key)
      let next: MemberState | undefined
      if (cur) {
        const found = evaluated.get(key) ?? []
        const ids = found.map((row) => this.slots.map((s) => terms.id(row.get(s))))
        const t = p.window ? this.rt.timestamp(cur.member, p.window.timeBy) : undefined
        next = { rows: ids, t, inWindow: !p.window || (t !== undefined && t >= cutoff) }
        if (old && old.inWindow === next.inWindow && old.t === next.t && sameRows(old.rows, ids)) continue
        for (const r of ids) for (const id of r) terms.retain(id)
      }
      if (old?.inWindow) enter(old, -1)
      if (old) release(old), (this.memberRows -= old.rows.length)
      if (next) {
        if (!old) {
          const m = key.slice(key.indexOf(' ') + 1)
          let keys = this.byMember.get(m)
          if (!keys) this.byMember.set(m, (keys = new Set()))
          keys.add(key)
        }
        this.memberRows += next.rows.length
        this.members.set(key, next)
        if (next.inWindow) enter(next, 1)
        if (p.window && next.inWindow && next.t !== undefined) insertOrdered(this.order, { t: next.t, key })
      } else if (old) {
        this.members.delete(key)
        const m = key.slice(key.indexOf(' ') + 1)
        const keys = this.byMember.get(m)
        keys?.delete(key)
        if (!keys?.size) this.byMember.delete(m)
      }
    }
    // Expiry: members whose timestamp left the window.
    if (p.window) {
      while (this.order.length && this.order[0]!.t < cutoff) {
        const { key, t } = this.order.shift()!
        const st = this.members.get(key)
        if (st?.inWindow && st.t === t) {
          enter(st, -1)
          st.inWindow = false
        }
      }
    }
    terms.sweep()
    // Every group with no GROUP BY exists even when empty (COUNT 0).
    if (!p.groupBy.length && !this.groups.has('')) {
      this.groups.set('', newGroup([], p.aggregates))
      dirty.add('')
    }
    const out = new ZSet<Quad>()
    const rowDelta = new ZSet<Map<string, Term>>()
    let outRows = 0
    for (const gk of dirty) {
      const g = this.groups.get(gk)!
      const before = this.emitted.get(gk)
      let row: Map<string, Term> | undefined
      if (g.rows > 0 || !p.groupBy.length) {
        row = new Map()
        p.groupBy.forEach((v, i) => {
          const t = terms.term(g.ids[i]!)
          if (t) row!.set(v, t)
        })
        p.aggregates.forEach((a, i) => {
          const t = result(f, terms, a, g.accs[i]!)
          if (t) row!.set(a.as, t)
        })
      } else {
        g.ids.forEach((id) => terms.release(id))
        this.groups.delete(gk)
      }
      const rk = row ? mapKey(row) : undefined
      if (before && rk === mapKey(before.row)) continue
      if (before) {
        rowDelta.add(mapKey(before.row), before.row, -1)
        for (const q of before.quads) out.add(quadKey(q), q, -1)
        this.emitted.delete(gk)
        outRows++
      }
      if (row) {
        rowDelta.add(rk!, row, 1)
        const quads = p.output ? this.withProvenance(p.output(row)) : []
        for (const q of quads) out.add(quadKey(q), q, 1)
        this.emitted.set(gk, { row, quads })
        outRows++
      }
    }
    const ms = performance.now() - t0
    if (!initial) {
      this.figures.ticks++
      this.figures.rowsIn += rows + dirty.size
      this.figures.rowsOut += outRows
      this.figures.ms += ms
      this.figures.lastRows = rows + dirty.size + outRows
      this.figures.lastMs = ms
      this.rt.totals.rowsIn += rows + dirty.size + outRows
    }
    this.notify(rowDelta, out)
    return out
  }

  /** Subjects the view types were generated by its activity; others it decorates were influenced. */
  private withProvenance(quads: Quad[]): Quad[] {
    const f = this.rt.store.factory
    const typed = new Set(quads.filter((q) => q.predicate.value === RDF_TYPE).map((q) => q.subject.value))
    const subjects = new Map(quads.map((q) => [q.subject.value, q.subject]))
    const out = [...quads]
    for (const [s, node] of subjects) out.push(f.quad(node, f.namedNode(typed.has(s) ? PROV.wasGeneratedBy : PROV.wasInfluencedBy), this.activity, this.rt.graph))
    return out
  }

  private recompute(initial: boolean): ZSet<Quad> | undefined {
    const p = this.plan as Extract<ViewPlan, { kind: 'recompute' }>
    const t0 = performance.now()
    const run = this.rt.runner()
    const out = new ZSet<Quad>()
    const rowDelta = new ZSet<Map<string, Term>>()
    if (p.form === 'construct') {
      const next = new Map(this.withProvenance(run.construct(p.query)).map((q) => [quadKey(q), q]))
      const prev = (this.recomputed as Map<string, Quad> | undefined) ?? new Map()
      for (const [k, q] of prev) if (!next.has(k)) out.add(k, q, -1)
      for (const [k, q] of next) if (!prev.has(k)) out.add(k, q, 1)
      this.recomputed = next
    } else {
      const next = new Map<string, Map<string, Term>>()
      const counts = new ZSet<Map<string, Term>>()
      for (const r of run.select(p.query)) counts.add(mapKey(r), r, 1)
      const prev = (this.recomputed as Map<string, Map<string, Term>> | undefined) ?? new Map()
      const prevCounts = new ZSet<Map<string, Term>>()
      for (const [k, r] of prev) prevCounts.add(k.slice(k.indexOf('|') + 1), r, 1)
      rowDelta.plus(counts).plus(prevCounts, -1)
      for (const [k, r, w] of counts.entries()) for (let i = 0; i < w; i++) next.set(i + '|' + k, r)
      this.recomputed = next
    }
    const ms = performance.now() - t0
    if (!initial) {
      this.figures.ticks++
      this.figures.ms += ms
      this.figures.lastMs = ms
    }
    this.notify(rowDelta, out)
    return out
  }

  private notify(rows: ZSet<Map<string, Term>>, quads: ZSet<Quad>) {
    if (!this.listeners.length || (!rows.size && !quads.size)) return
    for (const l of this.listeners) l(this.plan.form === 'select' ? { rows } : { quads })
  }

  /** Evaluate again from the inputs (after a suspension): the change is the difference. */
  rebuild(now: number): ZSet<Quad> {
    const out = new ZSet<Quad>()
    this.reset(out)
    this.recomputed = undefined
    return out.plus(this.initial(now))
  }

  /** Retract everything (the view is redefined or removed). */
  drop(out: ZSet<Quad>) {
    out.plus(this.planQuads(), -1)
    this.reset(out)
  }

  private reset(out: ZSet<Quad>) {
    for (const q of this.quads()) out.add(quadKey(q), q, -1)
    for (const st of this.members.values()) for (const r of st.rows) for (const id of r) this.rt.terms.release(id)
    for (const g of this.groups.values()) for (const id of g.ids) this.rt.terms.release(id)
    this.members.clear()
    this.byMember.clear()
    this.memberRows = 0
    this.groups.clear()
    this.emitted.clear()
    this.order = []
  }

  rows(): Map<string, Term>[] {
    if (this.plan.kind === 'recompute') return this.plan.form === 'select' ? [...((this.recomputed as Map<string, Map<string, Term>>) ?? new Map()).values()] : []
    return [...this.emitted.values()].map((e) => e.row)
  }

  quads(): Quad[] {
    if (this.plan.kind === 'recompute') return this.plan.form === 'construct' ? [...((this.recomputed as Map<string, Quad>) ?? new Map()).values()] : []
    return [...this.emitted.values()].flatMap((e) => e.quads)
  }

  subscribe(fn: (d: ViewDelta) => void, opts: { replay?: boolean } = {}): () => void {
    this.listeners.push(fn)
    if (opts.replay) {
      const rows = new ZSet<Map<string, Term>>()
      for (const r of this.rows()) rows.add(mapKey(r), r, 1)
      const quads = new ZSet<Quad>()
      for (const q of this.quads()) quads.add(quadKey(q), q, 1)
      fn(this.plan.form === 'select' ? { rows } : { quads })
    }
    return () => (this.listeners = this.listeners.filter((l) => l !== fn))
  }

  footprint(): Record<string, number> {
    let rows = 0
    for (const st of this.members.values()) rows += st.rows.length
    let acc = 0
    for (const g of this.groups.values()) for (const a of g.accs) acc += accSize(a)
    return { members: this.members.size, byMember: this.byMember.size, memberRows: rows, groups: this.groups.size, accumulators: acc, window: this.order.length, recomputed: this.recomputed?.size ?? 0 }
  }

  /** Rows of state: cached member rows, groups, window entries (or a recomputed result). */
  stateRows(): number {
    return this.memberRows + this.groups.size + this.order.length + (this.recomputed?.size ?? 0)
  }

  /** Rows a from-scratch evaluation reads: the stream's members' rows (for the figures). */
  inputRows(): number {
    return this.memberRows
  }

  nextExpiry(): number | undefined {
    const p = this.plan
    if (p.kind !== 'stream-aggregate' || !p.window) return undefined
    for (const { t, key } of this.order) {
      const st = this.members.get(key)
      // In the window while t >= now - range: it leaves one millisecond after t + range.
      if (st?.inWindow && st.t === t) return t + p.window.rangeMs + 1
    }
    return undefined
  }

  /** Evaluate the view's query from scratch (the oracle). */
  fromScratch(now: number): (Quad | Map<string, Term>)[] {
    const run = this.rt.runner()
    const query = this.plan.kind === 'recompute' ? this.plan.query : this.plan.reference?.(now)
    if (!query) return []
    return this.plan.form === 'construct' ? run.construct(query) : run.select(query)
  }

  /** undefined when the maintained result equals the from-scratch one; else what differs. */
  compare(now: number): string | undefined {
    const query = this.plan.kind === 'recompute' ? this.plan.query : this.plan.reference?.(now)
    if (!query) return undefined
    const expected = new ZSet<string>()
    const actual = new ZSet<string>()
    if (this.plan.form === 'construct') {
      // CONSTRUCT results are sets; provenance is the view's own decoration.
      const isProv = (q: Quad) => q.predicate.value === PROV.wasGeneratedBy || q.predicate.value === PROV.wasInfluencedBy
      for (const k of new Set((this.fromScratch(now) as Quad[]).filter((q) => !isProv(q)).map(normQuad))) expected.add(k, '', 1)
      for (const k of new Set(this.quads().filter((q) => !isProv(q)).map(normQuad))) actual.add(k, '', 1)
    } else {
      for (const r of this.fromScratch(now) as Map<string, Term>[]) expected.add(normRow(r), '', 1)
      for (const r of this.rows()) actual.add(normRow(r), '', 1)
    }
    const diff = new ZSet<string>().plus(actual).plus(expected, -1)
    if (!diff.size) return undefined
    return [...diff.entries()].slice(0, 6).map(([k, , w]) => `${w > 0 ? 'extra' : 'missing'} ${k}`).join('; ')
  }
}

function sameRows(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false
  const ka = a.map(rowKey).sort()
  const kb = b.map(rowKey).sort()
  return ka.every((k, i) => k === kb[i])
}

function insertOrdered(order: { t: number; key: string }[], e: { t: number; key: string }) {
  let lo = 0
  let hi = order.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (order[mid]!.t <= e.t) lo = mid + 1
    else hi = mid
  }
  order.splice(lo, 0, e)
}

const mapKey = (row: Map<string, Term>) =>
  [...row.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, t]) => `${k}=${termKey(t)}`)
    .join(' ')

/** Numeric literals compare by value, to 12 digits (lexical forms and float sums differ between engines). */
function norm(t: Term): string {
  if (t.termType === 'Literal' && /#(integer|decimal|double|float|int|long)$/.test(t.datatype.value) && !Number.isNaN(Number(t.value))) return `${Number(Number(t.value).toPrecision(12))}^^numeric`
  return termKey(t)
}
const normQuad = (q: Quad) => `${norm(q.subject)} ${q.predicate.value} ${norm(q.object)}`
const normRow = (r: Map<string, Term>) =>
  [...r.entries()]
    .filter(([k]) => !k.startsWith('__'))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, t]) => `${k}=${norm(t)}`)
    .join(' ')
