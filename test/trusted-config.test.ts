import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { Islands } from '../src/foreign.ts'
import { loadStore } from '../src/node/load.ts'
import { DEFAULT_LAYERS, MOD, NS } from '../src/ns.ts'
import { memoryBackend, Persistence } from '../src/persistence.ts'
import type { SourceTransport } from '../src/remote.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import { Sandboxes } from '../src/sandbox.ts'
import { mount, type MountedApp } from '../src/web/mount.ts'

// Under mount({ authored }) the host effects take their configuration from the trusted graphs
// alone (the ontology and `graphs`), and restoring remembered state brings back only what a
// policy covers (docs/SAFETY.md).

const EX = 'https://example.org/app#'
const PFX = `@prefix ex: <${EX}> .\n` + Object.entries(NS).filter(([k]) => /^[a-z]+$/.test(k)).map(([k, v]) => `@prefix ${k}: <${v}> .`).join('\n') + '\n'
const apps: MountedApp[] = []

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function host() {
  const { document, window } = parseHTML('<!doctype html><html><body><main id="app"></main></body></html>')
  document.adoptedStyleSheets = []
  class Sheet {
    replaceSync() {}
  }
  Object.defineProperty(window, 'CSSStyleSheet', { value: Sheet, configurable: true })
  Object.defineProperty(window, 'requestAnimationFrame', { value: () => 1, configurable: true })
  Object.defineProperty(window, 'cancelAnimationFrame', { value: () => {}, configurable: true })
  vi.stubGlobal('requestIdleCallback', () => 0)
  vi.stubGlobal('fetch', async () => new Response(readFileSync(new URL('../rdf-engine/build/wat.wasm', import.meta.url)), { headers: { 'Content-Type': 'application/wasm' } }))
  return { document, element: document.getElementById('app')! }
}

async function mounted(graphs: string[], authored: string[] | undefined, extra: Partial<Parameters<typeof mount>[1]> = {}) {
  const { element } = host()
  const history = { state: null, pushState() {}, replaceState() {} }
  const app = await mount(element, {
    root: EX + 'page',
    graphs,
    authored,
    store: 'wat',
    files: false,
    fullscreen: false,
    onRefused: () => {},
    navigation: { location: { pathname: '/', search: '', hash: '' }, history, events: new EventTarget(), links: new EventTarget() },
    ...extra,
  })
  apps.push(app)
  return app
}

const page = `${PFX}ex:page a c:Stack ; c:children ( ) .`

describe('mount({ authored }): effects read their configuration from the trusted graphs', () => {
  it('keeps a store of the trusted graphs, without the authored ones, and releases it on unmount', async () => {
    const app = await mounted([page], [`${PFX}ex:note a c:Text ; c:label "authored" .`])
    const trusted = app.trusted!
    const f = trusted.factory
    expect(trusted.match(f.namedNode(EX + 'page'), null, null).length).toBeGreaterThan(0)
    expect(trusted.match(f.namedNode(EX + 'note'), null, null)).toEqual([])
    expect(app.store.match(f.namedNode(EX + 'note'), null, null).length).toBeGreaterThan(0)
    const dispose = vi.spyOn(trusted, 'dispose')
    app.unmount()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('has no trusted store when nothing is authored: the effects read the store', async () => {
    const app = await mounted([page], undefined)
    expect(app.trusted).toBeUndefined()
  })

  it('attaches navigation only for a location the trusted graphs declare for the root', async () => {
    const location = `${PFX}ex:loc a nav:Location ; nav:root ex:page .`
    expect((await mounted([page], [location])).navigation).toBeUndefined()
    expect((await mounted([page, location], [])).navigation).toBeDefined()
  })

  it('serves the location as the trusted graphs declare it: an authored dimension is not part of it', async () => {
    const location = `${PFX}ex:loc a nav:Location ; nav:root ex:page ; nav:dimensions ( ex:atView ) .
ex:atView a nav:Dimension ; nav:subject ex:page ; nav:property ex:view ; nav:carriedBy nav:Fragment .`
    const app = await mounted([page, location], [`${PFX}ex:loc nav:dimensions ( ex:atZoom ) .
ex:atZoom a nav:Dimension ; nav:subject ex:page ; nav:property ex:zoom ; nav:carriedBy nav:Query .`])
    expect(app.navigation!.location()!.dimensions.map((d) => d.iri)).toEqual([EX + 'atView'])
  })

  it('binds a remote source as the trusted graphs declare it: an authored graph cannot widen its patterns or make it writable', async () => {
    const app0 = `${PFX}ex:notes a src:Source ; src:pattern [ src:predicate ex:title ] .`
    const asked: unknown[] = []
    const transport: SourceTransport = { follow: async (patterns) => void asked.push(patterns), write: async () => ({ ok: true }) as never }
    const app = await mounted([page, app0], [`${PFX}ex:notes src:pattern [ ] ; src:writable true .
ex:other a src:Source ; src:pattern [ ] .`], { sources: { endpoints: { [EX + 'notes']: transport, [EX + 'other']: transport } } })
    await new Promise((r) => setTimeout(r, 0))
    expect(asked).toEqual([[{ predicate: EX + 'title' }]])
    const bound = (app.sources as unknown as { bound: { iri: string; writable: boolean }[] }).bound
    expect(bound.map((b) => [b.iri, b.writable])).toEqual([[EX + 'notes', false]])
  })
})

describe('islands: ext:module is read from the trusted graphs', () => {
  it('loads a registered module only when the trusted graphs name it', async () => {
    const run = async (trustedTtl: string, authoredTtl: string) => {
      const trusted = loadStore('wat', trustedTtl)
      const store = loadStore('wat', trustedTtl, authoredTtl)
      const runtime = new Runtime(store)
      const projection = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, prefer: 'sparql', name: 'screen', roots: [EX + 'it'] })
      const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
      const element = document.getElementById('app')!
      const renderer = new DomRenderer(projection.index, element, EX + 'it')
      renderer.flush()
      Object.defineProperty(Object.getPrototypeOf(element), 'isConnected', { get: () => true, configurable: true })
      const loaded: string[] = []
      const islands = new Islands(new EventBus(runtime, projection), renderer, {
        modules: { chart: async () => void loaded.push('chart') },
        trusted,
        onError: () => {},
      })
      islands.attach()
      renderer.flush()
      await islands.settled()
      runtime.dispose()
      trusted.dispose?.()
      return loaded
    }
    const island = `${PFX}ex:it a ext:Island ; ext:tag "x-chart" .`
    expect(await run(island, `${PFX}ex:it ext:module "chart" .`)).toEqual([])
    expect(await run(`${island}\nex:it ext:module "chart" .`, '')).toEqual(['chart'])
  })
})

