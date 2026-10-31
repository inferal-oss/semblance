// The sales dashboard example (demo/gallery/_ex-dashboard.ttl): facets over a stream of orders,
// counts that apply the other facets, charts and a table over one maintained view (a cube), and
// work that does not grow with the stream - driven through events on the site.
import { describe, expect, it } from 'vitest'
import { ManualClock } from '../src/behaviour/clock.ts'
import { mountSite } from './harness.ts'
import { implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const DX = 'https://semblance.dev/demo/dashboard#'

function dashboard(prefer: 'sparql' | 'function' = 'sparql', strict = false, kind: 'oxigraph' | 'wat' = 'oxigraph') {
  const clock = new ManualClock()
  const h = mountSite(kind, prefer, clock)
  h.runtime.views.clock = clock
  h.runtime.views.strict = strict
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  click(button('Examples'))
  click(navItem('Sales dashboard'))
  const root = () => h.shell.nodeOf(UI + 'ex-dashboard/~root') as Element
  const facet = (caption: string) => [...root().querySelectorAll('[data-sem-c=chips]')].find((c) => c.getAttribute('aria-label') === caption)!
  /** A facet's chips: label, count, and * when chosen. */
  const chips = (caption: string) =>
    [...facet(caption).querySelectorAll('button')].map((b) => {
      const count = b.querySelector('.sem-count [aria-hidden]')?.textContent
      return `${b.firstChild!.textContent}${count === undefined ? '' : ' ' + count}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`
    })
  const chip = (label: string) => [...root().querySelectorAll('[data-sem-c=chips] button')].find((b) => b.firstChild!.textContent === label)!
  const stat = (label: string) => [...root().querySelectorAll('[data-sem-c=stat]')].find((s) => s.querySelector('.sem-label')!.textContent === label)!.querySelector('.sem-value')!.textContent
  const bars = (chart: number) => Object.fromEntries([...[...root().querySelectorAll('[data-sem-c=bar-chart]')][chart]!.querySelectorAll('.sem-bar')].map((b) => [b.querySelector('.sem-category')!.textContent, b.querySelector('.sem-total')!.textContent]))
  const table = () => [...root().querySelectorAll('[data-sem-c=table] tbody tr')].map((tr) => [...tr.querySelectorAll('td, th')].map((c) => c.textContent!.trim()).join(' | '))
  const advance = (ms: number) => (clock.advance(ms), h.shell.flush())
  const members = () => h.store.match(h.store.factory.namedNode(DX + 'orders'), h.store.factory.namedNode('https://w3id.org/tree#member'), null).length
  return { ...h, clock, click, button, root, facet, chips, chip, stat, bars, table, advance, members }
}

describe('the sales dashboard example', () => {
  it('has both implementations of the chips it uses', () => {
    expect(implementationGaps(['components/controls.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })

  it('shows the orders through the cube: counts per facet value, figures, charts and the table', () => {
    const h = dashboard('sparql', true)
    expect(h.chips('Region')).toEqual(['North 7', 'South 5', 'East 6', 'West 6'])
    expect(h.chips('Product')).toEqual(['Coffee 8', 'Tea 6', 'Cocoa 4', 'Juice 6'])
    expect(h.chips('Channel')).toEqual(['Web 12', 'Store 8', 'Partner 4'])
    // The count is shown once and spelled out once.
    expect(h.chip('North').querySelector('.sem-visually-hidden')!.textContent).toBe(', 7 orders')
    expect(h.stat('Orders shown')).toBe('24')
    expect(h.stat('Sales shown')).toBe('500')
    expect(h.stat('Orders in all')).toBe('24')
    expect(h.stat('Cube cells')).toBe('21')
    expect(h.bars(0)).toEqual({ North: '147', South: '102', East: '137', West: '114' })
    expect(h.bars(1)).toEqual({ Coffee: '8', Tea: '6', Cocoa: '4', Juice: '6' })
    expect(h.table()[0]).toBe('North | Coffee | 3 | 95 | 31.67')
    // The cube is a maintained view, incremental (not a fallback), and holds a row per cell.
    const cube = h.runtime.views.view(DX + 'Cube')!
    expect(cube.fallback).toBeUndefined()
    // So are the queries over it: their rows are a result set in the views graph, which the charts, the table, the figures and the chips read.
    for (const q of ['qByRegion', 'qByProduct', 'qBreakdown', 'qShownOrders', 'qShownSales', 'qRegionCounts', 'qProductCounts', 'qChannelCounts', 'qCells', 'qAllOrders']) {
      expect(h.runtime.views.view(DX + q)?.strategy, q).toBe('incremental')
    }
    const f = h.store.factory
    expect(h.store.match(f.namedNode(DX + 'qByRegion'), f.namedNode('http://www.w3.org/2001/sw/DataAccess/tests/result-set#solution'), null, f.namedNode('urn:semblance:views'))).toHaveLength(h.runtime.views.view(DX + 'qByRegion')!.rows().length)
    expect(h.runtime.views.view(DX + 'qByRegion')!.rows().length).toBeGreaterThan(3)
  })

  it('filters by the facets: everything follows, and each facet counts with the others applied', () => {
    const h = dashboard()
    h.click(h.chip('Tea'))
    expect(h.store.match(h.store.factory.namedNode(DX + 'filters'), h.store.factory.namedNode(DX + 'product'), null).map((q) => q.object.value)).toEqual([DX + 'tea'])
    // Product counts ignore the product filter; the others are tea orders now.
    expect(h.chips('Product')).toEqual(['Coffee 8', 'Tea 6*', 'Cocoa 4', 'Juice 6'])
    expect(h.chips('Region')).toEqual(['North 2', 'South 2', 'East 1', 'West 1'])
    expect(h.chips('Channel')).toEqual(['Web 3', 'Store 2', 'Partner 1'])
    expect(h.stat('Orders shown')).toBe('6')
    expect(h.bars(1)).toEqual({ Tea: '6' })
    expect(h.table()).toHaveLength(4)
    // And North: the products now count North's orders, the regions still the tea ones.
    h.click(h.chip('North'))
    expect(h.chips('Product')).toEqual(['Coffee 3', 'Tea 2*', 'Cocoa 1', 'Juice 1'])
    expect(h.chips('Region')).toEqual(['North 2*', 'South 2', 'East 1', 'West 1'])
    expect(h.stat('Orders shown')).toBe('2')
    expect(h.bars(0)).toEqual({ North: '25' })
    expect(h.table()).toEqual(['North | Tea | 2 | 25 | 12.50'])
    // Cocoa as well (a facet's values are or-ed): North's tea and cocoa.
    h.click(h.chip('Cocoa'))
    expect(h.stat('Orders shown')).toBe('3')
    // A zero is shown, and marked: no partner orders of North's tea or cocoa.
    expect(h.chips('Channel')).toEqual(['Web 2', 'Store 1', 'Partner 0'])
    expect(h.chip('Partner').querySelector('.sem-count')!.classList.contains('sem-zero')).toBe(true)
    h.click(h.button('Clear filters'))
    expect(h.stat('Orders shown')).toBe('24')
    expect(h.chips('Region')).toEqual(['North 7', 'South 5', 'East 6', 'West 6'])
  })

  it('streams more orders in batches, each one step of the cube, checked against a from-scratch run', () => {
    const h = dashboard('sparql', true)
    h.click(h.button('Add 100 orders'))
    // Ten batches of ten, 40 ms apart: strict mode compares every view with a re-run after each.
    h.advance(1000)
    expect(h.members()).toBe(124)
    expect(h.stat('Orders in all')).toBe('124')
    expect(h.stat('Orders shown')).toBe('124')
    const sum = (xs: string[]) => xs.reduce((a, x) => a + Number(x.split(' ')[1]), 0)
    expect(sum(h.chips('Region'))).toBe(124)
    expect(sum(h.chips('Channel'))).toBe(124)
    // The cube's own account of its last step: a batch's work, against a re-run reading all 124.
    h.runtime.warm(8)
    h.shell.flush()
    const work = h.root().querySelector('[data-sem-c=progress]')!
    expect(work.textContent).toMatch(/^The cube's last step: \d+ rows of work; a from-scratch run reads 124\.$/)
    expect(Number(work.getAttribute('aria-valuenow'))).toBeLessThan(40)
  }, 120_000)

  // On wat the SPARQL rules that write numbers in the viewer's locale (sx:formatNumber) are the ones chosen.
  for (const kind of ['oxigraph', 'wat'] as const) it(`renders the same with SPARQL and with function rules, filtered and not (${kind})`, () => {
    const [a, b] = [dashboard('sparql', false, kind), dashboard('function', false, kind)]
    const html = (h: typeof a) => h.root().innerHTML
    expect(html(b)).toBe(html(a))
    expect(a.root().querySelectorAll('.sem-count').length).toBeGreaterThan(3)
    for (const h of [a, b]) h.click(h.chip('Store'))
    expect(html(b)).toBe(html(a))
    for (const h of [a, b]) h.click(h.chip('East'))
    expect(html(b)).toBe(html(a))
    for (const h of [a, b]) h.click(h.button('Clear filters'))
    expect(html(b)).toBe(html(a))
  }, 120_000)
})

describe('the dashboard costs the same at a thousand orders as at two thousand', () => {
  it('a filter, and a batch of orders', () => {
    const measure = (thousands: number) => {
      const h = dashboard()
      for (let i = 0; i < thousands; i++) {
        h.click(h.button('Add 1,000 orders'))
        h.advance(2000)
      }
      expect(h.members()).toBe(24 + thousands * 1000)
      const counters = { sparqlRows: 0 }
      const { select } = h.store
      h.store.select = (...args) => {
        const rows = select.apply(h.store, args)
        counters.sparqlRows += rows.length
        return rows
      }
      const snap = () => ({ ruleRuns: h.screen.engine.stats.ruleRuns, sparqlRows: counters.sparqlRows, viewRows: h.runtime.views.totals.rowsIn })
      const diff = (a: ReturnType<typeof snap>, b: ReturnType<typeof snap>) => ({ ruleRuns: b.ruleRuns - a.ruleRuns, sparqlRows: b.sparqlRows - a.sparqlRows, viewRows: b.viewRows - a.viewRows })
      const a = snap()
      h.click(h.chip('Tea'))
      const b = snap()
      h.click(h.chip('Tea'))
      // One batch of fifty.
      h.click(h.button('Add 1,000 orders'))
      const c = snap()
      h.advance(40)
      const d = snap()
      return { filter: diff(a, b), batch: diff(c, d), cells: h.stat('Cube cells') }
    }
    const one = measure(1)
    const two = measure(2)
    console.info('[dashboard cost]', JSON.stringify({ one, two }))
    // Every cell is filled at both sizes, so a filter reads the same 48 cells.
    expect(one.cells).toBe('48')
    expect(two.cells).toBe('48')
    expect(two.filter).toEqual(one.filter)
    // The filter re-evaluates, in each query over the cube, the cells it gates (at most 48 a query), never the orders.
    expect(one.filter.viewRows).toBeGreaterThan(0)
    expect(one.filter.viewRows).toBeLessThan(48 * 12)
    // A batch: the cube's work is the batch's (its fifty orders, the cells they touch), and each
    // query's is those cells' - not the stream's.
    for (const m of [one, two]) {
      expect(m.batch.viewRows).toBeGreaterThan(0)
      expect(m.batch.viewRows).toBeLessThan(2500)
    }
    // (A batch's orders are random: how many cells it touches varies, but never past the 48 there are.)
    expect(two.batch.ruleRuns).toBe(one.batch.ruleRuns)
  }, 300_000)
})
