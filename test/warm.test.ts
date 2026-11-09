// A warm runtime for per-request rendering (src/server/warm.ts): a runtime loaded once per language
// and moved to each request's address renders the page a fresh store renders there (renderSite),
// whatever address it was at before: across pages, sections, languages, a target and an address
// that names nothing.
import { describe, expect, it } from 'vitest'
import { createHandler, loadSite, renderSite, siteRenderer } from '../src/node/site.ts'

const root = new URL('../', import.meta.url)

describe('a warm runtime per request', () => {
  it('renders each address of the site as a fresh store does, in any order', async () => {
    const site = await loadSite(new URL('semblance.config.ts', root).pathname)
    const warm = siteRenderer(site, { styles: false })
    const routes = [
      '/',
      '/docs/rules/',
      '/components/inputs/',
      '/uk/docs/rules/',
      '/examples/todo/',
      '/docs/',
      '/uk/',
      '/ar/components/inputs/',
      '/reference/c:Window/',
      '/examples/kanban/',
      '/nowhere/',
      '/docs/rules/',
      '/',
    ]
    for (const url of routes) {
      const w = await warm.render(url)
      const cold = await renderSite(site, url, { styles: false })
      cold.runtime.dispose()
      cold.runtime.store.dispose?.()
      expect({ url, status: w.status, lang: w.lang, dir: w.dir, address: w.address, attributes: w.attributes }).toEqual({ url, status: cold.status, lang: cold.lang, dir: cold.dir, address: cold.address, attributes: cold.attributes })
      expect(w.html, url).toBe(cold.html)
    }
    // One load per language (en, uk, ar); every other address moved a loaded runtime.
    expect(warm.stats).toEqual({ cold: 3, warm: routes.length - 3 })
    warm.dispose()
  })

  it('serves examples/hello from its subset, warm, as cold', async () => {
    const site = await loadSite(new URL('examples/hello/semblance.config.ts', root).pathname)
    const assets = new URL('test/fixtures/', root).pathname
    const handler = (warm: boolean) => createHandler({ site, assets, template: new URL('examples/hello/index.html', root).pathname, warm })
    const [warm, cold] = [handler(true), handler(false)]
    for (const url of ['/', '/', '/index.html']) {
      const [a, b] = await Promise.all([warm(new Request('http://localhost' + url)), cold(new Request('http://localhost' + url))])
      expect(a.status).toBe(b.status)
      expect(await a.text()).toBe(await b.text())
    }
    const page = await (await warm(new Request('http://localhost/'))).text()
    expect(page).toContain('<strong>0 cups</strong>')
  })
})
