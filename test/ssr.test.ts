import { readdirSync, readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore } from '../src/node/load.ts'
import { loadSite, renderSite, siteRoutes } from '../src/node/site.ts'
import { Navigation } from '../src/navigation.ts'
import { MOD, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { renderDocument } from '../src/server/document.ts'
import { graphLanguages, serializeRoot } from '../src/server/render.ts'
import { renderToStream } from '../src/server/stream.ts'
import type { Site } from '../src/server/site.ts'
import type { GraphStore } from '../src/store/types.ts'
import { DEFAULT_LAYERS } from '../src/web/mount.ts'
import { replayKept, takeOver } from '../src/web/takeover.ts'
import { prepareSite, recordSiteSources, ROOT, siteGraphs, siteLayers } from '../demo/site.ts'

// Server-side rendering (docs/SSR.md): a page rendered beforehand (the build) or per request is
// byte for byte the client's first render of the same address, so the client adopts its DOM
// without creating a node; what the visitor did meanwhile is replayed.

const root = new URL('../', import.meta.url)
const TEMPLATE = '<!doctype html><html lang="en"><head><title>t</title></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>'

/** The site's client up to its first render, as demo/main.ts runs it (empty storage). */
async function siteClient(url: string, extra?: (store: GraphStore) => void) {
  const site = await loadSite(new URL('semblance.config.ts', root).pathname)
  const graphs = await site.graphs()
  const store = loadStore('wat', ...graphs)
  site.setup?.(store, { single: false })
  extra?.(store)
  const u = new URL(url, 'https://semblance.test/')
  const location = { pathname: u.pathname, search: u.search, hash: u.hash }
  await new Navigation(store, { root: ROOT, location, history: { pushState() {}, replaceState() {} }, events: new EventTarget(), links: new EventTarget() }).restore()
  prepareSite(store, { kind: 'wat', prefer: 'sparql', compile: 'off' })
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: siteLayers(store), prefer: 'sparql', provenance: 'onDemand', languages: graphLanguages(store, ROOT), name: 'screen', roots: [ROOT] })
  // Its live examples as its sandboxes render them first (test/ssr-live.test.ts takes them over).
  return { store, runtime, screen, html: serializeRoot(runtime, screen, ROOT, { sandboxes: { load: (...t) => loadStore('wat', ...t) }, prefer: 'sparql' }) }
}

/** The site with a theme on its shell (as a visitor who chose it would have it restored). */
const themed = (site: Site, theme: string): Site => ({ ...site, setup: (s, ctx) => (site.setup?.(s, ctx), setTheme(s, theme)) })
function setTheme(store: GraphStore, theme: string) {
  const f = store.factory
  const shell = f.namedNode(ROOT)
  for (const q of store.match(shell, f.namedNode(NS.sty + 'theme'), null)) store.delete(q)
  store.add(f.quad(shell, f.namedNode(NS.sty + 'theme'), f.namedNode(NS.sty + theme)))
}

/** Parse a server's document, take it over with the client's projection: what adopting it found and the first flush did. */
function adopt(page: string, client: { screen: { index: DomRenderer['index'] } }) {
  const { document } = parseHTML(page)
  const host = document.getElementById('app')!
  // A browser decodes character references in a <textarea> (its text is RCDATA); linkedom keeps
  // them as written: decode them, as the page a browser parsed has them.
  for (const area of host.querySelectorAll('textarea')) area.textContent = area.textContent!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  const renderer = new DomRenderer(client.screen.index, host, ROOT)
  const t = takeOver(renderer)
  renderer.flush()
  return { mismatches: t.mismatches, nodes: t.nodes, ops: renderer.ops, host }
}

