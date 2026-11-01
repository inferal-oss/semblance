import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { loadSite, namedGraphs, renderSite } from '../src/node/site.ts'
import { Navigation } from '../src/navigation.ts'
import { DEFAULT_LAYERS, MOD, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { exampleSpec, Sandboxes } from '../src/sandbox.ts'
import { renderDocument } from '../src/server/document.ts'
import { graphLanguages, renderToString } from '../src/server/render.ts'
import type { GraphStore } from '../src/store/types.ts'
import { takeOver } from '../src/web/takeover.ts'
import { prepareSite, ROOT, siteLayers } from '../demo/site.ts'

// Live examples rendered on the server (#220, docs/SSR.md): each one shown has its sandbox built at
// build time as the browser builds it, its rendering, data and text serialized into its slots, and
// the client takes those over when its own sandbox runs, without creating a node.

const root = new URL('../', import.meta.url)
const TEMPLATE = '<!doctype html><html lang="en"><head><title>t</title></head><body><div id="app"></div></body></html>'
const UI = 'https://semblance.dev/demo#'
const load = (...t: string[]) => loadStore('wat', ...t)

const site = () => loadSite(new URL('semblance.config.ts', root).pathname)

/** The site's client up to its first render, as demo/main.ts runs it (empty storage). */
async function siteClient(url: string) {
  const s = await site()
  const store = loadStore('wat', ...Object.values(await namedGraphs(s)))
  s.setup?.(store, { single: false })
  const u = new URL(url, 'https://semblance.test/')
  await new Navigation(store, { root: ROOT, location: { pathname: u.pathname, search: u.search, hash: u.hash }, history: { pushState() {}, replaceState() {} }, events: new EventTarget(), links: new EventTarget() }).restore()
  prepareSite(store, { kind: 'wat', prefer: 'sparql', compile: 'off' })
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: siteLayers(store), prefer: 'sparql', provenance: 'onDemand', languages: graphLanguages(store, ROOT), name: 'screen', roots: [ROOT] })
  return { store, runtime, screen }
}

/** The client's live examples over `host` (its renderer's), built at once (the site defers them until seen). */
function liveExamples(client: Awaited<ReturnType<typeof siteClient>>, renderer: DomRenderer) {
  const sandboxes = new Sandboxes(client.runtime, client.screen, {
    renderer,
    shown: (c) => client.screen.index.isShown(c, new Set([renderer.rootFocus])),
    flush: () => flush(),
    load,
    prefer: 'sparql',
    languages: () => [...client.screen.engine.languages],
  })
  const flush = () => {
    renderer.flush()
    sandboxes.sync()
  }
  sandboxes.attach()
  return { sandboxes, flush }
}

/** A server's page parsed, and its mount element (a browser decodes a <textarea>'s references; linkedom does not). */
function parsed(page: string) {
  const { document, window } = parseHTML(page)
  const host = document.getElementById('app')!
  for (const area of host.querySelectorAll('textarea')) area.textContent = area.textContent!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  return { document, window, host }
}

