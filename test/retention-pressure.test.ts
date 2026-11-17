import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { todoReactions } from '../src/examples/todo.ts'
import { BEH, EVENTS_GRAPH, LDES, NS, RETENTION_GRAPH } from '../src/ns.ts'
import { HEAP_ESTIMATE, heapCountsWasm, MemoryPressure, type PressureReport, type Sample, usage } from '../src/retention/pressure.ts'
import { setup } from './helpers.ts'
import { mountSite } from './harness.ts'
import { type Page, sitePages } from './site-clicks.ts'

const RET = NS.ret
const MIB = 2 ** 20
const BUDGET = 'https://example.org/memory#budget'
const FIXTURE = `
@prefix ret: <https://semblance.dev/ns/retention#> .
<${BUDGET}> a ret:MemoryBudget ; ret:maxMiB 100 .
`

function mounted() {
  const h = setup('wat', {}, 5, [FIXTURE])
  const f = h.store.factory
  const bus = new EventBus(h.runtime, h.screen, { functions: todoReactions })
  let used = 10 * MIB
  const reports: PressureReport[] = []
  let answer: { maxBytes?: number; drop?: boolean } | undefined
  const pressure = new MemoryPressure(h.runtime, {
    bus,
    sample: () => ({ wasmBytes: used, heapBytes: 0 }),
    onRetention: (r) => {
      reports.push(r)
      return answer
    },
  })
  const b = f.namedNode(BUDGET)
  const figure = (p: string) => h.store.match(b, f.namedNode(RET + p), null, f.namedNode(RETENTION_GRAPH))[0]?.object.value
  const set = (p: string, o: ReturnType<typeof f.namedNode> | ReturnType<typeof f.literal>) => h.runtime.apply({ remove: h.store.match(b, f.namedNode(RET + p), null, f.defaultGraph()), add: [f.quad(b, f.namedNode(RET + p), o)] })
  return {
    ...h,
    f,
    bus,
    pressure,
    reports,
    figure,
    set,
    use: (mib: number) => void (used = mib * MIB),
    answer: (a: typeof answer) => void (answer = a),
  }
}

