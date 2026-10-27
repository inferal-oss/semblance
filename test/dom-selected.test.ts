import { parseHTML } from 'linkedom'
import { Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { HtmlIndex } from '../src/render/html-index.ts'
import { toHTML } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'

const EX = 'https://example.org/selected#'
// A browser keeps selectedness separate from its content attribute after a user
// or property assignment dirties it. linkedom does not model that dirty flag, so
// isolate the live property here. This is a reflection regression, not native
// browser evidence; responsive/history acceptance needs an actual browser.
function dirtySelected(option: HTMLOptionElement) {
  let selected = option.hasAttribute('selected')
  const writes: boolean[] = []
  Object.defineProperty(option, 'selected', { configurable: true,
    get: () => selected,
    set: (value: boolean) => { selected = Boolean(value); writes.push(selected) },
  })
  return { writes, dirty(value: boolean) { selected = value } }
}

function direct(multiple: boolean, disabled: boolean) {
  const { document, window } = parseHTML('<html><body><main></main></body></html>')
  const index = new HtmlIndex(), root = EX + 'select'
  const parser = new Parser()
  const parse = (value: string) => parser.parse(`@prefix h: <${NS.rdfhtml}> . @prefix sem: <${NS.sem}> . @prefix ex: <${EX}> . ` + value)
  index.apply({ remove: [], add: parse(`ex:select a h:Select ; sem:renders ex:page ; h:hasChild ex:a, ex:b .
ex:a a h:Option ; h:value "a" ; h:selected "" . ex:b a h:Option ; h:value "b" .
${multiple ? 'ex:select h:multiple "" .' : ''} ${disabled ? 'ex:select h:disabled "" . ex:b h:disabled "" .' : ''}
<${EX}a> <${NS.ord}immediatelyPrecedes> <${EX}b> .`) })
  const renderer = new DomRenderer(index, document.querySelector('main')!, EX + 'page'); renderer.flush()
  const select = renderer.nodeOf(root) as HTMLSelectElement
  const options = [...select.querySelectorAll('option')] as HTMLOptionElement[]
  const live = options.map(dirtySelected)
  let selected = 'ex:a h:selected "" .'
  const change = (next: string) => { index.apply({ remove: parse(selected), add: parse(next) }); selected = next; renderer.flush() }
  return { renderer, index, select, options, live, change, window }
}

for (const [name, multiple, disabled] of [['single', false, false], ['multiple', true, false], ['disabled select and option', false, true]] as const) {
  it(`reflects selected additions/removals into original dirty options (${name})`, () => {
    const h = direct(multiple, disabled), original = [...h.options]
    let changes = 0
    h.select.addEventListener('change', () => changes++)
    h.live[0]!.dirty(true); h.live[1]!.dirty(false)
    h.change('ex:b h:selected "" .')
    expect(h.options.map(option => option.selected)).toEqual([false, true])
    expect(h.options.map(option => option.hasAttribute('selected'))).toEqual([false, true])
    expect([...h.select.querySelectorAll('option')]).toEqual(original)
    expect(h.live[0]!.writes).toContain(false)
    expect(h.live[1]!.writes).toContain(true)
    h.change('')
    expect(h.options[1]!.selected).toBe(false)
    expect(h.options[1]!.hasAttribute('selected')).toBe(false)
    expect(changes).toBe(0)
  })
}

it('keeps boolean attribute presence semantics and independent multiple selections', () => {
  const h = direct(true, false)
  h.change('ex:a h:selected "false" . ex:b h:selected "" .')
  expect(h.options.map(option => option.selected)).toEqual([true, true])
  h.change('ex:b h:selected "" .')
  expect(h.options.map(option => option.selected)).toEqual([false, true])
})

const graph = (disabled: boolean) => `@prefix ex: <${EX}> . @prefix c: <${NS.c}> .
ex:page a c:Stack ; c:children ( ex:choice ex:segmented ) .
ex:state ex:view ex:screen .
ex:choice a c:Choice ; c:label "View" ; c:controls ex:state ; c:property ex:view ; c:options ( ex:screen ex:monitor ) ; c:disabled ${disabled} .
ex:segmented a c:Segmented ; c:label "View" ; c:controls ex:state ; c:property ex:view ; c:options ( ex:screen ex:monitor ) ; c:compactAs c:Picker .
ex:screen c:label "Screen" . ex:monitor c:label "Monitor" .`

describe.each(['wat', 'oxigraph'] as const)('stock Choice and compact Segmented (%s)', kind => {
  for (const disabled of [false, true]) it(`keeps graph, attributes and dirty live selection aligned (disabled Choice=${disabled})`, () => {
    const histories: string[][] = []
    for (const prefer of ['sparql', 'function'] as const) {
      const store = loadStore(kind, graph(disabled)), runtime = new Runtime(store)
      const screen = runtime.project({ modality: MOD.Screen, prefer, layers: [STY.Layer], roots: [EX + 'page'] }, e => { throw e })
      const { document, window } = parseHTML('<html><body><main></main></body></html>')
      const renderer = new DomRenderer(screen.index, document.querySelector('main')!, EX + 'page'); renderer.flush()
      const bus = new EventBus(runtime, screen, { prefer }), detach = bus.attach(renderer, () => renderer.flush())
      try {
        const selects = [...document.querySelectorAll('select')] as HTMLSelectElement[]
        expect(selects).toHaveLength(2)
        const options = selects.map(select => [...select.querySelectorAll('option')] as HTMLOptionElement[])
        const live = options.map(list => list.map(dirtySelected))
        const f = store.factory
        const value = () => store.match(f.namedNode(EX + 'state'), f.namedNode(EX + 'view'), null)[0]?.object.value
        const snapshot = () => toHTML(screen.index, EX + 'page')
        const history = [snapshot()]
        Object.defineProperty(selects[0], 'value', { configurable: true, value: EX + 'monitor' })
        selects[0]!.dispatchEvent(new window.Event('change', { bubbles: true }))
        expect(value()).toBe(EX + (disabled ? 'screen' : 'monitor'))
        history.push(snapshot())
        // A desktop action changes the same graph while the native compact
        // picker is retained. Dirty properties must follow that graph change.
        const choose = (label: string) => {
          const button = [...document.querySelectorAll('button')].find(node => node.textContent === label)!
          button.dispatchEvent(new window.Event('click', { bubbles: true }))
        }
        choose('Screen')
        for (const states of live) { states[0]!.dirty(true); states[1]!.dirty(false) }
        choose('Monitor')
        expect(value()).toBe(EX + 'monitor')
        for (const list of options) {
          expect(list.map(option => option.selected)).toEqual([false, true])
          expect(list.map(option => option.hasAttribute('selected'))).toEqual([false, true])
        }
        expect([...document.querySelectorAll('select')]).toEqual(selects)
        history.push(snapshot()); histories.push(history)
      } finally { detach(); runtime.dispose(); store.dispose?.() }
    }
    expect(histories[0]).toEqual(histories[1])
  })
})
