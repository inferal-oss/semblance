import type { Delta } from './rdf.ts'
import { Engine, type EngineOptions } from './engine/engine.ts'
import { functions as builtinFunctions } from './components/functions.ts'
import { HtmlIndex } from './render/html-index.ts'
import type { GraphStore } from './store/types.ts'
import { EVENTS_GRAPH, PERF_GRAPH, PERSIST_GRAPH, SEM } from './ns.ts'
import { docsFunctions } from './layers/docs.ts'
import { persistenceFunctions } from './persistence.ts'
import { privacyFunctions } from './layers/privacy.ts'
import { functions as workbenchFunctions } from './components/workbench.ts'

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

  constructor(readonly store: GraphStore) {}

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
      inputGraphs: [EVENTS_GRAPH, PERF_GRAPH, PERSIST_GRAPH],
      ...opts,
      functions: { ...builtinFunctions, ...docsFunctions, ...persistenceFunctions, ...workbenchFunctions, ...privacyFunctions, ...opts.functions },
    })
    const index = new HtmlIndex(onError)
    engine.onChange((d) => index.apply(d))
    if (opts.roots) {
      const roots = new Set(opts.roots)
      engine.demand = (focus) => index.isShown(focus, roots)
      // Idle time warms only what an ancestor declares sem:warm sem:Eager (default: lazy).
      const f = this.store.factory
      const warm = f.namedNode(SEM.warm)
      engine.warmable = (focus) =>
        index.nearest(focus, (key) => (key.includes(' ') ? undefined : this.store.match(f.namedNode(key), warm, null)[0]?.object.value)) === SEM.Eager
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
