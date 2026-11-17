import type { Quad } from '@rdfjs/types'
import { describe, expect, it } from 'vitest'
import type { EngineStore } from '../rdf-engine/host/store.ts'
import type { StoreCompaction } from '../src/store/types.ts'
import { termKey } from '../src/rdf.ts'
import { mountSite } from './harness.ts'
import { type Page, sitePages } from './site-clicks.ts'

const UI = 'https://semblance.dev/demo#'
const PAGE = '#app > [data-sem-c=stack] > [data-sem-c=switch] > :not([hidden])'
const MiB = (n: number) => (n / 2 ** 20).toFixed(0) + ' MiB'
/**
 * The slice idle time gives compaction here, and what a slice overruns it by: the last chunk it
 * started (1024 quads) with any garbage collection it met (measured 0.1-3.3 ms) and, in a slice
 * where the new instance's memory grows (WAT grows by half of it, 150 to 337 MiB in one step near
 * the end of the copy), that growth (measured up to 13 ms). The bounds leave room for a busy machine.
 */
const BUDGET = 8
const CHUNK_OVERRUN = 6
const GROWTH_OVERRUN = 20

/**
 * A visit of every page of the site grows the engine's WebAssembly memory to its high-water mark,
 * and it stays there however much of that state goes (#530). Compaction copies the store into a
 * fresh instance: the memory falls to what live state needs, the graph is the same, and the site
 * goes on rendering as it did. Idle time copies a slice at a time, and what changes between the
 * slices reaches the copy.
 */
describe('the site after a visit of every page, compacted', () => {
  it('holds the same graph in less memory and renders the same', () => {
    const site = mountSite('wat')
    const { document, shell, runtime } = site
    const store = site.store as EngineStore
    const f = store.factory
    const app = f.namedNode(UI + 'app')
    const set = (p: string, o: string) => runtime.apply({ remove: store.match(app, f.namedNode(UI + p), null), add: [f.quad(app, f.namedNode(UI + p), f.namedNode(o))] })
    const show = ({ page, dimension, value }: Page) => {
      if (dimension && value) set(dimension, value)
      set('page', UI + page)
      shell.flush()
      return document.querySelector(PAGE)?.innerHTML ?? ''
    }
    const fresh = store.memoryBytes()
    const pages = Object.values(sitePages()).flat()
    expect(pages.length).toBeGreaterThan(40)
    for (const p of pages) show(p)
    // Pages whose rendering does not change with time: as shown before and after compaction.
    const again = [{ page: 'Reference' }, sitePages().docs[0]!, sitePages().components[0]!]
    const before = again.map(show)
    show({ page: 'Home' })
    const graph = () => store.match(null, null, null, null).map((q) => [q.subject, q.predicate, q.object, q.graph].map(termKey).join(' ')).sort()
    const visited = store.memoryBytes()
    const live = store.liveBytes()

    // A slice at a time, as idle time compacts, with pages shown between the slices of the first
    // half of the copy: what they change goes into the journal, and from there into the copy.
    const slices: { ms: number; grew: boolean }[] = []
    let c: StoreCompaction | undefined
    let shown = 0
    let held: string[] | undefined
    const notes: Quad[] = []
    for (let k = 0; !c; k++) {
      const memory = store.memoryBytes()
      const t = performance.now()
      c = store.compactStep(BUDGET)
      slices.push({ ms: performance.now() - t, grew: !c && store.memoryBytes() > memory })
      const now = store.compacting()
      if (!now) continue
      if (now.copied < now.quads / 2) {
        if (k % 4 === 3) show(pages[shown++ % pages.length]!)
        // And data of the app's own, some of it removed again.
        if (k % 4 === 1) {
          const batch = Array.from({ length: 200 }, (_, j) => f.quad(f.namedNode(`${UI}note/${k}/${j}`), f.namedNode(UI + 'says'), f.literal(`a note ${k}.${j}`)))
          runtime.apply({ add: batch, remove: notes.splice(0, 100) })
          notes.push(...batch)
        }
      } else if (!held) {
        show({ page: 'Home' })
        held = graph()
      }
    }
    expect(store.abandoned).toBeUndefined()
    expect(shown).toBeGreaterThan(3)
    expect(c.journal).toBeGreaterThan(1000)
    expect(c.after).toBe(store.memoryBytes())
    expect(c.after).toBeLessThan(visited)
    expect(graph()).toEqual(held)
    // Each slice stays within its budget, but for the chunk it started last and the memory growth.
    const longest = (grew: boolean) => Math.max(0, ...slices.filter((x) => x.grew === grew).map((x) => x.ms))
    expect(longest(false)).toBeLessThan(BUDGET + CHUNK_OVERRUN)
    expect(longest(true)).toBeLessThan(BUDGET + GROWTH_OVERRUN)
    expect(again.map(show)).toEqual(before)
    // Interaction goes on: every page again, then the estimate still matches what a fresh copy needs.
    for (const p of pages) show(p)
    const now = store.memoryBytes()
    // The same in one step, for comparison (what pressure at Critical asks for).
    const one = store.compact()!
    expect(one.slices).toBe(1)
    console.log(
      `the site (WAT): ${MiB(fresh)} loaded, ${MiB(visited)} after ${pages.length} pages (live estimate ${MiB(live)});`,
      `compacted to ${MiB(c.after)} (${c.quads} quads, ${c.terms} terms) in ${c.slices} slices of ${BUDGET} ms:`,
      `the longest ${longest(false).toFixed(1)} ms (${longest(true).toFixed(1)} ms where the new memory grew, in ${slices.filter((x) => x.grew).length} slices), the swap ${c.swapMs!.toFixed(1)} ms,`,
      `${c.ms.toFixed(0)} ms of work over ${c.elapsedMs!.toFixed(0)} ms; ${shown} pages shown meanwhile, ${c.journal} changes journaled, replayed in ${c.journalMs!.toFixed(1)} ms;`,
      `${MiB(now)} after visiting every page again; in one step then: ${one.ms.toFixed(0)} ms (${one.quads} quads, to ${MiB(one.after)})`,
    )
    runtime.dispose()
  }, 600_000)
})
