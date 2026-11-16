// Maintained views (docs/IVM.md): every view equals a from-scratch evaluation of its own
// query after every tick (the runtime's strict mode checks it against Oxigraph and refuses
// fallbacks), under appends, retirements, members changing in place, transactions and a
// sliding window moved by a hand-driven clock.
import type { Quad } from '@rdfjs/types'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { LDES, NS } from '../src/ns.ts'
import { Runtime } from '../src/runtime.ts'
import { ManualClock, VIEW_GRAPH } from '../src/view/runtime.ts'
import { mountShell } from './harness.ts'

const V = 'https://example.org/v#'

const views = `
@prefix v: <${V}> .
@prefix sem: <https://semblance.dev/ns/core#> .
@prefix iv: <https://semblance.dev/ns/view#> .
@prefix ldes: <https://w3id.org/ldes#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

v:prefixes sh:declare [ sh:prefix "v" ; sh:namespace "${V}"^^xsd:anyURI ] .
v:s a ldes:EventStream ; ldes:timestampPath v:at .
v:t a ldes:EventStream .

v:perKind a iv:View ; sem:select """
SELECT ?kind (COUNT(?m) AS ?n) (SUM(?x) AS ?sum) (AVG(?x) AS ?avg) (MIN(?x) AS ?min) (MAX(?x) AS ?max) (COUNT(DISTINCT ?tag) AS ?tags)
WHERE { v:s tree:member ?m . ?m v:kind ?kind ; v:x ?x . OPTIONAL { ?m v:part ?p . ?p v:tag ?tag } }
GROUP BY ?kind""" .

v:total a iv:View ; sem:select """SELECT (COUNT(*) AS ?rows) (SUM(?x) AS ?sum) (MAX(?at) AS ?latest) WHERE { v:s tree:member ?m . ?m v:x ?x ; v:at ?at }""" .

v:everyStream a iv:View ; sem:construct """
CONSTRUCT { ?s v:size ?n ; v:kinds ?k }
WHERE { { SELECT ?s (COUNT(DISTINCT ?m) AS ?n) (COUNT(DISTINCT ?kind) AS ?k) WHERE { ?s tree:member ?m . OPTIONAL { ?m v:kind ?kind } } GROUP BY ?s } }""" .

v:recent a iv:View ; iv:window v:w ; sem:construct """
CONSTRUCT { ?row v:kindOf ?kind ; v:count ?n }
WHERE {
  { SELECT ?kind (COUNT(?m) AS ?n) WHERE { v:s tree:member ?m . { ?m v:kind ?kind } UNION { ?m v:part/v:tag ?kind } } GROUP BY ?kind }
  BIND(IRI(CONCAT(STR(v:), "row-", ENCODE_FOR_URI(STR(?kind)))) AS ?row)
}""" .
v:w a iv:SlidingWindow ; iv:range "PT10S"^^xsd:dayTimeDuration .
`

