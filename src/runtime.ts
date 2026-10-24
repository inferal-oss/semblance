import type { Delta } from './rdf.ts'
import { Engine, type EngineOptions } from './engine/engine.ts'
import { functions as builtinFunctions } from './components/functions.ts'
import { HtmlIndex } from './render/html-index.ts'
import type { GraphStore } from './store/types.ts'
import { EVENTS_GRAPH, NAV_GRAPH, NETWORK_GRAPH, PERF_GRAPH, PERSIST_GRAPH, SEM } from './ns.ts'
import { docsFunctions } from './layers/docs.ts'
import { persistenceFunctions } from './persistence.ts'
import { navigationFunctions } from './navigation.ts'
import { privacyFunctions } from './layers/privacy.ts'
import { functions as workbenchFunctions } from './components/workbench.ts'
import { exampleFunctions } from './examples/index.ts'
import { functions as referenceFunctions } from './components/reference.ts'

/** An engine plus the RDF/HTML view it keeps up to date. */
export interface Projection {
  engine: Engine
  index: HtmlIndex
}

/**
 * One graph, many projections. The runtime owns the store; every projection
 * (one per modality or view) derives its own graph from the same input, and
 * every input change is applied once and propagated to all.
 */
export class Runtime {
  readonly projections: Projection[] = []
  private readonly inputListeners: ((graph: string | undefined, delta: Delta) => void)[] = []
  private readonly warmth = new WeakMap<Engine, (focus: string) => string | undefined>()
  private readonly refreshListeners: (() => void)[] = []
  private refreshQueued = false
  /** When the next refresh may run: a slow one waits longer, so following never takes over. */
  private refreshAfter = 0

  /**
   * How a refresh waits for the next frame (see refresh()): requestAnimationFrame where there
   * is a page, else a microtask. Hosts and tests may replace it.
   */
  frame: (run: () => void) => void =
    typeof requestAnimationFrame === 'function' ? (run) => void requestAnimationFrame(() => run()) : (run) => queueMicrotask(run)
  /**
   * Following a query never takes more than about this share of the time: after a refresh
   * that took t ms, the next waits at least t / share - t ms more.
   */
  refreshShare = 0.25

  constructor(readonly store: GraphStore) {}

  /** Hear about every refresh (after the projections are updated): the host flushes its renderers. */
  onRefresh(listener: () => void): () => void {
    this.refreshListeners.push(listener)
    return () => this.refreshListeners.splice(this.refreshListeners.indexOf(listener), 1)
  }

  /**
   * Re-run the views whose followed queries read what changed since the last refresh (see
   * Engine.refresh), in every projection. The host calls it at the next frame by itself
   * (`frame`); call it to refresh now. Returns whether anything was re-run.
   */
  refresh(): boolean {
    const t = performance.now()
    let any = false
    for (const p of this.projections) if (p.engine.refresh()) settle(p), (any = true)
    if (!any) return false
    const took = performance.now() - t
    this.refreshAfter = performance.now() + took * (1 / this.refreshShare - 1)
    for (const l of this.refreshListeners) l()
    return true
  }

  /** At most one refresh waits at a time: everything that changes before it runs is in it. */
  private queueRefresh() {
    if (this.refreshQueued) return
    this.refreshQueued = true
    const go = () => {
      const wait = this.refreshAfter - performance.now()
      if (wait > 1) return void setTimeout(() => this.frame(go), wait)
      this.refreshQueued = false
      this.refresh()
    }
    this.frame(go)
  }

  /**
   * Hear about every effective change to the input graphs (`graph` undefined = the
   * default graph): host effects such as persistence follow the input this way.
   */
  onInput(listener: (graph: string | undefined, delta: Delta) => void): () => void {
    this.inputListeners.push(listener)
    return () => this.inputListeners.splice(this.inputListeners.indexOf(listener), 1)
  }

