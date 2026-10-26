import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { TiledWorkspace } from '../src/layout/tiled-workspace.ts'
import { mountShell } from './harness.ts'
import { expectSameRendering, implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const c = NS.c

/** The shell on the Components page, showing the Layout gallery group. */
function showPanes(prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountShell(5, 'oxigraph', prefer)
  const f = h.store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  h.showPage('Components')
  h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupLayout'))] })
  h.shell.flush()
  const node = (iri: string) => ([...h.document.querySelectorAll('*')].find((el) => h.shell.keyOf(el) === iri) ?? null) as HTMLElement | null
  const root = (local: string) => node(`${UI}${local}/~root`)!
  const part = (local: string, name: string) => node(`${UI}${local}/~${name}`)!
  const fact = (s: string, p: string) => h.store.match(f.namedNode(UI + s), f.namedNode(c + p), null)[0]?.object.value
  const size = (el: Element, detail: { size: number; extent: number }) => {
    el.dispatchEvent(new h.window.CustomEvent('sem-size', { bubbles: true, detail }))
    h.shell.flush()
  }
  /** Give an element a measured box (linkedom does no layout). */
  const box = (el: Element, width: number, height: number) => {
    ;(el as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height })
  }
  /** A key press on a focused element, as the browser delivers it (to the document listener). */
  const key = (el: Element, k: string) => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as Event & { key: string }
    Object.defineProperty(e, 'key', { value: k })
    // The bus creates the sem-size event with the global CustomEvent; linkedom dispatches only its own.
    const global = globalThis as { CustomEvent: unknown }
    const own = global.CustomEvent
    global.CustomEvent = h.window.CustomEvent
    try {
      el.dispatchEvent(e)
    } finally {
      global.CustomEvent = own
    }
    h.shell.flush()
  }
  return { ...h, node, root, part, fact, size, box, key, click: (el: Element) => (h.fire(el, 'click'), h.shell.flush()) }
}

