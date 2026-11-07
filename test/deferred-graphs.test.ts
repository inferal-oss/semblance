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
// yet: a page reached by a click afterwards is the page loaded directly (#332). And what was
// evaluated before they arrived is evaluated again (Runtime.reread), whatever it read: every page
// reached by a click, before or after they arrive, is the page loaded directly (#350).

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
  c.runtime.arriving(true)
  c.runtime.apply({ add: rules, remove: [] })
  c.renderer.flush()
  for (const slice of rest) c.runtime.apply({ add: slice, remove: [] })
  c.runtime.arriving(false)
  c.renderer.flush()
  idle(c)
}

/** Idle time, and the frames in it: everything idle time may evaluate is evaluated. */
function idle(c: Client & { renderer: DomRenderer }) {
  while (c.runtime.warm(20));
  c.runtime.refresh()
  while (c.runtime.warm(20));
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

const walkthroughs = (root: ParentNode) => [...root.querySelectorAll('[data-sem-c=walkthrough]')].filter((w) => !w.closest('[hidden]')).map((w) => shown(w).join('\n'))

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
      c.runtime.arriving(true)
      c.runtime.apply({ add: rules, remove: [] })
      c.renderer.flush()
      rest.forEach((slice, i) => {
        if (i === at) follow(c, to.client)
        c.runtime.apply({ add: slice, remove: [] })
        c.renderer.flush()
        expect(c.errors, `click at ${at}, slice ${i}`).toEqual([])
      })
      c.runtime.arriving(false)
      c.renderer.flush()
      expect(c.errors, `click at ${at}, when all had arrived`).toEqual([])
      idle(c)
      expect(c.errors, `click at ${at}, reading again`).toEqual([])
      const [got, want] = [walkthroughs(c.host).join(), to.walks.join()]
      let i = 0
      while (i < got.length && got[i] === want[i]) i++
      expect(got === want ? '' : `click at ${at}, at ${i}:\n  got:  ${got.slice(Math.max(0, i - 200), i + 200)}\n  want: ${want.slice(Math.max(0, i - 200), i + 200)}`).toBe('')
      c.runtime.dispose()
    }
  }, 300_000)

  // l10n:Labels is evaluated for every component, shown or not: a translated label on another page
  // is no reason to load that page's graph first (#355).
  it('a page does not need the graph of a page it does not show, for a label in its languages', async () => {
    const url = '/components/themes/'
    const server = await renderSite(site, url)
    const only = await pageGraphs(site, url, server.html, { base: '/' })
    server.runtime.dispose()
    expect(only).toBeDefined()
    expect(only).not.toContain('demo/gallery/_ex-checkout.ttl')
    expect(only).not.toContain('demo/gallery/_ex-budget.ttl')
  }, 60_000)

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

/** One line per element and text shown: its place and its attributes (the status bar counts interactions). */
function shown(host: Element): string[] {
  const out: string[] = []
  const walk = (n: Element, path: string) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) {
        if (c.textContent!.trim()) out.push(`${path} ${JSON.stringify(c.textContent)}`)
        continue
      }
      const el = c as Element
      if (el.nodeType !== 1 || el.hasAttribute('hidden') || el.getAttribute('data-sem-c') === 'status-bar') continue
      const attrs = [...el.attributes].map((a) => `${a.name}=${a.value}`).sort().join(' ')
      // (linkedom keeps an SVG element's case only when it creates it.)
      const name = el.localName.toLowerCase()
      out.push(`${path}>${name} ${attrs}`)
      walk(el, `${path}>${name}`)
    }
  }
  walk(host, '')
  return out
}

/** What differs between two pages, briefly ('' when they are the same). */
function difference(got: string[], want: string[]): string {
  const [g, w] = [new Set(got), new Set(want)]
  const brief = (l: string) => l.split('>').slice(-2).join('>').slice(0, 200)
  const missing = want.filter((l) => !g.has(l))
  const extra = got.filter((l) => !w.has(l))
  return missing.length || extra.length ? `${missing.length} missing, ${extra.length} extra\n${missing.slice(0, 5).map((l) => '  - ' + brief(l)).join('\n')}\n${extra.slice(0, 5).map((l) => '  + ' + brief(l)).join('\n')}` : ''
}

describe('every page reached by a click is the page loaded directly', () => {
  const FROM = '/components/themes/'
  let site: Site
  let routes: string[]

  beforeAll(async () => {
    site = await loadSite(config)
    routes = (await siteRoutes(site)).filter((r) => /^\/(docs|examples|components)\//.test(r) && r !== FROM)
    expect(routes.length).toBeGreaterThan(40)
  }, 60_000)

  /** The page `url` as a client that loaded it directly has it, with `use` to compare it to. */
  async function direct(url: string, use: (c: Client, page: string[]) => void | Promise<void>) {
    const c = await client(site, url)
    const { document } = parseHTML(TEMPLATE)
    const host = document.getElementById('app')!
    const renderer = new DomRenderer(c.screen.index, host, ROOT)
    renderer.flush()
    idle({ ...c, renderer })
    await use(c, shown(host))
    c.runtime.dispose()
  }

  it('a click after the rest arrived', async () => {
    const wrong: string[] = []
    for (const url of routes) {
      const c = await takenOver(site, FROM)
      await loadRest(site, c)
      await direct(url, (to, want) => {
        follow(c, to)
        idle(c)
        const diff = difference(shown(c.host), want)
        if (diff || c.errors.length) wrong.push(`${url}: ${diff} ${c.errors[0] ?? ''}`)
      })
      c.runtime.dispose()
    }
    expect(wrong).toEqual([])
  }, 900_000)

  it('a click before the rest arrive', async () => {
    const wrong: string[] = []
    for (const url of routes) {
      const c = await takenOver(site, FROM)
      await direct(url, async (to, want) => {
        follow(c, to)
        await loadRest(site, c)
        // (A text in every language may say so in passing, before the graph that picks one: not what is left at the end.)
        const diff = difference(shown(c.host), want)
        if (diff) wrong.push(`${url}: ${diff}`)
      })
      c.runtime.dispose()
    }
    expect(wrong).toEqual([])
  }, 900_000)

  it('reading again changes nothing on a page that had everything', async () => {
    const wrong: string[] = []
    for (const url of routes) {
      await direct(url, (c, want) => {
        const { document } = parseHTML(TEMPLATE)
        const host = document.getElementById('app')!
        const renderer = new DomRenderer(c.screen.index, host, ROOT)
        renderer.flush()
        const changes: string[] = []
        c.screen.engine.onChange((d) => changes.push(...[...d.add, ...d.remove].map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`)))
        c.runtime.reread()
        idle({ ...c, renderer })
        const diff = difference(shown(host), want)
        if (diff || changes.length) wrong.push(`${url}: ${diff} ${changes.slice(0, 5).join('; ')}`)
      })
    }
    expect(wrong).toEqual([])
  }, 600_000)
})
