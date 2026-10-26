import { parseHTML } from 'linkedom'
import { Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { DomRenderer } from '../src/render/dom.ts'
import { HtmlIndex } from '../src/render/html-index.ts'

const prefix = `@prefix ui: <https://example.org/ui#> .
@prefix h: <https://ia2.dev/spec/rdf-html#> .
@prefix sem: <https://semblance.dev/ns/core#> .`
const parse = (text: string) => new Parser().parse(prefix + text)

function mount(graph: string, nativeMoves: boolean) {
  const { document, window } = parseHTML('<!doctype html><html><body><main></main></body></html>')
  const host = document.querySelector('main')!
  const index = new HtmlIndex()
  const renderer = new DomRenderer(index, host, 'https://example.org/ui#workspace')
  const moves: Node[] = []
  const prototype = window.Element.prototype
  const original = Object.getOwnPropertyDescriptor(prototype, 'moveBefore')
  Object.defineProperty(prototype, 'moveBefore', {
    configurable: true,
    value: nativeMoves ? function (this: Element, node: Node, before: Node | null) {
      expect(this.isConnected).toBe(true)
      expect(node.isConnected).toBe(true)
      moves.push(node)
      this.insertBefore(node, before)
    } : undefined,
  })
  index.apply({ add: parse(graph), remove: [] })
  renderer.flush()
  const slot = renderer.slot('page')!
  const iframe = document.createElement('iframe')
  slot.append(iframe)
  return {
    host, renderer, slot, iframe, moves,
    apply(remove: string, add: string) {
      index.apply({ remove: parse(remove), add: parse(add) })
      renderer.flush()
      expect(renderer.slot('page')).toBe(slot)
      expect(slot.firstChild).toBe(iframe)
      expect(iframe.isConnected).toBe(true)
    },
    dispose() {
      if (original) Object.defineProperty(prototype, 'moveBefore', original)
      else Reflect.deleteProperty(prototype, 'moveBefore')
    },
  }
}

describe('state-preserving DOM moves', () => {
  for (const nativeMoves of [true, false]) {
    it(`wraps and unwraps a live host slot (${nativeMoves ? 'moveBefore' : 'insertBefore fallback'})`, () => {
      const app = mount(`ui:root a h:Section ; sem:renders ui:workspace ; h:hasChild ui:slot .
ui:slot a h:Div ; sem:slot "page" .`, nativeMoves)
      try {
        app.apply('ui:root h:hasChild ui:slot .', 'ui:root h:hasChild ui:wrapper . ui:wrapper a h:Div ; h:hasChild ui:slot .')
        expect(app.slot.parentElement).not.toBe(app.host.firstElementChild)
        app.apply('ui:root h:hasChild ui:wrapper . ui:wrapper a h:Div ; h:hasChild ui:slot .', 'ui:root h:hasChild ui:slot .')
        expect(app.slot.parentElement).toBe(app.host.firstElementChild)
        expect(app.moves.filter(node => node === app.slot)).toHaveLength(nativeMoves ? 2 : 0)
      } finally { app.dispose() }
    })
  }

  it('keeps a moved slot connected when its old parent is patched first', () => {
    const app = mount(`ui:root a h:Section ; sem:renders ui:workspace ; h:hasChild ui:left, ui:right .
ui:left a h:Div ; h:hasChild ui:slot . ui:right a h:Div .
ui:slot a h:Div ; sem:slot "page" .`, true)
    try {
      const oldParent = app.slot.parentElement
      app.apply('ui:left h:hasChild ui:slot .', 'ui:right h:hasChild ui:slot .')
      expect(app.slot.parentElement).not.toBe(oldParent)
      expect(app.moves).toContain(app.slot)
    } finally { app.dispose() }
  })
})
