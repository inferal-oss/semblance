// Where an interaction's time goes when maintained views do the work (docs/IVM.md, phase 6, #47):
// the warehouse (a sale over 2,000 earlier movements), the network inspector's grid (a response for
// an old entry of 2,000) and the sales dashboard (a facet, and a batch of orders over 2,000), on
// Semblance's engines (wat, rust) and Oxigraph for reference. For each interaction, the median of
// several: the whole update, the views' step (ViewRuntime.tick), and within it the time spent in
// the store (SPARQL partition evaluations, triple lookups for dependency probes) - the boundary a
// circuit inside the engine would remove - against the views' own JavaScript.
//
//   npx tsx bench/ivm-profile.ts [wat rust oxigraph]
import type { Quad } from '@rdfjs/types'
import { ManualClock } from '../src/behaviour/clock.ts'
import type { StoreKind } from '../src/node/load.ts'
import { NETWORK_GRAPH, NS } from '../src/ns.ts'
import { mountShell, mountSite } from '../test/harness.ts'

const UI = 'https://semblance.dev/demo#'
const WH = 'https://semblance.dev/demo/warehouse#'
const NET = NS.net
const TREE = NS.tree

type H = ReturnType<typeof mountSite>

interface Sample {
  total: number
  views: number
  viewStore: number
  viewSelects: number
  viewMatches: number
  otherStore: number
}

