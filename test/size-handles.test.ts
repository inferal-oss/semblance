import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { attachSizeHandles } from '../src/web/size-handles.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const c = NS.c

/** What linkedom does not do: boxes, computed styles, observers and frames, all in the test's hands. */
function page(prefer: 'sparql' | 'function', group: string) {
  const h = mountShell(5, 'wat', prefer)
  const f = h.store.factory
  h.showPage('Components')
  const app = f.namedNode(UI + 'app')
  const groupOf = f.namedNode(UI + 'galleryGroup')
  h.runtime.apply({ remove: h.store.match(app, groupOf, null), add: [f.quad(app, groupOf, f.namedNode(UI + group))] })
  h.shell.flush()
  const win = h.window as unknown as Record<string, unknown>
  const frames: (() => void)[] = []
  win.requestAnimationFrame = (cb: () => void) => frames.push(cb)
  win.cancelAnimationFrame = () => {}
  const observers: { fire: (el: Element) => void; watched: Set<Element> }[] = []
  win.ResizeObserver = class {
    watched = new Set<Element>()
    constructor(private cb: (entries: { target: Element }[]) => void) {
      observers.push(this as unknown as (typeof observers)[number])
    }
    fire(el: Element) {
      if (this.watched.has(el)) this.cb([{ target: el }])
    }
    observe(el: Element) {
      this.watched.add(el)
    }
    unobserve(el: Element) {
      this.watched.delete(el)
    }
    disconnect() {
      this.watched.clear()
    }
  }
  let style: (el: Element) => Record<string, string> = () => ({ position: 'static', direction: 'ltr' })
  win.getComputedStyle = (el: Element) => style(el)
  const view = (width: number, height: number) => {
    Object.defineProperty(h.document.documentElement, 'clientWidth', { configurable: true, value: width })
    Object.defineProperty(h.document.documentElement, 'clientHeight', { configurable: true, value: height })
  }
  /** Its size as laid out, and (for one scaling in) what it looks like meanwhile. */
  const box = (el: Element, width: number, height: number, looks = 1) => {
    Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width })
    Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height })
    ;(el as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ width: width * looks, height: height * looks, top: 0, left: 0, right: width, bottom: height })
  }
  const node = (iri: string) => ([...h.document.querySelectorAll('*')].find((el) => h.shell.keyOf(el) === iri) ?? null) as HTMLElement | null
  const root = (local: string) => node(`${UI}${local}/~root`)!
  const handle = (local: string) => root(local).querySelector(':scope > .sem-dock-handle') as HTMLElement
  const fact = (local: string, p: string) => h.store.match(f.namedNode(UI + local), f.namedNode(c + p), null)[0]?.object.value
  const edge = (local: string, to: string) => {
    const s = f.namedNode(UI + local)
    const p = f.namedNode(c + 'attachedTo')
    h.runtime.apply({ remove: h.store.match(s, p, null), add: [f.quad(s, p, f.namedNode(c + to))] })
    h.shell.flush()
  }
  /** What is due: the observers' records, then the frame. */
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0))
    for (const run of frames.splice(0)) run()
  }
  const said = (el: Element) => ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'].map((n) => el.getAttribute(n))
  const open = (button: string) => {
    h.fire(root(button), 'click')
    h.shell.flush()
  }
  return { ...h, frames, observers, view, box, root, handle, fact, edge, settle, said, open, styled: (s: typeof style) => (style = s) }
}

/** The side panel, docked, on a 375 by 812 phone: the theme's caps are 80vw across, 70vh and 50dvh along. */
async function phone(prefer: 'sparql' | 'function') {
  const p = page(prefer, 'GroupWindows')
  p.open('wn-open-side')
  p.view(375, 812)
  const caps: Record<string, { maxWidth: string; maxHeight: string }> = {
    end: { maxWidth: '300px', maxHeight: 'none' },
    start: { maxWidth: '300px', maxHeight: 'none' },
    top: { maxWidth: 'none', maxHeight: '568.4px' },
    bottom: { maxWidth: 'none', maxHeight: '406px' },
  }
  p.styled((el) => ({ position: 'fixed', direction: 'ltr', ...caps[el.getAttribute('data-sem-edge') ?? 'end'] }))
  p.box(p.root('win-side'), 300, 812)
  return p
}

