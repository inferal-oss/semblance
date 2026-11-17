import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { todoReactions } from '../src/examples/todo.ts'
import { BEH, EVENTS_GRAPH, LDES, NS, RETENTION_GRAPH } from '../src/ns.ts'
import { MemoryPressure, type PressureReport } from '../src/retention/pressure.ts'
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
