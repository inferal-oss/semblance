import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { domPoint } from '../src/behaviour/text.ts'
import { memoryFileStore } from '../src/file-store.ts'
import { Files } from '../src/files.ts'
import { loadStore } from '../src/node/load.ts'
import { DEFAULT_LAYERS, MOD, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { sameHtml } from './same-html.ts'

// Editing block documents (ontology/components/block-editor.ttl), driven as a person types: the
// browser's selection, its beforeinput events with their target ranges, key presses. After every step
// the SPARQL rules and their function twins render the same HTML and text.

const EX = 'https://example.org/notes#'
const DOC = `
@prefix c: <${NS.c}> .
@prefix blk: <${NS.blk}> .
@prefix beh: <${NS.beh}> .
@prefix po: <${NS.po}> .
@prefix oa: <${NS.oa}> .
@prefix co: <${NS.co}> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix ex: <${EX}> .
ex:page a c:Stack ; c:children ( ex:editor ex:undo ex:redo ) .
ex:editor a c:BlockEditor ; c:label "Notes" ; c:of ex:doc ; c:editable true ; c:undoer ex:undo ; c:redoer ex:redo .
ex:undo a c:Button , beh:Undoer ; c:label "Undo" .
ex:redo a c:Button , beh:Redoer ; c:label "Redo" .
ex:doc a blk:Document ; po:contains ex:p1 , ex:p2 , ex:hr , ex:p3 .
ex:p1 a blk:Paragraph ; rdf:value "Hello world" ; blk:mark ex:p1-b ; co:nextItem ex:p2 .
ex:p1-b a blk:Strong ; oa:start 6 ; oa:end 11 .
ex:p2 a blk:Paragraph ; rdf:value "Second line" ; co:nextItem ex:hr .
ex:hr a blk:Divider ; co:nextItem ex:p3 .
ex:p3 a blk:Paragraph ; rdf:value "After the rule" .
`

/** A stand-in for the browser's Selection (linkedom has none). */
class FakeSelection {
  anchorNode: Node | null = null
  anchorOffset = 0
  focusNode: Node | null = null
  focusOffset = 0
  get rangeCount() {
    return this.anchorNode ? 1 : 0
  }
  get isCollapsed() {
    return this.anchorNode === this.focusNode && this.anchorOffset === this.focusOffset
  }
  setBaseAndExtent(a: Node, ao: number, f: Node, fo: number) {
    Object.assign(this, { anchorNode: a, anchorOffset: ao, focusNode: f, focusOffset: fo })
  }
  getRangeAt() {
    return { startContainer: this.anchorNode!, startOffset: this.anchorOffset, endContainer: this.focusNode!, endOffset: this.focusOffset }
  }
}

export function mount(prefer: 'sparql' | 'function', kind: 'wat' | 'oxigraph' = 'wat', extra = '') {
  const store = loadStore(kind, DOC + extra)
  const runtime = new Runtime(store)
  const fail = (e: Error) => {
    throw e
  }
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, prefer, name: 'screen', roots: [EX + 'page'] }, fail)
  const text = runtime.project({ modality: MOD.Text, layers: [], prefer, name: 'text', roots: [EX + 'editor'] }, fail)
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const selection = new FakeSelection()
  Object.assign(document, { getSelection: () => selection })
  const app = document.getElementById('app')!
  const renderer = new DomRenderer(screen.index, app, EX + 'page')
  renderer.flush()
  const bus = new EventBus(runtime, screen, { prefer })
  bus.attach(renderer, () => renderer.flush())
  const region = () => app.querySelector('[data-sem-text-root]')!
  Object.defineProperty(document, 'activeElement', { get: () => region(), configurable: true })
  const f = store.factory
  const value = (b: string) => store.match(f.namedNode(EX + b), f.namedNode(NS.rdf + 'value'), null)[0]?.object.value
  const objects = (s: string, p: string) => store.match(f.namedNode(s.startsWith('http') ? s : EX + s), f.namedNode(p), null).map((q) => q.object.value)
  const point = (b: string, offset: number) => domPoint(region(), { node: EX + b, offset })!
  /** Put the caret (or a selection) somewhere, as a click or the arrows would, and tell the page. */
  const select = (b: string, offset: number, b2 = b, offset2 = offset) => {
    const a = point(b, offset)
    const z = point(b2, offset2)
    selection.setBaseAndExtent(a.node, a.offset, z.node, z.offset)
    document.dispatchEvent(new window.Event('selectionchange'))
  }
  /** A beforeinput over the selection (its target range), as the browser sends one. */
  const input = (inputType: string, data?: string) => {
    const range = selection.getRangeAt()
    const e = Object.assign(new window.Event('beforeinput', { bubbles: true, cancelable: true }), { inputType, data: data ?? null, getTargetRanges: () => [range] })
    ;(selection.anchorNode!.parentElement ?? region()).dispatchEvent(e)
    return e
  }
  const type = (s: string) => {
    for (const ch of s) input('insertText', ch)
  }
  const press = (key: string, mods: Partial<KeyboardEvent> = {}) => {
    const e = new window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
    ;(selection.anchorNode!.parentElement ?? region()).dispatchEvent(e)
    return e
  }
  const click = (label: string) => [...app.querySelectorAll('button')].find((b) => b.textContent === label)!.dispatchEvent(new window.Event('click', { bubbles: true }))
  const caret = () => region().getAttribute('data-sem-text-root')
  const blocks = () => objects('doc', NS.po + 'contains')
  return { bus, renderer, store, runtime, screen, app, value, objects, select, input, type, press, click, caret, blocks, html: () => app.innerHTML, text: () => toText(text.index, EX + 'editor'), selection }
}