for (const prefer of ['sparql', 'function'] as const) {
  describe(`a size handle says what is drawn (${prefer})`, () => {
    it('a docked frame on a phone: the frame the theme capped, not the size the graph asks for', async () => {
      const p = await phone(prefer)
      // The rendering can only say what the graph asks for.
      expect(p.said(p.handle('win-side'))).toEqual(['360', '240', '720'])
      const stop = attachSizeHandles(p.shell)
      await p.settle()
      expect(p.said(p.handle('win-side'))).toEqual(['300', '240', '300'])
      // The graph keeps what it asked for, for when there is room, and the bounds the gesture reads.
      expect(p.fact('win-side', 'width')).toBe('360')
      expect(p.root('win-side').getAttribute('style')).toContain('width: 360px')
      expect(p.handle('win-side').getAttribute('data-sem-max')).toBe('720')
      stop()
    })

    it('on every edge, and when it moves to another edge whose cap is different with the same box', async () => {
      const p = await phone(prefer)
      const stop = attachSizeHandles(p.shell)
      await p.settle()
      for (const [to, width, height, said] of [
        ['StartEdge', 300, 812, ['300', '240', '300']],
        ['TopEdge', 375, 300, ['300', '240', '568']],
        ['BottomEdge', 375, 300, ['300', '240', '406']],
        ['EndEdge', 300, 812, ['300', '240', '300']],
      ] as const) {
        p.box(p.root('win-side'), width, height)
        p.edge('win-side', to)
        await p.settle()
        expect(p.said(p.handle('win-side'))).toEqual(said)
      }
      stop()
    })

    it('on a screen too narrow for its least size, the least it says is what it can be', async () => {
      const p = await phone(prefer)
      p.view(280, 600)
      p.styled(() => ({ position: 'fixed', direction: 'ltr', maxWidth: '224px', maxHeight: 'none' }))
      p.box(p.root('win-side'), 224, 600)
      const stop = attachSizeHandles(p.shell)
      await p.settle()
      expect(p.said(p.handle('win-side'))).toEqual(['224', '224', '224'])
      stop()
    })

    it('follows the box and the viewport, and comes back to the graph\'s size when there is room', async () => {
      const p = await phone(prefer)
      const stop = attachSizeHandles(p.shell)
      await p.settle()
      // The viewport grows: the cap moves, and with it the box.
      p.view(1280, 800)
      p.styled(() => ({ position: 'fixed', direction: 'ltr', maxWidth: '1024px', maxHeight: 'none' }))
      p.window.dispatchEvent(new p.window.Event('resize'))
      await p.settle()
      expect(p.said(p.handle('win-side'))).toEqual(['300', '240', '720'])
      p.box(p.root('win-side'), 360, 800)
      for (const o of p.observers) o.fire(p.root('win-side'))
      await p.settle()
      expect(p.said(p.handle('win-side'))).toEqual(['360', '240', '720'])
      stop()
    })

    it('corrects what a new rendering says, then the next key starts from the box', async () => {
      const p = await phone(prefer)
      const stop = attachSizeHandles(p.shell)
      await p.settle()
      const key = (k: string) => {
        const e = new p.window.Event('keydown', { bubbles: true, cancelable: true }) as Event & { key: string }
        Object.defineProperty(e, 'key', { value: k })
        p.handle('win-side').dispatchEvent(e)
        p.shell.flush()
      }
      // Scaling in, it looks 288 wide; it is 300.
      p.box(p.root('win-side'), 300, 812, 0.96)
      key('ArrowRight')
      expect(p.fact('win-side', 'width')).toBe('284')
      p.box(p.root('win-side'), 284, 812)
      await p.settle()
      expect(p.said(p.handle('win-side'))).toEqual(['284', '240', '300'])
      stop()
    })

    it('a dock panel in the flow: at most the room there is, where the theme says only 100%', async () => {
      const p = page(prefer, 'GroupLayout')
      p.styled((el) => ({ position: 'sticky', direction: 'ltr', maxWidth: el.getAttribute('data-sem-edge') === 'end' ? '100%' : 'none', maxHeight: 'none' }))
      const end = p.root('ly-dock-end-panel')
      p.box(end, 177, 300)
      p.box(end.parentElement!, 227, 300)
      const bottom = p.root('ly-dock-panel')
      p.box(bottom, 375, 220)
      p.box(bottom.parentElement!, 375, 445)
      expect(p.said(p.handle('ly-dock-end-panel'))).toEqual(['240', '160', '4096'])
      const stop = attachSizeHandles(p.shell)
      await p.settle()
      expect(p.said(p.handle('ly-dock-end-panel'))).toEqual(['177', '160', '227'])
      expect(p.said(p.handle('ly-dock-panel'))).toEqual(['220', '120', '445'])
      stop()
    })

    it('a divider says its pane\'s share, and a column with no width of its own what it came to', async () => {
      const layout = page(prefer, 'GroupLayout')
      const split = layout.root('ly-split-view')
      const divider = split.querySelector(':scope > .sem-divider') as HTMLElement
      layout.box(split, 887, 192)
      layout.box(divider.previousElementSibling!, 354, 190)
      const stop = attachSizeHandles(layout.shell)
      await layout.settle()
      expect(layout.said(divider)).toEqual(['40', '0', '100'])
      // A share is of what they divide, when the height leaves the ratio nothing to take a share of.
      layout.box(divider.previousElementSibling!, 142, 190)
      for (const o of layout.observers) o.fire(divider.previousElementSibling!)
      await layout.settle()
      expect(layout.said(divider)).toEqual(['16', '0', '100'])
      stop()

      const data = page(prefer, 'GroupData')
      const free = [...data.document.querySelectorAll<HTMLElement>('.sem-resize[role=separator]')].find((h) => !h.hasAttribute('aria-valuenow'))!
      data.box(free.closest('th')!, 605, 36)
      const stopData = attachSizeHandles(data.shell)
      await data.settle()
      expect(free.getAttribute('aria-valuenow')).toBe('605')
      expect(free.hasAttribute('aria-valuemax')).toBe(false)
      stopData()
    })

    it('leaves a box that is not shown, or a page with no observers, to what the rendering said', async () => {
      const p = await phone(prefer)
      p.box(p.root('win-side'), 0, 0)
      const stop = attachSizeHandles(p.shell)
      await p.settle()
      expect(p.said(p.handle('win-side'))).toEqual(['360', '240', '720'])
      stop()
      delete (p.window as unknown as Record<string, unknown>).ResizeObserver
      p.box(p.root('win-side'), 300, 812)
      attachSizeHandles(p.shell)()
      await p.settle()
      expect(p.said(p.handle('win-side'))).toEqual(['360', '240', '720'])
    })

    it('stops when asked, and follows only the handles there are', async () => {
      const p = await phone(prefer)
      const stop = attachSizeHandles(p.shell)
      await p.settle()
      const watching = () => p.observers.reduce((n, o) => n + o.watched.size, 0)
      expect(watching()).toBe(2)
      // Floating, the frame has no handle: nothing is left watched.
      const f = p.store.factory
      const s = f.namedNode(UI + 'win-side')
      p.runtime.apply({ remove: p.store.match(s, f.namedNode(c + 'attachedTo'), null), add: [] })
      p.shell.flush()
      await p.settle()
      expect(watching()).toBe(0)
      stop()
      expect(p.frames.length).toBe(0)
    })
  })
}
