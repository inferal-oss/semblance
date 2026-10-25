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
})
