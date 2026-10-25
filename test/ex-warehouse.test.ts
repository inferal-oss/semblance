// The warehouse example (demo/gallery/_ex-warehouse.ttl): stock per item, a reorder list and the
// last hour's best sellers, all maintained views over one stream of movements - driven through
// events on the site, on Semblance's own engine (wat), with every view checked against a
// from-scratch run after every tick (strict).
import type { Quad } from '@rdfjs/types'
import { describe, expect, it } from 'vitest'
import { ManualClock } from '../src/behaviour/clock.ts'
import type { StoreKind } from '../src/node/load.ts'
import { L10N, NS } from '../src/ns.ts'
import { mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const WH = 'https://semblance.dev/demo/warehouse#'
const TREE = 'https://w3id.org/tree#'
const THEME = 'https://semblance.dev/ns/style#Doodle'

function warehouse(opts: { kind?: StoreKind; prefer?: 'sparql' | 'function'; strict?: boolean; history?: number } = {}) {
  const { kind = 'wat', prefer = 'sparql', strict = true, history = 0 } = opts
  const clock = new ManualClock()
  const h = mountSite(kind, prefer, clock)
  h.runtime.views.clock = clock
  h.runtime.views.strict = strict
  const f = h.store.factory
  const nn = (iri: string) => f.namedNode(iri)
  if (history) {
    // A longer history before today: deliveries and sales of the inner tubes, a year back.
    const add: Quad[] = []
    const int = (n: number) => f.literal(String(n), nn(NS.xsd + 'integer'))
    for (let i = 0; i < history; i++) {
      const m = nn(`${WH}old-${i}`)
      const at = new Date(Date.parse('2025-01-01T08:00:00Z') + i * 60_000).toISOString()
      add.push(
        f.quad(nn(WH + 'movements'), nn(TREE + 'member'), m),
        f.quad(m, nn(NS.rdf + 'type'), nn(WH + (i % 2 ? 'Sale' : 'Restock'))),
        f.quad(m, nn(WH + 'item'), nn(WH + 'tube')),
        f.quad(m, nn(WH + 'change'), int(i % 2 ? -1 : 1)),
        f.quad(m, nn(WH + 'at'), f.literal(at, nn(NS.xsd + 'dateTime'))),
      )
    }
    h.runtime.apply({ add, remove: [] })
  }
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  // What the host does after every change (demo/main.ts syncSettings): the viewer's language
  // becomes the projection's, and a right-to-left one flips the document.
  const sync = () => {
    const language = h.store.match(nn(UI + 'app'), nn(L10N.language), null)[0]?.object
    const code = language && h.store.match(language as never, nn(L10N.code), null)[0]?.object.value
    if (code && h.screen.engine.languages[0] !== code) h.screen.engine.reconfigure({ languages: [code] })
    const rtl = !!language && h.store.match(language as never, nn(L10N.direction), nn(L10N.RTL)).length > 0
    h.document.documentElement.setAttribute('dir', rtl ? 'rtl' : 'ltr')
    h.shell.flush()
  }
  const click = (el: Element) => (h.fire(el, 'click'), sync())
  const button = (text: string, within: ParentNode = h.document) => [...within.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const open = () => {
    click(button('Examples'))
    click(navItem('Warehouse'))
  }
  open()
  const root = () => h.shell.nodeOf(UI + 'ex-warehouse/~root') as Element
  const card = (title: string) => [...root().querySelectorAll('[data-sem-c=card]')].find((c) => c.querySelector('.sem-card-title, h2, h3')?.textContent?.trim() === title)!
  const stat = (label: string) => [...root().querySelectorAll('[data-sem-c=stat]')].find((s) => s.querySelector('.sem-label')!.textContent === label)!.querySelector('.sem-value')!.textContent
  const rows = (table: number) => [...[...root().querySelectorAll('[data-sem-c=table]')][table]!.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td, th')].map((c) => c.textContent!.trim()).join(' | '))
  const stock = () => Object.fromEntries(rows(0).map((r) => r.split(' | ')).map(([item, , onHand]) => [item, Number(onHand!.replace(/\D/g, '')) * (onHand!.startsWith('-') || onHand!.startsWith('−') ? -1 : 1)]))
  const reorder = () => rows(1)
  const bars = () => [...root().querySelectorAll('[data-sem-c=bar-chart] .sem-bar')].map((b) => `${b.querySelector('.sem-category')!.textContent} ${b.querySelector('.sem-total')!.textContent}`)
  const alert = () => root().querySelector('[data-sem-c=alert]')!
  const costs = () => [...root().querySelectorAll('[data-sem-c=text]')].map((t) => t.textContent!.trim()).filter((t) => t.startsWith('Last change') || t.startsWith('No change') || t.startsWith('Measuring'))
  const choose = (item: string) => {
    const select = root().querySelector('[data-sem-c=choice] select')!
    const o = [...select.querySelectorAll('option')].find((x) => x.textContent === item)!
    Object.defineProperty(select, 'value', { value: o.getAttribute('value'), configurable: true })
    h.fire(select, 'change')
    sync()
  }
  const amount = (n: string) => click(button(n, root().querySelector('[data-sem-c=segmented]')!))
  const advance = (ms: number) => (clock.advance(ms), sync())
  const idle = () => (h.runtime.warm(8), h.shell.flush())
  const members = () => h.store.match(nn(WH + 'movements'), nn(TREE + 'member'), null).length
  return { ...h, clock, click, button, root, card, stat, rows, stock, reorder, bars, alert, costs, choose, amount, advance, idle, members, open, sync }
}

const VIEWS = ['Stock', 'Reorder', 'BestSellers', 'OnHand', 'SoldLastHour', 'Recorded']
const opening = { 'Brake pads': 10, 'Chain lube': 19, Helmet: 7, 'Inner tube 700c': 57, 'Light set': 8, 'Puncture kit': 40, 'Tyre levers': 22, 'Water bottle': 30 }

describe('the warehouse example', () => {
  it('opens on the stock per item, the reorder list and an empty last hour', () => {
    const h = warehouse()
    expect(h.stock()).toEqual(opening)
    expect(h.rows(0)[0]).toBe('Brake pads | Stopwell | 10 | 12')
    expect(h.reorder()).toEqual(['Brake pads | Stopwell | 10 | 2'])
    expect(h.alert().textContent).toContain('1 item is below its minimum.')
    expect(h.alert().getAttribute('data-sem-tone')).toBe('warning')
    expect(h.stat('Units on hand')).toBe('193')
    expect(h.stat('Sold in the last hour')).toBe('0')
    expect(h.stat('Movements recorded')).toBe('14')
    expect(h.bars()).toEqual([])
    expect(h.root().textContent).toContain('Nothing sold in the last hour.')
    // Every view on the page is maintained, none recomputed.
    for (const v of VIEWS) {
      const view = h.runtime.views.view(WH + v)!
      expect(view.strategy, v).toBe('incremental')
      expect(view.fallback, v).toBeUndefined()
    }
  }, 120_000)

  it('sells and restocks: the stock, the reorder list and the best sellers follow each movement', () => {
    const h = warehouse()
    h.choose('Chain lube')
    h.amount('5')
    h.click(h.button('Sell'))
    expect(h.stock()['Chain lube']).toBe(14)
    expect(h.stat('Units on hand')).toBe('188')
    expect(h.stat('Sold in the last hour')).toBe('5')
    expect(h.stat('Movements recorded')).toBe('15')
    expect(h.bars()).toEqual(['Chain lube 5'])
    h.click(h.button('Sell'))
    // Under its minimum of ten: on the list, the most short first.
    expect(h.stock()['Chain lube']).toBe(9)
    expect(h.reorder()).toEqual(['Brake pads | Stopwell | 10 | 2', 'Chain lube | Northwind Oils | 9 | 1'])
    expect(h.alert().textContent).toContain('2 items are below their minimum.')
    // A delivery of one case takes it off again.
    h.click(h.button('Restock'))
    expect(h.stock()['Chain lube']).toBe(21)
    expect(h.reorder()).toEqual(['Brake pads | Stopwell | 10 | 2'])
    h.choose('Brake pads')
    h.click(h.button('Restock'))
    expect(h.reorder()).toEqual(['Nothing to reorder.'])
    expect(h.alert().textContent).toContain('Every item is at or above its minimum.')
    expect(h.alert().getAttribute('data-sem-tone')).toBe('success')
    // An hour later the sales have left the window, on the clock alone; the stock has not moved.
    // (WAT compares xsd:dateTime coarsely, #21, so the from-scratch check at the window's very
    // edge waits until the clock is past it; the next test checks the edge itself on Oxigraph.)
    h.runtime.views.strict = false
    h.advance(61 * 60_000)
    h.runtime.views.strict = true
    h.runtime.advance() // a tick with nothing in it: strict mode compares every view again
    expect(h.bars()).toEqual([])
    expect(h.stat('Sold in the last hour')).toBe('0')
    expect(h.stock()['Chain lube']).toBe(21)
    // Reset takes away what was added here.
    h.click(h.button('Reset'))
    expect(h.stock()).toEqual(opening)
    expect(h.stat('Movements recorded')).toBe('14')
  }, 120_000)

  it('lets each sale leave the last hour when it is an hour old, checked at the edge (Oxigraph, until #21)', () => {
    const h = warehouse({ kind: 'oxigraph' })
    h.choose('Water bottle')
    h.click(h.button('Sell'))
    h.advance(30 * 60_000)
    h.choose('Helmet')
    h.amount('2')
    h.click(h.button('Sell'))
    expect(h.bars()).toEqual(['Helmet 2', 'Water bottle 1'])
    // The bottle's hour is up: it leaves on its timer, strict mode comparing at that instant.
    h.advance(31 * 60_000)
    expect(h.bars()).toEqual(['Helmet 2'])
    expect(h.stat('Sold in the last hour')).toBe('2')
    h.advance(30 * 60_000)
    expect(h.bars()).toEqual([])
    expect(h.stat('Sold in the last hour')).toBe('0')
    expect(h.stat('Units on hand')).toBe('190')
  }, 120_000)

  it('runs a rush hour on the scheduler: thirty orders, each one step of every view', () => {
    const h = warehouse()
    h.click(h.button('Rush hour'))
    h.advance(3100)
    expect(h.members()).toBe(14 + 30)
    expect(h.stat('Movements recorded')).toBe('44')
    // Stock is still the sum of the movements, per item and in all.
    const total = Object.values(h.stock()).reduce((a, b) => a + b, 0)
    expect(h.stat('Units on hand')).toBe(String(total))
    expect(total).toBeLessThan(193)
    // The top five, most sold first, adding up to no more than was sold.
    const best = h.bars().map((b) => Number(b.split(' ').pop()))
    expect(best.length).toBe(5)
    expect([...best].sort((a, b) => b - a)).toEqual(best)
    expect(best.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(Number(h.stat('Sold in the last hour')))
    // Nothing more comes: the rush is over.
    h.advance(5000)
    expect(h.members()).toBe(44)
    h.click(h.button('Reset'))
    expect(h.stock()).toEqual(opening)
    expect(h.members()).toBe(14)
  }, 120_000)

  it('says on each tile what the last change cost, against what a recount would read', () => {
    const h = warehouse()
    h.click(h.button('Sell'))
    h.idle()
    const lines = h.costs()
    expect(lines).toHaveLength(4)
    for (const line of lines) expect(line).toMatch(/^Last change: \d+ rows of work; a recount would read \d+\.$/)
    const [, stockLine] = lines
    expect(stockLine).toMatch(/a recount would read 15\.$/)
    expect(Number(/: (\d+) rows/.exec(stockLine!)![1])).toBeLessThan(10)
  }, 120_000)

  it('renders the same with SPARQL rules as with function rules', () => {
    const [a, b] = [warehouse({ prefer: 'sparql', strict: false }), warehouse({ prefer: 'function', strict: false })]
    expect(b.root().innerHTML).toBe(a.root().innerHTML)
    for (const h of [a, b]) {
      h.choose('Helmet')
      h.amount('5')
      h.click(h.button('Sell'))
    }
    expect(b.root().innerHTML).toBe(a.root().innerHTML)
  }, 120_000)

  it('keeps its numbers in another theme and in a right-to-left language', () => {
    const h = warehouse({ strict: false })
    h.click(h.button('Sell'))
    const before = { stock: h.stock(), reorder: h.reorder(), bars: h.bars() }
    // What the settings' theme and language choices write (ui:themeChoice, ui:languageChoice).
    const f = h.store.factory
    const set = (s: string, p: string, o: string) => {
      h.runtime.apply({ remove: h.store.match(f.namedNode(s), f.namedNode(p), null), add: [f.quad(f.namedNode(s), f.namedNode(p), f.namedNode(o))] })
      h.sync()
    }
    set(UI + 'shell', NS.sty + 'theme', THEME)
    expect(h.stock()).toEqual(before.stock)
    set(UI + 'app', L10N.language, NS.l10n + 'Arabic')
    expect(h.document.documentElement.getAttribute('dir')).toBe('rtl')
    expect(h.stock()).toEqual(before.stock)
    expect(h.reorder()).toEqual(before.reorder)
    expect(h.bars()).toEqual(before.bars)
  }, 120_000)
})

describe('the warehouse costs the same with a long history as with a short one', () => {
  it('a sale and a delivery, over 200 and 2,000 earlier movements', () => {
    const measure = (history: number) => {
      const h = warehouse({ history, strict: false })
      expect(h.members()).toBe(14 + history)
      h.click(h.button('Sell'))
      const counters = { sparqlRows: 0 }
      const { select, construct } = h.store
      h.store.select = (...args) => {
        const rows = select.apply(h.store, args)
        counters.sparqlRows += rows.length
        return rows
      }
      h.store.construct = (...args) => {
        const quads = construct.apply(h.store, args)
        counters.sparqlRows += quads.length
        return quads
      }
      const snap = () => ({ ruleRuns: h.screen.engine.stats.ruleRuns, sparqlRows: counters.sparqlRows, viewRows: h.runtime.views.totals.rowsIn, partitions: h.runtime.views.totals.partitions, rebuilds: h.runtime.views.totals.rebuilds, domOps: h.shell.ops })
      const diff = (a: ReturnType<typeof snap>, b: ReturnType<typeof snap>) => Object.fromEntries(Object.keys(a).map((k) => [k, b[k as keyof typeof b] - a[k as keyof typeof a]]))
      const a = snap()
      h.click(h.button('Sell'))
      const b = snap()
      h.click(h.button('Restock'))
      const c = snap()
      h.idle()
      return { sale: diff(a, b), delivery: diff(b, c), stockCost: h.costs()[1] }
    }
    const short = measure(200)
    const long = measure(2000)
    console.info('[warehouse cost]', JSON.stringify({ short, long }))
    expect(long.sale).toEqual(short.sale)
    expect(long.delivery).toEqual(short.delivery)
    expect(short.sale.rebuilds).toBe(0)
    expect(short.sale.viewRows).toBeLessThan(40)
    // What a recount would read grows with the history; the work of a change does not.
    expect(short.stockCost).toMatch(/a recount would read 217\.$/)
    expect(long.stockCost).toMatch(/a recount would read 2017\.$/)
    expect(/: (\d+) rows/.exec(long.stockCost!)![1]).toBe(/: (\d+) rows/.exec(short.stockCost!)![1])
  }, 600_000)
})
