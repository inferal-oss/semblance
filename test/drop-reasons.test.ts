import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeLayout } from './drag-layout.ts'
import { compileStyles } from '../src/style/compile.ts'
import { loadStore } from '../src/node/load.ts'
import { mount, type MountedApp } from '../src/web/mount.ts'

// A refused drop's reason on a mounted graph, driven by pointer and key events (src/web/drop-reasons.ts):
// the graph stays the source, the surface is an anchored panel, and the live region still says it.

const UI = 'https://example.org/ui#'
const graph = `
@prefix ui: <${UI}> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix dnd: <https://semblance.dev/ns/dragdrop#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix beh: <https://semblance.dev/ns/behaviour#> .
ui:Shelf a <http://www.w3.org/2002/07/owl#Class> .
ui:ShelfDrop a beh:Reaction ; beh:when dnd:Drop ; beh:sourceClass ui:Shelf ;
    beh:inserts "CONSTRUCT { $this c:item ?task } WHERE { $event dnd:carrying ?task }" .
ui:root a c:Stack ; c:children ( ui:open ui:bugs ui:full ) .
ui:open a c:List , dnd:Sortable , ui:Shelf ; c:label "Open" ; c:itemLabel rdfs:label ; c:sortBy ui:rank ;
    dnd:members c:item ; dnd:orderBy ui:rank ; c:item ui:notes .
ui:bugs a c:List , dnd:Sortable , ui:Shelf ; c:label "Bugs" ; c:itemLabel rdfs:label ; c:sortBy ui:rank ;
    dnd:members c:item ; dnd:orderBy ui:rank ; dnd:accepts ui:BugShape ; c:item ui:crash .
ui:full a c:List , dnd:Sortable , ui:Shelf ; c:label "Full" ; c:itemLabel rdfs:label ; c:sortBy ui:rank ;
    dnd:members c:item ; dnd:orderBy ui:rank ; c:item ui:login .
ui:FullLimit a sh:NodeShape ; sh:targetNode ui:full ; sh:property [ sh:path c:item ; sh:maxCount 1 ; sh:message "Full holds one at most." ] .
ui:BugShape a sh:NodeShape ; sh:property [ sh:path ui:kind ; sh:hasValue ui:Bug ; sh:message "Only bugs go here." ] .
ui:OtherShape a sh:NodeShape ; sh:property [ sh:path ui:kind ; sh:hasValue ui:Other ; sh:message "Others alone." ] .
ui:notes rdfs:label "Write notes" ; ui:rank 1 .
ui:crash rdfs:label "A crash" ; ui:kind ui:Bug ; ui:rank 1 .
ui:login rdfs:label "Log in" ; ui:rank 1 .
`
const apps: MountedApp[] = []

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

type Box = { top: number; left: number; width: number; height: number }