describe('live examples rendered on the server', () => {
  it("puts the home page's todo in its HTML: its items, its data and its text", async () => {
    const server = await renderSite(await site(), '/')
    const { host } = parsed(renderDocument(TEMPLATE, server))
    const ex = host.querySelector('[data-sem-c=live-example]')!
    // The frame says it is waiting for its sandbox, and the panes already show it.
    expect(ex.getAttribute('data-sem-state')).toBe('pending')
    expect([...ex.querySelectorAll('.sem-live-screen li')].map((li) => li.textContent)).toEqual(['Write the core ontology', 'Sketch the style layer', 'Wire up behaviour'])
    const data = ex.querySelector('.sem-live-data [data-sem-c=rdf-editor]')!
    expect([...data.querySelectorAll('.sem-resource > .sem-row > .sem-label')].map((l) => l.textContent)).toEqual(['ex:t1', 'ex:t2', 'ex:t3'])
    expect(data.querySelector('[data-sem-change]')).toBeNull() // nothing has changed yet
    expect(ex.querySelector('.sem-live-text')!.textContent).toContain('[x] Write the core ontology')
    server.runtime.dispose()
  })

  it('builds one sandbox per example shown, and lets each go once serialized', async () => {
    const s = await site()
    const store = loadStore('wat', ...Object.values(await namedGraphs(s)))
    s.setup?.(store, { single: false })
    const loaded: GraphStore[] = []
    const disposed = new Set<GraphStore>()
    const counted = (...t: string[]) => {
      const st = load(...t)
      const own = st.dispose?.bind(st)
      st.dispose = () => (disposed.add(st), own?.())
      loaded.push(st)
      return st
    }
    const r = await renderToString({ store, root: ROOT, url: '/docs/start/', prepare: s.prepare, layers: s.layers?.(store), styles: false, sandboxes: { load: counted } })
    const shown = (r.html.match(/<div data-sem-sandbox="ssr-\d+"/g) ?? []).length
    expect(shown).toBeGreaterThanOrEqual(3)
    expect(loaded.length).toBe(shown)
    expect(loaded.every((st) => disposed.has(st))).toBe(true)
    r.runtime.dispose()
  })

  it.each(['/', '/docs/start/'])('on %s, is taken over by the client: no node is created, and the example is live once its sandbox runs', async (url) => {
    const server = await renderSite(await site(), url)
    const { host, window } = parsed(renderDocument(TEMPLATE, server, { stylesheet: { href: '/semblance.css' } }))
    const client = await siteClient(url)
    const renderer = new DomRenderer(client.screen.index, host, ROOT)
    expect(takeOver(renderer).mismatches).toBe(0)
    // What the server put in the slots, before the client's sandboxes run.
    const panes = [...host.querySelectorAll('.sem-live-screen, .sem-live-data, .sem-live-text')].map((slot) => [...slot.children].find((c) => c.localName === 'div')!)
    const inside = panes.map((p) => [...p.querySelectorAll('*')])
    expect(panes.length).toBeGreaterThanOrEqual(3)
    const { sandboxes, flush } = liveExamples(client, renderer)
    flush()
    expect(sandboxes.adopted.mismatches).toBe(0)
    expect(sandboxes.adopted.nodes).toBeGreaterThan(20)
    // The sandboxes created nothing; the site patched only the frames (pending, then live).
    const f = client.store.factory
    for (const q of client.store.match(null, f.namedNode(NS.rdf + 'type'), f.namedNode(NS.c + 'LiveExample'))) expect(sandboxes.rendererOf(q.subject.value)?.ops ?? 0).toBe(0)
    // The same elements, all of them; the server's numbering and styles are the client's now.
    panes.forEach((p, i) => {
      expect(p.isConnected).toBe(true)
      expect(inside[i]!.every((el) => el.isConnected)).toBe(true)
    })
    expect(host.querySelector('[data-sem-sandbox^="ssr-"], [data-sem-sandbox-styles]')).toBeNull()
    for (const ex of host.querySelectorAll('[data-sem-c=live-example]')) expect(ex.getAttribute('data-sem-state')).toBe('live')
    // And it works: a todo ticked in the taken-over rendering changes the example's data.
    if (url === '/') {
      const box = [...host.querySelectorAll('.sem-live-screen li')].find((li) => li.textContent!.includes('Sketch'))!.querySelector('input')!
      expect(inside.some((els) => els.includes(box))).toBe(true)
      box.checked = true
      box.dispatchEvent(new window.Event('change', { bubbles: true }))
      expect(host.querySelector('.sem-live-data [data-sem-change=added]')).not.toBeNull()
      expect(host.querySelector('.sem-live-text')!.textContent).toContain('[x] Sketch the style layer')
    }
    sandboxes.dispose()
    server.runtime.dispose()
    client.runtime.dispose()
  })

  it.each(['/', '/docs/start/', '/docs/recipes/', '/ar/docs/styling/', '/uk/docs/views/'])('on %s, renders each pane as the client renders it', async (url) => {
    const server = await renderSite(await site(), url, { styles: false })
    // The client from nothing: no server HTML to take over.
    const client = await siteClient(url)
    const { document } = parseHTML(TEMPLATE)
    const renderer = new DomRenderer(client.screen.index, document.getElementById('app')!, ROOT)
    const { sandboxes, flush } = liveExamples(client, renderer)
    flush()
    let examples = 0
    for (const q of client.store.match(null, client.store.factory.namedNode(NS.rdf + 'type'), client.store.factory.namedNode(NS.c + 'LiveExample'))) {
      const sb = sandboxes.sandboxOf(q.subject.value)
      if (!sb) continue
      examples++
      expect(server.html).toContain(`>${toHTML(sb.screen.index, sb.root)}</div>`)
      if (sb.text) expect(server.html).toContain(`<div>${toHTML(sb.text.index, sb.root)}</div>`)
      if (sb.data) expect(server.html).toContain(`<div>${toHTML(sb.data.index, 'urn:semblance:live:data')}</div>`)
    }
    expect(examples).toBe((server.html.match(/<div data-sem-sandbox="ssr-\d+"/g) ?? []).length)
    expect(examples).toBeGreaterThan(0)
    sandboxes.dispose()
    server.runtime.dispose()
    client.runtime.dispose()
  })
})