/** A seeded PRNG (mulberry32), so a failure replays. */
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function streamRuntime() {
  const store = loadStore('oxigraph', views)
  const runtime = new Runtime(store)
  const clock = new ManualClock()
  runtime.views.clock = clock
  runtime.views.strict = true
  runtime.views.start('sparql')
  const f = store.factory
  const nn = (s: string) => f.namedNode(s)
  const int = (n: number) => f.literal(String(n), nn(NS.xsd + 'integer'))
  const dec = (n: number) => f.literal(n.toFixed(1), nn(NS.xsd + 'decimal'))
  const members: string[] = []
  let n = 0
  const append = (stream: string, kind: string, x: number, decimal: boolean, tag?: string) => {
    const m = `${V}m${++n}`
    const quads: Quad[] = [
      f.quad(nn(V + stream), nn(LDES.member), nn(m)),
      f.quad(nn(m), nn(V + 'kind'), f.literal(kind)),
      f.quad(nn(m), nn(V + 'x'), decimal ? dec(x) : int(x)),
      f.quad(nn(m), nn(V + 'at'), f.literal(new Date(clock.t).toISOString(), nn(NS.xsd + 'dateTime'))),
    ]
    if (tag) quads.push(f.quad(nn(m), nn(V + 'part'), nn(m + '/~p')), f.quad(nn(m + '/~p'), nn(V + 'tag'), f.literal(tag)))
    if (stream === 's') members.push(m)
    runtime.apply({ add: quads, remove: [] })
    return m
  }
  const owned = (m: string) => [...store.match(nn(m), null, null), ...store.match(nn(m + '/~p'), null, null), ...store.match(null, nn(LDES.member), nn(m))]
  const retire = () => {
    const m = members.shift()
    if (m) runtime.apply({ add: [], remove: owned(m) })
  }
  const output = (view: string) => store.match(null, null, null, nn(VIEW_GRAPH)).filter((q) => q.predicate.value.startsWith(V)).map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`).filter((x) => (view === 'recent' ? x.includes('row-') : !x.includes('row-'))).sort()
  return { store, runtime, clock, f, nn, int, members, append, retire, owned, output }
}

describe('maintained views', () => {
  it('equal a from-scratch evaluation after every tick, under random changes', () => {
    const h = streamRuntime()
    const r = rng(7)
    const kinds = ['a', 'b', 'c', 'd']
    for (let step = 0; step < 400; step++) {
      const op = r()
      if (op < 0.4) h.append(r() < 0.9 ? 's' : 't', kinds[Math.floor(r() * kinds.length)]!, Math.floor(r() * 20) - 5, r() < 0.3, r() < 0.4 ? kinds[Math.floor(r() * 4)] : undefined)
      else if (op < 0.55) h.retire()
      else if (op < 0.7 && h.members.length) {
        // A member changes in place: its value, or the tag of a node minted under it.
        const m = h.members[Math.floor(r() * h.members.length)]!
        const old = h.store.match(h.nn(m), h.nn(V + 'x'), null)
        const tag = h.store.match(h.nn(m + '/~p'), h.nn(V + 'tag'), null)
        if (r() < 0.5 || !tag.length) h.runtime.apply({ remove: old, add: [h.f.quad(h.nn(m), h.nn(V + 'x'), h.int(Math.floor(r() * 9)))] })
        else h.runtime.apply({ remove: tag, add: [] })
      } else if (op < 0.85) {
        // One transaction: several appends and a retirement, some cancelling out.
        h.runtime.transaction(() => {
          const m = h.append('s', 'a', 1, false)
          h.append('s', kinds[Math.floor(r() * 4)]!, 2, true, 'b')
          if (r() < 0.5) h.runtime.apply({ add: [], remove: h.owned(m) }), h.members.splice(h.members.indexOf(m), 1)
          h.retire()
        })
      } else h.clock.advance(Math.floor(r() * 4000))
    }
    expect(h.runtime.views.all().filter((v) => v.strategy !== 'incremental')).toEqual([])
    // Grouped and windowed output exists (the test exercised something).
    expect(h.runtime.views.view(V + 'perKind')!.rows().length).toBeGreaterThan(0)
  })

  it('let a sliding window age out on the clock alone, one timer at a time', () => {
    const h = streamRuntime()
    h.append('s', 'a', 1, false)
    h.clock.advance(4000)
    h.append('s', 'a', 1, false)
    h.append('s', 'b', 1, false)
    expect(h.output('recent')).toEqual([`${V}row-a ${V}count 2`, `${V}row-a ${V}kindOf a`, `${V}row-b ${V}count 1`, `${V}row-b ${V}kindOf b`])
    h.clock.advance(7000) // the first member is 11 s old: its timer fires
    expect(h.output('recent')).toEqual([`${V}row-a ${V}count 1`, `${V}row-a ${V}kindOf a`, `${V}row-b ${V}count 1`, `${V}row-b ${V}kindOf b`])
    h.clock.advance(4000)
    expect(h.output('recent')).toEqual([])
    // The other views still hold all three.
    expect(h.runtime.views.view(V + 'total')!.rows()[0]!.get('rows')!.value).toBe('3')
  })

  it('fall back to recomputing what they cannot maintain, and say so', () => {
    const store = loadStore('oxigraph', views, `@prefix v: <${V}> . @prefix iv: <https://semblance.dev/ns/view#> . @prefix sem: <https://semblance.dev/ns/core#> .
v:top a iv:View ; sem:select """SELECT ?m (COUNT(?x) AS ?n) WHERE { v:s tree:member ?m . ?m v:x ?x FILTER(?x < STRLEN(STR(NOW()))) } GROUP BY ?m""" .`)
    const runtime = new Runtime(store)
    runtime.views.start('sparql')
    const top = runtime.views.view(V + 'top')!
    expect(top.strategy).toBe('recompute')
    expect(top.fallback).toMatch(/NOW\(\)/)
    const f = store.factory
    const note = store.match(f.namedNode(V + 'top'), f.namedNode(NS.iv + 'fallback'), null, f.namedNode(VIEW_GRAPH))
    expect(note[0]?.object.value).toMatch(/NOW\(\)/)
    // Still correct: recomputed when its input changes.
    runtime.apply({ add: [f.quad(f.namedNode(V + 's'), f.namedNode(LDES.member), f.namedNode(V + 'q')), f.quad(f.namedNode(V + 'q'), f.namedNode(V + 'x'), f.literal('5', f.namedNode(NS.xsd + 'integer')))], remove: [] })
    expect(top.rows().map((r) => r.get('m')!.value)).toEqual([V + 'q'])
    // Strict (tests, or iv:strategy iv:Incremental): a fallback is an error.
    const strict = new Runtime(loadStore('oxigraph', views, `@prefix v: <${V}> . @prefix iv: <https://semblance.dev/ns/view#> . @prefix sem: <https://semblance.dev/ns/core#> .
v:top a iv:View ; sem:select """SELECT (COUNT(*) AS ?n) WHERE { v:s tree:member ?m BIND(RAND() AS ?r) }""" .`))
    strict.views.strict = true
    expect(() => strict.views.start('sparql')).toThrow(/recomputed from scratch/)
  })

  it('recompile when their query changes', () => {
    const h = streamRuntime()
    h.append('s', 'a', 3, false)
    h.append('s', 'b', 4, false)
    const total = () => h.runtime.views.view(V + 'total')!.rows()[0]!.get('sum')!.value
    expect(total()).toBe('7')
    const q = h.store.match(h.nn(V + 'total'), h.nn(NS.sem + 'select'), null)
    h.runtime.apply({ remove: q, add: [h.f.quad(h.nn(V + 'total'), h.nn(NS.sem + 'select'), h.f.literal('SELECT (SUM(?x) AS ?sum) WHERE { v:s tree:member ?m . ?m v:x ?x ; v:kind "b" }'))] })
    expect(total()).toBe('4')
  })
})

describe('maintained views in the app', () => {
  for (const [kind, prefer] of [
    ['oxigraph', 'sparql'],
    ['hybrid', 'function'],
    ['wat', 'sparql'],
  ] as const) {
    it(`match from-scratch evaluation after every event, retirement included (${kind} + ${prefer})`, () => {
      const h = mountShell(5, kind, prefer)
      const { document, store, fire } = h
      const f = store.factory
      const policy = f.namedNode(NS.beh + 'ChangeLogRetention')
      h.runtime.apply({ remove: store.match(policy, f.namedNode(LDES.amount), null), add: [f.quad(policy, f.namedNode(LDES.amount), f.literal('25', f.namedNode(NS.xsd + 'integer')))] })
      // Strict from here on: every tick is checked against the store's own SPARQL from scratch (function views against their SPARQL).
      h.runtime.views.strict = true
      // (Queries a result view runs on request, c:QueryRuns, are not maintained: they stay as of their run.)
      expect(h.runtime.views.all().filter((v) => v.strategy === 'recompute').map((v) => v.iri)).toEqual([])
      const button = (text: string) => [...document.querySelectorAll('button, [role=tab]')].find((b) => b.textContent!.trim() === text) as HTMLElement
      const field = () => document.querySelector('[data-sem-c=text-field] input') as HTMLInputElement
      fire(button('Activity'), 'click')
      const r = rng(3)
      for (let i = 0; i < 80; i++) {
        const op = r()
        if (op < 0.35) {
          const boxes = document.querySelectorAll('[data-sem-c=list-item] input')
          const box = boxes[Math.floor(r() * boxes.length)] as HTMLInputElement
          box.checked = !box.checked
          fire(box, 'change')
        } else if (op < 0.75) {
          field().value = 'x'.repeat(1 + Math.floor(r() * 6))
          fire(field(), 'input')
        } else if (op < 0.85) fire(button('Add'), 'click')
        else fire(button(['Change log', 'Activity', 'Inspector'][Math.floor(r() * 3)]!), 'click')
      }
      // The Activity view counts what the log holds: the bound.
      expect(document.querySelector('[data-sem-c=stream-stats] dd')!.textContent).toBe('25')
      const stats = h.runtime.views.view(NS.c + 'StreamTotals')!
      // Maintained while the Activity view is shown (iv:whileShown), rebuilt when it is shown again.
      expect(stats.figures.ticks).toBeGreaterThan(10)
    }, 120_000)
  }

  it('an event is one tick: its state change and its log member reach the projection together', () => {
    const h = mountShell(5)
    let calls = 0
    const process = h.screen.engine.process.bind(h.screen.engine)
    h.screen.engine.process = (d) => (calls++, process(d))
    const box = h.document.querySelector('[data-sem-c=list-item] input') as HTMLInputElement
    box.checked = !box.checked
    h.fire(box, 'change')
    expect(calls).toBe(1)
  })
})
