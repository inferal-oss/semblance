// c:RdfEditor (ontology/components/rdf-editor.ttl; src/components/rdf-editor.ts) as a viewer: the
// gallery's library document as a tree, driven through DOM events. Its SPARQL rules and function twins
// render the same HTML and text on Oxigraph and on Semblance's own engine after every step; links jump
// (the target row takes the focus) or go to the Reference; arrows follow their mode; an edit re-renders
// the rows of its subject, however large the document.
import { readFileSync } from 'node:fs'
import type { Quad } from '@rdfjs/types'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { md5 } from '../src/components/data.ts'
import { implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const LIB = 'https://semblance.dev/demo/library#'
const C = NS.c
const EDITOR = UI + 'dt-rdf-editor'
const GALLERY = readFileSync(new URL('../demo/gallery/_dt-rdf.ttl', import.meta.url), 'utf8')

type Kind = 'oxigraph' | 'wat'

/** The library editor, projected on its own (Screen and Text) and driven through events. */
function mount(kind: Kind, prefer: 'sparql' | 'function', extra = '', languages: string[] = [], root = EDITOR) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const store = loadStore(kind, GALLERY, extra)
  const runtime = new Runtime(store)
  const fail = (e: unknown) => {
    throw e
  }
  const screen = runtime.project({ modality: MOD.Screen, layers: [STY.Layer], prefer, languages, name: 'screen', roots: [root] }, fail)
  const text = runtime.project({ modality: MOD.Text, layers: [], prefer, languages, name: 'text', roots: [EDITOR] }, fail)
  const app = document.getElementById('app')!
  const dom = new DomRenderer(screen.index, app, root)
  dom.flush()
  const bus = new EventBus(runtime, screen, { prefer })
  bus.attach(dom, () => dom.flush())
  const f = store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const editor = () => app.querySelector('[data-sem-c=rdf-editor]') as HTMLElement
  /** The label of the row at a path of shown texts: a resource, then its predicate, then an object… */
  const label = (...path: string[]): HTMLElement => {
    let scope: Element = editor()
    let found: HTMLElement | undefined
    for (const step of path) {
      const rows = scope === editor() ? ':scope > .sem-tree > [role=treeitem] > .sem-row > .sem-label' : ':scope > [role=group] > [role=treeitem] > .sem-row > .sem-label'
      found = [...scope.querySelectorAll(rows)].find((l) => l.textContent === step) as HTMLElement | undefined
      if (!found) throw new Error(`no row ${path.join(' › ')}`)
      scope = found.closest('[role=treeitem]')!
    }
    return found!
  }
  const item = (...path: string[]) => label(...path).closest('[role=treeitem]') as HTMLElement
  const twisty = (...path: string[]) => item(...path).querySelector(':scope > .sem-row > .sem-twisty') as HTMLElement
  const click = (el: Element) => el.dispatchEvent(new window.Event('click', { bubbles: true }))
  const contextMenu = (el: Element) => el.dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true }))
  const focusOn = (el: Element) => el.dispatchEvent(new window.Event('focusin', { bubbles: true }))
  const key = (el: Element, k: string, shiftKey = false, altKey = false) => {
    const e = new window.Event('keydown', { bubbles: true, cancelable: true })
    Object.assign(e, { key: k, ctrlKey: false, metaKey: false, altKey, shiftKey })
    el.dispatchEvent(e)
  }
  /** The field open in the editor (editing a row, or adding to one). */
  const field = () => editor().querySelector('input.sem-edit') as HTMLInputElement | null
  /** Types into the open field and presses Enter. */
  const enter = (text: string) => {
    const input = field()!
    input.value = text
    key(input, 'Enter')
  }
  const objects = (s: string, p: string) => store.match(nn(s), nn(p), null).map((q) => (q.object.termType === 'Literal' ? `${q.object.value}|${q.object.language || q.object.datatype.value.replace(/^.*#/, '')}` : q.object.value))
  const apply = (change: { add?: Quad[]; remove?: Quad[] }) => {
    runtime.apply({ add: change.add ?? [], remove: change.remove ?? [] })
    dom.flush()
  }
  const outline = () => toText(text.index, EDITOR)
  const html = () => app.innerHTML
  const runs = (prefix: string, ns: string = C) => [...screen.engine.stats.byRule].filter(([iri]) => iri.startsWith(ns + prefix)).reduce((n, [, s]) => n + s.runs, 0)
  return { contextMenu, focusOn, bus, store, runtime, screen, dom, f, nn, editor, label, item, twisty, click, key, field, enter, objects, apply, outline, html, runs, document }
}

const LIBRARY = [
  'lib:dispossessed',
  '  a lib:Book',
  '  lib:author lib:ursula ~ lib:authorship {|',
  '     lib:source <https://www.wikidata.org/wiki/Q1213434>',
  '  |}',
  '  lib:edition [',
  '    lib:publisher "Harper & Row"',
  '    lib:year 1974',
  '  ]',
  '  lib:keywords ( "anarchism" "physics" "utopia" )',
  '  lib:pages 387',
  '  lib:published "1974"^^xsd:gYear',
  '  lib:title "The Dispossessed"@en "Знедолені"@uk',
  'lib:earthsea',
  '  a lib:Book',
  '  lib:author lib:ursula',
  '  lib:pages 183',
  '  lib:title "A Wizard of Earthsea"@en',
  'lib:ursula',
  '  a lib:Person',
  '  lib:born "1929-10-21"^^xsd:date',
  '  rdfs:label "Ursula K. Le Guin"',
]

