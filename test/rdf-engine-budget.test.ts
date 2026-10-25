// The query budget of the rdf-engine builds (ABI.md, "Query budget"): a query
// that runs past its deadline or its steps stops with an interrupted error,
// leaves nothing behind, and runs again once the budget allows. With
// RDF_ENGINE_COMPILE=1 every query that compiles runs compiled (ABI.md,
// "Optional: compiled queries"), whose loops step the same budget.
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Engine, EngineError, Form, Format } from '../rdf-engine/host/engine.ts'

const built = (['rust', 'wat'] as const).filter((k) => existsSync(new URL(`../rdf-engine/build/${k}.wasm`, import.meta.url)))

/** 100 subjects with one :p each: a cross join of them is 10,000 rows. */
const DATA = Array.from({ length: 100 }, (_, i) => `<http://example/s${i}> <http://example/p> "${i}" .`).join('\n')
const CROSS = 'SELECT (COUNT(*) AS ?n) { ?a <http://example/p> ?x . ?b <http://example/p> ?y }'
/** The same rows without the aggregate, which compiled queries leave to the interpreter. */
const ROWS = 'SELECT ?x ?y { ?a <http://example/p> ?x . ?b <http://example/p> ?y }'
/** 2,000 list cells and a walk over them, then a join pair per cell. */
const LIST = Array.from({ length: 2000 }, (_, i) => `<http://example/c${i}> <http://example/next> <http://example/c${i + 1}> .`).join('\n')
const WALK = 'SELECT ?c ?d { <http://example/c0> <http://example/next>* ?c . ?c <http://example/next> ?d }'
const compileMode = !!process.env.RDF_ENGINE_COMPILE

function interrupted(f: () => unknown): boolean {
  try {
    f()
  } catch (e) {
    if (e instanceof EngineError && e.interrupted) return true
    throw e
  }
  return false
}

describe.skipIf(!built.length).each(built)('%s engine: query budget', (kind) => {
  const module = new WebAssembly.Module(readFileSync(new URL(`../rdf-engine/build/${kind}.wasm`, import.meta.url)))
  const engine = (now?: () => number) => {
    const e = new Engine(module, now)
    if (compileMode) e.autoCompile = 1
    return e
  }
  const count = (e: Engine, q = e.prepare(CROSS)) => {
    const r = q.run()
    if (r.form !== Form.Select) throw new Error('not a SELECT')
    return e.value(r.rows[0]!)
  }

  it('has the budget exports', () => {
    expect(engine().budgeted).toBe(true)
  })

  it('stops a query when its steps run out, and runs it again without', () => {
    const e = engine()
    e.load(Format.NTriples, DATA)
    const q = e.prepare(CROSS)
    e.setFuel(1000)
    expect(interrupted(() => q.run())).toBe(true)
    e.setFuel(1_000_000)
    expect(count(e, q)).toBe('10000')
    e.setFuel(undefined)
    expect(count(e, q)).toBe('10000')
  })

  it('stops a query at its deadline, on the env.now clock', () => {
    let t = 0
    const e = engine(() => (t += 1000))
    e.load(Format.NTriples, DATA)
    const q = e.prepare(CROSS)
    e.setDeadline(1)
    expect(interrupted(() => q.run())).toBe(true)
    e.setDeadline(undefined)
    expect(count(e, q)).toBe('10000')
  })

  it('says interrupted, and leaves the store and other queries as they were', () => {
    const e = engine()
    e.load(Format.NTriples, DATA)
    e.setFuel(10)
    let message = ''
    try {
      e.prepare(CROSS).run()
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toBe('interrupted')
    e.setFuel(undefined)
    expect(count(e)).toBe('10000')
    expect(e.match(0, 0, 0, 0).length / 4).toBe(100)
  })

  it('stops compiled queries too: scans, joins and path walks in the module', () => {
    const e = engine()
    e.load(Format.NTriples, DATA + '\n' + LIST)
    const rows = (text: string, fuel: number | undefined) => {
      const q = e.prepare(text)
      expect(q.compile()).toBe(null)
      e.setFuel(fuel)
      try {
        const r = q.run()
        return r.form === Form.Select ? r.count : -1
      } finally {
        q.release()
      }
    }
    for (const text of [ROWS, WALK]) {
      expect(interrupted(() => rows(text, 1000))).toBe(true)
      expect(e.stats.interpretedRuns).toBe(0)
    }
    expect(rows(ROWS, undefined)).toBe(10000)
    expect(rows(WALK, 1_000_000)).toBe(2000)
    let t = 0
    const slow = new Engine(module, () => (t += 1000))
    slow.load(Format.NTriples, DATA)
    const q = slow.prepare(ROWS)
    expect(q.compile()).toBe(null)
    slow.setDeadline(1)
    expect(interrupted(() => q.run())).toBe(true)
    slow.setDeadline(undefined)
    const r = q.run()
    expect(r.form === Form.Select && r.count).toBe(10000)
    expect(slow.stats.interpretedRuns).toBe(0)
  })

  it('does not stop updates', () => {
    const e = engine()
    e.load(Format.NTriples, DATA)
    e.setFuel(10)
    e.update('INSERT { ?s <http://example/q> ?x } WHERE { ?s <http://example/p> ?x }')
    e.setFuel(undefined)
    expect(e.match(0, 0, 0, 0).length / 4).toBe(200)
  })
})
