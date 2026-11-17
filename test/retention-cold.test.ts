import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type MountedApp } from '../src/web/mount.ts'
import { NS } from '../src/ns.ts'
import { loadStore } from '../src/node/load.ts'
import { ColdGraphs, coldGraphIri } from '../src/retention/cold.ts'
import { MemoryPressure } from '../src/retention/pressure.ts'
import { Runtime } from '../src/runtime.ts'
import { galleryFiles, mountSite, mountSiteCold } from './harness.ts'
import { type Page, sitePages } from './site-clicks.ts'

const UI = 'https://semblance.dev/demo#'
const RET = NS.ret
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
 * The page shown, with each element's attributes in name order: an element patched in place keeps its
 * attributes in the order they were set, which is not part of what is rendered.
 */
const canonical = (site: Site) => {
  const write = (n: Node): string => {
    if (n.nodeType === 3) return (n.textContent ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    if (n.nodeType !== 1) return ''
    const el = n as Element
    const attrs = [...el.attributes].map((a) => ` ${a.name}="${a.value}"`).sort().join('')
    return `<${el.localName}${attrs}>${[...el.childNodes].map(write).join('')}</${el.localName}>`
  }
  return write(site.document.querySelector(PAGE)!)
}
/** The input's triples (the default graph): what the files and the person stated. */
const input = (site: Site) => site.store.match(null, null, null, site.store.factory.defaultGraph()).length

/** Simulate a level on the site's budget and take one step of the pressure effect. */
const pressure = (site: ReturnType<typeof mountSiteCold>) => {
  const effect = new MemoryPressure(site.runtime, { cold: site.cold, sample: () => ({ wasmBytes: 0, heapBytes: 0 }) })
  const f = site.store.factory
  const budget = f.namedNode(UI + 'memoryBudget')
  const simulate = f.namedNode(RET + 'simulate')
  return async (level: 'Critical' | 'Normal') => {
    site.runtime.apply({ remove: site.store.match(budget, simulate, null), add: [f.quad(budget, simulate, f.namedNode(RET + level))] })
    await effect.step()
    site.shell.flush()
  }
}

/**
 * Cold graphs (docs/RETENTION.md §6.2): under pressure, the graphs the site can fetch again that no
 * page shown needs are unloaded; a page that needs one brings it back before it is patched, and
 * renders as it does on a site that never unloaded anything (and evicted the same hidden renderings).
 */
describe('cold graphs', () => {
  it('unloads what no page shown needs, leaves the page shown as it is, and brings a page back as it was', async () => {
    const pages = sitePages()
    const cold = mountSiteCold('wat')
    const plain = mountSite('wat')
    const step = pressure(cold)
    const at = (p: Page) => `${p.page} ${p.value ?? ''}`
    const visits = [...pages.home, ...pages.components, ...pages.examples, pages.docs[0]!, pages.docs[3]!]
    // Loaded as cold graphs, the site is the site.
    const before0: string[] = []
    for (const p of visits) {
      show(cold, p)
      show(plain, p)
      if (canonical(cold) !== canonical(plain)) before0.push(at(p))
    }
    expect(before0).toEqual([])
    show(cold, { page: 'Home' })
    show(plain, { page: 'Home' })
    const home = canonical(cold)
    expect(home).toBe(canonical(plain))
    const before = input(cold)
    await step('Critical')
    // The site that keeps everything evicts what is hidden too: what is compared is what unloading did.
    plain.runtime.evict(), plain.shell.flush()
    const unloaded = cold.cold.list().filter((g) => g.state === 'unloaded')
    // The examples not shown are out of the store (Home needs none of them).
    expect(unloaded.length).toBeGreaterThan(3)
    expect(input(cold)).toBe(before - unloaded.reduce((n, g) => n + g.size, 0))
    // What owns a person's state is kept (the chat example remembers its conversation: per:Policy).
    expect(cold.cold.list().find((g) => g.name === 'demo/gallery/_ex-chat.ttl')?.state).toBe('kept')
    // The page shown did not change.
    expect(canonical(cold)).toBe(home)
    // The Memory tool's figures and list say so.
    const g = cold.store.factory
    const figure = cold.store.match(g.namedNode(UI + 'memoryBudget'), g.namedNode(RET + 'graphsUnloaded'), null)[0]?.object.value
    expect(Number(figure)).toBe(unloaded.length)
    expect(cold.store.match(g.namedNode(coldGraphIri(unloaded[0]!.name)), g.namedNode(RET + 'state'), g.namedNode(RET + 'Unloaded')).length).toBe(1)
    // Every page shown again is as on the site that kept everything; and unloading under it changes nothing.
    const differ: string[] = []
    for (const p of visits) {
      show(cold, p)
      show(plain, p)
      const expected = canonical(plain)
      if (canonical(cold) !== expected) differ.push(at(p))
      await step('Critical')
      // The site that keeps everything evicts what is hidden too: what is compared is what unloading did.
      plain.runtime.evict(), plain.shell.flush()
      if (canonical(cold) !== expected) differ.push(`${at(p)} after unloading under it`)
    }
    expect(differ).toEqual([])
    cold.runtime.dispose()
    plain.runtime.dispose()
  }, 900_000)

  it('renders a page whose graph came back as a fresh visit does', async () => {
    const page: Page = { page: 'Examples', dimension: 'example', value: UI + 'ExSheet' }
    const fresh = mountSite('wat')
    show(fresh, page)
    const html = shown(fresh)
    fresh.runtime.dispose()
    const site = mountSiteCold('wat')
    const step = pressure(site)
    show(site, page)
    show(site, { page: 'Home' })
    await step('Critical')
    expect(site.cold.list().find((g) => g.name === 'demo/gallery/_ex-sheet.ttl')?.state).toBe('unloaded')
    show(site, page)
    expect(site.cold.list().find((g) => g.name === 'demo/gallery/_ex-sheet.ttl')?.state).toBe('loaded')
    expect(shown(site)).toBe(html)
    site.runtime.dispose()
  }, 300_000)

  it('keeps what a person changed in a graph that left and came back', async () => {
    const site = mountSiteCold('wat')
    const step = pressure(site)
    const s = site.store
    const f = s.factory
    const page: Page = { page: 'Examples', dimension: 'example', value: UI + 'ExSheet' }
    show(site, page)
    // A statement of the sheet example's graph, changed as a person's edit would change it.
    const name = 'demo/gallery/_ex-sheet.ttl'
    const label = f.namedNode(NS.c + 'label')
    const card = site.cold.parse(name, galleryFiles[name]!).find((q) => q.predicate.equals(label) && q.subject.termType === 'NamedNode' && q.object.termType === 'Literal')!
    expect(card).toBeDefined()
    const edited = f.quad(card.subject, label, f.literal('Edited by a person'))
    const note = f.quad(card.subject, f.namedNode(NS.c + 'note'), f.literal('Added by a person'))
    site.runtime.apply({ remove: [card], add: [edited, note] })
    show(site, { page: 'Home' })
    await step('Critical')
    expect(site.cold.list().find((g) => g.name === 'demo/gallery/_ex-sheet.ttl')?.state).toBe('unloaded')
    // What the person added stays while the graph is out; what they removed does not come back with it.
    expect(s.has(note)).toBe(true)
    show(site, page)
    expect(s.has(edited)).toBe(true)
    expect(s.has(note)).toBe(true)
    expect(s.has(card)).toBe(false)
    site.runtime.dispose()
  }, 300_000)

  it('takes out only what no other graph states, blank nodes included, and puts back the same', async () => {
    const store = loadStore('wat')
    const runtime = new Runtime(store)
    const text: Record<string, string> = {
      a: '@prefix ex: <https://example.org/> . ex:a a ex:Thing ; ex:shared ex:x ; ex:list ( 1 2 ) ; ex:in [ ex:depth 1 ] .',
      b: '@prefix ex: <https://example.org/> . ex:a ex:shared ex:x . ex:b a ex:Thing ; ex:in [ ex:depth 2 ] .',
    }
    let needs: string[] = []
    const cold = new ColdGraphs(store, { fetch: (n) => text[n]!, needs: () => needs })
    const f = store.factory
    const dg = () => store.match(null, null, null, f.defaultGraph()).length
    const base = dg()
    const a = cold.parse('a', text.a!).length
    const b = cold.parse('b', text.b!).length
    cold.load({ a: cold.parse('a', text.a!), b: cold.parse('b', text.b!) })
    cold.attach(runtime)
    // The triple both state is stored once.
    expect(dg()).toBe(base + a + b - 1)
    const shared = f.quad(f.namedNode('https://example.org/a'), f.namedNode('https://example.org/shared'), f.namedNode('https://example.org/x'))
    // The same text read again is the same triples, blank nodes and all.
    expect(cold.parse('a', text.a!).every((q) => store.has(q))).toBe(true)
    await cold.unload('critical')
    expect(cold.list().map((g) => g.state)).toEqual(['unloaded', 'unloaded'])
    expect(dg()).toBe(base)
    expect(store.has(shared)).toBe(false)
    await cold.reload('a')
    expect(dg()).toBe(base + a)
    await cold.reload('b')
    expect(dg()).toBe(base + a + b - 1)
    // Only b leaves (the host's page needs a): the triple a states too stays.
    needs = ['a']
    await cold.unload('critical')
    expect(cold.list().map((g) => g.state)).toEqual(['loaded', 'unloaded'])
    expect(dg()).toBe(base + a)
    expect(store.has(shared)).toBe(true)
    // A page that needs b brings it back at the end of the next change.
    needs = ['a', 'b']
    runtime.apply({ add: [f.quad(f.namedNode('https://example.org/c'), f.namedNode('https://example.org/p'), f.literal('1'))], remove: [] })
    expect(cold.list().map((g) => g.state)).toEqual(['loaded', 'loaded'])
    expect(dg()).toBe(base + a + b - 1 + 1)
    runtime.dispose()
  })

  it('works through mount: a cold graph leaves, and a page that shows it brings it back', async () => {
    const { document, window } = parseHTML('<!doctype html><html><body><main id="app"></main></body></html>')
    document.adoptedStyleSheets = []
    class Sheet { replaceSync() {} }
    Object.defineProperty(window, 'CSSStyleSheet', { value: Sheet, configurable: true })
    Object.defineProperty(window, 'requestAnimationFrame', { value: () => 1, configurable: true })
    Object.defineProperty(window, 'cancelAnimationFrame', { value: () => {}, configurable: true })
    vi.stubGlobal('requestIdleCallback', () => 0)
    vi.stubGlobal('fetch', async () => new Response(readFileSync(new URL('../rdf-engine/build/wat.wasm', import.meta.url)), { headers: { 'Content-Type': 'application/wasm' } }))
    const element = document.getElementById('app')!
    const EX = 'https://example.org/cold#'
    const prefixes = `@prefix ex: <${EX}> . @prefix c: <${NS.c}> .`
    const app = `${prefixes}
ex:app ex:page ex:Home .
ex:root a c:Switch ; c:controls ex:app ; c:property ex:page ; c:cases ( ex:home-case ex:orders-case ) .
ex:home-case c:when ex:Home ; c:content ex:home .
ex:orders-case c:when ex:Orders ; c:content ex:orders .
ex:home a c:Text ; c:label "Home" .`
    const orders = `${prefixes}
ex:orders a c:Text ; c:label "Your orders" .`
    const mounted = await mount(element, { root: EX + 'root', graphs: [app], coldGraphs: { 'pages/orders.ttl': () => orders }, store: 'wat', files: false, fullscreen: false })
    apps.push(mounted)
    const f = mounted.store.factory
    const go = (page: string) => {
      const s = f.namedNode(EX + 'app')
      const p = f.namedNode(EX + 'page')
      mounted.runtime.apply({ remove: mounted.store.match(s, p, null), add: [f.quad(s, p, f.namedNode(EX + page))] })
      mounted.renderer.flush()
    }
    go('Orders')
    const shownOrders = element.innerHTML
    expect(shownOrders).toContain('Your orders')
    go('Home')
    expect(await mounted.cold!.unload('critical')).toBeGreaterThan(0)
    expect(mounted.cold!.list()).toEqual([{ name: 'pages/orders.ttl', state: 'unloaded', size: 2 }])
    go('Orders')
    expect(mounted.cold!.list()[0]!.state).toBe('loaded')
    expect(element.innerHTML).toBe(shownOrders)
  })
})

const apps: MountedApp[] = []
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
