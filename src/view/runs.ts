// A run of a query, as data (ontology/layers/view.ttl, iv:ResultSet): what a view whose result a
// person reads (the workbench, a result table) writes to the views graph, whatever its form - a
// SELECT's rows, a CONSTRUCT's triples as rows, an ASK's answer, or the error a run ended in - so a
// component shows it with plain SPARQL:
//
//   <view> a rs:ResultSet ; rs:resultVariable "v" … ; iv:column <view>/~column-i … ; iv:rowCount n
//          [ iv:triples true ]   (the rows are a CONSTRUCT's triples: ?subject ?predicate ?object)
//          [ rs:boolean b ]      (an ASK: no rows)
//          [ iv:error "…" ]      (a failed run: no rows)
//   <view>/~column-i rs:variable "v" ; rs:index i             (the columns in order, 1-based)
//   <view>/~row-<hash> rs:binding <row>-v ; rs:index i        (every row, 1-based, in a stable order)
//   <row>-v rs:variable "v" ; rs:value term [ iv:label "_:b" ]  (a blank node's label)
//
// A row's node is keyed by its values (its nth copy, when the result has it n times, ends in .n), so a
// row that is in the next run too keeps its node. Under a minted IRI (<x>/~run) the parts are minted
// with "-" (<x>/~run-row-…), as view rows are (view.ttl).
import type { Quad, Term } from '@rdfjs/types'
import { md5 } from '../components/data.ts'
import { NS, RDF_TYPE } from '../ns.ts'
import { quadKey, termKey } from '../rdf.ts'
import { queryForm, resultColumns } from '../sparql-forms.ts'
import type { Factory } from '../store/types.ts'
import { ZSet } from './zset.ts'

const RS = NS.rs
const IV = NS.iv

type Row = Map<string, Term>

/** What a run of a query gave. */
export type RunResult =
  | { kind: 'rows'; vars: string[]; rows: Row[] }
  | { kind: 'triples'; quads: Quad[] }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'error'; message: string }

export interface QueryRunner {
  select(q: string): Map<string, Term>[] | boolean
  construct(q: string): Quad[]
}

/** The longest error message a run keeps. */
const ERROR_LENGTH = 600

/** Run a query of any form; never throws (a failure is a result like any other). */
export function runQuery(run: QueryRunner, text: string, construct: boolean): RunResult {
  try {
    if (construct || /^(CONSTRUCT|DESCRIBE)$/.test(queryForm(text) ?? '')) return { kind: 'triples', quads: run.construct(text) }
    const result = run.select(text) as unknown
    if (typeof result === 'boolean') return { kind: 'boolean', value: result }
    if (!Array.isArray(result)) return { kind: 'error', message: 'The query returned no results the workbench can show.' }
    const rows = result as Row[]
    return { kind: 'rows', vars: resultColumns(text, rows), rows }
  } catch (e) {
    const message = String((e as Error)?.message ?? e)
    return { kind: 'error', message: message.length > ERROR_LENGTH ? message.slice(0, ERROR_LENGTH - 1) + '…' : message }
  }
}

/** A part of a result set's node: minted under it (<x>/~part), or after "-" when it is itself minted. */
const part = (iri: string, local: string) => iri + (iri.includes('/~') ? '-' : '/~') + local

/** The rows of a CONSTRUCT's triples, in a stable order (by subject, predicate, object). */
export function tripleRows(quads: readonly Quad[]): Row[] {
  const seen = new Map<string, Quad>()
  for (const q of quads) seen.set(quadKey(q), q)
  return [...seen.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, q]) => new Map<string, Term>([['subject', q.subject], ['predicate', q.predicate], ['object', q.object]]))
}

const rowKey = (row: Row) =>
  [...row.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, t]) => `${k}=${termKey(t)}`)
    .join(' ')

/** A run's result as the triples of a result set on `iri` (in `graph`). */
export function resultSetQuads(f: Factory, graph: Quad['graph'], iri: string, result: RunResult): Quad[] {
  const nn = (x: string) => f.namedNode(x)
  const int = (n: number) => f.literal(String(n), nn(NS.xsd + 'integer'))
  const base = nn(iri)
  const out: Quad[] = [f.quad(base, nn(RDF_TYPE), nn(RS + 'ResultSet'), graph)]
  const t = (s: Quad['subject'], p: string, o: Term) => out.push(f.quad(s, nn(p), o as Quad['object'], graph))
  if (result.kind === 'error') return t(base, IV + 'error', f.literal(result.message)), out
  if (result.kind === 'boolean') return t(base, RS + 'boolean', f.literal(String(result.value), nn(NS.xsd + 'boolean'))), out
  const vars = result.kind === 'triples' ? ['subject', 'predicate', 'object'] : result.vars
  const rows = result.kind === 'triples' ? tripleRows(result.quads) : result.rows
  if (result.kind === 'triples') t(base, IV + 'triples', f.literal('true', nn(NS.xsd + 'boolean')))
  t(base, IV + 'rowCount', int(rows.length))
  vars.forEach((v, i) => {
    const col = nn(part(iri, `column-${i + 1}`))
    t(base, RS + 'resultVariable', f.literal(v))
    t(base, IV + 'column', col)
    t(col, RS + 'variable', f.literal(v))
    t(col, RS + 'index', int(i + 1))
  })
  const copies = new Map<string, number>()
  rows.forEach((row, i) => {
    const hash = md5(rowKey(row)).slice(0, 12)
    const n = (copies.get(hash) ?? 0) + 1
    copies.set(hash, n)
    const node = nn(part(iri, 'row-' + hash + (n > 1 ? '.' + n : '')))
    t(base, RS + 'solution', node)
    t(node, RS + 'index', int(i + 1))
    for (const v of vars) {
      const value = row.get(v)
      if (!value) continue
      const b = nn(node.value + '-' + v)
      t(node, RS + 'binding', b)
      t(b, RS + 'variable', f.literal(v))
      t(b, RS + 'value', value)
      if (value.termType === 'BlankNode') t(b, IV + 'label', f.literal('_:' + value.value))
    }
  })
  return out
}

/** What a view has written of its result set: the next run's triples replace them, as a difference. */
export class ResultSetWriter {
  private current = new Map<string, Quad>()
  last?: RunResult

  write(next: Quad[], out: ZSet<Quad>, result: RunResult) {
    this.last = result
    const keyed = new Map(next.map((q) => [quadKey(q), q]))
    for (const [k, q] of this.current) if (!keyed.has(k)) out.add(k, q, -1)
    for (const [k, q] of keyed) if (!this.current.has(k)) out.add(k, q, 1)
    this.current = keyed
  }

  clear(out: ZSet<Quad>) {
    for (const [k, q] of this.current) out.add(k, q, -1)
    this.current.clear()
    this.last = undefined
  }

  quads(): Quad[] {
    return [...this.current.values()]
  }
}
