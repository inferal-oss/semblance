// The reader example (demo/gallery/_ex-reader.ttl): an article in a pane of its own, a table of
// contents that follows the section being read, and how far along the reader is - all derived by
// maintained views from the rendered state of the pane and its sections, measured from a layout the
// test sets (linkedom has none) and driven by scrolling the pane, as a reader would.
import { describe, expect, it } from 'vitest'
import { mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
/** The pane's box, in document pixels; each section is 300 px tall, 30 px apart. */
const PANE = { x: 300, y: 200, width: 600, height: 400 }
const SECTION = 300
const GAP = 30
const EXTENT = 5 * SECTION + 4 * GAP

function reader(prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountSite('oxigraph', prefer)
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  click([...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Examples' && visible(b))!)
  click([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === 'Reader' && visible(b))!)
  const el = (iri: string) => h.shell.nodeOf(h.screen.index.rootOf(UI + iri)!) as HTMLElement
  /** The pane scrolled to `top`: the sections move up in the document, and the pane says so. */
  const scrollTo = (top: number) => {
    h.layout.place(UI + 'ex-reader-pane', PANE.x, PANE.y, PANE.width, PANE.height)
    h.layout.scrolls.set(UI + 'ex-reader-pane', { top, left: 0, height: EXTENT, width: PANE.width, clientHeight: PANE.height, clientWidth: PANE.width })
    for (let n = 1; n <= 5; n++) h.layout.place(UI + `ex-reader-s${n}`, PANE.x, PANE.y + (n - 1) * (SECTION + GAP) - top, PANE.width, SECTION)
    // A pane's scroll event does not bubble; linkedom reaches the effect's listener only if it does.
    el('ex-reader-pane').dispatchEvent(new h.window.Event('scroll', { bubbles: true }))
    h.rendered.flush()
    h.shell.flush()
  }
  const reading = () => [1, 2, 3, 4, 5].filter((n) => el(`ex-reader-t${n}`).getAttribute('data-sem-emphasis') === 'solid')
  const bar = () => el('ex-reader-progress')
  const progress = () => [bar().getAttribute('aria-valuenow'), bar().getAttribute('aria-valuetext')]
  const table = () => [...el('ex-reader-table').querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('th, td')].map((td) => td.textContent!.trim()))
  const map = () => el('ex-reader-map')
  /** Each shadow in the schematic: its name, then its rectangle (x, y, width, height). */
  const shadows = () => [...map().querySelectorAll('g.ex-schematic-shadow')].map((g) => [g.querySelector('text')!.textContent, ...['x', 'y', 'width', 'height'].map((a) => g.querySelector('rect')!.getAttribute(a))].join(' '))
  /** Open the window with its button; the page reports it fixed to the viewport, where it is. */
  const openWindow = (x: number, y: number, width: number, height: number) => {
    click([...el('ex-reader').querySelectorAll('button')].find((b) => b.textContent!.includes('Open a window'))!)
    h.layout.fixedOnes.add(UI + 'ex-reader-window')
    h.layout.place(UI + 'ex-reader-window', x, y, width, height)
    h.rendered.invalidate()
    h.rendered.flush()
    h.shell.flush()
  }
  return { ...h, el, scrollTo, reading, progress, table, map, shadows, openWindow }
}

describe('the reader example', () => {
  it('marks the section being read and says how far along the reader is, as the pane scrolls', () => {
    const h = reader()
    h.scrollTo(0)
    expect(h.reading()).toEqual([1])
    expect(h.progress()).toEqual(['0', '0% read'])
    expect(h.el('ex-reader-t1').getAttribute('data-sem-tone')).toBe('accent')
    // 400 px down: the first section is past the top, the second is being read; 400 of 1220.
    h.scrollTo(400)
    expect(h.reading()).toEqual([2])
    expect(h.progress()).toEqual(['33', '33% read'])
    expect(h.el('ex-reader-t1').getAttribute('data-sem-tone')).toBeNull()
    // To the end: the pane says it is at its end.
    h.scrollTo(EXTENT - PANE.height)
    expect(h.reading()).toEqual([4])
    expect(h.progress()).toEqual(['100', 'Read to the end'])
  })

  it('shows what the page says: each section, where it is in the pane, and which is being read', () => {
    const h = reader()
    h.scrollTo(400)
    expect(h.table()).toEqual([
      ['1 · An interface is a graph', '-400', '300', ''],
      ['2 · Rules project it', '-70', '300', 'yes'],
      ['3 · Events are data', '260', '300', ''],
      ['4 · Measured, not guessed', '590', '300', ''],
      ['5 · What it costs', '920', '300', ''],
    ])
  })

  it('draws the viewport to scale, with the shadows of the article and of the window it opens', () => {
    const h = reader()
    h.scrollTo(0)
    expect(h.map().querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 1280 800')
    expect(h.map().querySelector('.ex-schematic-caption')!.textContent).toBe('Viewport 1280 × 800')
    expect(h.shadows()).toEqual(['Article 300 200 600 400'])
    h.openWindow(160, 160, 320, 220)
    expect(h.shadows()).toEqual(['Article 300 200 600 400', 'Notes 160 160 320 220'])
    // The page scrolls: the article's shadow moves up, the window's stays (it is fixed).
    h.layout.view.scrollTop = 150
    h.rendered.flush()
    h.shell.flush()
    expect(h.shadows()).toEqual(['Article 300 50 600 400', 'Notes 160 160 320 220'])
    // Moved and resized (as its title bar and grip would): the shadow follows.
    h.layout.place(UI + 'ex-reader-window', 700, 300, 480, 300)
    h.rendered.invalidate()
    h.rendered.flush()
    h.shell.flush()
    expect(h.shadows()).toEqual(['Article 300 50 600 400', 'Notes 700 300 480 300'])
    // A label sits at the top of the part in view.
    h.layout.view.scrollTop = 400
    h.rendered.flush()
    h.shell.flush()
    expect(h.map().querySelector('g.ex-schematic-shadow text')!.getAttribute('y')).toBe('60')
  })

  it('the schematic renders the same from its SPARQL rule and its function twin', () => {
    const [sparql, fn] = (['sparql', 'function'] as const).map((prefer) => {
      const h = reader(prefer)
      h.scrollTo(100)
      h.openWindow(160, 160, 320, 220)
      return h.map().outerHTML
    })
    expect(fn).toBe(sparql)
  })

  it('measures only the pane and its sections, records nothing, and re-renders only what the views change', () => {
    const h = reader()
    h.scrollTo(0)
    const f = h.store.factory
    const observed = h.store.match(null, f.namedNode('https://semblance.dev/ns/rendered#of'), null, f.namedNode('urn:semblance:rendered')).map((q) => q.object.value.slice(UI.length))
    expect(observed.filter((c) => c.startsWith('ex-reader')).sort()).toEqual(['ex-reader-pane', 'ex-reader-s1', 'ex-reader-s2', 'ex-reader-s3', 'ex-reader-s4', 'ex-reader-s5'])
    const log = () => h.store.match(null, null, null, f.namedNode('urn:semblance:events')).length
    const before = { log: log(), runs: new Map([...h.screen.engine.stats.byRule].map(([k, v]) => [k, v.runs])) }
    h.scrollTo(400)
    expect(log()).toBe(before.log)
    const ran = [...h.screen.engine.stats.byRule].filter(([k, v]) => v.runs !== (before.runs.get(k) ?? 0))
    const runs = ran.reduce((n, [k, v]) => n + v.runs - (before.runs.get(k) ?? 0), 0)
    // Two badges (the one let go, the one being read), the bar and the table, with the layers over
    // them: the article's headings, text and stacks do not run at all.
    expect(ran.map(([k]) => k.replace(/^.*[#/]/, '')).filter((r) => /Heading|Text|Stack/.test(r))).toEqual([])
    expect(runs).toBeLessThan(40)
  })
})
