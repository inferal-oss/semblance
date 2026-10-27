import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { trackFocus } from './focus.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

/** The shell on the Components page, showing one gallery group. */
function showGroup(key: string, kind: 'oxigraph' | 'hybrid' | 'n3' = 'oxigraph') {
  const h = mountShell(5, kind)
  const f = h.store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  h.showPage('Components')
  h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + key))] })
  h.shell.flush()
  const byId = (iri: string) => h.document.getElementById(iri) as HTMLElement
  // The DOM node rendered for an RDF/HTML node (keyed by its IRI).
  const node = (iri: string) => ([...h.document.querySelectorAll('*')].find((el) => h.shell.keyOf(el) === iri) ?? null) as HTMLElement
  const root = (local: string) => node(`${UI}${local}/~root`)
  const fact = (s: string, p: string) => h.store.match(f.namedNode(UI + s), f.namedNode(NS.c + p), null)[0]?.object.value
  const click = (el: Element) => h.fire(el, 'click')
  return { ...h, byId, root, fact, click }
}

describe('overlay components', () => {
  it('a closed dialog renders an empty hidden root on the desktop, and its content is not evaluated', () => {
    const { root, document, screen } = showGroup('GroupOverlays')
    const dialog = root('ov-dialog')
    expect(dialog.getAttribute('data-sem-c')).toBe('dialog')
    expect(dialog.hasAttribute('hidden')).toBe(true)
    expect(dialog.children).toHaveLength(0)
    expect(document.querySelector('[data-sem-c=desktop]')!.contains(dialog)).toBe(true)
    expect(root('ov-dialog-field')).toBeNull()
    // The drawers on the desktop render (closed), through whichever rule the store prefers.
    const runs = (rule: string) => screen.engine.stats.byRule.get(NS.c + rule)?.runs ?? 0
    expect(runs('DrawerRendering-fn') + runs('DrawerRendering-sparql')).toBeGreaterThan(0)
  })

  it('opens from a c:opens button, with dialog ARIA, and closes by ✕, scrim and action buttons', () => {
    const { root, fact, click, byId } = showGroup('GroupOverlays')
    const opener = root('ov-open-dialog')
    expect(opener.getAttribute('aria-haspopup')).toBe('dialog')
    expect(opener.getAttribute('aria-controls')).toBe(`${UI}ov-dialog/~root`)
    expect(opener.getAttribute('aria-expanded')).toBe('false')

    click(opener)
    expect(fact('ov-dialog', 'open')).toBe('true')
    expect(opener.getAttribute('aria-expanded')).toBe('true')
    const dialog = root('ov-dialog')
    expect(dialog.hasAttribute('hidden')).toBe(false)
    const panel = dialog.querySelector('.sem-panel')!
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('true')
    const title = byId(panel.getAttribute('aria-labelledby')!)
    expect(title.textContent).toBe('Rename graph')
    expect(byId(panel.getAttribute('aria-describedby')!).textContent).toContain('written to the graph')
    expect(panel.querySelector('[data-sem-c=text-field]')).not.toBeNull()
    expect(panel.querySelectorAll('.sem-actions [data-sem-c=button]')).toHaveLength(2)
    // clicking inside the panel does not close it
    click(title)
    expect(fact('ov-dialog', 'open')).toBe('true')

    click(panel.querySelector('.sem-close')!)
    expect(fact('ov-dialog', 'open')).toBe('false')
    expect(root('ov-dialog').hasAttribute('hidden')).toBe(true)

    click(opener)
    click(root('ov-dialog').querySelector('.sem-scrim')!)
    expect(fact('ov-dialog', 'open')).toBe('false')

    click(opener)
    click(root('ov-dialog-save'))
    expect(fact('ov-dialog', 'open')).toBe('false')
    expect(root('ov-dialog').children).toHaveLength(0)
  })

  it('drawers slide from the side they name', () => {
    const { root, click } = showGroup('GroupOverlays')
    click(root('ov-open-drawer-start'))
    expect(root('ov-drawer-start').getAttribute('data-side')).toBe('start')
    expect(root('ov-drawer-start').querySelector('[role=dialog]')).not.toBeNull()
    click(root('ov-drawer-start').querySelector('.sem-close')!)
    expect(root('ov-drawer-start').hasAttribute('hidden')).toBe(true)

    click(root('ov-open-drawer-end'))
    const drawer = root('ov-drawer-end')
    expect(drawer.getAttribute('data-side')).toBe('end')
    // components inside keep working: a selectable tag in the drawer
    const tag = root('ov-filter-done').querySelector('.sem-tag-toggle')!
    click(tag)
    expect(root('ov-filter-done').querySelector('.sem-tag-toggle')!.getAttribute('aria-pressed')).toBe('true')
    expect(root('ov-drawer-end').hasAttribute('hidden')).toBe(false)
    click(root('ov-drawer-apply'))
    expect(root('ov-drawer-end').hasAttribute('hidden')).toBe(true)
  })

  it('popovers toggle from their trigger, which reports aria-expanded and controls the panel', () => {
    const { root, fact, click, byId } = showGroup('GroupOverlays')
    const pop = root('ov-pop-status')
    const trigger = () => root('ov-pop-status').querySelector('.sem-trigger')!
    const panel = () => byId(trigger().getAttribute('aria-controls')!)
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(pop.contains(panel())).toBe(true)
    expect(panel().hasAttribute('hidden')).toBe(true)
    click(trigger())
    expect(fact('ov-pop-status', 'open')).toBe('true')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(panel().hasAttribute('hidden')).toBe(false)
    expect(panel().getAttribute('role')).toBe('dialog')
    expect(panel().getAttribute('aria-labelledby')).toBe(trigger().id)
    expect(panel().getAttribute('data-sem-anchor')).toBe(trigger().id)
    expect(panel().querySelectorAll('[data-sem-c=badge]')).toHaveLength(3)
    click(trigger())
    expect(fact('ov-pop-status', 'open')).toBe('false')
    expect(panel().hasAttribute('hidden')).toBe(true)
  })

  it('an opened dialog takes the focus to the first control of its content, else its first action, and gives it back', () => {
    const h = showGroup('GroupOverlays')
    const { root, click, document, window } = h
    trackFocus(window, document)
    const escape = () => {
      const e = new window.Event('keydown', { bubbles: true })
      Object.defineProperty(e, 'key', { value: 'Escape' })
      document.activeElement!.dispatchEvent(e)
    }
    // A dialog with content: its field (not the ✕ before it).
    const opener = root('ov-open-dialog')
    opener.focus()
    click(opener)
    expect(document.activeElement).toBe(root('ov-dialog-field').querySelector('input'))
    escape()
    expect(h.fact('ov-dialog', 'open')).toBe('false')
    expect(document.activeElement).toBe(opener)
    // A confirmation without content: its first action, the safe one.
    const confirm = root('ov-open-confirm')
    confirm.focus()
    click(confirm)
    expect(document.activeElement).toBe(root('ov-confirm-cancel'))
    click(root('ov-confirm-cancel'))
    expect(document.activeElement).toBe(confirm)
    // A drawer: the first tag of its content; closed by an action, the focus goes back.
    const drawer = root('ov-open-drawer-end')
    drawer.focus()
    click(drawer)
    expect(document.activeElement).toBe(root('ov-filter-open').querySelector('.sem-tag-toggle'))
    click(root('ov-drawer-apply'))
    expect(document.activeElement).toBe(drawer)
    // A drawer with neither content nor actions: its panel; the ✕ gives the focus back.
    const outline = root('ov-open-drawer-start')
    outline.focus()
    click(outline)
    expect(document.activeElement).toBe(root('ov-drawer-start').querySelector('.sem-panel'))
    click(root('ov-drawer-start').querySelector('.sem-close')!)
    expect(document.activeElement).toBe(outline)
  })

  it('a dialog opened by the graph, not by an event, still takes the focus and gives it back', () => {
    const h = showGroup('GroupOverlays')
    const { root, document, window, runtime, store, shell } = h
    trackFocus(window, document)
    const f = store.factory
    const dialog = f.namedNode(UI + 'ov-confirm')
    const open = f.namedNode(NS.c + 'open')
    const set = (v: boolean) => runtime.apply({ remove: store.match(dialog, open, null), add: [f.quad(dialog, open, f.literal(String(v), f.namedNode('http://www.w3.org/2001/XMLSchema#boolean')))] })
    const before = root('ov-open-dialog')
    before.focus()
    set(true)
    shell.flush()
    expect(document.activeElement).toBe(root('ov-confirm-cancel'))
    set(false)
    shell.flush()
    expect(document.activeElement).toBe(before)
  })

  it('a popover opened from its trigger takes the focus to its first control, and gives it back to the trigger', () => {
    const h = showGroup('GroupOverlays')
    const { root, click, document, window, store, runtime, shell } = h
    trackFocus(window, document)
    // The specimen's panel holds badges only: put a control in it.
    const f = store.factory
    const pop = f.namedNode(UI + 'ov-pop-info')
    const button = f.namedNode(UI + 'ov-pop-info-ok')
    runtime.apply({ remove: [], add: [f.quad(button, f.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), f.namedNode(NS.c + 'Button')), f.quad(button, f.namedNode(NS.c + 'label'), f.literal('OK')), f.quad(button, f.namedNode(NS.c + 'closes'), pop), f.quad(pop, f.namedNode(NS.c + 'content'), button)] })
    shell.flush()
    const trigger = () => root('ov-pop-info').querySelector<HTMLElement>('.sem-trigger')!
    trigger().focus()
    click(trigger())
    expect(h.fact('ov-pop-info', 'open')).toBe('true')
    expect(document.activeElement).toBe(root('ov-pop-info-ok'))
    click(root('ov-pop-info-ok'))
    expect(h.fact('ov-pop-info', 'open')).toBe('false')
    expect(document.activeElement).toBe(trigger())
    // Without a control in it, the focus stays on the trigger, and the trigger closes it.
    const status = () => root('ov-pop-status').querySelector<HTMLElement>('.sem-trigger')!
    status().focus()
    click(status())
    expect(document.activeElement).toBe(status())
    click(status())
    expect(document.activeElement).toBe(status())
  })

  it('every interaction is one recorded event', () => {
    const { root, click, bus } = showGroup('GroupOverlays')
    const before = bus.recent(50).length
    click(root('ov-open-confirm'))
    click(root('ov-confirm-cancel'))
    expect(bus.recent(50).length - before).toBe(2)
  })

  it('reacts the same through the function fallbacks (a store without SPARQL)', () => {
    const { root, fact, click } = showGroup('GroupOverlays', 'n3')
    click(root('ov-open-dialog'))
    expect(root('ov-dialog').querySelector('[role=dialog]')).not.toBeNull()
    click(root('ov-dialog').querySelector('.sem-scrim')!)
    expect(fact('ov-dialog', 'open')).toBe('false')
    click(root('ov-open-confirm'))
    click(root('ov-confirm-delete'))
    expect(fact('ov-confirm', 'open')).toBe('false')
    const trigger = () => root('ov-pop-info').querySelector('.sem-trigger')!
    click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    click(trigger())
    expect(fact('ov-pop-info', 'open')).toBe('false')
  })
})