describe('the memory budget (ret:MemoryBudget)', () => {
  it('measures against the budget in the graph and says the level there', async () => {
    const h = mounted()
    expect(await h.pressure.step()).toBe('normal')
    expect(h.figure('level')).toBe(RET + 'Normal')
    expect(h.figure('usedMiB')).toBe('10.0')
    h.use(85)
    expect(await h.pressure.step()).toBe('elevated')
    expect(h.runtime.pressure).toBe('elevated')
    h.use(120)
    expect(await h.pressure.step()).toBe('critical')
    expect(h.figure('level')).toBe(RET + 'Critical')
    // A budget set with ret:maxBytes wins over ret:maxMiB.
    h.set('maxBytes', h.f.literal(String(200 * MIB), h.f.namedNode(NS.xsd + 'integer')))
    expect(await h.pressure.step()).toBe('normal')
  })

  it("counts the engines' memory once where the heap figure holds it (Chromium), and estimates the heap where none is reported", async () => {
    const h = setup('wat', {}, 5, [FIXTURE])
    const f = h.store.factory
    let x: Sample = { wasmBytes: 60 * MIB, heapBytes: 90 * MIB, heapIncludesWasm: true }
    const pressure = new MemoryPressure(h.runtime, { sample: () => x })
    const figure = (p: string) => h.store.match(f.namedNode(BUDGET), f.namedNode(RET + p), null, f.namedNode(RETENTION_GRAPH))[0]?.object.value
    // 90 MiB in all, 30 of them JS (not 150): Elevated on the 100 MiB budget, not Critical.
    expect(await pressure.step()).toBe('elevated')
    expect(figure('usedMiB')).toBe('90.0')
    expect(figure('heapMiB')).toBe('30.0')
    expect(figure('wasmMiB')).toBe('60.0')
    // A heap figure without the engines' memory (another browser's) is added to it.
    x = { wasmBytes: 60 * MIB, heapBytes: 30 * MIB }
    await pressure.step()
    expect(figure('usedMiB')).toBe('90.0')
    // Which Chromium counts it (measured): 143 does, 151 and later do not; other browsers report no heap.
    expect(heapCountsWasm('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/143.0.7499.4 Safari/537.36')).toBe(true)
    expect(heapCountsWasm('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36')).toBe(false)
    expect(heapCountsWasm('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15')).toBe(false)
    // Without a heap figure, the triples stand in for it, derived ones dearer.
    const u = usage({ wasmBytes: 0 }, 1000, 400)
    expect(u.estimated).toBe(true)
    expect(u.js).toBe(400 * HEAP_ESTIMATE.derivedTriple + 600 * HEAP_ESTIMATE.triple)
    h.runtime.dispose()
  })

  it('acts as if a level held when one is simulated, and performs requests', async () => {
    const h = mounted()
    h.set('simulate', h.f.namedNode(RET + 'Critical'))
    expect(await h.pressure.step()).toBe('critical')
    h.set('simulate', h.f.namedNode(RET + 'Measured'))
    expect(await h.pressure.step()).toBe('normal')
    h.set('request', h.f.namedNode(RET + 'Evict'))
    await h.pressure.step()
    expect(h.store.match(h.f.namedNode(BUDGET), h.f.namedNode(RET + 'request'), null)).toHaveLength(0)
  })

  it('measures usage by graph, class and host structure on request, replacing the last measurement', async () => {
    const h = mounted()
    const f = h.f
    const g = f.namedNode(RETENTION_GRAPH)
    const usage = (kind: string) =>
      h.store.match(null, f.namedNode(NS.rdf + 'type'), f.namedNode(RET + kind), g).map((q) => {
        const one = (p: string) => h.store.match(q.subject, f.namedNode(RET + p), null, g)[0]?.object
        return { of: (one('graph') ?? one('class') ?? one('structure'))!.value, n: Number((one('triples') ?? one('instances') ?? one('entries'))!.value) }
      })
    await h.pressure.step()
    expect(usage('GraphUsage')).toHaveLength(0)
    h.set('request', f.namedNode(RET + 'Measure'))
    await h.pressure.step()
    expect(h.store.match(f.namedNode(BUDGET), f.namedNode(RET + 'request'), null)).toHaveLength(0)
    const graphs = usage('GraphUsage')
    const triples = (iri: string) => graphs.find((u) => u.of === iri)?.n ?? 0
    // The default graph holds the ontology and the app; the events graph what was raised; the budget's figures are in the retention graph.
    expect(triples(RET + 'DefaultGraph')).toBeGreaterThan(1000)
    expect(triples(RETENTION_GRAPH)).toBeGreaterThan(0)
    expect(graphs.every((u) => u.n > 0)).toBe(true)
    const classes = usage('ClassUsage')
    expect(classes.length).toBeGreaterThan(0)
    expect(classes.length).toBeLessThanOrEqual(25)
    expect(classes.map((c) => c.n)).toEqual([...classes.map((c) => c.n)].sort((a, b) => b - a))
    expect(usage('StructureUsage').map((u) => u.of)).toContain('screen.engine.refs')
    expect(h.figure('measuredAt')).toMatch(/^\d{4}-\d\d-\d\dT/)
    // Measured again: the same nodes, replaced, not added to.
    const nodes = h.store.match(null, f.namedNode(RET + 'usageOf'), null, g).length
    h.set('request', f.namedNode(RET + 'Measure'))
    await h.pressure.step()
    expect(h.store.match(null, f.namedNode(RET + 'usageOf'), null, g).length).toBe(nodes)
    expect(usage('GraphUsage').filter((u) => u.of === RET + 'DefaultGraph')).toHaveLength(1)
  })

  it('compacts the engine on request and says what it gave back, beside the live estimate', async () => {
    const h = mounted()
    const f = h.f
    // Grow the engine's memory with what then goes: compaction has something to give back.
    const junk = Array.from({ length: 60_000 }, (_, i) => f.quad(f.namedNode(`https://example.org/junk#${i}`), f.namedNode('https://example.org/junk#p'), f.literal('a value long enough to take room ' + i)))
    for (const q of junk) h.store.add(q)
    for (const q of junk) h.store.delete(q)
    await h.pressure.step()
    expect(Number(h.figure('liveMiB'))).toBeGreaterThan(0)
    expect(h.figure('compactedMiB')).toBe('0.0')
    h.set('request', f.namedNode(RET + 'CompactNow'))
    await h.pressure.step()
    expect(Number(h.figure('compactedMiB'))).toBeGreaterThan(0)
  })

  it('compacts a slice at a time at Elevated and all at once at Critical', async () => {
    const h = mounted()
    const f = h.f
    const grow = () => {
      const junk = Array.from({ length: 60_000 }, (_, i) => f.quad(f.namedNode(`https://example.org/junk#${i}`), f.namedNode('https://example.org/junk#p'), f.literal('a value long enough to take room ' + i)))
      for (const q of junk) h.store.add(q)
      for (const q of junk) h.store.delete(q)
    }
    const store = h.store as typeof h.store & { compactStep?: (ms: number, o?: { below?: number }) => unknown }
    expect(typeof store.compactStep).toBe('function')
    const steps: number[] = []
    const compactStep = store.compactStep!.bind(store)
    store.compactStep = (ms, o) => (steps.push(ms), compactStep(ms, o))
    grow()
    h.use(85)
    for (let i = 0; i < 20 && Number(h.figure('compactedMiB') ?? 0) === 0; i++) await h.pressure.step()
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.every((ms) => ms <= 8)).toBe(true)
    expect(Number(h.figure('compactedMiB'))).toBeGreaterThan(0)
    // Critical finishes one in a single step.
    const before = Number(h.figure('compactedMiB'))
    grow()
    steps.length = 0
    // Idle upkeep frees the junk's terms (and does not compact itself), so live state is well below the memory.
    ;(h.store as unknown as { setCompaction(p: { below: number }): void }).setCompaction({ below: 0 })
    h.store.maintain?.(1000)
    h.use(150)
    await h.pressure.step()
    expect(steps).toHaveLength(0)
    expect(Number(h.figure('compactedMiB'))).toBeGreaterThan(before)
  })

  it('raises ret:Pressure for reactions after its own steps, then asks the host, once a crossing', async () => {
    const h = mounted()
    h.use(150)
    h.answer({ maxBytes: 400 * MIB })
    await h.pressure.step()
    expect(h.reports).toHaveLength(0)
    await h.pressure.step()
    // Announced (ret:AnnouncePressure): a member of the change log, said once.
    const g = h.f.namedNode(EVENTS_GRAPH)
    expect(h.store.match(null, h.f.namedNode(BEH.handledBy), h.f.namedNode(RET + 'AnnouncePressure'), g)).toHaveLength(1)
    expect(h.reports).toHaveLength(0)
    await h.pressure.step()
    expect(h.reports).toEqual([expect.objectContaining({ reason: 'memory', level: 'critical', usedBytes: 150 * MIB, maxBytes: 100 * MIB })])
    // The host's answer is the new budget, in the graph.
    expect(await h.pressure.step()).toBe('normal')
    expect(h.store.match(h.f.namedNode(BUDGET), h.f.namedNode(RET + 'maxBytes'), null)[0]?.object.value).toBe(String(400 * MIB))
    expect(h.reports).toHaveLength(1)
  })

  it('asks the host about history storage refused, and keeps it when told to', async () => {
    const h = mounted()
    const f = h.f
    for (const name of ['ChangeLogRetention', 'UndoRetention']) {
      const policy = f.namedNode(NS.beh + name)
      for (const q of h.store.match(policy, f.namedNode(LDES.amount), null)) h.store.delete(q)
      h.store.add(f.quad(policy, f.namedNode(LDES.amount), f.literal('5', f.namedNode(NS.xsd + 'integer'))))
    }
    const full = { get: async () => undefined, set: async () => Promise.reject(new Error('QuotaExceededError')), remove: async () => undefined }
    Object.assign(h.runtime.retention.opts, { schedule: (run: () => void) => run() })
    await h.runtime.retention.use(full)
    h.answer({ drop: false })
    for (let i = 0; i < 160; i++) h.bus.emit(NS.beh + 'Click', 'https://example.org/todo#density')
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0))
      await h.runtime.retention.flush()
    }
    const x = h.runtime.retention.get(BEH.ChangeLog)!.figures()
    expect(h.reports.some((r) => r.reason === 'storage' && r.stream === BEH.ChangeLog)).toBe(true)
    expect(x.dropped).toBe(0)
    expect(x.pending).toBeGreaterThan(128)
  })
})

