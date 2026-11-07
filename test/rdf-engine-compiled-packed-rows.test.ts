import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { Engine, Form, Format, type Query, type Solutions } from '../rdf-engine/host/engine.ts'

const PREFIX = 'PREFIX : <http://ex/> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> '
const image = () => new WebAssembly.Module(readFileSync(new URL('../rdf-engine/build/rust.wasm', import.meta.url)))
const pads = (n: number) => n ? `FILTER(${Array.from({ length: n }, (_, i) => `!BOUND(?pad${i})`).join(' && ')})` : ''
function select(result: Solutions) {
  if (result.form !== Form.Select) throw Error('Expected SELECT')
  return result
}
function compiled(e: Engine, q: Query) {
  expect(q.compile()).toBeNull()
  const before = { ...e.stats }
  const result = select(q.run())
  expect(q.isCompiled).toBe(true)
  expect(e.stats.compiledRuns - before.compiledRuns).toBe(1)
  expect(e.stats.interpretedRuns - before.interpretedRuns).toBe(0)
  expect(e.stats.fallbacks - before.fallbacks).toBe(0)
  return result
}
function bag(result: ReturnType<typeof select>) {
  const rows = new Map<string, number>()
  for (let at = 0; at < result.rows.length; at += result.vars.length) {
    const key = Array.from(result.rows.subarray(at, at + result.vars.length)).join(',')
    rows.set(key, (rows.get(key) ?? 0) + 1)
  }
  return [...rows].sort(([a], [b]) => a.localeCompare(b))
}
// Observe descriptors from real calls without changing the image or its rows.
// Run separately from q.run(), whose host compiled/fallback counters are checked.
function tracePacking(e: Engine, q: Query) {
  const bytes = e.compiledBytes(q.handle)
  if (typeof bytes === 'string') throw Error(bytes)
  const native = (e as unknown as { x: WebAssembly.Exports }).x
  const pack = native.cq_pack as (at: number) => number
  const scan = native.cq_scan as (...args: number[]) => number
  const evaluate = native.cq_eval as (...args: number[]) => number
  const modes: number[] = []
  const scans: { subject: number; predicate: number; rows: number }[] = []
  const evaluatedRows: number[] = []
  const imports: WebAssembly.ModuleImports = { ...native, cq_pack: (at: number) => {
    const descriptor = pack(at)
    modes.push(descriptor & 1)
    return descriptor
  }, cq_scan: (...args: number[]) => {
    const rows = scan(...args)
    scans.push({ subject: args[0], predicate: args[1], rows })
    return rows
  }, cq_eval: (...args: number[]) => {
    const rows = evaluate(...args)
    evaluatedRows.push(rows)
    return rows
  } }
  const module = new WebAssembly.Instance(new WebAssembly.Module(bytes), { engine: imports })
  const count = e.runCompiled(module.exports as unknown as { run: (graphs: number) => number }, [])
  return { modes, scans, evaluatedRows, result: { form: Form.Select as const, count, vars: q.vars, rows: e.resultIds(count * q.vars.length) } }
}

