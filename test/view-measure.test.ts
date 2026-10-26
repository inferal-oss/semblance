// Phase 5's measure (docs/IVM.md §17, §24): two of the repository's largest SPARQL rules, as they
// were before maintained views took their aggregates and their window - c:StreamStats's rendering
// (aggregates of aggregates over the change log, labels by LATERAL, a rank by pairs) and the data
// grid's window (counts and positions by subqueries, correlated LATERALs, closures, pairs within
// the window) - run as views over a stream that grows, retires, is renamed, sorted, filtered and
// pinned, strict: equal to a from-scratch run of the rule after every step, on Oxigraph and on WAT.
// The stream statistics' work per event does not depend on how many members the log holds.
import type { Quad, Term } from '@rdfjs/types'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { NS } from '../src/ns.ts'
import { Runtime } from '../src/runtime.ts'
import { ManualClock } from '../src/view/runtime.ts'
import { rng } from './view-laws.ts'

const X = 'https://example.org/measure#'
const C = NS.c
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

function measured(kind: 'oxigraph' | 'wat') {
  const store = loadStore(
    kind,
    `@prefix ex: <${X}> . @prefix c: <${C}> . @prefix iv: <${NS.iv}> . @prefix sem: <${NS.sem}> . @prefix ldes: <https://w3id.org/ldes#> .
ex:log a ldes:EventStream ; ldes:sequencePath ex:seq .
ex:stats a c:StreamStats ; c:label "Events" ; c:of ex:log .
ex:grid a c:DataGrid ; c:label "Log" ; c:collection ex:log ; c:pageSize 4 ; c:gridColumns ( ex:col1 ex:col2 ) .
ex:col1 c:label "Name" ; c:cellProperty ex:name .
ex:col2 c:label "Time" ; c:cellAs c:TimeBarCell ; c:startProperty ex:start ; c:endProperty ex:end .
ex:FullStats a iv:View ; iv:targets c:StreamStats ; sem:construct """${fixture('stream-stats-full.rq')}""" .
ex:FullGrid a iv:View ; iv:targets c:DataGrid ; sem:construct """${fixture('grid-window-full.rq')}""" .
`,
  )
  const runtime = new Runtime(store)
  runtime.views.clock = new ManualClock()
  runtime.views.shown = () => true
  runtime.views.strict = true
  runtime.views.start('sparql')
  const f = store.factory
  const nn = (s: string) => f.namedNode(X + s)
  const p = (s: string) => f.namedNode(s.startsWith('http') ? s : X + s)
  const int = (n: number) => f.literal(String(n), f.namedNode(NS.xsd + 'integer'))
  const members: string[] = []
  let n = 0
  const set = (s: string, pred: string, o?: Term) => ({ remove: store.match(nn(s), p(pred), null), add: o ? [f.quad(nn(s), p(pred), o as never)] : [] })
  const append = (r: () => number) => {
    const m = `e${++n}`
    members.push(m)
    const add: Quad[] = [
      f.quad(nn('log'), p(NS.tree + 'member'), nn(m)),
      f.quad(nn(m), p(NS.rdf + 'type'), f.namedNode(NS.beh + (r() < 0.5 ? 'Click' : 'Input'))),
      f.quad(nn(m), p(NS.beh + 'added'), int(Math.floor(r() * 5))),
      f.quad(nn(m), p(NS.beh + 'removed'), int(Math.floor(r() * 3))),
      f.quad(nn(m), p(NS.beh + 'target'), nn(`b${Math.floor(r() * 4)}`)),
      f.quad(nn(m), p('seq'), int(n)),
      f.quad(nn(m), p('name'), f.literal('item ' + Math.floor(r() * 9))),
      f.quad(nn(m), p('start'), int(n * 10)),
      f.quad(nn(m), p('end'), int(n * 10 + Math.floor(r() * 30))),
    ]
    return { remove: [], add }
  }
  const retire = () => {
    const m = members.shift()
    return m ? { remove: [...store.match(nn(m), null, null), ...store.match(null, null, nn(m))], add: [] } : { remove: [], add: [] }
  }
  return { store, runtime, f, nn, p, int, members, set, append, retire, count: () => n }
}