describe('memory pressure on the whole site', () => {
  it('evicts what is hidden at Critical, and evaluates nothing hidden ahead of time while it holds', async () => {
    const site = mountSite('wat')
    const f = site.store.factory
    const all = Object.values(sitePages()).flat()
    const show = ({ page, dimension, value }: Page) => {
      const app = f.namedNode('https://semblance.dev/demo#app')
      const set = (p: string, o: string) => site.runtime.apply({ remove: site.store.match(app, f.namedNode('https://semblance.dev/demo#' + p), null), add: [f.quad(app, f.namedNode('https://semblance.dev/demo#' + p), f.namedNode(o))] })
      if (dimension && value) set(dimension, value)
      set('page', 'https://semblance.dev/demo#' + page)
      site.shell.flush()
    }
    for (const p of all.slice(0, 20)) show(p)
    show({ page: 'Home' })
    const derived = () => site.runtime.projections.reduce((n, p) => n + p.engine.derivedSize, 0)
    const before = derived()
    const budget = f.namedNode('https://semblance.dev/demo#memoryBudget')
    site.runtime.apply({ remove: site.store.match(budget, f.namedNode(RET + 'simulate'), null), add: [f.quad(budget, f.namedNode(RET + 'simulate'), f.namedNode(RET + 'Critical'))] })
    const pressure = new MemoryPressure(site.runtime, { sample: () => ({ wasmBytes: 0, heapBytes: 0 }) })
    expect(await pressure.step()).toBe('critical')
    const after = derived()
    expect(after).toBeLessThan(before / 2)
    for (let i = 0; i < 20; i++) site.runtime.warm(50)
    expect(derived()).toBe(after)
    site.runtime.dispose()
  }, 600_000)
})
