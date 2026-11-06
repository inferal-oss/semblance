import { parseHTML } from 'linkedom'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadStore, loadStoreOf, ontologyFiles } from '../src/node/load.ts'
import { loadSite, namedGraphs, pageGraphs, renderSite, siteRoutes } from '../src/node/site.ts'
import { Navigation, setBase } from '../src/navigation.ts'
import { MOD } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { parseTurtle, Runtime } from '../src/runtime.ts'
import { renderDocument } from '../src/server/document.ts'
import type { Site } from '../src/server/site.ts'
import { graphLanguages, serializeRoot } from '../src/server/render.ts'
import { sliceAddition } from '../src/slices.ts'
import { sourceQuads } from '../src/sources.ts'
import { takeOver } from '../src/web/takeover.ts'
import { prepareSite, ROOT, siteLayers, siteSources, UI } from '../demo/site.ts'

// A page rendered beforehand names the graphs its client needs first, and those can hold a
// rendering's function rule without its SPARQL twin (ontology/components/walkthrough.ttl and
// walkthrough-diagram.ttl). When the rest arrive the twin takes over, also for what is not shown
// yet: a page reached by a click afterwards is the page loaded directly (#332).

const TEMPLATE = '<!doctype html><html lang="en"><head><title>t</title></head><body><div id="app"></div></body></html>'
const config = new URL('../semblance.config.ts', import.meta.url).pathname
const load = { load: (...t: string[]) => loadStore('wat', ...t) }

/** The site's client up to its first render, with the graphs `only` names, or all of them. */
async function client(site: Site, url: string, only?: string[]) {
  const named = await namedGraphs(site)
  const graphs = Object.entries(named).filter(([n]) => !only || only.includes(n)).map(([, t]) => t)
  const store = only ? loadStoreOf('wat', only, ...graphs) : loadStore('wat', ...graphs)
  site.setup?.(store, { single: false, ...(only && { graphs: new Set(only) }) })
  setBase(store, '/')
  const u = new URL(url, 'https://semblance.test/')
  await new Navigation(store, { root: ROOT, location: { pathname: u.pathname, search: u.search, hash: u.hash }, history: { pushState() {}, replaceState() {} }, events: new EventTarget(), links: new EventTarget() }).restore()
  prepareSite(store, { kind: 'wat', prefer: 'sparql', compile: 'off' })
  const runtime = new Runtime(store)
  const errors: string[] = []
  const screen = runtime.project({ modality: MOD.Screen, layers: siteLayers(store), prefer: 'sparql', provenance: 'onDemand', languages: graphLanguages(store, ROOT), name: 'screen', roots: [ROOT] }, (e) => errors.push(e.message))
  return { store, runtime, screen, errors }
}
type Client = Awaited<ReturnType<typeof client>>

/** A client of a page rendered beforehand: it took the page over with the graphs the page names. */
async function takenOver(site: Site, url: string) {
  const server = await renderSite(site, url)
  const only = await pageGraphs(site, url, server.html, { base: '/' })
  expect(only).toBeDefined()
  const page = renderDocument(TEMPLATE, server)
  server.runtime.dispose()
  const c = await client(site, url, only)
  const { document } = parseHTML(page)
  const host = document.getElementById('app')!
  for (const area of host.querySelectorAll('textarea')) area.textContent = area.textContent!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  const renderer = new DomRenderer(c.screen.index, host, ROOT)
  takeOver(renderer)
  renderer.flush()
  return { ...c, renderer, host, only: only! }
}

/** The rest of the graphs, with the sources of the examples among them, as the client takes them in (demo/main.ts). */
async function restOf(site: Site, c: Awaited<ReturnType<typeof takenOver>>) {
  const named: Record<string, string> = { ...ontologyFiles(), ...(await namedGraphs(site)) }
  const rest = Object.keys(named).filter((n) => !c.only.includes(n))
  const add = rest.flatMap((n) => parseTurtle(named[n]!, c.store.factory))
  add.push(...sourceQuads(c.store.factory, siteSources(Object.fromEntries(rest.filter((n) => n.startsWith('demo/gallery/')).map((n) => [n, named[n]!])))))
  return sliceAddition(add, 150)
}