describe('editing block documents (c:BlockEditor)', () => {
  for (const kind of ['wat', 'oxigraph'] as const)
  it(`edits within and across blocks, with marks, shortcuts, undo and redo, the same with SPARQL and function rules (${kind})`, () => {
    const both = [mount('sparql', kind), mount('function', kind)] as const
    const [m] = both
    const step = (what: string, act: (h: ReturnType<typeof mount>) => void) => {
      for (const h of both) act(h)
      sameHtml(both[1].html(), both[0].html(), what)
      expect(both[1].text(), what).toBe(both[0].text())
    }
    expect(m.app.querySelector('[data-sem-text-root]')!.getAttribute('contenteditable')).toBe('true')

    step('typing in the middle of a block', (h) => {
      h.select('p1', 5)
      h.type(' there')
    })
    expect(m.value('p1')).toBe('Hello there world')
    // The bold "world" moved with the text before it.
    expect(m.objects('p1-b', NS.oa + 'start')).toEqual(['12'])
    expect(m.caret()).toBe(`${EX}p1 11 ${EX}p1 11`)

    step('typing at the end of a mark extends it', (h) => {
      h.select('p1', 17)
      h.type('s')
    })
    expect(m.objects('p1-b', NS.oa + 'end')).toEqual(['18'])

    step('deleting a selection', (h) => {
      h.select('p1', 5, 'p1', 11)
      h.input('deleteContentBackward')
    })
    expect(m.value('p1')).toBe('Hello worlds')

    step('Enter splits the block', (h) => {
      h.select('p1', 6)
      h.input('insertParagraph')
    })
    expect(m.value('p1')).toBe('Hello ')
    const split = m.objects('p1', NS.co + 'nextItem')[0]!
    expect(m.store.match(m.store.factory.namedNode(split), m.store.factory.namedNode(NS.rdf + 'value'), null)[0]!.object.value).toBe('worlds')
    expect(m.caret()).toBe(`${split} 0 ${split} 0`)

    step('Backspace at the start joins the block before', (h) => {
      const at = h.objects('p1', NS.co + 'nextItem')[0]!.slice(EX.length)
      h.select(at, 0)
      h.input('deleteContentBackward')
    })
    expect(m.value('p1')).toBe('Hello worlds')
    expect(m.objects('p1', NS.co + 'nextItem')).toEqual([EX + 'p2'])
    expect(m.objects('p1-b', NS.oa + 'start')).toEqual(['6'])

    step('"# " makes a heading', (h) => {
      h.select('p2', 0)
      h.type('# ')
    })
    expect(m.objects('p2', NS.rdf + 'type')).toEqual([NS.blk + 'Heading1'])
    expect(m.value('p2')).toBe('Second line')

    step('Enter at the end of a heading starts a paragraph', (h) => {
      h.select('p2', 11)
      h.input('insertParagraph')
    })
    const after = m.objects('p2', NS.co + 'nextItem')[0]!
    expect(m.objects(after, NS.rdf + 'type')).toEqual([NS.blk + 'Paragraph'])
    expect(m.value('p2')).toBe('Second line')

    step('Backspace in the empty paragraph joins it to the heading', (h) => {
      h.select(h.objects('p2', NS.co + 'nextItem')[0]!.slice(EX.length), 0)
      h.input('deleteContentBackward')
    })
    expect(m.objects('p2', NS.co + 'nextItem')).toEqual([EX + 'hr'])
    expect(m.caret()).toBe(`${EX}p2 11 ${EX}p2 11`)

    step('Backspace at the start of a heading makes it a paragraph', (h) => {
      h.select('p2', 0)
      h.input('deleteContentBackward')
    })
    expect(m.objects('p2', NS.rdf + 'type')).toEqual([NS.blk + 'Paragraph'])

    step('"- " makes a list', (h) => {
      h.select('p2', 0)
      h.type('- ')
    })
    const list = m.objects('doc', NS.po + 'contains').find((b) => m.objects(b, NS.rdf + 'type').includes(NS.blk + 'BulletedList'))!
    expect(m.objects(list, NS.po + 'contains')).toEqual([EX + 'p2'])
    expect(m.app.querySelector(`[id="${EX}p2/~root"]`)!.localName).toBe('li')

    step('Enter at the end of an item makes another', (h) => {
      h.select('p2', 11)
      h.input('insertParagraph')
    })
    expect(m.objects(list, NS.po + 'contains')).toHaveLength(2)

    step('Enter on an empty item leaves the list', (h) => {
      h.input('insertParagraph')
    })
    expect(m.objects(list, NS.po + 'contains')).toEqual([EX + 'p2'])
    const left = m.objects(list, NS.co + 'nextItem')[0]!
    expect(m.objects(left, NS.rdf + 'type')).toEqual([NS.blk + 'Paragraph'])

    step('**text** marks it bold', (h) => {
      h.select('p3', 14)
      h.type(' **bold**')
    })
    expect(m.value('p3')).toBe('After the rule bold')
    expect(m.app.querySelector(`[id="${EX}p3/~root"] strong`)!.textContent).toBe('bold')

    step('Mod+I italicizes the selection', (h) => {
      h.select('p3', 0, 'p3', 5)
      h.press('i', { ctrlKey: true })
    })
    expect(m.app.querySelector(`[id="${EX}p3/~root"] em`)!.textContent).toBe('After')

    step('Mod+I again takes it off', (h) => {
      h.press('i', { ctrlKey: true })
    })
    expect(m.app.querySelector(`[id="${EX}p3/~root"] em`)).toBeNull()

    step('deleting across blocks joins them', (h) => {
      h.select('p1', 5, 'p2', 6)
      h.input('deleteContentBackward')
    })
    expect(m.value('p1')).toBe('Hello line')
    expect(m.objects(list, NS.po + 'contains')).toEqual([])

    step('undo', (h) => h.click('Undo'))
    expect(m.value('p1')).toBe('Hello worlds')
    step('redo', (h) => h.click('Redo'))
    expect(m.value('p1')).toBe('Hello line')

    step('Backspace after a divider removes it', (h) => {
      h.select('p3', 0)
      h.input('deleteContentBackward')
    })
    expect(m.blocks()).not.toContain(EX + 'hr')

    step('Mod+Z undoes through the editor\'s undoer', (h) => {
      h.select('p3', 0)
      h.press('z', { ctrlKey: true })
    })
    expect(m.blocks()).toContain(EX + 'hr')
    step('Mod+Shift+Z redoes', (h) => h.press('z', { ctrlKey: true, shiftKey: true }))
    expect(m.blocks()).not.toContain(EX + 'hr')
  })

  it('checks off a to-do and opens a toggle by their controls', () => {
    const extra = `
<${EX}doc> <${NS.po}contains> <${EX}todo> , <${EX}toggle> .
<${EX}p3> <${NS.co}nextItem> <${EX}todos> .
<${EX}todos> a <${NS.blk}TodoList> ; <${NS.po}contains> <${EX}todo> ; <${NS.co}nextItem> <${EX}toggle> .
<${EX}doc> <${NS.po}contains> <${EX}todos> .
<${EX}todo> a <${NS.blk}TodoItem> ; <${NS.rdf}value> "Ship" .
<${EX}toggle> a <${NS.blk}Toggle> ; <${NS.rdf}value> "More" ; <${NS.po}contains> <${EX}inside> .
<${EX}inside> a <${NS.blk}Paragraph> ; <${NS.rdf}value> "Inside" .`.replace(`<${EX}doc> <${NS.po}contains> <${EX}todo> , <${EX}toggle> .`, `<${EX}doc> <${NS.po}contains> <${EX}toggle> .`)
    const h = mount('sparql', 'wat', extra)
    const check = h.app.querySelector(`[id="${EX}todo/~root"] input`) as HTMLInputElement
    check.dispatchEvent(new (check.ownerDocument.defaultView!.Event)('click', { bubbles: true }))
    expect(h.objects('todo', NS.blk + 'checked')).toEqual(['true'])
    expect(h.app.querySelector(`[id="${EX}todo/~root"]`)!.getAttribute('data-sem-done')).toBe('true')
    const twisty = h.app.querySelector(`[id="${EX}toggle/~root"] button`)!
    expect(twisty.getAttribute('aria-expanded')).toBe('false')
    twisty.dispatchEvent(new (twisty.ownerDocument.defaultView!.Event)('click', { bubbles: true }))
    expect(h.app.querySelector(`[id="${EX}toggle/~root"] button`)!.getAttribute('aria-expanded')).toBe('true')
    expect(h.app.querySelector(`[id="${EX}toggle/~children"]`)!.hasAttribute('hidden')).toBe(false)
  })

  it('records what a composition typed once it ends, and renders the block from the graph again', () => {
    const h = mount('sparql')
    h.select('p2', 6)
    const target = h.selection.anchorNode!.parentElement!
    const win = target.ownerDocument.defaultView!
    target.dispatchEvent(new win.Event('compositionstart', { bubbles: true }))
    // The browser edits the text itself while composing.
    const node = h.selection.anchorNode as Text
    node.data = 'Second ありがとう line'
    target.dispatchEvent(new win.Event('compositionend', { bubbles: true }))
    expect(h.value('p2')).toBe('Second ありがとう line')
    expect(h.app.querySelector(`[id="${EX}p2/~text"]`)!.textContent).toBe('Second ありがとう line')
  })
})

