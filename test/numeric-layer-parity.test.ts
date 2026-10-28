// Shared reader adoption must preserve the function/SPARQL policy on actual
// field and shape rules, including values too wide for native exact arithmetic.
import { describe, expect, it } from 'vitest'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { MOD, NS, VAL } from '../src/ns.ts'
import { Runtime } from '../src/runtime.ts'
import type { GraphStore } from '../src/store/types.ts'

const EX = 'https://example.org/numeric/'
const XSD = NS.xsd
const SH = NS.sh
const prefixes = `@prefix : <${EX}> . @prefix c: <${NS.c}> . @prefix val: <${NS.val}> . @prefix sem: <${NS.sem}> . @prefix sh: <${SH}> . @prefix xsd: <${XSD}> . @prefix rdfs: <${NS.rdfs}> .`
const quoted = (text: string) => JSON.stringify(text)
const stores = ['oxigraph', 'wat', 'rust'] as const
const twins = ['function', 'sparql'] as const
// Controlled generic entry text has its existing boundary trim policy. An
// internal NBSP remains invalid on both paths; boundary NBSP is raw/plain only.
const fieldModes = (lexical: string) => lexical.startsWith('\u00a0') || lexical.endsWith('\u00a0') ? [false] : [false, true]

function project(kind: StoreKind, prefer: typeof twins[number], graph: string, roots: string[], layer: string, rule: string, beforeProject?: (store: GraphStore) => void) {
  const store = loadStore(kind, prefixes + '\n' + graph)
  beforeProject?.(store)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: [layer], prefer, name: 'numeric', roots: roots.map(id => EX + id) }, error => { throw error })
  expect(screen.engine.stats.byRule.get(NS.val + rule + (prefer === 'sparql' ? '-sparql' : '-fn'))?.runs).toBeGreaterThan(0)
  const objects = (id: string, predicate: string) => store.match(store.factory.namedNode(EX + id), store.factory.namedNode(predicate), null).map(q => q.object.value).sort()
  return { store, runtime, objects }
}

type ShapeCase = { id: string; target: string; family: string; lexical: string; invalid: boolean }
const baseFamilies = new Set(['integer', 'decimal', 'float', 'double'])

// Shape validation sees the term the backend actually stores. Oxigraph can
// encode a numeric value and emit a canonical term, losing input spelling or
// a derived integer datatype. Never pretend that lost input remains visible.
// Only these explicit value-preserving normalization relations are allowed;
// an unreviewed transformation fails the test instead of changing the oracle.
function storedShapeOracle(kind: typeof stores[number], store: GraphStore, entry: ShapeCase) {
  const f = store.factory
  const rows = store.match(f.namedNode(EX + entry.id), f.namedNode(EX + 'value'), null)
  expect(rows).toHaveLength(1)
  const value = rows[0]!.object
  if (value.termType !== 'Literal') throw Error('numeric fixture must retain one literal')
  const family = value.datatype.value.replace(XSD, '')
  const observed = { inputFamily: entry.family, inputLexical: entry.lexical, storedFamily: family, storedLexical: value.value }
  if (family === entry.family && value.value === entry.lexical) return { invalid: entry.invalid, observed }
  expect(kind, 'Only the canonicalizing backend may change this raw fixture').toBe('oxigraph')
  if (!['decimal', 'float', 'double'].includes(entry.family) && family === 'integer'
      && /^[+-]?[0-9]+$/.test(entry.lexical) && /^[+-]?[0-9]+$/.test(value.value)) {
    expect(BigInt(value.value)).toBe(BigInt(entry.lexical))
    // The stored term is now xsd:integer; the original subtype is unavailable.
    // Keep exactly the existing four-family compatibility on that stored term.
    return { invalid: !baseFamilies.has(entry.target), observed }
  }
  if (['float', 'double'].includes(entry.family) && family === entry.family
      && ['INF', '+INF', 'Infinity', '+Infinity', '-INF', '-Infinity'].includes(entry.lexical)) {
    expect(value.value).toBe(entry.lexical.startsWith('-') ? '-INF' : 'INF')
    return { invalid: !baseFamilies.has(entry.target) || entry.target === 'integer', observed }
  }
  throw Error('Unreviewed stored numeric normalization: ' + JSON.stringify(observed))
}

