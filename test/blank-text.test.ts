// Text of only white space is no text: a required field says so, and nothing is made of it (#339).
// Driven through events on the site, asserting the DOM and the graph, by SPARQL and by function.
import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import type { StoreKind } from '../src/node/load.ts'
import { isBlank } from '../src/components/util.ts'
import { mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const KB = 'https://semblance.dev/demo/kanban#'
const CF = 'https://semblance.dev/demo/coffee#'
const PF = 'https://semblance.dev/demo/profile#'
const EX = 'https://example.org/todo#'
const C = NS.c

// The default engine and the function twins throughout; the SPARQL on Oxigraph for the Kanban board.
const WAYS: [StoreKind, 'sparql' | 'function'][] = [['wat', 'sparql'], ['oxigraph', 'function']]
// Spaces, and the white space an engine's own \s may not count: no-break and ideographic spaces.
const BLANKS = ['   ', '\u00A0\u00A0', '\u3000', ' \u2003 ']

/** An example of the site, reached as a visitor reaches it, with what its tests need. */
function example(name: string, kind: StoreKind, prefer: 'sparql' | 'function') {
  const h = mountSite(kind, prefer)
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const fire = (el: Element, type: string) => {
    h.fire(el, type)
    h.shell.flush()
  }
  const all = (selector: string) => [...h.document.querySelectorAll(selector)]
  fire(all('button').find((b) => b.textContent!.trim() === 'Examples' && visible(b))!, 'click')
  fire(all('[data-sem-c=nav-list] button').find((b) => b.textContent!.trim().startsWith(name) && visible(b))!, 'click')
  const root = (local: string) => h.shell.nodeOf(`${UI}${local}/~root`) as HTMLElement
  const input = (local: string) => root(local).querySelector('input, textarea') as HTMLInputElement
  const type = (el: HTMLInputElement, text: string) => {
    el.value = text
    fire(el, 'input')
  }
  const f = h.store.factory
  const subjects = (p: string, o: string) => h.store.match(null, f.namedNode(p), f.namedNode(o)).map((q) => q.subject.value)
  const objects = (s: string, p: string) => h.store.match(f.namedNode(s), f.namedNode(p), null).map((q) => q.object.value)
  /** What a field says: invalid in the graph, on its control, and in its own words. */
  const says = (node: string, el: HTMLInputElement, owner: Element) => ({
    invalid: objects(node, NS.val + 'invalid'),
    aria: el.getAttribute('aria-invalid'),
    alert: owner.querySelector('[role=alert]')?.textContent,
  })
  return { ...h, all, visible, fire, root, input, type, subjects, objects, says }
}

describe('text of only white space is no text', () => {
  it('blank is the same list as the SPARQL rules', () => {
    for (const text of ['', ...BLANKS, '\t\n\r']) expect(isBlank(text)).toBe(true)
    for (const text of ['a', ' a ', '\u00A0a', 'ا']) expect(isBlank(text)).toBe(false)
  })

  it.each([...WAYS, ['oxigraph', 'sparql']] as typeof WAYS)('a Kanban card needs a title (%s, %s)', (kind, prefer) => {
    const h = example('Kanban board', kind, prefer)
    const add = h.root('ex-kanban-add').closest('button') ?? h.root('ex-kanban-add')
    const cards = () => h.subjects(NS.rdf + 'type', KB + 'Card').length
    const before = cards()
    expect(add.hasAttribute('disabled')).toBe(true)
    for (const blank of BLANKS) {
      h.type(h.input('ex-kanban-new'), blank)
      expect(add.hasAttribute('disabled')).toBe(true)
      expect(h.says(UI + 'ex-kanban-new', h.input('ex-kanban-new'), h.root('ex-kanban-new'))).toEqual({
        invalid: ['true'], aria: 'true', alert: 'A title of up to 80 characters.',
      })
      // Whichever way the press gets here, nothing is added and the text stays to be corrected.
      h.fire(add, 'click')
      h.shell.flush()
      expect(cards()).toBe(before)
      expect(h.objects(UI + 'ex-kanban-new', C + 'value')).toEqual([blank])
    }
    h.type(h.input('ex-kanban-new'), '  Spaces around  ')
    expect(add.hasAttribute('disabled')).toBe(false)
    expect(h.says(UI + 'ex-kanban-new', h.input('ex-kanban-new'), h.root('ex-kanban-new'))).toEqual({ invalid: [], aria: null, alert: undefined })
    h.fire(add, 'click')
    h.shell.flush()
    expect(cards()).toBe(before + 1)
    expect(h.objects(UI + 'ex-kanban-new', C + 'value')).toEqual([])
    // Too long is still refused, by the same shape.
    h.type(h.input('ex-kanban-new'), 'x'.repeat(81))
    h.fire(add, 'click')
    h.shell.flush()
    expect(cards()).toBe(before + 1)
  })

  it.each(WAYS)('the checkout needs a name, a street and a city (%s, %s)', (kind, prefer) => {
    const h = example('Checkout', kind, prefer)
    h.fire(h.all('button').find((b) => b.textContent!.trim() === 'Continue to shipping' && h.visible(b))!, 'click')
    const shapes: [string, string][] = [
      ['co-name', 'Enter the name of the person receiving the parcel.'],
      ['co-street', 'Enter a street and number, like 12 Harbour Road.'],
      ['co-city', 'Enter a city.'],
    ]
    for (const [field, message] of shapes) {
      for (const blank of BLANKS) {
        h.type(h.input(field), blank)
        expect(h.says(UI + field, h.input(field), h.root(field))).toEqual({ invalid: ['true'], aria: 'true', alert: message })
      }
    }
    h.type(h.input('co-city'), 'Kyiv')
    expect(h.says(UI + 'co-city', h.input('co-city'), h.root('co-city'))).toEqual({ invalid: [], aria: null, alert: undefined })
  })

  it.each(WAYS)('the settings need a display name, and Save stays off without one (%s, %s)', (kind, prefer) => {
    const h = example('Settings', kind, prefer)
    const save = h.root('set-save').closest('button') ?? h.root('set-save').querySelector('button')!
    h.type(h.input('set-name'), '   ')
    expect(h.says(UI + 'set-name', h.input('set-name'), h.root('set-name'))).toEqual({
      invalid: ['true'], aria: 'true', alert: 'Enter a name, up to 60 characters.',
    })
    expect(save.hasAttribute('disabled')).toBe(true)
    h.type(h.input('set-name'), 'Ada King')
    expect(save.hasAttribute('disabled')).toBe(false)
    // An optional text may be spaces: nothing requires it.
    h.type(h.input('set-bio'), '   ')
    expect(h.objects(UI + 'set-bio', NS.val + 'invalid')).toEqual([])
  })

  it.each(WAYS)('a form derived from a shape counts it as missing where the shape requires a value (%s, %s)', (kind, prefer) => {
    const h = example('A form from a shape', kind, prefer)
    const field = (local: string) => h.shell.nodeOf(`${UI}ex-shapes-form/~f-${local}/~root`) as HTMLElement
    const control = () => field('name').querySelector('input') as HTMLInputElement
    for (const blank of BLANKS) {
      h.type(control(), blank)
      expect(field('name').querySelector('[role=alert]')?.textContent).toBe('Required.')
      expect(control().getAttribute('aria-invalid')).toBe('true')
    }
    h.type(control(), 'Ada')
    expect(field('name').querySelector('[role=alert]')).toBeNull()
    expect(h.objects(PF + 'ada', PF + 'name')).toEqual(['Ada'])
  })

  it.each(WAYS)('the tasting takes no coffee without a name (%s, %s)', (kind, prefer) => {
    const h = example('Coffee tasting', kind, prefer)
    const add = h.root('ex-foreign-add').closest('button') ?? h.root('ex-foreign-add')
    const coffees = () => h.subjects(NS.rdf + 'type', CF + 'Coffee').length
    const before = coffees()
    expect(add.hasAttribute('disabled')).toBe(true)
    for (const blank of BLANKS) {
      h.type(h.input('ex-foreign-new'), blank)
      expect(h.says(UI + 'ex-foreign-new', h.input('ex-foreign-new'), h.root('ex-foreign-new'))).toEqual({
        invalid: ['true'], aria: 'true', alert: 'Name the coffee, up to 40 characters.',
      })
      h.fire(add, 'click')
      h.shell.flush()
      expect(coffees()).toBe(before)
    }
    h.type(h.input('ex-foreign-new'), 'Guji')
    expect(add.hasAttribute('disabled')).toBe(false)
    h.fire(add, 'click')
    h.shell.flush()
    expect(coffees()).toBe(before + 1)
  })

  it.each(WAYS)('the todo app asks for a description (%s, %s)', (kind, prefer) => {
    const h = mountSite(kind, prefer)
    const f = h.store.factory
    const items = () => h.store.match(f.namedNode(EX + 'todos'), f.namedNode(C + 'item'), null).length
    const before = items()
    h.bus.emit(NS.beh + 'Input', EX + 'newTodo', { value: '   ' })
    h.bus.emit(NS.beh + 'Click', EX + 'add')
    h.shell.flush()
    expect(items()).toBe(before)
    expect(h.store.match(f.namedNode(EX + 'newTodo'), f.namedNode(C + 'error'), null).map((q) => q.object.value)).toEqual(['Please describe the todo first.'])
  })

  it('the SPARQL rules and their twins render a blank field alike', () => {
    const field = (prefer: 'sparql' | 'function') => {
      const h = example('Kanban board', 'oxigraph', prefer)
      h.type(h.input('ex-kanban-new'), '   ')
      return h.root('ex-kanban-new').outerHTML
    }
    expect(field('sparql')).toBe(field('function'))
  })
})
