import type { JellyTarget } from './jelly.ts'
import type { Row, T } from './terms.ts'

export type RdfFormat = 'turtle' | 'ntriples' | 'nquads' | 'trig' | 'rdfxml'

export interface RdfFile {
  text: string
  format: RdfFormat
  /** The file's IRI, which is also its base IRI. */
  base: string
}

/** The dataset a test runs against: files for the default graph and named graphs. */
export interface Dataset {
  default: RdfFile[]
  named: { name: string; file: RdfFile }[]
  /** SERVICE endpoints the test provides (`qt:serviceData`): what each holds. */
  services?: { endpoint: string; data: RdfFile[] }[]
}

export type QueryResult =
  | { kind: 'boolean'; value: boolean }
  | { kind: 'bindings'; vars: string[]; rows: Map<string, T>[] }
  | { kind: 'graph'; quads: Row[] }

/**
 * What the conformance runner drives. A target is an engine plus a thin
 * adapter; every method throws on a syntax or evaluation error.
 */
export interface Target {
  readonly name: string
  /** Parse RDF and return its quads as rows (s, p, o, g). */
  parse(file: RdfFile): Row[]
  /** Parse a query without evaluating it. */
  parseQuery(text: string, base: string): void
  /** Parse an update without applying it. */
  parseUpdate(text: string, base: string): void
  query(dataset: Dataset, text: string, base: string): QueryResult
  /** Apply an update to the dataset and return every quad of the result. */
  update(dataset: Dataset, text: string, base: string): Row[]
  /** Jelly (the `jelly` suite), when the target reads and writes it. */
  jelly?: JellyTarget
  /**
   * Optional: `query` and `update` with SERVICE and LOAD, the dataset's services answering
   * (and nothing else: any other endpoint or document is unreachable).
   */
  queryFetching?(dataset: Dataset, text: string, base: string): Promise<QueryResult>
  updateFetching?(dataset: Dataset, text: string, base: string): Promise<Row[]>
}
