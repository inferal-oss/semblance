// The host side of the sx:Math and sx:Locale extensions (EXTENSIONS.md): what
// the engines' `math` and `intl` imports compute. Function rules that twin a
// SPARQL rule using them call these too, so both render the same bytes.

/** `math(op, x, y)`: op 0 log … 11 atan2, 12 sqrt, in EXTENSIONS.md's order. */
export const MATH_OPS: readonly ((x: number, y: number) => number)[] = [
  Math.log,
  Math.log10,
  Math.log2,
  Math.exp,
  Math.pow,
  Math.sin,
  Math.cos,
  Math.tan,
  Math.asin,
  Math.acos,
  Math.atan,
  Math.atan2,
  Math.sqrt,
]

/** `key=value;…` as an Intl options object: `true`, `false` and numbers as such. */
export function intlOptions(options: string | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (!options) return out
  for (const pair of options.split(';')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const key = pair.slice(0, eq).trim()
    const v = pair.slice(eq + 1).trim()
    out[key] = v === 'true' ? true : v === 'false' ? false : v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v
  }
  return out
}

// Constructing an Intl formatter costs far more than using one: keep them.
const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.Collator>()
function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.Collator>(key: string, make: () => T): T {
  let f = cache.get(key) as T | undefined
  if (!f) {
    if (cache.size >= 256) cache.clear()
    cache.set(key, (f = make()))
  }
  return f
}

/** A numeric literal's lexical form as a JavaScript number (INF, -INF, NaN included). */
export function numberOf(lexical: string): number {
  const s = lexical.trim()
  return s === 'INF' || s === '+INF' ? Infinity : s === '-INF' ? -Infinity : s === 'NaN' ? NaN : Number(s)
}

/** An xsd:dateTime or xsd:date lexical form as a Date: no timezone means UTC, a date is its midnight. */
export function dateOf(lexical: string): Date {
  const s = lexical.trim()
  const m = /^(-?\d{4,}-\d{2}-\d{2})(T[^Z+-]*)?(Z|[+-]\d{2}:\d{2})?$/.exec(s)
  if (!m) return new Date(NaN)
  return new Date(`${m[1]}${m[2] ?? 'T00:00:00'}${m[3] ?? 'Z'}`)
}

/** sx:formatNumber. */
export function formatNumber(n: number, lang: string, options?: string): string {
  return cached(`n\0${lang}\0${options ?? ''}`, () => new Intl.NumberFormat(lang, intlOptions(options))).format(n)
}

type WeekInfo = { firstDay: number }
const dateFormats = new Map<string, { format: Intl.DateTimeFormat; part?: string; fields?: Map<string, string>; info?: string }>()

/**
 * sx:formatDateTime; `timeZone` applies when the options name none. Three options are not
 * Intl's (EXTENSIONS.md): `part=<type>` is the text of that field alone (formatToParts; "" when
 * there is none), `fields=<type>:<text>,…` the formatted text with those fields' texts replaced,
 * and `info=` what the locale says rather than a date: `firstDay` (1 Monday … 7 Sunday),
 * `hourCycle` (as resolved, "" without an hour) or `locale` (the tag, canonical).
 */
export function formatDateTime(d: Date, lang: string, options?: string, timeZone?: string): string {
  const key = `${lang}\0${options ?? ''}\0${timeZone ?? ''}`
  let f = dateFormats.get(key)
  if (!f) {
    const o = intlOptions(options)
    const { part, fields, info } = o
    delete o.part
    delete o.fields
    delete o.info
    if (timeZone && o.timeZone === undefined) o.timeZone = timeZone
    f = {
      format: new Intl.DateTimeFormat(lang, o),
      part: part === undefined ? undefined : String(part),
      fields: fields === undefined ? undefined : new Map(String(fields).split(',').map((pair) => [pair.slice(0, pair.indexOf(':')), pair.slice(pair.indexOf(':') + 1)])),
      info: info === undefined ? undefined : String(info),
    }
    if (dateFormats.size >= 256) dateFormats.clear()
    dateFormats.set(key, f)
  }
  if (f.info === 'locale') return Intl.getCanonicalLocales(lang)[0]!
  if (f.info === 'hourCycle') return f.format.resolvedOptions().hourCycle ?? ''
  if (f.info === 'firstDay') {
    const locale = new Intl.Locale(lang) as Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo }
    return String((locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay ?? '')
  }
  if (f.info !== undefined) throw new RangeError(`no info ${f.info}`)
  if (f.part !== undefined) return f.format.formatToParts(d).find((p) => p.type === f.part)?.value ?? ''
  if (f.fields) return f.format.formatToParts(d).map((p) => (p.type === 'literal' ? p.value : (f.fields!.get(p.type) ?? p.value))).join('')
  return f.format.format(d)
}

/** sx:collated as an ORDER BY key: -1, 0 or 1. */
export function collate(lang: string, a: string, b: string): number {
  return Math.sign(cached(`c\0${lang}`, () => new Intl.Collator(lang)).compare(a, b))
}

/** sx:sortKey: case folded, accents stripped. */
export function sortKey(s: string, lang: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase(lang || undefined)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The `intl` import over an engine's memory; `timeZone()` is the store's zone (undefined: the host's). */
export function intlImport(memory: () => WebAssembly.Memory, timeZone: () => string | undefined) {
  return (op: number, inPtr: number, inLen: number, outPtr: number, outCap: number): number => {
    const args = decoder.decode(new Uint8Array(memory().buffer, inPtr, inLen)).split('\0')
    let out: string
    try {
      switch (op) {
        case 0:
          out = formatNumber(numberOf(args[0]!), args[1]!, args[2])
          break
        case 1: {
          const d = dateOf(args[0]!)
          if (Number.isNaN(d.getTime())) return -2147483648
          out = formatDateTime(d, args[1]!, args[2], timeZone())
          break
        }
        case 2:
          return collate(args[0]!, args[1] ?? '', args[2] ?? '')
        case 3:
          out = sortKey(args[0]!, args[1] ?? '')
          break
        default:
          return -2147483648
      }
    } catch {
      return -2147483648
    }
    const bytes = encoder.encode(out)
    if (bytes.length > outCap) return -bytes.length
    new Uint8Array(memory().buffer, outPtr, bytes.length).set(bytes)
    return bytes.length
  }
}
