import { appendFileSync } from 'node:fs'
import type { Quad } from '@rdfjs/types'
import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { measure, MemoryPressure } from '../src/retention/pressure.ts'
import { mountSite } from './harness.ts'
import { type Page, sitePages } from './site-clicks.ts'

const UI = 'https://semblance.dev/demo#'
const MIB = 2 ** 20
// The page shown: the one case of the shell's page switch that is not hidden.
const PAGE = '#app > [data-sem-c=stack] > [data-sem-c=switch] > :not([hidden])'
// The budget. Unbounded, a visit of every page reaches 337 MiB of WebAssembly memory and 1,109k
// triples (some 464 MiB as the pressure effect counts it, with 120 bytes a triple standing in for the
// heap, which Node does not report). At 200 MiB pressure reaches Critical on the heaviest pages, so
// eviction (a quarter at Elevated, all at Critical) and compaction both act on every pass.
const BUDGET_MIB = 200
const PASSES = Number(process.env.SOAK_PASSES ?? 3)
// A page's own rendering is measured at the next idle step, so it may pass the budget until then: the
// heaviest page adds some 58 MiB.
const OVERSHOOT = 1.1

type Site = ReturnType<typeof mountSite>
const show = async (site: Site, { page, dimension, value }: Page) => {
  const s = site.store
  const f = s.factory
  const app = f.namedNode(UI + 'app')
  const set = (p: string, o: string) => site.runtime.apply({ remove: s.match(app, f.namedNode(UI + p), null), add: [f.quad(app, f.namedNode(UI + p), f.namedNode(o))] })
  if (dimension && value) set(dimension, value)
  set('page', UI + page)
  site.shell.flush()
  // An idle slice, and the views that follow their queries refresh (live figures that say
  // "Measuring…" until then).
  site.runtime.warm(8)
  await new Promise((r) => setTimeout(r, 0))
  site.shell.flush()
  return site.document.querySelector(PAGE)!.outerHTML
}
const name = (p: Page) => (p.value ?? p.page).replace(UI, 'ui:')
/**
 * A page as markup with each element's attributes in name order: the patcher sets an attribute that
 * came later after those already there, where a fresh render writes them in the rule's order.
 */
const canonical = (html: string, site: Site) => {
  const box = site.document.createElement('div')
  box.innerHTML = html
  const walk = (n: Node): string => {
    if (n.nodeType !== 1) return n.nodeType === 3 ? (n.textContent ?? '') : ''
    const el = n as Element
    const attrs = [...el.attributes].map((a) => `${a.name}="${a.value}"`).sort()
    return `<${el.tagName.toLowerCase()} ${attrs.join(' ')}>${[...el.childNodes].map(walk).join('')}</>`
  }
  return walk(box)
}

/**
 * The whole site within a memory budget (docs/RETENTION.md §8.5, §8.8): every page visited in
 * passes, with the pressure effect stepped between pages as idle time would. After the first pass the
 * memory stays within the budget, pages shown again render as on their first visit (and that as on a
 * fresh mount), and nothing the app owns is lost.
 */
