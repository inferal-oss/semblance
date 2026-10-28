import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { Engine, EngineError, Form, Format, type Query, type Solutions } from '../rdf-engine/host/engine.ts'

const PREFIX = 'PREFIX : <http://ex/> '
const image = (kind: 'rust' | 'wat') => new WebAssembly.Module(readFileSync(new URL(`../rdf-engine/build/${kind}.wasm`, import.meta.url)))
type Native = {
  cq_begin: (h: number, shape: number, graphs: number) => number
  cq_combo: (i: number) => void
  cq_may_match: (s: number, p: number, o: number) => number
  cq_guard_count: (i: number) => number
  cq_bu_event: () => number
  cq_end: () => number
}
const native = (e: Engine) => (e as unknown as { x: Native }).x
const counters = (e: Engine) => Array.from({ length: 6 }, (_, i) => native(e).cq_guard_count(i))
function bounded(e: Engine) {
  const [calls, graphs, candidates, absent, unknown, present] = counters(e)
  expect(graphs + candidates).toBeLessThanOrEqual(128 * calls)
  expect(absent + unknown + present).toBe(calls)
}
function count(result: Solutions) {
  if (result.form !== Form.Select) throw Error('Expected SELECT')
  return result.count
}

// The native primitive is exercised inside the real host query-call boundary
// and cq_begin/cq_end lifecycle. No fabricated store or mocked native function.
function probe(e: Engine, pattern: number[], graphs: number[] = [], query = 'SELECT ?s WHERE { ?s :anchor ?m }', before?: (x: Native) => void, after?: (x: Native) => void) {
  const q = e.prepare(PREFIX + query), x = native(e)
  let verdict = -1, observed: number[] = [], invocations = 0
  try {
    const bytes = e.compiledBytes(q.handle)
    if (typeof bytes === 'string') throw Error(bytes)
    const imports = { ...(x as unknown as WebAssembly.ModuleImports), cq_combo: (i: number) => {
      x.cq_combo(i)
      invocations++
      before?.(x)
      verdict = x.cq_may_match(pattern[0], pattern[1], pattern[2])
      observed = counters(e)
      after?.(x)
    } }
    // Use each engine's actual emitted cq_begin shape and frame protocol.
    const module = new WebAssembly.Instance(new WebAssembly.Module(bytes), { engine: imports })
    const ended = e.runCompiled(module.exports as unknown as { run: (n: number) => number }, graphs)
    expect(invocations).toBe(1)
    bounded(e)
    expect(observed[1] + observed[2]).toBeLessThanOrEqual(128 * observed[0])
    return { verdict, ended, counters: observed }
  } finally { q.release() }
}