describe('the cost of typing in a block (c:BlockEditor)', () => {
  /** A document of `n` more paragraphs after the editor's own, in its chain. */
  const longer = (n: number) => {
    const ex = (i: number) => `<${EX}more-${i}>`
    const lines = [`<${EX}p3> <${NS.co}nextItem> ${ex(0)} .`]
    for (let i = 0; i < n; i++) {
      lines.push(`<${EX}doc> <${NS.po}contains> ${ex(i)} .`, `${ex(i)} a <${NS.blk}Paragraph> ; <${NS.rdf}value> "Paragraph ${i} of a long document." .`)
      if (i + 1 < n) lines.push(`${ex(i)} <${NS.co}nextItem> ${ex(i + 1)} .`)
    }
    return lines.join('\n')
  }
  const keystroke = (n: number, prefer: 'sparql' | 'function') => {
    const h = mount(prefer, 'wat', longer(n))
    h.select('p1', 5)
    h.type('a')
    const stats = h.screen.engine.stats
    const before = { runs: stats.ruleRuns, written: stats.derivedAdded + stats.derivedRemoved, dom: h.renderer.ops }
    h.type('b')
    return { runs: stats.ruleRuns - before.runs, written: stats.derivedAdded + stats.derivedRemoved - before.written, dom: h.renderer.ops - before.dom }
  }
  for (const prefer of ['sparql', 'function'] as const) {
    it(`costs the same in a document of three thousand blocks as in one of four (${prefer})`, () => {
      const short = keystroke(0, prefer)
      const long = keystroke(3000, prefer)
      expect(long).toEqual(short)
      expect(short.runs).toBeLessThanOrEqual(8)
    })
  }
})

