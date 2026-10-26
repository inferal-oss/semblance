// A rule maintained as a view (iv:strategy iv:Incremental, docs/IVM.md §10.1 step 3): its query is
// a view partitioned by its focus, and the engine reads each focus's output from it - no query per
// change, the same output as evaluating the rule, and an item added to a list of 200 or of 2,000
// costs the same.
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS } from '../src/ns.ts'
import { Runtime } from '../src/runtime.ts'

const X = 'https://example.org/inc#'

const rules = (incremental: boolean) => `
@prefix x: <${X}> .
@prefix sem: <https://semblance.dev/ns/core#> .
@prefix iv: <https://semblance.dev/ns/view#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
x:prefixes sh:declare [ sh:prefix "x" ; sh:namespace "${X}"^^xsd:anyURI ] .
x:SummaryRule a sem:Rule ; sem:targets x:Summary ; sem:stratum 0 ;${incremental ? ' iv:strategy iv:Incremental ;' : ''}
    sem:construct """CONSTRUCT { ?root x:count ?n ; x:top ?top } WHERE {
  $this x:of ?list .
  { SELECT ?list (COUNT(?i) AS ?n) (MAX(?score) AS ?top) WHERE { ?list x:item ?i . ?i x:score ?score } GROUP BY ?list }
  BIND(IRI(CONCAT(STR($this), "/~root")) AS ?root)
}""" .
x:s1 a x:Summary ; x:of x:list1 .
x:s2 a x:Summary ; x:of x:list2 .
x:s3 a x:Summary ; x:of x:list1 .
`

function setup(n: number, incremental: boolean) {
  const items = Array.from({ length: n }, (_, i) => `x:list${1 + (i % 2)} x:item x:i${i} . x:i${i} x:score ${i % 97} .`).join('\n')
  const store = loadStore('oxigraph', rules(incremental), `@prefix x: <${X}> .\n${items}`)
  const runtime = new Runtime(store)
  // The plain rule declares nothing it follows: only exact dependencies (from its patterns) re-run it when an item changes.
  const screen = runtime.project({ modality: MOD.Screen, name: incremental ? 'inc' : 'plain', exactDependencies: !incremental })
  const f = store.factory
  const nn = (s: string) => f.namedNode(X + s)
  const int = (v: number) => f.literal(String(v), f.namedNode(NS.xsd + 'integer'))
  const out = () =>
    store
      .match(null, null, null, screen.engine.graph)
      .filter((q) => q.predicate.value.startsWith(X))
      .map((q) => `${q.subject.value.replace(X, '')} ${q.predicate.value.replace(X, '')} ${q.object.value}`)
      .sort()
  return { store, runtime, screen, f, nn, int, out }
}

describe('rules maintained as views (iv:strategy iv:Incremental)', () => {
  it('gives the same output as evaluating the rule (with exact dependencies), after every change, with no query per change', () => {
    const inc = setup(40, true)
    const plain = setup(40, false)
    expect(inc.out()).toEqual(plain.out())
    expect(inc.out()).toContain('s1/~root count 20')
    const queries = inc.screen.engine.stats.queries
    const steps: ((h: typeof inc) => void)[] = [
      (h) => h.runtime.apply({ remove: [], add: [h.f.quad(h.nn('list1'), h.nn('item'), h.nn('new1')), h.f.quad(h.nn('new1'), h.nn('score'), h.int(500))] }),
      (h) => h.runtime.apply({ remove: h.store.match(h.nn('i3'), h.nn('score'), null), add: [h.f.quad(h.nn('i3'), h.nn('score'), h.int(-4))] }),
      (h) => h.runtime.apply({ remove: [...h.store.match(h.nn('list1'), h.nn('item'), h.nn('new1'))], add: [] }),
      (h) => h.runtime.apply({ remove: h.store.match(h.nn('s2'), h.nn('of'), null), add: [h.f.quad(h.nn('s2'), h.nn('of'), h.nn('list1'))] }),
      (h) => h.runtime.apply({ remove: [], add: [h.f.quad(h.nn('s4'), h.f.namedNode(NS.rdf + 'type'), h.nn('Summary')), h.f.quad(h.nn('s4'), h.nn('of'), h.nn('list2'))] }),
      (h) => h.runtime.apply({ remove: h.store.match(h.nn('s1'), null, null), add: [] }),
    ]
    for (const step of steps) {
      step(inc)
      step(plain)
      expect(inc.out()).toEqual(plain.out())
    }
    // Checked once against an evaluation (one query per focus at the start), then fed by its view.
    expect(inc.screen.engine.stats.queries).toBe(queries)
    expect(inc.screen.engine.stats.maintained).toBeGreaterThan(3)
  })

  it('an item added costs the same over 200 items as over 2,000', () => {
    const cost = (n: number) => {
      const h = setup(n, true)
      const t = h.runtime.views.totals
      const before = { rows: t.rowsIn, partitions: t.partitions, rebuilds: t.rebuilds, queries: h.screen.engine.stats.queries }
      h.runtime.apply({ remove: [], add: [h.f.quad(h.nn('list2'), h.nn('item'), h.nn('extra')), h.f.quad(h.nn('extra'), h.nn('score'), h.int(3))] })
      return { rows: t.rowsIn - before.rows, partitions: t.partitions - before.partitions, rebuilds: t.rebuilds - before.rebuilds, queries: h.screen.engine.stats.queries - before.queries }
    }
    const small = cost(200)
    const large = cost(2000)
    expect(large).toEqual(small)
    expect(small.queries).toBe(0)
    expect(small.rebuilds).toBe(0)
  })
})