describe.each(['rust', 'wat'] as const)('%s bounded required-triple primitive', kind => {
  it('proves absence, accepts a positive match, and resets only diagnostic counts per run', () => {
    const e = new Engine(image(kind))
    try {
      const s = e.iri('http://ex/a'), p = e.iri('http://ex/p'), o = e.iri('http://ex/o')
      e.add(s, p, o)
      expect(probe(e, [s, p, o]).counters).toEqual([1, 1, 1, 0, 0, 1])
      const absent = probe(e, [e.iri('http://ex/absent'), p, o])
      expect(absent.verdict).toBe(0)
      expect(absent.counters).toEqual([1, 1, 0, 1, 0, 0])
      expect(e.quadCount()).toBe(1)
      expect(native(e).cq_guard_count(99)).toBe(0)
    } finally { e.dispose() }
  })

  it('compares term identity without narrowing or canonicalizing numeric literals', () => {
    const e = new Engine(image(kind))
    try {
      const s = e.iri('http://ex/a'), p = e.iri('http://ex/p'), dt = e.iri('http://www.w3.org/2001/XMLSchema#integer')
      const wide = e.literal('1234567890123456789012345678901234567890', dt)
      const padded = e.literal('01', dt), canonical = e.literal('1', dt), zero = e.literal('0', dt)
      for (const o of [wide, padded, zero]) e.add(s, p, o)
      for (const o of [wide, padded, zero]) expect(probe(e, [s, p, o]).verdict).toBe(1)
      expect(probe(e, [s, p, canonical]).verdict).toBe(0)
      expect(probe(e, [s, p, 0]).verdict).toBe(1) // Unbound slot is a wildcard.
    } finally { e.dispose() }
  })

  it('returns unknown at the shared candidate cap, including a later real match', () => {
    const e = new Engine(image(kind))
    try {
      const s = e.iri('http://ex/a'), p = e.iri('http://ex/p'), o = e.iri('http://ex/o'), other = e.iri('http://ex/other')
      for (let i = 0; i < 260; i++) {
        e.add(s, other, e.iri(`http://ex/o${i}`))
        e.add(e.iri(`http://ex/s${i}`), p, o)
      }
      let observed = probe(e, [s, p, o])
      expect(observed.verdict).toBe(1)
      expect(observed.counters).toEqual([1, 1, 127, 0, 1, 0])
      e.add(s, p, o) // The matching row is after the capped index prefix.
      observed = probe(e, [s, p, o])
      expect(observed.verdict).toBe(1)
      expect(observed.counters).toEqual([1, 1, 127, 0, 1, 0])
      const q = e.prepare(PREFIX + 'SELECT ?s WHERE { ?s :p :o FILTER(?s=:a) }')
      try { expect(count(q.run())).toBe(1) } finally { q.release() }
    } finally { e.dispose() }
  })

  it('bounds graph visits even when all early selected graph indices are empty', () => {
    const e = new Engine(image(kind))
    try {
      const s = e.iri('http://ex/a'), p = e.iri('http://ex/p'), o = e.iri('http://ex/o')
      const graphs = Array.from({ length: 129 }, (_, i) => e.iri(`http://ex/g${i}`))
      e.add(s, p, o, graphs[128])
      const observed = probe(e, [s, p, o], graphs)
      expect(observed.verdict).toBe(1)
      expect(observed.counters).toEqual([1, 128, 0, 0, 1, 0])
    } finally { e.dispose() }
  })

  it('uses exactly the selected graph union rather than another graph or global store', () => {
    const e = new Engine(image(kind))
    try {
      const s = e.iri('http://ex/a'), p = e.iri('http://ex/p'), o = e.iri('http://ex/o')
      const empty = e.iri('http://ex/empty'), live = e.iri('http://ex/live')
      e.add(s, p, o, live)
      expect(probe(e, [s, p, o]).verdict).toBe(0)
      expect(probe(e, [s, p, o], [empty]).verdict).toBe(0)
      const union = probe(e, [s, p, o], [empty, live])
      expect(union.verdict).toBe(1)
      expect(union.counters).toEqual([1, 2, 1, 0, 0, 1])
      expect(probe(e, [s, p, o], [live], 'SELECT ?s FROM :empty WHERE { ?s :anchor ?m }').verdict).toBe(0)
      const named = probe(e, [s, p, o], [live], 'SELECT ?s FROM NAMED :live WHERE { ?s :anchor ?m }')
      expect(named.verdict).toBe(0)
      expect(named.counters).toEqual([1, 0, 0, 1, 0, 0])
    } finally { e.dispose() }
  })

  it('polls the existing deadline and never returns false for a stopped query', () => {
    let now = 0
    const e = new Engine(image(kind), () => now)
    try {
      e.setDeadline(1)
      const observed = probe(e, [e.iri('http://ex/a'), e.iri('http://ex/p'), 0], [], undefined, () => { now = 2 })
      expect(observed.verdict).toBe(1)
      expect(observed.ended).toBe(-2)
      expect(observed.counters).toEqual([1, 0, 0, 0, 1, 0])
      e.setDeadline()
      expect(probe(e, [e.iri('http://ex/a'), e.iri('http://ex/p'), 0]).verdict).toBe(0)
    } finally { e.setDeadline(); e.dispose() }
  })

  it('does not publish an absence proof after a nonfinite clock return', () => {
    let now = 0
    const e = new Engine(image(kind), () => now)
    try {
      const s = e.iri('http://ex/a'), p = e.iri('http://ex/p')
      e.setDeadline(1)
      const observed = probe(e, [s, p, 0], [], undefined, () => { now = NaN })
      expect(observed.verdict).toBe(1)
      expect(observed.ended).toBe(-2)
      expect(observed.counters).toEqual([1, 0, 0, 0, 1, 0])
    } finally { e.setDeadline(); e.dispose() }
  })

  it('does not restart consumed fuel while proving an absent triple', () => {
    const e = new Engine(image(kind))
    try {
      const s = e.iri('http://ex/a'), p = e.iri('http://ex/p')
      e.setFuel(5000)
      const observed = probe(e, [s, p, 0], [], undefined,
        x => { expect(x.cq_bu_event()).toBe(0) },
        x => { expect(x.cq_bu_event()).toBe(1) })
      expect(observed.verdict).toBe(0)
      expect(observed.ended).toBe(-2)
    } finally { e.setFuel(); e.dispose() }
  })

})

