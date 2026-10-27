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
  const key = (el: Element, k: string, shiftKey = false) => {
    const e = new window.Event('keydown', { bubbles: true, cancelable: true })
    Object.assign(e, { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey })
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
  const runs = (prefix: string) => [...screen.engine.stats.byRule].filter(([iri]) => iri.startsWith(C + prefix)).reduce((n, [, s]) => n + s.runs, 0)
  return { store, runtime, screen, dom, f, nn, editor, label, item, twisty, click, key, field, enter, objects, apply, outline, html, runs, document }
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
    expect(label('lib:dispossessed', 'lib:author', 'lib:ursula', '~ lib:authorship').getAttribute('aria-description')).toBe('said about this statement')
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
    expect(label('lib:dispossessed', 'lib:author', 'lib:ursula', '~ lib:authorship', 'lib:source', '<https://www.wikidata.org/wiki/Q1213434>').hasAttribute('data-sem-link')).toBe(false)
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
      // A click does not follow a link in an editor; Enter edits instead.
      each((x) => x.click(x.label('lib:earthsea', 'lib:author', 'lib:ursula')), 'a plain click')
      expect(m.store.match(m.nn(EDITOR), m.nn(C + 'current'), null).map((q) => q.object.value)).toEqual([LIB + 'dispossessed'])
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
      expect(m.field()!.getAttribute('aria-label')).toBe('New statement: predicate value')
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
})
