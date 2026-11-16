/** Shared XML Schema numeric input. Validity is distinct from its IEEE value.
 *
 * Decimal input is rounded directly to its target precision. In particular,
 * parsing float through Number and then Math.fround can round twice.
 */
const XSD = 'http://www.w3.org/2001/XMLSchema#'

const FAMILIES = [
  'integer', 'decimal', 'float', 'double', 'long', 'int', 'short', 'byte',
  'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger',
  'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
] as const
export type NumericFamily = typeof FAMILIES[number]
export const NUMERIC = new Set<string>(FAMILIES.map(name => XSD + name))
const familyByIRI = new Map<string, NumericFamily>(FAMILIES.map(name => [XSD + name, name]))

const LIMITS: Partial<Record<NumericFamily, readonly [string, string]>> = {
  long: ['9223372036854775807', '9223372036854775808'],
  int: ['2147483647', '2147483648'],
  short: ['32767', '32768'],
  byte: ['127', '128'],
  unsignedLong: ['18446744073709551615', '0'],
  unsignedInt: ['4294967295', '0'],
  unsignedShort: ['65535', '0'],
  unsignedByte: ['255', '0'],
}

export type NumericInput = { readonly valid: false } | {
  readonly valid: true
  readonly family: NumericFamily
  /** May be NaN or infinite for a valid float/double or a wide exact source. */
  readonly value: number
}

const INVALID: NumericInput = Object.freeze({ valid: false })
const xmlSpace = (c: number) => c === 0x20 || c === 9 || c === 10 || c === 13
const digit = (c: number) => c >= 48 && c <= 57
const LIMB_BITS = 8192
const PREFIX_DIGITS = 800

function bounded(value: bigint): bigint {
  if (value < 0n || value.toString(2).length > LIMB_BITS) throw Error('numeric conversion workspace bound')
  return value
}

function bitsNumber(bits: bigint, precision: 24 | 53): number {
  const view = new DataView(new ArrayBuffer(8))
  if (precision === 24) {
    view.setUint32(0, Number(bits), false)
    return view.getFloat32(0, false)
  }
  view.setBigUint64(0, bits, false)
  return view.getFloat64(0, false)
}

/** The exact lower endpoint a*10^exponent, and a nonzero discarded tail. */
function rounded(a: bigint, exponent: number, sticky: boolean, negative: boolean, precision: 24 | 53): number {
  const fraction = precision - 1
  const bias = precision === 53 ? 1023 : 127
  const emin = 1 - bias
  const emax = bias
  const width = precision === 53 ? 64 : 32
  const sign = negative ? 1n << BigInt(width - 1) : 0n
  const infinity = ((1n << BigInt(precision === 53 ? 11 : 8)) - 1n) << BigInt(fraction)
  if (a === 0n) return bitsNumber(sign, precision)
  // The caller's decimal-order decision bounds every exponent before here.
  if (!Number.isInteger(exponent) || exponent < -1123 || exponent > 308) throw Error('numeric exponent bound')
  let numerator = a
  let denominator = 1n
  if (exponent >= 0) numerator = bounded(numerator * 5n ** BigInt(exponent))
  else denominator = bounded(5n ** BigInt(-exponent))
  let e = numerator.toString(2).length - denominator.toString(2).length
  const below = e >= 0 ? numerator < bounded(denominator << BigInt(e)) : bounded(numerator << BigInt(-e)) < denominator
  if (below) e--
  e += exponent
  if (e > emax) return bitsNumber(sign | infinity, precision)
  let quantum = Math.max(e - fraction, emin - fraction)
  const shift = exponent - quantum
  if (shift >= 0) numerator = bounded(numerator << BigInt(shift))
  else denominator = bounded(denominator << BigInt(-shift))
  let q = numerator / denominator
  const remainder = numerator % denominator
  const twice = bounded(remainder << 1n)
  if (twice > denominator || (twice === denominator && (sticky || (q & 1n) !== 0n))) q++
  if (q === 0n) return bitsNumber(sign, precision)
  const hidden = 1n << BigInt(fraction)
  if (q >= hidden << 1n) {
    q >>= 1n
    quantum++
  }
  if (q < hidden) return bitsNumber(sign | q, precision)
  const normalExponent = quantum + fraction
  if (normalExponent > emax) return bitsNumber(sign | infinity, precision)
  if (q >= hidden << 1n || normalExponent < emin) throw Error('numeric quotient bound')
  return bitsNumber(sign | (BigInt(normalExponent + bias) << BigInt(fraction)) | (q - hidden), precision)
}