describe('a site soak within the memory budget', () => {
  it(`visits every page ${PASSES} times within ${BUDGET_MIB} MiB`, async () => {
    const pages = sitePages()
    const all = Object.values(pages).flat()
    const sample = [pages.docs[1]!, pages.components[2]!, pages.examples[3]!]
    const fresh = new Map<Page, string>()
    for (const p of sample) {
      const other = mountSite('wat')
      fresh.set(p, await show(other, p))
      other.runtime.dispose()
    }

    const site = mountSite('wat')
    const s = site.store
    const f = s.factory
    // The budget in the graph: ret:maxMiB wins over the Memory tool's slider (ret:maxFrom).
    const budget = f.namedNode(UI + 'memoryBudget')
    site.runtime.apply({ remove: [], add: [f.quad(budget, f.namedNode(NS.ret + 'maxMiB'), f.literal(String(BUDGET_MIB), f.namedNode(NS.xsd + 'integer')))] })
    // Measured as the effect measures by default: the engine's memory, and the store's size for the heap.
    const pressure = new MemoryPressure(site.runtime, { onChange: () => site.shell.flush() })
    const triples = () => s.size?.() ?? s.match(null, null, null).length
    const used = () => {
      const x = measure(site.runtime)
      return (x.wasmBytes + (x.heapBytes ?? triples() * 120)) / MIB
    }
    const wasm = () => s.memoryBytes!() / MIB
    // What the app owns: the default graph, but for the page and what picks it.
    const key = (q: Quad) => `${q.subject.value} ${q.predicate.value} ${q.object.termType}:${q.object.value}`
    const owned = () => new Set(s.match(null, null, null, f.defaultGraph()).map(key).filter((k) => !k.startsWith(UI + 'app ')))
    const before = owned()

    const first = new Map<Page, string>()
    const passes: { seconds: number; peak: number; settled: number; wasm: number; triples: number; levels: Record<string, number>; compactions: number; differ: string[] }[] = []
    for (let pass = 0; pass < PASSES; pass++) {
      const t = performance.now()
      const x = { seconds: 0, peak: 0, settled: 0, wasm: 0, triples: 0, levels: {} as Record<string, number>, compactions: 0, differ: [] as string[] }
      for (const p of all) {
        const html = await show(site, p)
        if (!first.has(p)) first.set(p, html)
        else if (first.get(p) !== html) x.differ.push(name(p))
        x.peak = Math.max(x.peak, used())
        const memory = wasm()
        const level = await pressure.step()
        x.levels[level] = (x.levels[level] ?? 0) + 1
        if (wasm() < memory) x.compactions++
        x.settled = Math.max(x.settled, used())
        x.wasm = Math.max(x.wasm, wasm())
        x.triples = Math.max(x.triples, triples())
      }
      x.seconds = (performance.now() - t) / 1000
      passes.push(x)
    }
    const figures = passes.map((x, i) => `pass ${i}: ${x.seconds.toFixed(1)} s, peak ${x.peak.toFixed(0)} MiB, after a step ${x.settled.toFixed(0)} MiB, wasm ${x.wasm.toFixed(0)} MiB, ${x.triples} triples, ${JSON.stringify(x.levels)}, ${x.compactions} compactions`).join('\n')
    // SOAK_LOG=<file> writes the figures of each pass.
    if (process.env.SOAK_LOG) appendFileSync(process.env.SOAK_LOG, figures + '\n')

    // Pressure acted: eviction (Elevated or Critical) and compaction, on every pass.
    for (const x of passes) {
      expect((x.levels.elevated ?? 0) + (x.levels.critical ?? 0), figures).toBeGreaterThan(0)
      expect(x.compactions, figures).toBeGreaterThan(0)
    }
    // After the first pass: within the budget once a step has run, and within the overshoot before.
    for (const x of passes.slice(1)) {
      expect(x.settled, figures).toBeLessThanOrEqual(BUDGET_MIB)
      expect(x.peak, figures).toBeLessThanOrEqual(BUDGET_MIB * OVERSHOOT)
      // Nothing accumulates from pass to pass: the triples stay within 5% of the second pass's. The
      // WebAssembly memory's high-water mark moves with where in a pass the compactions land (100 to
      // 120 MiB over six passes), so it is held to the budget and a quarter over the second pass's.
      expect(x.triples, figures).toBeLessThanOrEqual(passes[1]!.triples * 1.05)
      expect(x.wasm, figures).toBeLessThanOrEqual(Math.min(BUDGET_MIB, passes[1]!.wasm * 1.25))
    }
    // Pages shown again render byte for byte as on their first visit; a first visit as on a fresh
    // mount, but for the order of attributes.
    expect(passes.flatMap((x) => x.differ)).toEqual([])
    for (const p of sample) expect(canonical(first.get(p)!, site), name(p)).toBe(canonical(fresh.get(p)!, site))
    // Nothing owned is lost, and no retained stream dropped a member.
    const after = owned()
    expect([...before].filter((k) => !after.has(k))).toEqual([])
    for (const r of site.runtime.retention.all()) expect(r.figures().dropped, r.iri).toBe(0)
    site.runtime.dispose()
  }, 600_000)
})
