// SELECT * on the rdf-engine builds: every variable the query names, in order,
// whatever its name; the engine's own variables (blank nodes, unnamed reifiers)
// never show.
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { wasmTarget } from '../rdf-engine/conformance/targets/wasm.ts'

const built = (['rust', 'wat'] as const).filter((k) => existsSync(new URL(`../rdf-engine/build/${k}.wasm`, import.meta.url)))

/** Query, and the variables SELECT * gives, with the number of rows. */
const CASES: [string, string[], number][] = [
  ['SELECT * WHERE { VALUES (?__i ?x) { (0 "a") (1 "b") } BIND(?x AS ?y) }', ['__i', 'x', 'y'], 2],
  ['SELECT * WHERE { VALUES (?_1 ?x) { (0 "a") } }', ['_1', 'x'], 1],
  // a blank node and an anonymous node are the engine's own variables, apart from ?_1
  ['SELECT * WHERE { VALUES (?_1) { (0) } OPTIONAL { _:b <http://example/p> [] } }', ['_1'], 1],
  ['SELECT * WHERE { VALUES ?x { 1 } }', ['x'], 1],
]

describe.skipIf(!built.length).each(built)('%s engine: SELECT *', async (kind) => {
  const target = await wasmTarget(kind)
  it.each(CASES)('%s', (query, vars, rows) => {
    const r = target.query({ default: [], named: [] }, query, 'http://example/')
    if (r.kind !== 'bindings') throw new Error('expected bindings')
    expect(r.vars).toEqual(vars)
    expect(r.rows.length).toBe(rows)
  })
})
