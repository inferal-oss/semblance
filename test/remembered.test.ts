// What a visitor chose, before the first paint (#308): a server-rendered page's head script puts
// back what the policies in the graph stored, so the page is painted as the client's projection will
// have it, and taking it over changes nothing.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore, loadStoreOf } from '../src/node/load.ts'
import { loadSite, namedGraphs, pageGraphs, renderSite } from '../src/node/site.ts'
import { Navigation, setBase } from '../src/navigation.ts'
import { MOD, NS } from '../src/ns.ts'
import { Persistence, webStorageBackend } from '../src/persistence.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { renderDocument } from '../src/server/document.ts'
import { firstPaintPlan, rememberedPolicies } from '../src/server/remembered.ts'
import { graphLanguages, serializeRoot } from '../src/server/render.ts'
import type { GraphStore } from '../src/store/types.ts'
import { DEFAULT_LAYERS } from '../src/web/mount.ts'
import { rememberedScript } from '../src/web/remembered.ts'
import { takeOver } from '../src/web/takeover.ts'
import { prepareSite, ROOT, siteLayers, UI } from '../demo/site.ts'

const root = new URL('../', import.meta.url)
const config = new URL('semblance.config.ts', root).pathname
const TEMPLATE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><link rel="stylesheet" href="/chrome.css"></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>'
const STY = NS.sty
const APP = UI + 'app'
const DAY = 86400000

class FakeStorage {
  private m = new Map<string, string>()
  getItem = (k: string) => this.m.get(k) ?? null
  setItem = (k: string, v: string) => void this.m.set(k, v)
  removeItem = (k: string) => void this.m.delete(k)
  entries = () => [...this.m.entries()]
}
const backends = (session: FakeStorage, device: FakeStorage) => ({ [NS.per + 'Session']: webStorageBackend(session as unknown as Storage), [NS.per + 'Device']: webStorageBackend(device as unknown as Storage) })

type Choice = [subject: string, property: string, value: string]
const scheme = (v: string): Choice => [APP, STY + 'colorScheme', STY + v]
const theme = (v: string): Choice => [ROOT, STY + 'theme', STY + v]
const contrast = (v: string): Choice => [ROOT, STY + 'contrast', STY + v]
const density = (v: string): Choice => [ROOT, STY + 'density', STY + v]

function put(store: GraphStore, [s, p, o]: Choice) {
  const f = store.factory
  const g = f.defaultGraph()
  for (const q of store.match(f.namedNode(s), f.namedNode(p), null, g)) store.delete(q)
  store.add(f.quad(f.namedNode(s), f.namedNode(p), f.namedNode(o), g))
}

async function siteStore(only?: string[]) {
  const site = await loadSite(config)
  const named = await namedGraphs(site)
  const graphs = Object.entries(named).filter(([n]) => !only || only.includes(n)).map(([, t]) => t)
  const store = only ? loadStoreOf('wat', only, ...graphs) : loadStore('wat', ...graphs)
  site.setup?.(store, { single: false, ...(only && { graphs: new Set(only) }) })
  setBase(store, '/')
  return store
}

/** What the real writer stores for a visitor's choices. */
async function storedBy(choices: Choice[]) {
  const session = new FakeStorage()
  const device = new FakeStorage()
  const store = await siteStore()
  const persistence = new Persistence(store, backends(session, device))
  for (const c of choices) put(store, c)
  const runtime = new Runtime(store)
  persistence.attach(runtime)
  for (const p of persistence.policies()) persistence['dirty'].add(p.iri)
  await persistence.flush()
  persistence.stop()
  runtime.dispose()
  return { session, device }
}

/** A stub observer that says when the parser would have called it back. */
function observerStub() {
  const made: { callback: () => void; disconnected: boolean }[] = []
  return {
    made,
    MutationObserver: class {
      entry: (typeof made)[number]
      constructor(callback: () => void) {
        this.entry = { callback, disconnected: false }
        made.push(this.entry)
      }
      observe() {}
      disconnect() {
        this.entry.disconnected = true
      }
    },
  }
}