describe('server-side rendering: the site', () => {
  it('lists every place its location names, in every language', async () => {
    const site = await loadSite(new URL('semblance.config.ts', root).pathname)
    const routes = await siteRoutes(site)
    const english = routes.filter((r) => !/^\/(uk|de|ar)\//.test(r))
    // Every place in every language, the Reference's terms in English only (semblance.config.ts).
    const terms = english.filter((r) => /^\/reference\/[^/]+\/$/.test(r))
    expect(terms.length).toBeGreaterThan(1000)
    expect(routes.length).toBe((english.length - terms.length) * 4 + terms.length)
    expect(english).toContain('/reference/c:Window/')
    expect(english).toContain('/')
    expect(english).toContain('/docs/')
    expect(english).toContain('/docs/rules/')
    expect(english).toContain('/components/inputs/')
    expect(english).toContain('/examples/kanban/')
    expect(english).toContain('/reference/')
    expect(routes).toContain('/ar/examples/kanban/')
    expect(english.some((r) => r.includes('home'))).toBe(false) // the home page is /
  })

  it.each(['/', '/docs/rules/', '/uk/components/inputs/', '/ar/examples/kanban/', '/de/reference/', '/examples/sheet/'])('renders %s as the client first renders it, and the client adopts it as it is', async (url) => {
    const site = await loadSite(new URL('semblance.config.ts', root).pathname)
    const server = await renderSite(site, url)
    const client = await siteClient(url)
    expect(server.html).toBe(client.html)
    expect(server.status).toBe(200)
    const lang = url.match(/^\/(uk|de|ar)\//)?.[1] ?? 'en'
    expect(server.lang).toBe(lang)
    expect(server.dir).toBe(lang === 'ar' ? 'rtl' : 'ltr')
    const page = renderDocument(TEMPLATE, server, { stylesheet: { href: '/semblance.css' }, attributes: server.attributes })
    const taken = adopt(page, client)
    expect(taken.mismatches).toBe(0)
    expect(taken.ops).toBe(0)
    expect(taken.nodes).toBeGreaterThan(100)
    server.runtime.dispose()
    client.runtime.dispose()
  })

  it.each(['Semblance', 'Paper', 'Terminal', 'Blueprint', 'Sunset', 'Cupertino', 'Tracker', 'Classic', 'Fluent', 'Doodle'])('renders the same in the %s theme', async (theme) => {
    const site = themed(await loadSite(new URL('semblance.config.ts', root).pathname), theme)
    const server = await renderSite(site, '/docs/overview/')
    const client = await siteClient('/docs/overview/', (s) => setTheme(s, theme))
    expect(server.html).toBe(client.html)
    expect(server.html).toContain(`data-sem-theme="${theme.toLowerCase()}"`)
    expect(adopt(renderDocument(TEMPLATE, server), client).mismatches).toBe(0)
    server.runtime.dispose()
    client.runtime.dispose()
  })

  it('renders the pages of a dimension shown in place one after another as each renders alone (nav:rendersInPlace)', async () => {
    const site = await loadSite(new URL('semblance.config.ts', root).pathname)
    const { renderPages } = await import('../src/node/site.ts')
    const { mkdtempSync, readFileSync: read } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const out = mkdtempSync(tmpdir() + '/sem-ssr-')
    const group = ['/reference/', '/reference/c:List/', '/reference/sem:Rule/', '/reference/nav:Path/']
    await renderPages({ config: new URL('semblance.config.ts', root).pathname, outDir: out, template: TEMPLATE, head: '', single: false, base: '/', routes: [group], styles: false })
    for (const url of group.slice(1)) {
      const alone = await renderSite(site, url)
      expect(read(out + url + 'index.html', 'utf8'), url).toContain('<div id="app" data-sem-ssr>' + alone.html + '</div>')
      alone.runtime.dispose()
    }
  })

  it('says 404 for a place no location names, and renders the default', async () => {
    const site = await loadSite(new URL('semblance.config.ts', root).pathname)
    const r = await renderSite(site, '/no/such/place/')
    expect(r.status).toBe(404)
    expect(r.html).toContain('data-sem-c="app-bar"')
    r.runtime.dispose()
  })
})

describe('server-side rendering: an app (the getting-started example)', () => {
  const hello = () => loadSite(new URL('examples/hello/semblance.config.ts', root).pathname)
  const EX = 'https://example.org/hello#'

  it('is taken over by its client, and a click made before that counts', async () => {
    const site = await hello()
    const server = await renderSite(site, '/')
    const page = renderDocument(TEMPLATE, server)
    expect(page).toContain('<div id="app" data-sem-ssr>')
    expect(page).toContain('<style data-sem-styles>')
    expect(page).toContain('__semblanceKept') // the capture script
    const { document, window } = parseHTML(page)
    const host = document.getElementById('app')!
    // The visitor clicked the button before the client was ready; the capture script kept it.
    const button = host.querySelector('[data-sem-c=button]')!
    const early = new window.Event('click', { bubbles: true })
    Object.defineProperty(early, 'target', { value: button })
    ;(globalThis as { __semblanceKept?: unknown }).__semblanceKept = { events: [early], stop() {} }

    // The client, as mount() does: the same graphs, the same root, its own projection.
    const store = loadStore('wat', ...(await site.graphs()))
    const runtime = new Runtime(store)
    const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, languages: graphLanguages(store, site.root), name: 'screen', roots: [site.root] })
    const renderer = new DomRenderer(screen.index, host, site.root)
    const t = takeOver(renderer)
    expect(t.mismatches).toBe(0)
    expect(host.hasAttribute('data-sem-ssr')).toBe(false)
    new EventBus(runtime, screen).attach(renderer, () => renderer.flush())
    renderer.flush()
    expect(renderer.ops).toBe(0)
    expect(renderer.nodeOf(EX + 'drink/~root')).toBe(button) // the server's node, not a new one
    expect(t.replay()).toBe(1)
    expect(host.querySelector('[data-sem-c=ex-tally]')!.textContent).toContain('1')
    expect(replayKept(host)).toBe(0) // once
    server.runtime.dispose()
    runtime.dispose()
  })

  it('streams the head before the projection, then the root', async () => {
    const site = await hello()
    const store = loadStore('wat', ...(await site.graphs()))
    const chunks: string[] = []
    let status = 0
    const reader = renderToStream({ store, root: site.root, url: '/', template: TEMPLATE, stylesheet: { href: '/semblance.css' }, onStatus: (s) => (status = s) }).getReader()
    for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(new TextDecoder().decode(r.value))
    expect(status).toBe(200)
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toContain('<link rel="stylesheet" href="/semblance.css" data-sem-styles>')
    expect(chunks[0]!.endsWith('<div id="app" data-sem-ssr>')).toBe(true)
    expect(chunks[1]).toContain('Hello, Semblance')
    expect(chunks.join('')).toContain('</html>')
  })
})

