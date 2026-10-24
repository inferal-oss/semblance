// The kanban example (demo/gallery/_ex-kanban.ttl) on a c:Board, driven through events on the site.
import { describe, expect, it } from 'vitest'
import { mountSite } from './harness.ts'
import { fakeLayout } from './drag-layout.ts'

const UI = 'https://semblance.dev/demo#'
const KB = 'https://semblance.dev/demo/kanban#'

function kanban(prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountSite('oxigraph', prefer)
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  click(button('Examples'))
  click(navItem('Kanban board'))
  const root = () => h.shell.nodeOf(UI + 'ex-kanban/~root') as Element
  const lanes = () =>
    Object.fromEntries(
      [...root().querySelectorAll('[data-sem-c=board] > section')].map((s) => [
        s.querySelector('h3')!.textContent,
        { count: s.querySelector('header [data-sem-c=badge]')!.textContent, cards: [...s.querySelectorAll('ul > li .sem-title')].map((t) => t.textContent) },
      ]),
    )
  const card = (title: string) => [...root().querySelectorAll('[data-sem-c=board-card]')].find((li) => li.querySelector('.sem-title')!.textContent === title)!
  const control = (title: string, label: string) => card(title).querySelector(`button[aria-label^="${label}"]`)!
  const press = (title: string, key: string) => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
    card(title).dispatchEvent(e)
    h.shell.flush()
  }
  const column = (id: string) => h.store.match(h.store.factory.namedNode(KB + id), h.store.factory.namedNode(KB + 'column'), null).map((q) => q.object.value.replace(KB, ''))
  const toasts = () => [...h.document.querySelectorAll('[data-sem-c=toast]')].map((t) => t.textContent).join(' | ')
  const field = () => root().querySelector('[data-sem-c=text-field] input') as HTMLInputElement
  const type = (text: string) => {
    field().value = text
    h.fire(field(), 'input')
    h.shell.flush()
  }
  return { ...h, click, root, lanes, card, control, press, column, toasts, field, type, button }
}

/**
 * The board with a fake layout (the test DOM has none): the lanes 300px apart, their cards 60px
 * rows from y = 100, and pointer and key events to drag cards over them.
 */
function dragging(prefer: 'sparql' | 'function' = 'sparql') {
  const h = kanban(prefer)
  const zones = () => [...h.root().querySelectorAll('[data-sem-drop-zone]')] as HTMLElement[]
  const { rectOf, pointer } = fakeLayout(h, { width: 300, row: 60 })
  /** Drag a card to the top half of the i-th card of lane z (or past the last). */
  const drag = (title: string, z: number, i: number) => {
    const el = h.card(title) as HTMLElement
    const r = rectOf(el)
    pointer(el, 'pointerdown', r.left + 20, r.top + 20)
    pointer(h.document, 'pointermove', r.left + 30, r.top + 30)
    pointer(h.document, 'pointermove', z * 300 + 140, 100 + i * 60 + 10)
    pointer(h.document, 'pointerup', z * 300 + 140, 100 + i * 60 + 10)
    h.shell.flush()
  }
  const rank = (id: string) => h.store.match(h.store.factory.namedNode(KB + id), h.store.factory.namedNode(KB + 'rank'), null).map((q) => q.object.value)
  return { ...h, zones, pointer, drag, rank }
}

