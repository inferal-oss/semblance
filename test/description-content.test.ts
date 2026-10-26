import { parseHTML } from 'linkedom'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { DEFAULT_LAYERS, MOD } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML, toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'

const UI = 'https://example.org/facts#'
const C = 'https://semblance.dev/ns/component#'
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const graph = `@prefix ui: <${UI}> . @prefix c: <${C}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ui:root a c:Stack ; c:children (ui:facts ui:metrics ui:headersView) .
ui:facts a c:DescriptionList ; c:items (ui:plain ui:rich ui:summary ui:hosted) .
ui:plain c:label "Region" ; c:value "North" .
ui:rich c:label "Checklist" ; c:content ui:body .
ui:body a c:Stack ; c:children (ui:bodyText ui:reviewed ui:nested) .
ui:bodyText a c:Text ; c:label "Interactive note" .
ui:reviewed a c:ToggleSwitch ; c:label "Reviewed" ; c:checked false .
ui:nested a c:DescriptionList ; c:items (ui:build) .
ui:build c:label "Build" ; c:value 42 .
ui:summary c:label "Details" ; c:value "Text summary" ; c:content ui:visual .
ui:visual a c:Text ; c:label "Visual details" .
ui:hosted c:label "Editor" ; c:value "Host editor summary" ; c:content ui:slot .
ui:slot a c:HostSlot ; c:slot "editor" .
ui:metrics a c:DescriptionList ; c:of ui:measure ; c:fields (ui:latency) .
ui:measure ui:latency 1234.5 . ui:latency rdfs:label "Latency" ; c:unit "ms" .
ui:headersView a c:DescriptionList ; c:of ui:headers ; c:entryProperty ui:entry ; c:keyProperty ui:name ; c:valueProperty ui:detail .
ui:headers ui:entry ui:etag . ui:etag ui:name "ETag" ; ui:detail "sample" .`
const live: Array<{ runtime: Runtime; detach: () => void }> = []
afterEach(() => { for (const app of live.splice(0)) { app.detach(); app.runtime.dispose() } })

function mount(kind: StoreKind, prefer: 'function' | 'sparql') {
  const { document, window } = parseHTML('<!doctype html><html><body><main></main></body></html>')
  const host = document.querySelector('main')!
  const store = loadStore(kind, graph)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, roots: [UI + 'root'], prefer })
  const text = runtime.project({ modality: MOD.Text, layers: DEFAULT_LAYERS, roots: [UI + 'root'], prefer })
  const renderer = new DomRenderer(screen.index, host, UI + 'root')
  const bus = new EventBus(runtime, screen, { prefer })
  const detach = bus.attach(renderer, () => renderer.flush())
  live.push({ runtime, detach })
  renderer.flush()
  return { host, document, store, runtime, renderer,
    html: () => toHTML(screen.index, UI + 'root'), text: () => toText(text.index, UI + 'root'),
    click: (element: Element) => element.dispatchEvent(new window.Event('click', { bubbles: true })),
  }
}

for (const kind of ['wat', 'oxigraph'] as const) describe(`component description values (${kind})`, () => {
  it('renders nested components and preserves summaries, fields and entries with parity through updates', () => {
    const apps = [mount(kind, 'function'), mount(kind, 'sparql')]
    const parity = () => {
      expect(apps[1]!.html()).toBe(apps[0]!.html())
      expect(apps[1]!.text()).toBe(apps[0]!.text())
    }
    parity()
    for (const app of apps) {
      expect(app.host.textContent).toContain('Interactive note')
      expect(app.host.textContent).toContain('Visual details')
      expect(app.host.textContent).not.toContain('Text summary')
      expect(app.host.textContent).toContain('1,234.5 ms')
      expect(app.host.textContent).toContain('ETagsample')
      expect(app.host.textContent).toContain('Build42')
      expect(app.text()).toContain('Text summary')
      expect(app.text()).not.toContain('Visual details')
      expect(app.text()).toContain('Interactive note')
      expect(app.text()).toContain('Host editor summary')
      const control = app.host.querySelector('[role="switch"]')!
      expect(control.closest('dd')).not.toBeNull()
      app.click(control)
      expect(control.getAttribute('aria-checked')).toBe('true')
    }
    parity()
    for (const app of apps) {
      const control = app.host.querySelector('[role="switch"]')!
      const f = app.store.factory
      const subject = f.namedNode(UI + 'bodyText'), predicate = f.namedNode(C + 'label')
      app.runtime.apply({ remove: app.store.match(subject, predicate, null),
        add: [f.quad(subject, predicate, f.literal('Updated note'))] })
      app.renderer.flush()
      expect(app.host.textContent).toContain('Updated note')
      expect(app.host.querySelector('[role="switch"]')).toBe(control)
    }
    parity()
  })

  it('retains a host editor and its draft when an item is inserted before it', () => {
    for (const prefer of ['function', 'sparql'] as const) {
      const app = mount(kind, prefer)
      const slot = app.renderer.slot('editor')!
      expect(slot).toBeDefined()
      expect(slot.closest('dd')).not.toBeNull()
      const input = app.document.createElement('input')
      input.value = 'Keep this draft'
      slot.append(input)
      const f = app.store.factory
      const subject = f.namedNode(UI + 'facts'), property = f.namedNode(C + 'items')
      const before = app.store.match(subject, property, null)
      const cell = f.namedNode(UI + 'newCell'), item = f.namedNode(UI + 'newItem')
      app.runtime.apply({ remove: before, add: [
        f.quad(subject, property, cell), f.quad(cell, f.namedNode(RDF + 'first'), item),
        f.quad(cell, f.namedNode(RDF + 'rest'), before[0]!.object),
        f.quad(item, f.namedNode(C + 'label'), f.literal('Earlier')),
        f.quad(item, f.namedNode(C + 'value'), f.literal('Added')),
      ] })
      app.renderer.flush()
      expect(app.host.querySelector('dt')!.textContent).toBe('Earlier')
      expect(app.renderer.slot('editor')).toBe(slot)
      expect(slot.firstChild).toBe(input)
      expect(input.value).toBe('Keep this draft')
      expect(input.isConnected).toBe(true)
    }
  })
})