describe('the / menu (c:BlockEditor)', () => {
  it('opens at a "/", filters as one types, moves by key and turns the block into what is picked, the same with SPARQL and function rules', () => {
    const both = [mount('sparql'), mount('function')] as const
    const [m] = both
    const step = (what: string, act: (h: ReturnType<typeof mount>) => void) => {
      for (const h of both) act(h)
      sameHtml(both[1].html(), both[0].html(), what)
    }
    const menu = () => m.app.querySelector('.sem-block-menu')
    const shown = () => [...m.app.querySelectorAll('.sem-block-menu [role=option]:not([hidden])')].map((o) => o.querySelector('.sem-ta-label')!.textContent)
    const active = () => m.app.querySelector('.sem-block-menu [aria-selected=true] .sem-ta-label')?.textContent

    step('Enter at the end of the first block makes an empty one', (h) => {
      h.select('p1', 11)
      h.input('insertParagraph')
    })
    const empty = m.objects('p1', NS.co + 'nextItem')[0]!
    step('"/" opens the menu', (h) => h.type('/'))
    expect(menu()).not.toBeNull()
    expect(menu()!.getAttribute('data-sem-anchor')).toBe(`${empty}/~root`)
    expect(shown()[0]).toBe('Text')
    expect(shown()).toContain('Heading 1')
    expect(active()).toBe('Text')
    const region = m.app.querySelector('[data-sem-text-root]')!
    expect(region.getAttribute('aria-expanded')).toBe('true')
    expect(region.getAttribute('aria-activedescendant')).toBe(`${EX}editor/~opt-${encodeURIComponent(NS.blk + 'Paragraph')}/~root`)

    step('typing filters it', (h) => h.type('head'))
    // The table of contents is found by its keyword "headings".
    expect(shown()).toEqual(['Heading 1', 'Heading 2', 'Heading 3', 'Table of contents'])
    expect(m.app.querySelector('.sem-block-menu mark')!.textContent).toBe('Head')
    step('Down moves to the next', (h) => h.press('ArrowDown'))
    expect(active()).toBe('Heading 2')
    step('Up moves back', (h) => h.press('ArrowUp'))
    step('Up again goes round to the last', (h) => h.press('ArrowUp'))
    expect(active()).toBe('Table of contents')
    step('and Up once more', (h) => h.press('ArrowUp'))
    expect(active()).toBe('Heading 3')
    step('Enter picks it: the block becomes one, without the "/head"', (h) => h.press('Enter'))
    expect(m.objects(empty, NS.rdf + 'type')).toEqual([NS.blk + 'Heading3'])
    expect(m.store.match(m.store.factory.namedNode(empty), m.store.factory.namedNode(NS.rdf + 'value'), null)[0]!.object.value).toBe('')
    expect(menu()).toBeNull()

    step('a type that is not text goes above the empty line', (h) => {
      h.type('/divi')
      h.press('Enter')
    })
    const before = m.store.match(null, m.store.factory.namedNode(NS.co + 'nextItem'), m.store.factory.namedNode(empty))[0]!.subject.value
    expect(m.objects(before, NS.rdf + 'type')).toEqual([NS.blk + 'Divider'])

    step('a table comes with its rows and cells', (h) => {
      h.type('/table')
      h.press('Enter')
    })
    const table = m.store.match(null, m.store.factory.namedNode(NS.co + 'nextItem'), m.store.factory.namedNode(empty))[0]!.subject.value
    expect(m.app.querySelectorAll(`[id="${table}/~root"] th`)).toHaveLength(2)
    expect(m.app.querySelectorAll(`[id="${table}/~root"] td`)).toHaveLength(2)

    step('a list type makes the empty block its only item', (h) => {
      h.type('/todo')
      h.press('Enter')
    })
    expect(m.objects(empty, NS.rdf + 'type')).toEqual([NS.blk + 'TodoItem'])

    step('Escape closes it, the text stays', (h) => {
      h.type(' /quo')
      h.press('Escape')
    })
    expect(menu()).toBeNull()
    expect(m.store.match(m.store.factory.namedNode(empty), m.store.factory.namedNode(NS.rdf + 'value'), null)[0]!.object.value).toBe(' /quo')
  })
})

