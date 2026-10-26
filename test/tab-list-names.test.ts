import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { A11Y, C, MOD } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'

const EX = 'https://example.org/tabs#'
const source = `@prefix c: <https://semblance.dev/ns/component#> .
@prefix ex: <${EX}> .
ex:page a c:Stack ; c:children ( ex:source ex:constraints ex:unnamed ) .
ex:source a c:Tabs ; c:label "Source files" ; c:tabs ( ex:rdf ex:owl ) .
ex:constraints a c:Tabs ; c:label "Constraints"@en, "Обмеження"@uk, "Bedingungen"@de, "القيود"@ar ; c:tabs ( ex:visual ex:raw ) .
ex:unnamed a c:Tabs ; c:tabs ( ex:only ) .
ex:rdf a c:Tab ; c:label "RDF" . ex:owl a c:Tab ; c:label "OWL" .
ex:visual a c:Tab ; c:label "Visual" . ex:raw a c:Tab ; c:label "Source" . ex:only a c:Tab ; c:label "Only" .`

function mount(kind: StoreKind, prefer: 'sparql' | 'function') {
  const store = loadStore(kind, source)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer], languages: ['en'], prefer, roots: [EX + 'page'] }, e => { throw e })
  const { document, window } = parseHTML('<html><body><main></main></body></html>')
  const dom = new DomRenderer(screen.index, document.querySelector('main')!, EX + 'page')
  dom.flush()
  const bus = new EventBus(runtime, screen, { prefer })
  bus.attach(dom, () => dom.flush())
  const lists = () => [...document.querySelectorAll('[role=tablist]')].map(e => e.getAttribute('aria-label'))
  const html = () => toHTML(screen.index, EX + 'page')
  const f = store.factory
  const names = (value?: string) => {
    const node = f.namedNode(EX + 'source'), predicate = f.namedNode(C.label)
    runtime.apply({ remove: store.match(node, predicate, null), add: value === undefined ? [] : [f.quad(node, predicate, f.literal(value))] })
    dom.flush()
  }
  const language = (value: string) => { screen.engine.reconfigure({ languages: [value] }); dom.flush() }
  const select = () => {
    document.querySelectorAll('[role=tab]')[1]!.dispatchEvent(new window.Event('click', { bubbles: true }))
    expect(store.match(f.namedNode(EX + 'source'), f.namedNode(C.selected), null).map(q => q.object.value)).toEqual([EX + 'owl'])
    expect(document.querySelectorAll('[role=tab]')[1]!.getAttribute('aria-selected')).toBe('true')
  }
  return { lists, html, names, language, select }
}

describe.each(['wat', 'oxigraph'] as StoreKind[])('accessible tab-list names (%s)', kind => {
  it('keeps SPARQL/function parity through selection, localization and label changes', () => {
    const a = mount(kind, 'sparql'), b = mount(kind, 'function')
    const check = (names: (string | null)[]) => {
      expect(a.lists()).toEqual(names)
      expect(b.lists()).toEqual(names)
      expect(a.html()).toBe(b.html())
    }
    check(['Source files', 'Constraints', null])
    a.select(); b.select(); check(['Source files', 'Constraints', null])
    for (const [language, label] of [['uk', 'Обмеження'], ['de', 'Bedingungen'], ['ar', 'القيود']]) {
      a.language(language!); b.language(language!); check(['Source files', label!, null])
    }
    a.names('Selected snapshot'); b.names('Selected snapshot'); check(['Selected snapshot', 'القيود', null])
    a.names(); b.names(); check([null, 'القيود', null])
  })
})
