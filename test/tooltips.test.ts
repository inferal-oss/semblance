import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, SEM } from '../src/ns.ts'
import { toHTML, toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'
import { attachAnchoredPopups } from '../src/web/anchored-popups.ts'
import { DEFAULT_LAYERS, mount, type MountedApp } from '../src/web/mount.ts'

// The tooltip layer's host side (src/web/tooltips.ts) on a mounted graph: sem:tooltip stays the
// source, the surface is an anchored panel, and showing one costs nothing but the surface.

const UI = 'https://example.org/ui#'
const graph = `
@prefix ui: <${UI}> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sty: <https://semblance.dev/ns/style#> .
ui:root a c:Stack ; c:children ( ui:edit ui:add ui:note ) .
ui:edit a c:IconButton ; c:icon "✎" ; c:label "Edit" .
ui:add a c:IconButton ; c:icon "+" ; c:label "Add" .
ui:note a c:Text ; c:label "A note" .
`
const apps: MountedApp[] = []

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

type Box = { top: number; left: number; width: number; height: number }

/** A page with a layout the test decides: where the sources are and how big the viewport is. */
function page({ html = '<div id="app"></div>', rtl = false, viewport = { width: 480, height: 600 } } = {}) {
  const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
  class Sheet { replaceSync() {} }
  Object.defineProperty(window, 'CSSStyleSheet', { value: Sheet, configurable: true })
  document.adoptedStyleSheets = []
  const frames: FrameRequestCallback[] = []
  Object.defineProperty(window, 'requestAnimationFrame', { value: (f: FrameRequestCallback) => frames.push(f), configurable: true })
  Object.defineProperty(window, 'cancelAnimationFrame', { value: () => {}, configurable: true })
  Object.defineProperty(document.documentElement, 'clientWidth', { value: viewport.width, configurable: true })
  Object.defineProperty(document.documentElement, 'clientHeight', { value: viewport.height, configurable: true })
  const computed = {
    direction: rtl ? 'rtl' : 'ltr', overflowX: 'visible', overflowY: 'visible', maxHeight: 'none',
    getPropertyValue: (p: string) => (p === '--sem-tooltip-bg' ? 'light-dark(#111, #eee)' : p === 'color-scheme' ? 'dark' : ''),
  }
  const getComputedStyle = vi.fn(() => computed)
  Object.defineProperty(window, 'getComputedStyle', { value: getComputedStyle, configurable: true })
  vi.stubGlobal('requestIdleCallback', () => 0)
  vi.stubGlobal('fetch', async () => new Response(readFileSync(new URL('../rdf-engine/build/wat.wasm', import.meta.url)), { headers: { 'Content-Type': 'application/wasm' } }))
  // Layout: anything not told otherwise is a 100x30 box in the top left; the surface is 200x40.
  const boxes = new Map<Element, Box>()
  const proto = window.HTMLElement.prototype as HTMLElement & { showPopover(): void; hidePopover(): void }
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const b = boxes.get(this) ?? (this.matches('.sem-tooltip') ? { top: 0, left: 0, width: 200, height: 40 } : { top: 0, left: 0, width: 100, height: 30 })
    return { ...b, bottom: b.top + b.height, right: b.left + b.width } as DOMRect
  }
  const open = new Set<Element>()
  const matches = proto.matches
  proto.showPopover = function (this: HTMLElement) { open.add(this) }
  proto.hidePopover = function (this: HTMLElement) { open.delete(this) }
  proto.matches = function (this: HTMLElement, selector: string) {
    if (selector === ':popover-open') return open.has(this)
    if (selector === ':focus-visible') return true
    return matches.call(this, selector)
  } as typeof proto.matches
  // What the pointer rests on at takeover: nothing, unless a test says so (linkedom ignores :hover).
  const queryAll = proto.querySelectorAll
  proto.querySelectorAll = function (this: HTMLElement, selector: string) {
    return selector.endsWith(':hover') ? ([] as unknown as NodeListOf<Element>) : queryAll.call(this, selector)
  } as typeof proto.querySelectorAll
  return { document, window, element: document.getElementById('app')!, boxes, open, frames, getComputedStyle }
}