describe('nesting and moving blocks (c:BlockEditor)', () => {
  const extra = `
<${EX}p3> <${NS.co}nextItem> <${EX}list> .
<${EX}doc> <${NS.po}contains> <${EX}list> , <${EX}tog> , <${EX}after> .
<${EX}list> a <${NS.blk}BulletedList> ; <${NS.po}contains> <${EX}i1> , <${EX}i2> , <${EX}i3> ; <${NS.co}nextItem> <${EX}tog> .
<${EX}i1> a <${NS.blk}ListItem> ; <${NS.rdf}value> "One" ; <${NS.co}nextItem> <${EX}i2> .
<${EX}i2> a <${NS.blk}ListItem> ; <${NS.rdf}value> "Two" ; <${NS.co}nextItem> <${EX}i3> .
<${EX}i3> a <${NS.blk}ListItem> ; <${NS.rdf}value> "Three" .
<${EX}tog> a <${NS.blk}Toggle> ; <${NS.rdf}value> "More" ; <${NS.c}expanded> true ; <${NS.co}nextItem> <${EX}after> .
<${EX}after> a <${NS.blk}Paragraph> ; <${NS.rdf}value> "After" .`

  it('nests by Tab, takes out by Shift+Tab and moves by Alt+arrows, the same with SPARQL and function rules', () => {
    const both = [mount('sparql', 'wat', extra), mount('function', 'wat', extra)] as const
    const [m] = both
    const step = (what: string, act: (h: ReturnType<typeof mount>) => void) => {
      for (const h of both) act(h)
      sameHtml(both[1].html(), both[0].html(), what)
      expect(both[1].text(), what).toBe(both[0].text())
    }
    step('Tab nests an item in the one before it', (h) => {
      h.select('i2', 0)
      h.press('Tab')
    })
    const nested = m.objects('i1', NS.po + 'contains')[0]!
    expect(m.objects(nested, NS.po + 'contains')).toEqual([EX + 'i2'])
    expect(m.objects('i1', NS.co + 'nextItem')).toEqual([EX + 'i3'])
    expect(m.text()).toContain('  - Two')
    step('Tab on the next joins that nested list', (h) => {
      h.select('i3', 0)
      h.press('Tab')
    })
    expect(m.objects(nested, NS.po + 'contains').sort()).toEqual([EX + 'i2', EX + 'i3'])
    expect(m.objects('i2', NS.co + 'nextItem')).toEqual([EX + 'i3'])
    step('Shift+Tab takes it out again', (h) => {
      h.select('i3', 0)
      h.press('Tab', { shiftKey: true })
    })
    expect(m.objects('i1', NS.co + 'nextItem')).toEqual([EX + 'i3'])
    step('Tab puts a paragraph into the toggle before it', (h) => {
      h.select('after', 0)
      h.press('Tab')
    })
    expect(m.objects('tog', NS.po + 'contains')).toEqual([EX + 'after'])
    step('Shift+Tab takes it out', (h) => {
      h.select('after', 0)
      h.press('Tab', { shiftKey: true })
    })
    expect(m.objects('tog', NS.co + 'nextItem')).toEqual([EX + 'after'])
    step('Alt+Up moves a block up', (h) => {
      h.select('tog', 0)
      h.press('ArrowUp', { altKey: true })
    })
    expect(m.objects('p3', NS.co + 'nextItem')).toEqual([EX + 'tog'])
    expect(m.objects('tog', NS.co + 'nextItem')).toEqual([EX + 'list'])
    step('Alt+Down moves it back', (h) => {
      h.select('tog', 0)
      h.press('ArrowDown', { altKey: true })
    })
    expect(m.objects('list', NS.co + 'nextItem')).toEqual([EX + 'tog'])
  })

  it('lets Tab move the focus on where nothing can nest', () => {
    const h = mount('sparql', 'wat', extra)
    h.select('p1', 0)
    const e = h.press('Tab')
    expect(e.defaultPrevented).toBe(false)
  })
})

describe('pasting into a block (c:BlockEditor)', () => {
  it('inserts pasted plain text where the selection is, as typing does', () => {
    const h = mount('sparql')
    h.select('p2', 7, 'p2', 11)
    const range = h.selection.getRangeAt()
    const target = h.selection.anchorNode!.parentElement!
    const e = Object.assign(new (target.ownerDocument.defaultView!.Event)('beforeinput', { bubbles: true, cancelable: true }), {
      inputType: 'insertFromPaste',
      data: null,
      dataTransfer: { getData: (type: string) => (type === 'text/plain' ? 'paste' : '') },
      getTargetRanges: () => [range],
    })
    target.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(h.value('p2')).toBe('Second paste')
    expect(h.caret()).toBe(`${EX}p2 12 ${EX}p2 12`)
  })
})