describe('Rust ordinary compiled row storage', () => {
  it('runs a sparse RHS beyond the old full-frame word limit without collecting the join product', () => {
    const e = new Engine(image())
    const size = 2000, hours = 96
    e.load(Format.Turtle, PREFIX + ':keep :anchor :m . ' + Array.from({ length: size }, (_, i) => `:x${i} :value ${i} .`).join('\n'))
    const q = e.prepare(PREFIX + `SELECT ?s ?v WHERE {
      ?s :anchor ?m .
      { ?x :value ?v OPTIONAL { ?x :optional ?o }
        VALUES ?h { ${Array.from({ length: hours }, (_, i) => i).join(' ')} }
        FILTER(!BOUND(?s)) }
      ${pads(96)}
    }`)
    try {
      e.setFuel(20_000_000)
      const reference = select(q.run())
      expect(reference.count).toBe(size * hours)
      const expected = bag(reference)
      e.setFuel(20_000_000)
      const result = compiled(e, q)
      expect(result.count).toBe(size * hours)
      expect(bag(result)).toEqual(expected)
      // 192,000 rows and at least 96 padding slots exceeded 16M full-frame
      // words before this change. The output has two columns, not that frame.
      expect(expected).toHaveLength(size)
      expect(expected.every(([, multiplicity]) => multiplicity === hours)).toBe(true)
    } finally { q.release(); e.setFuel(); e.dispose() }
  }, 60_000)

  it.each([
    { name: 'dense table', padding: 0, nativeLeft: false },
    { name: 'sparse table', padding: 96, nativeLeft: false },
    { name: 'sparse table above a live native LHS table', padding: 96, nativeLeft: true },
  ])('restores MAYBE bindings and OPTIONAL misses with a $name', ({ padding, nativeLeft }) => {
    const e = new Engine(image())
    e.add(e.iri('http://ex/exists'), e.iri('http://ex/p'), e.iri('http://ex/o'), e.iri('http://ex/g'))
    const values = 'VALUES (?s ?outside) { (UNDEF UNDEF) (:a UNDEF) (:absent :bound) }'
    const left = nativeLeft ? `GRAPH :g { ${values} }` : values
    const q = e.prepare(PREFIX + `SELECT ?s ?v ?outside WHERE {
      ${left}
      OPTIONAL { { VALUES (?s ?v) { (:a 1) (:b UNDEF) } FILTER(!BOUND(?outside)) } }
      ${pads(padding)}
    }`)
    try {
      const reference = select(q.run())
      expect(reference.count).toBe(4)
      const result = compiled(e, q)
      expect(result.count).toBe(4)
      expect(bag(result)).toEqual(bag(reference))
      const text = []
      for (let at = 0; at < result.rows.length; at += 3) text.push(Array.from(result.rows.subarray(at, at + 3), id => id ? e.value(id) : '-').join('|'))
      expect(text.sort()).toEqual(['http://ex/a|1|-', 'http://ex/a|1|-', 'http://ex/absent|-|http://ex/bound', 'http://ex/b|-|-'].sort())
      const traced = tracePacking(e, q)
      expect(traced.modes).toEqual([padding ? 1 : 0])
      expect(bag(traced.result)).toEqual(bag(reference))
    } finally { q.release(); e.dispose() }
  })

  it('retains row order and duplicates through sparse and nested live tables', () => {
    const e = new Engine(image())
    for (const s of ['a', 'b']) e.add(e.iri(`http://ex/${s}`), e.iri('http://ex/p'), e.iri(`http://ex/z${s}`), e.iri('http://ex/g'))
    const q = e.prepare(PREFIX + `SELECT ?s ?v ?w ?z WHERE {
      VALUES ?s { :a :b }
      { VALUES ?v { 2 1 2 } FILTER(!BOUND(?s)) }
      LATERAL {
        VALUES ?k { 0 }
        { VALUES ?w { 4 3 } FILTER(!BOUND(?k)) }
        GRAPH :g { ?s :p ?z }
      }
      ${pads(96)}
    }`)
    try {
      const reference = select(q.run())
      expect(reference.count).toBe(12)
      const result = compiled(e, q)
      expect(result.rows).toEqual(reference.rows)
      const actual = []
      for (let at = 0; at < result.rows.length; at += 4) actual.push(Array.from(result.rows.subarray(at, at + 4), id => e.value(id)).join('|'))
      expect(actual).toEqual(['a', 'b'].flatMap(s => [2, 1, 2].flatMap(v => [4, 3].map(w => `http://ex/${s}|${v}|${w}|http://ex/z${s}`))))
      const traced = tracePacking(e, q)
      expect(traced.result.rows).toEqual(reference.rows)
      expect(traced.modes.length).toBeGreaterThan(1)
      expect(traced.modes.every(mode => mode === 1)).toBe(true)
    } finally { q.release(); e.dispose() }
  })

  it('keeps mixed UNION tables across positive, empty and positive probes', () => {
    const e = new Engine(image())
    e.add(e.iri('http://ex/a'), e.iri('http://ex/anchor'), e.iri('http://ex/m'))
    e.add(e.iri('http://ex/a'), e.iri('http://ex/p'), e.iri('http://ex/za'), e.iri('http://ex/g'))
    const columns = Array.from({ length: 96 }, (_, i) => `?pad${i}`).join(' ')
    const denseRow = `(9 ${Array.from({ length: 96 }, () => ':bound').join(' ')})`
    const q = e.prepare(PREFIX + `SELECT ?s ?v ?w ?dense ?outside ?z WHERE {
      VALUES ?seed { :root }
      { VALUES ?outside { :one :one } FILTER(!BOUND(?seed)) }
      LATERAL {
        VALUES ?s { :a :missing :a }
        LATERAL {
          ?s :anchor ?m
          { VALUES ?v { 2 1 2 } FILTER(!BOUND(?m)) }
          UNION { GRAPH :g { VALUES (?v ${columns}) { ${denseRow} ${denseRow} } FILTER(!BOUND(?m)) } }
        }
      }
      LATERAL {
        VALUES ?k { 0 }
        { VALUES ?w { 4 3 } FILTER(!BOUND(?k)) }
        GRAPH :g { ?s :p ?z }
      }
      BIND(BOUND(?pad0) AS ?dense)
    }`)
    try {
      const reference = select(q.run())
      expect(reference.count).toBe(40)
      const result = compiled(e, q)
      expect(result.rows).toEqual(reference.rows)
      const cycle = [2, 1, 2, 9, 9].flatMap(v => [4, 3].map(w => `http://ex/a|${v}|${w}|${v === 9}|http://ex/one|http://ex/za`))
      const text = []
      for (let at = 0; at < result.rows.length; at += 6) text.push(Array.from(result.rows.subarray(at, at + 6), id => e.value(id)).join('|'))
      expect(text).toEqual(Array.from({ length: 4 }, () => cycle).flat())

      const traced = tracePacking(e, q)
      expect(traced.result.rows).toEqual(reference.rows)
      // One live outer sparse table. Each positive incoming row adds a sparse
      // UNION table and a wide dense EVAL table, then nested continuations:
      // sparse for three ordinary rows, dense for two rows carrying the pads.
      expect(traced.modes).toEqual([1, ...Array.from({ length: 4 }, () => [1, 1, 1, 1, 0, 0]).flat()])
      // One dense UNION table, then one GRAPH result for each of five rows times two w values.
      expect(traced.evaluatedRows).toEqual(Array.from({ length: 4 }, () => [2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]).flat())
      // The same compiled table_if sites see positive -> zero -> positive
      // inside each outer row, not in freshly compiled modules. Count-zero
      // probes must not consume stale base/flag values or emit phantom rows.
      const a = e.iri('http://ex/a'), missing = e.iri('http://ex/missing'), anchor = e.iri('http://ex/anchor')
      const probeCycle = [[a, 1], [missing, 0], [a, 1]].flatMap(row => Array.from({ length: 3 }, () => row))
      expect(traced.scans.filter(scan => scan.predicate === anchor).map(scan => [scan.subject, scan.rows])).toEqual([...probeCycle, ...probeCycle])
    } finally { q.release(); e.dispose() }
  })

  it('keeps cq_group(-1) returning a count and dense rows for legacy consumers', () => {
    const e = new Engine(image())
    const q = e.prepare(PREFIX + 'SELECT ?s ?v WHERE { VALUES ?s { :a :b } { VALUES ?v { 2 1 2 } FILTER(!BOUND(?s)) } }')
    try {
      const reference = select(q.run())
      expect(reference.count).toBe(6)
      expect(compiled(e, q).rows).toEqual(reference.rows)
      const bytes = e.compiledBytes(q.handle)
      if (typeof bytes === 'string') throw Error(bytes)
      const native = (e as unknown as { x: WebAssembly.Exports }).x
      const group = native.cq_group as (k: number, at: number) => number
      let rows = 0
      const legacy: { at: number; count: number; dense: number[] }[] = []
      // Call the unchanged legacy helper and explicitly translate its dense
      // count into the new consumer descriptor in the test adapter only.
      const imports: WebAssembly.ModuleImports = { ...native, cq_pack: (at: number) => {
        rows = group(0xffffffff, at)
        const ptr = (native.cq_stack as () => number)() + 4 * at
        legacy.push({ at, count: rows, dense: Array.from(new Uint32Array((native.memory as WebAssembly.Memory).buffer, ptr, rows * 2)) })
        return (at + rows * 2) * 2
      }, cq_pack_count: () => rows }
      const module = new WebAssembly.Instance(new WebAssembly.Module(bytes), { engine: imports })
      expect(e.runCompiled(module.exports as unknown as { run: (graphs: number) => number }, [])).toBe(6)
      expect(e.resultIds(12)).toEqual(reference.rows)
      expect(legacy).toHaveLength(1)
      expect(legacy[0].at).toBe(0)
      expect(legacy[0].count).toBe(3)
      expect(legacy[0].dense.filter((_, i) => i % 2 === 0)).toEqual([0, 0, 0])
      expect(legacy[0].dense.filter((_, i) => i % 2 === 1).map(id => e.value(id))).toEqual(['2', '1', '2'])
    } finally { q.release(); e.dispose() }
  })

  it('keeps numeric term identity, including wide integers, noncanonical spelling and zero', () => {
    const e = new Engine(image())
    const spellings = ['1234567890123456789012345678901234567890', '01', '1', '0']
    e.load(Format.Turtle, PREFIX + ':keep :anchor :m . ' + spellings.map((value, i) => `:x${i} :value "${value}"^^xsd:integer .`).join(' '))
    const q = e.prepare(PREFIX + `SELECT ?v WHERE { ?s :anchor ?m { ?x :value ?v OPTIONAL { ?x :optional ?o } FILTER(!BOUND(?s)) } ${pads(96)} }`)
    try {
      const reference = select(q.run())
      const result = compiled(e, q)
      expect(result.count).toBe(4)
      expect(bag(result)).toEqual(bag(reference))
      expect(Array.from(result.rows, id => e.value(id)).sort()).toEqual([...spellings].sort())
      expect(Array.from(result.rows, id => e.value(e.datatype(id))).every(value => value === 'http://www.w3.org/2001/XMLSchema#integer')).toBe(true)
    } finally { q.release(); e.dispose() }
  })

  it('evaluates each RHS and LHS volatile expression once in the retained plan', () => {
    const e = new Engine(image())
    e.load(Format.Turtle, PREFIX + ':a :anchor :m . :b :anchor :m . :x0 :value 0 . :x1 :value 1 . :x2 :value 2 .')
    const q = e.prepare(PREFIX + `SELECT ?s ?v ?r ?left WHERE {
      ?s :anchor ?m BIND(RAND() AS ?left)
      { ?x :value ?v BIND(RAND() AS ?r) FILTER(!BOUND(?s)) }
      ${pads(96)}
    }`)
    let calls = 0
    const random = vi.spyOn(Math, 'random').mockImplementation(() => ++calls / 10)
    try {
      const result = compiled(e, q)
      expect(result.count).toBe(6)
      expect(calls).toBe(5)
      const right = new Map<number, Set<number>>(), left = new Map<number, Set<number>>()
      for (let at = 0; at < result.rows.length; at += 4) {
        const [s, v, r, l] = result.rows.subarray(at, at + 4)
        if (!right.has(v)) right.set(v, new Set())
        if (!left.has(s)) left.set(s, new Set())
        right.get(v)!.add(r); left.get(s)!.add(l)
      }
      expect(right.size).toBe(3); expect(left.size).toBe(2)
      expect([...right.values(), ...left.values()].every(values => values.size === 1)).toBe(true)
    } finally { random.mockRestore(); q.release(); e.dispose() }
  })

  it('retains SELECT expressions and ORDER/LIMIT inside a nested subquery', () => {
    const e = new Engine(image())
    e.load(Format.Turtle, PREFIX + ':a :anchor :m . :b :anchor :m .')
    const q = e.prepare(PREFIX + `SELECT ?s ?v ?r WHERE {
      ?s :anchor ?m
      { { SELECT ?v (RAND() AS ?r) WHERE { VALUES ?v { 1 2 3 } } ORDER BY DESC(?v) LIMIT 1 } FILTER(!BOUND(?s)) }
      ${pads(96)}
    }`)
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      const result = compiled(e, q)
      expect(result.count).toBe(2)
      expect(random).toHaveBeenCalledTimes(3)
      for (let at = 0; at < result.rows.length; at += 3) expect(e.value(result.rows[at + 1])).toBe('3')
    } finally { random.mockRestore(); q.release(); e.dispose() }
  })

  it('preserves duplicate zero-width solutions without a stored row header', () => {
    const e = new Engine(image())
    const q = e.prepare('SELECT * WHERE { VALUES () { () () } { OPTIONAL { FILTER(true) } } }')
    try {
      const reference = select(q.run())
      expect(reference.count).toBe(2)
      const result = compiled(e, q)
      expect(result.vars).toEqual([])
      expect(result.rows).toHaveLength(0)
      expect(result.count).toBe(2)
    } finally { q.release(); e.dispose() }
  })
})