describe.each(['rust', 'wat'] as const)('%s compiled guard scope and incoming row', kind => {
  const right = '{ ?x :value ?v OPTIONAL { ?x :optional ?o } FILTER(!BOUND(?s)) }'
  const cases = [
    { name: 'OPTIONAL-only absent triple', left: 'OPTIONAL { ?s :missing ?m }', rows: 3 },
    { name: 'UNION branch scope', left: '{ VALUES ?s { :a } } UNION { VALUES ?s { :b } }', rows: 6 },
    { name: 'subquery scope', left: '{ SELECT ?s WHERE { VALUES ?s { :a } } }', rows: 3 },
    { name: 'named graph scope', left: 'GRAPH :g { ?s :anchor ?m }', rows: 3 },
    { name: 'zero-length path', left: ':isolated :next* ?s', rows: 3 },
    { name: 'MINUS-right absent triple', left: 'VALUES ?s { :a } MINUS { ?s :missing ?m }', rows: 3 },
  ]
  it.each(cases)('does not infer absence across $name', ({ left, rows }) => {
    const e = new Engine(image(kind))
    e.load(Format.Turtle, PREFIX + ':x0 :value 0 . :x1 :value 1 . :x2 :value 2 .')
    e.add(e.iri('http://ex/a'), e.iri('http://ex/anchor'), e.iri('http://ex/m'), e.iri('http://ex/g'))
    const q = e.prepare(PREFIX + `SELECT ?s ?v WHERE { ${left} ${right} }`)
    try {
      expect(count(q.run())).toBe(rows)
      expect(q.compile()).toBeNull()
      const before = { ...e.stats }
      expect(count(q.run())).toBe(rows)
      bounded(e)
      expect(e.stats.compiledRuns - before.compiledRuns).toBe(1)
      expect(e.stats.fallbacks - before.fallbacks).toBe(0)
    } finally { q.release(); e.dispose() }
  })

  it('reads current MAYBE and unbound incoming slots without leaking a previous row', () => {
    const e = new Engine(image(kind))
    e.load(Format.Turtle, PREFIX + ':x :value 1 . :a :anchor :m .')
    const q = e.prepare(PREFIX + `SELECT ?s ?v WHERE { VALUES ?s { UNDEF :absent :a } LATERAL { ?s :anchor ?m ${right} } }`)
    try {
      const expected = count(q.run())
      expect(expected).toBe(1)
      expect(q.compile()).toBeNull()
      expect(count(q.run())).toBe(expected)
      bounded(e)
      // Incoming :a is bound, making the independent !BOUND(?s) filter false;
      // only the initially UNDEF branch can contribute a result.
      expect(counters(e)[3]).toBeGreaterThan(0)
    } finally { q.release(); e.dispose() }
  })

  it('limits each join guard to four plain required triples', () => {
    const e = new Engine(image(kind))
    e.load(Format.Turtle, PREFIX + ':x :value 1 . :a :p0 :o ; :p1 :o ; :p2 :o ; :p3 :o .')
    const q = e.prepare(PREFIX + `SELECT ?s ?v WHERE { ?s :p0 :o ; :p1 :o ; :p2 :o ; :p3 :o ; :missing :o . ${right} }`)
    try {
      expect(count(q.run())).toBe(0)
      expect(q.compile()).toBeNull()
      expect(count(q.run())).toBe(0)
      const [calls, , , absent] = counters(e)
      expect(calls).toBe(4)
      expect(absent).toBe(0) // The fifth triple is deliberately not proved.
      bounded(e)
    } finally { q.release(); e.dispose() }
  })

  it('continues the streamed plan on unknown and sees a later store update', () => {
    const e = new Engine(image(kind))
    const s = e.iri('http://ex/a'), p = e.iri('http://ex/p'), o = e.iri('http://ex/o'), other = e.iri('http://ex/other')
    for (let i = 0; i < 260; i++) {
      e.add(s, other, e.iri(`http://ex/o${i}`))
      e.add(e.iri(`http://ex/s${i}`), p, o)
    }
    e.load(Format.Turtle, PREFIX + ':x :value 1 .')
    const q = e.prepare(PREFIX + `SELECT ?m ?v WHERE {
      :a :p :o BIND(:anchor AS ?m)
      { ?x :value ?v OPTIONAL { ?x :optional ?z } FILTER(!BOUND(?m)) }
    }`)
    try {
      expect(q.compile()).toBeNull()
      expect(count(q.run())).toBe(0)
      expect(counters(e)).toEqual([1, 1, 127, 0, 1, 0])
      e.add(s, p, o)
      const before = { ...e.stats }
      expect(count(q.run())).toBe(1)
      // WAT also probes the subsequently entered RHS/OPTIONAL groups. Their
      // legitimate present/absent proofs must not hide this unknown outcome.
      expect(counters(e)[4]).toBe(1)
      bounded(e)
      expect(e.stats.compiledRuns - before.compiledRuns).toBe(1)
      expect(e.stats.fallbacks - before.fallbacks).toBe(0)
    } finally { q.release(); e.dispose() }
  })

  it('does not evaluate an impure left expression twice', () => {
    const e = new Engine(image(kind))
    e.load(Format.Turtle, PREFIX + ':a :anchor :m . :x :value 1 .')
    const q = e.prepare(PREFIX + `SELECT ?s ?r ?v WHERE { ?s :anchor ?m BIND(RAND() AS ?r) ${right} }`)
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      expect(q.compile()).toBeNull()
      random.mockClear()
      expect(count(q.run())).toBe(1)
      expect(random).toHaveBeenCalledTimes(1)
      bounded(e)
    } finally { random.mockRestore(); q.release(); e.dispose() }
  })

  it('keeps live-work interruption and deadline recovery through the ordinary compiled path', () => {
    let now = 0
    const e = new Engine(image(kind), () => now)
    e.load(Format.Turtle, PREFIX + ':x :value 1 .')
    const q = e.prepare(PREFIX + `SELECT ?s ?v WHERE { ?s :anchor ?m ${right} }`)
    try {
      expect(q.compile()).toBeNull()
      e.setDeadline(1)
      now = 2
      let failure: unknown
      try { q.run() } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(EngineError)
      expect((failure as EngineError).interrupted).toBe(true)
      expect(counters(e)[3]).toBe(0)
      e.setDeadline()
      expect(count(q.run())).toBe(0)
      expect(counters(e)[3]).toBeGreaterThan(0)
      expect(e.stats.fallbacks).toBe(0)
    } finally { q.release(); e.setDeadline(); e.dispose() }
  })

  it('pairs the generated guard import with its emitting engine image', () => {
    const rust = image('rust')
    const wat = new WebAssembly.Module(readFileSync(new URL('../rdf-engine/build/wat.wasm', import.meta.url)))
    expect(WebAssembly.Module.exports(rust).some(x => x.name === 'cq_may_match')).toBe(true)
    expect(WebAssembly.Module.exports(wat).some(x => x.name === 'cq_may_match')).toBe(true)
    const e = new Engine(image(kind)), q: Query = e.prepare(PREFIX + `SELECT ?s ?v WHERE { ?s :anchor ?m ${right} }`)
    try {
      const bytes = e.compiledBytes(q.handle)
      if (typeof bytes === 'string') throw Error(bytes)
      expect(WebAssembly.Module.imports(new WebAssembly.Module(bytes)).some(x => x.module === 'engine' && x.name === 'cq_may_match')).toBe(true)
    } finally { q.release(); e.dispose() }
  })
})
