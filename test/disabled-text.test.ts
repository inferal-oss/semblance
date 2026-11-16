import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore } from '../src/node/load.ts'
import { A11Y, KEY, MOD, NS, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'

const EX = 'https://example.org/disabled-text#'
const C = NS.c
const graph = (component: string, disabled: boolean) => `
@prefix ex: <${EX}> .
@prefix c: <${C}> .
ex:page a c:Stack ; c:children ( ex:field ) .
ex:field a c:${component} ; c:label "Reviewed value" ;
  c:value "original" ; c:error "Retain this error" ; c:disabled ${disabled} .
`

function mount(kind: 'wat' | 'oxigraph' | 'n3', component: string, prefer: 'sparql' | 'function', initiallyDisabled: boolean) {
  const store = loadStore(kind, graph(component, initiallyDisabled))
  const runtime = new Runtime(store)
  const root = EX + 'page'
  const screen = runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer, KEY.Layer], prefer, name: 'screen', roots: [root] }, (e) => { throw e })
  const text = runtime.project({ modality: MOD.Text, layers: [], prefer, name: 'text', roots: [root] }, (e) => { throw e })
  const { document, window } = parseHTML('<!doctype html><html><body><main></main></body></html>')
  const renderer = new DomRenderer(screen.index, document.querySelector('main')!, root)
  renderer.flush()
  const bus = new EventBus(runtime, screen, { prefer })
  const detach = bus.attach(renderer, () => renderer.flush())
  const f = store.factory, field = f.namedNode(EX + 'field')
  const input = () => document.querySelector(component === 'TextArea' ? 'textarea' : 'input')! as HTMLInputElement
  const values = (property: string) => store.match(field, f.namedNode(C + property), null, f.defaultGraph()).map((q) => q.object.value)
  const setDisabled = (value: boolean | undefined) => {
    runtime.apply({ remove: store.match(field, f.namedNode(C + 'disabled'), null), add: value === undefined ? [] : [f.quad(field, f.namedNode(C + 'disabled'), f.literal(String(value), f.namedNode(NS.xsd + 'boolean')))] })
    renderer.flush()
  }
  const type = (value: string) => {
    input().value = value
    input().dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  const snapshot = () => ({ screen: toHTML(screen.index, root), text: toHTML(text.index, root), value: values('value'), error: values('error') })
  return { input, values, setDisabled, type, snapshot, dispose() { detach(); runtime.dispose(); store.dispose?.() } }
}

describe('disabled text entries', () => {
  for (const component of ['TextField', 'TextArea']) {
    for (const kind of ['wat', 'oxigraph', 'n3'] as const) {
      it(`${component} locks and unlocks the native control and its input reaction (${kind})`, () => {
        const variants = kind === 'n3' ? ['function'] as const : ['sparql', 'function'] as const
        const histories = []
        for (const prefer of variants) {
          const h = mount(kind, component, prefer, true)
          try {
            const snapshots = [h.snapshot()]
            const original = h.input()
            expect(original.hasAttribute('disabled')).toBe(true)
            h.type('must be ignored')
            expect(h.values('value')).toEqual(['original'])
            expect(h.values('error')).toEqual(['Retain this error'])
            snapshots.push(h.snapshot())

            h.setDisabled(false)
            expect(h.input()).toBe(original)
            expect(h.input().hasAttribute('disabled')).toBe(false)
            h.type('accepted')
            expect(h.values('value')).toEqual(['accepted'])
            expect(h.values('error')).toEqual([])
            snapshots.push(h.snapshot())

            h.setDisabled(true)
            expect(h.input()).toBe(original)
            expect(h.input().hasAttribute('disabled')).toBe(true)
            h.type('must also be ignored')
            expect(h.values('value')).toEqual(['accepted'])
            snapshots.push(h.snapshot())

            h.setDisabled(undefined)
            expect(h.input().hasAttribute('disabled')).toBe(false)
            h.type('restored')
            expect(h.values('value')).toEqual(['restored'])
            snapshots.push(h.snapshot())
            histories.push(snapshots)
          } finally { h.dispose() }
        }
        if (histories.length === 2) expect(histories[0]).toEqual(histories[1])
      })
    }
  }
})