describe('persistence: policies from the trusted graphs, restore what they cover', () => {
  const RDF = NS.rdf
  const policy = `${PFX}ex:remember a per:Policy ; per:scope per:Device ; per:subject ex:shell ; per:properties ( ex:theme ) .
ex:shell ex:theme "light" .`
  const stored = (nt: string) => JSON.stringify({ version: '1', savedAt: Date.now(), nt })

  it('reads its policies from the trusted graphs: an authored policy is not one, and picks no storage key', async () => {
    const authored = `${PFX}ex:other a per:Policy ; per:scope per:Device ; per:subject ex:shell ; per:properties ( ex:theme ) .`
    const trusted = loadStore('wat', policy)
    const store = loadStore('wat', policy, authored)
    const backend = memoryBackend()
    const read = vi.spyOn(backend, 'get')
    const p = new Persistence(store, { [NS.per + 'Device']: backend, [NS.per + 'Session']: memoryBackend() }, { trusted })
    expect(p.policies().map((x) => x.iri)).toEqual([EX + 'remember'])
    await p.restore()
    expect(read.mock.calls.map(([k]) => k)).not.toContain('semblance:' + EX + 'other')
    store.dispose?.()
    trusted.dispose?.()
  })

  it('restores only its subject’s listed properties', async () => {
    const store = loadStore('wat', policy)
    const backend = memoryBackend()
    await backend.set('semblance:' + EX + 'remember', stored(`<${EX}shell> <${EX}theme> "dark" .\n<${EX}shell> <${EX}other> "x" .\n<${EX}else> <${EX}theme> "y" .\n`))
    const p = new Persistence(store, { [NS.per + 'Device']: backend, [NS.per + 'Session']: memoryBackend() })
    expect(await p.restore()).toBe(1)
    const f = store.factory
    expect(store.match(f.namedNode(EX + 'shell'), f.namedNode(EX + 'theme'), null).map((q) => q.object.value)).toEqual(['dark'])
    expect(store.match(f.namedNode(EX + 'shell'), f.namedNode(EX + 'other'), null)).toEqual([])
    expect(store.match(f.namedNode(EX + 'else'), null, null)).toEqual([])
    store.dispose?.()
  })

  it('restores only what the template of its query can produce', async () => {
    const store = loadStore('wat', `${PFX}ex:recent a per:Policy ; per:scope per:Device ;
    per:construct """CONSTRUCT { ?run a c:RecentRun ; c:recentOf <${EX}palette> ; c:recentRank ?rank } WHERE { ?run c:recentOf <${EX}palette> ; c:recentRank ?rank }""" .`)
    const backend = memoryBackend()
    await backend.set('semblance:' + EX + 'recent', stored(`<${EX}r1> <${RDF}type> <${NS.c}RecentRun> .\n<${EX}r1> <${NS.c}recentOf> <${EX}palette> .\n<${EX}r1> <${NS.c}recentRank> "0"^^<${NS.xsd}integer> .
<${EX}r1> <${RDF}type> <${NS.sem}Rule> .\n<${EX}r1> <${NS.c}recentOf> <${EX}elsewhere> .\n<${EX}r1> <${NS.sem}construct> "x" .\n`))
    const p = new Persistence(store, { [NS.per + 'Device']: backend, [NS.per + 'Session']: memoryBackend() })
    expect(await p.restore()).toBe(3)
    const f = store.factory
    expect(store.match(f.namedNode(EX + 'r1'), null, null).map((q) => q.predicate.value + ' ' + q.object.value).sort()).toEqual(
      [`${RDF}type ${NS.c}RecentRun`, `${NS.c}recentOf ${EX}palette`, `${NS.c}recentRank 0`].sort(),
    )
    store.dispose?.()
  })

  it('restores the switches of the policies it has, and no other node’s', async () => {
    const store = loadStore('wat', policy)
    const backend = memoryBackend()
    await backend.set('semblance:enabled', JSON.stringify({ [EX + 'remember']: false, [EX + 'shell']: true }))
    const p = new Persistence(store, { [NS.per + 'Device']: backend, [NS.per + 'Session']: memoryBackend() })
    await p.restore()
    const f = store.factory
    expect(store.match(f.namedNode(EX + 'remember'), f.namedNode(NS.per + 'enabled'), null).map((q) => q.object.value)).toEqual(['false'])
    expect(store.match(f.namedNode(EX + 'shell'), f.namedNode(NS.per + 'enabled'), null)).toEqual([])
    store.dispose?.()
  })
})