describe('c:RdfEditor', () => {
  it('has a SPARQL and a function implementation of every rendering', () => {
    expect(implementationGaps(['components/rdf-editor.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })

  it('shows the document as a Turtle-like outline in the Text modality', () => {
    expect(mount('oxigraph', 'sparql').outline().split('\n')).toEqual(LIBRARY)
  })

  it('is a tree of resources, predicates and objects, with literals typed and nested resources described', () => {
    const { editor, item, label } = mount('oxigraph', 'sparql')
    const tree = editor().querySelector(':scope > .sem-tree')!
    expect(tree.getAttribute('role')).toBe('tree')
    expect(tree.getAttribute('aria-label')).toBe('Library')
    expect(item('lib:dispossessed').getAttribute('aria-level')).toBe('1')
    expect(item('lib:dispossessed', 'lib:pages').getAttribute('aria-level')).toBe('2')
    expect(item('lib:dispossessed', 'lib:pages', '387').getAttribute('aria-level')).toBe('3')
    expect(item('lib:dispossessed', 'lib:published', '"1974"').querySelector('.sem-datatype')!.textContent).toBe('xsd:gYear')
    expect(item('lib:dispossessed', 'lib:title', '"Знедолені"').querySelector('.sem-datatype')!.textContent).toBe('@uk')
    expect(label('lib:dispossessed', 'lib:edition', '[ ]').getAttribute('aria-description')).toBe('nested resource')
    expect(label('lib:dispossessed', 'lib:keywords', '( 3 )').getAttribute('aria-description')).toBe('list of 3')
    expect(label('lib:dispossessed', 'lib:author', 'lib:ursula', 'lib:authorship').getAttribute('aria-description')).toBe('said about this statement')
    // A label that says more than the name is shown; one that repeats it is not.
    expect(item('lib:dispossessed', 'lib:author', 'lib:ursula').querySelector(':scope > .sem-row > .sem-note')!.textContent).toBe('Ursula K. Le Guin')
    expect(item('lib:dispossessed', 'lib:author').querySelector(':scope > .sem-row > .sem-note')).toBeNull()
    // One label of each resource is in the tab order; twisties are not stops.
    expect(label('lib:dispossessed').getAttribute('tabindex')).toBe('0')
    expect(label('lib:dispossessed', 'lib:pages').getAttribute('tabindex')).toBe('-1')
    expect(item('lib:dispossessed').querySelector('.sem-twisty')!.getAttribute('tabindex')).toBe('-1')
  })

  it('links resources of the document (jump) and vocabulary terms (the Reference); a class does not open in place', () => {
    const { label, item } = mount('oxigraph', 'sparql')
    expect(label('lib:dispossessed', 'lib:author', 'lib:ursula').getAttribute('data-sem-link')).toBe('resource')
    expect(label('lib:dispossessed', 'a', 'lib:Book').getAttribute('data-sem-link')).toBe('term')
    expect(item('lib:dispossessed', 'a', 'lib:Book').hasAttribute('aria-expanded')).toBe(false)
    expect(label('lib:dispossessed', 'lib:author').getAttribute('data-sem-link')).toBe('term')
    expect(label('lib:dispossessed', 'lib:author', 'lib:ursula', 'lib:authorship', 'lib:source', '<https://www.wikidata.org/wiki/Q1213434>').hasAttribute('data-sem-link')).toBe(false)
  })

  for (const prefer of ['sparql', 'function'] as const) {
    it(`follows links: a jump makes the resource current and focuses its row, the next change spends the mark (${prefer})`, () => {
      const { store, nn, label, item, twisty, click, key } = mount('oxigraph', prefer)
      const current = () => store.match(nn(EDITOR), nn(C + 'current'), null).map((q) => q.object.value)
      click(label('lib:dispossessed', 'lib:author', 'lib:ursula'))
      expect(current()).toEqual([LIB + 'ursula'])
      expect(label('lib:ursula').hasAttribute('data-sem-takes-focus')).toBe(true)
      // Enter on a row follows its link too.
      key(label('lib:ursula', 'a', 'lib:Person'), 'Enter')
      expect(store.match(nn(EDITOR), nn(NS.nav + 'goTo'), null).map((q) => q.object.value)).toEqual([LIB + 'Person'])
      // A twisty opens a nested IRI in place, and spends the focus mark.
      click(twisty('lib:dispossessed', 'lib:author', 'lib:ursula'))
      expect(label('lib:ursula').hasAttribute('data-sem-takes-focus')).toBe(false)
      expect(item('lib:dispossessed', 'lib:author', 'lib:ursula', 'lib:born').getAttribute('aria-level')).toBe('4')
      click(twisty('lib:dispossessed', 'lib:edition'))
      expect(item('lib:dispossessed', 'lib:edition').getAttribute('aria-expanded')).toBe('false')
      expect(item('lib:dispossessed', 'lib:edition').querySelector('[role=group]')).toBeNull()
    })
  }

  const EXAMPLE = readFileSync(new URL('../demo/gallery/_ex-rdf.ttl', import.meta.url), 'utf8')
  for (const kind of ['oxigraph', 'wat'] as const)
    for (const prefer of ['sparql', 'function'] as const) {
      it(`follows a link in the editing example with a click: current, focused, its arrow re-aimed (${kind}, ${prefer})`, () => {
        // The recipes example as it is on the site: editable, validated, arrows from the current resource.
        const m = mount(kind, prefer, EXAMPLE, [], UI + 'ex-rdf-editor')
        const RCP = 'https://semblance.dev/demo/recipes#'
        const current = () => m.store.match(m.nn(UI + 'ex-rdf-editor'), m.nn(C + 'current'), null).map((q) => q.object.value)
        const arrows = () => [...m.editor().querySelectorAll('[data-sem-c=connector]')].map((a) => [a.getAttribute('data-sem-from'), a.getAttribute('data-sem-to')])
        expect(current()).toEqual([RCP + 'borscht'])
        const link = m.label('rcp:borscht', 'rcp:author', 'rcp:olena')
        expect(link.getAttribute('data-sem-link')).toBe('resource')
        expect(arrows()).toEqual([[link.id, m.label('rcp:olena').id]])
        m.focusOn(link)
        m.click(link)
        expect(current()).toEqual([RCP + 'olena'])
        expect(m.item('rcp:olena').getAttribute('aria-current')).toBe('true')
        expect(m.item('rcp:borscht').hasAttribute('aria-current')).toBe(false)
        expect(m.label('rcp:olena').hasAttribute('data-sem-takes-focus')).toBe(true)
        // Nothing opened for editing: a click on a link follows it, in an editor too.
        expect(m.field()).toBeNull()
        // From this resource: the arrows that touch olena, which is the one from Borscht's author.
        expect(arrows()).toEqual([[m.label('rcp:borscht', 'rcp:author', 'rcp:olena').id, m.label('rcp:olena').id]])
        // Every link, then none.
        m.apply({ remove: m.store.match(m.nn(UI + 'ex-rdf-editor'), m.nn(C + 'arrows'), null), add: [m.f.quad(m.nn(UI + 'ex-rdf-editor'), m.nn(C + 'arrows'), m.nn(C + 'ArrowsOff'))] })
        expect(arrows()).toEqual([])
      })
    }

  it('draws arrows for the current resource, for all links, or none', () => {
    const { store, nn, f, editor, apply, click, label } = mount('oxigraph', 'sparql')
    const arrows = () => [...editor().querySelectorAll('[data-sem-c=connector]')].length
    // Current: lib:dispossessed links to lib:ursula.
    expect(arrows()).toBe(1)
    click(label('lib:earthsea', 'lib:author', 'lib:ursula'))
    expect(arrows()).toBe(2)
    const mode = (m: string) => apply({ remove: store.match(nn(EDITOR), nn(C + 'arrows'), null), add: [f.quad(nn(EDITOR), nn(C + 'arrows'), nn(C + m))] })
    mode('ArrowsOn')
    expect(arrows()).toBe(2)
    mode('ArrowsOff')
    expect(arrows()).toBe(0)
  })

  it('speaks the viewer\'s language', () => {
    const { label } = mount('oxigraph', 'sparql', '', ['uk'])
    expect(label('lib:dispossessed', 'lib:edition', '[ ]').getAttribute('aria-description')).toBe('вкладений ресурс')
    expect(label('lib:dispossessed', 'lib:keywords', '( 3 )').getAttribute('aria-description')).toBe('список із 3')
  })

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders the same HTML and text with SPARQL and function rules after every step (${kind})`, () => {
      const both = [mount(kind, 'sparql'), mount(kind, 'function')]
      const same = (step: string) => {
        expect(both[1]!.html(), step).toBe(both[0]!.html())
        expect(both[1]!.outline(), step).toBe(both[0]!.outline())
      }
      const each = (act: (m: ReturnType<typeof mount>) => void) => both.forEach(act)
      same('initial')
      each((m) => m.click(m.twisty('lib:dispossessed', 'lib:edition')))
      same('closing a predicate')
      each((m) => m.click(m.twisty('lib:dispossessed', 'lib:author', 'lib:ursula')))
      same('opening a nested IRI')
      each((m) => m.click(m.label('lib:earthsea', 'lib:author', 'lib:ursula')))
      same('a jump')
      each((m) => m.apply({ add: [m.f.quad(m.nn(LIB + 'earthsea'), m.nn(LIB + 'keywords'), m.nn(NS.rdf + 'nil'))] }))
      same('an empty list')
      each((m) => {
        const pages = m.store.match(m.nn(LIB + 'earthsea'), m.nn(LIB + 'pages'), null)
        m.apply({ remove: pages, add: [m.f.quad(m.nn(LIB + 'earthsea'), m.nn(LIB + 'pages'), m.f.literal('205', m.nn(NS.xsd + 'integer')))] })
      })
      same('a changed literal')
      each((m) => {
        const arrows = m.store.match(m.nn(EDITOR), m.nn(C + 'arrows'), null)
        m.apply({ remove: arrows, add: [m.f.quad(m.nn(EDITOR), m.nn(C + 'arrows'), m.nn(C + 'ArrowsOn'))] })
      })
      same('all arrows')
    })
  }

  it('costs what an edit changes: the rows of its subject, however many resources the document has', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `lib:extra${i} a lib:Book ; lib:title "Extra ${i}" ; lib:pages ${i} ; lib:edition [ lib:year ${1900 + i} ] .\nui:dt-rdf-editor c:entry lib:extra${i} .`).join('\n')
    const prefixes = '@prefix c: <https://semblance.dev/ns/component#> .\n@prefix ui: <https://semblance.dev/demo#> .\n@prefix lib: <https://semblance.dev/demo/library#> .\n'
    const editRuns = (n: number) => {
      const m = mount('oxigraph', 'sparql', prefixes + many(n))
      const before = m.runs('Rdf')
      const pages = m.store.match(m.nn(LIB + 'earthsea'), m.nn(LIB + 'pages'), null)
      m.apply({ remove: pages, add: [m.f.quad(m.nn(LIB + 'earthsea'), m.nn(LIB + 'pages'), m.f.literal('205', m.nn(NS.xsd + 'integer')))] })
      expect(m.item('lib:earthsea', 'lib:pages', '205')).toBeTruthy()
      return m.runs('Rdf') - before
    }
    const small = editRuns(2)
    expect(small).toBeLessThanOrEqual(12)
    expect(editRuns(40)).toBe(small)
  })

  const EDITABLE = `@prefix c: <https://semblance.dev/ns/component#> . @prefix beh: <https://semblance.dev/ns/behaviour#> . @prefix ui: <https://semblance.dev/demo#> .
ui:dt-rdf-editor c:editable true .
ui:rdf-edit a c:Stack ; c:children ( ui:rdf-undo ui:dt-rdf-editor ) .
ui:rdf-undo a c:Button , beh:Undoer ; c:label "Undo" .`

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`edits as structure: terms, predicates, new statements, list members, undo; SPARQL and function alike (${kind})`, () => {
      const both = [mount(kind, 'sparql', EDITABLE, [], UI + 'rdf-edit'), mount(kind, 'function', EDITABLE, [], UI + 'rdf-edit')]
      const [m] = both as [ReturnType<typeof mount>]
      const same = (step: string) => {
        expect(both[1]!.html(), step).toBe(both[0]!.html())
        expect(both[1]!.store.match(null, null, null).filter((q) => q.subject.value.startsWith(LIB)).length, step).toBe(m.store.match(null, null, null).filter((q) => q.subject.value.startsWith(LIB)).length)
      }
      const each = (act: (x: ReturnType<typeof mount>) => void, step: string) => {
        both.forEach(act)
        same(step)
      }
      same('initial')
      // A click follows a link in an editor too; Enter edits.
      each((x) => x.click(x.label('lib:earthsea', 'lib:author', 'lib:ursula')), 'a click on a link')
      expect(m.store.match(m.nn(EDITOR), m.nn(C + 'current'), null).map((q) => q.object.value)).toEqual([LIB + 'ursula'])
      each((x) => x.key(x.label('lib:earthsea', 'lib:pages', '183'), 'Enter'), 'Enter on a number')
      expect(m.field()!.value).toBe('183')
      expect(m.field()!.hasAttribute('data-sem-takes-focus')).toBe(true)
      each((x) => x.enter('205'), 'a new number')
      expect(m.objects(LIB + 'earthsea', LIB + 'pages')).toEqual(['205|integer'])
      expect(m.field()).toBeNull()
      expect(m.label('lib:earthsea', 'lib:pages', '205').hasAttribute('data-sem-takes-focus')).toBe(true)
      // Text without quotes keeps the literal's language; Turtle syntax says another.
      each((x) => x.key(x.label('lib:earthsea', 'lib:title', '"A Wizard of Earthsea"'), 'Enter'), 'Enter on a title')
      expect(m.field()!.value).toBe('A Wizard of Earthsea')
      each((x) => x.enter('A Wizard of Earthsea (1968)'), 'a new title')
      expect(m.objects(LIB + 'earthsea', LIB + 'title')).toEqual(['A Wizard of Earthsea (1968)|en'])
      each((x) => x.key(x.label('lib:earthsea', 'lib:title', '"A Wizard of Earthsea (1968)"'), 'Enter'), 'Enter on it again')
      each((x) => x.enter('"Чарівник Земномор\'я"@uk'), 'a title in Ukrainian')
      expect(m.objects(LIB + 'earthsea', LIB + 'title')).toEqual(["Чарівник Земномор'я|uk"])
      // A predicate renamed: every statement of it.
      each((x) => x.key(x.label('lib:earthsea', 'lib:pages'), 'Enter'), 'Enter on a predicate')
      expect(m.field()!.value).toBe('lib:pages')
      each((x) => x.enter('lib:pageCount'), 'a renamed predicate')
      expect(m.objects(LIB + 'earthsea', LIB + 'pageCount')).toEqual(['205|integer'])
      expect(m.objects(LIB + 'earthsea', LIB + 'pages')).toEqual([])
      // Escape leaves a field unchanged.
      each((x) => x.key(x.label('lib:earthsea', 'lib:pageCount', '205'), 'Enter'), 'Enter on a value')
      each((x) => x.key(x.field()!, 'Escape'), 'Escape')
      expect(m.field()).toBeNull()
      expect(m.objects(LIB + 'earthsea', LIB + 'pageCount')).toEqual(['205|integer'])
      // Shift+Enter on a resource: a new statement, "predicate value".
      each((x) => x.key(x.label('lib:earthsea'), 'Enter', true), 'Shift+Enter on a resource')
      expect(m.field()!.getAttribute('aria-label')).toBe('predicate value')
      each((x) => x.enter('lib:published "1968"^^xsd:gYear'), 'a new statement')
      expect(m.objects(LIB + 'earthsea', LIB + 'published')).toEqual(['1968|gYear'])
      // Shift+Enter beside an object: another object of its predicate.
      each((x) => x.key(x.label('lib:earthsea', 'lib:author', 'lib:ursula'), 'Enter', true), 'Shift+Enter beside an object')
      each((x) => x.enter('<https://example.org/someone>'), 'a new object')
      expect(m.objects(LIB + 'earthsea', LIB + 'author').sort()).toEqual(['https://example.org/someone', LIB + 'ursula'])
      // Delete: a statement; list members, the list closing up (the head too).
      each((x) => x.key(x.label('lib:earthsea', 'lib:author', '<https://example.org/someone>'), 'Delete'), 'Delete a statement')
      expect(m.objects(LIB + 'earthsea', LIB + 'author')).toEqual([LIB + 'ursula'])
      // Undo goes back through the change log, one change at a time.
      const undo = (x: ReturnType<typeof mount>) => x.click(x.document.querySelector('[data-sem-c=button]')!)
      each(undo, 'Undo the delete')
      expect(m.objects(LIB + 'earthsea', LIB + 'author')).toHaveLength(2)
      // The field the edit closed is view state (beh:viewState): undo does not open it again.
      expect(m.field()).toBeNull()
      each(undo, 'Undo the addition')
      expect(m.objects(LIB + 'earthsea', LIB + 'author')).toEqual([LIB + 'ursula'])
      each((x) => x.key(x.label('lib:dispossessed', 'lib:keywords', '( 3 )', '"physics"'), 'Delete'), 'Delete a list member')
      expect(m.outline()).toContain('lib:keywords ( "anarchism" "utopia" )')
      each((x) => x.key(x.label('lib:dispossessed', 'lib:keywords', '( 2 )', '"anarchism"'), 'Delete'), 'Delete the head of a list')
      expect(m.outline()).toContain('lib:keywords ( "utopia" )')
    })
  }

  const VALIDATED = `@prefix c: <https://semblance.dev/ns/component#> . @prefix beh: <https://semblance.dev/ns/behaviour#> . @prefix ui: <https://semblance.dev/demo#> . @prefix lib: <https://semblance.dev/demo/library#> .
ui:dt-rdf-editor c:validated true ; c:editable true .
lib:earthsea lib:pages "many" .`
  const problemsOf = (m: ReturnType<typeof mount>, ...path: string[]) =>
    [...(m.item(...path).querySelector(':scope > .sem-problems')?.children ?? [])].map((p) => p.textContent)

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`shows what does not conform inline, and lets go of it once fixed; SPARQL and function alike (${kind})`, () => {
      const both = [mount(kind, 'sparql', VALIDATED), mount(kind, 'function', VALIDATED)]
      const [m] = both as [ReturnType<typeof mount>]
      const each = (act: (x: ReturnType<typeof mount>) => void, step: string) => {
        both.forEach(act)
        expect(both[1]!.html(), step).toBe(m.html())
      }
      each(() => {}, 'initial')
      // A required predicate the resource lacks: on the resource's row, its label described by it.
      expect(problemsOf(m, 'lib:earthsea')).toEqual(['When was it published?'])
      const label = m.label('lib:earthsea')
      expect(label.getAttribute('aria-invalid')).toBe('true')
      expect(m.document.getElementById(label.getAttribute('aria-describedby')!)?.textContent).toContain('When was it published?')
      // A value's own problems: on its row.
      expect(problemsOf(m, 'lib:earthsea', 'lib:pages', '"many"')).toEqual(['pages: at least 1', 'pages: expected xsd:integer'])
      expect(problemsOf(m, 'lib:earthsea', 'lib:pages', '183')).toEqual([])
      expect(m.editor().querySelectorAll('.sem-invalid')).toHaveLength(2)
      // Fixed by editing: the problems go.
      each((x) => x.key(x.label('lib:earthsea', 'lib:pages', '"many"'), 'Delete'), 'deleting the bad value')
      each((x) => x.key(x.label('lib:earthsea'), 'Enter', true), 'Shift+Enter')
      each((x) => x.enter('lib:published "1968"^^xsd:gYear'), 'adding what was missing')
      expect(m.editor().querySelectorAll('.sem-invalid')).toHaveLength(0)
      // Switched off, nothing is checked or shown.
      each((x) => x.apply({ add: [x.f.quad(x.nn(LIB + 'ursula'), x.nn(LIB + 'born'), x.f.literal('long ago'))] }), 'a bad date')
      expect(problemsOf(m, 'lib:ursula', 'lib:born', '"long ago"')).toEqual(['born: expected xsd:date'])
      each((x) => x.apply({ remove: x.store.match(x.nn(EDITOR), x.nn(C + 'validated'), null) }), 'validation off')
      expect(m.editor().querySelectorAll('.sem-problems')).toHaveLength(0)
    })
  }

  const TYPED = `@prefix c: <https://semblance.dev/ns/component#> . @prefix lib: <https://semblance.dev/demo/library#> . @prefix ui: <https://semblance.dev/demo#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ui:dt-rdf-editor c:editable true .
lib:earthsea lib:pages "many" .
lib:rating rdfs:range xsd:decimal .`

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`types what is written as Turtle does, and as the property expects; SPARQL and function alike (${kind})`, () => {
      const both = [mount(kind, 'sparql', TYPED), mount(kind, 'function', TYPED)]
      const [m] = both as [ReturnType<typeof mount>]
      const each = (act: (x: ReturnType<typeof mount>) => void, step: string) => {
        both.forEach(act)
        expect(both[1]!.html(), step).toBe(m.html())
        for (const x of both.slice(1)) expect(x.objects(LIB + 'earthsea', LIB + 'note').sort(), step).toEqual(m.objects(LIB + 'earthsea', LIB + 'note').sort())
      }
      // A string where the shape says xsd:integer: a number typed over it is an integer.
      each((x) => x.key(x.label('lib:earthsea', 'lib:pages', '"many"'), 'Enter'), 'Enter on a string')
      each((x) => x.enter('212'), 'a number over it')
      expect(m.objects(LIB + 'earthsea', LIB + 'pages').sort()).toEqual(['183|integer', '212|integer'])
      // A date where the shape says xsd:date, though the old value was a string.
      each((x) => x.apply({ add: [x.f.quad(x.nn(LIB + 'ursula'), x.nn(LIB + 'born'), x.f.literal('soon'))] }), 'a string date')
      each((x) => x.key(x.label('lib:ursula', 'lib:born', '"soon"'), 'Enter'), 'Enter on it')
      each((x) => x.enter('1929-10-22'), 'a date')
      expect(m.objects(LIB + 'ursula', LIB + 'born').sort()).toEqual(['1929-10-21|date', '1929-10-22|date'])
      // An XSD rdfs:range, for a new statement.
      each((x) => x.key(x.label('lib:earthsea'), 'Enter', true), 'Shift+Enter')
      each((x) => x.enter('lib:rating 4'), 'a rating')
      expect(m.objects(LIB + 'earthsea', LIB + 'rating')).toEqual(['4|decimal'])
      // Otherwise Turtle's reading: integer, decimal, double, boolean, else a string.
      for (const [text, typed] of [['2', 'integer'], ['2.5', 'decimal'], ['1e3', 'double'], ['true', 'boolean'], ['two', 'string']]) {
        each((x) => x.key(x.label('lib:earthsea'), 'Enter', true), `Shift+Enter for ${text}`)
        each((x) => x.enter(`lib:note ${text}`), `a note ${text}`)
        // (a store may write the number canonically: 1e3 as 1000)
        expect(m.objects(LIB + 'earthsea', LIB + 'note').filter((o) => o.endsWith(`|${typed}`)), text).toHaveLength(1)
      }
    })
  }

  it('checks what an edit changed: one entry, however many the document has', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `lib:extra${i} a lib:Book ; lib:title "Extra ${i}" ; lib:pages ${i + 1} ; lib:author lib:ursula ; lib:published "1970"^^<http://www.w3.org/2001/XMLSchema#gYear> .\nui:dt-rdf-editor c:entry lib:extra${i} .`).join('\n')
    const editRuns = (n: number) => {
      const m = mount('oxigraph', 'sparql', VALIDATED + '\n' + many(n))
      const before = m.runs('EntryShapes', 'https://semblance.dev/ns/validation#')
      m.apply({ add: [m.f.quad(m.nn(LIB + 'earthsea'), m.nn(LIB + 'published'), m.f.literal('1968'))] })
      return m.runs('EntryShapes', 'https://semblance.dev/ns/validation#') - before
    }
    expect(editRuns(2)).toBe(1)
    expect(editRuns(40)).toBe(1)
  })

  const SUGGESTING = `@prefix c: <https://semblance.dev/ns/component#> . @prefix ui: <https://semblance.dev/demo#> . @prefix lib: <https://semblance.dev/demo/library#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix sh: <http://www.w3.org/ns/shacl#> .
ui:dt-rdf-editor c:editable true ; c:entry lib:loose .
lib:Format a owl:Class . lib:Hardcover a lib:Format . lib:Paperback a lib:Format .
lib:FormatShape a sh:NodeShape ; sh:targetClass lib:Book ; sh:property [ sh:path lib:format ; sh:class lib:Format ] , [ sh:path lib:language ; sh:in ( "en" "uk" ) ] .
lib:loose lib:title "Untyped" .`

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`completes from the shapes: what is required first, whole statements in one pick; SPARQL and function alike (${kind})`, () => {
      const both = [mount(kind, 'sparql', SUGGESTING), mount(kind, 'function', SUGGESTING)]
      const [m] = both as [ReturnType<typeof mount>]
      const each = (act: (x: ReturnType<typeof mount>) => void, step: string) => {
        both.forEach(act)
        expect(both[1]!.html(), step).toBe(m.html())
      }
      const options = () => [...m.editor().querySelectorAll('.sem-suggestions > button')].map((b) => b.firstChild!.textContent + (b.classList.contains('sem-required') ? ' *' : ''))
      const option = (x: ReturnType<typeof mount>, text: string) => [...x.editor().querySelectorAll('.sem-suggestions > button')].find((b) => b.firstChild!.textContent === text)!
      const type = (x: ReturnType<typeof mount>, text: string) => {
        const input = x.field()!
        input.value = text
        input.dispatchEvent(new x.document.defaultView!.Event('input', { bubbles: true }))
      }
      each((x) => x.key(x.label('lib:earthsea'), 'Enter', true), 'Shift+Enter on a book')
      expect(m.editor().querySelector('.sem-suggestions')!.getAttribute('aria-label')).toBe('Expected here')
      expect(options()).toEqual(['lib:published *', 'lib:author', 'lib:format', 'lib:language', 'lib:language "en"', 'lib:language "uk"', 'lib:pages', 'lib:title'])
      // Typing narrows them.
      each((x) => type(x, 'lang'), 'typing')
      expect(options()).toEqual(['lib:language', 'lib:language "en"', 'lib:language "uk"'])
      // A predicate with its value: the whole statement, at once.
      each((x) => x.click(option(x, 'lib:language "uk"')), 'a whole statement')
      expect(m.objects(LIB + 'earthsea', LIB + 'language')).toEqual(['uk|string'])
      expect(m.field()).toBeNull()
      // A predicate alone goes into the field; the value follows.
      each((x) => x.key(x.label('lib:earthsea'), 'Enter', true), 'Shift+Enter again')
      each((x) => x.click(option(x, 'lib:format')), 'a predicate')
      expect(m.field()!.value).toBe('lib:format ')
      each((x) => x.enter(x.field()!.value + 'lib:Paperback'), 'its value')
      // A predicate's values: instances of its sh:class not yet there.
      each((x) => x.key(x.label('lib:earthsea', 'lib:format', 'lib:Paperback'), 'Enter', true), 'Shift+Enter beside a value')
      expect(options()).toEqual(['lib:Hardcover'])
      each((x) => x.click(option(x, 'lib:Hardcover')), 'another value')
      expect(m.objects(LIB + 'earthsea', LIB + 'format').sort()).toEqual([LIB + 'Hardcover', LIB + 'Paperback'])
      // A resource with no class: the classes shapes target that the document uses.
      each((x) => x.key(x.label('lib:loose'), 'Enter', true), 'Shift+Enter on an untyped resource')
      expect(options()).toEqual(['a lib:Book', 'a lib:Person'])
    })
  }

  const STRUCTURE = `@prefix c: <https://semblance.dev/ns/component#> . @prefix ui: <https://semblance.dev/demo#> .
ui:dt-rdf-editor c:editable true .`

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`nests, outdents, moves and appends list members, and moves statements by drag; SPARQL and function alike (${kind})`, () => {
      const both = [mount(kind, 'sparql', STRUCTURE), mount(kind, 'function', STRUCTURE)]
      const [m] = both as [ReturnType<typeof mount>]
      const each = (act: (x: ReturnType<typeof mount>) => void, step: string) => {
        both.forEach(act)
        expect(both[1]!.html(), step).toBe(m.html())
        expect(both[1]!.outline(), step).toBe(m.outline())
      }
      const line = (word: string) => m.outline().split('\n').filter((l) => l.includes(word))
      // Tab: the value becomes a nested resource's rdf:value, and keeps the focus.
      each((x) => x.key(x.label('lib:earthsea', 'lib:pages', '183'), 'Tab'), 'Tab')
      expect(m.outline()).toContain('  lib:pages [\n    rdf:value 183\n  ]')
      expect(m.label('lib:earthsea', 'lib:pages', '[ ]', 'rdf:value', '183').hasAttribute('data-sem-takes-focus')).toBe(true)
      // Shift+Tab: back up; the nested resource, left with nothing, goes.
      each((x) => x.key(x.label('lib:earthsea', 'lib:pages', '[ ]', 'rdf:value', '183'), 'Tab', true), 'Shift+Tab')
      expect(line('lib:pages')).toEqual(['  lib:pages 387', '  lib:pages 183'])
      expect(m.outline()).not.toContain('rdf:value')
      // Shift+Tab on a statement of a nested resource that says more: it moves up, the rest stays.
      each((x) => x.key(x.label('lib:dispossessed', 'lib:edition', '[ ]', 'lib:year', '1974'), 'Tab', true), 'Shift+Tab out of the edition')
      expect(m.outline()).toContain('  lib:edition [\n    lib:publisher "Harper & Row"\n  ]')
      expect(m.objects(LIB + 'dispossessed', LIB + 'year')).toEqual(['1974|integer'])
      // Alt+Down and Alt+Up move a list member; Shift+Enter on one appends to its list.
      each((x) => x.key(x.label('lib:dispossessed', 'lib:keywords', '( 3 )', '"physics"'), 'ArrowDown', false, true), 'Alt+Down')
      expect(line('lib:keywords')).toEqual(['  lib:keywords ( "anarchism" "utopia" "physics" )'])
      expect(m.label('lib:dispossessed', 'lib:keywords', '( 3 )', '"physics"').hasAttribute('data-sem-takes-focus')).toBe(true)
      each((x) => x.key(x.label('lib:dispossessed', 'lib:keywords', '( 3 )', '"physics"'), 'ArrowUp', false, true), 'Alt+Up')
      expect(line('lib:keywords')).toEqual(['  lib:keywords ( "anarchism" "physics" "utopia" )'])
      each((x) => x.key(x.label('lib:dispossessed', 'lib:keywords', '( 3 )', '"utopia"'), 'Enter', true), 'Shift+Enter on a member')
      expect(m.field()!.getAttribute('aria-label')).toBe('New member')
      each((x) => x.enter('ecology'), 'a new member')
      expect(line('lib:keywords')).toEqual(['  lib:keywords ( "anarchism" "physics" "utopia" "ecology" )'])
      // A drop on a predicate's row moves the statement there (the drag layer raises dnd:Drop).
      expect(m.item('lib:earthsea', 'lib:author', 'lib:ursula').getAttribute('data-sem-c')).toBe('rdf-term')
      each((x) => {
        const E = EDITOR
        const k12 = (v: string) => md5(v).slice(0, 12)
        const target = `${E}/~t-${k12(LIB + 'ursula')}/~p-${k12(LIB + 'born')}`
        const dragged = `${E}/~t-${k12(LIB + 'earthsea')}/~p-${k12(LIB + 'pages')}/~t-${k12('"183"^^http://www.w3.org/2001/XMLSchema#integer')}`
        x.bus.emit(NS.dnd + 'Drop', target, { about: [[NS.dnd + 'into', x.nn(target)], [NS.dnd + 'carrying', x.nn(dragged)]] })
        x.dom.flush()
      }, 'a drop')
      expect(m.objects(LIB + 'ursula', LIB + 'born').sort()).toEqual(['183|integer', '1929-10-21|date'])
      expect(line('lib:pages')).toEqual(['  lib:pages 387'])
    })
  }

  it('keeps a large document light: closed resources cost a row each, an edit what it changes', () => {
    const big = (n: number) =>
      '@prefix c: <https://semblance.dev/ns/component#> . @prefix ui: <https://semblance.dev/demo#> . @prefix lib: <https://semblance.dev/demo/library#> .\nui:dt-rdf-editor c:expandDepth 0 .\n' +
      Array.from({ length: n }, (_, i) => `lib:b${i} a lib:Book ; lib:title "Book ${i}" ; lib:pages ${i + 1} ; lib:edition [ lib:year ${1900 + i} ] .\nui:dt-rdf-editor c:entry lib:b${i} .`).join('\n')
    const measure = (n: number) => {
      const m = mount('oxigraph', 'sparql', big(n))
      const rows = m.editor().querySelectorAll('[role=treeitem]').length
      const before = m.runs('Rdf')
      m.apply({ add: [m.f.quad(m.nn(LIB + 'b1'), m.nn(LIB + 'pages'), m.f.literal('7', m.nn(NS.xsd + 'integer')))] })
      const edit = m.runs('Rdf') - before
      m.click(m.twisty('lib:b1'))
      const opened = m.editor().querySelectorAll('[role=treeitem]').length - rows
      return { rows, edit, opened }
    }
    const small = measure(10)
    const large = measure(300)
    expect(small.rows).toBe(13)
    expect(large.rows).toBe(303)
    expect(large.edit).toBe(small.edit)
    expect(large.opened).toBe(small.opened)
    expect(large.opened).toBeGreaterThan(0)
  })

  const FLUID = `@prefix c: <https://semblance.dev/ns/component#> . @prefix ui: <https://semblance.dev/demo#> .
ui:dt-rdf-editor c:editable true .`

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`is fluid from the keyboard: typing edits, the suggestions are a combobox, rows have a menu, a status line says where; SPARQL and function alike (${kind})`, () => {
      const both = [mount(kind, 'sparql', FLUID), mount(kind, 'function', FLUID)]
      const [m] = both as [ReturnType<typeof mount>]
      const each = (act: (x: ReturnType<typeof mount>) => void, step: string) => {
        both.forEach(act)
        expect(both[1]!.html(), step).toBe(m.html())
      }
      const typeKey = (x: ReturnType<typeof mount>, el: Element, ch: string) => {
        const e = new x.document.defaultView!.Event('keydown', { bubbles: true, cancelable: true })
        Object.assign(e, { key: ch, ctrlKey: false, metaKey: false, altKey: false, shiftKey: ch !== ch.toLowerCase() })
        el.dispatchEvent(e)
      }
      const status = () => m.editor().querySelector('.sem-status')!
      // The status line: viewing, with the keys that apply; focus moves it.
      expect(status().querySelector('.sem-mode')!.textContent).toBe('Viewing')
      expect([...status().querySelectorAll('.sem-key')].map((k) => k.textContent)).toEqual(['↵edit', '⇧↵add', '⌫delete', '⇥nest', '⌥↑↓move', '⇧F10menu'])
      each((x) => x.focusOn(x.label('lib:earthsea', 'lib:pages', '183')), 'focus on a value')
      expect(status().querySelector('.sem-where')!.textContent).toBe('lib:earthsea › lib:pages › "183"')
      // Typing a character edits the row, the character typed.
      each((x) => typeKey(x, x.label('lib:earthsea', 'lib:pages', '183'), '2'), 'typing on a value')
      expect(m.field()!.value).toBe('2')
      each((x) => x.focusOn(x.field()!), 'focus in the field')
      expect(status().querySelector('.sem-mode')!.textContent).toBe('Editing')
      each((x) => x.enter('205'), 'commit')
      expect(m.objects(LIB + 'earthsea', LIB + 'pages')).toEqual(['205|integer'])
      // Typing on a resource starts a statement; Down and Up highlight what the shapes expect, Enter takes it.
      each((x) => typeKey(x, x.label('lib:earthsea'), 'P'), 'typing on a resource')
      const input = () => m.field()!
      expect(input().value).toBe('P')
      expect(input().getAttribute('role')).toBe('combobox')
      const listbox = m.document.getElementById(input().getAttribute('aria-controls')!)!
      expect(listbox.getAttribute('role')).toBe('listbox')
      expect([...listbox.querySelectorAll('[role=option]')].map((o) => o.firstChild!.textContent)).toEqual(['lib:published', 'lib:pages'])
      each((x) => x.key(x.field()!, 'ArrowDown'), 'Down')
      expect(input().getAttribute('aria-activedescendant')).toBe(listbox.querySelector('[role=option]')!.id)
      expect(listbox.querySelector('[aria-selected=true]')!.firstChild!.textContent).toBe('lib:published')
      each((x) => x.key(x.field()!, 'ArrowDown'), 'Down again')
      each((x) => x.key(x.field()!, 'ArrowUp'), 'Up')
      each((x) => x.key(x.field()!, 'Enter'), 'Enter takes the predicate')
      expect(input().value).toBe('lib:published ')
      each((x) => x.enter(x.field()!.value + '"1968"^^xsd:gYear'), 'its value')
      expect(m.objects(LIB + 'earthsea', LIB + 'published')).toEqual(['1968|gYear'])
      // A right click opens the row's menu; its items do the editor's reactions; Escape closes it.
      each((x) => x.contextMenu(x.label('lib:dispossessed', 'lib:keywords', '( 3 )', '"physics"')), 'right click')
      const items = () => [...m.editor().querySelectorAll('[role=menu] [role=menuitem]')].map((b) => b.firstChild!.textContent)
      expect(items()).toEqual(['Edit', 'Add a statement', 'Move up', 'Move down', 'Delete'])
      expect(m.editor().querySelector('[role=menuitem]')!.getAttribute('aria-keyshortcuts')).toBe('Enter')
      each((x) => x.click([...x.editor().querySelectorAll('[role=menuitem]')].find((b) => b.firstChild!.textContent === 'Move up')!), 'Move up')
      expect(m.outline()).toContain('lib:keywords ( "physics" "anarchism" "utopia" )')
      expect(m.editor().querySelector('[role=menu]')).toBeNull()
      each((x) => x.key(x.label('lib:dispossessed', 'lib:pages'), 'F10', true), 'Shift+F10')
      expect(items()).toEqual(['Edit', 'Add a statement', 'Open in the Reference', 'Delete'])
      each((x) => x.key(x.editor().querySelector('[role=menuitem]')!, 'Escape'), 'Escape')
      expect(m.editor().querySelector('[role=menu]')).toBeNull()
    })
  }

  it('refuses a drop where the value would not conform, with the shape\'s reason', () => {
    const m = mount('oxigraph', 'sparql', FLUID)
    const k12 = (v: string) => md5(v).slice(0, 12)
    // Lift Earthsea's 183 (an integer) and carry it over Ursula's lib:born (dates only).
    const dragged = `${EDITOR}/~t-${k12(LIB + 'earthsea')}/~p-${k12(LIB + 'pages')}/~t-${k12('"183"^^http://www.w3.org/2001/XMLSchema#integer')}`
    m.bus.emit(NS.dnd + 'Start', dragged, { about: [] })
    m.dom.flush()
    const born = `${EDITOR}/~t-${k12(LIB + 'ursula')}/~p-${k12(LIB + 'born')}`
    const reception = (target: string) => {
      const r = m.store.match(null, m.nn(NS.dnd + 'receptacle'), m.nn(target)).map((q) => q.subject).find((x) => m.store.match(x, m.nn(NS.dnd + 'verdict'), null).length)
      return r && [m.store.match(r, m.nn(NS.dnd + 'verdict'), null)[0]!.object.value.replace(/^.*#/, ''), m.store.match(r, m.nn(NS.dnd + 'reason'), null)[0]?.object.value]
    }
    expect(reception(born)).toEqual(['Refused', 'born: expected date'])
    // Where it fits (another book's pages), it is accepted.
    expect(reception(`${EDITOR}/~t-${k12(LIB + 'dispossessed')}/~p-${k12(LIB + 'pages')}`)).toEqual(['Accepted', undefined])
  })
})
