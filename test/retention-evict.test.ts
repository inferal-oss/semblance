import { describe, expect, it } from 'vitest'
import { mountSite } from './harness.ts'
import { type Page, sitePages } from './site-clicks.ts'

const UI = 'https://semblance.dev/demo#'
// The page shown: the one case of the shell's page switch that is not hidden.
const PAGE = '#app > [data-sem-c=stack] > [data-sem-c=switch] > :not([hidden])'

type Site = ReturnType<typeof mountSite>
const show = (site: Site, { page, dimension, value }: Page) => {
  const s = site.store
  const f = s.factory
  const app = f.namedNode(UI + 'app')
  const set = (p: string, o: string) => site.runtime.apply({ remove: s.match(app, f.namedNode(UI + p), null), add: [f.quad(app, f.namedNode(UI + p), f.namedNode(o))] })
  if (dimension && value) set(dimension, value)
  set('page', UI + page)
  site.shell.flush()
}
const shown = (site: Site) => site.document.querySelector(PAGE)!.outerHTML

/**
 * Under memory pressure the derived state of hidden pages is released (Runtime.evict, docs/RETENTION.md):
 * a visit of every page keeps the whole site's renderings, eviction gives most of it back, and a page
 * shown again renders exactly as it does on a fresh visit.
 */
describe('evicting hidden renderings', () => {
  it('releases what a visit of every page kept, and a page shown again is as it was', () => {
    const pages = sitePages()
    const all = Object.values(pages).flat()
    const again = [pages.docs[1]!, pages.components[2]!, pages.examples[3]!]
    const site = mountSite('wat')
    const fresh = again.map((p) => {
      const other = mountSite('wat')
      show(other, p)
      const html = shown(other)
      other.runtime.dispose()
      return html
    })
    for (const p of all) show(site, p)
    show(site, { page: 'Home' })
    const visited = site.store.size?.() ?? site.store.match(null, null, null).length
    const freed = site.runtime.evict()
    site.shell.flush()
    const after = site.store.size?.() ?? site.store.match(null, null, null).length
    expect(freed).toBeGreaterThan(0)
    // Most of what the visit added is gone (the home page and what is always evaluated stay).
    expect(after).toBeLessThan(visited * 0.5)
    again.forEach((p, i) => {
      show(site, p)
      expect(shown(site), `${p.page} ${p.value ?? ''}`).toBe(fresh[i])
    })
    site.runtime.dispose()
  }, 600_000)
})
