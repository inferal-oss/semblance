// Maintained views over time (docs/IVM.md §7.3-7.4, phase 4): sliding, tumbling and count windows
// on the wall clock, and sliding and tumbling windows on event time (a watermark over numeric
// timestamps, as net:Capture writes them), each equal to a from-scratch run of its own query - the
// window written out as SPARQL at the clock's time - after every tick and after every move of an
// injected clock, under seeded random changes: members arriving out of order, retiring, changing
// their timestamp and their values. And the work: an event, and an expiry, cost the same over 200
// members as over 2,000.
//
// On Oxigraph: Semblance's own engine compares xsd:dateTime coarsely for now (#21).
import type { Quad } from '@rdfjs/types'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { LDES, NS } from '../src/ns.ts'
import { Runtime } from '../src/runtime.ts'
import { ManualClock } from '../src/view/runtime.ts'
import { rng } from './view-laws.ts'

const T = 'https://example.org/time#'
const XSD = NS.xsd

const VIEWS = `
@prefix t: <${T}> .
@prefix sem: <https://semblance.dev/ns/core#> .
@prefix iv: <https://semblance.dev/ns/view#> .
@prefix ldes: <https://w3id.org/ldes#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

t:prefixes sh:declare [ sh:prefix "t" ; sh:namespace "${T}"^^xsd:anyURI ] .
t:s a ldes:EventStream ; ldes:timestampPath t:at .
t:e a ldes:EventStream ; ldes:timestampPath t:started .

t:w30s a iv:SlidingWindow ; iv:range "PT30S"^^xsd:dayTimeDuration .
t:w10s a iv:TumblingWindow ; iv:size "PT10S"^^xsd:dayTimeDuration ; iv:keep 3 ; iv:bucketVariable "bucket" .
t:w1m a iv:TumblingWindow ; iv:size "PT1M"^^xsd:dayTimeDuration .
t:last5 a iv:CountWindow ; ldes:amount 5 .
t:last4 a iv:CountWindow ; ldes:amount 4 .
t:last6 a iv:CountWindow ; ldes:amount 6 .
t:ev5s a iv:SlidingWindow ; iv:range "PT5S"^^xsd:dayTimeDuration ; iv:clock iv:EventTime ; iv:lateness "PT1S"^^xsd:dayTimeDuration .
t:ev2s a iv:TumblingWindow ; iv:size "PT2S"^^xsd:dayTimeDuration ; iv:keep 2 ; iv:bucketVariable "b" ; iv:clock iv:EventTime .

t:slide a iv:View ; iv:window t:w30s ;
    sem:select """SELECT ?k (COUNT(?m) AS ?n) WHERE { t:s tree:member ?m . ?m t:kind ?k } GROUP BY ?k""" .
t:tumble a iv:View ; iv:window t:w10s ;
    sem:select """SELECT ?bucket (COUNT(?m) AS ?n) (MAX(?x) AS ?top) WHERE { t:s tree:member ?m . ?m t:x ?x } GROUP BY ?bucket""" .
t:minute a iv:View ; iv:window t:w1m ;
    sem:select """SELECT (COUNT(?m) AS ?n) (SUM(?x) AS ?sum) WHERE { t:s tree:member ?m . ?m t:x ?x }""" .
t:latest a iv:View ; iv:window t:last5 ;
    sem:select """SELECT ?k (COUNT(?m) AS ?n) WHERE { t:s tree:member ?m . ?m t:kind ?k } GROUP BY ?k""" .
t:latestK1 a iv:View ; iv:window t:last4 ;
    sem:select """SELECT ?m WHERE { t:s tree:member ?m . ?m t:kind t:K1 }""" .
t:latestTop a iv:View ; iv:window t:last6 ;
    sem:select """SELECT ?m ?x WHERE { t:s tree:member ?m . ?m t:x ?x } ORDER BY DESC(?x) ?m LIMIT 2""" .
t:buckets a iv:View ; iv:window t:w10s ;
    sem:construct """CONSTRUCT { ?row t:count ?n ; t:from ?bucket } WHERE {
  { SELECT ?bucket (COUNT(?m) AS ?n) WHERE { t:s tree:member ?m } GROUP BY ?bucket }
  BIND(IRI(CONCAT("urn:bucket:", STR(?bucket))) AS ?row)
}""" .
t:evSlide a iv:View ; iv:window t:ev5s ;
    sem:select """SELECT (COUNT(?m) AS ?n) (MIN(?st) AS ?first) WHERE { t:e tree:member ?m . ?m t:started ?st }""" .
t:evTumble a iv:View ; iv:window t:ev2s ;
    sem:select """SELECT ?b ?k (COUNT(?m) AS ?n) WHERE { t:e tree:member ?m . ?m t:kind ?k } GROUP BY ?b ?k""" .
`