  /**
   * `roots` (optional) are the instances this projection is mounted at: only
   * what is shown under them is evaluated (see Engine.demand); the rest waits.
   */
  project(opts: EngineOptions & { roots?: string[] }, onError?: (e: Error) => void): Projection {
    const engine = new Engine(this.store, {
      inputGraphs: [EVENTS_GRAPH, PERF_GRAPH, PERSIST_GRAPH, NETWORK_GRAPH, NAV_GRAPH],
      ...opts,
      functions: { ...builtinFunctions, ...docsFunctions, ...persistenceFunctions, ...navigationFunctions, ...workbenchFunctions, ...referenceFunctions, ...privacyFunctions, ...exampleFunctions, ...opts.functions },
    })
    const index = new HtmlIndex(onError)
    engine.onChange((d) => index.apply(d))
    engine.onStale = () => this.queueRefresh()
    if (opts.roots) {
      const roots = new Set(opts.roots)
      // Whether a focus is shown is asked for every parked pair on every check; the answer holds
      // until something that decides visibility changes (index.visibility), so it is kept until then.
      let epoch = -1
      let shown = new Map<string, boolean>()
      engine.demand = (focus) => {
        if (epoch !== index.visibility) (epoch = index.visibility), (shown = new Map())
        let v = shown.get(focus)
        if (v === undefined) shown.set(focus, (v = index.isShown(focus, roots)))
        return v
      }
      // Idle time warms only what an ancestor declares sem:warm sem:Eager (default: lazy).
      const f = this.store.factory
      const warm = f.namedNode(SEM.warm)
      const warmth = (focus: string) => index.nearest(focus, (key) => (key.includes(' ') ? undefined : this.store.match(f.namedNode(key), warm, null)[0]?.object.value))
      engine.warmable = (focus) => warmth(focus) === SEM.Eager
      this.warmth.set(engine, warmth)
    }
    engine.start()
    const p: Projection = { engine, index }
    settle(p)
    this.projections.push(p)
    return p
  }

  /**
   * Change a named input graph (the change log, performance observations...)
   * and update the projections that read it.
   */
  write(graph: string, delta: Delta): Delta {
    const f = this.store.factory
    const g = f.namedNode(graph)
    const effective: Delta = { add: [], remove: [] }
    for (const q of delta.remove) {
      const e = f.quad(q.subject, q.predicate, q.object, g)
      if (this.store.has(e)) this.store.delete(e), effective.remove.push(e)
    }
    for (const q of delta.add) {
      const e = f.quad(q.subject, q.predicate, q.object, g)
      if (!this.store.has(e)) this.store.add(e), effective.add.push(e)
    }
    if (effective.add.length || effective.remove.length) {
      for (const p of this.projections) p.engine.process(effective), settle(p)
      for (const l of this.inputListeners) l(graph, effective)
    }
    return effective
  }

  /** Append to (or retire from) the change log. Callers write complete, immutable members. */
  log(delta: Delta): void {
    this.write(EVENTS_GRAPH, delta)
  }

  /** Spend up to `budgetMs` evaluating hidden work (see Engine.warm). Returns whether work remains. */
  warm(budgetMs: number): boolean {
    const until = performance.now() + budgetMs
    let more = false
    const share = budgetMs / Math.max(1, this.projections.length)
    for (const p of this.projections) {
      more = p.engine.warm(share) || more
      settle(p)
    }
    // What time is left goes to the store's own upkeep (e.g. compaction).
    const left = until - performance.now()
    if (left > 1) more = (this.store.maintain?.(left) ?? false) || more
    return more
  }

  /**
   * Evaluate, for up to `budgetMs`, the parked work under the given components - what
   * the person shows intent to see (see sem:OnIntent) - where their warmth allows it
   * (on intent or eager). Returns whether work remains.
   */
  preload(contents: ReadonlySet<string>, budgetMs: number): boolean {
    let more = false
    for (const p of this.projections) {
      const warmth = this.warmth.get(p.engine)
      if (!warmth) continue
      const under = (focus: string) => p.index.nearest(focus, (key) => (contents.has(key) ? true : undefined)) === true
      const allowed = (focus: string) => {
        const w = warmth(focus)
        return (w === SEM.OnIntent || w === SEM.Eager) && under(focus)
      }
      more = p.engine.warm(budgetMs / this.projections.length, 4, allowed) || more
      settle(p)
    }
    return more
  }

  /** Apply a change to the input graph (default graph) and update every projection. */
  apply(delta: Delta): Delta {
    const effective: Delta = { add: [], remove: [] }
    const f = this.store.factory
    const dg = f.defaultGraph()
    for (const q of delta.remove) {
      const g = f.quad(q.subject, q.predicate, q.object, dg)
      if (this.store.has(g)) this.store.delete(g), effective.remove.push(g)
    }
    for (const q of delta.add) {
      const g = f.quad(q.subject, q.predicate, q.object, dg)
      if (!this.store.has(g)) this.store.add(g), effective.add.push(g)
    }
    if (effective.add.length || effective.remove.length) {
      for (const p of this.projections) p.engine.process(effective), settle(p)
      for (const l of this.inputListeners) l(undefined, effective)
    }
    return effective
  }
}

/**
 * Newly shown components render, which may show more: repeat until nothing new
 * is demanded. Parked work is only re-checked when visibility changed, so the
 * cost of a change does not grow with how much of the app is hidden.
 */
const seenVisibility = new WeakMap<Projection, number>()
function settle(p: Projection) {
  for (let i = 0; i < 64; i++) {
    if (seenVisibility.get(p) === p.index.visibility) return
    seenVisibility.set(p, p.index.visibility)
    if (!p.engine.resume()) return
  }
}
