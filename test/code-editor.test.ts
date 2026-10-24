import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore } from '../src/node/load.ts'
import { DEFAULT_LAYERS, MOD, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'

// The code editor (ontology/components/editor.ttl): one component for every language it knows,
// of which the SPARQL workbench's editor (c:QueryEditor) is the SPARQL one. Driven through
// events, as a person types.

const EX = 'https://example.org/editors#'
const app = `
@prefix c: <${NS.c}> .
@prefix ex: <${EX}> .
ex:page a c:Stack ; c:children ( ex:turtle ex:sparql ex:plain ) .
ex:turtle a c:CodeEditor ; c:language "turtle" ; c:label "app.ttl" ;
    c:original """@prefix ex: <https://example.org/x#> .
ex:a a c:Button ; c:label "Go" .""" .
ex:sparql a c:QueryEditor ; c:label "Query" ; c:value "SELECT * WHERE { ?s ?p ?o }" .
ex:plain a c:CodeEditor ; c:label "Notes" ; c:value "SELECT a note" .
`

function mount(kind: 'wat' | 'oxigraph' = 'wat') {
  const store = loadStore(kind, app)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, name: 'screen', roots: [EX + 'page'] }, (e) => {
    throw e
  })
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const renderer = new DomRenderer(screen.index, document.getElementById('app')!, EX + 'page')
  renderer.flush()
  new EventBus(runtime, screen).attach(renderer, () => renderer.flush())
  const editor = (name: string) => document.getElementById(`${EX}${name}/~input`)!.closest('[data-sem-c]')!
  const area = (name: string) => editor(name).querySelector('textarea') as HTMLTextAreaElement
  const type = (name: string, text: string, caret = text.length) => {
    const ta = area(name)
    ta.value = text
    Object.assign(ta, { selectionStart: caret, selectionEnd: caret })
    ta.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  const press = (name: string, key: string) => {
    const e = new window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
    area(name).dispatchEvent(e)
    return e
  }
  const options = (name: string) => [...editor(name).querySelectorAll('[role=option] code')].map((o) => o.textContent)
  const value = (name: string) => store.match(store.factory.namedNode(EX + name), store.factory.namedNode(NS.c + 'value'), null)[0]?.object.value
  return { store, runtime, screen, document, editor, area, type, press, options, value }
}

describe('the code editor (c:CodeEditor)', () => {
  it('shows its text as written (c:original) until edited, with line numbers and Turtle tokens', () => {
    const h = mount()
    const ed = h.editor('turtle')
    expect(ed.getAttribute('data-sem-c')).toBe('code-editor')
    expect(h.area('turtle').getAttribute('aria-label')).toBe('app.ttl')
    expect(h.area('turtle').getAttribute('aria-autocomplete')).toBe('list')
    expect(h.area('turtle').value).toContain('ex:a a c:Button')
    expect(ed.querySelector('.sem-gutter')!.textContent).toBe('1\n2')
    const kinds = (sel: string) => [...ed.querySelectorAll(sel)].map((s) => s.textContent)
    expect(kinds('.tok-keyword')).toEqual(['@prefix', 'a'])
    expect(kinds('.tok-pname')).toEqual(expect.arrayContaining(['ex:', 'ex:a', 'c:Button', 'c:label']))
    expect(kinds('.tok-string')).toEqual(['"Go"'])
    // Its value is graph state once typed; the text as written stays.
    h.type('turtle', 'ex:b a c:Heading .')
    expect(h.value('turtle')).toBe('ex:b a c:Heading .')
    expect(h.editor('turtle').querySelector('.sem-gutter')!.textContent).toBe('1')
  })

  it("completes Turtle with prefixed names from the graph and Turtle's own words, not SPARQL's", () => {
    const h = mount()
    h.type('turtle', 'ex:b a c:Hea')
    expect(h.options('turtle')).toContain('c:Heading')
    expect(h.press('turtle', 'Tab').defaultPrevented).toBe(true)
    expect(h.value('turtle')).toBe('ex:b a c:Heading')
    // A directive: @pre... becomes @prefix.
    h.type('turtle', '@pre')
    expect(h.options('turtle')).toEqual(['@prefix'])
    h.press('turtle', 'Enter')
    expect(h.value('turtle')).toBe('@prefix')
    // SPARQL's words and variables are SPARQL's.
    h.type('turtle', 'SELE')
    expect(h.options('turtle')).not.toContain('SELECT')
    h.type('turtle', '?s ?')
    expect(h.options('turtle')).toEqual([])
    // Nothing is suggested inside a long string.
    h.type('turtle', 'ex:a c:comment """c:Hea')
    expect(h.options('turtle')).toEqual([])
  })

  it('is the SPARQL editor in SPARQL (c:QueryEditor), and plain text without a language', () => {
    const h = mount()
    h.type('sparql', 'SELE')
    expect(h.options('sparql')).toContain('SELECT')
    h.type('sparql', 'SELECT ?subject WHERE { ?subject ?p ?o } ORDER BY ?su')
    expect(h.options('sparql')).toEqual(['?subject'])
    expect([...h.editor('sparql').querySelectorAll('.tok-keyword')].map((s) => s.textContent)).toContain('SELECT')
    // A code editor in no language it knows highlights nothing and suggests no words.
    expect(h.editor('plain').querySelectorAll('.sem-highlight span')).toHaveLength(0)
    h.type('plain', 'SELE')
    expect(h.options('plain')).toEqual([])
  })

  it('renders in the Text modality as numbered lines', () => {
    const store = loadStore('wat', app)
    const text = new Runtime(store).project({ modality: MOD.Text, roots: [EX + 'page'] })
    const out = toText(text.index, EX + 'page')
    expect(out).toContain('app.ttl:')
    expect(out).toContain('  2 │ ex:a a c:Button ; c:label "Go" .')
  })

  it('costs one rule run of the editor per keystroke, not of the page', () => {
    const h = mount()
    h.type('turtle', 'ex:b')
    const before = h.screen.engine.stats.ruleRuns
    h.type('turtle', 'ex:bc')
    // The editor's rendering, and the layers that decorate what changed under it.
    expect(h.screen.engine.stats.ruleRuns - before).toBeLessThanOrEqual(6)
  })
})