function timeRuntime() {
  const store = loadStore('oxigraph', VIEWS)
  const runtime = new Runtime(store)
  const clock = new ManualClock()
  runtime.views.clock = clock
  runtime.views.strict = true
  runtime.views.shown = () => true
  runtime.views.start('sparql')
  const f = store.factory
  const nn = (s: string) => f.namedNode(T + s)
  const member = f.namedNode(LDES.member)
  const int = (n: number) => f.literal(String(n), f.namedNode(XSD + 'integer'))
  const date = (ms: number) => f.literal(new Date(ms).toISOString(), f.namedNode(XSD + 'dateTime'))
  const dbl = (ms: number) => f.literal(String(ms), f.namedNode(XSD + 'double'))
  /** Every view against a from-scratch run now (strict mode checks after ticks; this also after the clock alone moved). */
  const check = () => {
    for (const v of runtime.views.all()) {
      const problem = (v as unknown as { compare(now: number): string | undefined }).compare(clock.now())
      if (problem) throw new Error(`<${v.iri}> at ${new Date(clock.now()).toISOString()}: ${problem}`)
    }
  }
  return { store, runtime, clock, f, nn, member, int, date, dbl, check }
}

describe('maintained views: windows on an injected clock', () => {
  for (const seed of [11, 12, 13]) {
    it(`every window equals a from-scratch run after every tick and every clock move (seed ${seed})`, () => {
      const { store, runtime, clock, f, nn, member, int, date, dbl, check } = timeRuntime()
      const r = rng(seed)
      const pick = <X>(xs: X[]) => xs[Math.floor(r() * xs.length)]!
      const K = ['K1', 'K2', 'K3']
      const wall: string[] = []
      const events: string[] = []
      let n = 0
      // Event time: milliseconds of a page, arriving roughly in order, some late.
      let pageMs = 1000
      const did: Record<string, number> = {}
      const apply = (name: string, d: { add: Quad[]; remove: Quad[] }) => ((did[name] = (did[name] ?? 0) + 1), runtime.apply(d))
      const ops: [string, number, () => void][] = [
        ['append', 4, () => {
          const m = `m${++n}`
          wall.push(m)
          // Mostly now, sometimes a little behind or ahead of the clock.
          const at = clock.now() - (r() < 0.25 ? Math.floor(r() * 40_000) : 0) + (r() < 0.05 ? 5_000 : 0)
          apply('append', { remove: [], add: [f.quad(nn('s'), member, nn(m)), f.quad(nn(m), nn('at'), date(at)), f.quad(nn(m), nn('kind'), nn(pick(K))), f.quad(nn(m), nn('x'), int(Math.floor(r() * 20)))] })
        }],
        ['retire', 1, () => {
          const m = wall.splice(Math.floor(r() * wall.length), 1)[0]
          if (m) apply('retire', { add: [], remove: [...store.match(nn(m), null, null), ...store.match(null, member, nn(m))] })
        }],
        ['retime', 0.8, () => {
          const m = wall.length ? pick(wall) : undefined
          if (m) apply('retime', { remove: store.match(nn(m), nn('at'), null), add: [f.quad(nn(m), nn('at'), date(clock.now() - Math.floor(r() * 60_000)))] })
        }],
        ['kind', 0.8, () => {
          const m = wall.length ? pick(wall) : undefined
          if (m) apply('kind', { remove: store.match(nn(m), nn('kind'), null), add: [f.quad(nn(m), nn('kind'), nn(pick(K)))] })
        }],
        ['event', 3, () => {
          const m = `e${++n}`
          events.push(m)
          pageMs += Math.floor(r() * 900)
          // Late: started before others that were already captured.
          const started = r() < 0.2 ? pageMs - Math.floor(r() * 4000) : pageMs
          apply('event', { remove: [], add: [f.quad(nn('e'), member, nn(m)), f.quad(nn(m), nn('started'), dbl(started + 0.5)), f.quad(nn(m), nn('kind'), nn(pick(K)))] })
        }],
        ['event gone', 0.6, () => {
          const m = events.splice(Math.floor(r() * events.length), 1)[0]
          if (m) apply('event gone', { add: [], remove: [...store.match(nn(m), null, null), ...store.match(null, member, nn(m))] })
        }],
        ['clock', 2, () => {
          did.clock = (did.clock ?? 0) + 1
          clock.advance(Math.floor(r() * (r() < 0.3 ? 25_000 : 3_000)))
          check()
        }],
      ]
      const total = ops.reduce((a, [, w]) => a + w, 0)
      for (let step = 0; step < 260; step++) {
        let x = r() * total
        const op = ops.find(([, w]) => (x -= w) < 0) ?? ops[0]!
        if (r() < 0.1) {
          runtime.transaction(() => {
            for (let i = 0; i < 2 + Math.floor(r() * 3); i++) (ops.find(([name]) => name !== 'clock' && r() < 0.5) ?? ops[0]!)[2]()
          })
        } else op[2]()
      }
      check()
      expect(Object.keys(did).length).toBe(ops.length)
      expect(runtime.views.all().filter((v) => v.strategy !== 'incremental').map((v) => v.iri)).toEqual([])
      // The windows did something: buckets, a count window that pushes members out, late events.
      expect(runtime.views.view(T + 'tumble')!.rows().length).toBeGreaterThan(0)
    }, 120_000)
  }

  it('a tumbling window: buckets as a column, the oldest leaving when a new one begins', () => {
    const { store, runtime, clock, f, nn, member, int, date } = timeRuntime()
    const start = clock.now() // 2026-01-01T00:00:00Z
    const add = (m: string, at: number, x: number) => runtime.apply({ remove: [], add: [f.quad(nn('s'), member, nn(m)), f.quad(nn(m), nn('at'), date(at)), f.quad(nn(m), nn('x'), int(x))] })
    add('a', start + 1_000, 3)
    add('b', start + 4_000, 5)
    clock.advance(12_000)
    add('c', start + 12_000, 2)
    const rows = () =>
      runtime.views
        .view(T + 'tumble')!
        .rows()
        .map((r) => `${r.get('bucket')!.value.slice(11, 19)} ${r.get('n')!.value} ${r.get('top')!.value}`)
        .sort()
    expect(rows()).toEqual(['00:00:00 2 5', '00:00:10 1 2'])
    // The minute window is one bucket: everything since 00:00:00.
    expect(runtime.views.view(T + 'minute')!.rows().map((r) => r.get('sum')!.value)).toEqual(['10'])
    // At 00:00:30 the bucket of 00:00:00 is the fourth: it leaves on the timer, nothing else does.
    clock.advance(17_999)
    expect(rows()).toEqual(['00:00:00 2 5', '00:00:10 1 2'])
    clock.advance(1)
    expect(rows()).toEqual(['00:00:10 1 2'])
    // The CONSTRUCT over the same window says the same in triples.
    expect(store.match(null, nn('count'), null).map((q) => q.object.value)).toEqual(['1'])
    // And the next minute empties the minute window.
    clock.advance(30_000)
    expect(runtime.views.view(T + 'minute')!.rows().map((r) => r.get('n')!.value)).toEqual(['0'])
  })

  it('a count window: the latest members, whether or not the body has rows for them', () => {
    const { runtime, clock, f, nn, member, date, store } = timeRuntime()
    const add = (m: string, kind: string, dt = 0) => runtime.apply({ remove: [], add: [f.quad(nn('s'), member, nn(m)), f.quad(nn(m), nn('at'), date(clock.now() + dt)), f.quad(nn(m), nn('kind'), nn(kind))] })
    const k1 = () => runtime.views.view(T + 'latestK1')!.rows().map((r) => r.get('m')!.value.replace(T, '')).sort()
    for (const [i, k] of ['K1', 'K2', 'K1', 'K3'].entries()) add('c' + i, k, i)
    expect(k1()).toEqual(['c0', 'c2'])
    // A fifth member pushes c0 out, though it is a K2.
    add('c4', 'K2', 4)
    expect(k1()).toEqual(['c2'])
    // c4 retires: c0 is among the latest four again.
    runtime.apply({ add: [], remove: [...store.match(nn('c4'), null, null), ...store.match(null, member, nn('c4'))] })
    expect(k1()).toEqual(['c0', 'c2'])
    // A late member (older than all) is not among the latest; time alone changes nothing.
    add('old', 'K1', -60_000)
    expect(k1()).toEqual(['c0', 'c2'])
    clock.advance(3_600_000)
    expect(k1()).toEqual(['c0', 'c2'])
  })

  it('event time: the watermark moves with the data, late members are counted, no timer is set', () => {
    const { runtime, clock, f, nn, member, dbl, check } = timeRuntime()
    const add = (m: string, started: number) => runtime.apply({ remove: [], add: [f.quad(nn('e'), member, nn(m)), f.quad(nn(m), nn('started'), dbl(started)), f.quad(nn(m), nn('kind'), nn('K1'))] })
    const n = () => runtime.views.view(T + 'evSlide')!.rows()[0]!.get('n')!.value
    add('p1', 100)
    add('p2', 2_100)
    add('p3', 6_000)
    // Watermark 5,000 (6,000 less a second of lateness): the window reaches back to 0.
    expect(n()).toBe('3')
    add('p4', 7_000)
    // Watermark 6,000: p1 (100) is out.
    expect(n()).toBe('3')
    // A late member inside the window is admitted; one behind it is not.
    add('late1', 4_000)
    add('late2', 200)
    expect(n()).toBe('4')
    // The wall clock does nothing to event time.
    clock.advance(3_600_000)
    expect(n()).toBe('4')
    check()
    const buckets = runtime.views
      .view(T + 'evTumble')!
      .rows()
      .map((r) => `${r.get('b')!.value} ${r.get('n')!.value}`)
      .sort()
    // Watermark 7,000: buckets 4,000 and 6,000 are kept.
    expect(buckets).toEqual(['4000 1', '6000 2'])
  })
})

