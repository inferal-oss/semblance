// Expected bits are exact-rational fixtures. Number below only observes the
// engine's canonical output (f32 has at most 9 digits, f64 at most 17), rather
// than deriving any gold bit pattern from the original input.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Engine, EngineError, Form } from '../rdf-engine/host/engine.ts'

const XSD = 'http://www.w3.org/2001/XMLSchema#'
const PREFIX = `PREFIX xsd: <${XSD}> `
const vectors = JSON.parse(readFileSync(new URL('./fixtures/numeric-rounding.json', import.meta.url), 'utf8')).vectors as { name: string; format: string; lexical: string; expected_bits: string }[]
// Both freshly built engines are mandatory; a missing binary fails collection.
const built = ['rust', 'wat'] as const
const observedBits = (lexical: string, single: boolean) => {
  const value = lexical === 'INF' ? Infinity : lexical === '-INF' ? -Infinity : Number(lexical)
  const view = new DataView(new ArrayBuffer(8))
  if (single) {
    view.setFloat32(0, value)
    return view.getUint32(0).toString(16).padStart(8, '0')
  }
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}
const values = (engine: Engine, result: ReturnType<ReturnType<Engine['prepare']>['run']>) => {
  if (result.form !== Form.Select) throw Error('expected SELECT')
  return Array.from(result.rows, id => id ? engine.value(id) : undefined)
}
const interrupted = (invoke: () => unknown) => {
  try { invoke() } catch (error) { if (error instanceof EngineError && error.interrupted) return error; throw error }
  throw Error('expected interruption')
}

const assertExecution = (engine: Engine, compiled: boolean, runs?: number) => {
  expect(engine.stats.fallbacks).toBe(0)
  if (compiled) {
    expect(engine.stats.interpretedRuns).toBe(0)
    if (runs !== undefined) expect(engine.stats.compiledRuns).toBe(runs)
    else expect(engine.stats.compiledRuns).toBeGreaterThan(0)
  } else {
    expect(engine.stats.compiledRuns).toBe(0)
    expect(engine.stats.interpretedRuns).toBeGreaterThan(0)
  }
}
const typedWork = (single: boolean, phase: 'scan' | 'limb', variant = 0) => ({
  // Distinct spellings keep each attempted cancellation/fault uncached. The
  // compact limb case has no 256-byte scan interval before limb conversion.
  lexical: phase === 'scan' ? '0.' + '0'.repeat(100_000 + variant) + '1e' + (100_001 + variant) : '+' + '0'.repeat(variant) + (single ? '1000000000000000000000000000001e-60' : '1e-300'),
  bits: phase === 'scan' ? (single ? '3f800000' : '3ff0000000000000') : (single ? '0da24260' : '01a56e1fc2f8f359'),
})

