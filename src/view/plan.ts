// The circuit IR for maintained views (docs/IVM.md §5, §20). A plan says what a view
// computes, independently of how its parts are evaluated (SPARQL on the store, or
// functions), so a compiler that reads a real algebra (the rdf-engine's Rust parser)
// can replace phase 1's recognizer behind the same interface.
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import type { RuleContext } from '../engine/context.ts'

export type AggregateFn = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'

export interface Aggregate {
  /** Output variable (without '?'). */
  as: string
  fn: AggregateFn
  distinct: boolean
  /** The argument: '*' (COUNT(*)), or the member-local row slot holding its value. */
  slot: string
}

/** A sliding window over the members' timestamps (iv:SlidingWindow). */
export interface WindowSpec {
  rangeMs: number
  /** The timestamp property (iv:timeBy, else the stream's ldes:timestampPath). */
  timeBy: string
}

/** Rows (variable name -> term) one member contributes, evaluated for many members at once. */
export type LocalEvaluator = (members: readonly { stream: NamedNode; member: NamedNode }[]) => Map<string, Map<string, Term>[]>
/** The triples one aggregate row stands for (CONSTRUCT views). */
export type OutputEvaluator = (row: Map<string, Term>) => Quad[]

/**
 * Aggregates over the members of LDES streams: a member-local part, evaluated once per
 * (stream, member) and cached until the member retires or changes (a partitioned
 * recompute leaf); a sliding window (optional); then GROUP BY with incremental
 * aggregates; then, for CONSTRUCT views, the triples of each group's row.
 */
export interface StreamAggregatePlan {
  kind: 'stream-aggregate'
  form: 'select' | 'construct'
  /** A fixed stream, or undefined for every subject of tree:member (then bound to `streamVar`). */
  stream?: string
  streamVar?: string
  memberVar: string
  groupBy: string[]
  aggregates: Aggregate[]
  window?: WindowSpec
  local: LocalEvaluator
  output?: OutputEvaluator
  /** SPARQL algebra of each part, for the plan as data (iv:algebra). */
  algebra: { local: string; group: string; output?: string }
  /** The from-scratch query this view must equal at clock time `now` (the test oracle). */
  reference?: (now: number) => string
}

/** A view the compiler cannot maintain: re-run from scratch when its inputs change, and diffed. */
export interface RecomputePlan {
  kind: 'recompute'
  form: 'select' | 'construct'
  query: string
  reason: string
}

export type ViewPlan = StreamAggregatePlan | RecomputePlan

/** What a compiler gets: the view's query and its annotations. */
export interface ViewSource {
  iri: string
  form: 'select' | 'construct'
  query: string
  prefixes: string
  /** iv:over */
  over?: string
  window?: { rangeMs: number; timeBy?: string }
}

export interface ViewCompiler {
  /** A plan whose parts run on `store` (SPARQL), or a recompute plan with the reason. */
  compile(source: ViewSource, run: SparqlRunner): ViewPlan
}

export interface SparqlRunner {
  select(query: string): Map<string, Term>[]
  construct(query: string): Quad[]
  /** The stream's timestamp property (ldes:timestampPath), if it has one. */
  timestampPath(stream: string): string | undefined
}

/**
 * A view written as functions (sem:function on the iv:View): the same plan, with
 * TypeScript evaluators. Tests check it agrees with the view's SPARQL.
 */
export interface FnView {
  stream?: string
  streamVar?: string
  memberVar: string
  groupBy: string[]
  aggregates: Aggregate[]
  /** Rows of one member (variable -> term; aggregate slots are variables). */
  local(ctx: RuleContext, stream: NamedNode, member: NamedNode): Map<string, Term>[]
  output?(ctx: RuleContext, row: Map<string, Term>): Quad[]
}