describe('live examples: the policy is read from the ontology alone', () => {
  it('refuses a script element even when the site’s store lists it (as restored state could)', async () => {
    const UI = 'https://semblance.dev/demo#'
    const docs = readFileSync(new URL('../demo/gallery/_docs.ttl', import.meta.url), 'utf8')
    const store = loadStore('wat', docs, `<${NS.safe}Authored> <${NS.safe}element> <${NS.rdfhtml}Script> .`)
    const root = UI + 'doc-start'
    const runtime = new Runtime(store)
    const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, name: 'screen', roots: [root] })
    const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    const renderer = new DomRenderer(screen.index, document.getElementById('app')!, root)
    const sandboxes = new Sandboxes(runtime, screen, { renderer, shown: (c) => screen.index.isShown(c, new Set([root])), flush: () => flush(), load: (...t) => loadStore('wat', ...t) })
    const flush = () => (renderer.flush(), sandboxes.sync())
    new EventBus(runtime, screen).attach(renderer, () => flush())
    sandboxes.attach()
    flush()
    const example = document.querySelector('[data-sem-c=live-example]')!
    const iri = example.querySelector('textarea')!.id.replace(/\/~input$/, '')
    const f = store.factory
    const exampleIri = store.match(null, f.namedNode(NS.c + 'sources'), null).find((q) => store.match(q.object, null, null).some((c) => c.object.value === iri))!.subject
    const target = store.match(exampleIri, f.namedNode(NS.c + 'exampleRoot'), null)[0]!.object.value
    const ta = document.getElementById(iri + '/~input') as HTMLTextAreaElement
    ta.value = `@prefix ex: <${EX}> .
ex:Evil a owl:Class ; rdfs:subClassOf sem:Component ; sem:slug "ex-evil" .
ex:EvilRendering a sem:Rendering ; sem:targets ex:Evil ; sem:stratum 0 .
ex:EvilRendering-sparql a sem:Rule ; sem:implements ex:EvilRendering ; sem:construct """
CONSTRUCT { ?root a rdfhtml:Div ; sem:renders $this ; rdfhtml:hasChild ?x . ?x a rdfhtml:Script }
WHERE { $this a <${EX}Evil> . BIND(IRI(CONCAT(STR($this), "/~root")) AS ?root) BIND(IRI(CONCAT(STR($this), "/~x")) AS ?x) }""" .
<${target}> a ex:Evil .`
    ta.dispatchEvent(new window.Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    flush()
    const shown = example.querySelector('.sem-live-screen')!.innerHTML
    expect(shown).toContain('<sem-refused data-sem-refused="script"></sem-refused>')
    expect(shown).not.toMatch(/<script/i)
    sandboxes.dispose()
    runtime.dispose()
  })
})
