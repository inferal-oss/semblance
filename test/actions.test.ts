import { beforeEach, describe, expect, it } from 'vitest'
import { MOD, NS } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
import { trackFocus } from './focus.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const C = NS.c

/** The demo shell on the Components page, showing the Actions group. */
let kind: 'oxigraph' | 'n3' | 'wat' | 'rust' = 'oxigraph'
function actions() {
  const shell = mountShell(5, kind)
  shell.showPage('Components')
  const { store, runtime } = shell
  const f = store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  runtime.apply({ remove: store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupActions'))] })
  shell.shell.flush()
  /** The mounted root element of a component instance. */
  const root = (id: string) => {
    const el = shell.shell.nodeOf(`${UI}${id}/~root`) as HTMLElement | undefined
    return el && shell.document.contains(el) ? el : null
  }
  const value = (s: string, p: string) => store.match(f.namedNode(UI + s), f.namedNode(p), null).map((q) => q.object.value)
  return { ...shell, root, value }
}

// SPARQL reactions on Oxigraph; the function fallbacks (rules and reactions) on N3.
describe.each(['oxigraph', 'n3', 'wat', 'rust'] as const)('actions components (%s)', (store) => {
  beforeEach(() => {
    kind = store
  })

  it('renders buttons in every tone and emphasis through the style hooks', () => {
    const { document } = actions()
    const buttons = [...document.querySelectorAll('[data-sem-c=button][data-sem-tone][data-sem-emphasis]')]
    expect(buttons.length).toBeGreaterThanOrEqual(24)
    const looks = new Set(buttons.map((b) => `${b.getAttribute('data-sem-tone')}/${b.getAttribute('data-sem-emphasis')}`))
    expect(looks.size).toBeGreaterThanOrEqual(24)
    expect(document.querySelector('[data-sem-c=button][data-sem-size=sm]')).not.toBeNull()
  })

  it('renders icon buttons as labelled, square, toned buttons', () => {
    const { root } = actions()
    const edit = root('act-ib-default')!
    expect(edit.localName).toBe('button')
    expect(edit.getAttribute('data-sem-c')).toBe('icon-button')
    expect(edit.getAttribute('aria-label')).toBe('Edit')
    expect(edit.getAttribute('data-sem-tooltip')).toBe('Edit')
    expect(edit.querySelector('.sem-icon')!.getAttribute('aria-hidden')).toBe('true')
    expect(edit.textContent).toBe('✎')
    expect(edit.hasAttribute('aria-pressed')).toBe(false)
    const danger = root('act-ib-danger')!
    expect(danger.getAttribute('data-sem-tone')).toBe('danger')
    expect(danger.getAttribute('data-sem-emphasis')).toBe('soft')
    expect(root('act-ib-off')!.hasAttribute('disabled')).toBe(true)
  })

  it('flips a pressable icon button through its reaction', () => {
    const { root, fire, value, bus } = actions()
    const star = root('act-ib-star')!
    expect(star.getAttribute('aria-pressed')).toBe('false')
    fire(star, 'click')
    expect(value('act-ib-star', C + 'pressed')).toEqual(['true'])
    expect(root('act-ib-star')!.getAttribute('aria-pressed')).toBe('true')
    expect(root('act-ib-star')).toBe(star) // patched in place
    fire(star, 'click')
    expect(star.getAttribute('aria-pressed')).toBe('false')
    expect(bus.recent(5)).toHaveLength(2)
    // a plain icon button has no reaction of its own: nothing is recorded
    fire(root('act-ib-default')!, 'click')
    expect(bus.recent(5)).toHaveLength(2)
  })

  it('groups buttons with role=group and its label', () => {
    const { root } = actions()
    const group = root('act-bg-edit')!
    expect(group.getAttribute('role')).toBe('group')
    expect(group.getAttribute('aria-label')).toBe('Clipboard')
    expect([...group.children].map((b) => b.textContent)).toEqual(['Cut', 'Copy', 'Paste'])
    expect(root('act-bg-small')!.getAttribute('data-sem-size')).toBe('sm')
    // toggles inside a group still flip
    const italic = root('act-bg-italic')!
    italic.dispatchEvent(new (italic.ownerDocument.defaultView as unknown as typeof globalThis).Event('click', { bubbles: true }))
    expect(italic.getAttribute('aria-pressed')).toBe('true')
  })

  it('opens a menu from its trigger, builds the items only then, and closes on a choice', () => {
    const { root, fire, value } = actions()
    const menu = root('act-menu-actions')!
    const trigger = menu.querySelector('button')!
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(menu.querySelector('[role=menu]')).toBeNull()
    expect(root('act-mi-duplicate')).toBeNull() // items are not built while closed

    fire(trigger, 'click')
    expect(value('act-menu-actions', C + 'open')).toEqual(['true'])
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const popup = menu.querySelector('[role=menu]')!
    expect(popup.getAttribute('aria-labelledby')).toBe(trigger.id)
    expect(trigger.getAttribute('aria-controls')).toBe(popup.id)
    expect(trigger.getAttribute('data-sem-shortcut')).toBe('escape')
    const items = [...popup.querySelectorAll('[role=menuitem]')]
    expect(items.map((i) => i.textContent)).toEqual(['⧉Duplicate', '✎Rename…', '⤓Archive', '⇪Share (disabled)', '✕Delete'])
    expect(items[3]!.hasAttribute('disabled')).toBe(true)
    expect(items[4]!.getAttribute('data-sem-tone')).toBe('danger')

    // Choosing an item closes the menu; this item is also a c:Setter and writes the badge.
    fire(items[4]!, 'click')
    expect(value('act-menu-actions', C + 'open')).toEqual(['false'])
    expect(menu.querySelector('[role=menu]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(root('act-menu-log')!.textContent).toContain('Deleted')
  })

  it('opened from its trigger, a menu takes the focus to its first item, and gives it back on a choice or Escape', () => {
    const { root, fire, document, window } = actions()
    trackFocus(window, document)
    const menu = root('act-menu-actions')!
    const trigger = menu.querySelector('button')!
    trigger.focus()
    fire(trigger, 'click')
    const items = () => [...menu.querySelectorAll('[role=menuitem]')]
    expect(document.activeElement).toBe(items()[0])
    fire(items()[0]!, 'click')
    expect(menu.querySelector('[role=menu]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fire(trigger, 'click')
    expect(document.activeElement).toBe(items()[0])
    const esc = new window.Event('keydown', { bubbles: true })
    Object.defineProperty(esc, 'key', { value: 'Escape' })
    document.activeElement!.dispatchEvent(esc)
    expect(menu.querySelector('[role=menu]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes the menu when the trigger is clicked again, and not from elsewhere', () => {
    const { root, fire, value } = actions()
    const menu = root('act-menu-new')!
    const trigger = menu.querySelector('button')!
    fire(trigger, 'click')
    expect(menu.getAttribute('data-open')).toBe('true')
    // a click on the popup's padding is not a click on the trigger
    fire(menu.querySelector('[role=menu]')!, 'click')
    expect(value('act-menu-new', C + 'open')).toEqual(['true'])
    fire(trigger.querySelector('.sem-label')!, 'click')
    expect(value('act-menu-new', C + 'open')).toEqual(['false'])
    expect(menu.hasAttribute('data-open')).toBe(false)
  })

  it('closes with Escape through the keyboard layer', () => {
    const { root, fire, value, document, window } = actions()
    const trigger = root('act-menu-sort')!.querySelector('button')!
    fire(trigger, 'click')
    expect(value('act-menu-sort', C + 'open')).toEqual(['true'])
    const esc = new window.Event('keydown', { bubbles: true })
    Object.defineProperty(esc, 'key', { value: 'Escape' })
    document.dispatchEvent(esc)
    expect(value('act-menu-sort', C + 'open')).toEqual(['false'])
  })

  it('records a click on a disabled menu as nothing', () => {
    const { root, fire, value } = actions()
    fire(root('act-menu-off')!.querySelector('button')!, 'click')
    expect(value('act-menu-off', C + 'open')).toEqual([])
  })

  it('renders a text sketch of each component', () => {
    const { runtime, store } = actions()
    const f = store.factory
    const open = f.namedNode(C + 'open')
    const menu = f.namedNode(UI + 'act-menu-new')
    runtime.apply({ remove: store.match(menu, open, null), add: [f.quad(menu, open, f.literal('true', f.namedNode(NS.xsd + 'boolean')))] })
    const text = runtime.project({ modality: MOD.Text, name: 'text-actions', roots: [UI + 'gallery-actions'] })
    expect(toText(text.index, UI + 'act-ib-default')).toBe('[✎]')
    expect(toText(text.index, UI + 'act-ib-pin')).toBe('[⚲*]')
    expect(toText(text.index, UI + 'act-bg-edit')).toBe('[ Cut ] [ Copy ] [ Paste ]')
    expect(toText(text.index, UI + 'act-menu-new').split('\n')).toEqual(['[ + New ▴ ]', '  › ▤ Document', '  › ▣ Folder', '  › ⇡ Upload'])
    expect(toText(text.index, UI + 'act-menu-sort')).toBe('[ ⇅ Sort ▾ ]')
  })
})
