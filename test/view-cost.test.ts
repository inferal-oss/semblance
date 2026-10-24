// Maintained views (docs/IVM.md): the Activity view's work per event must not depend on how
// many members the change log keeps (ldes:amount). Measured in work counters, with the
// Activity tab shown, at a bound of 200 and of 2,000.
import { describe, expect, it } from 'vitest'
import { BEH, LDES, NS } from '../src/ns.ts'
import { mountShell } from './harness.ts'

function measureAt(amount: number, prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountShell(5, 'hybrid', prefer)
  const { document, store, fire } = h
  const f = store.factory
  const policy = f.namedNode(NS.beh + 'ChangeLogRetention')
  h.runtime.apply({ remove: store.match(policy, f.namedNode(LDES.amount), null), add: [f.quad(policy, f.namedNode(LDES.amount), f.literal(String(amount), f.namedNode(NS.xsd + 'integer')))] })
  const counters = { read: 0, sparqlRows: 0 }
  const { match, select, construct } = store
  store.match = (...args) => {
    const quads = match.apply(store, args)
    counters.read += quads.length
    return quads
  }
  store.select = (...args) => {
    const rows = select.apply(store, args)
    counters.sparqlRows += rows.length
    return rows
  }
  store.construct = (...args) => {
    const quads = construct.apply(store, args)
    counters.sparqlRows += quads.length
    return quads
  }
  const button = (text: string) => [...document.querySelectorAll('button, [role=tab]')].find((b) => b.textContent!.trim() === text) as HTMLElement
  const field = () => document.querySelector('[data-sem-c=text-field] input') as HTMLInputElement
  fire(button('Activity'), 'click')
  for (let i = 0; i < amount + 20; i++) {
    field().value = 'x'.repeat((i % 7) + 1)
    fire(field(), 'input')
  }
  expect(h.bus.recent(amount + 100).length).toBe(amount)
  // Idle time, as a browser gives it: the hybrid store rebuilds its Oxigraph side (dead versions of replaced counts).
  while (store.maintain?.(1e6));
  const views = () => (h.runtime as unknown as { views?: { totals: { rowsIn: number; state: number; ms: number } } }).views?.totals
  // The Activity view's own time: its rendering rule plus the views it reads.
  const activityMs = () => [...h.screen.engine.stats.byRule].filter(([iri]) => iri.includes('StreamStats')).reduce((n, [, r]) => n + r.ms, 0) + (views()?.ms ?? 0)
  const snapshot = () => ({
    ruleRuns: h.screen.engine.stats.ruleRuns,
    written: h.screen.engine.stats.derivedAdded + h.screen.engine.stats.derivedRemoved,
    read: counters.read,
    sparqlRows: counters.sparqlRows,
    domOps: h.shell.ops,
    viewRows: views()?.rowsIn ?? 0,
    activityMs: activityMs(),
    viewMs: views()?.ms ?? 0,
  })
  const toggle = () => {
    const box = document.querySelector('[data-sem-c=list-item] input') as HTMLInputElement
    box.checked = !box.checked
    fire(box, 'change')
  }
  for (let i = 0; i < 4; i++) toggle()
  const a = snapshot()
  const times: number[] = []
  const n = 20
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    toggle()
    times.push(performance.now() - t)
  }
  const b = snapshot()
  const per = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(((v - a[k as keyof typeof a]) / n) * 1000) / 1000]))
  times.sort((x, y) => x - y)
  return { per, ms: times[times.length >> 1]!, stats: document.querySelector('[data-sem-c=stream-stats]')?.textContent }
}

describe('maintained views: cost per event', () => {
  it('does not depend on the change log bound (ldes:amount)', () => {
    const small = measureAt(200)
    const large = measureAt(2000)
    process.stderr.write(`[view-cost] amount 200: ${JSON.stringify(small.per)} ${small.ms.toFixed(3)} ms/toggle\n`)
    process.stderr.write(`[view-cost] amount 2000: ${JSON.stringify(large.per)} ${large.ms.toFixed(3)} ms/toggle\n`)
    expect(small.stats).toContain('200')
    expect(large.stats).toContain('2000') // the event count shows the bound
    const fs = measureAt(200, 'function')
    const fl = measureAt(2000, 'function')
    process.stderr.write(`[view-cost] function, amount 200: ${JSON.stringify(fs.per)} ${fs.ms.toFixed(3)} ms/toggle\n`)
    process.stderr.write(`[view-cost] function, amount 2000: ${JSON.stringify(fl.per)} ${fl.ms.toFixed(3)} ms/toggle\n`)
    for (const [a, b] of [
      [small, large],
      [fs, fl],
    ] as const) {
      for (const k of Object.keys(a.per)) if (!k.endsWith('Ms')) expect(b.per[k], k).toBeLessThanOrEqual(a.per[k]! * 1.1 + 2)
      // Time too (generously: timing is noisy; a cost growing with the bound would be ~10x).
      expect(b.per.activityMs!).toBeLessThan(a.per.activityMs! * 2 + 1)
    }
  }, 600_000)
})