describe('the selection toolbar and links (c:BlockEditor)', () => {
  it('marks the selection by its buttons, makes it a link and edits the address, the same with SPARQL and function rules', () => {
    const both = [mount('sparql'), mount('function')] as const
    const [m] = both
    const step = (what: string, act: (h: ReturnType<typeof mount>) => void) => {
      for (const h of both) act(h)
      sameHtml(both[1].html(), both[0].html(), what)
    }
    const button = (h: ReturnType<typeof mount>, local: string) => [...h.app.querySelectorAll('.sem-text-toolbar button')].find((b) => h.renderer.keyOf(b) === `${EX}editor/~tb-${local}`)!
    step('a selection shows the toolbar', (h) => h.select('p2', 0, 'p2', 6))
    expect(m.app.querySelector('.sem-text-toolbar')!.getAttribute('data-sem-anchor')).toBe(`${EX}p2/~root`)
    expect(button(m, 'strong').getAttribute('aria-pressed')).toBe('false')
    step('B makes it bold', (h) => button(h, 'strong').dispatchEvent(new (h.app.ownerDocument.defaultView!.Event)('click', { bubbles: true })))
    expect(m.app.querySelector(`[id="${EX}p2/~root"] strong`)!.textContent).toBe('Second')
    expect(button(m, 'strong').getAttribute('aria-pressed')).toBe('true')
    step('the link button makes it a link to https://', (h) => button(h, 'link').dispatchEvent(new (h.app.ownerDocument.defaultView!.Event)('click', { bubbles: true })))
    const field = () => m.app.querySelector('.sem-text-toolbar input') as HTMLInputElement
    expect(field().value).toBe('https://')
    step('typing in the address field edits it', (h) => {
      const input = h.app.querySelector('.sem-text-toolbar input') as HTMLInputElement
      input.value = 'https://semblance.dev'
      input.dispatchEvent(new (h.app.ownerDocument.defaultView!.Event)('input', { bubbles: true }))
    })
    expect(m.app.querySelector(`[id="${EX}p2/~root"] a`)!.getAttribute('href')).toBe('https://semblance.dev')
    step('remove takes the link off', (h) => {
      const remove = [...h.app.querySelectorAll('.sem-text-toolbar button')].find((b) => h.renderer.keyOf(b) === `${EX}editor/~link-remove`)!
      remove.dispatchEvent(new (h.app.ownerDocument.defaultView!.Event)('click', { bubbles: true }))
    })
    expect(m.app.querySelector(`[id="${EX}p2/~root"] a`)).toBeNull()
  })

  it('makes a link by Mod+K', () => {
    const h = mount('sparql')
    h.select('p2', 7, 'p2', 11)
    h.press('k', { ctrlKey: true })
    expect(h.app.querySelector(`[id="${EX}p2/~root"] a`)!.textContent).toBe('line')
  })

  it('starts a new line by Enter in code', () => {
    const extra = `<${EX}doc> <${NS.po}contains> <${EX}code> . <${EX}p3> <${NS.co}nextItem> <${EX}code> . <${EX}code> a <${NS.blk}Code> ; <${NS.rdf}value> "a = 1" .`
    const h = mount('sparql', 'wat', extra)
    h.select('code', 5)
    h.input('insertParagraph')
    h.type('b')
    expect(h.value('code')).toBe('a = 1\nb')
  })
})

describe('addresses and site types (c:BlockEditor)', () => {
  it('links an image by typing its address', () => {
    const extra = `<${EX}doc> <${NS.po}contains> <${EX}img> . <${EX}p3> <${NS.co}nextItem> <${EX}img> . <${EX}img> a <${NS.blk}Image> .`
    const h = mount('sparql', 'wat', extra)
    const field = h.app.querySelector(`[id="${EX}img/~root"] .sem-address-field`) as HTMLInputElement
    expect(field.value).toBe('')
    field.value = 'https://semblance.dev/favicon.svg'
    field.dispatchEvent(new (h.app.ownerDocument.defaultView!.Event)('input', { bubbles: true }))
    expect(h.objects('img', NS.schema + 'contentUrl')).toEqual(['https://semblance.dev/favicon.svg'])
    expect(h.app.querySelector(`[id="${EX}img/~root"] img`)!.getAttribute('src')).toBe('https://semblance.dev/favicon.svg')
  })

  it('follows a site\'s paragraph-like type with a paragraph on Enter', () => {
    const extra = `<${EX}Key> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${NS.blk}Paragraph> .
<${EX}doc> <${NS.po}contains> <${EX}kp> . <${EX}p3> <${NS.co}nextItem> <${EX}kp> .
<${EX}kp> a <${EX}Key> ; <${NS.rdf}value> "Key" .`
    const h = mount('sparql', 'wat', extra)
    h.select('kp', 3)
    h.input('insertParagraph')
    const next = h.objects('kp', NS.co + 'nextItem')[0]!
    expect(h.objects(next, NS.rdf + 'type')).toEqual([NS.blk + 'Paragraph'])
  })
})

describe('tables (c:BlockEditor)', () => {
  const extra = `
<${EX}doc> <${NS.po}contains> <${EX}t> . <${EX}p3> <${NS.co}nextItem> <${EX}t> .
<${EX}t> a <${NS.blk}Table> ; <${NS.po}contains> <${EX}r1> , <${EX}r2> .
<${EX}r1> a <${NS.blk}Row> ; <${NS.po}contains> <${EX}a1> , <${EX}b1> ; <${NS.co}nextItem> <${EX}r2> .
<${EX}a1> a <${NS.blk}Cell> ; <${NS.rdf}value> "a1" ; <${NS.co}nextItem> <${EX}b1> .
<${EX}b1> a <${NS.blk}Cell> ; <${NS.rdf}value> "b1" .
<${EX}r2> a <${NS.blk}Row> ; <${NS.po}contains> <${EX}a2> , <${EX}b2> .
<${EX}a2> a <${NS.blk}Cell> ; <${NS.rdf}value> "a2" ; <${NS.co}nextItem> <${EX}b2> .
<${EX}b2> a <${NS.blk}Cell> ; <${NS.rdf}value> "b2" .`

  it('moves between cells by Tab, and adds and removes rows and columns, the same with SPARQL and function rules', () => {
    const both = [mount('sparql', 'wat', extra), mount('function', 'wat', extra)] as const
    const [m] = both
    const step = (what: string, act: (h: ReturnType<typeof mount>) => void) => {
      for (const h of both) act(h)
      sameHtml(both[1].html(), both[0].html(), what)
      expect(both[1].text(), what).toBe(both[0].text())
    }
    const tool = (h: ReturnType<typeof mount>, local: string) =>
      [...h.app.querySelectorAll('.sem-table-tools button')].find((b) => h.renderer.keyOf(b) === `${EX}editor/~tt-${local}`)!.dispatchEvent(new (h.app.ownerDocument.defaultView!.Event)('click', { bubbles: true }))
    const grid = () => [...m.app.querySelectorAll(`[id="${EX}t/~root"] tr`)].map((tr) => [...tr.children].map((c) => c.textContent))
    step('Tab goes to the next cell', (h) => {
      h.select('a1', 2)
      h.press('Tab')
    })
    expect(m.caret()).toBe(`${EX}b1 0 ${EX}b1 0`)
    expect(m.app.querySelector('.sem-table-tools')!.getAttribute('data-sem-anchor')).toBe(`${EX}t/~root`)
    step('Tab at the end of a row goes to the next', (h) => h.press('Tab'))
    expect(m.caret()).toBe(`${EX}a2 0 ${EX}a2 0`)
    step('Shift+Tab goes back to the end of the cell before', (h) => h.press('Tab', { shiftKey: true }))
    expect(m.caret()).toBe(`${EX}b1 2 ${EX}b1 2`)
    step('Tab past the last cell adds a row', (h) => {
      h.select('b2', 2)
      h.press('Tab')
    })
    expect(grid()).toEqual([['a1', 'b1'], ['a2', 'b2'], ['', '']])
    step('a column after', (h) => {
      h.select('a1', 0)
      tool(h, 'column-after')
    })
    expect(grid()).toEqual([['a1', '', 'b1'], ['a2', '', 'b2'], ['', '', '']])
    step('a row above', (h) => tool(h, 'row-above'))
    expect(grid()).toEqual([['', '', ''], ['a1', '', 'b1'], ['a2', '', 'b2'], ['', '', '']])
    step('remove the column', (h) => tool(h, 'remove-column'))
    expect(grid()).toEqual([['', ''], ['', 'b1'], ['', 'b2'], ['', '']])
    step('remove the row', (h) => {
      h.select('b2', 0)
      tool(h, 'remove-row')
    })
    expect(grid()).toEqual([['', ''], ['', 'b1'], ['', '']])
  })
})

