import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
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

// --- tiled workspace: tabs moved and panes split and closed by dragging tabs (here by keyboard) ----

/** The Layout gallery's workspace, and a keyboard drag of its tabs. */
function workspace(prefer: 'sparql' | 'function') {
  const h = showPanes(prefer)
  const f = h.store.factory
  const ws = () => h.root('ly-tiled-workspace')
  const tab = (name: string) => [...ws().querySelectorAll('[role=tab]')].find((t) => t.textContent!.trim() === name) as HTMLElement
  const status = () => h.document.querySelector('[data-sem-drag-live]')?.textContent ?? ''
  const over = () => {
    const at = ws().querySelector('[data-sem-drop-over]')
    return at ? h.shell.keyOf(at) : undefined
  }
  /** Pick a tab up (Space), carry it with the arrow keys to a zone (`<pane>/~root` or `<pane>/~split-<edge>`), put it down. */
  const carry = (name: string, zone: string) => {
    const el = tab(name)
    el.focus()
    h.key(el, ' ')
    // The zones are in document order, Right after Left before: along to the end, then back.
    for (const arrow of ['ArrowRight', 'ArrowLeft']) for (let i = 0; i < 40 && over() !== zone; i++) h.key(h.document.activeElement ?? el, arrow)
    expect(over(), `${name} carried to ${zone}`).toBe(zone)
    const said = status()
    h.key(h.document.activeElement ?? el, ' ')
    return said
  }
  const obj = (s: string, p: string) => h.store.match(f.namedNode(s), f.namedNode(c + p), null).map((q) => q.object.value)
  /** The tree under the workspace, by local names: split(primary, secondary) and tabs[their tabs]. */
  const tree = (node = obj(UI + 'ly-tiled-workspace', 'rootTile')[0]!): string => {
    const [p] = obj(node, 'primary')
    const [s] = obj(node, 'secondary')
    const name = node.replace(UI + 'ly-tiled-', '').replace(/~(split|pane)-[0-9a-f]{12}/, '~$1')
    if (p || s) return `${name}(${p ? tree(p) : '-'}, ${s ? tree(s) : '-'})`
    const labels = [...(h.shell.nodeOf(node + '/~root') as HTMLElement).querySelectorAll('[role=tab]')].map((t) => t.textContent!.trim())
    return `${name}[${labels.join(' ')}]`
  }
  return { ...h, ws, tab, carry, tree, obj, status }
}

/** The workspace's HTML, its minted pane and split IRIs (from the drop event, which differs per run) made alike. */
const html = (w: ReturnType<typeof workspace>) => w.ws().outerHTML.replace(/~(split|pane)-[0-9a-f]{12}/g, '~$1')

/** The walk both implementations take: split a pane, move a tab into another (closing the one it left), split by the top. */
const WALK: [string, string][] = [
  ['Preview', 'ly-tiled-notes/~split-end'],
  ['Properties', 'ly-tiled-main/~root'],
  ['Notes', 'ly-tiled-main/~split-top'],
]

