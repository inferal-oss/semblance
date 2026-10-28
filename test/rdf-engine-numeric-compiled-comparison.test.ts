// Exercise the native numeric comparison path and its compiled expression
// fallback. Nested expressions must leave for the expression's bail block,
// rather than one of the comparison emitter's internal IF blocks.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Engine, Form } from '../rdf-engine/host/engine.ts'

const XSD = 'http://www.w3.org/2001/XMLSchema#'
const text = `SELECT (?a = ?b AS ?eq) (?a != ?b AS ?ne)
  (?a < ?b AS ?lt) (?a > ?b AS ?gt) (?a <= ?b AS ?le) (?a >= ?b AS ?ge)
  (IF(?a = ?b, "equal", "different") AS ?branch)
  (COALESCE(IF(?a < ?b, "less", IF(?a > ?b, "greater", "equal")), "unordered") AS ?order)
  WHERE {}`

type Operand = readonly [lexical: string, family: string]
const ordered = (order: number) => [
  String(order === 0), String(order !== 0), String(order < 0), String(order > 0),
  String(order <= 0), String(order >= 0), order === 0 ? 'equal' : 'different',
  order < 0 ? 'less' : order > 0 ? 'greater' : 'equal',
]
const cases: { name: string; a: Operand; b: Operand; expected: (string | undefined)[] }[] = [
  { name: 'integer rounds before float comparison', a: ['16777217', 'integer'], b: ['16777216', 'float'], expected: ordered(0) },
  { name: 'float on the left chooses the same precision', a: ['16777216', 'float'], b: ['16777217', 'integer'], expected: ordered(0) },
  { name: 'double does not inherit float precision', a: ['16777217', 'integer'], b: ['16777216', 'double'], expected: ordered(1) },
  { name: 'decimal promotes directly to float', a: ['0.1', 'decimal'], b: ['0.1', 'float'], expected: ordered(0) },
  { name: 'source float stays rounded when double is present', a: ['0.1', 'float'], b: ['0.1', 'double'], expected: ordered(1) },
  { name: 'signed zero compares equal', a: ['-0', 'float'], b: ['0', 'double'], expected: ordered(0) },
  { name: 'floating infinities compare equal', a: ['INF', 'float'], b: ['INF', 'double'], expected: ordered(0) },
  { name: 'negative infinity orders below finite double', a: ['-INF', 'float'], b: ['-1', 'double'], expected: ordered(-1) },
  // Reuse the same compiled expression with other runtime operand classes;
  // the float guard must require two actual numeric classes as well as types.
  { name: 'strings still compare lexically', a: ['z', ''], b: ['a', ''], expected: ordered(1) },
  { name: 'IRI equality is not numeric ordering', a: ['https://example.org/same', 'iri'], b: ['https://example.org/same', 'iri'], expected: ['true', 'false', undefined, undefined, undefined, undefined, 'equal', 'unordered'] },
]

describe.each(['rust', 'wat'] as const)('%s native comparison bail scope', kind => {
  // Both rebuilt binaries are required; no missing-backend skip is permitted.
  const module = new WebAssembly.Module(readFileSync(new URL(`../rdf-engine/build/${kind}.wasm`, import.meta.url)))
  it.each([false, true])('keeps target precision and nested result types (compiled=%s)', compiled => {
    const e = new Engine(module)
    const q = e.prepare(text)
    const term = ([lexical, family]: Operand) => family === 'iri' ? e.iri(lexical) : e.literal(lexical, family ? e.iri(XSD + family) : 0)
    try {
      q.bind('a', term(cases[0]!.a)).bind('b', term(cases[0]!.b))
      if (compiled) expect(q.compile()).toBe(null)
      for (const entry of cases) {
        q.bind('a', term(entry.a)).bind('b', term(entry.b))
        // The second run also selects the WAT typed numeric cache when present.
        for (let repeat = 0; repeat < 2; repeat++) {
          const result = q.run()
          if (result.form !== Form.Select) throw Error('expected SELECT')
          expect(result.rows.length, entry.name).toBe(entry.expected.length)
          expect(Array.from(result.rows, id => id ? e.value(id) : undefined), entry.name).toEqual(entry.expected)
        }
      }
      expect(e.stats.fallbacks).toBe(0)
      expect(e.stats.compiledRuns).toBe(compiled ? 2 * cases.length : 0)
      expect(e.stats.interpretedRuns).toBe(compiled ? 0 : 2 * cases.length)
    } finally {
      q.release()
      e.dispose()
    }
  })
})