describe('panes', () => {
  it('have both implementations, and they render the same', () => {
    expect(implementationGaps(['components/panes.ttl'])).toEqual({ noSparql: [], noFunction: [] })
    expectSameRendering(['GroupLayout'])
  })

  for (const prefer of ['sparql', 'function'] as const) {
    describe(`(${prefer})`, () => {
      it('keeps tab content stable while panes split, move and close', () => {
        const h = showPanes(prefer)
        const { store, runtime, shell, root, click } = h
        const f = store.factory
        const node = (local: string) => f.namedNode(UI + local)
        const manager = new TiledWorkspace(store, node('ly-tiled-workspace'))
        const workspace = root('ly-tiled-workspace')
        expect(workspace.tagName).toBe('SECTION')
        expect(workspace.getAttribute('aria-label')).toBe('Research workspace')
        expect(workspace.querySelectorAll('[data-sem-c="split-view"]')).toHaveLength(2)
        expect(root('ly-tiled-main').querySelectorAll('[role=tab]')).toHaveLength(2)
        click(root('ly-tiled-main').querySelectorAll('[role=tab]')[1]!)
        const previewElement = root('ly-tiled-preview')

        const extra = node('ly-tiled-extra')
        runtime.apply({ add: [
          f.quad(extra, f.namedNode(NS.rdf + 'type'), f.namedNode(c + 'Tabs')),
          f.quad(extra, f.namedNode(c + 'tabs'), f.namedNode(NS.rdf + 'nil')),
        ], remove: [] })
        runtime.apply(manager.split(node('ly-tiled-notes'), extra, 'column'))
        shell.flush()
        expect(workspace.querySelectorAll('[data-sem-c="split-view"]')).toHaveLength(3)
        expect(root('ly-tiled-notes').querySelector('[role=tab]')?.textContent).toBe('Notes')

        const preview = node('ly-tiled-tab-preview')
        runtime.apply(manager.moveTab(preview, node('ly-tiled-main'), extra))
        shell.flush()
        expect(root('ly-tiled-main').querySelectorAll('[role=tab]')).toHaveLength(1)
        expect(root('ly-tiled-extra').querySelector('[role=tab]')?.textContent).toBe('Preview')
        expect(root('ly-tiled-extra').textContent).toContain('Preview the document here.')
        expect(root('ly-tiled-preview')).toBe(previewElement)
        expect(store.match(extra, f.namedNode(c + 'selected'), preview)).toHaveLength(1)

        runtime.apply(manager.close(node('ly-tiled-notes')))
        shell.flush()
        expect(workspace.querySelectorAll('[data-sem-c="split-view"]')).toHaveLength(2)
        expect(root('ly-tiled-extra').textContent).toContain('Preview the document here.')
        expect(root('ly-tiled-preview')).toBe(previewElement)
        expect(store.match(node('ly-tiled-tab-preview'), f.namedNode(c + 'content'), null)).toHaveLength(1)
      })

      it('a split view: two panes, a separator between them, its share as a style property', () => {
        const { root, part } = showPanes(prefer)
        const split = root('ly-split-view')
        expect(split.getAttribute('data-sem-c')).toBe('split-view')
        expect(split.getAttribute('style')).toBe('--split-ratio: 0.4')
        const [first, divider, second] = [...split.children] as HTMLElement[]
        expect(first!.classList.contains('sem-primary')).toBe(true)
        expect(second!.classList.contains('sem-secondary')).toBe(true)
        expect(divider).toBe(part('ly-split-view', 'divider'))
        expect(divider!.getAttribute('role')).toBe('separator')
        expect(divider!.getAttribute('aria-orientation')).toBe('vertical')
        expect(divider!.getAttribute('aria-valuenow')).toBe('40')
        expect(divider!.getAttribute('aria-controls')).toBe(first!.id)
        expect(divider!.getAttribute('aria-label')).toBe('Resize the request list')
        expect(divider!.getAttribute('tabindex')).toBe('0')
        expect(divider!.getAttribute('data-sem-gesture')).toBe('size')
        expect(divider!.getAttribute('data-sem-sizes')).toBe('previous')
        expect(divider!.getAttribute('data-sem-min')).toBe('140')
        expect(first!.querySelector('[data-sem-c=stack]')).not.toBeNull()
        expect(second!.querySelector('[data-sem-c=description-list]')).not.toBeNull()
        // Stacked: the divider sizes heights.
        const stacked = part('ly-split-stacked-view', 'divider')
        expect(stacked.getAttribute('aria-orientation')).toBe('horizontal')
        expect(stacked.getAttribute('data-sem-axis')).toBe('y')
      })

      it('dragging the divider sets c:ratio, clamped by c:minSize', () => {
        const { root, part, fact, size } = showPanes(prefer)
        size(part('ly-split-view', 'divider'), { size: 300, extent: 1000 })
        expect(Number(fact('ly-split-view', 'ratio'))).toBe(0.3)
        expect(root('ly-split-view').getAttribute('style')).toBe('--split-ratio: 0.3')
        expect(part('ly-split-view', 'divider').getAttribute('aria-valuenow')).toBe('30')
        // 140 px of 1000 is the least either pane keeps.
        size(part('ly-split-view', 'divider'), { size: 20, extent: 1000 })
        expect(Number(fact('ly-split-view', 'ratio'))).toBe(0.14)
        size(part('ly-split-view', 'divider'), { size: 990, extent: 1000 })
        expect(Number(fact('ly-split-view', 'ratio'))).toBe(0.86)
      })

      it('arrow keys on the divider move it a step', () => {
        const { part, fact, box, key } = showPanes(prefer)
        const divider = part('ly-split-view', 'divider')
        box(divider.previousElementSibling!, 400, 300)
        box(divider.parentElement!, 1000, 300)
        key(divider, 'ArrowRight')
        expect(Number(fact('ly-split-view', 'ratio'))).toBe(0.424)
        key(divider, 'Home')
        expect(Number(fact('ly-split-view', 'ratio'))).toBe(0.14)
      })

      it('c:collapsed hides the second pane and drops the divider', () => {
        const { root, part, fact, click } = showPanes(prefer)
        click(root('ly-split-collapse').querySelector('button')!)
        expect(fact('ly-split-view', 'collapsed')).toBe('true')
        const split = root('ly-split-view')
        expect(part('ly-split-view', 'divider')).toBeNull()
        expect(split.querySelector(':scope > .sem-secondary')!.hasAttribute('hidden')).toBe(true)
        expect([...split.children].map((e) => e.className)).toEqual(['sem-pane sem-primary', 'sem-pane sem-secondary'])
      })

      it('a dock panel: a region with a header, toolbar, body and footer, sized along its free edge', () => {
        const { root, part } = showPanes(prefer)
        const dock = root('ly-dock-panel')
        expect(dock.tagName).toBe('SECTION')
        expect(dock.getAttribute('aria-label')).toBe('Activity')
        expect(dock.getAttribute('data-expanded')).toBe('true')
        expect(dock.getAttribute('style')).toBe('--dock-size: 220px')
        const handle = part('ly-dock-panel', 'handle')
        expect(handle.getAttribute('role')).toBe('separator')
        expect(handle.getAttribute('aria-orientation')).toBe('horizontal')
        expect(handle.getAttribute('aria-valuenow')).toBe('220')
        expect(handle.getAttribute('data-sem-axis')).toBe('y')
        expect(handle.getAttribute('data-sem-sign')).toBe('-1')
        const header = part('ly-dock-panel', 'header')
        expect([...header.children].map((e) => e.className)).toEqual(['sem-fold', 'sem-dock-badge', 'sem-dock-actions'])
        expect(header.querySelector('.sem-fold')!.textContent).toBe('Activity')
        expect(header.querySelector('.sem-dock-badge')!.textContent).toBe('3 events')
        const main = part('ly-dock-panel', 'main')
        expect([...main.children].map((e) => e.className)).toEqual(['sem-dock-toolbar', 'sem-dock-body', 'sem-dock-footer'])
        expect(header.querySelector('.sem-fold')!.getAttribute('aria-controls')).toBe(main.id)
        // At the end edge: sized by width, along x.
        const end = root('ly-dock-end-panel')
        expect(end.getAttribute('data-sem-edge')).toBe('end')
        expect(end.getAttribute('style')).toBe('--dock-size: 240px')
        expect(part('ly-dock-end-panel', 'handle').getAttribute('data-sem-axis')).toBe('x')
        expect(part('ly-dock-end-panel', 'handle').getAttribute('aria-orientation')).toBe('vertical')
      })

      it('resizing the free edge sets c:height (or c:width), within c:minSize and the room', () => {
        const { root, part, fact, size } = showPanes(prefer)
        size(part('ly-dock-panel', 'handle'), { size: 300, extent: 900 })
        expect(fact('ly-dock-panel', 'height')).toBe('300')
        expect(root('ly-dock-panel').getAttribute('style')).toBe('--dock-size: 300px')
        size(part('ly-dock-panel', 'handle'), { size: 40, extent: 900 })
        expect(fact('ly-dock-panel', 'height')).toBe('120')
        size(part('ly-dock-panel', 'handle'), { size: 2000, extent: 900 })
        expect(fact('ly-dock-panel', 'height')).toBe('900')
        size(part('ly-dock-end-panel', 'handle'), { size: 100, extent: 800 })
        expect(fact('ly-dock-end-panel', 'width')).toBe('160')
        expect(fact('ly-dock-end-panel', 'height')).toBeUndefined()
      })

      it('the title folds the panel to its header, and unfolds it', () => {
        const { root, part, fact, click } = showPanes(prefer)
        click(part('ly-dock-panel', 'fold'))
        expect(fact('ly-dock-panel', 'expanded')).toBe('false')
        expect(root('ly-dock-panel').getAttribute('data-expanded')).toBe('false')
        expect(part('ly-dock-panel', 'main').hasAttribute('hidden')).toBe(true)
        expect(part('ly-dock-panel', 'handle')).toBeNull()
        expect(part('ly-dock-panel', 'fold').getAttribute('aria-expanded')).toBe('false')
        click(part('ly-dock-panel', 'fold'))
        expect(fact('ly-dock-panel', 'expanded')).toBe('true')
        expect(part('ly-dock-panel', 'main').hasAttribute('hidden')).toBe(false)
      })
    })
  }
})