async function app(opts: Parameters<typeof page>[0] = {}, prefer: 'sparql' | 'function' = 'sparql', extra = '') {
  const p = page(opts)
  const mounted = await mount(p.element, { root: UI + 'root', graphs: [graph, extra], store: 'wat', prefer, files: false, fullscreen: false })
  apps.push(mounted)
  const source = (id: string) => mounted.renderer.nodeOf(`${UI}${id}/~root`) as HTMLElement
  return { ...p, app: mounted, source, surface: () => p.element.querySelector<HTMLElement>('.sem-tooltip') }
}

function fire(target: EventTarget, window: Window & typeof globalThis, type: string, init: Record<string, unknown> = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { pointerType: 'mouse', buttons: 0, clientX: 0, clientY: 0, relatedTarget: null }, init)
  target.dispatchEvent(event)
  return event
}
const settled = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)))
const quads = (m: MountedApp) => m.store.match(null, null, null).length

describe('tooltip surface', () => {
  it('sem:tooltip stays the source: the rendered attributes do not change, and the ::after stands down under the effect', async () => {
    const t = await app()
    expect(t.source('edit').getAttribute('data-sem-tooltip')).toBe('Edit')
    expect(t.source('edit').getAttribute('aria-description')).toBe('Edit')
    expect(t.element.hasAttribute('data-sem-tooltips')).toBe(true)
    expect(t.surface()).toBeNull()
    t.app.unmount()
    expect(t.element.hasAttribute('data-sem-tooltips')).toBe(false)
  })

  it('hover shows one surface in the top layer, above the source, centred, and leaving hides it', async () => {
    const t = await app()
    const edit = t.source('edit')
    t.boxes.set(edit, { top: 200, left: 150, width: 100, height: 30 })
    const before = quads(t.app)
    fire(edit, t.window, 'pointerover')
    const surface = t.surface()!
    expect(surface.textContent).toBe('Edit')
    expect(surface.getAttribute('role')).toBe('tooltip')
    expect(surface.getAttribute('popover')).toBe('manual')
    expect(t.open.has(surface)).toBe(true)
    expect(surface.style.position).toBe('fixed')
    expect(surface.style.left).toBe('100px')
    expect(surface.style.top).toBe('154px')
    // Where the source is decides how it looks: a theme may be set on any subtree.
    expect(surface.style.getPropertyValue('--sem-tooltip-bg')).toBe('light-dark(#111, #eee)')
    expect(surface.style.getPropertyValue('color-scheme')).toBe('dark')
    expect(surface.getAttribute('dir')).toBe('ltr')
    // The accessible description: always there, and tied to the surface while it shows.
    expect(edit.getAttribute('aria-description')).toBe('Edit')
    expect(edit.getAttribute('aria-describedby')).toBe(surface.id)

    // On to another source: still one surface. It is out of the way of the pointer.
    fire(t.source('add'), t.window, 'pointerover')
    expect(t.element.querySelectorAll('.sem-tooltip').length).toBe(1)
    expect(t.surface()!.textContent).toBe('Add')
    expect(edit.hasAttribute('aria-describedby')).toBe(false)

    // Over something without a tooltip, then out of the page.
    fire(t.source('note'), t.window, 'pointerover')
    expect(t.surface()).toBeNull()
    fire(t.source('add'), t.window, 'pointerover')
    fire(t.source('add'), t.window, 'pointerout', { relatedTarget: null })
    expect(t.surface()).toBeNull()
    // Hovering is the browser's state, not the graph's.
    expect(quads(t.app)).toBe(before)
  })

  it('stays within the viewport: clamped at the sides and below the source without room above', async () => {
    const t = await app({ viewport: { width: 320, height: 600 } })
    const edit = t.source('edit')
    t.boxes.set(edit, { top: 4, left: 280, width: 30, height: 30 })
    fire(edit, t.window, 'pointerover')
    expect(t.surface()!.style.left).toBe('112px')
    expect(t.surface()!.style.top).toBe('40px')
    t.boxes.set(edit, { top: 300, left: 2, width: 30, height: 30 })
    fire(edit, t.window, 'pointerout', { relatedTarget: null })
    fire(edit, t.window, 'pointerover')
    expect(t.surface()!.style.left).toBe('8px')
    expect(t.surface()!.style.top).toBe('254px')
  })

  it('right to left: the surface says so and still centres on its source', async () => {
    const t = await app({ rtl: true })
    t.boxes.set(t.source('edit'), { top: 200, left: 150, width: 100, height: 30 })
    fire(t.source('edit'), t.window, 'pointerover')
    expect(t.surface()!.getAttribute('dir')).toBe('rtl')
    expect(t.surface()!.style.left).toBe('100px')
  })

  it('keyboard focus shows it, leaving hides it; a focus the page does not show (a click) does not', async () => {
    const t = await app()
    const edit = t.source('edit')
    const proto = t.window.HTMLElement.prototype as HTMLElement
    const matches = proto.matches
    let visible = true
    proto.matches = function (this: HTMLElement, s: string) { return s === ':focus-visible' ? visible : matches.call(this, s) } as typeof proto.matches
    fire(edit, t.window, 'focusin')
    expect(t.surface()!.textContent).toBe('Edit')
    expect(edit.getAttribute('aria-describedby')).toBe(t.surface()!.id)
    fire(edit, t.window, 'focusout')
    expect(t.surface()).toBeNull()
    visible = false
    fire(edit, t.window, 'focusin')
    expect(t.surface()).toBeNull()
  })

  it('with both, the latest shows, and leaving it goes back to what still asks', async () => {
    const t = await app()
    fire(t.source('edit'), t.window, 'focusin')
    fire(t.source('add'), t.window, 'pointerover')
    expect(t.surface()!.textContent).toBe('Add')
    fire(t.source('add'), t.window, 'pointerout', { relatedTarget: null })
    expect(t.surface()!.textContent).toBe('Edit')
  })

  it('Escape dismisses it without keeping the key from anyone, until the source is left', async () => {
    const t = await app()
    const edit = t.source('edit')
    fire(edit, t.window, 'pointerover')
    const key = fire(edit, t.window, 'keydown', { key: 'Escape' })
    expect(t.surface()).toBeNull()
    expect(key.defaultPrevented).toBe(false)
    // Moving within the source does not bring it back; leaving and coming back does.
    fire(edit, t.window, 'pointerover')
    expect(t.surface()).toBeNull()
    fire(edit, t.window, 'pointerout', { relatedTarget: null })
    fire(edit, t.window, 'pointerover')
    expect(t.surface()!.textContent).toBe('Edit')
  })

  it('pressing the source dismisses it, and a drag across sources asks nothing', async () => {
    const t = await app()
    const edit = t.source('edit')
    fire(edit, t.window, 'pointerover')
    fire(edit, t.window, 'pointerdown')
    expect(t.surface()).toBeNull()
    fire(t.source('add'), t.window, 'pointerover', { buttons: 1 })
    expect(t.surface()).toBeNull()
  })

  it('printing dismisses it', async () => {
    const t = await app()
    fire(t.source('edit'), t.window, 'pointerover')
    t.window.dispatchEvent(new t.window.Event('beforeprint'))
    expect(t.surface()).toBeNull()
  })

  it('follows its source on scroll and resize, and hides when it is scrolled out of its container', async () => {
    const t = await app()
    const edit = t.source('edit')
    t.boxes.set(edit, { top: 200, left: 150, width: 100, height: 30 })
    fire(edit, t.window, 'pointerover')
    t.boxes.set(edit, { top: 120, left: 150, width: 100, height: 30 })
    fire(t.document, t.window, 'scroll')
    t.frames.splice(0).forEach((f) => f(0))
    expect(t.surface()!.style.top).toBe('74px')
    t.boxes.set(edit, { top: 120, left: 60, width: 100, height: 30 })
    t.window.dispatchEvent(new t.window.Event('resize'))
    t.frames.splice(0).forEach((f) => f(0))
    expect(t.surface()!.style.left).toBe('10px')

    // The scroller it sits in has moved it out of sight.
    const scroller = edit.parentElement!
    t.boxes.set(scroller, { top: 400, left: 0, width: 400, height: 100 })
    const scrolled = t.getComputedStyle.getMockImplementation()!
    t.getComputedStyle.mockImplementation(((el: Element) => ({ ...scrolled(), overflowY: el === scroller ? 'auto' : 'visible', overflowX: el === scroller ? 'auto' : 'visible' })) as never)
    fire(scroller, t.window, 'scroll')
    t.frames.splice(0).forEach((f) => f(0))
    expect(t.surface()!.style.visibility).toBe('hidden')
    // A source that is not laid out (display: none on the way up) has nothing to be next to.
    t.getComputedStyle.mockImplementation(scrolled)
    t.boxes.set(edit, { top: 0, left: 0, width: 0, height: 0 })
    t.window.dispatchEvent(new t.window.Event('resize'))
    t.frames.splice(0).forEach((f) => f(0))
    expect(t.surface()!.style.visibility).toBe('hidden')
  })

  it('removal of the source in the graph takes the tooltip with it, as does losing the annotation', async () => {
    const t = await app()
    const { store, runtime } = t.app
    const f = store.factory
    const edit = t.source('edit')
    fire(edit, t.window, 'pointerover')
    expect(t.surface()).not.toBeNull()
    runtime.apply({ remove: store.match(f.namedNode(UI + 'edit'), null, null), add: [] })
    t.app.flush()
    await settled()
    expect(edit.isConnected).toBe(false)
    expect(t.surface()).toBeNull()
    expect(t.element.querySelectorAll('.sem-tooltip').length).toBe(0)
  })

  it('a change to what the graph says reaches a shown tooltip', async () => {
    const t = await app()
    const { store, runtime } = t.app
    const f = store.factory
    fire(t.source('edit'), t.window, 'pointerover')
    const label = f.namedNode('https://semblance.dev/ns/component#label')
    runtime.apply({ remove: store.match(f.namedNode(UI + 'edit'), label, null), add: [f.quad(f.namedNode(UI + 'edit'), label, f.literal('Rewrite'))] })
    t.app.flush()
    await settled()
    expect(t.surface()!.textContent).toBe('Rewrite')
    expect(t.source('edit').getAttribute('aria-description')).toBe('Rewrite')
  })

  it('touch: a tap on a control leaves nothing behind, a long press shows it, the next touch hides it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = await app()
    const edit = t.source('edit')
    const touch = { pointerType: 'touch' }
    fire(edit, t.window, 'pointerover', touch)
    fire(edit, t.window, 'pointerdown', touch)
    fire(edit, t.window, 'pointerup', touch)
    vi.advanceTimersByTime(1000)
    expect(t.surface()).toBeNull()

    fire(edit, t.window, 'pointerdown', touch)
    vi.advanceTimersByTime(499)
    expect(t.surface()).toBeNull()
    vi.advanceTimersByTime(1)
    expect(t.surface()!.textContent).toBe('Edit')
    fire(edit, t.window, 'pointerup', touch)
    expect(t.surface()).not.toBeNull()
    fire(t.source('note'), t.window, 'pointerdown', touch)
    expect(t.surface()).toBeNull()

    // A scroll takes the finger over: the browser cancels the press.
    fire(edit, t.window, 'pointerdown', touch)
    fire(edit, t.window, 'pointercancel', touch)
    vi.advanceTimersByTime(1000)
    expect(t.surface()).toBeNull()
    // So does moving away, for what handles its own drags.
    fire(edit, t.window, 'pointerdown', { ...touch, clientX: 0 })
    fire(edit, t.window, 'pointermove', { ...touch, clientX: 20 })
    vi.advanceTimersByTime(1000)
    expect(t.surface()).toBeNull()
  })

  it('touch: a tap on what a tap does nothing else to toggles it, and a tap on a field is not keyboard focus', async () => {
    const t = await app()
    const note = t.source('note')
    note.setAttribute('data-sem-tooltip', 'About the note')
    const touch = { pointerType: 'touch' }
    fire(note, t.window, 'pointerdown', touch)
    fire(note, t.window, 'pointerup', touch)
    expect(t.surface()!.textContent).toBe('About the note')
    fire(note, t.window, 'pointerdown', touch)
    fire(note, t.window, 'pointerup', touch)
    expect(t.surface()).toBeNull()

    const edit = t.source('edit')
    fire(edit, t.window, 'pointerdown', touch)
    fire(edit, t.window, 'pointerup', touch)
    fire(edit, t.window, 'focusin')
    expect(t.surface()).toBeNull()
    // A key on a hardware keyboard: the focus is the keyboard's again.
    fire(edit, t.window, 'keydown', { key: 'Tab' })
    fire(edit, t.window, 'focusin')
    expect(t.surface()!.textContent).toBe('Edit')
  })

  it('a region not yet taken over keeps the ::after: the effect leaves it alone', async () => {
    const t = await app()
    const add = t.source('add')
    add.parentElement!.setAttribute('data-sem-ssr', '')
    fire(add, t.window, 'pointerover')
    expect(t.surface()).toBeNull()
    add.parentElement!.removeAttribute('data-sem-ssr')
    fire(t.source('note'), t.window, 'pointerover')
    fire(add, t.window, 'pointerover')
    expect(t.surface()!.textContent).toBe('Add')
  })

  it('foreign content is not the effect\'s, and a source inside it does not count as hovered', () => {
    const p = page({ html: '<main id="app"><button id="mine" data-sem-tooltip="Mine"></button><div data-sem-c="sem-island"><button id="theirs" data-sem-tooltip="Theirs"></button></div></main>' })
    const dispose = attachAnchoredPopups(p.element)
    fire(p.document.getElementById('mine')!, p.window, 'pointerover')
    expect(p.element.querySelector('.sem-tooltip')!.textContent).toBe('Mine')
    fire(p.document.getElementById('theirs')!, p.window, 'pointerover')
    expect(p.element.querySelector('.sem-tooltip')).toBeNull()
    fire(p.document.getElementById('mine')!, p.window, 'pointerover')
    dispose()
    expect(p.element.querySelector('.sem-tooltip')).toBeNull()
    expect(p.document.getElementById('mine')!.hasAttribute('aria-describedby')).toBe(false)
    expect(p.element.hasAttribute('data-sem-tooltips')).toBe(false)
    fire(p.document.getElementById('mine')!, p.window, 'pointerout', { relatedTarget: null })
    fire(p.document.getElementById('mine')!, p.window, 'pointerover')
    expect(p.element.querySelector('.sem-tooltip')).toBeNull()
  })

  it('takes over a tooltip the ::after was showing, under a resting pointer', async () => {
    const p = page()
    const proto = p.window.HTMLElement.prototype as HTMLElement
    const queryAll = proto.querySelectorAll
    proto.querySelectorAll = function (this: HTMLElement, selector: string) {
      if (!selector.endsWith(':hover')) return queryAll.call(this, selector)
      return [...queryAll.call(this, '[data-sem-tooltip]')].slice(0, 1) as unknown as NodeListOf<Element>
    } as typeof proto.querySelectorAll
    const mounted = await mount(p.element, { root: UI + 'root', graphs: [graph], store: 'wat', files: false, fullscreen: false })
    apps.push(mounted)
    expect(p.element.querySelector('.sem-tooltip')!.textContent).toBe('Edit')
  })

  it('the cost of showing one: no rule runs, no write, no search of the page, a single surface', async () => {
    const t = await app()
    const engine = t.app.projection.engine
    const before = { quads: quads(t.app), runs: JSON.stringify(engine.stats), ops: t.app.renderer.ops, nodes: t.element.querySelectorAll('*').length }
    const queryAll = vi.spyOn(t.element, 'querySelectorAll')
    const query = vi.spyOn(t.element, 'querySelector')
    const writes = vi.spyOn(t.app.runtime, 'apply')
    const edit = t.source('edit')
    for (let i = 0; i < 20; i++) {
      fire(edit, t.window, 'pointerover')
      fire(edit, t.window, 'pointerout', { relatedTarget: null })
    }
    fire(edit, t.window, 'pointerover')
    await settled()
    expect(writes).not.toHaveBeenCalled()
    expect(queryAll).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    queryAll.mockRestore()
    query.mockRestore()
    expect(quads(t.app)).toBe(before.quads)
    expect(JSON.stringify(engine.stats)).toBe(before.runs)
    expect(t.app.renderer.ops).toBe(before.ops)
    expect(t.element.querySelectorAll('*').length).toBe(before.nodes + 1)
    // Reading where a source is costs what its ancestors cost, and nothing grows with the page.
    t.getComputedStyle.mockClear()
    fire(edit, t.window, 'pointerout', { relatedTarget: null })
    fire(edit, t.window, 'pointerover')
    let depth = 0
    for (let e: Element | null = edit; e; e = e.parentElement) depth++
    expect(t.getComputedStyle.mock.calls.length).toBeLessThanOrEqual(depth + 4)
  })
})

