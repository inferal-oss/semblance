import { readFileSync } from 'node:fs'
import { Parser, Store } from 'n3'
import { describe, expect, it } from 'vitest'
import { type Backend, memoryBackend, Persistence } from '../src/persistence.ts'
import { NS } from '../src/ns.ts'
import { ONTOLOGY_FILES } from '../src/ontology.ts'
import { mountSite } from './harness.ts'
import { implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const C = NS.c

/** The site on its Reference page, reached through the navigation, driven only through events. */
function reference(prefer: 'sparql' | 'function' = 'function') {
  const h = mountSite('hybrid', prefer)
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => h.fire(el, 'click')
  click([...h.document.querySelectorAll('[data-sem-c=app-bar] button')].find((b) => b.textContent!.trim() === 'Reference')!)
  const page = () => h.document.querySelector('[data-sem-c=term-tree]')!.closest('[data-sem-c=switch] > div')!
  const tree = () => h.document.querySelector('[data-sem-c=term-tree]')!
  /** A branch's row by its name, a term's item by its local name (within a branch when given). */
  const branch = (name: string) => [...tree().querySelectorAll('[data-sem-c=term-branch]')].find((b) => b.querySelector(':scope > .sem-row > .sem-label')!.textContent === name)!
  const open = (name: string) => {
    const b = branch(name)
    if (b.getAttribute('aria-expanded') !== 'true') click(b.querySelector(':scope > .sem-row > .sem-twisty')!)
    return branch(name)
  }
  const item = (within: Element, local: string) => [...within.querySelectorAll('[aria-level="3"] .sem-label')].find((l) => l.textContent === local)!
  const select = (group: string, local: string) => click(item(open(group), local))
  const tab = (name: string) => click([...page().querySelectorAll('[role=tab]')].find((t) => t.textContent === name)!)
  const overview = () => page().querySelector('[data-sem-c=term-overview]')!
  const fact = (label: string) => [...overview().querySelectorAll('.sem-fact')].find((f) => f.querySelector('dt')!.textContent === label)
  const values = (label: string) => [...(fact(label)?.querySelectorAll('.sem-term, .sem-value') ?? [])].map((v) => v.textContent)
  const subject = () => h.value(UI + 'referenceSubject')
  const press = (el: Element, key: string) => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
    el.dispatchEvent(e)
    return e.defaultPrevented
  }
  return { ...h, visible, click, page, tree, branch, open, item, select, tab, overview, fact, values, subject, press }
}