describe('the kanban example', () => {
  it('lays the cards out in the columns, counted, Doing against its limit', () => {
    const { lanes, card } = kanban()
    expect(lanes()).toEqual({
      'To do': { count: '3', cards: ['Offline mode for the editor', 'Crash when pasting an empty query', 'Write the persistence guide'] },
      Doing: { count: '2 / 3', cards: ['Keyboard shortcuts for the board', 'Bump Oxigraph'] },
      Done: { count: '1', cards: ['Toast overlaps the dock'] },
    })
    const c = card('Bump Oxigraph')
    expect(c.getAttribute('tabindex')).toBe('0')
    expect(c.querySelector('[data-sem-c=tag]')!.textContent).toContain('chore')
    expect(c.querySelector('[data-sem-c=avatar]')!.getAttribute('aria-label')).toBe('Grace Hopper')
    expect([...c.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Move to To do', 'Move to Done', 'Remove'])
    // The first and last columns have no way further.
    expect(card('Offline mode for the editor').querySelector('button[aria-label="Move to To do"]')).toBeNull()
  })

  it('moves a card with its buttons, and the counts follow', () => {
    const { click, control, column, lanes } = kanban()
    click(control('Toast overlaps the dock', 'Move to Doing'))
    expect(column('c6')).toEqual(['doing'])
    expect(lanes().Doing.count).toBe('3 / 3')
    expect(lanes().Done.count).toBe('0')
    click(control('Toast overlaps the dock', 'Move to Done'))
    expect(column('c6')).toEqual(['done'])
  })

  it('moves a focused card with the arrow keys', () => {
    const { press, column, lanes } = kanban()
    press('Write the persistence guide', 'ArrowRight')
    expect(column('c3')).toEqual(['doing'])
    press('Write the persistence guide', 'ArrowRight')
    expect(column('c3')).toEqual(['done'])
    press('Write the persistence guide', 'ArrowRight')
    expect(column('c3')).toEqual(['done'])
    press('Write the persistence guide', 'ArrowLeft')
    expect(lanes().Doing.cards).toContain('Write the persistence guide')
  })

  it('refuses a move into a full Doing, says why, and lets it through once there is room', () => {
    const { click, control, press, column, lanes, toasts, card } = kanban()
    click(control('Offline mode for the editor', 'Move to Doing'))
    expect(lanes().Doing.count).toBe('3 / 3')
    expect(lanes().Doing.count).toBe('3 / 3')
    click(control('Crash when pasting an empty query', 'Move to Doing'))
    expect(column('c2')).toEqual(['todo'])
    expect(toasts()).toContain('That column is at its limit')
    expect(card('Crash when pasting an empty query').classList.contains('sem-refused')).toBe(true)
    press('Write the persistence guide', 'ArrowRight')
    expect(column('c3')).toEqual(['todo'])
    expect(lanes().Doing.cards).toHaveLength(3)
    // Finish one: now there is room.
    click(control('Bump Oxigraph', 'Move to Done'))
    click(control('Crash when pasting an empty query', 'Move to Doing'))
    expect(column('c2')).toEqual(['doing'])
    expect(card('Crash when pasting an empty query').classList.contains('sem-refused')).toBe(false)
  })

  it('adds a card from the field (the button waits for a title) and removes one', () => {
    const { type, field, lanes, click, button, control, toasts, store } = kanban()
    expect(button('Add to To do').hasAttribute('disabled')).toBe(true)
    type('Ship the board')
    expect(button('Add to To do').hasAttribute('disabled')).toBe(false)
    click(button('Add to To do'))
    expect(lanes()['To do'].cards.at(-1)).toBe('Ship the board')
    expect(lanes()['To do'].count).toBe('4')
    expect(field().value).toBe('')
    expect(toasts()).toContain('Card added to To do')
    click(control('Ship the board', 'Remove'))
    expect(lanes()['To do'].cards).not.toContain('Ship the board')
    expect(store.match(null, store.factory.namedNode(KB + 'title'), store.factory.literal('Ship the board'))).toHaveLength(0)
  })

  it('renders the same with function rules preferred, before and after moves', () => {
    const a = kanban('sparql')
    const b = kanban('function')
    expect(b.root().innerHTML).toBe(a.root().innerHTML)
    for (const h of [a, b]) {
      h.click(h.control('Offline mode for the editor', 'Move to Doing'))
      h.click(h.control('Crash when pasting an empty query', 'Move to Doing'))
      h.press('Bump Oxigraph', 'ArrowRight')
    }
    expect(b.root().innerHTML).toBe(a.root().innerHTML)
    expect(b.column('c2')).toEqual(a.column('c2'))
  })

  it('drags a card into another column, between two cards, and reorders within a column', () => {
    const { drag, column, rank, lanes, zones } = dragging()
    expect(zones().map((z) => z.getAttribute('data-sem-drop-zone')!.replace(KB, ''))).toEqual(['todo', 'doing', 'done'])
    drag('Write the persistence guide', 2, 0)
    expect(column('c3')).toEqual(['done'])
    expect(rank('c3')).toEqual(['5'])
    expect(lanes().Done.cards).toEqual(['Write the persistence guide', 'Toast overlaps the dock'])
    expect(lanes()['To do'].count).toBe('2')
    // Within To do: Crash (rank 2) to the top, before Offline mode (1).
    drag('Crash when pasting an empty query', 0, 0)
    expect(lanes()['To do'].cards).toEqual(['Crash when pasting an empty query', 'Offline mode for the editor'])
    expect(rank('c2')).toEqual(['0'])
    // Between two cards of Doing (ranks 4 and 5): half way.
    drag('Toast overlaps the dock', 1, 1)
    expect(lanes().Doing.cards).toEqual(['Keyboard shortcuts for the board', 'Toast overlaps the dock', 'Bump Oxigraph'])
    expect(rank('c6')).toEqual(['4.5'])
    expect(lanes().Doing.count).toBe('3 / 3')
  })

  it('refuses a drop into a full Doing with the shape\'s message, and the buttons still move cards', () => {
    const { drag, click, control, column, lanes, toasts, card, bus } = dragging()
    click(control('Offline mode for the editor', 'Move to Doing'))
    expect(lanes().Doing.count).toBe('3 / 3')
    drag('Crash when pasting an empty query', 1, 0)
    expect(column('c2')).toEqual(['todo'])
    expect(toasts()).toContain('Doing holds at most three cards.')
    expect(card('Crash when pasting an empty query').hasAttribute('data-sem-refused')).toBe(true)
    expect(bus.recent(1)[0]!.some((q) => q.predicate.value.endsWith('handledBy') && q.object.value === KB + 'DropCard')).toBe(false)
    // Reordering within the full column is still fine (it adds no card).
    drag('Bump Oxigraph', 1, 0)
    expect(lanes().Doing.cards[0]).toBe('Bump Oxigraph')
    click(control('Bump Oxigraph', 'Move to Done'))
    drag('Crash when pasting an empty query', 1, 0)
    expect(column('c2')).toEqual(['doing'])
    expect(card('Crash when pasting an empty query').hasAttribute('data-sem-refused')).toBe(false)
  })

  it('carries a card by keyboard: Space, the arrows, Enter - and the arrows are the board\'s again after', () => {
    const { press, column, lanes, document } = dragging()
    press('Write the persistence guide', ' ')
    expect(document.querySelector('[data-sem-drag-live]')!.textContent).toBe('Write the persistence guide: To do, after Crash when pasting an empty query.')
    // Into Doing at the same place (its end), then up one.
    press('Write the persistence guide', 'ArrowRight')
    expect(document.querySelector('[data-sem-drag-live]')!.textContent).toBe('Write the persistence guide: Doing, after Bump Oxigraph.')
    press('Write the persistence guide', 'ArrowUp')
    expect(document.querySelector('[data-sem-drag-live]')!.textContent).toBe('Write the persistence guide: Doing, before Bump Oxigraph.')
    // Still in To do while carried: the board's own arrow-key move did not run.
    expect(column('c3')).toEqual(['todo'])
    press('Write the persistence guide', 'Enter')
    expect(column('c3')).toEqual(['doing'])
    expect(lanes().Doing.cards).toEqual(['Keyboard shortcuts for the board', 'Write the persistence guide', 'Bump Oxigraph'])
    press('Write the persistence guide', 'ArrowRight')
    expect(column('c3')).toEqual(['done'])
  })

  it('renders the same with SPARQL and with function rules while dragging', () => {
    const [a, b] = (['sparql', 'function'] as const).map((prefer) => dragging(prefer))
    for (const h of [a!, b!]) {
      const el = h.card('Write the persistence guide')
      h.pointer(el, 'pointerdown', 20, 220)
      h.pointer(h.document, 'pointermove', 30, 230)
      h.pointer(h.document, 'pointermove', 440, 170)
      h.shell.flush()
    }
    expect(b!.root().innerHTML).toBe(a!.root().innerHTML)
    expect(a!.root().innerHTML).toContain('data-sem-drop-before')
    for (const h of [a!, b!]) h.pointer(h.document, 'pointerup', 440, 170), h.shell.flush()
    expect(b!.root().innerHTML).toBe(a!.root().innerHTML)
    expect(b!.rank('c3')).toEqual(a!.rank('c3'))
  })
})