describe('tooltip parity and other surfaces', () => {
  it('the SPARQL rule and its function twin render the same bytes, before and after showing one', async () => {
    const [a, b] = [await app({}, 'sparql'), await app({}, 'function')]
    const html = (t: typeof a) => t.element.innerHTML
    expect(html(a)).toContain('data-sem-tooltip="Edit"')
    expect(html(a)).toBe(html(b))
    for (const t of [a, b]) {
      fire(t.source('edit'), t.window, 'pointerover')
      fire(t.source('edit'), t.window, 'pointerout', { relatedTarget: null })
    }
    await settled()
    expect(html(a)).toBe(html(b))
    expect(html(a)).not.toContain('sem-tooltip"')
    expect(html(a)).not.toContain('aria-describedby')
  })

  it('first paint carries the attributes and the ::after; text shows no tooltip; only the screen does', () => {
    const store = loadStore('wat', graph)
    const css = compileStyles(store)
    expect(css).toMatch(/:where\(:not\(\[data-sem-tooltips\] \*\), \[data-sem-tooltips\] \[data-sem-ssr\] \*\)\[data-sem-tooltip\]:is\(:hover, :focus-visible\)::after\s*\{[^}]*content:\s*attr\(data-sem-tooltip\)/)
    expect(css).toMatch(/\.sem-tooltip\s*\{[^}]*position:\s*fixed/)
    const runtime = new Runtime(store)
    const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, prefer: 'sparql', name: 'screen', roots: [UI + 'root'] }, (e) => { throw e })
    const served = toHTML(screen.index, UI + 'root')
    expect(served).toContain('data-sem-tooltip="Edit"')
    expect(served).toContain('aria-description="Edit"')
    expect(served).not.toContain('sem-tooltip"')
    const text = runtime.project({ modality: MOD.Text, layers: DEFAULT_LAYERS, prefer: 'sparql', name: 'text', roots: [UI + 'root'] }, (e) => { throw e })
    expect(toText(text.index, UI + 'root')).not.toContain('data-sem-tooltip')
    // The annotation stays in the graph; only the screen's layer projects it.
    expect(store.match(null, store.factory.namedNode(SEM.tooltip), null).length).toBeGreaterThan(0)
    runtime.dispose()
  })
})
