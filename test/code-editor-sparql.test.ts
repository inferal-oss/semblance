// The code editor in SPARQL (#285, ontology/components/editor.ttl): its lines (a node per line, keyed by
// content) and their tokens, its suggestions as data (from the maintained term index, c:TermIndex), and
// its renderings, on screen and as text, the same as the function twins' after every keystroke.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore } from '../src/node/load.ts'
import { DEFAULT_LAYERS, MOD, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import { sameHtml } from './same-html.ts'

const EX = 'https://example.org/editors#'
const app = `
@prefix c: <${NS.c}> .
@prefix ex: <${EX}> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:prefixes sh:declare [ sh:prefix "ex" ; sh:namespace "${EX}"^^xsd:anyURI ] .
ex:Widget a owl:Class ; rdfs:comment "A thing on a page. It has parts." .
ex:widgetSize a owl:DatatypeProperty ; rdfs:comment "How big a widget is, in pixels." .
ex:page a c:Stack ; c:children ( ex:turtle ex:sparql ex:plain ) .
ex:turtle a c:CodeEditor ; c:language "turtle" ; c:label "app.ttl" ;
    c:original """@prefix ex: <https://example.org/x#> .
ex:a a c:Button ;
    c:label "Go" ;
    rdfs:comment \\"\\"\\"two
lines\\"\\"\\" .
ex:a a c:Button .""" .
ex:sparql a c:QueryEditor ; c:label "Query" ; c:value "SELECT * WHERE { ?s ?p ?o }" .
ex:plain a c:CodeEditor ; c:label "Notes" ; c:value "SELECT a note" .
`

function mount(prefer: 'sparql' | 'function') {
  const store = loadStore((process.env.ENGINE as 'wat') ?? 'wat', app)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, name: 'screen', prefer, roots: [EX + 'page'] }, (e) => {
    throw e
  })
  const text = runtime.project({ modality: MOD.Text, name: 'text', prefer, roots: [EX + 'page'] }, (e) => {
    throw e
  })
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div><div id="text"></div></body></html>')
  const renderer = new DomRenderer(screen.index, document.getElementById('app')!, EX + 'page')
  const textRenderer = new DomRenderer(text.index, document.getElementById('text')!, EX + 'page')
  renderer.flush()
  new EventBus(runtime, screen).attach(renderer, () => renderer.flush())
  const editor = (name: string) => document.getElementById(`${EX}${name}/~input`)!.closest('[data-sem-c]')!
  const area = (name: string) => editor(name).querySelector('textarea') as HTMLTextAreaElement
  return {
    screen,
    html: () => (runtime.refresh(), renderer.flush(), textRenderer.flush(), document.getElementById('app')!.innerHTML + '\n----\n' + document.getElementById('text')!.innerHTML),
    options: (name: string) => [...editor(name).querySelectorAll('[role=option] code')].map((o) => o.textContent),
    editor,
    type: (name: string, value: string, caret = value.length) => {
      const ta = area(name)
      ta.value = value
      Object.assign(ta, { selectionStart: caret, selectionEnd: caret })
      ta.dispatchEvent(new window.Event('input', { bubbles: true }))
    },
    press: (name: string, key: string) => {
      const e = new window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
      Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
      area(name).dispatchEvent(e)
    },
  }
}

describe('the code editor in SPARQL', () => {
  it('renders what its function twins render, after every keystroke', () => {
    const [sp, fn] = [mount('sparql'), mount('function')]
    const both = (what: string, step: (h: typeof sp) => void) => {
      step(sp)
      step(fn)
      sameHtml(sp.html(), fn.html(), what)
    }
    sameHtml(sp.html(), fn.html(), 'loading')
    const kinds = (sel: string) => [...sp.editor('turtle').querySelectorAll(sel)].map((s) => s.textContent)
    expect(kinds('.tok-keyword')).toEqual(['@prefix', 'a', 'a'])
    expect(kinds('.tok-string')).toEqual(['"Go"', '"""two', 'lines"""'])
    both('a SPARQL word', (h) => h.type('sparql', 'SELE'))
    expect(sp.options('sparql')).toContain('SELECT')
    both('down', (h) => h.press('sparql', 'ArrowDown'))
    both('a variable', (h) => h.type('sparql', 'SELECT ?subject WHERE { ?subject ?p ?o } ORDER BY ?su'))
    expect(sp.options('sparql')).toEqual(['?subject'])
    both('accepting', (h) => h.press('sparql', 'Tab'))
    both('a lower-case word', (h) => h.type('sparql', 'select * where { ?s ?p ?o } ord'))
    both('a term by its local name', (h) => h.type('sparql', 'SELECT * WHERE { ?s a wid'))
    expect(sp.options('sparql')).toEqual(expect.arrayContaining(['ex:Widget', 'ex:widgetSize']))
    const widget = [...sp.editor('sparql').querySelectorAll('[role=option]')].find((o) => o.querySelector('code')!.textContent === 'ex:Widget')!
    expect(widget.querySelector('.sem-detail')!.textContent).toBe('A thing on a page.')
    both('a prefixed name', (h) => h.type('sparql', 'SELECT * WHERE { ?s a ex:Wi'))
    both('closing', (h) => h.press('sparql', 'Escape'))
    both('a Turtle term', (h) => h.type('turtle', 'ex:b a c:Hea'))
    both('a directive', (h) => h.type('turtle', '@pre'))
    expect(sp.options('turtle')).toEqual(['@prefix'])
    both('in a long string', (h) => h.type('turtle', 'ex:a c:comment """c:Hea'))
    both('a new line', (h) => h.type('turtle', 'ex:a a c:Button .\nex:b a c:Heading .\nex:a a c:Button .'))
    both('empty lines', (h) => h.type('turtle', 'ex:a a c:Button .\n\n\nex:b a c:Heading .\n'))
    both('plain text', (h) => h.type('plain', 'SELE\n\nnotes'))
    expect(sp.screen.engine.stats.byRule.get(NS.c + 'EditorSuggestions-sparql')?.runs ?? 0).toBeGreaterThan(0)
    expect(sp.screen.engine.stats.byRule.get(NS.c + 'CodeEditorRendering-sparql-screen')?.runs ?? 0).toBeGreaterThan(0)
  })

  it('re-tokenizes only the line a keystroke changes', () => {
    const sp = mount('sparql')
    sp.html()
    const runs = () => sp.screen.engine.stats.byRule.get(NS.c + 'EditorLineTokens-sparql')?.runs ?? 0
    const before = runs()
    sp.type('turtle', '@prefix ex: <https://example.org/x#> .\nex:a a c:Button ;\n    c:label "Gone" ;\n    rdfs:comment """two\nlines""" .\nex:a a c:Button .')
    sp.html()
    // The new line's node, and the old one's retraction.
    expect(runs() - before).toBeLessThanOrEqual(2)
  })
})
