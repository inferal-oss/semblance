import { describe, expect, it } from 'vitest'
import { MOD, NS } from '../src/ns.ts'
import { type Backend, memoryBackend } from '../src/persistence.ts'
import { toText } from '../src/render/serialize.ts'
import { mountRemembering, mountShell } from './harness.ts'
import { implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const C = NS.c
type Shell = ReturnType<typeof mountShell>

/** The shell with the Playground's Query tab shown. */
function workbench(prefer: 'sparql' | 'function' = 'sparql'): Shell {
  const h = mountShell(5, 'oxigraph', prefer)
  h.fire([...h.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Query')!, 'click')
  return h
}

const area = (h: Shell) => h.document.querySelector('[data-sem-c=query-editor] textarea') as HTMLTextAreaElement
const highlighted = (h: Shell) => h.document.querySelector('[data-sem-c=query-editor] .sem-highlight')!
const options = (h: Shell) => [...h.document.querySelectorAll('[data-sem-c=query-editor] [role=option]')]
const optionNames = (h: Shell) => options(h).map((o) => o.querySelector('code')!.textContent)
const value = (h: Shell, s: string, p: string) => h.store.match(h.store.factory.namedNode(s), h.store.factory.namedNode(p), null)[0]?.object.value
const editorValue = (h: Shell) => value(h, UI + 'queryEditor', C + 'value')

/** Type into the editor: the text area's value and caret, then its input event. */
function type(h: Shell, text: string, caret = text.length) {
  const ta = area(h)
  ta.value = text
  Object.assign(ta, { selectionStart: caret, selectionEnd: caret })
  h.fire(ta, 'input')
}

function press(h: Shell, key: string, mods: { ctrlKey?: boolean } = {}) {
  const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
  Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
  area(h).dispatchEvent(e)
  return e
}

const panel = (h: Shell) => h.document.querySelector('[data-sem-c=query-workbench] [data-sem-c=tabs] > [role=tabpanel]:not([hidden])')!
const showResults = (h: Shell, name: 'Table' | 'Graph' | 'Turtle') =>
  h.fire([...h.document.querySelectorAll('[data-sem-c=query-workbench] [role=tab]')].find((t) => t.textContent === name)!, 'click')
const run = (h: Shell) => h.fire(h.document.querySelector('[data-sem-c=query-workbench] .sem-toolbar button')!, 'click')
const sample = (h: Shell, label: string) =>
  h.fire([...h.document.querySelectorAll('.sem-sample')].find((b) => b.querySelector('.sem-sample-label')!.textContent === label)!, 'click')

describe('the SPARQL workbench (c:QueryWorkbench)', () => {
  it('opens on the first sample, run, with its results as a table', () => {
    const h = workbench()
    const d = h.document
    expect(d.querySelector('[data-sem-c=query-workbench]')!.getAttribute('aria-label')).toBe('SPARQL workbench')
    expect(d.querySelectorAll('.sem-sample').length).toBe(8)
    expect(d.querySelector('.sem-sample[aria-pressed=true] .sem-sample-label')!.textContent).toBe('Components and their renderings')
    expect(area(h).getAttribute('aria-label')).toBe('SPARQL query')
    expect(area(h).value).toBe(editorValue(h))
    const table = panel(h).querySelector('[data-sem-c=result-table]')!
    expect(table.querySelector('.sem-summary')!.textContent).toMatch(/^Rows: \d+/)
    expect([...table.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['?component', '?renderings', '?rules'])
    expect(table.querySelectorAll('tbody tr').length).toBeGreaterThan(50)
    expect(table.querySelector('tbody td code')!.textContent).toMatch(/^c:/)
    // The run button carries its shortcut.
    expect(d.querySelector('[data-sem-c=query-workbench] .sem-toolbar button')!.getAttribute('aria-keyshortcuts')).toMatch(/^Control\+enter$/i)
  })

  it('typing updates c:value and re-renders only the editor', () => {
    const h = workbench()
    const runs = (rule: string) => h.screen.engine.stats.byRule.get(C + rule)?.runs ?? 0
    const before = { bench: runs('QueryWorkbenchRendering-fn'), table: runs('ResultTableRendering-fn'), editor: runs('QueryEditorRendering-fn') }
    const rows = panel(h).querySelector('tbody')!.innerHTML
    const query = 'SELECT ?tab WHERE { ?tab a c:Tab }'
    type(h, query)
    expect(editorValue(h)).toBe(query)
    expect(value(h, UI + 'queryEditor', C + 'caret')).toBe(String(query.length))
    const spans = [...highlighted(h).querySelectorAll('span')].map((s) => `${s.className}:${s.textContent}`)
    expect(spans).toContain('tok-keyword:SELECT')
    expect(spans).toContain('tok-var:?tab')
    expect(spans).toContain('tok-pname:c:Tab')
    expect(highlighted(h).textContent).toBe(query + ' ')
    expect(runs('QueryEditorRendering-fn')).toBe(before.editor + 1)
    expect(runs('QueryWorkbenchRendering-fn')).toBe(before.bench)
    expect(runs('ResultTableRendering-fn')).toBe(before.table)
    expect(panel(h).querySelector('tbody')!.innerHTML).toBe(rows) // results change only on Run
    // A second line adds a line number; editing it leaves the first line's nodes alone.
    const first = highlighted(h).querySelector('span')!
    type(h, query + '\nLIMIT 3')
    expect(h.document.querySelector('[data-sem-c=query-editor] .sem-gutter')!.textContent).toBe('1\n2')
    expect(highlighted(h).querySelector('span')).toBe(first)
    // Lower-case keywords are keywords too (the c:SparqlWord vocabulary).
    type(h, 'ask { ?s ?p ?o }')
    expect([...highlighted(h).querySelectorAll('.tok-keyword')].map((s) => s.textContent)).toContain('ask')
  })

  it('suggests ontology terms for a prefix, and Tab / Enter / a click accepts one', () => {
    const h = workbench()
    type(h, 'SELECT * WHERE { ?x a c:Ta')
    const list = h.document.querySelector('[data-sem-c=query-editor] [role=listbox]')!
    expect(list.getAttribute('aria-label')).toBe('Suggestions')
    expect(optionNames(h)).toEqual(expect.arrayContaining(['c:Tab', 'c:Table', 'c:Tabs']))
    expect(optionNames(h).length).toBeLessThanOrEqual(8)
    // Classes before properties; the active option is the text area's active descendant.
    expect(optionNames(h).indexOf('c:Tabs')).toBeLessThan(optionNames(h).indexOf('c:tabs') < 0 ? Infinity : optionNames(h).indexOf('c:tabs'))
    expect(area(h).getAttribute('aria-activedescendant')).toBe(options(h)[0]!.id)
    expect(area(h).getAttribute('aria-controls')).toBe(list.id)
    expect(options(h)[0]!.getAttribute('aria-selected')).toBe('true')
    // Down moves; Enter accepts the active one, replacing the word.
    const second = optionNames(h)[1]!
    expect(press(h, 'ArrowDown').defaultPrevented).toBe(true)
    expect(options(h)[1]!.getAttribute('aria-selected')).toBe('true')
    const enter = press(h, 'Enter')
    expect(enter.defaultPrevented).toBe(true)
    expect(editorValue(h)).toBe(`SELECT * WHERE { ?x a ${second}`)
    expect(area(h).getAttribute('data-sem-caret')).toBe(String(editorValue(h)!.length))
    expect(options(h)).toHaveLength(0) // closed
    // Keys do nothing special while closed.
    expect(press(h, 'Tab').defaultPrevented).toBe(false)
    // Mid-text: the whole word is replaced, the rest kept; Tab accepts.
    type(h, 'SELECT * WHERE { ?x rdfs:subC ?y }', 'SELECT * WHERE { ?x rdfs:subC'.length)
    expect(optionNames(h)[0]).toBe('rdfs:subClassOf')
    press(h, 'Tab')
    expect(editorValue(h)).toBe('SELECT * WHERE { ?x rdfs:subClassOf ?y }')
    // A click on an option accepts it.
    type(h, 'SELECT * WHERE { ?x beh:sourceC')
    h.fire(options(h).find((o) => o.querySelector('code')!.textContent === 'beh:sourceClass')!, 'click')
    expect(editorValue(h)).toBe('SELECT * WHERE { ?x beh:sourceClass')
    // Escape closes.
    type(h, 'SELECT * WHERE { ?x c:Ta')
    expect(press(h, 'Escape').defaultPrevented).toBe(true)
    expect(options(h)).toHaveLength(0)
  })

  it('suggests keywords, prefixes and variables', () => {
    const h = workbench()
    type(h, 'sel')
    expect(optionNames(h)[0]).toBe('select') // in the case typed
    type(h, 'SELECT ?component ?count WHERE { ?c')
    expect(optionNames(h)).toEqual(['?component', '?count'])
    type(h, 'SELECT * WHERE { ?x a rdf')
    expect(optionNames(h)).toEqual(expect.arrayContaining(['rdf:', 'rdfs:', 'rdfhtml:']))
    // Accepting a prefix keeps suggesting, for the term after it.
    press(h, 'Enter')
    expect(editorValue(h)).toBe('SELECT * WHERE { ?x a rdf:')
    expect(optionNames(h).length).toBeGreaterThan(0)
    expect(optionNames(h).every((n) => n!.startsWith('rdf:'))).toBe(true)
    // Not inside strings or comments.
    type(h, 'SELECT * WHERE { ?x rdfs:label "c:Ta')
    expect(options(h)).toHaveLength(0)
    type(h, '# c:Ta')
    expect(options(h)).toHaveLength(0)
  })

  it('runs with the button and with mod+Enter, as SELECT or CONSTRUCT', () => {
    const h = workbench()
    type(h, 'SELECT ?item WHERE { ex:todos c:item ?item }')
    expect(panel(h).querySelectorAll('tbody tr').length).toBeGreaterThan(5) // still the sample
    run(h)
    expect(value(h, UI + 'currentQuery', NS.sem + 'select')).toBe('SELECT ?item WHERE { ex:todos c:item ?item }')
    expect(panel(h).querySelectorAll('tbody tr').length).toBe(5)
    expect(h.document.querySelector('.sem-sample[aria-pressed=true]')).toBeNull()
    expect(h.document.querySelector('.sem-status')!.textContent).toBe('Results of your query')
    // The editor's shortcut runs a CONSTRUCT (prologue and all).
    type(h, '# the items\nPREFIX x: <https://example.org/todo#>\nCONSTRUCT { ?i a x:Item } WHERE { x:todos c:item ?i }')
    press(h, 'Enter', { ctrlKey: true })
    expect(value(h, UI + 'currentQuery', NS.sem + 'select')).toBeUndefined()
    expect(value(h, UI + 'currentQuery', NS.sem + 'construct')).toContain('CONSTRUCT')
    expect(panel(h).querySelector('.sem-summary')!.textContent).toBe('Triples: 5')
    expect([...panel(h).querySelectorAll('th')].map((t) => t.textContent)).toEqual(['subject', 'predicate', 'object'])
    // Running the same text again re-runs it.
    const runs = h.screen.engine.stats.byRule.get(C + 'ResultTableRendering-fn')!.runs
    run(h)
    expect(h.screen.engine.stats.byRule.get(C + 'ResultTableRendering-fn')!.runs).toBe(runs + 1)
  })

  it('every sample runs, into a table, a graph and Turtle', () => {
    const h = workbench()
    const labels = [...h.document.querySelectorAll('.sem-sample-label')].map((l) => l.textContent!)
    for (const label of labels) {
      sample(h, label)
      expect(h.document.querySelector('.sem-sample[aria-pressed=true] .sem-sample-label')!.textContent).toBe(label)
      expect(h.document.querySelector('.sem-status')!.textContent).toBe(`Results of: ${label}`)
      expect(area(h).value, label).toBe(editorValue(h))
      showResults(h, 'Table')
      const table = panel(h).querySelector('[data-sem-c=result-table]')!
      expect(table.querySelector('[role=alert]'), label).toBeNull()
      // Shapes are clean in the demo; everything else has rows.
      if (label !== 'Components that violate their shapes') expect(table.querySelectorAll('tbody tr').length, label).toBeGreaterThan(0)
      showResults(h, 'Turtle')
      const turtle = panel(h).querySelector('[data-sem-c=result-turtle]')!
      expect(turtle.querySelector('[role=alert]'), label).toBeNull()
      showResults(h, 'Graph')
      expect(panel(h).querySelector('[data-sem-c=result-graph] [role=alert]'), label).toBeNull()
    }
    // The CONSTRUCT sample opens on its graph.
    sample(h, 'How c:Tabs is made')
    expect(h.document.querySelector('[data-sem-c=query-workbench] [role=tab][aria-selected=true]')!.textContent).toBe('Graph')
    const graph = panel(h).querySelector('[data-sem-c=result-graph]')!
    expect(graph.querySelector('svg')!.getAttribute('role')).toBe('img')
    const nodes = [...graph.querySelectorAll('.sem-node-label')].map((t) => t.textContent)
    expect(nodes).toEqual(expect.arrayContaining(['c:Tabs', 'sem:Component', 'c:TabsSelect', 'beh:Click']))
    expect([...graph.querySelectorAll('.sem-edge-label')].map((t) => t.textContent)).toContain('rdfs:subClassOf')
    showResults(h, 'Turtle')
    const ttl = panel(h).querySelector('.sem-turtle')!
    expect(ttl.textContent).toContain('@prefix c: <https://semblance.dev/ns/component#> .')
    expect(ttl.querySelector('.ttl-pname')).not.toBeNull()
    // A SELECT as Turtle is a result set.
    sample(h, 'The todo items')
    showResults(h, 'Turtle')
    expect(panel(h).querySelector('.sem-turtle')!.textContent).toContain('rs:ResultSet')
    expect(panel(h).querySelector('.sem-turtle')!.textContent).toContain('rs:variable "label"')
    // and as a graph, each row's first value linked to the others by variable.
    showResults(h, 'Graph')
    expect([...panel(h).querySelectorAll('.sem-edge-label')].map((t) => t.textContent)).toContain('?label')
  })

  it('caps the graph at its best-connected nodes', () => {
    const h = workbench()
    type(h, 'CONSTRUCT { ?c rdfs:subClassOf ?super } WHERE { ?c rdfs:subClassOf ?super . ?super rdfs:subClassOf* sem:Component }')
    run(h)
    showResults(h, 'Graph')
    const graph = panel(h).querySelector('[data-sem-c=result-graph]')!
    expect(graph.querySelectorAll('.sem-node').length).toBe(40)
    expect(graph.querySelector('.sem-summary')!.textContent).toMatch(/· \+\d+ more$/)
    // The hub (sem:Component) is in the middle.
    const hub = [...graph.querySelectorAll('.sem-node')].find((n) => n.querySelector('.sem-node-label')!.textContent === 'sem:Component')!
    expect(hub.querySelector('circle')!.getAttribute('cx')).toBe('360')
  })

  it('shows a failing query as an error, and never throws', () => {
    for (const prefer of ['sparql', 'function'] as const) {
      const h = workbench(prefer)
      type(h, 'SELECT ?x WHERE { ?x ')
      expect(() => run(h)).not.toThrow()
      for (const view of ['Table', 'Graph', 'Turtle'] as const) {
        showResults(h, view)
        const alert = panel(h).querySelector('[data-sem-c=alert]')!
        expect(alert.getAttribute('role'), view).toBe('alert')
        expect(alert.getAttribute('data-sem-tone')).toBe('danger')
        expect(alert.textContent).toContain('The query failed')
      }
      // A good query clears it.
      type(h, 'ASK { ex:todos c:item ?i }')
      run(h)
      expect(panel(h).querySelector('[data-sem-c=alert]')).toBeNull()
      expect(panel(h).textContent).toContain('true')
    }
  })

  it('the function variants of its reactions do what the SPARQL ones do', () => {
    const results = (['sparql', 'function'] as const).map((prefer) => {
      const h = workbench(prefer)
      type(h, 'SELECT * WHERE { ?x a c:Ta')
      press(h, 'ArrowDown')
      press(h, 'ArrowDown')
      press(h, 'ArrowUp')
      press(h, 'Tab')
      const accepted = editorValue(h)
      type(h, 'SELECT * WHERE { ?x beh:sourceC')
      h.fire(options(h)[0]!, 'click')
      const picked = editorValue(h)
      run(h)
      const ran = [value(h, UI + 'currentQuery', NS.sem + 'select'), value(h, UI + 'currentQuery', C + 'runCount')]
      sample(h, 'How c:Tabs is made')
      const loaded = [editorValue(h), value(h, UI + 'currentQuery', NS.sem + 'construct'), value(h, UI + 'queryResults', C + 'selected')]
      return { accepted, picked, ran, loaded }
    })
    expect(results[1]).toEqual(results[0])
    expect(results[0]!.loaded[2]).toBe(UI + 'queryGraphTab')
  })

  it('works in a window, and is remembered for this tab', async () => {
    const PER = NS.per
    const storage: Record<string, Backend> = { [PER + 'Session']: memoryBackend(), [PER + 'Device']: memoryBackend(), [PER + 'Database']: memoryBackend() }
    const a = await mountRemembering(storage)
    a.fire([...a.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Query')!, 'click')
    const query = 'CONSTRUCT { ?i a ex:Item } WHERE { ex:todos c:item ?i }'
    type(a as unknown as Shell, query)
    run(a as unknown as Shell)
    a.fire([...a.document.querySelectorAll('[data-sem-c=query-workbench] [role=tab]')].find((t) => t.textContent === 'Turtle')!, 'click')
    a.fire(a.document.querySelector('[aria-label="Open Query in a window"]')!, 'click')
    const win = a.document.querySelector('[data-sem-c=window]')!
    expect(win.querySelector('[data-sem-c=query-workbench]')).not.toBeNull()
    win.querySelector('.sem-window-bar')!.dispatchEvent(new a.window.CustomEvent('sem-move', { bubbles: true, detail: { x: 120, y: 80 } }))
    // Typing in the window works like typing in the tab.
    type(a as unknown as Shell, query + ' LIMIT 2')
    await a.persistence.flush()
    expect(await storage[PER + 'Session']!.get('semblance:' + UI + 'rememberWorkbench')).toBeTruthy()

    const b = await mountRemembering(storage)
    const restored = b.document.querySelector('[data-sem-c=window]')!
    expect(restored.querySelector('[data-sem-c=query-workbench]')).not.toBeNull()
    expect(restored.getAttribute('style')).toContain('left: 120px; top: 80px')
    expect((restored.querySelector('[data-sem-c=query-editor] textarea') as HTMLTextAreaElement).value).toBe(query + ' LIMIT 2')
    expect(value(b as unknown as Shell, UI + 'currentQuery', NS.sem + 'construct')).toBe(query)
    // The empty SELECT stands for "none": the CONSTRUCT is what shows.
    expect(restored.querySelector('[data-sem-c=result-turtle] .sem-summary')!.textContent).toBe('Triples: 5')
  })

  it('has a Text sketch, and says why its renderings are function-only', () => {
    const h = mountShell()
    const text = h.runtime.project({ modality: MOD.Text, name: 'text-workbench', roots: [UI + 'workbench'] })
    const out = toText(text.index, UI + 'workbench')
    expect(out).toContain('── SPARQL workbench ──')
    expect(out).toContain('• 1. Components and their renderings (SELECT)')
    expect(out).toMatch(/1 │ # Every component class/)
    expect(out).toContain('[ Run ]')
    expect(out).toContain('Results of: Components and their renderings · SELECT')
    expect(implementationGaps(['components/workbench.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })
})
