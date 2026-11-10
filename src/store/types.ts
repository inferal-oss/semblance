import type { DefaultGraph, Literal, NamedNode, Quad, Quad_Graph, Term } from '@rdfjs/types'
import type { JellyDumpOptions, JellyStoreReader } from '../jelly/store.ts'
import type { FetchPolicy } from '../../rdf-engine/host/fetching.ts'

export type { FetchPolicy, Remote } from '../../rdf-engine/host/fetching.ts'

/** What `query` answers: a SELECT's solutions, an ASK's boolean, or a CONSTRUCT's (or DESCRIBE's) triples. */
export type QueryAnswer = Map<string, Term>[] | boolean | Quad[]

export interface QueryOptions {
  /** The default graph is the union of these (absent: the store's default graph). */
  graphs?: Quad_Graph[]
  /**
   * A policy for this call only, which can only narrow the store's (docs/FETCHING.md): what both
   * list, within the smaller of each limit (a deadline, fewer requests). Where and how a remote is
   * fetched (url, headers, credentials, fetch) is the store's alone.
   */
  policy?: FetchPolicy
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
   * Answer any SPARQL query, asynchronously: the one entry point for host code. Only here do
   * `SERVICE` patterns reach the network, and only what the store's fetch policy lists
   * (docs/FETCHING.md); the synchronous `select` and `construct` (which rules, views and reactions
   * use) refuse them. The engines (wat, rust) run one such call at a time per store. Oxigraph and
   * N3 answer what they can and refuse SERVICE.
   */
  query<T extends QueryAnswer = QueryAnswer>(query: string, options?: QueryOptions): Promise<T>
  /**
   * A SPARQL Update, with `LOAD` and `SERVICE` under the store's fetch policy, applied to the store
   * directly: for a store no runtime drives (a mounted app takes remote data in with `query` and
   * `runtime.apply` instead). Optional: the engines and Oxigraph have it (Oxigraph refuses LOAD
   * and SERVICE); N3 and the hybrid store omit it.
   */
  update?(update: string, options?: Pick<QueryOptions, 'policy'>): Promise<void>
  /**
   * Replace the store's fetch policy (undefined: nothing may be fetched). The host sets it where it
   * creates the store (`createStore`, `mount`, a site's config, all `fetchPolicy`); no graph can
   * add to it. Optional: only the engines fetch, and the stores that do not omit it.
   */
  setFetchPolicy?(policy: FetchPolicy | undefined): void
}

/** What a store that does not fetch says to SERVICE, LOAD or a fetch policy. */
export const doesNotFetch = (kind: string) => new Error(`The ${kind} store does not fetch: SERVICE and LOAD need one of Semblance's engines, 'wat' or 'rust' (docs/FETCHING.md)`)

/**
 * Give `store` the host's fetch policy (undefined: nothing may be fetched), as createStore, mount and
 * a site's config do. A store that does not fetch refuses a policy, rather than ignore it.
 */
export function configureFetching<S extends GraphStore>(store: S, policy: FetchPolicy | undefined): S {
  if (store.setFetchPolicy) store.setFetchPolicy(policy)
  else if (policy) throw doesNotFetch(store.kind)
  return store
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
