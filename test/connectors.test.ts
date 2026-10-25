// Connectors (ontology/components/connector.ttl): derived and declared ones render the same under
// SPARQL and function rules; the host effect (src/web/connectors.ts) draws them between the right
// elements, again when they move, not at all while an end is hidden, and writes nothing when
// nothing it joins moved.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { attachConnectors, route } from '../src/web/connectors.ts'
import { NS } from '../src/ns.ts'
import { mountShell, mountSite } from './harness.ts'
import { implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const C = NS.c
type Rect = { left: number; top: number; width: number; height: number }

/** Give an element a box (linkedom lays nothing out). */
function place(el: Element, r: Rect) {
  ;(el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top }) as DOMRect
}

/** A page with two boxes and a connector between them, drawn by hand (frames run when asked). */
function page(attrs: Record<string, string> = {}, dir = 'ltr') {
  const { document, window } = parseHTML(`<!doctype html><html><body><div id="app" dir="${dir}"></div></body></html>`)
  const host = document.getElementById('app')!
  const a = document.createElement('div')
  a.id = 'A'
  const b = document.createElement('div')
  b.id = 'B'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'sem-connector')
  for (const [k, v] of Object.entries({ 'data-sem-from': 'A', 'data-sem-to': 'B', 'data-sem-route': 'curved', 'data-sem-heads': 'to', ...attrs })) svg.setAttribute(k, v)
  const part = (tag: string, cls: string, extra: Record<string, string> = {}) => {
    const p = document.createElementNS('http://www.w3.org/2000/svg', tag)
    p.setAttribute('class', cls)
    for (const [k, v] of Object.entries(extra)) p.setAttribute(k, v)
    svg.append(p)
    return p
  }
  const leaderPath = part('path', 'sem-connector-leader')
  const start = part('circle', 'sem-connector-start')
  const line = part('path', 'sem-connector-line')
  const head = part('path', 'sem-connector-head', { 'data-sem-end': 'to' })
  host.append(a, b, svg)
  place(svg, { left: 0, top: 0, width: 800, height: 600 })
  place(a, { left: 10, top: 10, width: 100, height: 40 })
  place(b, { left: 300, top: 100, width: 100, height: 40 })
  const frames: (() => void)[] = []
  const effect = attachConnectors(host as HTMLElement, { frame: (cb) => (frames.push(cb), () => frames.splice(frames.indexOf(cb), 1)) })
  const tick = () => frames.splice(0).forEach((f) => f())
  return { document, window, host, a, b, svg, line, head, leaderPath, start, effect, frames, tick }
}

const ends = (d: string) => {
  const n = d.match(/-?\d+(\.\d+)?/g)!.map(Number)
  return { from: n.slice(0, 2), to: n.slice(-2) }
}

