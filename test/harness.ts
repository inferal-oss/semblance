import { readdirSync, readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { EventBus } from '../src/behaviour/events.ts'
import type { Clock } from '../src/behaviour/clock.ts'
import { Scheduler } from '../src/behaviour/schedule.ts'
import { todoApp, todoReactions } from '../src/examples/todo.ts'
import { Navigation, type NavigationOptions } from '../src/navigation.ts'
import { type Backend, Persistence } from '../src/persistence.ts'
import { isExampleSource, recordSources } from '../src/sources.ts'
import type { GraphStore } from '../src/store/types.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { A11Y, ANN, KEY, MOD, NS, SEM, ST, STY, VAL } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'

const UI = 'https://semblance.dev/demo#'
const appGraph = readFileSync(new URL('../demo/app.ttl', import.meta.url), 'utf8')
const galleryDir = new URL('../demo/gallery/', import.meta.url)
const galleryFiles = Object.fromEntries(readdirSync(galleryDir).filter((f) => f.endsWith('.ttl')).sort().map((f) => ['demo/gallery/' + f, readFileSync(new URL(f, galleryDir), 'utf8')]))
const gallery = Object.values(galleryFiles)
/** As the host does: the examples' own files (and the todo app's graph) as c:SourceText. */
const sources = (store: GraphStore) => {
  recordSources(store, { 'src/examples/todo.ts': todoApp(5), ...Object.fromEntries(Object.entries(galleryFiles).filter(([p]) => isExampleSource(p))) })
  return store
}

/** The demo's whole interface (demo/app.ttl), projected into a DOM and driven only through events. */
export function mountShell(todos = 5, kind: StoreKind = 'oxigraph', prefer: 'sparql' | 'function' = 'sparql') {
  return mount(workbench(sources(loadStore(kind, todoApp(todos), appGraph, ...gallery))), prefer)
}

/** The site as a visitor first sees it: the landing page, tools closed. */
export function mountSite(kind: StoreKind = 'oxigraph', prefer: 'sparql' | 'function' = 'sparql', clock?: Clock) {
  return mount(sources(loadStore(kind, todoApp(5), appGraph, ...gallery)), prefer, clock)
}

/**
 * Most tests start where the demo's Playground page was: the todo example shown, with the
 * tools open (written before the first projection, as a restored session would be).
 */
function workbench(store: GraphStore): GraphStore {
  const f = store.factory
  const set = (s: string, p: string, o: Parameters<typeof f.quad>[2]) => {
    for (const q of store.match(f.namedNode(s), f.namedNode(p), null)) store.delete(q)
    store.add(f.quad(f.namedNode(s), f.namedNode(p), o))
  }
  set(UI + 'app', UI + 'page', f.namedNode(UI + 'Examples'))
  set(UI + 'app', UI + 'example', f.namedNode(UI + 'ExTodo'))
  set(UI + 'tools', NS.c + 'open', f.literal('true', f.namedNode(NS.xsd + 'boolean')))
  return store
}

/**
 * The shell with persistence over the given backends, as the host runs it: remembered
 * state is restored before the first projection; `persistence.flush()` writes now.
 */
export async function mountRemembering(backends: Record<string, Backend>, clock?: Clock) {
  const store = workbench(sources(loadStore('oxigraph', todoApp(5), appGraph, ...gallery)))
  const persistence = new Persistence(store, backends, { delayMs: 60_000 })
  await persistence.restore()
  const shell = mount(store, 'sparql', clock)
  persistence.attach(shell.runtime)
  return { ...shell, persistence }
}

/**
 * The site with the navigation effect over an injected location and history (and, given
 * backends, persistence), as the host runs it: storage, then the URL, before the first projection.
 */
export async function mountNavigating(opts: NavigationOptions, backends?: Record<string, Backend>, prefer: 'sparql' | 'function' = 'sparql') {
  const store = sources(loadStore('oxigraph', todoApp(5), appGraph, ...gallery))
  const persistence = backends && new Persistence(store, backends, { delayMs: 60_000 })
  await persistence?.restore()
  const navigation = new Navigation(store, { root: UI + 'shell', ...opts, persistence })
  await navigation.restore()
  const shell = mount(store, prefer)
  persistence?.attach(shell.runtime)
  navigation.attach(shell.runtime, { bus: shell.bus, onNavigate: () => shell.shell.flush() })
  return { ...shell, persistence, navigation }
}

/** `clock` is the host's time (beh:at, beh:dueAt): a ManualClock lets a test move it; by default nothing due fires. */
function mount(store: GraphStore, prefer: 'sparql' | 'function', clock?: Clock) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const runtime = new Runtime(store)
  const layers = [A11Y.Layer, STY.Layer, SEM.SourceLayer, SEM.TooltipLayer, VAL.Layer, VAL.ShapesLayer, KEY.Layer, ST.Layer, ANN.Layer, SEM.DocsLayer, NS.prv + 'Layer']
  const screen = runtime.project({ modality: MOD.Screen, layers, prefer, provenance: true, name: 'screen', roots: [UI + 'shell'] }, (e) => {
    throw e
  })
  const shell = new DomRenderer(screen.index, document.getElementById('app')!, UI + 'shell')
  shell.flush()
  const bus = new EventBus(runtime, screen, { functions: todoReactions, prefer, clock })
  bus.attach(shell, () => shell.flush())
  // Things due later (beh:dueAt) become beh:Due events; one waiting to be shown waits.
  const scheduler = new Scheduler(bus, { shown: (c) => screen.index.isShown(c, new Set([UI + 'shell'])), onHandled: () => shell.flush() })
  scheduler.attach()
  const fire = (el: Element, type: string, init: object = {}) => el.dispatchEvent(new window.Event(type, { bubbles: true, ...init }))
  const app = () => store.factory.namedNode(UI + 'app')
  const value = (p: string) => store.match(app(), store.factory.namedNode(p), null)[0]?.object.value
  const set = (s: string, p: string, o: string) => {
    const f = store.factory
    runtime.apply({ remove: store.match(f.namedNode(s), f.namedNode(p), null), add: [f.quad(f.namedNode(s), f.namedNode(p), o.startsWith('"') ? f.literal(o.slice(1, -1), f.namedNode(NS.xsd + 'boolean')) : f.namedNode(o))] })
  }
  /**
   * A page of the site. 'Playground' is the todo example with the tools open (what the
   * Playground page was before the site had pages); 'Performance' is the docs' live section.
   */
  const showPage = (page: 'Home' | 'Docs' | 'Components' | 'Examples' | 'Playground' | 'Performance') => {
    if (page === 'Playground') {
      set(UI + 'app', UI + 'example', UI + 'ExTodo')
      set(UI + 'tools', NS.c + 'open', '"true"')
    }
    if (page === 'Performance') set(UI + 'app', UI + 'docSection', UI + 'DocPerformance')
    set(UI + 'app', UI + 'page', UI + (({ Playground: 'Examples', Performance: 'Docs' } as Record<string, string>)[page] ?? page))
    shell.flush()
  }
  return { document, window, store, runtime, screen, shell, bus, scheduler, fire, value, showPage }
}