describe.each(built)('%s numeric conversion', kind => {
  const module = new WebAssembly.Module(readFileSync(new URL(`../rdf-engine/build/${kind}.wasm`, import.meta.url)))
  it.each([false, true])('runs independent bit fixtures through actual query casts (compiled=%s)', compiled => {
    const e = new Engine(module)
    const q64 = e.prepare(PREFIX + 'SELECT (xsd:double(?input) AS ?number) WHERE {}')
    const q32 = e.prepare(PREFIX + 'SELECT (xsd:float(?input) AS ?number) WHERE {}')
    const seed = e.literal('1')
    q64.bind('input', seed); q32.bind('input', seed)
    if (compiled) { expect(q64.compile()).toBe(null); expect(q32.compile()).toBe(null) }
    for (const vector of vectors) {
      const single = vector.format === 'binary32'
      const q = single ? q32 : q64
      // Both simple strings and valid raw decimals exercise direct rounding.
      for (const datatype of [0, e.iri(XSD + 'decimal')]) {
        q.bind('input', e.literal(vector.lexical, datatype))
        const lexical = values(e, q.run())[0]
        expect(lexical, vector.name).toBeDefined()
        expect(observedBits(lexical!, single), vector.name).toBe(vector.expected_bits)
      }
    }
    assertExecution(e, compiled, vectors.length * 2)
    q64.release(); q32.release(); e.dispose()
  })

  it.each([false, true])('runs all golds through typed native numeric parsing and cache (compiled=%s)', compiled => {
    const e = new Engine(module)
    const queries = [false, true].map(single => {
      const datatype = e.iri(XSD + (single ? 'float' : 'double'))
      // Same-type positive one preserves signed zero and forces numeric input.
      const query = e.prepare(PREFIX + 'SELECT (?input * ?one AS ?number) WHERE {}')
        .bind('input', e.literal('0', datatype)).bind('one', e.literal('1', datatype))
      if (compiled) expect(query.compile()).toBe(null)
      return { query, datatype }
    })
    const typedZeros = ['binary64', 'binary32'].flatMap(format => ['-0', '-0.0e99999', '+0', '0e-99999'].map(lexical => ({
      name: 'typed-zero-' + lexical, format, lexical, expected_bits: lexical.startsWith('-') ? (format === 'binary32' ? '80000000' : '8000000000000000') : (format === 'binary32' ? '00000000' : '0000000000000000'),
    })))
    for (const vector of [...vectors, ...typedZeros]) {
      const single = vector.format === 'binary32'
      const { query, datatype } = queries[single ? 1 : 0]!
      query.bind('input', e.literal(vector.lexical, datatype))
      const output = values(e, query.run())[0]
      expect(output, vector.name).toBeDefined()
      expect(observedBits(output!, single), vector.name).toBe(vector.expected_bits)
    }
    assertExecution(e, compiled, vectors.length + typedZeros.length)
    for (const { query } of queries) query.release()
    e.dispose()
  })

  it('selects compiled borrowed-string and computed-number cast bridges', () => {
    const e = new Engine(module)
    const q = e.prepare(PREFIX + 'SELECT (xsd:double(CONCAT(?input, "")) AS ?string) (xsd:double(?native + 0) AS ?computed) (xsd:double("1000000000000000065") AS ?constant) WHERE {}')
    q.bind('input', e.literal('1000000000000000065'))
    q.bind('native', e.literal('1000000000000000065', e.iri(XSD + 'integer')))
    expect(q.compile()).toBe(null)
    const output = values(e, q.run())
    for (const lexical of output) expect(observedBits(lexical!, false)).toBe('43abc16d674ec801')
    expect(e.stats.compiledRuns).toBe(1)
    expect(e.stats.interpretedRuns).toBe(0)
    expect(e.stats.fallbacks).toBe(0)
    q.release(); e.dispose()
  })

  it.each([false, true])('validates subtype ranges and wide values before native type-zero (compiled=%s)', compiled => {
    const e = new Engine(module)
    const q = e.prepare(PREFIX + 'SELECT (isNUMERIC(?input) AS ?valid) (xsd:double(?input) AS ?number) WHERE {}')
    q.bind('input', e.literal('1'))
    if (compiled) expect(q.compile()).toBe(null)
    const cases: [string, string, boolean][] = []
    for (const [family, lo, hi] of [
      ['long', '-9223372036854775808', '9223372036854775807'], ['int', '-2147483648', '2147483647'],
      ['short', '-32768', '32767'], ['byte', '-128', '127'],
      ['unsignedLong', '0', '18446744073709551615'], ['unsignedInt', '0', '4294967295'],
      ['unsignedShort', '0', '65535'], ['unsignedByte', '0', '255'],
    ]) {
      for (const lexical of [lo!, hi!, '+000' + hi!, '-0', '+0']) cases.push([family!, lexical, true])
      for (const lexical of [(BigInt(lo!) - 1n).toString(), (BigInt(hi!) + 1n).toString()]) cases.push([family!, lexical, false])
    }
    for (const [family, good, bad] of [
      ['nonNegativeInteger', ['-0', '+0', '1'], ['-1']], ['positiveInteger', ['1', '+0001'], ['0', '-0', '-1']],
      ['nonPositiveInteger', ['-0', '+0', '-1'], ['1']], ['negativeInteger', ['-1', '-0001'], ['-0', '+0', '1']],
      ['integer', ['9'.repeat(200), '-' + '9'.repeat(200), '-0'], ['1.0']],
      ['decimal', ['0.' + '0'.repeat(80) + '1', '9'.repeat(200), '-0.0'], ['1e2']],
      ['float', ['1e2', 'NaN', 'INF', '+INF', '-INF', '-0'], ['0x10']],
      ['double', ['1e2', 'NaN', 'INF', '+INF', '-INF', '-0'], ['Infinity']],
    ] as const) {
      for (const lexical of good) cases.push([family, lexical, true])
      for (const lexical of bad) cases.push([family, lexical, false])
    }
    for (const family of ['integer', 'decimal', 'float', 'double', 'long', 'int', 'short', 'byte', 'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte']) {
      const lexical = family === 'nonPositiveInteger' || family === 'negativeInteger' ? '-1' : '1'
      cases.push([family, (lexical === '-1' ? '-' : '') + '0'.repeat(2000) + '1', true])
      cases.push([family, lexical + '0'.repeat(2000) + 'malformed', false])
    }
    for (const [family, lexical, valid] of cases) {
      q.bind('input', e.literal(lexical, e.iri(XSD + family)))
      const result = values(e, q.run())
      expect(result[0], `${family}: ${lexical.slice(0, 30)}`).toBe(valid ? 'true' : 'false')
      if (valid) expect(result[1], family).toBeDefined()
      else expect(result[1], family).toBeUndefined()
    }
    assertExecution(e, compiled, cases.length)
    q.release(); e.dispose()
  })

  it.each([false, true])('distinguishes valid wide input from unsupported native exact arithmetic (compiled=%s)', compiled => {
    const e = new Engine(module)
    const q = e.prepare(PREFIX + 'SELECT (isNUMERIC(?input) AS ?valid) (xsd:double(?input) AS ?floating) (?input + 0 AS ?native) WHERE {}')
      .bind('input', e.literal('0'))
    if (compiled) expect(q.compile()).toBe(null)
    for (const [family, lexical] of [['integer', '9'.repeat(200)], ['decimal', '0.' + '0'.repeat(80) + '1']]) {
      q.bind('input', e.literal(lexical!, e.iri(XSD + family)))
      const result = values(e, q.run())
      expect(result[0]).toBe('true')
      expect(result[1]).toBeDefined()
      expect(result[2]).toBeUndefined()
    }
    assertExecution(e, compiled, 2)
    q.release(); e.dispose()
  })

  it.each([false, true])('enforces derived integer restrictions on cast results (compiled=%s)', compiled => {
    const e = new Engine(module)
    const q = e.prepare(PREFIX + 'SELECT (xsd:byte(?input) AS ?byte) (xsd:unsignedByte(?input) AS ?unsigned) (xsd:positiveInteger(?input) AS ?positive) WHERE {}')
    q.bind('input', e.literal('1'))
    if (compiled) expect(q.compile()).toBe(null)
    for (const [lexical, expected] of [['128', [undefined, '128', '128']], ['-1', ['-1', undefined, undefined]], ['0', ['0', '0', undefined]]] as const) {
      q.bind('input', e.literal(lexical))
      expect(values(e, q.run())).toEqual(expected)
    }
    assertExecution(e, compiled)
    q.release(); e.dispose()
  })

  it.each([false, true])('uses complete XML lexical validation and keeps floating signed zero (compiled=%s)', compiled => {
    const e = new Engine(module)
    const q = e.prepare(PREFIX + 'SELECT (xsd:double(?input) AS ?number) WHERE {}')
    q.bind('input', e.literal('1'))
    if (compiled) expect(q.compile()).toBe(null)
    for (const datatype of [0, e.iri(XSD + 'double')]) {
      for (const lexical of ['', ' ', '0x10', '1 0', '\u00a01', '1e9999999tail', '-NaN', '+NaN']) {
        q.bind('input', e.literal(lexical, datatype))
        expect(values(e, q.run())).toEqual([undefined])
      }
      for (const [lexical, expected] of [[' \t\r\n1\n ', '1'], ['-0e999999999999999999999', '-0'], ['INF', 'INF'], ['NaN', 'NaN']]) {
        q.bind('input', e.literal(lexical!, datatype))
        expect(values(e, q.run())[0]).toBe(expected)
      }
    }
    assertExecution(e, compiled)
    q.release(); e.dispose()
  })

  it.each([false, true])('promotes the operand before float operations and preserves source float rounding (compiled=%s)', compiled => {
    const e = new Engine(module)
    const q = e.prepare(PREFIX + 'SELECT (?a + ?b AS ?sum) (?a = ?b AS ?same) (xsd:double(?b) AS ?wide) WHERE {}')
    q.bind('a', e.literal('16777217', e.iri(XSD + 'integer')))
    q.bind('b', e.literal('16777216', e.iri(XSD + 'float')))
    if (compiled) expect(q.compile()).toBe(null)
    expect(values(e, q.run())).toEqual(['33554432', 'true', '16777216'])
    q.bind('a', e.literal('1152921573326323713', e.iri(XSD + 'integer')))
    q.bind('b', e.literal('0', e.iri(XSD + 'float')))
    expect(observedBits(values(e, q.run())[0]!, true)).toBe('5d800001')
    q.bind('a', e.literal('0.1', e.iri(XSD + 'decimal')))
    q.bind('b', e.literal('0.1', e.iri(XSD + 'float')))
    // Both operands are promoted at float precision.
    expect(values(e, q.run())[1]).toBe('true')
    assertExecution(e, compiled)
    q.release(); e.dispose()
  })

  it.each([false, true])('cancels uncached typed scan/limb work and reuses the exact term/query (compiled=%s)', compiled => {
    for (const single of [false, true]) {
      let armed = false; let calls = 0
      const e = new Engine(module, () => armed && ++calls >= 4 ? 2 : 0)
      const datatype = e.iri(XSD + (single ? 'float' : 'double'))
      const q = e.prepare(PREFIX + 'SELECT (?input * ?one AS ?number) WHERE {}')
        .bind('input', e.literal('0', datatype)).bind('one', e.literal('1', datatype))
      if (compiled) expect(q.compile()).toBe(null)
      for (const phase of ['scan', 'limb'] as const) {
        const work = typedWork(single, phase)
        const id = e.literal(work.lexical, datatype)
        q.bind('input', id)
        calls = 0; armed = true; e.setDeadline(1)
        // Call 1: Rust Ctx clock / WAT num-entry poll. Call 2: validator
        // entry. Call 4: scan's second 256-byte interval, or first limb poll
        // after compact lexical validation. The initial clock succeeded.
        interrupted(() => q.run())
        expect(calls, `${phase}, float=${single}`).toBe(4)
        armed = false; e.setDeadline(undefined)
        // No rebinding or replacing the term: a poisoned negative cache fails.
        expect(observedBits(values(e, q.run())[0]!, single)).toBe(work.bits)
        expect(e.literal(work.lexical, datatype)).toBe(id)
        // After interrupted/recovered typed-cache work, observe page capacity
        // only; this does not prove allocator high-water or within-page leaks.
        const memory = (e as unknown as { x: { memory: WebAssembly.Memory } }).x.memory
        const recoveredPages = memory.buffer.byteLength
        for (let repeat = 0; repeat < 2; repeat++) expect(observedBits(values(e, q.run())[0]!, single)).toBe(work.bits)
        expect(memory.buffer.byteLength).toBe(recoveredPages)
      }
      assertExecution(e, compiled, 6)
      q.release(); e.dispose()
    }
  })

  it.each([false, true])('keeps exact minimum row fuel and observes warmed page capacity (compiled=%s)', compiled => {
    const e = new Engine(module)
    const text = PREFIX + 'SELECT (?input * ?one AS ?number) WHERE { ?marker <https://example.org/numeric-fuel-row> ?row }'
    const datatype = e.iri(XSD + 'double')
    const one = e.literal('1', datatype)
    // Real triple scans spend row fuel in both evaluators and compiled loops.
    // VALUES is not required to spend fuel; conversion work must not invent it.
    const rowCount = 8, predicate = e.iri('https://example.org/numeric-fuel-row')
    for (let i = 0; i < rowCount; i++) e.add(e.iri('https://example.org/numeric-fuel-row/' + i), predicate, one)
    expect(e.quadCount()).toBe(rowCount)
    const short = e.prepare(text).bind('input', one).bind('one', one)
    const long = e.prepare(text).bind('input', e.literal(typedWork(false, 'scan').lexical, datatype)).bind('one', one)
    if (compiled) { expect(short.compile()).toBe(null); expect(long.compile()).toBe(null) }
    let variant = 0
    const succeeds = (q: typeof short, fuel: number) => {
      // Force a fresh uncached input at EVERY boundary attempt; a successful
      // prefix of an interrupted query cannot hide conversion work in a cache.
      const lexical = q === long ? typedWork(false, 'scan', ++variant).lexical : '+' + '0'.repeat(++variant) + '1'
      q.bind('input', e.literal(lexical, datatype))
      e.setFuel(fuel)
      try {
        const result = q.run()
        expect(result.form).toBe(Form.Select)
        if (result.form === Form.Select) expect(result.count).toBe(rowCount)
        expect(values(e, result)).toEqual(Array(rowCount).fill('1'))
        return true
      } catch (error) { if (error instanceof EngineError && error.interrupted) return false; throw error }
    }
    let minimum: number | undefined
    let sawFailure = false
    for (let fuel = 1; fuel <= 256; fuel++) {
      const small = succeeds(short, fuel)
      expect(succeeds(long, fuel), `fuel=${fuel}`).toBe(small)
      if (small) { minimum = fuel; break }
      sawFailure = true
    }
    expect(sawFailure).toBe(true)
    expect(minimum).toBeDefined()
    expect(minimum!).toBeGreaterThan(1)
    expect(succeeds(short, minimum! - 1)).toBe(false)
    expect(succeeds(long, minimum! - 1)).toBe(false)
    expect(succeeds(short, minimum!)).toBe(true)
    expect(succeeds(long, minimum!)).toBe(true)
    e.setFuel(undefined)
    expect(values(e, long.run())[0]).toBe('1')
    const memory = (e as unknown as { x: { memory: WebAssembly.Memory } }).x.memory
    // This is page-capacity evidence only. Fixed workspace and absence of
    // input copies are separately reviewed source invariants, not proved by
    // byteLength or by allocator activity within already allocated pages.
    const warmed = memory.buffer.byteLength
    for (let i = 0; i < 12; i++) expect(values(e, long.run())[0]).toBe('1')
    expect(memory.buffer.byteLength).toBe(warmed)
    assertExecution(e, compiled)
    short.release(); long.release(); e.dispose()
  })

  it.each([false, true])('cleans up query clock exceptions/nonfinite values before throwing and permits reuse (compiled=%s)', compiled => {
    let fault: unknown
    const e = new Engine(module, () => { if (fault instanceof Error) throw fault; return typeof fault === 'number' ? fault : 0 })
    const q = e.prepare(PREFIX + 'SELECT (NOW() AS ?now) (xsd:double(?input) AS ?number) WHERE {}')
    q.bind('input', e.literal('1e-300'))
    if (compiled) expect(q.compile()).toBe(null)
    for (const cause of [Error('injected clock failure'), NaN, Infinity, -Infinity]) {
      fault = cause; e.setDeadline(1)
      const error = interrupted(() => q.run())
      expect(error.message).toBe('engine clock callback failed')
      const retained = (error as Error & { cause: unknown }).cause
      if (cause instanceof Error) expect(retained).toBe(cause)
      else { expect(retained).toBeInstanceOf(TypeError); expect((retained as Error).message).toBe('engine clock must return finite milliseconds') }
      fault = undefined; e.setDeadline(undefined)
      expect(values(e, q.run())[1]).toBeDefined()
    }
    assertExecution(e, compiled, 4)
    q.release(); e.dispose()
  })

  it.each([false, true])('cleans up clock faults after native scan/limb conversion begins (compiled=%s)', compiled => {
    for (const single of [false, true]) for (const phase of ['scan', 'limb'] as const) {
      let armed = false; let calls = 0; let injected: unknown
      const e = new Engine(module, () => {
        if (!armed || ++calls < 4) return 0
        if (injected instanceof Error) throw injected
        return injected as number
      })
      const datatype = e.iri(XSD + (single ? 'float' : 'double'))
      const q = e.prepare(PREFIX + 'SELECT (?input * ?one AS ?number) WHERE {}')
        .bind('input', e.literal('0', datatype)).bind('one', e.literal('1', datatype))
      if (compiled) expect(q.compile()).toBe(null)
      for (const [variant, cause] of [Error('mid-work clock sentinel'), NaN, Infinity, -Infinity].entries()) {
        const work = typedWork(single, phase, variant)
        const id = e.literal(work.lexical, datatype)
        q.bind('input', id)
        calls = 0; injected = cause; armed = true; e.setDeadline(1)
        const error = interrupted(() => q.run())
        expect(calls, `${phase}, float=${single}`).toBe(4)
        expect(error.message).toBe('engine clock callback failed')
        const retained = (error as Error & { cause: unknown }).cause
        if (cause instanceof Error) expect(retained).toBe(cause)
        else { expect(retained).toBeInstanceOf(TypeError); expect((retained as Error).message).toBe('engine clock must return finite milliseconds') }
        armed = false; e.setDeadline(undefined)
        // Exact same term and query must parse successfully after normal cleanup.
        expect(observedBits(values(e, q.run())[0]!, single)).toBe(work.bits)
        expect(e.literal(work.lexical, datatype)).toBe(id)
      }
      assertExecution(e, compiled, 4)
      q.release(); e.dispose()
    }
  })

  it.each([false, true])('rejects callback reentry before mutation and permits independent instances (compiled=%s)', compiled => {
    let callback: (() => void) | undefined
    const e = new Engine(module, () => { callback?.(); return 0 })
    const other = new Engine(module)
    const q = e.prepare(PREFIX + 'SELECT (NOW() AS ?now) (xsd:double(?input) AS ?number) WHERE {}')
    const one = e.literal('1'), two = e.literal('2')
    const subject = e.iri('https://example.org/subject'), predicate = e.iri('https://example.org/value')
    e.add(subject, predicate, one)
    q.bind('input', one)
    if (compiled) expect(q.compile()).toBe(null)
    // Warm deterministic NOW/numeric output, datatype IDs and query scratch.
    expect(values(e, q.run())[1]).toBe('1')
    const termsBefore = e.termCount()
    const quadsBefore = e.quadCount()
    const attempts = [
      () => e.literal('forbidden'), () => q.bind('input', two), () => q.bindValues('input', [two]),
      () => q.run(), () => q.release(), () => q.compile(), () => q.compileShape('input'),
      () => e.dispose(), () => e.prepare('SELECT * {}'), () => e.setFuel(1), () => e.setDeadline(1),
      () => e.add(subject, predicate, two), () => e.remove(subject, predicate, one), () => e.apply([], [subject, predicate, two, 1]), () => e.load(1, ''),
      () => e.update('INSERT DATA {}'), () => e.parseUpdate('INSERT DATA {}'), () => e.collect(),
    ]
    callback = () => {
      for (const nested of attempts) expect(nested).toThrow('same-instance engine entry from clock callback')
      expect(other.literal('independent')).toBeGreaterThan(0)
    }
    // Caught reentry rejection plus finite time leaves the outer query valid.
    expect(values(e, q.run())[1]).toBe('1')
    callback = undefined
    expect(e.termCount()).toBe(termsBefore)
    expect(e.quadCount()).toBe(quadsBefore)
    expect(e.has(subject, predicate, one)).toBe(true)
    expect(e.has(subject, predicate, two)).toBe(false)
    expect(values(e, q.run())[1]).toBe('1')
    callback = () => q.bind('input', two)
    interrupted(() => q.run())
    callback = undefined
    expect(e.termCount()).toBe(termsBefore)
    expect(e.quadCount()).toBe(quadsBefore)
    expect(e.has(subject, predicate, one)).toBe(true)
    expect(e.has(subject, predicate, two)).toBe(false)
    expect(values(e, q.run())[1]).toBe('1')
    assertExecution(e, compiled, 4)
    q.release(); e.dispose(); other.dispose()
  })
})
