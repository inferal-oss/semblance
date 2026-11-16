// A view of one triple pattern under DISTINCT is a scan (docs/IVM.md, iv:Scan): the triples that change
// give its rows, nothing is evaluated, and it equals a from-scratch run of its query after every tick
// (strict), whichever graph a triple is in and whatever IRI it holds. Around it: an event's own triples
// reach the tick, iv:whileShown counts a subclass's instances, and a change of any size fits the runtime.
import { describe, expect, it } from 'vitest'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { NS, PERF_GRAPH } from '../src/ns.ts'
import { Runtime } from '../src/runtime.ts'
import { ManualClock } from '../src/view/runtime.ts'
import { mountShell } from './harness.ts'

const V = 'https://example.org/scan#'

const views = `
@prefix v: <${V}> .
@prefix sem: <https://semblance.dev/ns/core#> .
@prefix iv: <https://semblance.dev/ns/view#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

v:prefixes sh:declare [ sh:prefix "v" ; sh:namespace "${V}"^^xsd:anyURI ] .
v:predicates a iv:View ; iv:materialize iv:Graph ; sem:select "SELECT DISTINCT ?p WHERE { ?s ?p ?o }" .
v:objects a iv:View ; sem:select "SELECT DISTINCT ?s ?o WHERE { ?s v:p ?o }" .
v:joined a iv:View ; sem:select "SELECT DISTINCT ?s WHERE { ?s v:r ?o . ?o v:q ?x }" .
v:Base a rdfs:Class .
v:Sub rdfs:subClassOf v:Base .
v:i a v:Sub .
v:shownWithBase a iv:View ; iv:whileShown v:Base ; sem:select "SELECT DISTINCT ?s WHERE { ?s v:q ?o }" .
`

function runtimeOn(kind: StoreKind) {
  const store = loadStore(kind, views)
  const runtime = new Runtime(store)
  runtime.views.clock = new ManualClock()
  runtime.views.strict = true
  runtime.views.shown = () => true
  runtime.views.start('sparql')
  const f = store.factory
  const nn = (s: string) => f.namedNode(V + s)
  return { store, runtime, f, nn }
}

describe('a view of one triple pattern is a scan', () => {
  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`evaluates nothing as triples come and go, in any graph (${kind})`, () => {
      const { runtime, f, nn } = runtimeOn(kind)
      const rows = (name: string, v: string) => runtime.views.view(V + name)!.rows().map((r) => r.get(v)!.value)
      const partitions = runtime.views.totals.partitions
      const a = f.quad(nn('a'), nn('p'), nn('b'))
      runtime.apply({ add: [a], remove: [] })
      expect(rows('predicates', 'p')).toContain(V + 'p')
      // In another graph too: the row stays until the last triple that gives it goes.
      runtime.write(PERF_GRAPH, { add: [a], remove: [] })
      runtime.apply({ add: [], remove: [a] })
      expect(rows('predicates', 'p')).toContain(V + 'p')
      runtime.write(PERF_GRAPH, { add: [], remove: [a] })
      expect(rows('predicates', 'p')).not.toContain(V + 'p')
      expect(rows('objects', 'o')).toEqual([])
      expect(runtime.views.totals.partitions).toBe(partitions)
      // A pattern joined with another still evaluates its partitions.
      runtime.apply({ add: [f.quad(nn('a'), nn('r'), nn('b')), f.quad(nn('b'), nn('q'), nn('c'))], remove: [] })
      expect(rows('joined', 's')).toEqual([V + 'a'])
      expect(runtime.views.totals.partitions).toBeGreaterThan(partitions)
    })

  }

  it('holds an IRI that query text could not (wat)', () => {
    const { runtime, f, nn } = runtimeOn('wat')
    const bad = f.namedNode(V + 'bad%E0%A4%A')
    runtime.apply({ add: [f.quad(nn('a'), nn('p'), bad)], remove: [] })
    expect(runtime.views.view(V + 'objects')!.rows().map((r) => r.get('o')!.value)).toEqual([bad.value])
  })

  it('says so in its plan', () => {
    const { store, f, nn } = runtimeOn('oxigraph')
    const kinds = (name: string) => store.match(nn(name), f.namedNode(NS.iv + 'operator'), null).flatMap((op) => store.match(op.object as never, f.namedNode(NS.iv + 'kind'), null)).map((q) => q.object.value.replace(NS.iv, ''))
    expect(kinds('objects')).toContain('Scan')
    expect(kinds('objects')).not.toContain('Partition')
    expect(kinds('joined')).toContain('Partition')
  })
})