describe('a live example that fails on the server', () => {
  const docs = readFileSync(new URL('../demo/gallery/_docs.ttl', import.meta.url), 'utf8')
  /** The Docs' Getting started, its first example's first source edited as given. */
  function edited(text: string) {
    const store = loadStore('wat', docs)
    const f = store.factory
    const editor = exampleSpec(store, UI + 'gs-page').sources[0]!.editor!
    store.add(f.quad(f.namedNode(editor), f.namedNode(NS.c + 'value'), f.literal(text)))
    return store
  }
  const status = (host: Element) => host.querySelector('[data-sem-c=live-example] .sem-live-status')?.textContent

  it('renders its problem as the browser does', async () => {
    const broken = 'ex:page a c:Page ;\n  c:title "unfinished'
    const server = await renderToString({ store: edited(broken), root: UI + 'doc-start', styles: false, sandboxes: { load } })
    const { host } = parsed(renderDocument(TEMPLATE, server))
    const ex = host.querySelector('[data-sem-c=live-example]')!
    expect(ex.getAttribute('data-sem-state')).toBe('broken')
    expect(ex.querySelector('.sem-live-screen')!.children.length).toBe(0)
    // The browser's host, building the same sources.
    const store = edited(broken)
    const runtime = new Runtime(store)
    const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, name: 'screen', roots: [UI + 'doc-start'] })
    const { document } = parseHTML(TEMPLATE)
    const renderer = new DomRenderer(screen.index, document.getElementById('app')!, UI + 'doc-start')
    const { sandboxes, flush } = liveExamples({ store, runtime, screen }, renderer)
    flush()
    expect(status(renderer.host)).toBeTruthy()
    expect(status(host)).toBe(status(renderer.host))
    sandboxes.dispose()
    server.runtime.dispose()
    runtime.dispose()
  })

  it('stops at the same turn limit as in the browser, and says so', async () => {
    const server = await renderToString({ store: loadStore('wat', docs), root: UI + 'doc-start', styles: false, sandboxes: { load, budgetMs: 1 } })
    const { host } = parsed(renderDocument(TEMPLATE, server))
    expect(host.querySelector('[data-sem-c=live-example]')!.getAttribute('data-sem-state')).toBe('broken')
    expect(status(host)).toContain('Stopped: rendering took longer than 1 ms')
    server.runtime.dispose()
  })
})
