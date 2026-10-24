import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { EventBus } from '../src/behaviour/events.ts'
import { todoApp, todoReactions } from '../src/examples/todo.ts'
import { loadStore } from '../src/node/load.ts'
import { A11Y, MOD, SEM, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'

const UI = 'https://semblance.dev/demo#'
const appGraph = readFileSync(new URL('../demo/app.ttl', import.meta.url), 'utf8')

/** The demo's whole interface (demo/app.ttl), projected into a DOM and driven only through events. */
export function mountShell(todos = 5, kind: 'oxigraph' | 'hybrid' | 'n3' = 'oxigraph') {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const store = loadStore(kind, todoApp(todos), appGraph)
  const runtime = new Runtime(store)
  const layers = [A11Y.Layer, STY.Layer, SEM.SourceLayer, SEM.TooltipLayer]
  const screen = runtime.project({ modality: MOD.Screen, layers, provenance: true, name: 'screen', roots: [UI + 'shell'] }, (e) => {
    throw e
  })
  const shell = new DomRenderer(screen.index, document.getElementById('app')!, UI + 'shell')
  shell.flush()
  const bus = new EventBus(runtime, screen, { functions: todoReactions })
  bus.attach(shell, () => shell.flush())
  const fire = (el: Element, type: string, init: object = {}) => el.dispatchEvent(new window.Event(type, { bubbles: true, ...init }))
  const app = () => store.factory.namedNode(UI + 'app')
  const value = (p: string) => store.match(app(), store.factory.namedNode(p), null)[0]?.object.value
  const showPage = (page: 'Playground' | 'Performance') => {
    const f = store.factory
    runtime.apply({ remove: store.match(app(), f.namedNode(UI + 'page'), null), add: [f.quad(app(), f.namedNode(UI + 'page'), f.namedNode(UI + page))] })
    shell.flush()
  }
  return { document, window, store, runtime, screen, shell, bus, fire, value, showPage }
}

