import { parseHTML } from 'linkedom'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { DEFAULT_LAYERS, MOD } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML, toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'

const UI = 'https://example.org/messages#'
const C = 'https://semblance.dev/ns/component#'
const AS = 'https://www.w3.org/ns/activitystreams#'
const prefix = `@prefix ui: <${UI}> . @prefix c: <${C}> . @prefix as: <${AS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> . @prefix prov: <http://www.w3.org/ns/prov#> .`
const graph = prefix + `
ui:thread a c:MessageList ; c:label "Review thread" ; c:viewer ui:ava ;
  c:item ui:plain, ui:rich, ui:summary, ui:hosted, ui:pending .
ui:ava c:label "Ava" .
ui:plain as:attributedTo ui:ava ; as:content "Plain body" ; as:published "2026-01-01T12:00:00Z"^^xsd:dateTime .
ui:rich as:attributedTo ui:ava ; c:content ui:richBody ; as:published "2026-01-01T12:01:00Z"^^xsd:dateTime .
ui:richBody a c:Stack ; c:children (ui:richText ui:reviewed) .
ui:richText a c:Text ; c:label "Detailed component body" .
ui:reviewed a c:ToggleSwitch ; c:label "Reviewed" ; c:checked false .
ui:summary as:attributedTo ui:ava ; as:content "Plain summary" ; c:content ui:summaryBody ; as:published "2026-01-01T12:02:00Z"^^xsd:dateTime .
ui:summaryBody a c:Text ; c:label "Visual component body" .
ui:hosted as:attributedTo ui:ava ; as:content "Host content summary" ; c:content ui:slot ; as:published "2026-01-01T12:03:00Z"^^xsd:dateTime .
ui:slot a c:HostSlot ; c:slot "message-host" .
ui:pending as:attributedTo ui:ava ; c:content ui:pendingBody ; prov:startedAtTime "2026-01-01T12:04:00Z"^^xsd:dateTime .
ui:pendingBody a c:Text ; c:label "Not published yet" .
`
const live: Array<{ runtime: Runtime; detach: () => void }> = []
afterEach(() => { for (const app of live.splice(0)) { app.detach(); app.runtime.dispose() } })

function mount(kind: StoreKind, prefer: 'function' | 'sparql') {
  const { document, window } = parseHTML('<!doctype html><html><body><main></main></body></html>')
  const host = document.querySelector('main')!
  const store = loadStore(kind, graph)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, roots: [UI + 'thread'], name: 'screen', prefer })
  const text = runtime.project({ modality: MOD.Text, layers: DEFAULT_LAYERS, roots: [UI + 'thread'], name: 'text', prefer })
  const renderer = new DomRenderer(screen.index, host, UI + 'thread')
  const bus = new EventBus(runtime, screen, { prefer })
  const detach = bus.attach(renderer, () => renderer.flush())
  live.push({ runtime, detach })
  renderer.flush()
  return { host, document, store, runtime, renderer,
    html: () => toHTML(screen.index, UI + 'thread'),
    text: () => toText(text.index, UI + 'thread'),
    click: (element: Element) => element.dispatchEvent(new window.Event('click', { bubbles: true })),
  }
}

for (const kind of ['wat', 'oxigraph'] as const) describe(`rich messages (${kind})`, () => {
  it('renders component bodies, text summaries and typing with parity through interaction and updates', () => {
    const apps = [mount(kind, 'function'), mount(kind, 'sparql')]
    const parity = () => {
      expect(apps[1]!.html()).toBe(apps[0]!.html())
      expect(apps[1]!.text()).toBe(apps[0]!.text())
    }
    parity()
    for (const app of apps) {
      expect(app.host.querySelectorAll('[data-sem-c="message"]')).toHaveLength(5)
      expect(app.host.textContent).toContain('Detailed component body')
      expect(app.host.textContent).toContain('Visual component body')
      expect(app.host.textContent).not.toContain('Plain summary')
      expect(app.host.querySelector('.sem-message-body')!.tagName).toBe('P')
      expect(app.host.querySelector('[data-sem-c="stack"]')!.closest('.sem-message-body')!.tagName).toBe('DIV')
      expect(app.host.querySelector('.sem-pending')!.textContent).toContain('is typing')
      expect(app.host.textContent).not.toContain('Not published yet')
      expect(app.text()).toContain('Detailed component body')
      expect(app.text()).toContain('Plain summary')
      expect(app.text()).not.toContain('Visual component body')
      const control = app.host.querySelector('[role="switch"]')!
      app.click(control)
      expect(control.getAttribute('aria-checked')).toBe('true')
    }
    parity()
    for (const app of apps) {
      const control = app.host.querySelector('[role="switch"]')!
      const f = app.store.factory
      const subject = f.namedNode(UI + 'richText'), predicate = f.namedNode(C + 'label')
      app.runtime.apply({ remove: app.store.match(subject, predicate, null), add: [f.quad(subject, predicate, f.literal('Updated component body'))] })
      app.renderer.flush()
      expect(app.host.textContent).toContain('Updated component body')
      expect(app.host.querySelector('[role="switch"]')).toBe(control)
    }
    parity()
    for (const app of apps) {
      const f = app.store.factory
      app.runtime.apply({ remove: [], add: [f.quad(f.namedNode(UI + 'pending'),
        f.namedNode(AS + 'published'), f.literal('2026-01-01T12:04:00Z',
          f.namedNode('http://www.w3.org/2001/XMLSchema#dateTime')))] })
      app.renderer.flush()
      expect(app.host.querySelector('.sem-pending')).toBeNull()
      expect(app.host.textContent).toContain('Not published yet')
      expect(app.text()).toContain('Not published yet')
    }
    parity()
  })

  it('keeps a host slot and its draft connected when another message arrives before it', () => {
    for (const prefer of ['function', 'sparql'] as const) {
      const app = mount(kind, prefer)
      const slot = app.renderer.slot('message-host')!
      expect(slot).toBeDefined()
      const field = app.document.createElement('input')
      field.value = 'Unsaved host draft'
      slot.append(field)
      const f = app.store.factory
      const incoming = f.namedNode(UI + 'incoming')
      app.runtime.apply({ remove: [], add: [
        f.quad(f.namedNode(UI + 'thread'), f.namedNode(C + 'item'), incoming),
        f.quad(incoming, f.namedNode(AS + 'content'), f.literal('Earlier incoming message')),
        f.quad(incoming, f.namedNode(AS + 'published'), f.literal('2026-01-01T11:59:00Z', f.namedNode('http://www.w3.org/2001/XMLSchema#dateTime'))),
      ] })
      app.renderer.flush()
      expect(app.host.querySelector('[data-sem-c="message"]')!.textContent).toContain('Earlier incoming message')
      expect(app.renderer.slot('message-host')).toBe(slot)
      expect(slot.firstChild).toBe(field)
      expect(field.value).toBe('Unsaved host draft')
      expect(field.isConnected).toBe(true)
    }
  })
})