describe('the connector effect', () => {
  it('draws a path between the right elements, relative to its canvas', () => {
    const p = page()
    p.tick()
    expect(p.svg.hasAttribute('data-sem-drawn')).toBe(true)
    // Side by side: out of A's right side at its middle, into B's left side at its middle.
    expect(ends(p.line.getAttribute('d')!)).toEqual({ from: [110, 30], to: [300, 120] })
    expect(p.head.getAttribute('d')).toMatch(/^M300\.0,120\.0 L/)
    // The canvas moved, not the ends: everything is relative to it.
    place(p.svg, { left: -50, top: 20, width: 800, height: 600 })
    p.effect.draw()
    expect(ends(p.line.getAttribute('d')!)).toEqual({ from: [160, 10], to: [350, 100] })
  })

  it('draws again when an end moves or resizes, once a frame', async () => {
    const p = page()
    p.tick()
    place(p.b, { left: 500, top: 300, width: 160, height: 40 })
    // A change in the page (the renderer writing the box's place) asks for one frame.
    p.b.setAttribute('style', 'left: 500px')
    p.a.setAttribute('data-x', '1')
    await new Promise((r) => setTimeout(r, 0))
    expect(p.frames).toHaveLength(1)
    p.tick()
    expect(ends(p.line.getAttribute('d')!).to).toEqual([500, 320])
    // Its own writes ask for nothing.
    await new Promise((r) => setTimeout(r, 0))
    expect(p.frames).toHaveLength(0)
  })

  it('writes nothing when nothing it joins moved', () => {
    const p = page()
    p.tick()
    const writes = p.effect.stats.writes
    p.effect.draw()
    p.effect.draw()
    expect(p.effect.stats.writes).toBe(writes)
    expect(p.effect.stats.frames).toBe(3)
  })

  it('hides the connector while an end is hidden, not rendered, or off the page', () => {
    const p = page()
    p.tick()
    p.b.setAttribute('hidden', '')
    p.effect.draw()
    expect(p.svg.hasAttribute('data-sem-drawn')).toBe(false)
    p.b.removeAttribute('hidden')
    p.effect.draw()
    expect(p.svg.hasAttribute('data-sem-drawn')).toBe(true)
    p.b.remove()
    p.effect.draw()
    expect(p.svg.hasAttribute('data-sem-drawn')).toBe(false)
    p.host.append(p.b)
    place(p.a, { left: 0, top: 0, width: 0, height: 0 })
    p.effect.draw()
    expect(p.svg.hasAttribute('data-sem-drawn')).toBe(false)
  })

  it('stops at a round end’s ring, and leaves running text along a leader', () => {
    const p = page({ 'data-sem-to': 'dot', 'data-sem-leader': 'para' })
    const dot = p.document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    dot.id = 'dot'
    const para = p.document.createElement('p')
    para.id = 'para'
    p.host.append(dot, para)
    place(dot, { left: 593, top: 93, width: 14, height: 14 })
    place(para, { left: 0, top: 0, width: 400, height: 80 })
    p.tick()
    // Under the phrase to the paragraph's edge, then a curve into the dot's ring (radius 7 + 3).
    expect(p.leaderPath.getAttribute('d')).toBe('M110.0,50.0 L400.0,50.0')
    expect([p.start.getAttribute('cx'), p.start.getAttribute('cy')]).toEqual(['110.0', '50.0'])
    const to = ends(p.line.getAttribute('d')!).to
    expect(Math.hypot(to[0]! - 600, to[1]! - 100)).toBeCloseTo(10, 0)
  })

  it('arcs out of the inline end side, mirrored right to left', () => {
    const column = { a: { left: 100, top: 0, right: 200, bottom: 36, width: 100, height: 36 }, b: { left: 100, top: 108, right: 200, bottom: 144, width: 100, height: 36 } }
    const ltr = route({ ...column, route: 'arc', heads: 'to', roundFrom: false, roundTo: false, rtl: false })
    const rtl = route({ ...column, route: 'arc', heads: 'to', roundFrom: false, roundTo: false, rtl: true })
    expect(ltr.line).toBe('M192.0,18.0 C224.0,18.0 224.0,126.0 192.0,126.0')
    expect(rtl.line).toBe('M108.0,18.0 C76.0,18.0 76.0,126.0 108.0,126.0')
    // Elbows and straight lines between the same boxes side by side.
    const side = { a: column.a, b: { left: 300, top: 108, right: 400, bottom: 144, width: 100, height: 36 } }
    expect(route({ ...side, route: 'elbow', heads: 'none', roundFrom: false, roundTo: false, rtl: false })).toEqual({ line: 'M200.0,18.0 L250.0,18.0 L250.0,126.0 L300.0,126.0' })
    expect(route({ ...side, route: 'straight', heads: 'both', roundFrom: false, roundTo: false, rtl: false }).headFrom).toBeDefined()
  })
})

/** The Components page on its Layout group, with the connector specimen. */
function layout(prefer: 'sparql' | 'function' = 'function') {
  const h = mountShell(5, 'oxigraph', prefer)
  const f = h.store.factory
  h.showPage('Components')
  h.runtime.apply({ remove: h.store.match(f.namedNode(UI + 'app'), f.namedNode(UI + 'galleryGroup'), null), add: [f.quad(f.namedNode(UI + 'app'), f.namedNode(UI + 'galleryGroup'), f.namedNode(UI + 'GroupLayout'))] })
  h.shell.flush()
  const canvas = () => h.shell.nodeOf(UI + 'ly-connect-canvas/~root') as HTMLElement
  const arrow = () => canvas().querySelector('[data-sem-c=connector]') as SVGSVGElement
  return { ...h, canvas, arrow }
}