describe('maintained views: an event and an expiry cost what they change', () => {
  /** `n` members a day old, then twenty in the last minute; the cost of one more, and of one expiry. */
  function sized(n: number) {
    const { runtime, clock, f, nn, member, int, date, dbl } = timeRuntime()
    runtime.views.strict = false
    const start = clock.now()
    runtime.transaction(() => {
      for (let i = 0; i < n; i++) runtime.apply({ remove: [], add: [f.quad(nn('s'), member, nn('old' + i)), f.quad(nn('old' + i), nn('at'), date(start - 86_400_000 + i)), f.quad(nn('old' + i), nn('kind'), nn('K1')), f.quad(nn('old' + i), nn('x'), int(i % 7))] })
      // Captured long ago (page milliseconds), and ten in the last nine seconds of the capture.
      for (let i = 0; i < n; i++) runtime.apply({ remove: [], add: [f.quad(nn('e'), member, nn('eo' + i)), f.quad(nn('eo' + i), nn('started'), dbl(i - n - 100_000)), f.quad(nn('eo' + i), nn('kind'), nn('K1'))] })
      for (let i = 0; i < 10; i++) runtime.apply({ remove: [], add: [f.quad(nn('e'), member, nn('en' + i)), f.quad(nn('en' + i), nn('started'), dbl(i * 1_000)), f.quad(nn('en' + i), nn('kind'), nn('K2'))] })
      for (let i = 0; i < 20; i++) runtime.apply({ remove: [], add: [f.quad(nn('s'), member, nn('new' + i)), f.quad(nn('new' + i), nn('at'), date(start - 20_000 + i * 1_000)), f.quad(nn('new' + i), nn('kind'), nn('K2')), f.quad(nn('new' + i), nn('x'), int(i % 5))] })
    })
    const t = runtime.views.totals
    const measure = (change: () => void) => {
      const a = { partitions: t.partitions, rows: t.rowsIn, rebuilds: t.rebuilds }
      change()
      return { partitions: t.partitions - a.partitions, rows: t.rowsIn - a.rows, rebuilds: t.rebuilds - a.rebuilds }
    }
    return {
      event: measure(() => runtime.apply({ remove: [], add: [f.quad(nn('s'), member, nn('x1')), f.quad(nn('x1'), nn('at'), date(start)), f.quad(nn('x1'), nn('kind'), nn('K3')), f.quad(nn('x1'), nn('x'), int(4))] })),
      // One second later the first of the twenty (at -20 s) is 31 s old: it leaves the sliding window.
      expiry: measure(() => clock.advance(11_001)),
      // The next bucket of ten seconds: the oldest bucket leaves the tumbling window.
      bucket: measure(() => clock.advance(20_000)),
      capture: measure(() => runtime.apply({ remove: [], add: [f.quad(nn('e'), member, nn('ex')), f.quad(nn('ex'), nn('started'), dbl(10_000)), f.quad(nn('ex'), nn('kind'), nn('K2'))] })),
    }
  }

  it('the same over 200 members as over 2,000', () => {
    const small = sized(200)
    const large = sized(2000)
    process.stderr.write(`[view-time cost] 200: ${JSON.stringify(small)}\n[view-time cost] 2000: ${JSON.stringify(large)}\n`)
    expect(large).toEqual(small)
    for (const m of Object.values(small)) {
      expect(m.rebuilds).toBe(0)
      expect(m.partitions).toBeLessThan(20)
    }
  }, 120_000)
})
