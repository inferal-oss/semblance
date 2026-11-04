// The network inspector's grid over a large capture (docs/IVM.md §17 phase 2, "Measure"): its
// window is maintained views (c:GridWindowOlder, c:GridWindowNewer, c:GridWindowCounts), so a
// response arriving for an old member re-sorts that member's row in the same tick, and the work
// it takes - rule runs, triples read, SPARQL rows, view rows, DOM operations - is the same over
// 200 captured entries as over 2,000.
import { describe, expect, it } from 'vitest'
import { NETWORK_GRAPH, NS } from '../src/ns.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const NET = NS.net

function network(size: number, prefer: 'sparql' | 'function', column: string) {
  const h = mountShell(5, 'hybrid', prefer)
  const f = h.store.factory
  const nn = (s: string) => f.namedNode(s)
  const g = nn(NETWORK_GRAPH)
  const dbl = (n: number) => f.literal(String(n), nn(NS.xsd + 'double'))
  const int = (n: number) => f.literal(String(n), nn(NS.xsd + 'integer'))
  // A capture of `size` requests, all still pending: no duration yet.
  const entry = (i: number) => nn(`urn:semblance:net:cost-${i}`)
  h.runtime.transaction(() => {
    const add = []
    for (let i = 1; i <= size; i++) {
      const e = entry(i)
      add.push(
        f.quad(nn(NET + 'Capture'), nn(NS.tree + 'member'), e, g),
        f.quad(e, nn(NS.rdf + 'type'), nn(NET + 'Exchange'), g),
        f.quad(e, nn(NET + 'kind'), nn(NET + 'HttpKind'), g),
        f.quad(e, nn(NET + 'label'), f.literal(`GET /api/${i}`), g),
        f.quad(e, nn(NET + 'sequence'), int(i), g),
        f.quad(e, nn(NET + 'startedAt'), dbl(1000 + i), g),
        f.quad(e, nn(NET + 'status'), nn(NET + 'Pending'), g),
      )
    }
    h.runtime.write(NETWORK_GRAPH, { add, remove: [] })
  })
  const app = nn(UI + 'app')
  h.runtime.apply({
    remove: [...h.store.match(app, nn(UI + 'page'), null), ...h.store.match(app, nn(UI + 'example'), null)],
    add: [f.quad(app, nn(UI + 'page'), nn(UI + 'Examples')), f.quad(app, nn(UI + 'example'), nn(UI + 'ExNetwork'))],
  })
  h.shell.flush()
  const grid = nn(UI + 'net-grid')
  // Sort by a column (pending ones last), and hide the earlier visit's samples.
  h.runtime.transaction(() => {
    h.runtime.apply({ remove: [], add: [f.quad(grid, nn(NS.c + 'sortColumn'), nn(UI + column))] })
    h.runtime.apply({ remove: h.store.match(nn(UI + 'net-samples'), nn(NS.c + 'included'), null), add: [f.quad(nn(UI + 'net-samples'), nn(NS.c + 'included'), f.literal('false', nn(NS.xsd + 'boolean')))] })
  })
  h.shell.flush()
  const node = (iri: string) => [...h.document.querySelectorAll('*')].find((el) => h.shell.keyOf(el) === iri) as HTMLElement | undefined
  const rows = () => [...node(UI + 'net-grid/~root')!.querySelectorAll('tbody > tr[role=row]')].map((tr) => tr.textContent!)
  const counters = { read: 0, sparqlRows: 0 }
  const { match, select, construct } = h.store
  h.store.match = (...args) => {
    const quads = match.apply(h.store, args)
    counters.read += quads.length
    return quads
  }
  h.store.select = (...args) => {
    const r = select.apply(h.store, args)
    counters.sparqlRows += r.length
    return r
  }
  h.store.construct = (...args) => {
    const r = construct.apply(h.store, args)
    counters.sparqlRows += r.length
    return r
  }
  const t = h.runtime.views.totals
  const snap = () => ({ ruleRuns: h.screen.engine.stats.ruleRuns, read: counters.read, sparqlRows: counters.sparqlRows, domOps: h.shell.ops, viewRows: t.rowsIn, partitions: t.partitions, rebuilds: t.rebuilds })
  /** The response for entry i arrives: it is complete, took `ms`, and has this status code. */
  const respond = (i: number, ms: number, code: number) => {
    const e = entry(i)
    const r = nn(`urn:semblance:net:cost-${i}/~resp`)
    h.runtime.write(NETWORK_GRAPH, {
      remove: [f.quad(e, nn(NET + 'status'), nn(NET + 'Pending'), g)],
      add: [f.quad(e, nn(NET + 'status'), nn(NET + 'Complete'), g), f.quad(e, nn(NET + 'endedAt'), dbl(1000 + i + ms), g), f.quad(e, nn(NS.http + 'resp'), r, g), f.quad(r, nn(NS.http + 'statusCodeValue'), int(code), g)],
    })
    h.shell.flush()
  }
  return { h, rows, snap, respond }
}

describe('the network grid over a large capture', () => {
  // How long each took reads the member; its HTTP code goes through a hop (c:via http:resp) that a
  // pending entry does not have yet. Either way, the same three responses in the same order.
  for (const [column, by] of [['net-col-took', 'how long each took'], ['net-col-code', 'its response’s code']] as const)
    for (const prefer of ['sparql', 'function'] as const) {
      it(`sorted by ${by}, re-sorts a row when its response arrives, at the same cost over 200 entries as over 2,000 (${prefer} rules)`, () => {
        const measure = (size: number) => {
          const n = network(size, prefer, column)
          expect(n.rows()).toHaveLength(50)
          // Each member once: a pending entry has no hop, and that does not join it to every response.
          expect(new Set(n.rows()).size).toBe(50)
          // All pending: capture order, the newest page.
          expect(n.rows()[0]).toContain(`GET /api/${size - 49}`)
          // Warm up: two responses (the first moves to the top: the only one with a sort value).
          n.respond(size - 20, 30, 200)
          expect(n.rows()[0]).toContain(`GET /api/${size - 20}`)
          n.respond(size - 30, 50, 404)
          // An old entry's response: it sorts before both, so it goes first - in the same tick.
          const a = n.snap()
          n.respond(size - 40, 10, 100)
          const b = n.snap()
          expect(n.rows()[0]).toContain(`GET /api/${size - 40}`)
          expect(n.rows()[1]).toContain(`GET /api/${size - 20}`)
          expect(n.rows()[2]).toContain(`GET /api/${size - 30}`)
          // An entry outside the window answering changes no row.
          const c = n.snap()
          n.respond(size - 120, 5, 100)
          const d = n.snap()
          const diff = (x: typeof a, y: typeof a) => Object.fromEntries(Object.entries(y).map(([k, v]) => [k, v - x[k as keyof typeof x]]))
          return { inside: diff(a, b), outside: diff(c, d), rowsOutside: n.rows()[0] }
        }
        const small = measure(200)
        const large = measure(2000)
        process.stderr.write(`[grid-cost ${column} ${prefer}] 200: ${JSON.stringify(small)}\n[grid-cost ${column} ${prefer}] 2000: ${JSON.stringify(large)}\n`)
        expect(large.inside).toEqual(small.inside)
        expect(large.outside).toEqual(small.outside)
        // Nothing was rebuilt; a response is one partition per view.
        expect(small.inside.rebuilds).toBe(0)
        expect(small.outside.rebuilds).toBe(0)
        expect(small.inside.partitions).toBeLessThanOrEqual(6)
        // Outside the window: the views change no row, so the window rule does not run.
        expect(small.outside.domOps).toBe(0)
      }, 600_000)
    }
})