describe('a connector between two cards', () => {
  it('names its ends by id, says what it joins, and renders the same with SPARQL and functions', () => {
    expect(implementationGaps(['components/connector.ttl'])).toEqual({ noSparql: [], noFunction: [] })
    const [a, b] = (['sparql', 'function'] as const).map((prefer) => {
      const h = layout(prefer)
      const svg = h.arrow()
      expect(svg.getAttribute('role')).toBe('img')
      expect(svg.getAttribute('aria-label')).toBe('Order → Invoice: is billed as')
      expect(svg.getAttribute('data-sem-tone')).toBe('accent')
      const from = h.document.getElementById(svg.getAttribute('data-sem-from')!)
      expect(from).toBe(h.shell.nodeOf(UI + 'ly-connect-order/~root'))
      expect(h.document.getElementById(svg.getAttribute('data-sem-to')!)).toBe(h.shell.nodeOf(UI + 'ly-connect-invoice/~root'))
      // Each card sits in a draggable item; the canvas is resizable.
      expect(from!.parentElement!.getAttribute('data-sem-gesture')).toBe('move')
      expect(h.canvas().querySelector('.sem-canvas-grip')!.getAttribute('data-sem-gesture')).toBe('resize')
      const html = [h.canvas().outerHTML]
      from!.parentElement!.dispatchEvent(new h.window.CustomEvent('sem-move', { bubbles: true, detail: { x: 40, y: 120 } }))
      h.shell.flush()
      html.push(h.canvas().outerHTML)
      return html
    })
    a!.forEach((html, i) => expect(html, `state ${i}`).toBe(b![i]))
  })

  it('follows a card that is dragged, and hides with a hidden card', async () => {
    const h = layout()
    const order = h.shell.nodeOf(UI + 'ly-connect-order/~root') as HTMLElement
    const invoice = h.shell.nodeOf(UI + 'ly-connect-invoice/~root') as HTMLElement
    const svg = h.arrow()
    place(svg, { left: 0, top: 0, width: 600, height: 240 })
    place(order, { left: 16, top: 16, width: 180, height: 80 })
    place(invoice, { left: 400, top: 16, width: 180, height: 80 })
    const frames: (() => void)[] = []
    const effect = attachConnectors(h.document.getElementById('app') as HTMLElement, { frame: (cb) => (frames.push(cb), () => {}) })
    frames.splice(0).forEach((f) => f())
    const line = svg.querySelector('.sem-connector-line')!
    expect(ends(line.getAttribute('d')!)).toEqual({ from: [196, 56], to: [400, 56] })
    // Dropped lower down: one move event, its place in the graph, and the arrow follows.
    invoice.parentElement!.dispatchEvent(new h.window.CustomEvent('sem-move', { bubbles: true, detail: { x: 400, y: 140 } }))
    h.shell.flush()
    expect(invoice.parentElement!.getAttribute('style')).toBe('left: 400px; top: 140px')
    expect(h.store.match(h.store.factory.namedNode(UI + 'ly-connect-canvas/~item-' + encodeURIComponent(UI + 'ly-connect-invoice')), h.store.factory.namedNode(C + 'y'), null)[0]?.object.value).toBe('140')
    place(invoice, { left: 400, top: 140, width: 180, height: 80 })
    await new Promise((r) => setTimeout(r, 0))
    expect(frames.length).toBeGreaterThan(0)
    frames.splice(0).forEach((f) => f())
    expect(ends(line.getAttribute('d')!).to).toEqual([400, 180])
    // A hidden end hides it.
    const f = h.store.factory
    h.runtime.apply({ add: [f.quad(f.namedNode(UI + 'ly-connect-invoice'), f.namedNode(C + 'hidden'), f.literal('true', f.namedNode(NS.xsd + 'boolean')))], remove: [] })
    h.shell.flush()
    effect.draw()
    expect(svg.hasAttribute('data-sem-drawn')).toBe(false)
    effect.dispose()
  })
})