describe('server-side rendering: documents', () => {
  it('puts the language, direction and attributes on <html>, and takes the HTML as it is', () => {
    const doc = renderDocument(TEMPLATE, { html: '<p>$& $1 cost</p>', css: 'p{}', lang: 'ar', dir: 'rtl' }, { attributes: { 'data-sem-color-scheme': 'dark' }, head: '<link rel="modulepreload" href="/a.js">' })
    expect(doc).toContain('<html lang="ar" dir="rtl" data-sem-color-scheme="dark">')
    expect(doc).toContain('<div id="app" data-sem-ssr><p>$& $1 cost</p></div><script>')
    expect(doc).toContain('<style data-sem-styles>p{}</style><link rel="modulepreload" href="/a.js"></head>')
    expect(() => renderDocument('<html><body></body></html>', { html: '', lang: 'en', dir: 'ltr' })).toThrow(/no empty <div id="app">/)
  })
})

describe('provenance on demand', () => {
  it('is recorded from when a rendering that reads it first runs, for what was derived before too', () => {
    const app = readFileSync(new URL('demo/app.ttl', root), 'utf8')
    const gallery = Object.fromEntries(readdirSync(new URL('demo/gallery/', root)).filter((f) => f.endsWith('.ttl')).map((f) => ['demo/gallery/' + f, readFileSync(new URL('demo/gallery/' + f, root), 'utf8')]))
    const project = (provenance: boolean | 'onDemand') => {
      const store = loadStore('wat', ...siteGraphs(app, gallery))
      recordSiteSources(store, gallery)
      const runtime = new Runtime(store)
      const screen = runtime.project({ modality: MOD.Screen, layers: siteLayers(store), provenance, name: 'screen', roots: [ROOT] })
      return { store, runtime, screen, derived: () => store.match(null, null, null, screen.engine.graph).length }
    }
    const always = project(true)
    const lazy = project('onDemand')
    expect(toHTML(lazy.screen.index, ROOT)).toBe(toHTML(always.screen.index, ROOT))
    const prov = (p: ReturnType<typeof project>) => p.store.match(null, p.store.factory.namedNode(NS.prov + 'wasGeneratedBy'), null, p.screen.engine.graph).length
    expect(prov(lazy)).toBe(0) // nothing on the landing page reads it
    lazy.screen.engine.recordProvenance()
    expect(prov(lazy)).toBe(prov(always))
    expect(lazy.derived()).toBe(always.derived())
    always.runtime.dispose()
    lazy.runtime.dispose()
  })
})