describe('tiled workspace', () => {
  for (const prefer of ['sparql', 'function'] as const) {
    it(`(${prefer}) a tab dragged onto an edge splits that pane, onto tabs moves there; emptied panes close`, () => {
      const w = workspace(prefer)
      expect(w.ws().tagName).toBe('SECTION')
      expect(w.ws().getAttribute('aria-label')).toBe('Research workspace')
      expect(w.tree()).toBe('row(main[Editor Preview], column(inspector[Properties], notes[Notes]))')
      // Each tab is a draggable carrying itself; the tab list keeps its one roving tab stop.
      const preview = w.tab('Preview')
      expect([preview.getAttribute('data-sem-gesture'), preview.getAttribute('data-sem-drag'), preview.getAttribute('tabindex')]).toEqual(['drag', UI + 'ly-tiled-tab-preview', '-1'])
      // Every pane takes a tab as a whole and splits at its four edges.
      expect([...w.ws().querySelectorAll('[data-sem-drop-zone]')].map((z) => w.shell.keyOf(z)!.replace(UI + 'ly-tiled-', '')).slice(0, 5)).toEqual([
        'main/~root', 'main/~split-start', 'main/~split-end', 'main/~split-top', 'main/~split-bottom',
      ])
      w.click(preview)
      const content = w.root('ly-tiled-preview')

      // Beside Notes: the notes pane splits, Preview in new tabs after it, selected there.
      expect(w.carry('Preview', UI + 'ly-tiled-notes/~split-end')).toBe('Preview: Split right.')
      expect(w.tree()).toBe('row(main[Editor], column(inspector[Properties], notes/~split(notes[Notes], notes/~pane[Preview])))')
      const split = w.obj(UI + 'ly-tiled-column', 'secondary')[0]!
      expect(w.obj(split, 'ratio')).toEqual([])
      expect(w.obj(w.obj(split, 'secondary')[0]!, 'selected')).toEqual([UI + 'ly-tiled-tab-preview'])
      // The same tab, the same content, the same element.
      expect(w.root('ly-tiled-preview')).toBe(content)
      expect(w.root('ly-tiled-preview').closest('[role=tabpanel]')!.hasAttribute('hidden')).toBe(false)

      // Onto the main tabs: Properties moves there (last, selected) and the inspector, now empty, closes.
      expect(w.carry('Properties', UI + 'ly-tiled-main/~root')).toBe('Properties: Editor.')
      expect(w.tree()).toBe('row(main[Editor Properties], notes/~split(notes[Notes], notes/~pane[Preview]))')
      expect(w.obj(UI + 'ly-tiled-main', 'selected')).toEqual([UI + 'ly-tiled-tab-properties'])
      expect(w.obj(UI + 'ly-tiled-inspector', 'tabs')).toEqual([NS.rdf + 'nil'])

      // Above the main tabs: Notes leaves its pane (which closes, its sibling taking its split's place).
      w.carry('Notes', UI + 'ly-tiled-main/~split-top')
      expect(w.tree()).toBe('row(main/~split(main/~pane[Notes], main[Editor Properties]), notes/~pane[Preview])')
      expect(w.store.match(w.store.factory.namedNode(w.obj(UI + 'ly-tiled-row', 'primary')[0]!), w.store.factory.namedNode(NS.pos + 'direction'), null).map((q) => q.object.value)).toEqual([NS.pos + 'Column'])
      expect(w.root('ly-tiled-preview')).toBe(content)
    })

    it(`(${prefer}) a pane's only tab dropped beside itself changes nothing`, () => {
      const w = workspace(prefer)
      const before = w.tree()
      const last = () => w.bus.recent(1)[0]?.[0]?.subject.value
      const recorded = last()
      w.carry('Notes', UI + 'ly-tiled-notes/~split-start')
      expect(w.tree()).toBe(before)
      expect(last()).toBe(recorded)
    })
  }

  it('keeps a moved tab\'s content in the document while panes split and close (an iframe there would not reload)', () => {
    const w = workspace('sparql')
    w.click(w.tab('Preview'))
    const content = w.root('ly-tiled-preview')
    // Every DOM insertion and removal: a detour through a detached pane would disconnect the content.
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(content)) as Node
    const at = (['insertBefore', 'removeChild'] as const).map((name) => {
      let owner: object = proto
      while (!Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner)
      return [owner as Record<string, unknown>, name, (owner as Record<string, unknown>)[name]] as const
    })
    const detached: string[] = []
    for (const [owner, name, original] of at) {
      owner[name] = function (this: Node, ...args: unknown[]) {
        const out = (original as (...a: unknown[]) => unknown).apply(this, args)
        if (!content.isConnected) detached.push(name)
        return out
      }
    }
    try {
      for (const [name, zone] of WALK) w.carry(name, UI + zone)
    } finally {
      for (const [owner, name, original] of at) owner[name] = original
    }
    expect(w.tree()).toBe('row(main/~split(main/~pane[Notes], main[Editor Properties]), notes/~pane[Preview])')
    expect(w.root('ly-tiled-preview')).toBe(content)
    expect(detached).toEqual([])
  })

  it('renders the same with SPARQL rules and reactions as with functions, after every drop', () => {
    const both = (['sparql', 'function'] as const).map(workspace)
    expect(html(both[0]!)).toBe(html(both[1]!))
    for (const [name, zone] of WALK) {
      for (const w of both) w.carry(name, UI + zone)
      expect(both[0]!.tree()).toBe(both[1]!.tree())
      expect(html(both[0]!), `after ${name} onto ${zone}`).toBe(html(both[1]!))
    }
  })
})

