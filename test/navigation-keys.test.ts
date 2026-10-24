import { describe, expect, it } from 'vitest'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

/** The shell, with a helper that presses a key on an element (as if it had focus). */
function setup() {
  const h = mountShell()
  const f = h.store.factory
  const app = f.namedNode(UI + 'app')
  const show = (group: string) => {
    h.showPage('Components')
    const p = f.namedNode(UI + 'galleryGroup')
    h.runtime.apply({ remove: h.store.match(app, p, null), add: [f.quad(app, p, f.namedNode(UI + group))] })
    h.shell.flush()
  }
  const press = (el: Element, key: string) => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
    el.dispatchEvent(e)
    return e.defaultPrevented
  }
  const tabbable = (root: Element, selector: string) => [...root.querySelectorAll(selector)].filter((x) => x.getAttribute('tabindex') === '0')
  return { ...h, show, press, tabbable }
}

describe('arrow-key navigation (keyboard layer)', () => {
  it('declares each pattern on the component root', () => {
    const h = setup()
    const tabs = h.document.querySelector('[data-sem-c=tabs]')!
    expect(tabs.getAttribute('data-sem-nav-items')).toBe('[role=tablist] > [role=tab]')
    expect(tabs.getAttribute('data-sem-nav-orientation')).toBe('horizontal')
    expect(tabs.hasAttribute('data-sem-nav-activate')).toBe(true)
    // NavList refines Segmented: its own (vertical) pattern wins.
    h.show('GroupFoundations')
    expect(h.document.querySelector('[data-sem-c=nav-list]')!.getAttribute('data-sem-nav-orientation')).toBe('vertical')
  })

  it('moves between tabs and selects the focused one', () => {
    const h = setup()
    const tab = (name: string) => [...h.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === name)!
    expect(h.press(tab('Inspector'), 'ArrowRight')).toBe(true)
    expect(tab('Query').getAttribute('aria-selected')).toBe('true')
    h.press(tab('Query'), 'End')
    expect(tab('Engine').getAttribute('aria-selected')).toBe('true')
    h.press(tab('Engine'), 'ArrowRight') // wraps
    expect(tab('Inspector').getAttribute('aria-selected')).toBe('true')
  })

  it('opens a menu from its button and moves among enabled items', () => {
    const h = setup()
    h.show('GroupActions')
    const menu = h.document.querySelector('[data-sem-c=menu]')!
    const trigger = menu.querySelector('[aria-haspopup=menu]')!
    h.press(trigger, 'ArrowDown')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const items = () => [...menu.querySelectorAll('[role=menuitem]')]
    expect(h.tabbable(menu, '[role=menuitem]')).toEqual([items()[0]])
    h.press(items()[0]!, 'End')
    // The disabled item is skipped: End lands on the last enabled one.
    expect(h.tabbable(menu, '[role=menuitem]')[0]!.textContent).toContain('Delete')
    h.press(items().at(-1)!, 'ArrowUp')
    expect(h.tabbable(menu, '[role=menuitem]')[0]!.textContent).toContain('Archive')
  })

  it('moves between accordion headers without toggling them', () => {
    const h = setup()
    h.show('GroupDisclosure')
    const acc = h.document.querySelector('[data-sem-c=accordion]')!
    const headers = [...acc.querySelectorAll('h3 > button[aria-expanded]')]
    const states = () => headers.map((b) => b.getAttribute('aria-expanded'))
    const before = states()
    h.press(headers[0]!, 'ArrowDown')
    expect(h.tabbable(acc, 'h3 > button')).toEqual([headers[1]])
    expect(states()).toEqual(before)
  })

  it('expands, collapses and moves between parent and child in a tree', () => {
    const h = setup()
    h.show('GroupData')
    const tree = h.document.querySelector('[data-sem-c=tree]')!
    const node = () => tree.querySelector('[role=treeitem]')!
    const label = () => node().querySelector(':scope > .sem-row > .sem-label')!
    expect(node().getAttribute('aria-expanded')).toBe('true')
    h.press(label(), 'ArrowLeft')
    expect(node().getAttribute('aria-expanded')).toBe('false')
    h.press(label(), 'ArrowRight')
    expect(node().getAttribute('aria-expanded')).toBe('true')
    h.press(label(), 'ArrowRight') // into the first child
    const child = h.tabbable(tree, '.sem-label')[0]!
    expect(child.closest('[role=treeitem]')!.getAttribute('aria-level')).toBe('2')
    h.press(child, 'ArrowLeft') // a leaf: back to its parent
    expect(h.tabbable(tree, '.sem-label')).toEqual([label()])
  })

  it('changes pages with the arrow keys on the app’s segmented control', () => {
    const h = setup()
    const nav = [...h.document.querySelectorAll('[data-sem-c=segmented]')].find((s) => s.textContent!.includes('Docs'))!
    const button = (t: string) => [...nav.querySelectorAll('button')].find((b) => b.textContent === t)!
    h.press(button('Components'), 'ArrowRight')
    expect(h.value(UI + 'page')).toBe(UI + 'Examples')
    h.press(button('Examples'), 'ArrowLeft')
    expect(h.value(UI + 'page')).toBe(UI + 'Components')
  })
})
