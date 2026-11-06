import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { trackFocus } from './focus.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const c = NS.c

/**
 * data-sem-takes-focus marks: a closed overlay's trigger keeps its mark at rest, to have the focus back
 * on closing. That mark asks for nothing when an event reaches something around the overlay (#336).
 */

/** The site at a gallery group, or at an example; everything is driven through events. */
function site(prefer: 'sparql' | 'function', where: { group: string } | { example: string }) {
  const h = mountShell(5, 'oxigraph', prefer)
  const f = h.store.factory
  const app = f.namedNode(UI + 'app')
  const show = (p: string, o: string) => h.runtime.apply({ remove: h.store.match(app, f.namedNode(UI + p), null), add: [f.quad(app, f.namedNode(UI + p), f.namedNode(UI + o))] })
  if ('group' in where) {
    h.showPage('Components')
    show('galleryGroup', where.group)
  } else {
    show('page', 'Examples')
    show('example', where.example)
  }
  h.shell.flush()
  trackFocus(h.window, h.document)
  const node = (iri: string) => ([...h.document.querySelectorAll('*')].find((el) => h.shell.keyOf(el) === iri) ?? null) as HTMLElement | null
  const root = (local: string) => node(`${UI}${local}/~root`)!
  const part = (local: string, name: string) => node(`${UI}${local}/~${name}`)!
  const fact = (s: string, p: string) => h.store.match(f.namedNode(UI + s), f.namedNode(c + p), null)[0]?.object.value
  /** Put an instance the site already has in a part of another one. */
  const nest = (owner: string, p: string, inner: string) => {
    const s = f.namedNode(UI + owner)
    const pn = f.namedNode(c + p)
    h.runtime.apply({ remove: h.store.match(s, pn, null), add: [f.quad(s, pn, f.namedNode(UI + inner))] })
    h.shell.flush()
  }
  const box = (el: Element, width: number, height: number) => {
    ;(el as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height })
  }
  /** A press where the focus is, as the browser delivers it. */
  const key = (k: string) => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as Event & { key: string }
    Object.defineProperty(e, 'key', { value: k })
    h.document.activeElement!.dispatchEvent(e)
    h.shell.flush()
  }
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  return { ...h, node, root, part, fact, nest, box, key, click }
}

/** Each kind of closed overlay that keeps a mark on its trigger or opener. */
const OVERLAYS = [
  ['a popover', 'ov-pop-info'],
  ['a menu', 'act-menu-actions'],
  ['a date field', 'inp-date-departs'],
] as const

const marked = (el: Element | null) => !!el?.querySelector('[data-sem-takes-focus]')

describe.each(['sparql', 'function'] as const)('focus marks (%s)', (prefer) => {
  it('the Network inspector: a size key keeps the focus on the panel handle, and the panel changes size', () => {
    const h = site(prefer, { example: 'ExNetwork' })
    const panel = h.root('net-inspector')
    const handle = panel.querySelector(':scope > .sem-dock-handle') as HTMLElement
    expect(marked(panel)).toBe(true)
    h.box(panel, 1000, 560)
    handle.focus()
    h.key('ArrowUp')
    expect(h.fact('net-inspector', 'height')).toBe('576')
    expect(h.document.activeElement).toBe(handle)
    h.box(panel, 1000, 576)
    h.key('ArrowDown')
    expect(h.fact('net-inspector', 'height')).toBe('560')
    expect(h.document.activeElement).toBe(handle)
    h.box(panel, 1000, 560)
    h.key('Home')
    expect(h.fact('net-inspector', 'height')).toBe('220')
    expect(h.document.activeElement).toBe(handle)
  })

  it('the Network inspector: its popover still takes the focus to its panel and back when it opens and closes', () => {
    const h = site(prefer, { example: 'ExNetwork' })
    const trigger = h.part('net-preferences', 'trigger')
    trigger.focus()
    h.click(trigger)
    expect(h.fact('net-preferences', 'open')).toBe('true')
    expect(h.part('net-preferences', 'panel').contains(h.document.activeElement)).toBe(true)
    h.key('Escape')
    expect(h.fact('net-preferences', 'open')).toBe('false')
    expect(h.document.activeElement).toBe(h.part('net-preferences', 'trigger'))
  })
})

