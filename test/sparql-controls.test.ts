// The actions, inputs, feedback and overlays components have SPARQL and function rules,
// and both render the same thing.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { todoApp } from '../src/examples/todo.ts'
import { loadStore } from '../src/node/load.ts'
import { A11Y, MOD, NS, RDF_TYPE, XSD_BOOLEAN } from '../src/ns.ts'
import { type Literal, owningFocus, termKey } from '../src/rdf.ts'
import { Runtime } from '../src/runtime.ts'
import { expectSameRendering, implementationGaps } from './implementations.ts'

const FILES = ['components/actions.ttl', 'components/inputs.ttl', 'components/feedback.ttl', 'components/overlays.ttl']
const CLASSES = [
  ...['IconButton', 'ButtonGroup', 'Menu', 'MenuItem'],
  ...['TextArea', 'Checkbox', 'RadioGroup', 'ToggleSwitch', 'Slider', 'Field'],
  ...['Badge', 'Alert', 'Tag', 'Spinner', 'Skeleton', 'EmptyState', 'Toast', 'ToastRegion'],
  ...['Dialog', 'Drawer', 'Popover'],
  'Button', // c:OpenerAria decorates buttons
].map((c) => NS.c + c)

const UI = 'https://semblance.dev/demo#'
const demo = new URL('../demo/', import.meta.url)
const gallery = readdirSync(new URL('gallery/', demo))
  .filter((f) => f.endsWith('.ttl'))
  .sort()
  .map((f) => readFileSync(new URL('gallery/' + f, demo), 'utf8'))

/**
 * Everything the demo's instances of CLASSES render (every instance, shown or not), as
 * N-Triples-like lines per class: the rules' output for the subjects minted under each focus,
 * for what the four gallery pages and the desktop (dialogs, drawers, toasts) show. `toggled`
 * opens every menu, dialog, drawer and popover, closes every toast and removes every tag, so the
 * other branch of each rule runs too.
 */
function derived(prefer: 'sparql' | 'function', modality: string, state: 'initial' | 'toggled' | 'edge') {
  const store = loadStore('oxigraph', todoApp(5), readFileSync(new URL('app.ttl', demo), 'utf8'), ...gallery)
  const f = store.factory
  const flag = (cls: string, p: string, v: boolean) => {
    for (const q of store.match(null, f.namedNode(RDF_TYPE), f.namedNode(NS.c + cls))) {
      for (const old of store.match(q.subject, f.namedNode(NS.c + p), null)) store.delete(old)
      store.add(f.quad(q.subject, f.namedNode(NS.c + p), f.literal(String(v), f.namedNode(XSD_BOOLEAN))))
    }
  }
  if (state === 'toggled') {
    for (const cls of ['Menu', 'Dialog', 'Drawer', 'Popover']) flag(cls, 'open', true)
    flag('Toast', 'open', false)
    flag('Tag', 'removed', true)
  }
  const set = (s: string, p: string, o: Literal) => {
    for (const old of store.match(f.namedNode(UI + s), f.namedNode(NS.c + p), null)) store.delete(old)
    store.add(f.quad(f.namedNode(UI + s), f.namedNode(NS.c + p), o))
  }
  if (state === 'edge') {
    // Values the rules format or split: multi-line text (and more lines than the SPARQL rule
    // has indices for), slider values out of range or between steps, odd skeletons.
    set('inp-ta-about', 'value', f.literal('first\n\nthird line\n'))
    set('inp-ta-error', 'value', f.literal(Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n')))
    set('inp-sl-volume', 'value', f.literal('140', f.namedNode(NS.xsd + 'integer')))
    set('inp-sl-opacity', 'value', f.literal('0.333', f.namedNode(NS.xsd + 'decimal')))
    set('inp-sl-temp', 'value', f.literal('-3', f.namedNode(NS.xsd + 'integer')))
    set('fb-skel-lines', 'lines', f.literal('20', f.namedNode(NS.xsd + 'integer')))
    set('fb-skel-para', 'shape', f.literal('hexagon'))
  }
  const roots = ['gallery-actions', 'gallery-inputs', 'gallery-feedback', 'gallery-overlays', 'desktop'].map((r) => UI + r)
  const p = new Runtime(store).project({ modality, layers: [A11Y.Layer], prefer, name: 'compare', roots })
  const classOf = new Map<string, string>()
  for (const g of [f.defaultGraph(), p.engine.graph]) {
    for (const q of store.match(null, f.namedNode(RDF_TYPE), null, g)) if (CLASSES.includes(q.object.value)) classOf.set(q.subject.value, q.object.value)
  }
  const out = new Map<string, string[]>()
  for (const q of store.match(null, null, null, p.engine.graph)) {
    // Placements of child components (`child ord:immediatelyPrecedes child`) are compared as HTML below.
    if (!q.subject.value.includes('/~')) continue
    const cls = classOf.get(owningFocus(q.subject.value))
    if (!cls) continue
    if (!out.has(cls)) out.set(cls, [])
    out.get(cls)!.push(termKey(q.subject) + ' ' + q.predicate.value + ' ' + termKey(q.object))
  }
  for (const lines of out.values()) lines.sort()
  return out
}

describe('SPARQL rules of the actions, inputs, feedback and overlays components', () => {
  it('every rendering has a SPARQL and a function implementation', () => {
    expect(implementationGaps(FILES)).toEqual({ noSparql: [], noFunction: [] })
  })

  it('renders the gallery pages identically either way', () => {
    expectSameRendering(['GroupActions', 'GroupInputs', 'GroupFeedback', 'GroupOverlays'])
  })

  for (const modality of [MOD.Screen, MOD.Text]) {
    for (const state of ['initial', 'toggled', 'edge'] as const) {
      it(`derives the same RDF/HTML (${modality.replace(/.*#/, '')}, ${state})`, () => {
        const a = derived('sparql', modality, state)
        const b = derived('function', modality, state)
        // Every class renders something (menu items only while their menu is open).
        expect(a.size).toBe(state === 'toggled' ? CLASSES.length : CLASSES.length - 1)
        for (const cls of CLASSES) expect(a.get(cls) ?? [], cls.replace(/.*#/, '')).toEqual(b.get(cls) ?? [])
      })
    }
  }
})