describe('nesting by shapes (c:BlockEditor)', () => {
  it('puts a paragraph after a list into its last item, and none into a table, whose shape takes rows only', () => {
    const extra = `
<${EX}doc> <${NS.po}contains> <${EX}l> , <${EX}x> , <${EX}t> , <${EX}y> . <${EX}p3> <${NS.co}nextItem> <${EX}l> .
<${EX}l> a <${NS.blk}BulletedList> ; <${NS.po}contains> <${EX}li> ; <${NS.co}nextItem> <${EX}x> .
<${EX}li> a <${NS.blk}ListItem> ; <${NS.rdf}value> "Item" .
<${EX}x> a <${NS.blk}Paragraph> ; <${NS.rdf}value> "More about the item" ; <${NS.co}nextItem> <${EX}t> .
<${EX}t> a <${NS.blk}Table> ; <${NS.po}contains> <${EX}r> ; <${NS.co}nextItem> <${EX}y> .
<${EX}r> a <${NS.blk}Row> ; <${NS.po}contains> <${EX}c> .
<${EX}c> a <${NS.blk}Cell> ; <${NS.rdf}value> "c" .
<${EX}y> a <${NS.blk}Paragraph> ; <${NS.rdf}value> "After the table" .`
    const h = mount('sparql', 'wat', extra)
    h.select('x', 0)
    h.press('Tab')
    expect(h.objects('li', NS.po + 'contains')).toEqual([EX + 'x'])
    expect(h.app.querySelector(`[id="${EX}li/~root"] .sem-children [id="${EX}x/~root"]`)).not.toBeNull()
    h.select('y', 0)
    const e = h.press('Tab')
    expect(h.objects('t', NS.po + 'contains')).toEqual([EX + 'r'])
    expect(e.defaultPrevented).toBe(false)
  })
})

describe('uploads (c:BlockEditor)', () => {
  it('asks for the picker by Upload…, and shows the latest file the block took', () => {
    const FILE = 'https://semblance.dev/ns/file#'
    const extra = `<${EX}doc> <${NS.po}contains> <${EX}img> . <${EX}p3> <${NS.co}nextItem> <${EX}img> .
<${EX}img> a <${NS.blk}Image> ; <${FILE}accept> "image/*" ; <${NS.blk}file> <${EX}f1> , <${EX}f2> .
<${EX}f1> a <${FILE}File> ; <${NS.sem}order> 1 ; <${FILE}url> "blob:old" .
<${EX}f2> a <${FILE}File> ; <${NS.sem}order> 2 ; <${FILE}url> "blob:new" .`
    for (const prefer of ['sparql', 'function'] as const) {
      const h = mount(prefer, 'wat', extra)
      expect(h.app.querySelector(`[id="${EX}img/~root"] img`)!.getAttribute('src')).toBe('blob:new')
      const upload = h.app.querySelector(`[id="${EX}img/~root"] .sem-upload`)!
      upload.dispatchEvent(new (h.app.ownerDocument.defaultView!.Event)('click', { bubbles: true }))
      const picks = h.store.match(null, h.store.factory.namedNode(FILE + 'requestedBy'), h.store.factory.namedNode(EX + 'img'))
      expect(picks).toHaveLength(1)
      expect(h.store.match(picks[0]!.subject, h.store.factory.namedNode(FILE + 'accept'), null)[0]!.object.value).toBe('image/*')
    }
  })
})