/** Read one of the sixteen numeric datatype families without coercing invalid
 * hex, whitespace-only input or an out-of-range integer subtype to a number.
 * Extra storage is bounded by the 800-digit prefix and fixed-size big integers;
 * the complete source is scanned even when the value is zero or overflows.
 */
export function numericInput(value: string, datatype: string): NumericInput {
  const family = familyByIRI.get(datatype)
  if (!family || typeof value !== 'string') return INVALID
  let begin = 0
  let end = value.length
  while (begin < end && xmlSpace(value.charCodeAt(begin))) begin++
  while (end > begin && xmlSpace(value.charCodeAt(end - 1))) end--
  if (begin === end) return INVALID
  const floating = family === 'float' || family === 'double'
  const precision = family === 'float' ? 24 : 53
  let at = begin
  let negative = false
  if (value.charCodeAt(at) === 43 || value.charCodeAt(at) === 45) {
    negative = value.charCodeAt(at) === 45
    at++
  }
  if (at === end) return INVALID
  if (floating && end - at === 3 && value.charCodeAt(at) === 73 && value.charCodeAt(at + 1) === 78 && value.charCodeAt(at + 2) === 70) {
    return { valid: true, family, value: negative ? -Infinity : Infinity }
  }
  if (floating && at === begin && end - at === 3 && value.charCodeAt(at) === 78 && value.charCodeAt(at + 1) === 97 && value.charCodeAt(at + 2) === 78) {
    return { valid: true, family, value: NaN }
  }
  let dot = false
  let digits = 0
  let fractional = 0
  let significant = 0
  let first = -1
  let prefix = 0n
  let kept = 0
  let sticky = false
  while (at < end) {
    const c = value.charCodeAt(at)
    if (digit(c)) {
      digits++
      if (dot) fractional++
      if (first !== -1 || c !== 48) {
        if (first === -1) first = at
        significant++
        if (kept < PREFIX_DIGITS) {
          prefix = prefix * 10n + BigInt(c - 48)
          kept++
        } else if (c !== 48) sticky = true
      }
      at++
    } else if (c === 46 && !dot && family !== 'integer' && (family === 'decimal' || floating)) {
      dot = true
      at++
    } else break
  }
  if (!digits) return INVALID
  let exponent = 0n
  if (at < end) {
    if (!floating || (value.charCodeAt(at) !== 101 && value.charCodeAt(at) !== 69)) return INVALID
    at++
    let exponentNegative = false
    if (value.charCodeAt(at) === 43 || value.charCodeAt(at) === 45) {
      exponentNegative = value.charCodeAt(at) === 45
      at++
    }
    if (at === end) return INVALID
    const cap = BigInt(value.length) + 2048n
    while (at < end) {
      const c = value.charCodeAt(at++)
      if (!digit(c)) return INVALID
      if (exponent < cap) {
        exponent = exponent * 10n + BigInt(c - 48)
        if (exponent > cap) exponent = cap
      }
    }
    if (exponentNegative) exponent = -exponent
  }
  if (at !== end) return INVALID
  const zero = first === -1
  if (!floating && family !== 'decimal') {
    if ((family === 'positiveInteger' && (negative || zero)) || (family === 'negativeInteger' && (!negative || zero)) ||
        (family === 'nonPositiveInteger' && !negative && !zero) ||
        ((family === 'nonNegativeInteger' || family.startsWith('unsigned')) && negative && !zero)) return INVALID
    const limits = LIMITS[family]
    if (limits && !zero) {
      const limit = limits[negative ? 1 : 0]
      if (significant > limit.length) return INVALID
      if (significant === limit.length) {
        for (let i = 0; i < significant; i++) {
          const d = value.charCodeAt(first + i) - limit.charCodeAt(i)
          if (d > 0) return INVALID
          if (d < 0) break
        }
      }
    }
  }
  if (zero) return { valid: true, family, value: floating && negative ? -0 : 0 }
  const e = exponent - BigInt(fractional) + BigInt(significant - kept)
  const order = BigInt(kept - 1) + e
  if (order >= BigInt(precision === 53 ? 309 : 39)) return { valid: true, family, value: negative ? -Infinity : Infinity }
  if (order < BigInt(precision === 53 ? -324 : -46)) return { valid: true, family, value: negative ? -0 : 0 }
  return { valid: true, family, value: rounded(prefix, Number(e), sticky, negative, precision) }
}
