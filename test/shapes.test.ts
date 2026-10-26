import type { Term } from '@rdfjs/types'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { MOD, NS, SEM, VAL } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const SH = 'http://www.w3.org/ns/shacl#'
const C = NS.c

// Controls a c:Field can wrap, each labelled by a Field, standing alone without a c:label, and as
// the c:content of something that is not a Field (a tab): only the Field labels its content.
const graph = `
@prefix c: <${C}> .
@prefix ui: <${UI}> .
ui:root a c:Stack ; c:children ( ui:sl-field ui:tf-field ui:ci-field ui:tf-date ui:tf-unsupported ui:sl-alone ui:tf-alone ui:ci-alone ui:sl-own ui:tabs ) .
ui:sl-field a c:Field ; c:label "Brightness" ; c:content ui:sl-in-field .
ui:sl-in-field a c:Slider ; c:value 60 .
ui:tf-field a c:Field ; c:label "Name" ; c:content ui:tf-in-field .
ui:tf-in-field a c:TextField ; c:placeholder "Ada" .
ui:tf-date a c:TextField ; c:label "Due" ; c:inputType "date" .
ui:tf-unsupported a c:TextField ; c:label "Colour" ; c:inputType "color" .
ui:ci-field a c:Field ; c:label "Code" ; c:content ui:ci-in-field .
ui:ci-in-field a c:CodeInput ; c:length 6 .
ui:sl-alone a c:Slider ; c:value 10 .
ui:tf-alone a c:TextField ; c:placeholder "Ada" .
ui:ci-alone a c:CodeInput ; c:length 6 .
ui:sl-own a c:Slider ; c:label "Volume" ; c:value 30 .
ui:tabs a c:Tabs ; c:tabs ( ui:tab ) .
ui:tab a c:Tab ; c:label "One" ; c:content ui:sl-in-tab .
ui:sl-in-tab a c:Slider ; c:value 20 .
`

function validate(kind: StoreKind, prefer: 'sparql' | 'function') {
  const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const store = loadStore(kind, graph)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: [VAL.ShapesLayer, SEM.TooltipLayer], prefer, name: 'screen', roots: [UI + 'root'] }, (e) => {
    throw e
  })
  const dom = new DomRenderer(screen.index, document.getElementById('app')!, UI + 'root')
  dom.flush()
  const f = store.factory
  const results = (id: string) => store.match(null, f.namedNode(SH + 'focusNode'), f.namedNode(UI + id)).map((q) => q.subject)
  const about = (r: Term, p: string) => store.match(r, f.namedNode(SH + p), null).map((q) => q.object.value)
  const root = (id: string) => [...document.querySelectorAll('*')].find((e) => dom.keyOf(e) === `${UI}${id}/~root`) as HTMLElement
  const all = store
    .match(null, f.namedNode(SH + 'focusNode'), null)
    .flatMap((q) => store.match(q.subject, null, null))
    .map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`)
    .sort()
  return { store, runtime, dom, screen, results, about, root, all }
}

const runs = [
  ['oxigraph', 'sparql'],
  ['oxigraph', 'function'],
  ['wat', 'sparql'],
  ['wat', 'function'],
  ['rust', 'sparql'],
] as const

describe('component shapes: a c:Field labels its content (sh:or with an inverse path)', () => {
  for (const [kind, prefer] of runs) {
    it(`asks a control for its own c:label only when no Field labels it (${kind}, ${prefer})`, () => {
      const h = validate(kind, prefer)
      // The preferred implementation is the one that ran.
      expect(h.screen.engine.stats.byRule.get(`${NS.val}Shapes-${prefer === 'sparql' ? 'sparql' : 'fn'}`)?.runs).toBeGreaterThan(0)
      // Inside a Field, or with a label of its own: no violation.
      for (const id of ['sl-in-field', 'tf-in-field', 'tf-date', 'ci-in-field', 'sl-own']) {
        expect(h.results(id), id).toEqual([])
        expect(h.root(id).hasAttribute('data-sem-shape-invalid'), id).toBe(false)
      }
      expect(h.root('tf-date').querySelector('input')?.getAttribute('type')).toBe('date')
      const unsupported = h.results('tf-unsupported')
      expect(unsupported).toHaveLength(1)
      expect(h.about(unsupported[0]!, 'resultPath')).toEqual([C + 'inputType'])
      expect(h.root('tf-unsupported').getAttribute('data-sem-shape-invalid')).toBe('1')
      // Standalone without a label, or the content of a tab: one sh:or result about the focus itself.
      const expected = {
        'sl-alone': ['SliderShape', 'A slider needs a label'],
        'tf-alone': ['TextFieldShape', 'A text field needs a label'],
        'ci-alone': ['CodeInputShape', 'A code input needs a label'],
        'sl-in-tab': ['SliderShape', 'A slider needs a label'],
      }
      for (const [id, [shape, message]] of Object.entries(expected)) {
        const rs = h.results(id)
        expect(rs, id).toHaveLength(1)
        const r = rs[0]!
        expect(h.about(r, 'sourceShape'), id).toEqual([C + shape])
        expect(h.about(r, 'value'), id).toEqual([UI + id])
        expect(h.about(r, 'resultPath'), id).toEqual([])
        expect(h.about(r, 'resultSeverity'), id).toEqual([SH + 'Violation'])
        expect(h.about(r, 'resultMessage')[0], id).toContain(message)
        expect(h.root(id).getAttribute('data-sem-shape-invalid'), id).toBe('1')
        expect(h.root(id).getAttribute('data-sem-tooltip'), id).toContain(message)
      }
      // Its own label fixes it.
      const f = h.store.factory
      h.runtime.apply({ remove: [], add: [f.quad(f.namedNode(UI + 'sl-alone'), f.namedNode(C + 'label'), f.literal('Level'))] })
      h.dom.flush()
      expect(h.results('sl-alone')).toEqual([])
      expect(h.root('sl-alone').hasAttribute('data-sem-shape-invalid')).toBe(false)
    })
  }

  it('the SPARQL rule and its function twin record the same results', () => {
    const reference = validate('oxigraph', 'function').all
    expect(reference.length).toBeGreaterThan(0)
    for (const [kind, prefer] of runs) expect(validate(kind, prefer).all, `${kind}, ${prefer}`).toEqual(reference)
  })
})

describe('the Inputs gallery conforms to the component shapes', () => {
  for (const prefer of ['sparql', 'function'] as const) {
    it(`flags nothing, the Field specimen's label-less slider included (${prefer})`, () => {
      const h = mountShell(5, 'oxigraph', prefer)
      const f = h.store.factory
      h.showPage('Components')
      const app = f.namedNode(UI + 'app')
      const group = f.namedNode(UI + 'galleryGroup')
      h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupInputs'))] })
      h.shell.flush()
      expect(h.shell.nodeOf(UI + 'inp-f-level-input/~root')).toBeTruthy()
      expect(h.store.match(null, f.namedNode(SH + 'focusNode'), null).map((q) => q.object.value)).toEqual([])
      expect(h.document.querySelectorAll('[data-sem-shape-invalid]')).toHaveLength(0)
    })
  }
})