describe('around it', () => {
  it('a change larger than a call can take arguments fits', () => {
    const { store, runtime, f, nn } = runtimeOn('oxigraph')
    const n = 70_000
    const p = (i: number) => nn('p' + i)
    // Each predicate is a row of the materialized view: several triples each, in one sink.
    runtime.transaction(() => runtime.apply({ add: Array.from({ length: n }, (_, i) => f.quad(nn('a'), p(i), nn('b'))), remove: [] }))
    expect(runtime.views.view(V + 'predicates')!.rows().length).toBeGreaterThanOrEqual(n)
    expect(store.match(nn('predicates'), f.namedNode('http://www.w3.org/2001/sw/DataAccess/tests/result-set#solution'), null).length).toBeGreaterThanOrEqual(n)
  }, 120_000)

  it('iv:whileShown counts the instances of a subclass', () => {
    const { runtime } = runtimeOn('oxigraph')
    const view = () => runtime.views.view(V + 'shownWithBase') as unknown as { suspended: boolean }
    expect(view().suspended).toBe(false)
    runtime.views.shown = (c) => c === V + 'other'
    runtime.advance()
    expect(view().suspended).toBe(true)
    runtime.views.shown = (c) => c === V + 'i'
    runtime.views.resume()
    expect(view().suspended).toBe(false)
  })

  it('the term views wait for an editor', () => {
    const h = mountShell(5, 'wat', 'sparql')
    h.runtime.advance()
    for (const name of ['DeclaredTerms', 'UsedClasses', 'UsedProperties']) expect((h.runtime.views.view(NS.c + name) as unknown as { suspended: boolean }).suspended, name).toBe(true)
  }, 120_000)

  it('given a deadline, hidden views are rebuilt a view at a time, and what a person shows all at once (#421)', () => {
    const h = mountShell(5, 'wat', 'sparql')
    h.runtime.advance()
    const views = (h.runtime.views as unknown as { views: Map<string, { suspended: boolean }> }).views
    const suspended = () => [...views.values()].filter((v) => v.suspended).length
    const before = suspended()
    expect(before).toBeGreaterThanOrEqual(3)
    h.runtime.views.shown = () => true
    // A deadline already past: one view, and the rest are left for the next step.
    h.runtime.views.resume(0)
    expect(suspended()).toBe(before - 1)
    expect(h.runtime.views.resumeLeft).toBe(true)
    h.runtime.views.resume(0)
    expect(suspended()).toBe(before - 2)
    // No deadline: all that is left.
    h.runtime.views.resume()
    expect(suspended()).toBe(0)
    expect(h.runtime.views.resumeLeft).toBe(false)
  }, 120_000)

  it('an event’s own triples reach the views, as they arrive and as they retire', () => {
    const h = mountShell(5, 'oxigraph', 'sparql')
    const { document, store, fire } = h
    const f = store.factory
    const policy = f.namedNode(NS.beh + 'ChangeLogRetention')
    h.runtime.apply({ remove: store.match(policy, f.namedNode(NS.ldes + 'amount'), null), add: [f.quad(policy, f.namedNode(NS.ldes + 'amount'), f.literal('3', f.namedNode(NS.xsd + 'integer')))] })
    h.runtime.load(`<${V}eventsByTarget> a <${NS.iv}View> ; <${NS.sem}select> "SELECT DISTINCT ?e WHERE { ?e <${NS.beh}target> ?t }" .`)
    h.runtime.views.strict = true
    const view = h.runtime.views.view(V + 'eventsByTarget')!
    const box = () => document.querySelector('[data-sem-c=list-item] input') as HTMLInputElement
    for (let i = 0; i < 6; i++) {
      box().checked = !box().checked
      fire(box(), 'change')
    }
    expect(view.rows().length).toBeGreaterThan(0)
    expect(view.rows().length).toBeLessThanOrEqual(3)
  }, 120_000)
})
