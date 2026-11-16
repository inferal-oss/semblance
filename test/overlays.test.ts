import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { trackFocus } from './focus.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

/** The shell on the Components page, showing one gallery group. */
function showGroup(key: string, kind: 'oxigraph' | 'hybrid' | 'n3' = 'oxigraph', prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountShell(5, kind, prefer)
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
  // Escape, pressed where the focus is (or on the document's body), as a person would.
  const escape = () => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'key', { value: 'Escape' })
    ;(h.document.activeElement ?? h.document.body).dispatchEvent(e)
    h.shell.flush()
  }
  const set = (s: string, p: string, v: boolean) => {
    const subject = f.namedNode(UI + s)
    const predicate = f.namedNode(NS.c + p)
    h.runtime.apply({ remove: h.store.match(subject, predicate, null), add: [f.quad(subject, predicate, f.literal(String(v), f.namedNode('http://www.w3.org/2001/XMLSchema#boolean')))] })
    h.shell.flush()
  }
  return { ...h, byId, root, fact, click, escape, set }
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

  describe('an overlay that is not dismissible (c:dismissible false)', () => {
    it('the required-step dialog has no ✕, and neither its scrim nor Escape closes it: its action does', () => {
      const h = showGroup('GroupOverlays')
      const { root, fact, click, escape, document, window } = h
      trackFocus(window, document)
      const opener = root('ov-open-ack')
      opener.focus()
      click(opener)
      expect(fact('ov-ack', 'open')).toBe('true')
      const dialog = root('ov-ack')
      const panel = dialog.querySelector('.sem-panel')!
      expect(panel.getAttribute('role')).toBe('dialog')
      expect(panel.getAttribute('aria-modal')).toBe('true')
      expect(h.byId(panel.getAttribute('aria-labelledby')!).textContent).toBe('Save your recovery code')
      expect(h.byId(panel.getAttribute('aria-describedby')!).textContent).toContain('shown once')
      expect(dialog.querySelector('.sem-close')).toBeNull()
      expect(dialog.querySelector('[data-sem-escape]')).toBeNull()
      // The focus goes to its one action (its content is not a control).
      expect(document.activeElement).toBe(root('ov-ack-done'))
      click(dialog.querySelector('.sem-scrim')!)
      expect(fact('ov-ack', 'open')).toBe('true')
      escape()
      expect(fact('ov-ack', 'open')).toBe('true')
      expect(root('ov-ack').hasAttribute('hidden')).toBe(false)
      click(root('ov-ack-done'))
      expect(fact('ov-ack', 'open')).toBe('false')
      expect(root('ov-ack').hasAttribute('hidden')).toBe(true)
      expect(document.activeElement).toBe(opener)
    })

    it.each(['oxigraph', 'n3'] as const)('a drawer and a dialog made not dismissible stay open until an action or the graph closes them (%s)', (kind) => {
      const { root, fact, click, escape, set } = showGroup('GroupOverlays', kind)
      set('ov-drawer-end', 'dismissible', false)
      click(root('ov-open-drawer-end'))
      const drawer = root('ov-drawer-end')
      expect(drawer.querySelector('[role=dialog]')).not.toBeNull()
      expect(drawer.querySelector('.sem-close')).toBeNull()
      click(drawer.querySelector('.sem-scrim')!)
      escape()
      expect(fact('ov-drawer-end', 'open')).toBe('true')
      click(root('ov-drawer-apply'))
      expect(fact('ov-drawer-end', 'open')).toBe('false')

      // Without actions, only the graph closes it.
      set('ov-drawer-start', 'dismissible', false)
      click(root('ov-open-drawer-start'))
      click(root('ov-drawer-start').querySelector('.sem-scrim')!)
      escape()
      expect(fact('ov-drawer-start', 'open')).toBe('true')
      set('ov-drawer-start', 'open', false)
      expect(root('ov-drawer-start').hasAttribute('hidden')).toBe(true)

      click(root('ov-open-ack'))
      click(root('ov-ack').querySelector('.sem-scrim')!)
      expect(fact('ov-ack', 'open')).toBe('true')
      click(root('ov-ack-done'))
      expect(fact('ov-ack', 'open')).toBe('false')
    })

    it('Escape does not reach behind it: an open popover under it stays open', () => {
      const { root, fact, click, escape, set } = showGroup('GroupOverlays')
      click(root('ov-pop-status').querySelector('.sem-trigger')!)
      expect(fact('ov-pop-status', 'open')).toBe('true')
      set('ov-ack', 'open', true)
      escape()
      expect(fact('ov-ack', 'open')).toBe('true')
      expect(fact('ov-pop-status', 'open')).toBe('true')
      click(root('ov-ack-done'))
      // With the modal gone, Escape closes the popover again.
      escape()
      expect(fact('ov-pop-status', 'open')).toBe('false')
    })

    it('c:dismissible can change while it is open: the ✕ comes and goes, and so does closing by the scrim', () => {
      const { root, fact, click, escape, set } = showGroup('GroupOverlays')
      click(root('ov-open-dialog'))
      expect(root('ov-dialog').querySelector('.sem-close')).not.toBeNull()
      set('ov-dialog', 'dismissible', false)
      expect(fact('ov-dialog', 'open')).toBe('true')
      expect(root('ov-dialog').querySelector('.sem-close')).toBeNull()
      expect(root('ov-dialog').querySelector('[data-sem-escape]')).toBeNull()
      click(root('ov-dialog').querySelector('.sem-scrim')!)
      expect(fact('ov-dialog', 'open')).toBe('true')
      set('ov-dialog', 'dismissible', true)
      expect(root('ov-dialog').querySelector('.sem-close')).not.toBeNull()
      escape()
      expect(fact('ov-dialog', 'open')).toBe('false')
      // The required-step dialog, made dismissible, closes by its scrim; the fact retracted, it is dismissible again.
      set('ov-ack', 'dismissible', true)
      click(root('ov-open-ack'))
      expect(root('ov-ack').querySelector('.sem-close')).not.toBeNull()
      click(root('ov-ack').querySelector('.sem-scrim')!)
      expect(fact('ov-ack', 'open')).toBe('false')
    })

    it('renders the same HTML through the SPARQL rules and their function twins after every step', () => {
      const sparql = showGroup('GroupOverlays')
      const fn = showGroup('GroupOverlays', 'oxigraph', 'function')
      const both = [sparql, fn]
      const same = (step: string) => {
        for (const local of ['ov-ack', 'ov-dialog', 'ov-drawer-end', 'ov-drawer-start']) expect(sparql.root(local).outerHTML, `${step}: ${local}`).toBe(fn.root(local).outerHTML)
      }
      const each = (step: string, act: (h: typeof sparql) => void) => {
        for (const h of both) act(h)
        same(step)
      }
      same('closed')
      each('opened', (h) => h.click(h.root('ov-open-ack')))
      each('scrim', (h) => h.click(h.root('ov-ack').querySelector('.sem-scrim')!))
      each('escape', (h) => h.escape())
      each('made dismissible', (h) => h.set('ov-ack', 'dismissible', true))
      each('made not dismissible', (h) => h.set('ov-ack', 'dismissible', false))
      each('acknowledged', (h) => h.click(h.root('ov-ack-done')))
      each('drawer not dismissible', (h) => h.set('ov-drawer-end', 'dismissible', false))
      each('drawer opened', (h) => h.click(h.root('ov-open-drawer-end')))
      each('drawer scrim', (h) => h.click(h.root('ov-drawer-end').querySelector('.sem-scrim')!))
      each('drawer applied', (h) => h.click(h.root('ov-drawer-apply')))
      each('start drawer', (h) => (h.set('ov-drawer-start', 'dismissible', false), h.click(h.root('ov-open-drawer-start'))))
      each('dialog', (h) => (h.set('ov-dialog', 'dismissible', false), h.click(h.root('ov-open-dialog'))))
      for (const h of both) {
        expect(h.fact('ov-drawer-start', 'open')).toBe('true')
        expect(h.fact('ov-dialog', 'open')).toBe('true')
      }
    })

    it('a toast that is not dismissible stays in its region when its ✕ is clicked', () => {
      const h = showGroup('GroupOverlays')
      const f = h.store.factory
      const toast = f.namedNode(UI + 'ov-sticky-toast')
      const region = f.namedNode(UI + 'announcements')
      const t = (s: typeof toast, p: string, o: Parameters<typeof f.quad>[2]) => f.quad(s, f.namedNode(p), o)
      const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
      const bool = (v: boolean) => f.literal(String(v), f.namedNode('http://www.w3.org/2001/XMLSchema#boolean'))
      h.runtime.apply({
        remove: [],
        add: [
          t(region, NS.c + 'hosts', toast),
          t(toast, RDF, f.namedNode(NS.c + 'Toast')),
          t(toast, NS.c + 'label', f.literal('Saved')),
          t(toast, NS.c + 'dismissible', bool(false)),
        ],
      })
      h.shell.flush()
      h.click(h.root('ov-sticky-toast').querySelector('.sem-close')!)
      expect(h.fact('ov-sticky-toast', 'open')).toBeUndefined()
      expect(h.store.match(region, f.namedNode(NS.c + 'hosts'), toast)).toHaveLength(1)
      h.set('ov-sticky-toast', 'dismissible', true)
      h.click(h.root('ov-sticky-toast').querySelector('.sem-close')!)
      expect(h.fact('ov-sticky-toast', 'open')).toBe('false')
      expect(h.store.match(region, f.namedNode(NS.c + 'hosts'), toast)).toHaveLength(0)
    })
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

  describe('what opened a modal, scrolled away or gone', () => {
    /** The Overlays page with its dialog, and each focus's options. */
    const dialog = () => {
      const h = showGroup('GroupOverlays')
      const { document, window, runtime, store, shell } = h
      trackFocus(window, document)
      const focus = window.HTMLElement.prototype.focus
      const moved: [Element, boolean][] = []
      window.HTMLElement.prototype.focus = function (this: HTMLElement, o?: FocusOptions) {
        moved.push([this, !o?.preventScroll])
        return focus.call(this, o)
      }
      Object.assign(window, { innerWidth: 1000, innerHeight: 800 })
      const f = store.factory
      const set = (v: boolean) => {
        const s = f.namedNode(UI + 'ov-dialog')
        const p = f.namedNode(NS.c + 'open')
        runtime.apply({ remove: store.match(s, p, null), add: [f.quad(s, p, f.literal(String(v), f.namedNode('http://www.w3.org/2001/XMLSchema#boolean')))] })
        shell.flush()
      }
      const place = (el: Element, top: number) => {
        ;(el as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ top, bottom: top + 40, left: 100, right: 300, width: 200, height: 40 })
      }
      return { ...h, moved, set, place, f }
    }

    it('in view when it opened, it comes back into view; out of view then, the page stays', () => {
      const { root, click, fact, document, moved, set, place } = dialog()
      const opener = root('ov-open-dialog')
      place(opener, 300)
      opener.focus()
      click(opener)
      expect(fact('ov-dialog', 'open')).toBe('true')
      expect(document.activeElement).not.toBe(opener)
      // The reader scrolls the page under the modal; it closes.
      place(opener, -600)
      moved.length = 0
      set(false)
      expect(document.activeElement).toBe(opener)
      expect(moved.at(-1)).toEqual([opener, true])
      // A focus left off screen, and a shortcut that opens over it: nobody saw it, nothing scrolls.
      opener.focus()
      set(true)
      moved.length = 0
      set(false)
      expect(document.activeElement).toBe(opener)
      expect(moved.at(-1)).toEqual([opener, false])
    })

    it('the address changed: the page stays where it was asked to be', () => {
      const { root, click, document, window, moved, set, place } = dialog()
      const opener = root('ov-open-dialog')
      place(opener, 300)
      Object.defineProperty(window, 'location', { configurable: true, value: { href: 'https://semblance.dev/a' } })
      opener.focus()
      click(opener)
      Object.defineProperty(window, 'location', { configurable: true, value: { href: 'https://semblance.dev/b' } })
      moved.length = 0
      set(false)
      expect(document.activeElement).toBe(opener)
      expect(moved.at(-1)).toEqual([opener, false])
    })

    it('gone, a control near where it was takes the focus, without scrolling', () => {
      const { root, click, fact, document, runtime, store, shell, moved, set, f } = dialog()
      const opener = root('ov-open-dialog')
      const next = root('ov-open-confirm')
      opener.focus()
      click(opener)
      runtime.apply({ remove: store.match(f.namedNode(UI + 'ov-open-dialog'), null, null), add: [] })
      shell.flush()
      expect(opener.isConnected).toBe(false)
      expect(fact('ov-dialog', 'open')).toBe('true')
      moved.length = 0
      set(false)
      expect(fact('ov-dialog', 'open')).toBe('false')
      expect(document.activeElement).toBe(next)
      expect(moved.at(-1)).toEqual([next, false])
    })
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