describe('derived connectors', () => {
  it("are the walkthrough's arrows: the current step's mentions, and the lit ones, heavier", () => {
    const h = mountShell(5, 'oxigraph', 'function')
    const walk = () => h.document.querySelector('[data-sem-c=walkthrough]') as HTMLElement
    const arrows = () => [...walk().querySelectorAll('.sem-walk-arrows > [data-sem-c=connector]')]
    const steps = () => [...walk().querySelectorAll<HTMLElement>('.sem-walk-step')]
    // A step's mentions of terms the diagram shows.
    const shown = (m: Element) => [...walk().querySelectorAll('.sem-plot [data-sem-term]')].some((n) => n.getAttribute('data-sem-term') === m.getAttribute('data-sem-mentions'))
    const mentions = (i: number) => [...steps()[i]!.querySelectorAll('.sem-mention')].filter(shown)
    expect(arrows()).toHaveLength(mentions(0).length)
    // Each from its mention, to its node's dot, out of its step.
    for (const svg of arrows()) {
      const from = h.document.getElementById(svg.getAttribute('data-sem-from')!)!
      const to = h.document.getElementById(svg.getAttribute('data-sem-to')!)!
      expect(from.classList.contains('sem-mention')).toBe(true)
      expect(to.localName).toBe('circle')
      expect(to.parentElement!.getAttribute('data-sem-term')).toBe(from.getAttribute('data-sem-mentions'))
      expect(h.document.getElementById(svg.getAttribute('data-sem-leader')!)!.closest('.sem-walk-step')).toBe(from.closest('.sem-walk-step'))
    }
    steps()[2]!.dispatchEvent(new h.window.CustomEvent('sem-step', { bubbles: true }))
    h.shell.flush()
    expect(arrows()).toHaveLength(mentions(2).length)
    // Pointing at a term: every mention of it has an arrow, with a solid emphasis.
    const m = mentions(1).find((x) => x.textContent === 'ex:priority')!
    h.fire(m, 'mouseover')
    h.shell.flush()
    const lit = arrows().filter((a) => a.getAttribute('data-sem-emphasis') === 'solid')
    expect(lit.length).toBe(walk().querySelectorAll('[data-sem-lit]').length)
    expect(lit.length).toBeGreaterThan(0)
  })

  it("are the sheet's dependency arrows, and a keystroke elsewhere redraws none", async () => {
    const h = mountSite('oxigraph', 'function')
    const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
    const click = (label: string, scope = 'button') => {
      h.fire([...h.document.querySelectorAll(scope)].find((b) => b.textContent!.trim() === label && visible(b))!, 'click')
      h.shell.flush()
    }
    click('Examples')
    click('Spreadsheet', '[data-sem-c=nav-list] button')
    const sheet = h.document.querySelector('[data-sem-c=sheet]') as HTMLElement
    // Lay the grid out as its tracks say: 44px row header, 30px column header, 104 × 36 cells.
    const box = (el: Element): DOMRect => {
      const style = el.getAttribute('style') ?? ''
      const r = /grid-row: (\d+); grid-column: (\d+)/.exec(style)
      const at = r ? { left: 44 + (Number(r[2]) - 2) * 104, top: 30 + (Number(r[1]) - 2) * 36, width: 104, height: 36 } : { left: 0, top: 0, width: 600, height: 400 }
      return { ...at, right: at.left + at.width, bottom: at.top + at.height, x: at.left, y: at.top } as DOMRect
    }
    const proto = Object.getPrototypeOf(sheet) as { getBoundingClientRect?: unknown }
    const had = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(proto), 'getBoundingClientRect')
    Object.defineProperty(Object.getPrototypeOf(proto), 'getBoundingClientRect', { configurable: true, value: function (this: Element) { return box(this) } })
    try {
      const frames: (() => void)[] = []
      const effect = attachConnectors(h.document.getElementById('app') as HTMLElement, { frame: (cb) => (frames.push(cb), () => {}) })
      frames.splice(0).forEach((f) => f())
      const drawn = () => [...sheet.querySelectorAll('[data-sem-c=connector][data-sem-drawn]')]
      // D6 reads D2..D5 (one column: arcs) and is read by D7 and D8.
      expect(drawn()).toHaveLength(6)
      const arc = drawn().find((c) => c.getAttribute('aria-label') === 'D2 → D6')!
      expect(arc.getAttribute('data-sem-route')).toBe('arc')
      expect(ends(arc.querySelector('.sem-connector-line')!.getAttribute('d')!)).toEqual({ from: [44 + 3 * 104 + 96, 30 + 36 + 18], to: [44 + 3 * 104 + 96, 30 + 5 * 36 + 18] })
      // Typing in a cell no arrow touches (and in one whose value an arrow's end shows): nothing to redraw.
      const writes = effect.stats.writes
      const type = (name: string, text: string) => {
        const input = (h.shell.nodeOf('https://semblance.dev/demo/sheet#' + name + '/~root') as HTMLElement).querySelector('input')!
        input.value = text
        h.fire(input, 'input')
        h.shell.flush()
      }
      type('A2', 'Pour-over kettle')
      type('C3', '15')
      await new Promise((r) => setTimeout(r, 0))
      frames.splice(0).forEach((f) => f())
      expect(effect.stats.writes).toBe(writes)
      effect.dispose()
    } finally {
      if (had) Object.defineProperty(Object.getPrototypeOf(proto), 'getBoundingClientRect', had)
      else delete (Object.getPrototypeOf(proto) as { getBoundingClientRect?: unknown }).getBoundingClientRect
    }
  })
})
