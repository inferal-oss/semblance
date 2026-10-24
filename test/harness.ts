import { readdirSync, readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { EventBus } from '../src/behaviour/events.ts'
import { todoApp, todoReactions } from '../src/examples/todo.ts'
import { docsReactions } from '../src/layers/docs.ts'
import { reactions as workbenchReactions } from '../src/components/workbench.ts'
import { type Backend, Persistence, persistenceReactions } from '../src/persistence.ts'
import type { GraphStore } from '../src/store/types.ts'
import { loadStore } from '../src/node/load.ts'
import { A11Y, ANN, KEY, MOD, SEM, ST, STY, VAL } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'

const UI = 'https://semblance.dev/demo#'
const appGraph = readFileSync(new URL('../demo/app.ttl', import.meta.url), 'utf8')
const galleryDir = new URL('../demo/gallery/', import.meta.url)
const gallery = readdirSync(galleryDir).filter((f) => f.endsWith('.ttl')).sort().map((f) => readFileSync(new URL(f, galleryDir), 'utf8'))

/** The demo's whole interface (demo/app.ttl), projected into a DOM and driven only through events. */
export function mountShell(todos = 5, kind: 'oxigraph' | 'hybrid' | 'n3' = 'oxigraph', prefer: 'sparql' | 'function' = 'sparql') {
  return mount(loadStore(kind, todoApp(todos), appGraph, ...gallery), prefer)
}

/**
 * The shell with persistence over the given backends, as the host runs it: remembered
 * state is restored before the first projection; `persistence.flush()` writes now.
 */
export async function mountRemembering(backends: Record<string, Backend>) {
  const store = loadStore('oxigraph', todoApp(5), appGraph, ...gallery)
  const persistence = new Persistence(store, backends, { delayMs: 60_000 })
  await persistence.restore()
  const shell = mount(store, 'sparql')
  persistence.attach(shell.runtime)
  return { ...shell, persistence }
}

function mount(store: GraphStore, prefer: 'sparql' | 'function') {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const runtime = new Runtime(store)
  const layers = [A11Y.Layer, STY.Layer, SEM.SourceLayer, SEM.TooltipLayer, VAL.Layer, VAL.ShapesLayer, KEY.Layer, ST.Layer, ANN.Layer, SEM.DocsLayer]
  const screen = runtime.project({ modality: MOD.Screen, layers, prefer, provenance: true, name: 'screen', roots: [UI + 'shell'] }, (e) => {
    throw e
  })
  const shell = new DomRenderer(screen.index, document.getElementById('app')!, UI + 'shell')
  shell.flush()
  const bus = new EventBus(runtime, screen, { functions: { ...todoReactions, ...docsReactions, ...persistenceReactions, ...workbenchReactions }, prefer })
  bus.attach(shell, () => shell.flush())
  const fire = (el: Element, type: string, init: object = {}) => el.dispatchEvent(new window.Event(type, { bubbles: true, ...init }))
  const app = () => store.factory.namedNode(UI + 'app')
  const value = (p: string) => store.match(app(), store.factory.namedNode(p), null)[0]?.object.value
  const showPage = (page: 'Playground' | 'Performance' | 'Components') => {
    const f = store.factory
    runtime.apply({ remove: store.match(app(), f.namedNode(UI + 'page'), null), add: [f.quad(app(), f.namedNode(UI + 'page'), f.namedNode(UI + page))] })
    shell.flush()
  }
  return { document, window, store, runtime, screen, shell, bus, fire, value, showPage }
}