/** Mounted, with zones side by side 200px apart from y = 100 (drag-layout.ts); a test can move any element. */
async function shelves(prefer: 'sparql' | 'function' = 'sparql', { rtl = false, viewport = { width: 800, height: 600 } } = {}) {
  const { document, window } = parseHTML(`<!doctype html><html${rtl ? ' dir="rtl"' : ''}><body><div id="app"></div></body></html>`)
  class Sheet { replaceSync() {} }
  Object.defineProperty(window, 'CSSStyleSheet', { value: Sheet, configurable: true })
  document.adoptedStyleSheets = []
  const frames: FrameRequestCallback[] = []
  Object.defineProperty(window, 'requestAnimationFrame', { value: (f: FrameRequestCallback) => frames.push(f), configurable: true })
  Object.defineProperty(window, 'cancelAnimationFrame', { value: () => {}, configurable: true })
  Object.defineProperty(document.documentElement, 'clientWidth', { value: viewport.width, configurable: true })
  Object.defineProperty(document.documentElement, 'clientHeight', { value: viewport.height, configurable: true })
  const scrollers = new Set<Element>()
  const computed = (overflow: string) => ({
    direction: rtl ? 'rtl' : 'ltr', overflowX: overflow, overflowY: overflow, maxHeight: 'none',
    getPropertyValue: (p: string) => (p === '--sem-danger-9' ? 'light-dark(#a00, #f66)' : p === 'color-scheme' ? 'dark' : ''),
  })
  Object.defineProperty(window, 'getComputedStyle', { value: (el: Element) => computed(scrollers.has(el) ? 'auto' : 'visible'), configurable: true })
  vi.stubGlobal('requestIdleCallback', () => 0)
  vi.stubGlobal('fetch', async () => new Response(readFileSync(new URL('../rdf-engine/build/wat.wasm', import.meta.url)), { headers: { 'Content-Type': 'application/wasm' } }))
  const proto = window.HTMLElement.prototype as HTMLElement & { showPopover(): void; hidePopover(): void }
  const open = new Set<Element>()
  const matches = proto.matches
  proto.showPopover = function (this: HTMLElement) { open.add(this) }
  proto.hidePopover = function (this: HTMLElement) { open.delete(this) }
  proto.matches = function (this: HTMLElement, selector: string) {
    return selector === ':popover-open' ? open.has(this) : matches.call(this, selector)
  } as typeof proto.matches
  const element = document.getElementById('app')!
  const app = await mount(element, { root: UI + 'root', graphs: [graph], store: 'wat', prefer, files: false, fullscreen: false })
  apps.push(app)
  const { pointer, rectOf } = fakeLayout({ document, window } as unknown as Parameters<typeof fakeLayout>[0], { width: 200, row: 30 })
  // On top of the fake layout: where a test puts an element, and the surface's own size.
  const boxes = new Map<Element, Box>()
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.matches('.sem-drop-reason')) return { top: 0, left: 0, width: 120, height: 30, bottom: 30, right: 120 } as DOMRect
    const b = boxes.get(this)
    return b ? ({ ...b, bottom: b.top + b.height, right: b.left + b.width } as DOMRect) : rectOf(this)
  }
  const list = (id: string) => app.renderer.nodeOf(`${UI}${id}/~root`) as HTMLElement
  const item = (text: string) => [...element.querySelectorAll<HTMLElement>('[data-sem-drag]')].find((d) => d.textContent!.includes(text))!
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  /** Press on an item and lift it, without letting go. */
  const lift = async (text: string) => {
    const el = item(text)
    const r = el.getBoundingClientRect()
    pointer(el, 'pointerdown', r.left + 10, r.top + 10)
    pointer(document, 'pointermove', r.left + 20, r.top + 20)
    await settled()
  }
  /** Carry it over the first row of the z-th zone. */
  const over = async (z: number) => {
    pointer(document, 'pointermove', z * 200 + 90, 105)
    await settled()
  }
  const key = async (el: Element, k: string) => {
    const e = new window.Event('keydown', { bubbles: true, cancelable: true })
    Object.assign(e, { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
    el.dispatchEvent(e)
    await settled()
  }
  const surfaces = () => [...document.querySelectorAll<HTMLElement>('.sem-drop-reason')]
  const live = () => document.querySelector('[data-sem-drag-live]')?.textContent
  return { document, window, element, app, frames, boxes, open, scrollers, list, item, lift, over, pointer, key, settled, surfaces, live }
}

describe('a refused drop\'s reason', () => {
  it('shows on one surface in the top layer, next to the zone, and the graph stays the source', async () => {
    const s = await shelves()
    expect(s.element.hasAttribute('data-sem-drop-reasons')).toBe(true)
    await s.lift('Write notes')
    // Offered, and refused, but not over it yet.
    expect(s.list('bugs').getAttribute('data-sem-drop')).toBe('refuses')
    expect(s.surfaces()).toEqual([])

    await s.over(1)
    const zone = s.list('bugs')
    expect(zone.getAttribute('data-sem-drop-reason')).toBe('Only bugs go here.')
    const [surface] = s.surfaces()
    expect(surface!.textContent).toBe('Only bugs go here.')
    expect(surface!.getAttribute('popover')).toBe('manual')
    expect(s.open.has(surface!)).toBe(true)
    expect(surface!.style.position).toBe('fixed')
    // Above the zone (x 200, width 180, y 100), centred on it.
    expect(surface!.style.left).toBe('230px')
    expect(surface!.style.top).toBe('64px')
    // Where the zone is decides how it looks; it describes the zone while it shows.
    expect(surface!.style.getPropertyValue('--sem-danger-9')).toBe('light-dark(#a00, #f66)')
    expect(surface!.style.getPropertyValue('color-scheme')).toBe('dark')
    expect(surface!.getAttribute('dir')).toBe('ltr')
    expect(zone.getAttribute('aria-describedby')).toBe(surface!.id)
    // It says it to assistive technology as before: the drag's live region.
    expect(s.live()).toBe('Write notes: Bugs refuses it: Only bugs go here.')

    s.app.unmount()
    expect(s.element.hasAttribute('data-sem-drop-reasons')).toBe(false)
    expect(s.surfaces()).toEqual([])
    expect(zone.hasAttribute('aria-describedby')).toBe(false)
  })

  it('moves with the drag: another refusing zone, an accepting one, and letting go', async () => {
    const s = await shelves()
    await s.lift('Write notes')
    await s.over(1)
    const first = s.surfaces()[0]
    await s.over(2)
    expect(s.surfaces().map((x) => x.textContent)).toEqual(['Full holds one at most.'])
    expect(first!.isConnected).toBe(false)
    expect(s.list('bugs').hasAttribute('aria-describedby')).toBe(false)
    expect(s.live()).toBe('Write notes: Full refuses it: Full holds one at most.')

    // Its own zone takes it back: no reason.
    await s.over(0)
    expect(s.surfaces()).toEqual([])
    expect(s.live()).toBe('Write notes: Open.')

    await s.over(1)
    expect(s.surfaces().length).toBe(1)
    s.pointer(s.document, 'pointerup', 290, 105)
    await s.settled()
    expect(s.surfaces()).toEqual([])
    expect(s.element.querySelector('[data-sem-drop-over]')).toBeNull()
  })

  it('shows for a keyboard drag too, and Escape takes it away', async () => {
    const s = await shelves()
    const held = s.item('Write notes')
    await s.key(held, ' ')
    await s.key(s.document.activeElement ?? held, 'ArrowRight')
    expect(s.surfaces().map((x) => x.textContent)).toEqual(['Only bugs go here.'])
    expect(s.live()).toBe('Write notes: Bugs refuses it: Only bugs go here.')
    await s.key(held, 'Escape')
    expect(s.surfaces()).toEqual([])
    expect(s.live()).toBe('')
  })

  it('follows the graph: a reason that changes, and a zone that goes away', async () => {
    const s = await shelves()
    await s.lift('Write notes')
    await s.over(1)
    const f = s.app.store.factory
    const accepts = f.namedNode('https://semblance.dev/ns/dragdrop#accepts')
    const bugs = f.namedNode(UI + 'bugs')
    s.app.runtime.apply({ remove: [f.quad(bugs, accepts, f.namedNode(UI + 'BugShape'))], add: [f.quad(bugs, accepts, f.namedNode(UI + 'OtherShape'))] })
    s.app.flush()
    await s.settled()
    expect(s.list('bugs').getAttribute('data-sem-drop-reason')).toBe('Others alone.')
    expect(s.surfaces().map((x) => x.textContent)).toEqual(['Others alone.'])

    const zone = s.list('bugs')
    zone.remove()
    await s.settled()
    expect(s.surfaces()).toEqual([])
  })

  it('stays through a patch: the renderer keeps only its own children in the host', async () => {
    const s = await shelves()
    await s.lift('Write notes')
    await s.over(1)
    const zone = s.list('bugs')
    const f = s.app.store.factory
    s.app.runtime.apply({ remove: [], add: [f.quad(f.namedNode(UI + 'notes'), f.namedNode(UI + 'seen'), f.literal('yes'))] })
    s.app.flush()
    await s.settled()
    const [surface] = s.surfaces()
    expect(surface!.isConnected).toBe(true)
    expect(s.open.has(surface!)).toBe(true)
    expect(s.surfaces().length).toBe(1)
    expect(zone.getAttribute('aria-describedby')).toBe(surface!.id)
  })

  it('a scrolling list: no longer inside its overflow, next to what is in sight of a tall zone, gone when scrolled out', async () => {
    const s = await shelves()
    await s.lift('Write notes')
    await s.over(1)
    const zone = s.list('bugs')
    const surface = s.surfaces()[0]!
    // The list holding the zone scrolls: the surface is not in it, whatever the zone's ancestors do.
    expect(zone.contains(surface)).toBe(false)
    const scroller = zone.parentElement!
    s.scrollers.add(scroller)
    s.boxes.set(scroller, { top: 200, left: 100, width: 400, height: 200 })

    // The zone starts far above what the list shows: the reason is above the part in sight.
    s.boxes.set(zone, { top: -500, left: 200, width: 180, height: 800 })
    expect((await reposition(s)).style.top).toBe('164px')
    expect(s.surfaces()[0]!.style.visibility).toBe('')

    // Scrolled out of the list: hidden, and back when it returns.
    s.boxes.set(zone, { top: -900, left: 200, width: 180, height: 800 })
    expect((await reposition(s)).style.visibility).toBe('hidden')
    s.boxes.set(zone, { top: 220, left: 200, width: 180, height: 40 })
    expect((await reposition(s)).style.visibility).toBe('')
    expect(s.surfaces()[0]!.style.top).toBe('184px')
  })

  it('a zone that fills the viewport: over it, at the top of what is in sight, not off the page', async () => {
    const s = await shelves()
    const zone = s.list('bugs')
    s.boxes.set(zone, { top: -100, left: 0, width: 800, height: 900 })
    await s.lift('Write notes')
    // Over the zone by the fake layout's hit test; its box is what placement reads.
    await s.over(1)
    const surface = s.surfaces()[0]!
    expect(surface.style.top).toBe('8px')
    expect(surface.style.left).toBe('340px')
    expect(surface.style.maxHeight).toBe('584px')
  })

  it('right to left: the surface says so and still centres on the zone', async () => {
    const s = await shelves('sparql', { rtl: true })
    await s.lift('Write notes')
    await s.over(1)
    expect(s.surfaces()[0]!.getAttribute('dir')).toBe('rtl')
    expect(s.surfaces()[0]!.style.left).toBe('230px')
  })

  it('the rules say the same either way, and showing it changes nothing they render', async () => {
    const said: unknown[] = []
    for (const prefer of ['sparql', 'function'] as const) {
      const s = await shelves(prefer)
      await s.lift('Write notes')
      await s.over(1)
      const zone = s.list('bugs')
      said.push([zone.getAttribute('data-sem-drop'), zone.getAttribute('data-sem-drop-reason'), s.surfaces()[0]!.textContent, s.live()])
    }
    expect(said[0]).toEqual(['refuses', 'Only bugs go here.', 'Only bugs go here.', 'Write notes: Bugs refuses it: Only bugs go here.'])
    expect(said[1]).toEqual(said[0])
  })

  it('the cost of showing it: no write, no rule run, no search of the page', async () => {
    const s = await shelves()
    await s.lift('Write notes')
    await s.over(2)
    await s.over(1)
    const engine = s.app.projection.engine
    const before = { runs: JSON.stringify(engine.stats), ops: s.app.renderer.ops }
    const writes = vi.spyOn(s.app.runtime, 'apply')
    const queryAll = vi.spyOn(s.element, 'querySelectorAll')
    const query = vi.spyOn(s.element, 'querySelector')
    // The rules' marks on the zone, again, as the DOM patch writes them: the surface goes and comes back.
    const zone = s.list('bugs')
    for (let i = 0; i < 20; i++) {
      zone.removeAttribute('data-sem-drop-over')
      await s.settled()
      expect(s.surfaces()).toEqual([])
      zone.setAttribute('data-sem-drop-over', '')
      await s.settled()
      expect(s.surfaces().length).toBe(1)
    }
    expect(writes).not.toHaveBeenCalled()
    expect(queryAll).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    expect(JSON.stringify(engine.stats)).toBe(before.runs)
    expect(s.app.renderer.ops).toBe(before.ops)
  })

  it('the theme: the ::after stands down under the effect, and the surface has the look', async () => {
    const store = loadStore('wat', graph)
    const css = compileStyles(store)
    expect(css).toContain(':not([data-sem-drop-reasons] *)[data-sem-drop-zone][data-sem-drop=refuses][data-sem-drop-over]::after')
    expect(css).toMatch(/\.sem-drop-reason[^{]*\{[^}]*pointer-events: ?none/)
    expect(css).not.toMatch(/(^|[\s,}])\[data-sem-drop-zone\]\[data-sem-drop=refuses\]\[data-sem-drop-over\]::after/)
  })
})

/** Have the anchored panels place it again, as a scroll does; the surface stays the same element. */
async function reposition(s: Awaited<ReturnType<typeof shelves>>) {
  s.document.dispatchEvent(new s.window.Event('scroll'))
  for (const frame of s.frames.splice(0)) frame(0)
  await s.settled()
  return s.surfaces()[0]!
}