describe('phase 5: the full rules as views', () => {
  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`c:StreamStats's and the grid window's full SPARQL rules match from scratch after every step (${kind})`, () => {
      const m = measured(kind)
      const { runtime, f, nn, int, set, append, retire } = m
      for (const v of ['stats/~view-FullStats', 'grid/~view-FullGrid']) expect(runtime.views.view(X + v)?.strategy, v).toBe('incremental')
      const r = rng(kind === 'wat' ? 2 : 1)
      const bool = (b: boolean) => f.literal(String(b), f.namedNode(NS.xsd + 'boolean'))
      const ops: (() => import('../src/rdf.ts').Delta)[] = [
        () => append(r),
        () => append(r),
        retire,
        () => (m.members.length ? set(m.members[Math.floor(r() * m.members.length)]!, 'name', f.literal('item ' + Math.floor(r() * 9))) : { remove: [], add: [] }),
        () => set(`b${Math.floor(r() * 4)}`, C + 'label', r() < 0.3 ? undefined : f.literal('Button ' + Math.floor(r() * 9))),
        () => set('grid', C + 'sortColumn', r() < 0.3 ? undefined : nn(r() < 0.5 ? 'col1' : 'col2')),
        () => set('grid', C + 'sortDescending', r() < 0.5 ? bool(true) : undefined),
        () => ({
          remove: [...m.store.match(nn('grid'), m.p(C + 'filteredBy'), null), ...m.store.match(nn('tf'), null, null)],
          add: r() < 0.5 ? [] : [f.quad(nn('grid'), m.p(C + 'filteredBy'), nn('tf')), f.quad(nn('tf'), m.p(NS.rdf + 'type'), m.p(C + 'TextFilter')), f.quad(nn('tf'), m.p(C + 'searches'), nn('name')), f.quad(nn('tf'), m.p(C + 'filterText'), f.literal(String(Math.floor(r() * 9))))],
        }),
        () => set('grid', C + 'selectedRow', m.members.length && r() < 0.7 ? nn(m.members[Math.floor(r() * m.members.length)]!) : undefined),
        () => {
          const remove = [...m.store.match(nn('grid'), m.p(C + 'windowEnd'), null), ...m.store.match(nn('grid'), m.p(C + 'followTail'), null)]
          return r() < 0.5 ? { remove, add: [] } : { remove, add: [f.quad(nn('grid'), m.p(C + 'windowEnd'), int(Math.max(1, m.count() - Math.floor(r() * 6)))), f.quad(nn('grid'), m.p(C + 'followTail'), bool(false))] }
        },
      ]
      for (let i = 0; i < 60; i++) runtime.apply(i < 8 ? append(r) : ops[Math.floor(r() * ops.length)]!())
      expect(runtime.views.view(X + 'stats/~view-FullStats')!.quads().length).toBeGreaterThan(20)
      expect(runtime.views.view(X + 'grid/~view-FullGrid')!.quads().length).toBeGreaterThan(20)
    }, 600_000)
  }

  it('the stream statistics cost the same per event over 200 members as over 2,000', () => {
    const per = (size: number) => {
      const m = measured('oxigraph')
      m.runtime.views.strict = false
      // The same ten members first (they retire during the measure), then the log's bulk; the
      // measured events are the same at both sizes.
      const fixed = rng(9)
      const bulk = rng(5)
      m.runtime.transaction(() => {
        for (let i = 0; i < 10; i++) m.runtime.apply(m.append(fixed))
        for (let i = 0; i < size; i++) m.runtime.apply(m.append(bulk))
      })
      const view = m.runtime.views.view(X + 'stats/~view-FullStats')!
      const before = { ...view.figures }
      for (let i = 0; i < 10; i++) m.runtime.transaction(() => (m.runtime.apply(m.append(fixed)), m.runtime.apply(m.retire())))
      return { partitions: view.figures.partitions - before.partitions, rows: view.figures.rowsIn - before.rowsIn, rebuilds: view.figures.rebuilds - before.rebuilds }
    }
    const small = per(200)
    const large = per(2000)
    process.stderr.write(`[view-measure] stream statistics per 10 events: 200: ${JSON.stringify(small)} 2000: ${JSON.stringify(large)}\n`)
    expect(large).toEqual(small)
    expect(small.rebuilds).toBe(0)
  }, 600_000)
})
