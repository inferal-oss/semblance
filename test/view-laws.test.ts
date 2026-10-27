// Maintained views, operator by operator (docs/IVM.md §12.2, §21): joins outside the member,
// DISTINCT, UNION, VALUES, OPTIONAL, EXISTS, NOT EXISTS, MINUS, top-k, parameters and views per
// instance, each equal to a from-scratch run of its own query after every tick under seeded
// random changes (strict mode throws on any difference), and each costing what changed, not
// what the graph holds.
import { describe, expect, it } from 'vitest'
import { LDES, NS } from '../src/ns.ts'
import { lawRuntime, LAW_VIEWS, runLaws, V } from './view-laws.ts'

describe('maintained views: operator laws', () => {
  for (const seed of [1, 2, 3]) {
    it(`every view equals a from-scratch run after every tick (seed ${seed})`, () => {
      const { runtime, counts } = runLaws(seed, 220)
      // Every kind of change happened, and every view is maintained (not a fallback).
      expect(Object.keys(counts).length).toBeGreaterThan(15)
      expect(runtime.views.all().filter((v) => v.strategy !== 'incremental').map((v) => v.iri)).toEqual([])
      for (const name of Object.keys(LAW_VIEWS)) expect(runtime.views.view(V + name), name).toBeDefined()
    }, 120_000)
  }

  it('on Semblance’s own engine too (wat)', () => {
    const { runtime } = runLaws(4, 200, 'wat')
    expect(runtime.views.all().filter((v) => v.strategy !== 'incremental')).toEqual([])
  }, 120_000)

  it('writes a materialized SELECT’s rows as a result set, with positions', () => {
    const { store, runtime } = lawRuntime()
    const f = store.factory
    const nn = (s: string) => f.namedNode(V + s)
    const int = (n: number) => f.literal(String(n), f.namedNode(NS.xsd + 'integer'))
    runtime.transaction(() => {
      for (const [m, x] of [['a', 5], ['b', 9], ['c', 1], ['d', 7]] as const) runtime.apply({ remove: [], add: [f.quad(nn('s'), f.namedNode(LDES.member), nn(m)), f.quad(nn(m), nn('x'), int(x))] })
    })
    const RS = 'http://www.w3.org/2001/sw/DataAccess/tests/result-set#'
    const rows = () =>
      store
        .select(`PREFIX rs: <${RS}> SELECT ?i ?m WHERE { <${V}rows> rs:solution ?r . ?r rs:index ?i ; rs:binding [ rs:variable "m" ; rs:value ?m ] } ORDER BY ?i`, [f.namedNode('urn:semblance:views')])
        .map((r) => `${r.get('i')!.value} ${r.get('m')!.value.replace(V, '')}`)
    expect(rows()).toEqual(['1 b', '2 d', '3 a'])
    // A new first row moves the others down; the last falls out.
    runtime.apply({ remove: [], add: [f.quad(nn('s'), f.namedNode(LDES.member), nn('e')), f.quad(nn('e'), nn('x'), int(8))] })
    expect(rows()).toEqual(['1 b', '2 e', '3 d'])
  })

  it('a parameter on LIMIT moves the window in place', () => {
    const { store, runtime } = lawRuntime()
    const f = store.factory
    const nn = (s: string) => f.namedNode(V + s)
    const int = (n: number) => f.literal(String(n), f.namedNode(NS.xsd + 'integer'))
    runtime.transaction(() => {
      for (let i = 0; i < 8; i++) runtime.apply({ remove: [], add: [f.quad(nn('s'), f.namedNode(LDES.member), nn('m' + i)), f.quad(nn('m' + i), nn('x'), int(i))] })
    })
    const paged = runtime.views.view(V + 'paged')!
    expect(paged.rows()).toHaveLength(2) // iv:default
    const partitions = runtime.views.totals.partitions
    runtime.apply({ remove: [], add: [f.quad(nn('cfg'), nn('limit'), int(5))] })
    expect(paged.rows()).toHaveLength(5)
    // No partition was evaluated again: the top-k holds every candidate.
    expect(runtime.views.totals.partitions).toBe(partitions)
    expect(runtime.views.view(V + 'paged')).toBe(paged)
  })

  it('a parameter in the body retunes in place: a pattern’s constant re-evaluates what it matches, a FILTER’s every partition', () => {
    const { store, runtime } = lawRuntime()
    const f = store.factory
    const nn = (s: string) => f.namedNode(V + s)
    const int = (n: number) => f.literal(String(n), f.namedNode(NS.xsd + 'integer'))
    runtime.transaction(() => {
      for (let i = 0; i < 40; i++) runtime.apply({ remove: [], add: [f.quad(nn('s'), f.namedNode(LDES.member), nn('m' + i)), f.quad(nn('m' + i), nn('x'), int(i % 10)), f.quad(nn('m' + i), nn('kind'), nn('K' + (1 + (i % 4))))] })
    })
    const kinded = runtime.views.view(V + 'kinded')!
    const atLeast = runtime.views.view(V + 'atLeast')!
    expect(kinded.rows()).toHaveLength(10)
    const before = kinded.figures.partitions
    runtime.apply({ remove: [], add: [f.quad(nn('cfg'), nn('kind'), nn('K2'))] })
    // The same view, its K1 and K2 members evaluated again (and the strict check passed).
    expect(runtime.views.view(V + 'kinded')).toBe(kinded)
    expect(kinded.rows().map((r) => r.get('m')!.value.replace(V, '')).sort()).toEqual(['m1', 'm13', 'm17', 'm21', 'm25', 'm29', 'm33', 'm37', 'm5', 'm9'])
    expect(kinded.figures.partitions - before).toBeLessThanOrEqual(21)
    runtime.apply({ remove: [], add: [f.quad(nn('cfg'), nn('min'), int(7))] })
    expect(runtime.views.view(V + 'atLeast')).toBe(atLeast)
    expect(atLeast.rows().map((r) => r.get('x')!.value)).toEqual(['7', '7'])
  })

  it('a view per instance (iv:targets) comes and goes with its instance', () => {
    const { store, runtime } = lawRuntime()
    const f = store.factory
    const nn = (s: string) => f.namedNode(V + s)
    const instance = (t: string) => runtime.views.view(runtime.views.instanceOf(V + 'perTarget', V + t))
    expect(instance('T7')).toBeUndefined()
    runtime.apply({ remove: [], add: [f.quad(nn('T7'), f.namedNode(NS.rdf + 'type'), nn('Target')), f.quad(nn('s'), f.namedNode(LDES.member), nn('q')), f.quad(nn('q'), nn('target'), nn('T7'))] })
    expect(instance('T7')!.rows().map((r) => r.get('n')!.value)).toEqual(['1'])
    runtime.apply({ add: [], remove: [f.quad(nn('T7'), f.namedNode(NS.rdf + 'type'), nn('Target'))] })
    expect(instance('T7')).toBeUndefined()
  })

  it('a view per referrer (iv:perReferrer) comes and goes with the node naming it, its rows under that node', () => {
    const { store, runtime } = lawRuntime()
    const f = store.factory
    const nn = (s: string) => f.namedNode(V + s)
    const instance = (a: string) => runtime.views.view(runtime.views.instanceOf(V + 'perAsker', V + a))
    runtime.transaction(() => {
      for (const [m, t] of [['p', 'T1'], ['q', 'T1'], ['r', 'T2']]) runtime.apply({ remove: [], add: [f.quad(nn('s'), f.namedNode(LDES.member), nn(m!)), f.quad(nn(m!), nn('target'), nn(t!))] })
    })
    expect(instance('B1')).toBeUndefined()
    runtime.apply({ remove: [], add: [f.quad(nn('B1'), nn('asks'), nn('perAsker')), f.quad(nn('B1'), nn('about'), nn('T1'))] })
    expect(instance('B1')!.rows().map((r) => r.get('n')!.value)).toEqual(['2'])
    // Its rows are a result set minted under the node that asks.
    const RS = 'http://www.w3.org/2001/sw/DataAccess/tests/result-set#'
    const rows = store.match(f.namedNode(runtime.views.instanceOf(V + 'perAsker', V + 'B1')), f.namedNode(RS + 'solution'), null)
    expect(rows.map((q) => q.object.value.startsWith(V + 'B1/~'))).toEqual([true])
    // A second asker is a view of its own; the first is not rebuilt.
    const rebuilds = runtime.views.totals.rebuilds
    runtime.apply({ remove: [], add: [f.quad(nn('B2'), nn('asks'), nn('perAsker')), f.quad(nn('B2'), nn('about'), nn('T2'))] })
    expect(instance('B2')!.rows().map((r) => r.get('n')!.value)).toEqual(['1'])
    expect(runtime.views.totals.rebuilds).toBe(rebuilds)
    // What it asks about is a triple its query reads: maintained, not redefined.
    runtime.apply({ remove: store.match(nn('B1'), nn('about'), null), add: [f.quad(nn('B1'), nn('about'), nn('T2'))] })
    expect(instance('B1')!.rows().map((r) => r.get('n')!.value)).toEqual(['1'])
    runtime.apply({ add: [], remove: [f.quad(nn('B1'), nn('asks'), nn('perAsker'))] })
    expect(instance('B1')).toBeUndefined()
    expect(instance('B2')).toBeDefined()
  })
})

