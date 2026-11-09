// What sticks to the top sticks below the app bar as the page lays it out, from the first paint
// (#428): a server-rendered page measures the bar in its head (STICKY_TOP_SCRIPT), and the client
// follows it from then on (attachStickyTop), both alike (stickyTopOf). Measured only after the
// take-over, a side column was laid out at the stylesheet's fallback (a bar of two rows) and jumped
// up by the difference on every load wherever the bar has one row.
import { describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { documentParts, renderDocument } from '../src/server/document.ts'
import { attachStickyTop, STICKY_TOP_PROPERTY, STICKY_TOP_SCRIPT, stickyTopOf } from '../src/web/sticky-top.ts'
import { PLATFORM_SCRIPT } from '../src/web/platform.ts'

const TEMPLATE = '<!doctype html><html><head><title>t</title></head><body><div id="app"></div></body></html>'

/** A document whose elements are laid out as `layout` says (linkedom has no layout), with observers we drive. */
function page(layout: { position: string; height: number }) {
  const { document, window } = parseHTML('<!doctype html><html><head></head><body><div id="app"></div></body></html>')
  const resized: (() => void)[] = []
  const mutated: (() => void)[] = []
  const frames: (() => void)[] = []
  const observed = new Set<Element>()
  let mutations = 0
  class ResizeObserver {
    constructor(private cb: () => void) {
      resized.push(() => this.cb())
    }
    observe(e: Element) {
      observed.add(e)
    }
    unobserve(e: Element) {
      observed.delete(e)
    }
    disconnect() {
      observed.clear()
    }
  }
  class MutationObserver {
    private on = false
    constructor(private cb: () => void) {
      mutated.push(() => this.on && this.cb())
    }
    observe() {
      this.on = true
      mutations++
    }
    disconnect() {
      if (this.on) mutations--
      this.on = false
    }
  }
  const getComputedStyle = (e: Element) => ({ position: e.getAttribute('data-sem-c') === 'app-bar' ? layout.position : 'static' })
  const proto = Object.getPrototypeOf(document.createElement('div'))
  proto.getBoundingClientRect = function (this: Element) {
    return { height: this.getAttribute('data-sem-c') === 'app-bar' ? layout.height : 0 }
  }
  Object.assign(window, { ResizeObserver, MutationObserver, getComputedStyle, requestAnimationFrame: (f: () => void) => frames.push(f), cancelAnimationFrame() {} })
  const top = () => document.documentElement.style.getPropertyValue(STICKY_TOP_PROPERTY)
  const addBar = () => {
    const bar = document.createElement('header')
    bar.setAttribute('data-sem-c', 'app-bar')
    document.getElementById('app')!.append(bar)
    return bar
  }
  return {
    document,
    window,
    layout,
    top,
    addBar,
    observed,
    activeMutationObservers: () => mutations,
    mutate: () => mutated.forEach((f) => f()),
    resize: () => resized.forEach((f) => f()),
    frame: () => frames.splice(0).forEach((f) => f()),
    runScript: () =>
      new Function('document', 'ResizeObserver', 'MutationObserver', 'getComputedStyle', STICKY_TOP_SCRIPT)(document, ResizeObserver, MutationObserver, getComputedStyle),
  }
}

describe('the app bar measured for what sticks below it (#428)', () => {
  it('is measured by the head script as soon as the parser adds the bar, and followed as it resizes', () => {
    const p = page({ position: 'sticky', height: 61 })
    p.runScript()
    expect(p.top()).toBe('')
    const bar = p.addBar()
    p.mutate()
    expect(p.top()).toBe('73px')
    expect(p.observed.has(bar)).toBe(true)
    // Found: it stops looking at every addition.
    expect(p.activeMutationObservers()).toBe(0)
    // The window narrows and the bar wraps into a second row: before that frame is painted.
    p.layout.height = 103
    p.resize()
    expect(p.top()).toBe('115px')
  })

  it('measures as the client does, sticky or not', () => {
    for (const layout of [
      { position: 'sticky', height: 61 },
      { position: 'fixed', height: 40.2 },
      { position: 'static', height: 61 },
    ]) {
      const p = page(layout)
      p.runScript()
      const bar = p.addBar()
      p.mutate()
      const fromScript = p.top()
      expect(fromScript).toBe(`${stickyTopOf(bar, p.window as unknown as Window)}px`)
      p.document.documentElement.style.removeProperty(STICKY_TOP_PROPERTY)
      const client = attachStickyTop(p.document.getElementById('app') as unknown as HTMLElement)
      expect(p.top(), JSON.stringify(layout)).toBe(fromScript)
      client.dispose()
    }
  })

  it('stops looking once the document is parsed, and a page without a bar sticks near the top', async () => {
    const p = page({ position: 'sticky', height: 61 })
    p.runScript()
    p.document.dispatchEvent(new p.window.Event('DOMContentLoaded'))
    expect(p.activeMutationObservers()).toBe(0)
    const client = attachStickyTop(p.document.getElementById('app') as unknown as HTMLElement)
    expect(p.top()).toBe('16px')
    // A bar the client renders later is measured at the next frame, and followed.
    p.addBar()
    p.mutate()
    // (linkedom's own MutationObserver, if it keeps it, reports after the task.)
    await new Promise((r) => setTimeout(r, 0))
    p.frame()
    expect(p.top()).toBe('73px')
    p.layout.height = 177
    p.resize()
    expect(p.top()).toBe('189px')
    client.dispose()
  })

  it('is in a server-rendered head, ahead of the styles, once, and in a streamed head too', () => {
    const script = `<script>${STICKY_TOP_SCRIPT}</script>`
    for (const stylesheet of ['inline', { href: '/semblance.css' }] as const) {
      const doc = renderDocument(TEMPLATE, { html: '<p>hi</p>', css: 'p{}', lang: 'en', dir: 'ltr' }, { stylesheet })
      const head = doc.slice(0, doc.indexOf('</head>'))
      expect(head).toContain(script)
      expect(head.indexOf(script)).toBeLessThan(head.indexOf('data-sem-styles'))
      expect(head.indexOf(`<script>${PLATFORM_SCRIPT}</script>`)).toBeLessThan(head.indexOf(script))
      expect(doc.split(script).length).toBe(2)
    }
    const [before] = documentParts(TEMPLATE, { lang: 'en', dir: 'ltr' }, { stylesheet: 'none' })
    expect(before).toContain(script + '</head>')
  })
})