/** The head script, run in `document` with these storages. */
function run(page: string, document: Document, session: FakeStorage, device: FakeStorage, observer = observerStub()) {
  const script = /<script>(\(p=>.*?)<\/script>/.exec(page)?.[1]
  expect(script, 'the head script').toBeTruthy()
  // Its `globalThis[y.storage]`: only what a page's global has.
  new Function('document', 'localStorage', 'MutationObserver', 'globalThis', script!)(document, device, observer.MutationObserver, { sessionStorage: session, localStorage: device })
  return observer
}

/** The site's client up to its first render, restoring from the storages, as demo/main.ts does. */
async function client(url: string, session: FakeStorage, device: FakeStorage, only?: string[]) {
  const store = await siteStore(only)
  await new Persistence(store, backends(session, device)).restore()
  const u = new URL(url, 'https://semblance.test/')
  await new Navigation(store, { root: ROOT, location: { pathname: u.pathname, search: u.search, hash: u.hash }, history: { pushState() {}, replaceState() {} }, events: new EventTarget(), links: new EventTarget() }).restore()
  prepareSite(store, { kind: 'wat', prefer: 'sparql', compile: 'off' })
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: siteLayers(store), prefer: 'sparql', provenance: 'onDemand', languages: graphLanguages(store, ROOT), name: 'screen', roots: [ROOT] })
  return { store, runtime, screen, html: serializeRoot(runtime, screen, ROOT, { sandboxes: { load: (...t) => loadStore('wat', ...t) }, prefer: 'sparql' }) }
}

