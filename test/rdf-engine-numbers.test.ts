// How the rdf-engine builds write numbers and cast values to strings. Numbers
// are written as Oxigraph writes them, which Semblance's output relies on:
// decimals without trailing zeros, doubles and floats as the shortest digits
// that read back, in plain notation. A cast to xsd:string writes a number,
// boolean, date, time or duration in that canonical form (XPath's casting rules).
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { wasmTarget } from '../rdf-engine/conformance/targets/wasm.ts'

const built = (['rust', 'wat'] as const).filter((k) => existsSync(new URL(`../rdf-engine/build/${k}.wasm`, import.meta.url)))

/** Expression, and its value as `lexical^^local datatype` (undefined: an error, so unbound). */
const CASES: [string, string | undefined][] = [
  // casts to xsd:string: canonical forms
  ['xsd:string("0"^^xsd:boolean)', 'false^^string'],
  ['xsd:string("1"^^xsd:boolean)', 'true^^string'],
  ['xsd:string("1.0"^^xsd:decimal)', '1^^string'],
  ['xsd:string("+1.50"^^xsd:decimal)', '1.5^^string'],
  ['xsd:string("01"^^xsd:integer)', '1^^string'],
  ['xsd:string("+5"^^xsd:int)', '5^^string'],
  ['xsd:string("1.0E0"^^xsd:double)', '1^^string'],
  ['xsd:string("1e7"^^xsd:double)', '10000000^^string'],
  ['xsd:string("-0"^^xsd:double)', '-0^^string'],
  ['xsd:string("INF"^^xsd:float)', 'INF^^string'],
  ['xsd:string("2002-10-10T17:00:00.000Z"^^xsd:dateTime)', '2002-10-10T17:00:00Z^^string'],
  ['xsd:string("2002-10-10+00:00"^^xsd:date)', '2002-10-10Z^^string'],
  ['xsd:string("PT60M"^^xsd:dayTimeDuration)', 'PT1H^^string'],
  ['xsd:string("P13M"^^xsd:yearMonthDuration)', 'P1Y1M^^string'],
  ['xsd:string("x"^^<http://example/t>)', 'x^^string'],
  ['xsd:string(<http://example/i>)', 'http://example/i^^string'],
  // ill-formed literals cannot be cast
  ['xsd:string("maybe"^^xsd:boolean)', undefined],
  ['xsd:string("abc"^^xsd:integer)', undefined],
  ['xsd:string("bad"^^xsd:dateTime)', undefined],
  // computed doubles and floats: plain notation, the sign of zero kept
  ['"1e7"^^xsd:double * 1', '10000000^^double'],
  ['1e-7 * 1', '0.0000001^^double'],
  ['1e21 * 1', '1000000000000000000000^^double'],
  ['1234567.5e0 * 1', '1234567.5^^double'],
  ['-0.0e0 * 1', '-0^^double'],
  ['xsd:double("-0")', '-0^^double'],
  ['xsd:float("1e7")', '10000000^^float'],
  ['xsd:float("0.1")', '0.1^^float'],
  // STR keeps a literal's own lexical form
  ['STR(2.5e0)', '2.5e0^^string'],
]

describe.skipIf(!built.length).each(built)('%s engine: numbers and casts to string', async (kind) => {
  const target = await wasmTarget(kind)
  it.each(CASES)('%s', (expr, want) => {
    const q = `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\nSELECT ?x { BIND(${expr} AS ?x) }`
    const r = target.query({ default: [], named: [] }, q, 'http://example/')
    if (r.kind !== 'bindings') throw new Error('expected bindings')
    const v = r.rows[0]?.get('x') as { v: string; dt?: string } | undefined
    expect(v ? `${v.v}^^${(v.dt ?? '').replace(/.*#/, '')}` : undefined).toBe(want)
  })

  // Reading a double rounds once, to the nearest (ties to even), as Number() does (#159): the
  // midpoints between neighbouring doubles written out exactly (up to 767 digits), the same
  // with a 1 far past them, the midpoints below, and 20- and 40-digit spellings; normal
  // numbers across the range, subnormals, the largest double and powers of two.
  it('reads long and halfway double literals as Number() does', () => {
    const exact = (n: bigint, q: number) => {
      if (q >= 0) return (n << BigInt(q)).toString()
      const s = (n * 5n ** BigInt(-q)).toString().padStart(-q + 1, '0')
      return `${s.slice(0, s.length + q)}.${s.slice(s.length + q)}`
    }
    const view = new DataView(new ArrayBuffer(8))
    const double = (bits: bigint) => (view.setBigUint64(0, bits), view.getFloat64(0))
    const literals: string[] = []
    const around = (bits: bigint) => {
      const be = Number((bits >> 52n) & 0x7ffn)
      const f = (bits & 0xfffffffffffffn) | (be ? 1n << 52n : 0n)
      const q = Math.max(be, 1) - 1076
      const above = exact(2n * f + 1n, q)
      const point = above.includes('.') ? '' : '.'
      literals.push(above, `${above}${point}${'0'.repeat(30)}1`, `${above}${point}${'0'.repeat(900)}1`)
      // below a power of two the midpoint is half as far
      literals.push(f === 1n << 52n && be > 1 ? exact(4n * f - 1n, q - 1) : exact(2n * f - 1n, q))
      literals.push(double(bits).toExponential(20), double(bits).toPrecision(40))
    }
    let seed = 7
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let i = 0; i < 200; i++) {
      view.setFloat64(0, (1 + random()) * 2 ** Math.floor(random() * 2000 - 1000))
      around(view.getBigUint64(0))
    }
    for (const bits of [1n, 2n, 3n, 0xfffffffffffffn, 1n << 52n, (1n << 52n) + 1n, 0x3ff0000000000000n, 0x7feffffffffffffen]) around(bits)
    literals.push(`1${'0'.repeat(400)}`, `0.${'0'.repeat(400)}1`, '999.4999999999999', '9007199254740993')
    const read = (s: string) => {
      const r = target.query({ default: [], named: [] }, `SELECT ?x { BIND("${s}"^^<http://www.w3.org/2001/XMLSchema#double> + 0 AS ?x) }`, 'http://example/')
      if (r.kind !== 'bindings') throw new Error('expected bindings')
      const v = (r.rows[0]?.get('x') as { v: string }).v
      return v === 'INF' ? Infinity : Number(v)
    }
    const wrong = literals.filter((s) => !Object.is(read(s), Number(s)))
    expect(wrong.map((s) => `${s.slice(0, 40)}… (${s.length} chars): ${read(s)}, not ${Number(s)}`)).toEqual([])
  })
})