/** All of the rest: what defines rules, then slices. */
async function loadRest(site: Site, c: Awaited<ReturnType<typeof takenOver>>) {
  const { rules, rest } = await restOf(site, c)
  c.runtime.apply({ add: rules, remove: [] })
  c.renderer.flush()
  for (const slice of rest) c.runtime.apply({ add: slice, remove: [] })
  c.renderer.flush()
}

/** What the app states about where we are, as a click into the page `to` has it state. */
function follow(c: Client & { renderer: DomRenderer }, to: Client) {
  const app = c.store.factory.namedNode(UI + 'app')
  const dg = c.store.factory.defaultGraph()
  const here = c.store.match(app, null, null, dg)
  const there = to.store.match(app, null, null, dg)
  const named = (q: { predicate: { value: string }; object: { termType: string; value: string } }) => q.predicate.value + ' ' + q.object.termType + ' ' + q.object.value
  const have = new Set(here.map(named))
  const want = new Set(there.map(named))
  c.runtime.apply({ add: there.filter((q) => !have.has(named(q))), remove: here.filter((q) => !want.has(named(q))) })
  c.renderer.flush()
}

const walkthroughs = (root: ParentNode) => [...root.querySelectorAll('[data-sem-c=walkthrough]')].filter((w) => !w.closest('[hidden]')).map((w) => w.outerHTML)

describe('a page reached by a click after the deferred graphs', () => {
  let site: Site
  /** Each page with a walkthrough, as its client renders it when loaded directly. */
  const direct = new Map<string, { walks: string[]; client: Client }>()

  beforeAll(async () => {
    site = await loadSite(config)
    const routes = (await siteRoutes(site)).filter((r) => /^\/(docs|examples)\//.test(r) || ['/components/windows/', '/components/layout/', '/components/type/'].includes(r))
    for (const url of routes) {
      const c = await client(site, url)
      const { document } = parseHTML(TEMPLATE)
      const host = document.getElementById('app')!
      new DomRenderer(c.screen.index, host, ROOT).flush()
      const walks = walkthroughs(host)
      if (walks.length) direct.set(url, { walks, client: c })
      else c.runtime.dispose()
    }
    expect(direct.size).toBeGreaterThan(10)
  }, 600_000)

  afterAll(() => {
    for (const { client: c } of direct.values()) c.runtime.dispose()
  })

  it.each(['/', '/docs/overview/', '/components/themes/', '/de/components/themes/'])('from %s: the todo example and the docs on rules', async (from) => {
    const c = await takenOver(site, from)
    await loadRest(site, c)
    for (const url of ['/examples/todo/', '/docs/rules/']) {
      const to = direct.get(from.startsWith('/de/') ? '/de' + url : url) ?? direct.get(url)!
      follow(c, to.client)
      if (!from.startsWith('/de/')) expect(walkthroughs(c.host)).toEqual(to.walks)
      expect(c.errors).toEqual([])
    }
    c.runtime.dispose()
  }, 180_000)

  // The list of steps comes in a slice before the steps' own descriptions: a step has no title yet.
  it('a click while the rest arrive: no error at any slice, and the same page at the end', async () => {
    const to = direct.get('/examples/checkout/')!
    for (const at of [-1, 0, 40]) {
      const c = await takenOver(site, '/components/themes/')
      const { rules, rest } = await restOf(site, c)
      if (at === -1) follow(c, to.client)
      c.runtime.apply({ add: rules, remove: [] })
      c.renderer.flush()
      rest.forEach((slice, i) => {
        if (i === at) follow(c, to.client)
        c.runtime.apply({ add: slice, remove: [] })
        c.renderer.flush()
        expect(c.errors, `click at ${at}, slice ${i}`).toEqual([])
      })
      const [got, want] = [walkthroughs(c.host).join(), to.walks.join()]
      let i = 0
      while (i < got.length && got[i] === want[i]) i++
      expect(got === want ? '' : `click at ${at}, at ${i}:\n  got:  ${got.slice(Math.max(0, i - 200), i + 200)}\n  want: ${want.slice(Math.max(0, i - 200), i + 200)}`).toBe('')
      c.runtime.dispose()
    }
  }, 300_000)

  it('from /: every page with a walkthrough', async () => {
    const c = await takenOver(site, '/')
    await loadRest(site, c)
    for (const [url, to] of direct) {
      follow(c, to.client)
      expect(walkthroughs(c.host), url).toEqual(to.walks)
      expect(c.errors, url).toEqual([])
    }
    c.runtime.dispose()
  }, 300_000)
})
