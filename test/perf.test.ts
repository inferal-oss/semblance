import { readFileSync } from 'node:fs'
import * as ox from 'oxigraph'
import { describe, expect, it } from 'vitest'
import { judge, observationsTurtle, select, views } from '../bench/observations.ts'
import { CONFIGS, type Row } from '../bench/scenarios.ts'
import { oxigraphStore } from '../src/store/oxigraph.ts'

const perfOntology = readFileSync(new URL('../ontology/perf/perf.ttl', import.meta.url), 'utf8')

// A small synthetic matrix shaped like the browser results.
const initial: Record<string, [number, number]> = {
  'oxigraph · sparql · bulk': [47, 493],
  'oxigraph · sparql · per-focus': [66, 598],
  'oxigraph · function': [48, 470],
  'hybrid · sparql · bulk': [24, 186],
  'hybrid · function': [23, 133],
  'n3 · function': [14, 64],
}
const reorder: Record<string, [number, number]> = {
  'oxigraph · sparql · bulk': [4.8, 56],
  'oxigraph · sparql · per-focus': [4.8, 58],
  'oxigraph · function': [4.5, 55],
  'hybrid · sparql · bulk': [0.8, 3.4],
  'hybrid · function': [0.6, 3.1],
  'n3 · function': [0.6, 3.2],
}
const rows: Row[] = Object.keys(initial).flatMap((config) =>
  [100, 1000].flatMap((size, i) => [
    { env: 'browser', config, size, scenario: 'initial render', engineMs: initial[config]![i]!, domMs: 1, ruleRuns: 1, derived: 1 },
    { env: 'browser', config, size, scenario: 'reorder item', engineMs: reorder[config]![i]!, domMs: 0.5, ruleRuns: 1, derived: 1 },
    { env: 'browser', config, size, scenario: 'toggle item', engineMs: 0.2, domMs: 0.01, ruleRuns: 1, derived: 1 },
  ]),
)

describe('performance judgements', () => {
  const store = oxigraphStore(ox)
  store.loadTurtle(perfOntology)
  store.loadTurtle(observationsTurtle(rows))
  const { judgements, findings } = judge(store)
  const texts = (j: string) => findings.filter((f) => f.judgement.endsWith(j)).map((f) => f.text)

  it('loads every judgement from the ontology', () => {
    expect(judgements.map((j) => j.iri.split('#')[1])).toEqual([
      'FastestInitialRender',
      'FrameBudget',
      'StoreEffect',
      'RulesEffect',
      'BulkEffect',
      'Scaling',
      'DomShare',
    ])
  })

  it('names the fastest initial render per size', () => {
    expect(texts('FastestInitialRender')).toEqual([
      'At 100 items, n3 · function renders from scratch in 15 ms, 4.5× faster than oxigraph · sparql · per-focus (67 ms).',
      'At 1000 items, n3 · function renders from scratch in 65 ms, 9.2× faster than oxigraph · sparql · per-focus (599 ms).',
    ])
  })

  it('flags configurations whose updates miss a frame at the largest size', () => {
    const frame = findings.filter((f) => f.judgement.endsWith('FrameBudget'))
    expect(frame).toHaveLength(6)
    expect(frame.filter((f) => f.verdict === 'concern').map((f) => f.text.split(':')[0]).sort()).toEqual([
      'oxigraph · function',
      'oxigraph · sparql · bulk',
      'oxigraph · sparql · per-focus',
    ])
    expect(texts('FrameBudget')).toContain('oxigraph · sparql · bulk: 1 of 2 updates at 1000 items miss a 16.7 ms frame (worst: reorder item, 56.5 ms).')
  })

  it('quantifies the store and evaluation choices', () => {
    expect(texts('StoreEffect').at(-1)).toMatch(/^With identical SPARQL rules at 1000 items, mirroring the store into N3\.js makes the average update 13\.8× faster/)
    expect(texts('BulkEffect').at(-1)).toBe('At 1000 items, evaluating each SPARQL rule once for all instances takes 493 ms against 598 ms for one query per instance (1.2×).')
    expect(texts('Scaling')).toContain('oxigraph · sparql · bulk: 100 → 1000 items costs 10.3× the time (roughly linear).')
  })

  it('projects every chart and table from a SPARQL SELECT', () => {
    const all = views(store)
    expect(all.map((v) => v.iri.split('#')[1])).toEqual(['InitialRenderView', 'UpdateMixView', 'UpdateMatrixView', 'ScalingView'])
    const initial = select(store, all[0]!)
    expect(initial).toHaveLength(2 * CONFIGS.length * 2) // 2 sizes × configurations × (engine, dom)
    // The recorded rows predate the engine configurations, which come first and are unmeasured.
    expect(initial.find((r) => r.value !== undefined)).toMatchObject({ items: 100, part: 'dom', value: 1 })
    const matrix = select(store, all[2]!)
    expect(matrix.filter((r) => r.overBudget).map((r) => `${r.label}@${r.items}`).sort()).toEqual([
      'oxigraph · function@1000',
      'oxigraph · sparql · bulk@1000',
      'oxigraph · sparql · per-focus@1000',
    ])
    // planned but unmeasured cells come back unbound
    const pending = select(store, all[1]!).filter((r) => r.value === undefined)
    // The fixture measured 6 configurations, without rename/add/type; the later ones (the engines) not at all.
    expect(pending.length).toBe(2 * (6 * 3 + (CONFIGS.length - 6) * 5))
  })
})