describe('focus marks around a closed overlay', () => {
  it.each(OVERLAYS)('a dock panel with %s inside: its size handle keeps the focus', (_, overlay) => {
    const h = site('sparql', { group: 'GroupLayout' })
    h.nest('ly-dock-panel', 'content', overlay)
    const panel = h.root('ly-dock-panel')
    const handle = panel.querySelector(':scope > .sem-dock-handle') as HTMLElement
    expect(marked(panel)).toBe(true)
    h.box(panel, 1000, 220)
    handle.focus()
    h.key('ArrowUp')
    expect(h.fact('ly-dock-panel', 'height')).toBe('236')
    expect(h.document.activeElement).toBe(handle)
  })

  it('a panel at the end: its size handle keeps the focus in either writing direction', () => {
    const h = site('sparql', { group: 'GroupLayout' })
    h.nest('ly-dock-end-panel', 'content', 'ov-pop-info')
    const panel = h.root('ly-dock-end-panel')
    const handle = panel.querySelector(':scope > .sem-dock-handle') as HTMLElement
    expect(marked(panel)).toBe(true)
    h.box(panel, 240, 600)
    handle.focus()
    h.key('ArrowLeft')
    expect(h.fact('ly-dock-end-panel', 'width')).toBe('256')
    expect(h.document.activeElement).toBe(handle)
    // The test DOM's window outlives this mount: the direction is taken back below.
    ;(h.window as unknown as { getComputedStyle: () => object }).getComputedStyle = () => ({ direction: 'rtl', position: 'fixed' })
    h.box(panel, 256, 600)
    h.key('ArrowRight')
    expect(h.fact('ly-dock-end-panel', 'width')).toBe('272')
    expect(h.document.activeElement).toBe(handle)
    delete (h.window as unknown as { getComputedStyle?: () => object }).getComputedStyle
  })

  it("a split view's divider keeps the focus", () => {
    const h = site('sparql', { group: 'GroupLayout' })
    h.nest('ly-split-view', 'primary', 'ov-pop-info')
    const divider = h.part('ly-split-view', 'divider')
    expect(marked(h.root('ly-split-view'))).toBe(true)
    h.box(divider.previousElementSibling!, 400, 300)
    h.box(divider.parentElement!, 1000, 300)
    divider.focus()
    h.key('ArrowRight')
    expect(Number(h.fact('ly-split-view', 'ratio'))).toBe(0.424)
    expect(h.document.activeElement).toBe(divider)
  })

  it("a docked window's size handle keeps the focus", () => {
    const h = site('sparql', { group: 'GroupWindows' })
    h.nest('win-side', 'body', 'ov-pop-info')
    h.click(h.root('wn-open-side'))
    const win = h.root('win-side')
    const handle = win.querySelector(':scope > .sem-dock-handle') as HTMLElement
    expect(marked(win)).toBe(true)
    h.box(win, 360, 600)
    handle.focus()
    h.key('ArrowLeft')
    expect(h.fact('win-side', 'width')).toBe('376')
    expect(h.document.activeElement).toBe(handle)
  })

  it('a removed control leaves the focus near where it was, not on a closed overlay around it', () => {
    const h = site('sparql', { example: 'ExNetwork' })
    h.nest('net-inspector', 'content', 'fb-tags-removable')
    expect(marked(h.root('net-inspector'))).toBe(true)
    const tag = h.root('fb-tag-rm-2')
    const remove = tag.querySelector('.sem-remove') as HTMLElement
    remove.focus()
    h.click(remove)
    expect(h.fact('fb-tag-rm-2', 'removed')).toBe('true')
    expect(remove.isConnected && !remove.closest('[hidden]')).toBe(false)
    const now = h.document.activeElement!
    expect(now).not.toBe(h.part('net-preferences', 'trigger'))
    expect(h.root('fb-tags-removable').contains(now)).toBe(true)
  })
})
