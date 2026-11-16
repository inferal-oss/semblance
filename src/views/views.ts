// Maintained views on their own (docs/VIEWS.md): a store and the view runtime over it, with no
// ontology, no rule engine and no projection. Changes come in as deltas (apply, write, a
// transaction), each one tick; every view hosted here is kept up to date from what the tick
// changed, as the Runtime keeps its views (src/runtime.ts). The two share the ViewRuntime, its view
// functions, and how a change is applied and consolidated (src/view/input.ts).
import { parseTurtle } from '../parse-turtle.ts'
import type { Delta } from '../rdf.ts'
import type { GraphStore } from '../store/types.ts'
import { viewFunctions } from '../view/functions.ts'
import { applyEffective, Consolidation } from '../view/input.ts'
import { type ViewClock, type ViewHandle, ViewRuntime } from '../view/runtime.ts'

export interface ViewsOptions {
  /** Named graphs the views read besides the default graph (changed with `write`). */
  graphs?: string[]
  /** The clock windows over time read (default: the wall clock); tests pass a ManualClock. */
  clock?: ViewClock
  /**
   * Compare every view with a from-scratch evaluation after every tick, and throw on a difference
   * or on a view that cannot be maintained (tests).
   */
  strict?: boolean
}

/** A store and the views maintained over it (createViews). */
export class Views {
  /** The view runtime: its totals (work done), every view it holds, its clock. */
  readonly runtime: ViewRuntime
  private tx?: Consolidation
  private ended = false

  constructor(
    readonly store: GraphStore,
    opts: ViewsOptions = {},
  ) {
    this.runtime = new ViewRuntime(store, { graphs: opts.graphs ?? [], functions: viewFunctions, clock: opts.clock })
    this.runtime.strict = !!opts.strict
    // A window's next expiry: a tick with no input.
    this.runtime.onTimer = () => this.advance()
    this.runtime.start()
  }

  /** The last tick's number: what `ViewHandle.since(tick)` takes, and what a ViewChange brings a reader up to. */
  get tick(): number {
    return this.runtime.tickNo
  }

  /**
   * Maintain a SPARQL query as a view under `iri` (replacing a view hosted there before): a SELECT's
   * rows (`rows()`) or a CONSTRUCT's triples (`quads()`), evaluated now and kept up to date from
   * every tick. A query the compiler cannot maintain is recomputed when its inputs change, and says
   * so (`strategy`, `fallback`). The framework's prefixes (rdf:, rdfs:, xsd:, …) need no declaration.
   */
  host(iri: string, query: string, form: 'select' | 'construct'): ViewHandle {
    if (!this.store.sparql) throw new Error(`<${iri}>: the ${this.store.kind} store has no SPARQL; views need a store that has (wat, rust, oxigraph, hybrid)`)
    const v = this.runtime.host(iri, query, form)
    if (!v) throw new Error(`<${iri}>: the query cannot be evaluated on this store`)
    return v
  }

  /** `host(iri, query, 'select')`. */
  select(iri: string, query: string): ViewHandle {
    return this.host(iri, query, 'select')
  }

  /** `host(iri, query, 'construct')`. */
  construct(iri: string, query: string): ViewHandle {
    return this.host(iri, query, 'construct')
  }

  /** The view hosted under `iri`. */
  view(iri: string): ViewHandle | undefined {
    return this.runtime.view(iri)
  }

  /** Stop maintaining a view: its subscribers hear nothing more. */
  unhost(iri: string): void {
    this.runtime.unhost(iri)
  }

  /**
   * Change the default graph: one tick (or part of the open transaction's). Returns the effective
   * change - what it removed that the store held, what it added that the store lacked - which is
   * all the views see.
   */
  apply(delta: Delta): Delta {
    return this.change(undefined, delta)
  }

  /** Change a named graph the views read (ViewsOptions.graphs), as apply does the default graph. */
  write(graph: string, delta: Delta): Delta {
    return this.change(graph, delta)
  }

  /** Parse Turtle and add its triples to the default graph (or `graph`), as one change. */
  load(turtle: string, graph?: string): Delta {
    return this.change(graph, { add: parseTurtle(turtle, this.store.factory), remove: [] })
  }

  /**
   * Run `fn` as one tick: every change it applies or writes reaches the views once, consolidated (a
   * triple added and removed again is no change), when it returns. The store changes at once, so
   * `fn` reads its own writes. Nested calls join the outer transaction.
   */
  transaction<T>(fn: () => T): T {
    if (this.tx) return fn()
    this.tx = new Consolidation()
    try {
      return fn()
    } finally {
      const { all } = this.tx.result()
      this.tx = undefined
      if (all.add.length || all.remove.length) this.step(all)
    }
  }

  /** A tick with no input change: time passed (windows over time expire). */
  advance(): void {
    this.step({ add: [], remove: [] })
  }

  /** Hear every tick, once every view has settled. Returns a function that stops listening. */
  onTick(fn: (tick: number) => void): () => void {
    return this.runtime.afterTick(fn)
  }

  /** Stop: no timer fires, no change is taken in. `release` also lets the store go (GraphStore.dispose). */
  dispose(release = false): void {
    if (this.ended) return
    this.ended = true
    this.runtime.dispose()
    if (release) this.store.dispose?.()
  }

  private change(graph: string | undefined, delta: Delta): Delta {
    if (this.ended) return { add: [], remove: [] }
    const effective = applyEffective(this.store, graph, delta)
    if (!effective.add.length && !effective.remove.length) return effective
    if (this.tx) this.tx.add(graph, effective)
    else this.step(effective)
    return effective
  }

  private step(input: Delta) {
    if (this.ended) return
    this.runtime.tick(input)
  }
}

/** The views over a store (any GraphStore: the built-in kinds' openStore, or one of your own). */
export function createViews(store: GraphStore, opts: ViewsOptions = {}): Views {
  return new Views(store, opts)
}