/** Time the store's calls, by who made them: the views' step, or anything else (rules, reactions). */
function instrument(h: H) {
  let inViews = false
  const acc = { views: 0, viewStore: 0, viewSelects: 0, viewMatches: 0, otherStore: 0 }
  const store = h.store as unknown as Record<string, (...a: unknown[]) => unknown>
  for (const name of ['select', 'construct', 'match']) {
    const orig = store[name]!.bind(h.store)
    store[name] = (...args: unknown[]) => {
      const t = performance.now()
      try {
        return orig(...args)
      } finally {
        const dt = performance.now() - t
        if (inViews) {
          acc.viewStore += dt
          if (name === 'match') acc.viewMatches++
          else acc.viewSelects++
        } else acc.otherStore += dt
      }
    }
  }
  const views = h.runtime.views as unknown as Record<string, (...a: unknown[]) => unknown>
  for (const name of ['tick', 'resume']) {
    const orig = views[name]!.bind(h.runtime.views)
    views[name] = (...args: unknown[]) => {
      const was = inViews
      inViews = true
      const t = performance.now()
      try {
        return orig(...args)
      } finally {
        if (!was) acc.views += performance.now() - t
        inViews = was
      }
    }
  }
  return (run: () => void): Sample => {
    for (const k of Object.keys(acc) as (keyof typeof acc)[]) acc[k] = 0
    const t = performance.now()
    run()
    return { total: performance.now() - t, ...acc }
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
function summarize(samples: Sample[]) {
  const m = (k: keyof Sample) => median(samples.map((s) => s[k]))
  const views = m('views')
  const viewStore = m('viewStore')
  return {
    'update ms': m('total').toFixed(1),
    'views ms': views.toFixed(1),
    'views in store ms': viewStore.toFixed(1),
    'views own JS ms': Math.max(0, views - viewStore).toFixed(1),
    'store calls (select / match)': `${m('viewSelects')} / ${m('viewMatches')}`,
    'rules etc. in store ms': m('otherStore').toFixed(1),
  }
}

function warehouse(kind: StoreKind, history: number) {
  const clock = new ManualClock()
  const h = mountSite(kind, 'sparql', clock)
  h.runtime.views.clock = clock
  const f = h.store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const int = (n: number) => f.literal(String(n), nn(NS.xsd + 'integer'))
  const add: Quad[] = []
  for (let i = 0; i < history; i++) {
    const m = nn(`${WH}old-${i}`)
    add.push(
      f.quad(nn(WH + 'movements'), nn(TREE + 'member'), m),
      f.quad(m, nn(NS.rdf + 'type'), nn(WH + (i % 2 ? 'Sale' : 'Restock'))),
      f.quad(m, nn(WH + 'item'), nn(WH + 'tube')),
      f.quad(m, nn(WH + 'change'), int(i % 2 ? -1 : 1)),
      f.quad(m, nn(WH + 'at'), f.literal(new Date(Date.parse('2025-01-01T08:00:00Z') + i * 60_000).toISOString(), nn(NS.xsd + 'dateTime'))),
    )
  }
  h.runtime.apply({ add, remove: [] })
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  click(button('Examples'))
  click(navItem('Warehouse'))
  const measure = instrument(h)
  click(button('Sell'))
  return { sale: Array.from({ length: 9 }, () => measure(() => click(button('Sell')))) }
}

function grid(kind: StoreKind, size: number) {
  const h = mountShell(5, kind, 'sparql')
  const f = h.store.factory
  const nn = (s: string) => f.namedNode(s)
  const g = nn(NETWORK_GRAPH)
  const dbl = (n: number) => f.literal(String(n), nn(NS.xsd + 'double'))
  const int = (n: number) => f.literal(String(n), nn(NS.xsd + 'integer'))
  const entry = (i: number) => nn(`urn:semblance:net:cost-${i}`)
  const add: Quad[] = []
  for (let i = 1; i <= size; i++) {
    const e = entry(i)
    add.push(
      f.quad(nn(NET + 'Capture'), nn(TREE + 'member'), e, g),
      f.quad(e, nn(NS.rdf + 'type'), nn(NET + 'Exchange'), g),
      f.quad(e, nn(NET + 'kind'), nn(NET + 'HttpKind'), g),
      f.quad(e, nn(NET + 'label'), f.literal(`GET /api/${i}`), g),
      f.quad(e, nn(NET + 'sequence'), int(i), g),
      f.quad(e, nn(NET + 'startedAt'), dbl(1000 + i), g),
      f.quad(e, nn(NET + 'status'), nn(NET + 'Pending'), g),
    )
  }
  h.runtime.write(NETWORK_GRAPH, { add, remove: [] })
  const app = nn(UI + 'app')
  h.runtime.apply({
    remove: [...h.store.match(app, nn(UI + 'page'), null), ...h.store.match(app, nn(UI + 'example'), null)],
    add: [f.quad(app, nn(UI + 'page'), nn(UI + 'Examples')), f.quad(app, nn(UI + 'example'), nn(UI + 'ExNetwork'))],
  })
  h.shell.flush()
  const gridNode = nn(UI + 'net-grid')
  h.runtime.apply({ remove: [], add: [f.quad(gridNode, nn(NS.c + 'sortColumn'), nn(UI + 'net-col-took'))] })
  h.shell.flush()
  const measure = instrument(h)
  const respond = (i: number, ms: number) => {
    const e = entry(i)
    const r = nn(`urn:semblance:net:cost-${i}/~resp`)
    h.runtime.write(NETWORK_GRAPH, {
      remove: [f.quad(e, nn(NET + 'status'), nn(NET + 'Pending'), g)],
      add: [f.quad(e, nn(NET + 'status'), nn(NET + 'Complete'), g), f.quad(e, nn(NET + 'endedAt'), dbl(1000 + i + ms), g), f.quad(e, nn(NS.http + 'resp'), r, g), f.quad(r, nn(NS.http + 'statusCodeValue'), int(200), g)],
    })
    h.shell.flush()
  }
  respond(size - 1, 5)
  return { response: Array.from({ length: 9 }, (_, k) => measure(() => respond(size - 10 - k * 7, 40 + k))) }
}

function dashboard(kind: StoreKind, thousands: number) {
  const clock = new ManualClock()
  const h = mountSite(kind, 'sparql', clock)
  h.runtime.views.clock = clock
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const advance = (ms: number) => (clock.advance(ms), h.shell.flush())
  click(button('Examples'))
  click(navItem('Sales dashboard'))
  for (let i = 0; i < thousands; i++) {
    click(button('Add 1,000 orders'))
    advance(2000)
  }
  const chip = (label: string) => [...(h.shell.nodeOf(UI + 'ex-dashboard/~root') as Element).querySelectorAll('[data-sem-c=chips] button')].find((b) => b.firstChild!.textContent === label)!
  const measure = instrument(h)
  const filter = Array.from({ length: 7 }, () => measure(() => click(chip('Tea'))))
  const batch: Sample[] = []
  for (let k = 0; k < 4; k++) {
    click(button('Add 1,000 orders'))
    batch.push(measure(() => advance(40)))
    advance(2000)
  }
  return { filter, batch }
}

const kinds = (process.argv.slice(2).length ? process.argv.slice(2) : ['wat', 'rust', 'oxigraph']) as StoreKind[]
const table: Record<string, Record<string, string>> = {}
// IVM_ONLY=dashboard (or warehouse, grid): one example (for a CPU profile of it).
const only = process.env.IVM_ONLY
for (const kind of kinds) {
  if (!only || only === 'warehouse') for (const [name, samples] of Object.entries(warehouse(kind, 2000))) table[`warehouse ${name} (${kind})`] = summarize(samples)
  if (!only || only === 'grid') for (const [name, samples] of Object.entries(grid(kind, 2000))) table[`grid ${name} (${kind})`] = summarize(samples)
  if (!only || only === 'dashboard') for (const [name, samples] of Object.entries(dashboard(kind, 2))) table[`dashboard ${name} (${kind})`] = summarize(samples)
}
const cols = Object.keys(Object.values(table)[0]!)
console.log(`| | ${cols.join(' | ')} |\n|---|${cols.map(() => '---:').join('|')}|`)
for (const [row, v] of Object.entries(table)) console.log(`| ${row} | ${cols.map((c) => v[c]).join(' | ')} |`)
