import type { DefaultGraph, Literal, NamedNode, Quad, Quad_Graph, Term } from '@rdfjs/types'

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
  add(q: Quad): void
  delete(q: Quad): void
  has(q: Quad): boolean
  /** Match in one graph (`undefined` = all graphs). */
  match(s?: Term | null, p?: Term | null, o?: Term | null, g?: Term | null): Quad[]
  /** Evaluate a SELECT query; one map of variable name to term per solution. */
  select(query: string, graphs: Quad_Graph[]): Map<string, Term>[]
  /** Evaluate a CONSTRUCT query whose default graph is the union of `graphs`. */
  construct(query: string, graphs: Quad_Graph[]): Quad[]
  loadTurtle(text: string): void
}
