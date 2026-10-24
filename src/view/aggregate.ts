// Incremental GROUP BY aggregates (docs/IVM.md §6.5): per group, an accumulator per
// aggregate that rows enter (+1) and leave (-1). COUNT, SUM and AVG are invertible;
// MIN and MAX keep the group's values ordered; DISTINCT keeps values with weights.
import type { Term } from '@rdfjs/types'
import type { Factory } from '../store/types.ts'
import type { Aggregate } from './plan.ts'
import type { Terms } from './terms.ts'

const XSD = 'http://www.w3.org/2001/XMLSchema#'
/** Numeric type ranks for SPARQL's promotion: integer < decimal < float < double. */
const RANK: Record<string, number> = { [XSD + 'decimal']: 1, [XSD + 'float']: 2, [XSD + 'double']: 3 }
const TYPE = [XSD + 'integer', XSD + 'decimal', XSD + 'float', XSD + 'double']

interface Acc {
  /** COUNT: rows counted. SUM/AVG: numeric values summed. */
  n: number
  sum: number
  /** Unbound or non-numeric values (SUM, AVG: the result is an error, i.e. unbound). */
  errors: number
  /** Values per numeric type rank, so a retraction can narrow the result type again. */
  types: [number, number, number, number]
  /** DISTINCT, MIN, MAX: value id -> weight. */
  values?: Map<number, number>
  /** MIN, MAX: the values in order. */
  sorted?: number[]
}

export interface Group {
  ids: number[]
  rows: number
  accs: Acc[]
}

export function newGroup(ids: number[], aggregates: readonly Aggregate[]): Group {
  return {
    ids,
    rows: 0,
    accs: aggregates.map((a) => ({ n: 0, sum: 0, errors: 0, types: [0, 0, 0, 0], values: a.distinct || a.fn === 'MIN' || a.fn === 'MAX' ? new Map() : undefined, sorted: a.fn === 'MIN' || a.fn === 'MAX' ? [] : undefined })),
  }
}

/** Order of SPARQL terms for MIN / MAX: numbers by value, dates by time, then by kind and text. */
export function compareTerms(terms: Terms, a: number, b: number): number {
  if (a === b) return 0
  const na = terms.number(a)
  const nb = terms.number(b)
  if (na !== undefined && nb !== undefined) return na - nb || (terms.key(a) < terms.key(b) ? -1 : 1)
  const ta = terms.term(a)!
  const tb = terms.term(b)!
  const kind = (t: Term) => (t.termType === 'BlankNode' ? 0 : t.termType === 'NamedNode' ? 1 : 2)
  if (kind(ta) !== kind(tb)) return kind(ta) - kind(tb)
  if (ta.termType === 'Literal' && tb.termType === 'Literal' && ta.datatype.value === XSD + 'dateTime' && tb.datatype.value === XSD + 'dateTime') {
    const d = Date.parse(ta.value) - Date.parse(tb.value)
    if (d) return d
  }
  return ta.value < tb.value ? -1 : ta.value > tb.value ? 1 : terms.key(a) < terms.key(b) ? -1 : 1
}

/** A value enters (w = 1) or leaves (w = -1) one aggregate. `value` is a term id (0 = unbound). */
export function accumulate(terms: Terms, a: Aggregate, acc: Acc, value: number, w: number): void {
  if (a.slot === '*') {
    acc.n += w
    return
  }
  if (acc.values) {
    if (!value) {
      if (a.fn === 'SUM' || a.fn === 'AVG') acc.errors += w
      return
    }
    const before = acc.values.get(value) ?? 0
    const after = before + w
    if (after) acc.values.set(value, after)
    else acc.values.delete(value)
    if (acc.sorted) {
      if (before === 0 && after > 0) acc.sorted.splice(search(terms, acc.sorted, value), 0, value)
      else if (before > 0 && after === 0) acc.sorted.splice(search(terms, acc.sorted, value), 1)
      return
    }
    // DISTINCT: a value counts while its weight is positive.
    if (before === 0 && after > 0) numeric(terms, a, acc, value, 1)
    else if (before > 0 && after === 0) numeric(terms, a, acc, value, -1)
    return
  }
  if (!value) {
    if (a.fn === 'SUM' || a.fn === 'AVG') acc.errors += w
    return
  }
  numeric(terms, a, acc, value, w)
}

function numeric(terms: Terms, a: Aggregate, acc: Acc, value: number, w: number) {
  if (a.fn === 'COUNT') {
    acc.n += w
    return
  }
  const n = terms.number(value)
  if (n === undefined) {
    acc.errors += w
    return
  }
  acc.n += w
  acc.sum += w * n
  const t = terms.term(value) as { datatype: { value: string } }
  acc.types[RANK[t.datatype.value] ?? 0]! += w
}

function search(terms: Terms, sorted: number[], value: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (compareTerms(terms, sorted[mid]!, value) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

const fmt = (n: number, type: string) => (type === TYPE[0] ? String(Math.round(n)) : String(n))

/** The aggregate's current value as a term (undefined: unbound). */
export function result(f: Factory, terms: Terms, a: Aggregate, acc: Acc): Term | undefined {
  const lit = (n: number, type: string) => f.literal(fmt(n, type), f.namedNode(type))
  switch (a.fn) {
    case 'COUNT':
      return lit(acc.values && a.slot !== '*' ? acc.values.size : acc.n, TYPE[0]!)
    case 'SUM': {
      if (acc.errors > 0) return undefined
      return lit(acc.sum, TYPE[widest(acc)]!)
    }
    case 'AVG': {
      if (acc.errors > 0) return undefined
      if (acc.n === 0) return lit(0, TYPE[0]!)
      const r = widest(acc)
      return lit(acc.sum / acc.n, TYPE[Math.max(1, r)]!)
    }
    case 'MIN':
      return acc.sorted!.length ? terms.term(acc.sorted![0]!) : undefined
    case 'MAX':
      return acc.sorted!.length ? terms.term(acc.sorted![acc.sorted!.length - 1]!) : undefined
  }
}

function widest(acc: Acc): number {
  for (let r = 3; r > 0; r--) if (acc.types[r]! > 0) return r
  return 0
}

/** Rows of state an aggregate holds (for footprints). */
export function accSize(acc: Acc): number {
  return 1 + (acc.values?.size ?? 0)
}
