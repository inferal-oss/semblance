import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Engine, Form, Format, type Solutions } from '../rdf-engine/host/engine.ts'

const PREFIX = 'PREFIX : <http://ex/> '
const text = PREFIX + `SELECT ?s ?v WHERE {
  ?s :anchor ?m .
  { ?x :value ?v OPTIONAL { ?x :optional ?o } FILTER(!BOUND(?s)) }
  FILTER(?s = :keep)
}`

function show(result: Solutions): string {
  if (result.form !== Form.Select) throw Error('Expected SELECT')
  const rows = []
  for (let at = 0; at < result.rows.length; at += result.vars.length) {
    rows.push(Array.from(result.rows.subarray(at, at + result.vars.length)).join(','))
  }
  return JSON.stringify([result.vars, rows.sort()])
}

describe.each(['rust', 'wat'] as const)('%s compiled selective join continuation', (kind) => {
  function fixture(size: number) {
    const image = new URL(`../rdf-engine/build/${kind}.wasm`, import.meta.url)
    const e = new Engine(new WebAssembly.Module(readFileSync(image)))
    e.load(Format.Turtle, PREFIX + [
      ':keep :anchor :m .',
      ...Array.from({ length: size - 1 }, (_, i) => `:s${i} :anchor :m .`),
      ...Array.from({ length: size }, (_, i) => `:x${i} :value ${i} .`),
    ].join('\n'))
    return e
  }

  it('does not materialize the product before its selective continuation', () => {
    const size = 64
    const e = fixture(size), q = e.prepare(text)
    try {
      const reference = q.run()
      if (reference.form !== Form.Select) throw Error('Expected SELECT')
      expect(reference.count).toBe(size)
      expect(q.compile()).toBeNull()
      const before = { ...e.stats }
      const ordinary = q.run()
      expect(show(ordinary)).toBe(show(reference))
      expect(e.stats.compiledRuns - before.compiledRuns).toBe(1)
      expect(e.stats.interpretedRuns - before.interpretedRuns).toBe(0)
      expect(e.stats.fallbacks - before.fallbacks).toBe(0)

      // Test-only wrappers observe real native return counts. They forward every
      // call unchanged; the generated module, native image and rows stay real.
      // This direct module run is separate from the ordinary host counters above.
      const bytes = e.compiledBytes(q.handle)
      if (typeof bytes === 'string') throw Error(bytes)
      const native = (e as unknown as { x: WebAssembly.Exports }).x
      const imports: WebAssembly.ModuleImports = { ...native }
      const calls: { name: string; rows: number }[] = []
      let solutions = 0
      const solution = native.cq_solution as () => void
      imports.cq_solution = () => { solutions++; solution() }
      for (const name of ['cq_eval', 'cq_group', 'cq_scan', 'cq_path', 'cq_pack_count']) {
        const fn = native[name] as (...args: number[]) => number
        if (typeof fn !== 'function') continue // WAT has no ordinary packed collection.
        imports[name] = (...args: number[]) => {
          const rows = fn(...args)
          calls.push({ name, rows })
          return rows
        }
      }
      const module = new WebAssembly.Instance(new WebAssembly.Module(bytes), { engine: imports })
      const count = e.runCompiled(module.exports as unknown as { run: (graphs: number) => number }, [])
      expect(count).toBe(size)
      expect(show({ form: Form.Select, count, vars: q.vars, rows: e.resultIds(count * q.vars.length) })).toBe(show(reference))
      expect(solutions).toBe(size)
      // A whole-join cq_eval exposes size*size rows here. The original streamed
      // continuation needs at most its independent right table; WAT can inline
      // every scan and use no native table helper at all.
      expect(Math.max(0, ...calls.map(call => call.rows))).toBeLessThanOrEqual(size)
    } finally { q.release(); e.dispose() }
  })

  it('retains the selective compiled plan under a bounded fuel budget', () => {
    const size = 128
    const e = fixture(size), q = e.prepare(text)
    try {
      const reference = q.run()
      if (reference.form !== Form.Select) throw Error('Expected SELECT')
      expect(reference.count).toBe(size)
      expect(q.compile()).toBeNull()
      e.setFuel(4096)
      const before = { ...e.stats }
      expect(show(q.run())).toBe(show(reference))
      expect(e.stats.compiledRuns - before.compiledRuns).toBe(1)
      expect(e.stats.interpretedRuns - before.interpretedRuns).toBe(0)
      expect(e.stats.fallbacks - before.fallbacks).toBe(0)
    } finally { q.release(); e.setFuel(); e.dispose() }
  })
})
