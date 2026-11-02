import { existsSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadSite, renderSite } from '../src/node/site.ts'
import { resolveUrl } from '../src/render/html-index.ts'

// Relative URLs in a site's data (an image's c:image "photos/harbour.jpg") resolve against where the
// site is served (nav:base), not against the page's own path: the same file on every page (#272).

const root = new URL('../', import.meta.url)
const PUBLIC = new URL('demo/public/', root).pathname

describe('relative URLs', () => {
  it('resolve against the base, and anything anchored stays as written', () => {
    expect(resolveUrl('photos/a.jpg', '/')).toBe('/photos/a.jpg')
    expect(resolveUrl('./photos/a.jpg', '/sub/')).toBe('/sub/photos/a.jpg')
    for (const v of ['/photos/a.jpg', '//cdn.example/a.jpg', 'https://example.org/a.jpg', 'data:image/png;base64,AA', 'mailto:a@b', '#top', '?q=1', ''])
      expect(resolveUrl(v, '/sub/')).toBe(v)
  })

  it.each([
    ['/', '/examples/photos/'],
    ['/', '/components/data/'],
    ['/', '/components/overlays/'],
    ['/sub/', '/sub/examples/photos/'],
  ])('on a page at a nested path, name files that exist (base %s, %s)', async (base, url) => {
    const site = await loadSite(new URL('semblance.config.ts', root).pathname)
    const server = await renderSite(site, url, { base })
    expect(server.status).toBe(200)
    const { document } = parseHTML(`<!doctype html><html><body>${server.html}</body></html>`)
    const srcs = [...document.querySelectorAll('img[src]')].map((i) => i.getAttribute('src')!).filter((s) => !s.startsWith('data:'))
    expect(srcs.length).toBeGreaterThan(0)
    for (const src of srcs) {
      expect(src.startsWith(base), src).toBe(true)
      expect(existsSync(PUBLIC + src.slice(base.length)), src).toBe(true)
    }
    server.runtime.dispose()
  })

  it.each(['sparql', 'function'] as const)('show a list item its thumbnail (c:itemImage), the same from either rule (%s)', async (prefer) => {
    const site = await loadSite(new URL('semblance.config.ts', root).pathname)
    const server = await renderSite(site, '/examples/photos/', { prefer })
    const { document } = parseHTML(`<!doctype html><html><body>${server.html}</body></html>`)
    const order = [...document.querySelectorAll('[data-sem-c=list]')].find((l) => l.getAttribute('aria-label') === 'Order')!
    expect([...order.querySelectorAll('img.sem-thumb')].map((i) => i.getAttribute('src'))).toEqual(['/photos/harbour.jpg', '/photos/lighthouse.jpg', '/photos/dunes.webp', '/photos/forest.jpg'])
    server.runtime.dispose()
  })
})
