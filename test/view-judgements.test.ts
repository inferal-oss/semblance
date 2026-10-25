// Judgements as maintained findings (docs/IVM.md §21): the performance page's perf:Judgement
// CONSTRUCTs as views, kept up to date while a benchmark's observations arrive a few triples at a
// time - each equal to a from-scratch run of its query after every step (strict), on Oxigraph and
// on Semblance's own engine. Their aggregate subqueries (the best and worst per size, the largest
// size, sums per size) are parts of their own: a new observation re-evaluates the findings it can
// change, not the judgement.
import type { Quad } from '@rdfjs/types'
import { readFileSync } from 'node:fs'
import { Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { observationsTurtle } from '../bench/observations.ts'
import { CONFIGS, type Row } from '../bench/scenarios.ts'
import { loadStore } from '../src/node/load.ts'
import { NS, PERF_GRAPH } from '../src/ns.ts'
import { Runtime } from '../src/runtime.ts'
import { rng } from './view-laws.ts'

const PERF = 'https://semblance.dev/ns/perf#'
const perfOntology = readFileSync(new URL('../ontology/perf/perf.ttl', import.meta.url), 'utf8')
const JUDGEMENTS = ['FastestInitialRender', 'FrameBudget', 'StoreEffect', 'RulesEffect', 'BulkEffect', 'Scaling', 'DomShare', 'CompiledEffect']
const SCENARIOS = ['initial render', 'toggle item', 'reorder item', 'type in field']

function observations(configs: number, seed: number): Quad[] {
  const r = rng(seed)
  const rows: Row[] = CONFIGS.slice(0, configs).flatMap((c) =>
    [100, 1000].flatMap((size) => SCENARIOS.map((scenario) => ({ env: 'node', config: c.id, size, scenario, engineMs: 1 + r() * 3 * (size / 100), domMs: r() * 3, ruleRuns: 1, derived: 1 }))),
  )
  return new Parser().parse(observationsTurtle(rows, CONFIGS.slice(0, configs))) as unknown as Quad[]
}

function judged(kind: 'oxigraph' | 'wat', configs: number) {
  const store = loadStore(kind, perfOntology, JUDGEMENTS.map((j) => `<${PERF}${j}> a <${NS.iv}View> .`).join('\n'))
  const runtime = new Runtime(store)
  runtime.views.strict = true
  runtime.views.start('sparql')
  return { store, runtime }
}

describe('judgements as maintained findings', () => {
  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`keeps every judgement’s findings as observations arrive, equal to a from-scratch run after each step (${kind})`, () => {
      const { runtime } = judged(kind, 16)
      for (const j of JUDGEMENTS) expect(runtime.views.view(PERF + j)?.strategy, j).toBe('incremental')
      const r = rng(3)
      const order = observations(16, 7).map((q) => [r(), q] as const).sort((a, b) => a[0] - b[0]).map(([, q]) => q)
      const t = runtime.views.totals
      const before = t.partitions
      let steps = 0
      for (let i = 0; i < order.length; i += 7, steps++) {
        runtime.write(PERF_GRAPH, { add: order.slice(i, i + 7), remove: [] })
        // Now and then a few observations are withdrawn and come back.
        if (r() < 0.1) {
          const back = order.slice(Math.floor(r() * i), Math.floor(r() * i) + 3)
          runtime.write(PERF_GRAPH, { remove: back, add: [] })
          runtime.write(PERF_GRAPH, { add: back, remove: [] })
        }
      }
      // Every judgement found something.
      for (const j of JUDGEMENTS) expect(runtime.views.view(PERF + j)!.quads().length, j).toBeGreaterThan(0)
      // Only the first observation of a kind reaches every partition (an aggregate's value appearing);
      // a step re-evaluates the findings of the configurations and sizes it measures - a few dozen
      // partitions over all eight judgements - not the run's 1,600 triples.
      expect(t.rebuilds).toBeLessThanOrEqual(4)
      expect((t.partitions - before) / steps).toBeLessThan(80)
    }, 300_000)
  }
})