describe('the reference tree', () => {
  it('lists the component groups, the layers and the vocabularies from the ontology', () => {
    const h = reference()
    const sections = [...h.tree().querySelectorAll(':scope > .sem-section > .sem-row > .sem-label')].map((s) => s.textContent)
    expect(sections).toEqual(['Components', 'Layers', 'Vocabularies'])
    // Groups in sem:order, each with its count of member classes.
    const groups = [...h.tree().querySelectorAll(':scope > .sem-section:first-child [data-sem-c=term-branch] > .sem-row > .sem-label')].map((l) => l.textContent)
    expect(groups.slice(0, 4)).toEqual(['Layout', 'Type', 'Actions', 'Inputs'])
    expect(groups).toContain('Windows')
    expect(h.item(h.open('Windows'), 'Window')).toBeTruthy()
    expect(h.item(h.open('Windows'), 'Draggable')).toBeTruthy() // mixins are in their group
    expect(h.item(h.open('Inputs'), 'CodeInput')).toBeTruthy()
    // Layers are sem:Layer instances; their terms are the renderings in the layer.
    expect(h.item(h.open('validation'), 'Check')).toBeTruthy()
    // A vocabulary lists its classes and properties, but not component classes (they are in their groups).
    const components = h.open('Semblance components')
    expect(h.item(components, 'label')).toBeTruthy()
    expect(h.item(components, 'Window')).toBeUndefined()
    expect(h.item(h.open('Semblance persistence'), 'Policy')).toBeTruthy()
  })

  it('opens the branch that holds the selection, and marks its item selected', () => {
    const h = reference()
    // c:Window is selected to begin with; its group is open to show it.
    expect(h.subject()).toBe(C + 'Window')
    expect(h.branch('Windows').getAttribute('aria-expanded')).toBe('true')
    const selected = h.tree().querySelectorAll('[aria-selected=true]')
    expect([...selected].map((s) => s.querySelector('.sem-label')!.textContent)).toEqual(['Window'])
    h.select('Inputs', 'CodeInput')
    expect(h.subject()).toBe(C + 'CodeInput')
    expect([...h.tree().querySelectorAll('[aria-selected=true] > .sem-row > .sem-label')].map((l) => l.textContent)).toEqual(['CodeInput'])
    // Windows was only revealing the selection: it closes again. Inputs was opened by hand: it stays.
    expect(h.branch('Windows').getAttribute('aria-expanded')).toBe('false')
    expect(h.branch('Inputs').getAttribute('aria-expanded')).toBe('true')
    // A branch closed by hand stays closed even while it holds the selection.
    h.click(h.branch('Inputs').querySelector('.sem-twisty')!)
    expect(h.branch('Inputs').getAttribute('aria-expanded')).toBe('false')
    // A selection from elsewhere (Back, Forward, a link to #reference/c:Draggable) is shown the same way.
    const f = h.store.factory
    const app = f.namedNode(UI + 'app')
    const subject = f.namedNode(UI + 'referenceSubject')
    h.runtime.apply({ remove: h.store.match(app, subject, null), add: [f.quad(app, subject, f.namedNode(C + 'Draggable'))] })
    h.shell.flush()
    expect(h.branch('Windows').getAttribute('aria-expanded')).toBe('true')
    expect([...h.tree().querySelectorAll('[aria-selected=true] > .sem-row > .sem-label')].map((l) => l.textContent)).toEqual(['Draggable'])
    expect(h.overview().querySelector('h2')!.textContent).toBe('c:Draggable')
    // A branch's own name selects the group itself.
    h.click(h.branch('Layout').querySelector(':scope > .sem-row > .sem-label')!)
    expect(h.subject()).toBe(C + 'LayoutGroup')
    expect(h.branch('Layout').getAttribute('aria-selected')).toBe('true')
  })

  it('moves with the arrow keys: down and up through names, right opens a branch, left closes it', () => {
    const h = reference()
    const tree = h.tree()
    expect(tree.getAttribute('data-sem-nav-items')).toBe('[role=treeitem] > .sem-row > .sem-label')
    const first = tree.querySelector('.sem-section .sem-label')!
    expect(first.getAttribute('tabindex')).toBe('0') // the tree's tab stop
    expect(h.press(first, 'ArrowDown')).toBe(true)
    const layout = h.branch('Layout').querySelector(':scope > .sem-row > .sem-label')!
    expect(layout.getAttribute('tabindex')).toBe('0')
    h.press(layout, 'ArrowRight') // opens Layout
    expect(h.branch('Layout').getAttribute('aria-expanded')).toBe('true')
    h.press(h.branch('Layout').querySelector(':scope > .sem-row > .sem-label')!, 'ArrowRight') // enters it
    const member = h.branch('Layout').querySelector('[aria-level="3"] .sem-label')! // its first member
    expect(member.getAttribute('tabindex')).toBe('0')
    h.press(member, 'ArrowLeft') // back to the branch
    expect(h.branch('Layout').querySelector(':scope > .sem-row > .sem-label')!.getAttribute('tabindex')).toBe('0')
    h.press(h.branch('Layout').querySelector(':scope > .sem-row > .sem-label')!, 'ArrowLeft') // closes it
    expect(h.branch('Layout').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('a term', () => {
  it('shows its comment, kind, superclasses, renderings and rules, reactions, shape and where the gallery shows it', () => {
    const h = reference()
    h.select('Inputs', 'CodeInput')
    const o = h.overview()
    expect(o.querySelector('h2')!.textContent).toBe('c:CodeInput')
    expect(o.querySelector('header .sem-kind')!.textContent).toBe('class')
    expect(o.querySelector('.sem-comment')!.textContent).toMatch(/code/i)
    expect(h.values('rdfs:subClassOf')).toContain('sem:Component')
    expect(h.values('sem:slug')).toEqual(['code-input'])
    expect(h.values('sem:group')).toEqual(['c:InputsGroup'])
    expect(h.values('Renderings').length).toBeGreaterThan(0)
    const rules = h.values('Rules')
    expect(rules.some((r) => r!.endsWith('-fn'))).toBe(true)
    expect(rules.some((r) => r!.includes('sparql'))).toBe(true)
    expect(h.fact('Rules')!.textContent).toContain('function inputs:code-input')
    expect(h.values('Reactions').length).toBeGreaterThan(0)
    const shape = h.fact('Shape')!
    expect(shape.textContent).toContain('c:length')
    expect(shape.querySelector('.sem-constraint')!.textContent).toMatch(/^(minInclusive|maxInclusive|minCount|maxCount|datatype|class) /)
    // The gallery specimens that use it: links to the specimens themselves (c:to), resolved by the navigation layer.
    const links = [...h.fact('Shown in the gallery')!.querySelectorAll('[data-sem-c=link]')]
    expect(links.length).toBeGreaterThan(0)
    const link = h.store.match(null, h.store.factory.namedNode(C + 'to'), null).filter((q) => q.subject.value.startsWith(UI + 'referenceOverview/'))
    expect(link.length).toBe(links.length)
    expect(h.store.match(link[0]!.object, h.store.factory.namedNode(NS.rdf + 'type'), h.store.factory.namedNode(C + 'Specimen')).length).toBe(1)
  })

  it('links to the terms it mentions: following one selects it', () => {
    const h = reference()
    h.select('Inputs', 'CodeInput')
    const link = [...h.fact('rdfs:subClassOf')!.querySelectorAll('button.sem-term')].find((b) => b.textContent === 'sem:Component')!
    h.click(link)
    expect(h.subject()).toBe(NS.sem + 'Component')
    expect(h.values('Subclasses')).toEqual(expect.arrayContaining(['c:Button', 'c:CodeInput']))
    // Other vocabularies' terms are shown, not linked.
    expect(h.overview().querySelector('code.sem-term')).toBeTruthy()
  })

  it('shows a layer with what it renders, a class with its properties and their ranges, and an axis with its values', () => {
    const h = reference()
    h.select('Data', 'Tree')
    expect(h.values('Properties')).toEqual(expect.arrayContaining(['c:expandedNode']))
    h.select('Data', 'Table')
    expect(h.fact('Properties')!.textContent).toContain('c:tableColumns→ rdf:List')
    h.click(h.branch('validation').querySelector(':scope > .sem-row > .sem-label')!)
    expect(h.overview().querySelector('header .sem-kind')!.textContent).toBe('layer')
    expect(h.values('Renders')).toContain('val:Check')
    h.select('Semblance style layer', 'Tone')
    expect(h.values('Instances')).toEqual(expect.arrayContaining(['sty:Danger', 'sty:Accent']))
    expect(h.values('Range of')).toContain('sty:tone')
  })

  it('shows its alignment with other vocabularies, with the strength of each link', () => {
    const h = reference()
    h.select('Data', 'Table')
    h.tab('Alignment')
    const rows = () => [...h.page().querySelectorAll('[data-sem-c=term-alignment] tbody tr')].map((r) => [...r.querySelectorAll('td')].map((d) => d.textContent))
    expect(rows()).toEqual([['rdfs:subClassOf', 'schema:Table', 'narrower']])
    h.select('Semblance components', 'label')
    expect(rows()).toEqual([
      ['rdfs:subPropertyOf', 'rdfs:label', 'narrower'],
      ['skos:closeMatch', 'skos:prefLabel', 'close'],
    ])
    expect(h.page().querySelector('[data-sem-c=term-alignment] [data-sem-strength=close]')).toBeTruthy()
    h.select('Inputs', 'CodeInput')
    expect(h.page().querySelector('[data-sem-c=term-alignment] .sem-empty')!.textContent).toBe('No links to other vocabularies.')
  })

  it('draws its neighbourhood as a graph; a node of ours is followed', () => {
    const h = reference('sparql')
    h.tab('Graph')
    const graph = () => h.page().querySelector('[data-sem-c=result-graph]')!
    const names = () => [...graph().querySelectorAll('.sem-node')].map((n) => n.getAttribute('aria-label'))
    expect(names()).toEqual(expect.arrayContaining(['c:Window', 'c:Frame', 'c:Dockable', 'c:WindowRendering', 'schema:WPSideBar']))
    h.select('Inputs', 'CodeInput')
    expect(names()).toEqual(expect.arrayContaining(['c:CodeInput', 'sem:Component', 'c:CodeInputShape', 'c:InputsGroup']))
    expect(names()).not.toContain('c:Dockable')
    // The picked term is the graph's selection: focused.
    expect(graph().querySelector('.sem-node[aria-label="c:CodeInput"]')!.getAttribute('data-sem-salience')).toBe('focused')
    h.click(graph().querySelector('.sem-node[aria-label="sem:Component"]')!)
    expect(h.subject()).toBe(NS.sem + 'Component')
    expect(graph().querySelector('.sem-node[aria-label="sem:Component"]')!.getAttribute('data-sem-salience')).toBe('focused')
  })

  it('shows everything a group holds as cards, by role: components, then mixins', () => {
    const h = reference()
    h.click(h.branch('Windows').querySelector(':scope > .sem-row > .sem-label')!)
    const members = h.page().querySelector('[data-sem-c=term-members]')!
    const sections = [...members.querySelectorAll('section.sem-role')]
    expect(sections.map((x) => x.getAttribute('data-sem-role'))).toEqual(['component', 'mixin', 'class'])
    // A mixin through another (c:Restorable, by way of c:Maximizable) is a mixin too.
    expect([...sections[1]!.querySelectorAll('.sem-card-title')].map((t) => t.textContent)).toContain('c:Restorable')
    expect(sections[0]!.querySelector('h3')!.textContent).toBe('Components')
    const card = (name: string) => [...members.querySelectorAll('[data-sem-c=term-card]')].find((c) => c.querySelector('.sem-card-title')!.textContent === name)!
    expect([...sections[1]!.querySelectorAll('.sem-card-title')].map((t) => t.textContent)).toEqual(expect.arrayContaining(['c:Draggable', 'c:Resizable']))
    expect(card('c:Draggable').getAttribute('data-sem-role')).toBe('mixin')
    const window = card('c:Window')
    expect(window.querySelector('.sem-slug')!.textContent).toBe('window')
    expect(window.querySelector('.sem-summary')!.textContent).toBe('A floating window with every capability: move, resize, raise, minimize, maximize, dock to an edge, close.')
    // Its superclasses as tags, the mixins marked; its counts; the specimens that show it.
    const tags = [...window.querySelectorAll('.sem-tag')]
    expect(tags.map((t) => t.textContent)).toEqual(expect.arrayContaining(['c:Frame', 'c:Dockable']))
    expect(tags.find((t) => t.textContent === 'c:Dockable')!.hasAttribute('data-sem-mixin')).toBe(true)
    expect(tags.find((t) => t.textContent === 'c:Frame')!.hasAttribute('data-sem-mixin')).toBe(false)
    expect(tags.find((t) => t.textContent === 'schema:WPSideBar')!.hasAttribute('data-sem-mixin')).toBe(false)
    expect([...window.querySelectorAll('.sem-stat')].map((x) => x.textContent)).toEqual(expect.arrayContaining(['1 rendering', '1 function rule']))
    expect(window.querySelectorAll('.sem-shown [data-sem-c=link]').length).toBeGreaterThan(0)
    // A card's name is a button that selects its term.
    h.click(window.querySelector('button.sem-card-title')!)
    expect(h.subject()).toBe(C + 'Window')
    expect(h.page().querySelectorAll('[data-sem-c=term-members] section').length).toBe(0) // a class holds nothing
    // A vocabulary lists its classes and properties.
    h.click(h.branch('Semblance persistence').querySelector(':scope > .sem-row > .sem-label')!)
    expect([...h.page().querySelectorAll('[data-sem-c=term-members] section.sem-role')].map((x) => x.getAttribute('data-sem-role'))).toEqual(['class', 'property'])
  })

  it('shows its triples as Turtle', () => {
    const h = reference()
    h.select('Inputs', 'CodeInput')
    h.tab('Turtle')
    const ttl = h.page().querySelector('[data-sem-c=class-doc]')!.textContent!
    expect(ttl).toContain('c:CodeInput')
    expect(ttl).toContain('rdfs:subClassOf sem:Component')
    expect(ttl).toContain('sh:targetClass c:CodeInput')
  })
})

describe('the reference, as components', () => {
  it('puts every component class in a group', () => {
    const store = new Store()
    for (const f of ONTOLOGY_FILES) store.addQuads(new Parser().parse(readFileSync(new URL(`../ontology/${f}`, import.meta.url), 'utf8')))
    const sub = (c: string, seen = new Set<string>()): boolean =>
      c === NS.sem + 'Component' || (!seen.has(c) && (seen.add(c), store.getQuads(c, NS.rdfs + 'subClassOf', null, null).some((q) => sub(q.object.value, seen))))
    const classes = store.getQuads(null, NS.rdf + 'type', NS.owl + 'Class', null).map((q) => q.subject.value)
    const ungrouped = classes.filter((c) => c !== NS.sem + 'Component' && sub(c) && !store.getQuads(c, NS.sem + 'group', null, null).length)
    expect(ungrouped, 'component classes without a sem:group (ontology/components/groups.ttl)').toEqual([])
    // Their parts too (events, kinds, words of a language): every class of the component
    // vocabulary is in the group of the component it is part of, but for the few several share.
    const shared = [NS.c + 'Phrase', NS.c + 'CompactPresentation']
    const parts = classes.filter((c) => c.startsWith(NS.c) && !shared.includes(c) && !store.getQuads(c, NS.sem + 'group', null, null).length)
    expect(parts, 'classes of the component vocabulary without a sem:group (ontology/components/groups.ttl)').toEqual([])
  })

  it('has SPARQL and function implementations of every rendering', () => {
    expect(implementationGaps(['components/reference.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })

  it('renders the same with SPARQL rules as with functions', () => {
    const sites = [reference('sparql'), reference('function')]
    const both = (act: (h: ReturnType<typeof reference>) => void) => {
      for (const h of sites) act(h)
      const [a, b] = sites.map((h) => h.page().innerHTML)
      if (a !== b) {
        let i = 0
        while (i < a!.length && a![i] === b![i]) i++
        expect(a!.slice(Math.max(0, i - 300), i + 300)).toBe(b!.slice(Math.max(0, i - 300), i + 300))
      }
    }
    both(() => {})
    both((h) => h.select('Inputs', 'CodeInput'))
    both((h) => h.select('Semblance components', 'label'))
    both((h) => h.click(h.branch('keyboard').querySelector(':scope > .sem-row > .sem-label')!))
    both((h) => h.select('Semblance style layer', 'Tone'))
    both((h) => h.open('Semblance behaviour layer'))
    both((h) => h.tab('Alignment'))
    both((h) => h.select('Data', 'Table'))
    both((h) => h.tab('Overview'))
    both((h) => h.select('Semblance style layer', 'Tone'))
    both((h) => h.click([...h.fact('Instances')!.querySelectorAll('button.sem-term')].find((b) => b.textContent === 'sty:Danger')!))
    both((h) => h.click(h.branch('Windows').querySelector(':scope > .sem-row > .sem-label')!))
    both((h) => h.click(h.branch('validation').querySelector(':scope > .sem-row > .sem-label')!))
    both((h) => h.click(h.branch('Semblance style layer').querySelector(':scope > .sem-row > .sem-label')!))
  }, 240_000)

  it('a selection re-runs the term views and the tree rule, not the branches', () => {
    const h = reference()
    h.open('Semblance components') // a large branch, open: it must not re-run
    h.select('Inputs', 'CodeInput')
    const stats = h.screen.engine.stats
    const runs = { ...stats }
    const before = new Map([...stats.byRule].map(([k, v]) => [k, v.runs]))
    const t = performance.now()
    h.select('Inputs', 'TextArea')
    const ms = performance.now() - t
    const ran = stats.ruleRuns - runs.ruleRuns
    expect(h.subject()).toBe(C + 'TextArea')
    const which = [...stats.byRule].filter(([k, v]) => v.runs !== (before.get(k) ?? 0)).map(([k, v]) => `${k.replace(/^.*#/, '')} ×${v.runs - (before.get(k) ?? 0)}`)
    expect(which.some((w) => w.startsWith('TermBranchRendering')), which.join(', ')).toBe(false)
    // The overview, the tree's own rule, the page switch (it follows ui:app), and what the overview
    // mints anew (its gallery links) with the layers that decorate them; and the search field, which
    // shows the term: its values' texts, its own rule and its (closed, empty) list of matches - not
    // the texts of the thousand terms it searches; and the page switcher's Reference option, whose
    // address (its formaction, for a visit without scripts) keeps the term, with the location's
    // spelling of it.
    expect(which.some((w) => w.startsWith('TypeaheadTexts')), which.join(', ')).toBe(false)
    expect(ran, which.join(', ')).toBeLessThanOrEqual(29)
    // Logged for the report: rule runs and wall time of one selection (Node, linkedom, oxigraph).
    console.log(`reference selection: ${ran} rule runs, ${ms.toFixed(1)} ms`)
  })

  it('remembers the term, the tab and the branches opened by hand (per:Policy, this tab)', async () => {
    const backends: Record<string, Backend> = { [NS.per + 'Session']: memoryBackend(), [NS.per + 'Device']: memoryBackend(), [NS.per + 'Database']: memoryBackend() }
    const h = reference()
    const persistence = new Persistence(h.store, backends, { delayMs: 60_000 })
    persistence.attach(h.runtime)
    h.select('Inputs', 'CodeInput')
    h.tab('Alignment')
    await persistence.flush()
    const next = mountSite()
    await new Persistence(next.store, backends).restore()
    const f = next.store.factory
    expect(next.store.match(f.namedNode(UI + 'app'), f.namedNode(UI + 'referenceSubject'), null).map((q) => q.object.value)).toEqual([C + 'CodeInput'])
    expect(next.store.match(f.namedNode(UI + 'referenceTabs'), f.namedNode(C + 'selected'), null).map((q) => q.object.value)).toEqual([UI + 'refAlignmentTab'])
    expect(next.store.match(null, f.namedNode(C + 'expanded'), null).some((q) => q.subject.value.startsWith(UI + 'referenceTree/~b-'))).toBe(true)
  })
})
