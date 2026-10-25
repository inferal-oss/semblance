// Charts and tables over maintained views (docs/IVM.md §21): the performance page's SELECTs
// (perf:View) as views whose rows are a result set in the views graph, kept up to date as a
// benchmark's observations arrive one by one - each equal to a from-scratch run of its query,
// positions included (strict) - and read by the chart rules instead of running the SELECT.
import type { Quad } from '@rdfjs/types'
import { readFileSync } from 'node:fs'
import { Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { observationsTurtle } from '../bench/observations.ts'
import type { Row } from '../bench/scenarios.ts'
import { createContext } from '../src/engine/context.ts'
import { loadStore } from '../src/node/load.ts'
import { NS, PERF_GRAPH } from '../src/ns.ts'
import { Runtime } from '../src/runtime.ts'
import { maintainedRows } from '../src/view/rows.ts'
import { VIEW_GRAPH } from '../src/view/runtime.ts'
import { rng } from './view-laws.ts'

const PERF = 'https://semblance.dev/ns/perf#'
const perfOntology = readFileSync(new URL('../ontology/perf/perf.ttl', import.meta.url), 'utf8')
const VIEWS = ['InitialRenderView', 'UpdateMixView', 'UpdateMatrixView', 'ScalingView']

function observations(): Quad[] {
  const configs = ['oxigraph · sparql · bulk', 'hybrid · function', 'n3 · function']
  const rows: Row[] = configs.flatMap((config, c) =>
    [100, 1000].flatMap((size, i) => [
      { env: 'browser', config, size, scenario: 'initial render', engineMs: 10 + c * 7 + i * 40, domMs: 3 + i, ruleRuns: 1, derived: 1 },
      { env: 'browser', config, size, scenario: 'reorder item', engineMs: 1 + c + i * 5, domMs: 0.5, ruleRuns: 1, derived: 1 },
      { env: 'browser', config, size, scenario: 'toggle item', engineMs: 0.2 * (c + 1), domMs: 0.01, ruleRuns: 1, derived: 1 },
    ]),
  )
  return new Parser().parse(observationsTurtle(rows)) as unknown as Quad[]
}

describe('charts and tables over maintained views', () => {
  it('keeps the performance page’s views as observations arrive, equal to a from-scratch run after each', () => {
    const store = loadStore('oxigraph', perfOntology, VIEWS.map((v) => `<${PERF}${v}> a <${NS.iv}View> ; <${NS.iv}materialize> <${NS.iv}Graph> .`).join('\n'))
    const runtime = new Runtime(store)
    runtime.views.strict = true
    runtime.views.start('sparql')
    for (const v of VIEWS) expect(runtime.views.view(PERF + v)?.strategy, v).toBe('incremental')
    // The observations arrive in a random order, a few triples at a time; some are withdrawn and come back.
    const quads = observations()
    const r = rng(11)
    const order = quads.map((q) => [r(), q] as const).sort((a, b) => a[0] - b[0]).map(([, q]) => q)
    const partitions = runtime.views.totals.partitions
    for (let i = 0; i < order.length; i += 5) {
      runtime.write(PERF_GRAPH, { add: order.slice(i, i + 5), remove: [] })
      if (r() < 0.2) {
        const back = order.slice(Math.floor(r() * i), Math.floor(r() * i) + 3)
        runtime.write(PERF_GRAPH, { remove: back, add: [] })
        runtime.write(PERF_GRAPH, { add: back, remove: [] })
      }
    }
    // Each step re-evaluated the configurations it measured, not the page.
    expect(runtime.views.totals.rebuilds).toBe(0)
    expect((runtime.views.totals.partitions - partitions) / (order.length / 5)).toBeLessThan(20)
    // What a chart reads: the rows, in the SELECT's order, as the SELECT gives them.
    const ctx = createContext(store, [store.factory.defaultGraph(), store.factory.namedNode(PERF_GRAPH), store.factory.namedNode(VIEW_GRAPH)], '')
    const text = (rows: Map<string, import('@rdfjs/types').Term>[]) => rows.map((row) => [...row].map(([k, t]) => `${k}=${t.value}`).sort().join(' '))
    for (const v of VIEWS) {
      const select = store.match(store.factory.namedNode(PERF + v), store.factory.namedNode(NS.sem + 'select'), null)[0]!.object.value
      const fromScratch = text(runtime.views.runner().select(select))
      expect(text(maintainedRows(ctx, store.factory.namedNode(PERF + v))!), v).toEqual(fromScratch)
    }
  }, 120_000)
})
