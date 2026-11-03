import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { domPoint } from '../src/behaviour/text.ts'
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
      expect(short.runs).toBeLessThanOrEqual(6)
    })
  }
})
