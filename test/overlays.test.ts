import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
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

  it.each(['oxigraph', 'n3'] as const)('keeps nondismissible dialogs and drawers open until an explicit action with %s', (kind) => {
    const h = showGroup('GroupOverlays', kind)
    const { root, fact, click } = h
    const f = h.store.factory
    const dismissible = f.namedNode(NS.c + 'dismissible')
    const makePersistent = (local: string) => h.runtime.apply({
      add: [f.quad(f.namedNode(UI + local), dismissible, f.literal('false', f.namedNode('http://www.w3.org/2001/XMLSchema#boolean')))],
      remove: [],
    })

    makePersistent('ov-dialog')
    click(root('ov-open-dialog'))
    const dialog = root('ov-dialog')
    expect(dialog.querySelector('[role=dialog]')).not.toBeNull()
    expect(dialog.querySelector('.sem-close')).toBeNull()
    expect(dialog.querySelector('[data-sem-escape]')).toBeNull()
    click(dialog.querySelector('.sem-scrim')!)
    expect(fact('ov-dialog', 'open')).toBe('true')
    const escape = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(escape, { key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
    dialog.querySelector('.sem-panel')!.dispatchEvent(escape)
    h.shell.flush()
    expect(fact('ov-dialog', 'open')).toBe('true')
    click(root('ov-dialog-save'))
    expect(fact('ov-dialog', 'open')).toBe('false')

    makePersistent('ov-drawer-start')
    click(root('ov-open-drawer-start'))
    const drawer = root('ov-drawer-start')
    expect(drawer.querySelector('[role=dialog]')).not.toBeNull()
    expect(drawer.querySelector('.sem-close')).toBeNull()
    click(drawer.querySelector('.sem-scrim')!)
    expect(fact('ov-drawer-start', 'open')).toBe('true')
  })

  it('renders nondismissible modal overlays identically through SPARQL and function rules', () => {
    const sparql = showGroup('GroupOverlays')
    const functionRule = showGroup('GroupOverlays', 'oxigraph', 'function')
    for (const h of [sparql, functionRule]) {
      const f = h.store.factory
      for (const local of ['ov-dialog', 'ov-drawer-start']) {
        h.runtime.apply({
          add: [f.quad(f.namedNode(UI + local), f.namedNode(NS.c + 'dismissible'), f.literal('false', f.namedNode('http://www.w3.org/2001/XMLSchema#boolean')))],
          remove: [],
        })
      }
      h.click(h.root('ov-open-dialog'))
      h.click(h.root('ov-open-drawer-start'))
    }
    expect(sparql.root('ov-dialog').outerHTML).toBe(functionRule.root('ov-dialog').outerHTML)
    expect(sparql.root('ov-drawer-start').outerHTML).toBe(functionRule.root('ov-drawer-start').outerHTML)
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
    expect(panel().querySelectorAll('[data-sem-c=badge]')).toHaveLength(3)
    click(trigger())
    expect(fact('ov-pop-status', 'open')).toBe('false')
    expect(panel().hasAttribute('hidden')).toBe(true)
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