describe('pasting files (c:BlockEditor)', () => {
  it('makes a pasted image an image block after the caret\'s block, and a pasted file a file block', async () => {
    const FILE = 'https://semblance.dev/ns/file#'
    for (const prefer of ['sparql', 'function'] as const) {
      const h = mount(prefer, 'wat', `<${EX}editor> <${FILE}keepIn> <${NS.blk}Uploads> .`)
      const files = new Files(h.bus, { keep: memoryFileStore() })
      const off = files.attach(h.renderer)
      const paste = (name: string, type: string) => {
        const e = Object.assign(new (h.app.ownerDocument.defaultView!.Event)('paste', { bubbles: true, cancelable: true }), {
          clipboardData: { files: [{ name, type, size: 3, lastModified: 0 }] },
        })
        h.selection.anchorNode!.parentElement!.dispatchEvent(e)
        h.renderer.flush()
        return e
      }
      h.select('p2', 3)
      expect(paste('shot.png', 'image/png').defaultPrevented).toBe(true)
      const after = h.objects('p2', NS.co + 'nextItem')[0]!
      expect(h.objects(after, NS.rdf + 'type')).toContain(NS.blk + 'Image')
      expect(h.objects(after, NS.co + 'nextItem')).toEqual([EX + 'hr'])
      const kept = h.objects(after, NS.blk + 'file')
      expect(kept).toHaveLength(1)
      paste('notes.pdf', 'application/pdf')
      const second = h.objects('p2', NS.co + 'nextItem')[0]!
      expect(h.objects(second, NS.rdf + 'type')).toContain(NS.blk + 'File')
      expect(h.objects(second, NS.co + 'nextItem')).toEqual([after])
      await files.ready
      off()
    }
  })
})

describe('formulas and code (c:BlockEditor)', () => {
  const extra = `<${EX}doc> <${NS.po}contains> <${EX}m> , <${EX}code> . <${EX}p3> <${NS.co}nextItem> <${EX}m> . <${EX}m> <${NS.co}nextItem> <${EX}code> .
<${EX}m> a <${NS.blk}Math> ; <${NS.rdf}value> "x^2" .
<${EX}code> a <${NS.blk}Code> ; <${NS.rdf}value> "let a = 1" .`

  it('marks a block entered while the caret is in it (its sources show only then)', () => {
    const both = [mount('sparql', 'wat', extra), mount('function', 'wat', extra)] as const
    const folded = (h: (typeof both)[number]) => !h.app.querySelector(`[id="${EX}m/~root"]`)!.hasAttribute('data-sem-entered')
    for (const h of both) expect(folded(h)).toBe(true)
    for (const h of both) h.select('m', 1)
    for (const h of both) expect(folded(h)).toBe(false)
    sameHtml(both[1].html(), both[0].html(), "after the step")
    for (const h of both) h.select('p1', 0)
    for (const h of both) expect(folded(h)).toBe(true)
    sameHtml(both[1].html(), both[0].html(), "after the step")
  })

  it('enters an atom with an address by a click on it', () => {
    const more = extra + `\n<${EX}doc> <${NS.po}contains> <${EX}img> . <${EX}code> <${NS.co}nextItem> <${EX}img> . <${EX}img> a <${NS.blk}Image> ; <${NS.schema}contentUrl> "/a.png" .`
    const both = [mount('sparql', 'wat', more), mount('function', 'wat', more)] as const
    for (const h of both) {
      const root = h.app.querySelector(`[id="${EX}img/~root"]`)!
      expect(root.getAttribute('contenteditable')).toBe('false')
      expect(root.hasAttribute('data-sem-entered')).toBe(false)
      root.querySelector('img')!.dispatchEvent(new (h.app.ownerDocument.defaultView!.Event)('click', { bubbles: true }))
      expect(h.app.querySelector(`[id="${EX}img/~root"]`)!.hasAttribute('data-sem-entered')).toBe(true)
      expect(h.caret()).toBe(`${EX}img 0 ${EX}img 0`)
    }
    sameHtml(both[1].html(), both[0].html(), 'entered')
  })

  it('moves a caret put on the typeset formula into its TeX', () => {
    const h = mount('sparql', 'wat', extra)
    const typeset = h.app.querySelector(`[id="${EX}m/~root"] [data-sem-c=blk-typeset]`)!
    expect(typeset.getAttribute('contenteditable')).toBe('false')
    h.selection.setBaseAndExtent(typeset, 0, typeset, 0)
    h.app.ownerDocument.dispatchEvent(new (h.app.ownerDocument.defaultView!.Event)('selectionchange'))
    expect(h.caret()).toBe(`${EX}m 0 ${EX}m 0`)
    expect(h.selection.anchorNode!.parentElement!.closest('[data-sem-text]')!.getAttribute('data-sem-text')).toBe(EX + 'm')
  })

  it('sets a code block\'s language by typing it or picking an offered one', () => {
    const both = [mount('sparql', 'wat', extra), mount('function', 'wat', extra)] as const
    for (const h of both) {
      const field = h.app.querySelector(`[id="${EX}code/~root"] .sem-language-field`) as HTMLInputElement
      expect(field.value).toBe('')
      const list = h.app.querySelector(`[id="${field.getAttribute('list')}"]`)!
      expect([...list.querySelectorAll('option')].map((x) => x.getAttribute('value'))).toContain('turtle')
      field.value = 'turtle'
      field.dispatchEvent(new (h.app.ownerDocument.defaultView!.Event)('input', { bubbles: true }))
      expect(h.objects('code', NS.schema + 'programmingLanguage')).toEqual(['turtle'])
      expect(h.app.querySelector(`[id="${EX}code/~root"] code`)!.getAttribute('data-language')).toBe('turtle')
    }
    sameHtml(both[1].html(), both[0].html(), "after the step")
  })
})
