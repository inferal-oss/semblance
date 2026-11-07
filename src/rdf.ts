import type { Literal, NamedNode, Quad, Term } from '@rdfjs/types'

export type { Literal, NamedNode, Quad, Term }

const XSD = 'http://www.w3.org/2001/XMLSchema#'
const INTEGERS = new Set(['integer', 'long', 'int', 'short', 'byte', 'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte'].map((t) => XSD + t))
const DECIMAL = /^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$/
const INTEGER = /^[+-]?[0-9]+$/
const FLOATING = /^([+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?|[+-]?INF|NaN)$/

/** The canonical form of an xsd:decimal's or xsd:integer's text ("+1.50" -> "1.5", "-0.0" -> "0", "007" -> "7"). */
export function canonicalDecimal(text: string): string {
  const negative = text.startsWith('-')
  const [whole = '', fraction = ''] = text.replace(/^[+-]/, '').split('.')
  const int = whole.replace(/^0+(?=[0-9])/, '') || '0'
  const frac = fraction.replace(/0+$/, '')
  return (negative && (int !== '0' || frac) ? '-' : '') + int + (frac ? '.' + frac : '')
}

/** Two texts of a decimal that are the same number ("1.0", "1"). */
export const sameDecimal = (a: string, b: string): boolean => DECIMAL.test(a) && DECIMAL.test(b) && canonicalDecimal(a) === canonicalDecimal(b)

/** A double or a float as the engines write it: the shortest digits that read back, in plain notation. */
function canonicalFloating(text: string, float: boolean): string {
  const n = text.endsWith('INF') ? (text.startsWith('-') ? -Infinity : Infinity) : text === 'NaN' ? NaN : float ? Math.fround(Number(text)) : Number(text)
  if (Number.isNaN(n)) return 'NaN'
  if (!Number.isFinite(n)) return n < 0 ? '-INF' : 'INF'
  if (Object.is(n, -0)) return '-0'
  let digits = String(n)
  if (float) for (let p = 1; p < 10; p++) if (Math.fround(Number(n.toPrecision(p))) === n) { digits = String(Number(n.toPrecision(p))); break }
  const [mantissa = '', exponent] = digits.split('e')
  if (exponent === undefined) return mantissa
  const negative = mantissa.startsWith('-')
  const [whole = '', fraction = ''] = mantissa.replace('-', '').split('.')
  const point = whole.length + Number(exponent)
  const all = whole + fraction
  const plain = point <= 0 ? '0.' + '0'.repeat(-point) + all : point >= all.length ? all + '0'.repeat(point - all.length) : all.slice(0, point) + '.' + all.slice(point)
  return (negative ? '-' : '') + plain
}

/**
 * A term's text for showing it: a well-formed number in its canonical form, which is what the SPARQL
 * rules write as IF(isNumeric(?v), xsd:string(?v), STR(?v)), anything else as it is. Stores differ in
 * a number's own text (Oxigraph keeps the value, the others the lexical form "1.50"), so what is
 * shown never takes it from them.
 */
export function numberText(t: Term): string {
  if (t.termType !== 'Literal') return t.value
  const type = t.datatype.value
  if (type === XSD + 'decimal') return DECIMAL.test(t.value) ? canonicalDecimal(t.value) : t.value
  if (INTEGERS.has(type)) return INTEGER.test(t.value) ? canonicalDecimal(t.value) : t.value
  if (type === XSD + 'double' || type === XSD + 'float') return FLOATING.test(t.value) ? canonicalFloating(t.value, type === XSD + 'float') : t.value
  return t.value
}

/** Canonical string key for a term (N-Triples-like, graph excluded). */
export function termKey(t: Term): string {
  switch (t.termType) {
    case 'NamedNode':
      return '<' + t.value + '>'
    case 'Literal':
      return t.language ? `"${t.value}"@${t.language}` : `"${t.value}"^^${t.datatype.value}`
    case 'BlankNode':
      return '_:' + t.value
    case 'DefaultGraph':
      return ''
    default:
      return '?' + t.value
  }
}

export const quadKey = (q: Quad): string => termKey(q.subject) + ' ' + q.predicate.value + ' ' + termKey(q.object)

/** A change to a graph. Removals are applied before additions. */
export interface Delta {
  add: Quad[]
  remove: Quad[]
}

export const emptyDelta = (): Delta => ({ add: [], remove: [] })

/**
 * Minted IRIs live "under" the focus they were generated for: `<focus>/~<local>`.
 * The local part never contains `/~`, so the owning focus is everything before
 * the last `/~`. A focus may be minted itself (a block's handle): see mintedUnder.
 */
export const MINT_SEPARATOR = '/~'
export const mint = (focus: string, local: string): string => focus + MINT_SEPARATOR + local
export function owningFocus(iri: string): string {
  const i = iri.lastIndexOf(MINT_SEPARATOR)
  return i < 0 ? iri : iri.slice(0, i)
}

/**
 * Which of `foci` a subject belongs to: itself, or the nearest above it. The shape of an IRI cannot
 * say that alone: `<a>/~b` is a node `<a>` minted, or the focus `<a>/~b` writing about itself.
 */
export function mintedUnder(iri: string, foci: ReadonlySet<string>): string | undefined {
  for (let at = iri, up = owningFocus(at); ; at = up, up = owningFocus(at)) {
    if (foci.has(at)) return at
    if (up === at) return undefined
  }
}

/** Milliseconds in an ISO 8601 duration (days, hours, minutes, seconds). */
export function parseDuration(iso: string): number | undefined {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso)
  if (!m) return undefined
  const [, d = 0, h = 0, min = 0, sec = 0] = m.map((x) => (x === undefined ? undefined : Number(x)))
  return (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec)) * 1000
}
