import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Engine, EngineError, Form, Format, type Solutions } from '../rdf-engine/host/engine.ts'

const PREFIX = 'PREFIX : <http://ex/> '
const right = '{ ?x :value ?v OPTIONAL { ?x :optional ?o } FILTER(!BOUND(?s)) }'
const queries = [
  { name: 'inner', text: `SELECT ?s ?v WHERE { ?s :anchor ?m ${right} }`, nonemptyCount: 512, budgetText: `SELECT ?s ?v WHERE { ?s :anchor ?m ${right} }` },
  // group_parts extracts this group's FILTER as the LeftJoin condition. It
  // sees merged ?s, so all pairs fail and each left row remains unmatched.
  { name: 'optional condition', text: `SELECT ?s ?v WHERE { ?s :anchor ?m OPTIONAL ${right} }`, nonemptyCount: 2,
    budgetText: 'SELECT ?s ?v WHERE { ?s :anchor ?m OPTIONAL { ?x :value ?v OPTIONAL { ?x :optional ?o } FILTER(BOUND(?s)) } }' },
]

function show(result: Solutions): string {
  if (result.form !== Form.Select) throw Error('Expected SELECT')
  const rows = []
  for (let i = 0; i < result.rows.length; i += result.vars.length) {
    rows.push(Array.from(result.rows.subarray(i, i + result.vars.length)).join(','))
  }
  return JSON.stringify([result.vars, rows.sort()])
}

// The inner join's filter cannot see ?s supplied by its left row. The OPTIONAL
// case instead extracts that filter as its merged-row condition. Both must
// avoid collecting the independent right table for an empty left side. Rust
// used to collect that table first,
// even for an empty left side. A small fuel limit exposes that ordering without
// allocating the Calendar corpus's >16-million-word intermediate table.
describe.each(['rust', 'wat'] as const)('%s compiled empty-left joins', (kind) => {
  const image = new URL(`../rdf-engine/build/${kind}.wasm`, import.meta.url)
  const fixture = () => {
    const e = new Engine(new WebAssembly.Module(readFileSync(image)))
    e.load(Format.Turtle, PREFIX + Array.from({ length: 256 }, (_, i) => `:x${i} :value ${i} .`).join('\n'))
    return e
  }

  it.each(queries)('does not spend the right-side budget for an empty $name left side', ({ text }) => {
    const e = fixture()
    const q = e.prepare(PREFIX + text)
    try {
      e.setFuel(64)
      const interpreted = q.run()
      expect(interpreted.form).toBe(Form.Select)
      if (interpreted.form === Form.Select) expect(interpreted.count).toBe(0)
      expect(q.compile()).toBeNull()
      const before = { ...e.stats }
      expect(show(q.run())).toBe(show(interpreted))
      expect(e.stats.compiledRuns - before.compiledRuns).toBe(1)
      expect(e.stats.interpretedRuns - before.interpretedRuns).toBe(0)
      expect(e.stats.fallbacks - before.fallbacks).toBe(0)
    } finally {
      q.release()
      e.setFuel()
      e.dispose()
    }
  })

  it.each(queries)('preserves nonempty rows, bindings and selected graphs for $name', ({ text, nonemptyCount }) => {
    const e = fixture()
    e.load(Format.Turtle, PREFIX + ':a :anchor :m . :b :anchor :m .')
    const graph = e.iri('http://ex/g')
    e.add(e.iri('http://ex/c'), e.iri('http://ex/anchor'), e.iri('http://ex/m'), graph)
    e.add(e.iri('http://ex/x'), e.iri('http://ex/value'), e.literal('01', e.iri('http://www.w3.org/2001/XMLSchema#integer')), graph)
    const q = e.prepare(PREFIX + text)
    try {
      const expected = show(q.run())
      expect(q.compile()).toBeNull()
      expect(show(q.run())).toBe(expected)
      const result = q.run()
      if (result.form !== Form.Select) throw Error('Expected SELECT')
      expect(result.count).toBe(nonemptyCount)
      const valueSlot = result.vars.indexOf('v')
      expect(valueSlot).toBeGreaterThanOrEqual(0)
      for (let row = 0; row < result.count; row++) {
        expect(result.rows[row * result.vars.length + valueSlot] === 0).toBe(nonemptyCount === 2)
      }
      // Rebinding and graph changes must be read at execution, rather than
      // cached from the first empty/nonempty run or leaked from a left row.
      for (const bindings of [[], [e.iri('http://ex/a')], [e.iri('http://ex/absent')], []]) {
        q.bindValues('s', bindings)
        for (const graphs of [[], [graph]]) {
          const reference = e.prepare(PREFIX + text)
          try {
            reference.bindValues('s', bindings)
            const expected = show(reference.run(graphs))
            expect(q.compile()).toBeNull()
            const before = { ...e.stats }
            expect(show(q.run(graphs))).toBe(expected)
            expect(e.stats.compiledRuns - before.compiledRuns).toBe(1)
            expect(e.stats.fallbacks - before.fallbacks).toBe(0)
          } finally { reference.release() }
        }
      }
    } finally { q.release(); e.dispose() }
  })

  it.each(queries)('still interrupts a live expensive $name join', ({ budgetText }) => {
    const e = fixture()
    e.load(Format.Turtle, PREFIX + ':a :anchor :m .')
    const q = e.prepare(PREFIX + budgetText)
    try {
      const live = q.run()
      if (live.form !== Form.Select) throw Error('Expected SELECT')
      // The OPTIONAL control uses a true merged-row condition, so its right
      // work is required. Do not require interruption for an always-false one.
      expect(live.count).toBe(256)
      expect(q.compile()).toBeNull()
      e.setFuel(64)
      let failure: unknown
      try { q.run() } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(EngineError)
      expect((failure as EngineError).interrupted).toBe(true)
      expect(e.stats.fallbacks).toBe(0)
    } finally { q.release(); e.setFuel(); e.dispose() }
  })
})
