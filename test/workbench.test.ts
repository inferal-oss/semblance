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
    expect(d.querySelectorAll('.sem-sample').length).toBe(9)
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

  it('lists the renderings whose SPARQL or function side is missing, and which', () => {
    const h = workbench()
    sample(h, 'Renderings missing a SPARQL or function side')
    showResults(h, 'Table')
    const table = panel(h).querySelector('[data-sem-c=result-table]')!
    expect([...table.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['?rendering', '?targets', '?missing', '?why'])
    const missing = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td')[2]!.textContent!)
    for (const m of missing) expect(m).toMatch(/^(SPARQL|function|SPARQL for (Screen|Text))$/)
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
      // Shapes are clean in the demo, and every rendering is meant to have both sides; everything else has rows.
      if (label !== 'Components that violate their shapes' && label !== 'Renderings missing a SPARQL or function side') expect(table.querySelectorAll('tbody tr').length, label).toBeGreaterThan(0)
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
    // A group, not an image: its nodes are buttons.
    expect(graph.querySelector('svg')!.getAttribute('role')).toBe('group')
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
    const queryWindow = (d: Document) => [...d.querySelectorAll('[data-sem-c=window]')].find((w) => w.querySelector('.sem-window-bar strong')!.textContent === 'Query')!
    const win = queryWindow(a.document)
    expect(win.querySelector('[data-sem-c=query-workbench]')).not.toBeNull()
    win.querySelector('.sem-window-bar')!.dispatchEvent(new a.window.CustomEvent('sem-move', { bubbles: true, detail: { x: 120, y: 80 } }))
    // Typing in the window works like typing in the tab.
    type(a as unknown as Shell, query + ' LIMIT 2')
    await a.persistence.flush()
    expect(await storage[PER + 'Session']!.get('semblance:' + UI + 'rememberWorkbench')).toBeTruthy()

    const b = await mountRemembering(storage)
    const restored = queryWindow(b.document)
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

// --- selecting in the graph view (c:selectedTerm, c:ResultGraphSelection) -------------------------------

const graphView = (h: Shell) => panel(h).querySelector('[data-sem-c=result-graph]')!
const graphNodes = (h: Shell) => [...graphView(h).querySelectorAll('.sem-plot > .sem-node')]
const graphNode = (h: Shell, label: string) => graphNodes(h).find((n) => n.querySelector('.sem-node-label')!.textContent === label)!
const salience = (el: Element) => el.getAttribute('data-sem-salience')
const selectionLine = (h: Shell) => graphView(h).querySelector('.sem-selection')!

/** A key press on an element (bubbling, cancelable). */
function keyOn(h: Shell, el: Element, key: string) {
  const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
  Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
  el.dispatchEvent(e)
  return e
}

/** The links of the rendered graph, as pairs of node mark IRIs (c:edgeFrom / c:edgeTo, in the derived graph). */
function links(h: Shell): [string, string][] {
  const f = h.store.factory
  return graphNodes(h).length
    ? h.store
        .match(null, f.namedNode(C + 'edgeFrom'), null)
        .filter((q) => q.subject.value.startsWith(UI + 'queryGraph/~'))
        .map((q) => [q.object.value, h.store.match(q.subject, f.namedNode(C + 'edgeTo'), null)[0]!.object.value])
    : []
}

/** Marks within `depth` links of `from`, by breadth-first search over `links`. */
function within(pairs: [string, string][], from: string, depth: number): Map<string, number> {
  const distance = new Map([[from, 0]])
  for (let d = 1, ring = [from]; d <= depth; d++) {
    const next: string[] = []
    for (const k of ring) for (const [a, b] of pairs) for (const [x, y] of [[a, b], [b, a]]) if (x === k && !distance.has(y!)) distance.set(y!, d), next.push(y!)
    ring = next
  }
  return distance
}

/** The workbench showing "How c:Tabs is made" as a graph. */
function tabsGraph(prefer: 'sparql' | 'function' = 'sparql') {
  const h = workbench(prefer)
  sample(h, 'How c:Tabs is made')
  expect(graphNodes(h).length).toBeGreaterThan(5)
  return h
}

describe('selecting a node in the graph view', () => {
  it('highlights the node and its connections, dims the rest, and touches nothing else', () => {
    const h = tabsGraph()
    const runs = (rule: string) => h.screen.engine.stats.byRule.get(C + rule)?.runs ?? 0
    // Nothing selected: no salience, every node a released toggle, and a hint.
    expect(graphView(h).querySelectorAll('[data-sem-salience]')).toHaveLength(0)
    expect(graphNodes(h).every((n) => n.getAttribute('role') === 'button' && n.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect(selectionLine(h).textContent).toMatch(/^Select a node/)
    expect(selectionLine(h).getAttribute('aria-live')).toBe('polite')

    const before = { graph: runs('ResultGraphRendering-fn'), selection: runs('ResultGraphSelection-sparql'), table: runs('ResultTableRendering-fn'), ops: h.shell.ops }
    const tabs = graphNode(h, 'c:Tabs')
    h.fire(tabs.querySelector('circle')!, 'click')
    expect(value(h, UI + 'queryGraph', C + 'selectedTerm')).toBe(C + 'Tabs')
    // Only the selection rule ran for the view: the query did not run again, nothing was laid out.
    expect(runs('ResultGraphRendering-fn')).toBe(before.graph)
    expect(runs('ResultTableRendering-fn')).toBe(before.table)
    expect(runs('ResultGraphSelection-sparql')).toBe(before.selection + 1)

    const pairs = links(h)
    // The expected salience of every mark, from the links in the graph.
    const markOf = (el: Element) => h.shell.keyOf(el)!
    const distance = within(pairs, markOf(tabs), 1)
    for (const n of graphNodes(h)) {
      const d = distance.get(markOf(n))
      expect(salience(n), n.textContent!).toBe(d === 0 ? 'focused' : d === 1 ? 'neighbour' : 'dimmed')
      expect(n.getAttribute('aria-pressed')).toBe(String(n === tabs))
    }
    const incident = pairs.filter(([a, b]) => a === markOf(tabs) || b === markOf(tabs)).length
    const edges = [...graphView(h).querySelectorAll('.sem-plot > .sem-link')]
    expect(edges.filter((e) => salience(e) === 'neighbour')).toHaveLength(incident)
    expect(edges.filter((e) => salience(e) === 'dimmed')).toHaveLength(edges.length - incident)
    expect(graphNodes(h).filter((n) => salience(n) === 'dimmed').length).toBeGreaterThan(0)
    // The line says what is selected, and describes the node.
    expect(selectionLine(h).textContent).toBe(`c:Tabs — ${incident} connections✕`)
    expect(tabs.getAttribute('aria-describedby')).toBe(selectionLine(h).id)
    expect(selectionLine(h).querySelector('button')!.getAttribute('aria-label')).toBe('Clear the selection')

    // Another node moves the selection; the same one again clears it.
    const component = graphNode(h, 'sem:Component')
    h.fire(component.querySelector('text')!, 'click')
    expect(value(h, UI + 'queryGraph', C + 'selectedTerm')).toBe(NS.sem + 'Component')
    expect(salience(component)).toBe('focused')
    expect(salience(tabs)).not.toBe('focused')
    h.fire(component.querySelector('circle')!, 'click')
    expect(value(h, UI + 'queryGraph', C + 'selectedTerm')).toBeUndefined()
    expect(graphView(h).querySelectorAll('[data-sem-salience]')).toHaveLength(0)
    expect(selectionLine(h).textContent).toMatch(/^Select a node/)
    // A click on the background clears it, and so does the clear button.
    h.fire(tabs, 'click')
    h.fire(graphView(h).querySelector('.sem-canvas')!, 'click')
    expect(value(h, UI + 'queryGraph', C + 'selectedTerm')).toBeUndefined()
    h.fire(tabs, 'click')
    h.fire(selectionLine(h).querySelector('button')!, 'click')
    expect(value(h, UI + 'queryGraph', C + 'selectedTerm')).toBeUndefined()
    // The graph was never rendered again.
    expect(runs('ResultGraphRendering-fn')).toBe(before.graph)
  })

  it('is selectable from the keyboard: Enter or Space toggles, Escape clears', () => {
    const h = tabsGraph()
    const root = graphView(h)
    // Arrow keys move among the nodes (key:navigation); one node is in the tab order.
    expect(root.getAttribute('data-sem-nav-items')).toBe('.sem-plot > .sem-node')
    expect(graphNodes(h).filter((n) => n.getAttribute('tabindex') === '0')).toHaveLength(1)
    const tabs = graphNode(h, 'c:Tabs')
    expect(keyOn(h, tabs, 'Enter').defaultPrevented).toBe(true)
    expect(value(h, UI + 'queryGraph', C + 'selectedTerm')).toBe(C + 'Tabs')
    expect(tabs.getAttribute('aria-pressed')).toBe('true')
    expect(keyOn(h, tabs, ' ').defaultPrevented).toBe(true)
    expect(value(h, UI + 'queryGraph', C + 'selectedTerm')).toBeUndefined()
    keyOn(h, tabs, ' ')
    expect(salience(tabs)).toBe('focused')
    expect(keyOn(h, tabs, 'Escape').defaultPrevented).toBe(true)
    expect(value(h, UI + 'queryGraph', C + 'selectedTerm')).toBeUndefined()
    // With nothing selected, Escape is not the graph's.
    expect(keyOn(h, tabs, 'Escape').defaultPrevented).toBe(false)
    // From outside the view, Escape reaches the clear button (data-sem-escape).
    keyOn(h, tabs, 'Enter')
    expect(selectionLine(h).querySelector('[data-sem-escape]')).not.toBeNull()
    keyOn(h, h.document.body, 'Escape')
    expect(value(h, UI + 'queryGraph', C + 'selectedTerm')).toBeUndefined()
  })

  it.each(['sparql', 'function'] as const)('lets go of the selection when the query runs again or a sample loads (%s)', (prefer) => {
    const h = tabsGraph(prefer)
    h.fire(graphNode(h, 'c:Tabs').querySelector('circle')!, 'click')
    expect(value(h, UI + 'queryGraph', C + 'selectedTerm')).toBe(C + 'Tabs')
    run(h)
    expect(value(h, UI + 'queryGraph', C + 'selectedTerm')).toBeUndefined()
    expect(selectionLine(h).textContent).toMatch(/^Select a node/)
    h.fire(graphNode(h, 'c:Tabs').querySelector('circle')!, 'click')
    sample(h, 'How c:Tabs is made')
    expect(value(h, UI + 'queryGraph', C + 'selectedTerm')).toBeUndefined()
  })

  it('reaches as far as c:neighbourhood says', () => {
    const h = tabsGraph()
    const f = h.store.factory
    const graph = f.namedNode(UI + 'queryGraph')
    const depth = (n: number) => {
      h.runtime.apply({ remove: h.store.match(graph, f.namedNode(C + 'neighbourhood'), null), add: [f.quad(graph, f.namedNode(C + 'neighbourhood'), f.literal(String(n), f.namedNode(NS.xsd + 'integer')))] })
      h.shell.flush()
    }
    const literal = graphNodes(h).find((n) => n.classList.contains('sem-literal')) ?? graphNode(h, 'beh:Click')
    h.fire(literal, 'click')
    const markOf = (el: Element) => h.shell.keyOf(el)!
    const pairs = links(h)
    const counts: number[] = []
    for (const d of [1, 2, 3]) {
      depth(d)
      const distance = within(pairs, markOf(literal), d)
      for (const n of graphNodes(h)) {
        const at = distance.get(markOf(n))
        expect(salience(n), `${n.textContent} at depth ${d}`).toBe(at === 0 ? 'focused' : at !== undefined ? 'neighbour' : 'dimmed')
      }
      for (const e of graphView(h).querySelectorAll('.sem-plot > .sem-link')) {
        const [a, b] = [f.namedNode(markOf(e))].map((m) => [C + 'edgeFrom', C + 'edgeTo'].map((p) => h.store.match(m, f.namedNode(p), null)[0]!.object.value))[0]!
        const onTheWay = Math.min(distance.get(a!) ?? Infinity, distance.get(b!) ?? Infinity) < d
        expect(salience(e)).toBe(onTheWay ? 'neighbour' : 'dimmed')
      }
      counts.push(graphNodes(h).filter((n) => salience(n) === 'neighbour').length)
    }
    expect(counts[1]).toBeGreaterThan(counts[0]!)
  })

  it('renders the same with SPARQL and function rules and reactions', () => {
    const shells = (['sparql', 'function'] as const).map((prefer) => tabsGraph(prefer))
    const steps: ((h: Shell) => void)[] = [
      () => {},
      (h) => h.fire(graphNode(h, 'c:Tabs').querySelector('circle')!, 'click'),
      (h) => h.fire(graphNode(h, 'sem:Component'), 'click'),
      (h) => {
        const f = h.store.factory
        h.runtime.apply({ remove: [], add: [f.quad(f.namedNode(UI + 'queryGraph'), f.namedNode(C + 'neighbourhood'), f.literal('2', f.namedNode(NS.xsd + 'integer')))] })
        h.shell.flush()
      },
      (h) => keyOn(h, graphNode(h, 'c:TabsSelect'), 'Enter'),
      (h) => keyOn(h, graphNode(h, 'c:TabsSelect'), ' '),
      (h) => keyOn(h, graphNode(h, 'c:Tabs'), 'Enter'),
      (h) => keyOn(h, graphNode(h, 'c:Tabs'), 'Escape'),
    ]
    steps.forEach((step, i) => {
      const [a, b] = shells.map((h) => (step(h), graphView(h).outerHTML))
      expect(a, `step ${i}`).toBe(b)
      expect(shells.map((h) => value(h, UI + 'queryGraph', C + 'selectedTerm'))).toEqual(Array(2).fill(value(shells[0]!, UI + 'queryGraph', C + 'selectedTerm')))
    })
    expect(implementationGaps(['components/workbench.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })

  it('is remembered with the rest of the workbench', async () => {
    const PER = NS.per
    const storage: Record<string, Backend> = { [PER + 'Session']: memoryBackend(), [PER + 'Device']: memoryBackend(), [PER + 'Database']: memoryBackend() }
    const a = (await mountRemembering(storage)) as unknown as Shell & { persistence: { flush(): Promise<void> } }
    a.fire([...a.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Query')!, 'click')
    sample(a, 'How c:Tabs is made')
    a.fire(graphNode(a, 'c:Tabs'), 'click')
    await a.persistence.flush()

    const b = (await mountRemembering(storage)) as unknown as Shell
    b.fire([...b.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Query')!, 'click')
    expect(value(b, UI + 'queryGraph', C + 'selectedTerm')).toBe(C + 'Tabs')
    expect(salience(graphNode(b, 'c:Tabs'))).toBe('focused')
    expect(selectionLine(b).textContent).toMatch(/^c:Tabs — \d+ connections/)
  })
})