describe.each(stores)('%s numeric layer twins', kind => {
  it('rejects nonfinite numeric field input in plain and controlled branches, preserving finite wide input', () => {
    const cases: { id: string; datatype: string; lexical: string; invalid: boolean }[] = []
    for (const datatype of ['integer', 'decimal']) {
      for (const lexical of ['NaN', 'INF', '+INF', '-INF', 'Infinity', '1e999999', '-1e999999', '0x10', '\u00a01', '1\u00a0', '1\u00a00']) cases.push({ id: 'field-' + cases.length, datatype, lexical, invalid: true })
      for (const lexical of ['-0', '1e2', '9'.repeat(100), ' \t1\r\n ']) cases.push({ id: 'field-' + cases.length, datatype, lexical, invalid: false })
      cases.push({ id: 'field-' + cases.length, datatype, lexical: '0.' + '0'.repeat(80) + '1', invalid: datatype === 'integer' })
    }
    const roots: string[] = []
    const graph: string[] = []
    for (const entry of cases) {
      graph.push(`:${entry.id}-shape a sh:PropertyShape ; sh:path :value ; sh:datatype xsd:${entry.datatype} .`)
      // Boundary NBSP is asserted on the plain XML lexical input path. Internal
      // NBSP is asserted on both paths after the controlled entry's existing trim.
      for (const controlled of fieldModes(entry.lexical)) {
        const id = entry.id + (controlled ? '-controlled' : '-plain')
        roots.push(id)
        graph.push(`:${id} a c:TextField ; c:label "Number" ; val:validates :${entry.id}-shape ; c:value ${quoted(entry.lexical)} ${controlled ? '; c:controls :record ; c:property :value ; c:allowsCustom true' : ''} .`)
      }
    }
    const snapshots: string[][] = []
    for (const prefer of twins) {
      const h = project(kind, prefer, graph.join('\n'), roots, VAL.Layer, 'Check')
      try {
        const snapshot: string[] = []
        for (const entry of cases) for (const controlled of fieldModes(entry.lexical)) {
          const id = entry.id + (controlled ? '-controlled' : '-plain')
          const error = h.objects(id, controlled ? NS.val + 'invalidEntry' : NS.c + 'error')
          expect(error.length > 0, `${prefer}: ${id} ${entry.lexical}`).toBe(entry.invalid)
          if (!controlled) expect(h.objects(id, VAL.invalid)).toEqual(entry.invalid ? ['true'] : [])
          snapshot.push(id + ': ' + error.join('|'))
        }
        snapshots.push(snapshot)
      } finally { h.runtime.dispose() }
    }
    expect(snapshots[1]).toEqual(snapshots[0])
  })

  it('retains four-family compatibility over stored terms and validates all sixteen families on retaining stores', () => {
    const cases: ShapeCase[] = []
    const add = (target: string, family: string, lexical: string, invalid: boolean) => cases.push({ id: 'shape-' + cases.length, target, family, lexical, invalid })
    for (const family of ['float', 'double']) {
      for (const lexical of ['NaN', 'INF', '+INF', '-INF']) add('integer', family, lexical, true)
      add('integer', family, '1', false)
      add('integer', family, '1.25', true)
      add('decimal', family, 'INF', false) // finite restriction applies to integer compatibility only
    }
    for (const [family, valid, invalid] of [
      ['integer', '9'.repeat(200), '1.0'], ['decimal', '0.' + '0'.repeat(80) + '1', '1e2'],
      ['float', '-0', '0x10'], ['double', 'NaN', 'Infinity'],
      ['long', '-9223372036854775808', '-9223372036854775809'], ['int', '2147483647', '2147483648'],
      ['short', '-32768', '-32769'], ['byte', '127', '128'],
      ['nonNegativeInteger', '-0', '-1'], ['positiveInteger', '1', '0'], ['nonPositiveInteger', '+0', '1'], ['negativeInteger', '-1', '-0'],
      ['unsignedLong', '18446744073709551615', '18446744073709551616'], ['unsignedInt', '4294967295', '4294967296'],
      ['unsignedShort', '65535', '65536'], ['unsignedByte', '255', '256'],
    ]) {
      add(family!, family!, valid!, false)
      add(family!, family!, invalid!, true)
    }
    // The strict lexical guard has no i64/scale18 materialization limit.
    // Keep exact signed/unsigned endpoints, leading zeros and mathematical zero.
    for (const [family, low, high] of [
      ['long', '-9223372036854775808', '9223372036854775807'], ['int', '-2147483648', '2147483647'],
      ['short', '-32768', '32767'], ['byte', '-128', '127'],
      ['unsignedLong', '0', '18446744073709551615'], ['unsignedInt', '0', '4294967295'],
      ['unsignedShort', '0', '65535'], ['unsignedByte', '0', '255'],
    ]) {
      for (const lexical of [low!, high!, '+000' + high!, '-0', '+0']) add(family!, family!, lexical, false)
      for (const lexical of [(BigInt(low!) - 1n).toString(), (BigInt(high!) + 1n).toString()]) add(family!, family!, lexical, true)
    }
    // Valid subtype input does not widen the existing cross-datatype policy.
    add('integer', 'unsignedLong', '18446744073709551615', true)
    add('integer', 'decimal', '9'.repeat(100), false)
    const graph = cases.map(entry => `:${entry.id}-type rdfs:subClassOf sem:Component .
:${entry.id} a :${entry.id}-type ; :value ${quoted(entry.lexical)}^^xsd:${entry.family} .
:${entry.id}-nodeShape a sh:NodeShape ; sh:targetClass :${entry.id}-type ; sh:property :${entry.id}-propertyShape .
:${entry.id}-propertyShape sh:path :value ; sh:datatype xsd:${entry.target} .`).join('\n')
    const snapshots: boolean[][] = []
    for (const prefer of twins) {
      const oracles = new Map<string, ReturnType<typeof storedShapeOracle>>()
      const h = project(kind, prefer, graph, cases.map(entry => entry.id), VAL.ShapesLayer, 'Shapes', store => {
        for (const entry of cases) oracles.set(entry.id, storedShapeOracle(kind, store, entry))
      })
      try {
        const results = cases.map(entry => {
          const focus = h.store.factory.namedNode(EX + entry.id)
          const invalid = h.store.match(null, h.store.factory.namedNode(SH + 'focusNode'), focus).length > 0
          expect(invalid, `${prefer}: ${entry.family} to ${entry.target}, ${entry.lexical}`).toBe(oracles.get(entry.id)!.invalid)
          return invalid
        })
        snapshots.push(results)
        if (prefer === 'function') console.info('[numeric stored-term controls]', JSON.stringify({ kind, terms: [...oracles.values()].map(value => value.observed) }))
      } finally { h.runtime.dispose() }
    }
    expect(snapshots[1]).toEqual(snapshots[0])
  })
})
