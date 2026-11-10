import type { DefaultGraph, Literal, NamedNode, Quad, Quad_Graph, Term } from '@rdfjs/types'
import type { JellyDumpOptions, JellyStoreReader } from '../jelly/store.ts'
import type { FetchPolicy } from '../../rdf-engine/host/fetching.ts'

export type { FetchPolicy, Remote } from '../../rdf-engine/host/fetching.ts'

/**
 * Queries and updates that may reach the network: SPARQL `SERVICE` and `LOAD` (docs/FETCHING.md).
 * Only these fetch, asynchronously, and only what `policy` lists; the synchronous `select` and
 * `construct` (which rules, views and reactions use) refuse them, so no graph reaches the network
 * on its own. Operations on one store run one at a time.
 */
export interface FetchingQueries {
  /** A SELECT (or ASK: true or false) whose SERVICE patterns are answered under `policy`. */
  select(query: string, graphs: Quad_Graph[], policy: FetchPolicy): Promise<Map<string, Term>[]>
  /** A CONSTRUCT whose SERVICE patterns are answered under `policy`. */
  construct(query: string, graphs: Quad_Graph[], policy: FetchPolicy): Promise<Quad[]>
  /**
   * A SPARQL Update with LOAD and SERVICE, applied to the store directly: for a store no runtime
   * drives. A mounted app takes remote data in with `construct` and `runtime.apply` instead.
   */
  update(update: string, policy: FetchPolicy): Promise<void>
}

export interface Factory {
  namedNode(value: string): NamedNode
  literal(value: string, languageOrDatatype?: string | NamedNode): Literal
  defaultGraph(): DefaultGraph
  quad(subject: Term, predicate: Term, object: Term, graph?: Term): Quad
}

/**
 * The minimal store surface the engine needs. Adapters exist for Oxigraph
 * (WASM, with SPARQL) and N3.js (pure JS, no SPARQL).
 */
export interface GraphStore {
  readonly kind: string
  readonly factory: Factory
  readonly sparql: boolean
  /**
   * Whether one match across all graphs costs about what a match in one graph does (each call
   * crosses into WebAssembly, so the call is the cost): the engine then asks across graphs once
   * rather than graph by graph. Optional; stores whose matches are cheap calls omit it.
   */
  readonly crossGraphMatch?: boolean
  /**
   * The SPARQL extension groups (`sx:Math`, … as IRIs; rdf-engine/EXTENSIONS.md) the store's
   * queries may use. Absent: none. A rule that needs a group the store lacks is not chosen.
   */
  readonly extensions?: ReadonlySet<string>
  /** The time zone `sx:formatDateTime` uses when its options name none (undefined: the host's own). */
  readonly timeZone?: string
  add(q: Quad): void
  delete(q: Quad): void
  has(q: Quad): boolean
  /** Match in one graph (`undefined` = all graphs). */
  match(s?: Term | null, p?: Term | null, o?: Term | null, g?: Term | null): Quad[]
  /** Evaluate a SELECT query; one map of variable name to term per solution. */
  select(query: string, graphs: Quad_Graph[]): Map<string, Term>[]
  /** Evaluate a CONSTRUCT query whose default graph is the union of `graphs`. */
  construct(query: string, graphs: Quad_Graph[]): Quad[]
  /**
   * Evaluate a CONSTRUCT query once for each of `values` bound to `variable`
   * (as if written in its place) and return all the triples. Optional: stores
   * with prepared queries skip re-parsing per focus and splicing VALUES.
   */
  constructFor?(query: string, variable: string, values: Term[], graphs: Quad_Graph[]): Quad[]
  loadTurtle(text: string): void
  /**
   * Load a Jelly-RDF stream (docs/JELLY.md): delimited frames, or one bare frame. The statements
   * of a stream of triples go to `graph` (default: the default graph); a stream of quads keeps its
   * graphs. All or nothing. Returns how many statements it read. Optional: the built-in stores all
   * have it (the engines natively, N3.js and Oxigraph through src/jelly/).
   */
  loadJelly?(bytes: Uint8Array, graph?: Quad_Graph): number
  /** What the store holds, in `graph` or every graph, as a Jelly-RDF 1.2 stream of quads. Optional, as loadJelly. */
  dumpJelly?(graph?: Quad_Graph, options?: JellyDumpOptions): Uint8Array
  /** A reader of one Jelly stream into the store, a frame at a time (loadJellyStream uses it). Optional, as loadJelly. */
  jellyReader?(graph?: Quad_Graph): JellyStoreReader
  /** What the store holds as delimited Jelly frames, each as it is written (dumpJellyStream uses it). Optional, as loadJelly. */
  jellyFrames?(graph?: Quad_Graph, options?: JellyDumpOptions): Iterable<Uint8Array>
  /** How many quads it holds, in every graph, without listing them. Optional: else count a match of everything. */
  size?(): number
  /**
   * Housekeeping in small slices (e.g. in idle time), for at most `budgetMs`.
   * Returns whether more remains. Optional; stores without upkeep omit it.
   */
  maintain?(budgetMs: number): boolean
  /**
   * Release what the store holds outside the JavaScript heap (WebAssembly memory), which garbage
   * collection does not see: every Oxigraph store shares one capped WebAssembly memory. The store
   * must not be used afterwards. Optional; stores that hold nothing outside the heap omit it.
   */
  dispose?(): void
  /**
   * A deadline for the queries that follow (select, construct, constructFor), in Date.now()
   * milliseconds; undefined clears it. A query still running at the deadline throws
   * QueryInterrupted, leaving the store as it was. Optional: a store that cannot interrupt a query
   * (Oxigraph has no such hook) omits it, and a long query then runs to the end. The engine sets it
   * to the end of the turn's budget (src/engine/watchdog.ts) and treats an interruption as a stall.
   */
  setDeadline?(at: number | undefined): void
  /**
   * SERVICE and LOAD, under the host's policy. Optional: the Semblance engines (WASM and Rust)
   * have it; Oxigraph's JavaScript build has no HTTP client and N3 no SPARQL, so they omit it.
   */
  readonly fetching?: FetchingQueries
}

/** Thrown by a query a store's deadline (setDeadline) cut off. Nothing was changed. */
export class QueryInterrupted extends Error {
  readonly interrupted = true
  constructor(message = 'Query interrupted: it ran past its deadline') {
    super(message)
    this.name = 'QueryInterrupted'
  }
}

/**
 * What a store's error says, for a message about the rule or reaction that ran the query. A trap
 * (WebAssembly's "unreachable": the engine itself crashed, its instance is not to be trusted after)
 * also says which store and query it was: it names neither itself.
 */
export function storeFailure(store: GraphStore, e: unknown, query: string): string {
  const message = (e as Error).message
  return e instanceof WebAssembly.RuntimeError ? `the ${store.kind} store trapped (${message}) running:\n${query}` : message
}
