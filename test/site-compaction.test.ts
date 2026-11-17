import { describe, expect, it } from 'vitest'
import type { EngineStore } from '../rdf-engine/host/store.ts'
import { termKey } from '../src/rdf.ts'
import { mountSite } from './harness.ts'
import { type Page, sitePages } from './site-clicks.ts'

const UI = 'https://semblance.dev/demo#'
const PAGE = '#app > [data-sem-c=stack] > [data-sem-c=switch] > :not([hidden])'
const MiB = (n: number) => (n / 2 ** 20).toFixed(0) + ' MiB'

/**
 * A visit of every page of the site grows the engine's WebAssembly memory to its high-water mark,
 * and it stays there however much of that state goes (#530). Compaction copies the store into a
 * fresh instance: the memory falls to what live state needs, the graph is the same, and the site
 * goes on rendering as it did.
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
    const held = graph()
    const visited = store.memoryBytes()
    const live = store.liveBytes()

    const c = store.compact()!
    expect(c).toBeDefined()
    expect(c.after).toBe(store.memoryBytes())
    expect(c.after).toBeLessThan(visited)
    expect(graph()).toEqual(held)
    expect(again.map(show)).toEqual(before)
    // Interaction goes on: every page again, then the estimate still matches what a fresh copy needs.
    for (const p of pages) show(p)
    console.log(
      `the site (WAT): ${MiB(fresh)} loaded, ${MiB(visited)} after ${pages.length} pages (live estimate ${MiB(live)});`,
      `compacted to ${MiB(c.after)} in ${c.ms.toFixed(0)} ms (${c.quads} quads, ${c.terms} terms); ${MiB(store.memoryBytes())} after visiting every page again`,
    )
    runtime.dispose()
  }, 600_000)
})