/** A browser decodes character references in a <textarea>; linkedom keeps them as written. */
const decodeAreas = (host: Element) => {
  for (const area of host.querySelectorAll('textarea')) area.textContent = area.textContent!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

const pageOf = async (url: string) => {
  const rendered = await renderSite(await loadSite(config), url)
  const page = renderDocument(TEMPLATE, rendered, { attributes: rendered.attributes, stylesheet: { href: '/semblance.css' } })
  rendered.runtime.dispose()
  return page
}

describe('the head script', () => {
  it('is in a page, ahead of its stylesheets, with the empty page colour-schemed', async () => {
    const page = await pageOf('/docs/overview/')
    const at = page.indexOf('<script>(p=>')
    expect(at).toBeGreaterThan(page.indexOf('<meta charset'))
    expect(at).toBeLessThan(page.indexOf('<link rel="stylesheet"'))
    expect(at).toBeLessThan(page.indexOf('data-sem-styles'))
    expect(page).toContain('<meta name="color-scheme" content="light dark">')
    expect(page.indexOf('<meta name="color-scheme"')).toBeLessThan(at)
  })

  it('takes where to look from the policies in the graph, and only those it can read at once', async () => {
    const store = await siteStore()
    const policies = rememberedPolicies(store, ROOT)
    const byIri = Object.fromEntries(policies.map((p) => [p.iri, p]))
    // The taskbar's is of a node the page cannot name yet: it lands nowhere.
    const plan = firstPaintPlan(policies, 'app', { 'data-sem-color-scheme': 'system' })!
    expect(plan.policies.map((p) => p.iri).sort()).toEqual([UI + 'rememberColorScheme', UI + 'rememberDisplay', UI + 'rememberPrivacy'])
    // How it looks is kept on the device (#361); private mode, for this tab.
    expect(byIri[UI + 'rememberDisplay']!.storage).toBe('localStorage')
    expect(byIri[UI + 'rememberColorScheme']!.storage).toBe('localStorage')
    expect(byIri[UI + 'rememberPrivacy']!.storage).toBe('sessionStorage')
    expect(byIri[UI + 'rememberDisplay']!.hooks.map((h) => h.attribute).sort()).toEqual(['data-sem-contrast', 'data-sem-density', 'data-sem-motion', 'data-sem-theme'])
    expect(byIri[UI + 'rememberDisplay']!.hooks.every((h) => h.root)).toBe(true)
    // A language is not a hook; a scheme is, of the document.
    expect(byIri[UI + 'rememberLanguage']).toBeUndefined()
    expect(byIri[UI + 'rememberColorScheme']!.hooks.map((h) => [h.attribute, h.root])).toEqual([['data-sem-color-scheme', false]])
    // A policy in another scope or under another key follows the graph.
    const f = store.factory
    const display = f.namedNode(UI + 'rememberDisplay')
    const scope = f.namedNode(NS.per + 'scope')
    for (const q of store.match(display, scope, null)) store.delete(q)
    store.add(f.quad(display, scope, f.namedNode(NS.per + 'Session')))
    expect(rememberedPolicies(store, ROOT).find((p) => p.iri === display.value)!.storage).toBe('sessionStorage')
    // IndexedDB cannot be read before the first paint.
    for (const q of store.match(display, scope, null)) store.delete(q)
    store.add(f.quad(display, scope, f.namedNode(NS.per + 'Database')))
    expect(rememberedPolicies(store, ROOT).map((p) => p.iri)).not.toContain(display.value)
    // Neither is the document's hook put anywhere unless the document carries it.
    expect(firstPaintPlan(rememberedPolicies(store, ROOT), 'app', {})!.policies.map((p) => p.iri)).toEqual([UI + 'rememberPrivacy'])
  })

  it('leaves a page with nothing stored alone, and does not watch it', async () => {
    const page = await pageOf('/docs/overview/')
    const { document } = parseHTML(page)
    const before = document.toString()
    const observer = run(page, document, new FakeStorage(), new FakeStorage())
    expect(document.toString()).toBe(before)
    expect(observer.made.length).toBe(0)
  })

  it('leaves what cannot be trusted: another version, expired, turned off, unknown, unreadable', async () => {
    const page = await pageOf('/docs/overview/')
    const { session, device } = await storedBy([theme('Classic')])
    const key = 'semblance:' + UI + 'rememberDisplay'
    expect(session.getItem(key)).toBeNull()
    const blob = JSON.parse(device.getItem(key)!)
    const themeOf = (s: FakeStorage, d: FakeStorage) => {
      const { document } = parseHTML(page)
      run(page, document, s, d)
      return document.getElementById('app')!.firstElementChild!.getAttribute('data-sem-theme')
    }
    expect(themeOf(session, device)).toBe('classic')
    const stored = (v: unknown) => {
      const s = new FakeStorage()
      s.setItem(key, typeof v === 'string' ? v : JSON.stringify(v))
      return s
    }
    expect(themeOf(session, stored({ ...blob, version: 'other' }))).toBe('semblance')
    expect(themeOf(session, stored('{not json'))).toBe('semblance')
    expect(themeOf(session, stored({ ...blob, nt: blob.nt.replaceAll(STY + 'Classic', STY + 'NoSuchTheme') }))).toBe('semblance')
    const off = stored(blob)
    off.setItem('semblance:enabled', JSON.stringify({ [UI + 'rememberDisplay']: false }))
    expect(themeOf(session, off)).toBe('semblance')
    // A storage that throws (blocked site data).
    const blocked = new FakeStorage()
    blocked.getItem = () => {
      throw new Error('denied')
    }
    expect(themeOf(blocked, blocked)).toBe('semblance')
    // Retention, as the policy says.
    const store = await siteStore()
    const plan = firstPaintPlan(rememberedPolicies(store, ROOT), 'app', { 'data-sem-color-scheme': 'system' })!
    plan.policies.find((p) => p.iri === UI + 'rememberDisplay')!.retentionMs = DAY
    const held = parseHTML(page).document
    const script = rememberedScript(plan)
    const expired = stored({ ...blob, savedAt: Date.now() - 2 * DAY })
    new Function('document', 'localStorage', 'MutationObserver', 'globalThis', script)(held, expired, observerStub().MutationObserver, { sessionStorage: session, localStorage: expired })
    expect(held.getElementById('app')!.firstElementChild!.getAttribute('data-sem-theme')).toBe('semblance')
  })

  it('paints how it looks in a new tab, but not private mode, which stays with its tab (#361)', async () => {
    const page = await pageOf('/docs/overview/')
    const { session, device } = await storedBy([theme('Classic'), scheme('Dark'), [ROOT, NS.prv + 'privacy', NS.prv + 'Private']])
    expect(session.getItem('semblance:' + UI + 'rememberPrivacy')).toContain('Private')
    expect(device.getItem('semblance:' + UI + 'rememberPrivacy')).toBeNull()
    const painted = (s: FakeStorage) => {
      const { document } = parseHTML(page)
      run(page, document, s, device)
      const root = document.getElementById('app')!.firstElementChild!
      return [document.documentElement.getAttribute('data-sem-color-scheme'), root.getAttribute('data-sem-theme'), root.getAttribute('data-sem-privacy')]
    }
    expect(painted(session)).toEqual(['dark', 'classic', 'private'])
    expect(painted(new FakeStorage())).toEqual(['dark', 'classic', 'conceal'])
  })

  it('reaches what the parser has not got to yet, as it arrives', async () => {
    const page = await pageOf('/docs/overview/')
    const { session, device } = await storedBy([theme('Classic'), scheme('Dark')])
    const cut = page.indexOf('<div id="app" data-sem-ssr>') + '<div id="app" data-sem-ssr>'.length
    const end = page.indexOf('<script type="module"')
    const body = page.slice(cut, page.lastIndexOf('</div>', end))
    const { document } = parseHTML(page.slice(0, cut) + '</div></body></html>')
    const observer = run(page, document, session, device)
    // The document's switch is on at once, the meta with it; the mounted root is not there yet.
    expect(document.documentElement.getAttribute('data-sem-color-scheme')).toBe('dark')
    expect(document.querySelector('meta[name="color-scheme"]')!.getAttribute('content')).toBe('dark')
    expect(observer.made.length).toBe(1)
    document.getElementById('app')!.innerHTML = body
    observer.made[0]!.callback()
    expect(document.getElementById('app')!.firstElementChild!.getAttribute('data-sem-theme')).toBe('classic')
    expect(document.querySelector('option[selected][value$="#Classic"]')).toBeTruthy()
    // Done when the document is.
    document.dispatchEvent(new (parseHTML('').window.Event)('DOMContentLoaded'))
    expect(observer.made[0]!.disconnected).toBe(true)
  })
})

describe('taking over a page with a remembered choice', () => {
  // The structural themes among them; each against the system's opposite and back; the phone's
  // width is the same markup (a theme and a scheme are styles).
  const CASES: [string, string, Choice[]][] = [
    ['night', '/docs/overview/', [scheme('Dark')]],
    ['day', '/docs/overview/', [scheme('Light')]],
    ...['Paper', 'Terminal', 'Blueprint', 'Sunset', 'Cupertino', 'Tracker', 'Classic', 'Fluent', 'Doodle'].map((t, i): [string, string, Choice[]] => [t, '/docs/overview/', [theme(t), scheme(i % 2 ? 'Dark' : 'Light')]]),
    ['high contrast, compact', '/docs/overview/', [contrast('HighContrast'), density('Compact')]],
    ['everything, in Arabic', '/ar/docs/overview/', [theme('Classic'), scheme('Dark'), contrast('HighContrast'), density('Compact')]],
    ['the page of every theme control', '/components/themes/', [theme('Tracker'), scheme('Dark'), contrast('HighContrast')]],
  ]

  it.each(CASES)('changes nothing: %s', async (_name, url, choices) => {
    const page = await pageOf(url)
    // Chosen in one tab, the page opened in a new one: its session has nothing (#361).
    const { device } = await storedBy(choices)
    const session = new FakeStorage()
    const { document } = parseHTML(page)
    run(page, document, session, device)
    const c = await client(url, session, device)
    // The script made the page the client's first render, attribute for attribute.
    const host = document.getElementById('app')!
    const painted = parseHTML(`<div id="r">${host.innerHTML}</div>`).document.getElementById('r')!
    const expected = parseHTML(`<div id="r">${c.html}</div>`).document.getElementById('r')!
    expect(painted.innerHTML).toBe(expected.innerHTML)
    const attributes = (e: Element) => Object.fromEntries(Array.from(e.attributes, (a) => [a.name, a.value]))
    const htmlBefore = attributes(document.documentElement)
    decodeAreas(host)
    const renderer = new DomRenderer(c.screen.index, host, ROOT)
    const t = takeOver(renderer)
    renderer.flush()
    expect(t.mismatches).toBe(0)
    expect(renderer.ops).toBe(0)
    const value = (p: string, s: string) => c.store.match(c.store.factory.namedNode(s), c.store.factory.namedNode(p), null, c.store.factory.defaultGraph())[0]?.object.value
    for (const [s, p, o] of choices) expect(value(p, s)).toBe(o)
    // The switch on <html> says what the client's graph says.
    const schemeValue = value(STY + 'colorScheme', APP)
    const slug = c.store.match(c.store.factory.namedNode(schemeValue!), c.store.factory.namedNode(NS.sem + 'slug'), null)[0]?.object.value
    expect(htmlBefore['data-sem-color-scheme']).toBe(slug)
    c.runtime.dispose()
  })
})

describe('a client that loads a page\'s graphs first', () => {
  // It restores what it can name: a value's slug must be among the graphs it loads first, or taking
  // over would drop the switch until the rest arrive.
  it.each(['/', '/docs/overview/'])('finds every remembered switch as painted: %s', async (url) => {
    const site = await loadSite(config)
    const rendered = await renderSite(site, url)
    const only = await pageGraphs(site, url, rendered.html, { base: '/' })
    const page = renderDocument(TEMPLATE, rendered, { attributes: rendered.attributes, stylesheet: { href: '/semblance.css' } })
    rendered.runtime.dispose()
    expect(only).toBeTruthy()
    for (const choices of [[theme('Tracker'), scheme('Dark'), contrast('HighContrast'), density('Compact')], [theme('Classic'), scheme('Light')]]) {
      const { session, device } = await storedBy(choices)
      const { document } = parseHTML(page)
      run(page, document, session, device)
      const host = document.getElementById('app')!
      decodeAreas(host)
      const c = await client(url, session, device, only)
      const renderer = new DomRenderer(c.screen.index, host, ROOT)
      const t = takeOver(renderer)
      renderer.flush()
      expect(t.mismatches).toBe(0)
      c.runtime.dispose()
    }
  })
})

describe('a chooser bound to a remembered property', () => {
  const GRAPH = `
@prefix ex: <https://example.test/#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sem: <https://semblance.dev/ns/core#> .
@prefix sty: <https://semblance.dev/ns/style#> .
@prefix per: <https://semblance.dev/ns/persistence#> .
ex:app a c:Stack ; sty:density sty:Comfortable ; c:children ( ex:segmented ex:choice ex:radio ex:free ex:other ) .
ex:segmented a c:Segmented ; c:controls ex:app ; c:property sty:density .
ex:choice a c:Choice ; c:controls ex:app ; c:property sty:density .
ex:radio a c:RadioGroup ; c:controls ex:app ; c:property sty:density .
# Not of what is remembered: another subject, and another property.
ex:free a c:Segmented ; c:controls ex:elsewhere ; c:property sty:density .
ex:other a c:Segmented ; c:controls ex:app ; c:property sty:contrast .
ex:elsewhere sty:density sty:Comfortable .
ex:app sty:contrast sty:StandardContrast .
ex:remember a per:Policy ; per:scope per:Device ; per:subject ex:app ; per:properties ( sty:density ) .
`
  const ROOT_IRI = 'https://example.test/#app'
  const render = (prefer: 'sparql' | 'function', mutate?: (s: GraphStore) => void) => {
    const store = loadStore('wat', GRAPH)
    mutate?.(store)
    const runtime = new Runtime(store)
    const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, prefer, name: 'screen', roots: [ROOT_IRI] })
    const html = toHTML(screen.index, ROOT_IRI)
    return { store, runtime, screen, html }
  }

  it('is marked, by both rules alike, and nothing else is', () => {
    const sparql = render('sparql')
    const fn = render('function')
    expect(sparql.html).toBe(fn.html)
    const { document } = parseHTML(`<div>${sparql.html}</div>`)
    const marked = document.querySelectorAll('[data-sem-remembered]')
    expect(Array.from(marked, (m) => m.getAttribute('data-sem-c')).sort()).toEqual(['choice', 'radio-group', 'segmented'])
    for (const m of marked) expect(m.getAttribute('data-sem-remembered')).toBe(`${ROOT_IRI} ${STY}density`)
    sparql.runtime.dispose()
    fn.runtime.dispose()
  })

  it('shows the remembered value before the client is in: every kind of chooser', async () => {
    const value = STY + 'Compact'
    const server = render('sparql')
    const session = new FakeStorage()
    const device = new FakeStorage()
    device.setItem('semblance:https://example.test/#remember', JSON.stringify({ version: '1', savedAt: Date.now(), nt: `<${ROOT_IRI}> <${STY}density> <${value}>.\n` }))
    const page = renderDocument(TEMPLATE, { html: server.html, lang: 'en', dir: 'ltr', remembered: rememberedPolicies(server.store, ROOT_IRI) }, { stylesheet: 'none' })
    const { document } = parseHTML(page)
    run(page, document, session, device)
    const c = render('sparql', (s) => put(s, [ROOT_IRI, STY + 'density', value]))
    expect(document.getElementById('app')!.innerHTML).toBe(parseHTML(`<div id="r">${c.html}</div>`).document.getElementById('r')!.innerHTML)
    const renderer = new DomRenderer(c.screen.index, document.getElementById('app')!, ROOT_IRI)
    expect(takeOver(renderer).mismatches).toBe(0)
    server.runtime.dispose()
    c.runtime.dispose()
  })
})