describe('maintained views: work follows the change, not the data', () => {
  /** A graph of `n` members over five targets, plus three members of a target of their own (T9). */
  function sized(n: number) {
    const { store, runtime } = lawRuntime()
    runtime.views.strict = false
    const f = store.factory
    const nn = (s: string) => f.namedNode(V + s)
    const int = (x: number) => f.literal(String(x), f.namedNode(NS.xsd + 'integer'))
    const label = f.namedNode(NS.rdfs + 'label')
    runtime.transaction(() => {
      for (const t of ['T1', 'T2', 'T3', 'T4', 'T5', 'T9']) runtime.apply({ remove: [], add: [f.quad(nn(t), label, f.literal('label ' + t)), f.quad(nn(t), nn('group'), nn('G2'))] })
      for (let i = 0; i < n; i++) runtime.apply({ remove: [], add: [f.quad(nn('s'), f.namedNode(LDES.member), nn('m' + i)), f.quad(nn('m' + i), nn('x'), int(i % 50)), f.quad(nn('m' + i), nn('kind'), nn('K2')), f.quad(nn('m' + i), nn('target'), nn('T' + (1 + (i % 5))))] })
      for (let i = 0; i < 3; i++) runtime.apply({ remove: [], add: [f.quad(nn('s'), f.namedNode(LDES.member), nn('own' + i)), f.quad(nn('own' + i), nn('x'), int(i)), f.quad(nn('own' + i), nn('kind'), nn('K2')), f.quad(nn('own' + i), nn('target'), nn('T9'))] })
    })
    const t = runtime.views.totals
    const snap = () => ({ partitions: t.partitions, rows: t.rowsIn, rebuilds: t.rebuilds })
    const diff = (a: ReturnType<typeof snap>) => ({ partitions: t.partitions - a.partitions, rows: t.rowsIn - a.rows, rebuilds: t.rebuilds - a.rebuilds })
    const measure = (change: () => void) => {
      const a = snap()
      change()
      return diff(a)
    }
    return {
      // A join outside the member: T9's label, read by its three members.
      label: measure(() => runtime.apply({ remove: store.match(nn('T9'), label, null), add: [f.quad(nn('T9'), label, f.literal('renamed'))] })),
      // Negation: T9 hidden flips EXISTS and NOT EXISTS for its three members.
      hidden: measure(() => runtime.apply({ remove: [], add: [f.quad(nn('T9'), nn('hidden'), f.literal('true', f.namedNode(NS.xsd + 'boolean')))] })),
      // MINUS: T9 moves into the group the MINUS removes.
      minus: measure(() => runtime.apply({ remove: store.match(nn('T9'), nn('group'), null), add: [f.quad(nn('T9'), nn('group'), nn('G1'))] })),
      // A new member at the top of the top-k, and one that does not reach it.
      top: measure(() => runtime.apply({ remove: [], add: [f.quad(nn('s'), f.namedNode(LDES.member), nn('new1')), f.quad(nn('new1'), nn('x'), int(99)), f.quad(nn('new1'), nn('target'), nn('T9'))] })),
      below: measure(() => runtime.apply({ remove: [], add: [f.quad(nn('s'), f.namedNode(LDES.member), nn('new2')), f.quad(nn('new2'), nn('x'), int(-5)), f.quad(nn('new2'), nn('target'), nn('T9'))] })),
    }
  }

  it('joins, negation and top-k cost the same over 200 members as over 2,000', () => {
    const small = sized(200)
    const large = sized(2000)
    process.stderr.write(`[view-laws cost] 200: ${JSON.stringify(small)}\n[view-laws cost] 2000: ${JSON.stringify(large)}\n`)
    expect(large).toEqual(small)
    // None of them rebuilt a view; each touched a few partitions per view.
    for (const m of Object.values(small)) {
      expect(m.rebuilds).toBe(0)
      expect(m.partitions).toBeLessThan(120)
    }
  }, 300_000)
})
