// A query view's results as graph data (#7): each query of its list (c:queries) runs as a result set
// (c:QueryViewRuns, iv:perQuery … iv:listed), which the view names by iv:run and tells apart by
// iv:runOf; a view that binds a variable runs its own, <view>/~run-n. The rows are the query's
// triples, as running it directly gives them, and follow the binding as it changes.
import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { termKey } from '../src/rdf.ts'
import { mountShell, mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

type H = ReturnType<typeof mountSite>

const nn = (h: H, x: string) => h.store.factory.namedNode(x)
const one = (h: H, s: string, p: string) => h.store.match(nn(h, s), nn(h, p), null)[0]?.object

/** A view's runs: query -> the run's triples (as keys), read from the views graph. */
function runsOf(h: H, view: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const q of h.store.match(nn(h, view), nn(h, NS.iv + 'run'), null)) {
    const run = q.object.value
    const of = one(h, run, NS.iv + 'runOf')?.value ?? '?'
    const rows = h.store.match(nn(h, run), nn(h, NS.rs + 'solution'), null).map((s) => {
      const value = (v: string) => one(h, s.object.value + '-' + v, NS.rs + 'value')
      return ['subject', 'predicate', 'object'].map((v) => termKey(value(v)!)).join(' ')
    })
    out.set(of, rows.sort())
  }
  return out
}

/** The query's triples, run directly (with its $variable put in), as the function twin does. */
function expected(h: H, view: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const variable = one(h, view, NS.c + 'bindVariable')?.value
  const from = one(h, view, NS.c + 'bindFrom')
  const property = one(h, view, NS.c + 'bindProperty')
  const value = from && property ? one(h, from.value, property.value) : undefined
  let cell = one(h, view, NS.c + 'queries')
  while (cell && cell.value !== NS.rdf + 'nil') {
    const query = h.store.match(cell as never, nn(h, NS.rdf + 'first'), null)[0]!.object
    let text = one(h, query.value, NS.sem + 'construct')!.value
    if (variable && value) text = text.replaceAll('$' + variable, `<${value.value}>`)
    const keys = new Set(h.runtime.views.context.construct(text).map((t) => [t.subject, t.predicate, t.object].map(termKey).join(' ')))
    out.set(query.value, [...keys].sort())
    cell = h.store.match(cell as never, nn(h, NS.rdf + 'rest'), null)[0]?.object
  }
  return out
}

describe('query views run their queries as result sets', () => {
  it('a bound view runs each query of its list, and again when the binding changes', () => {
    const h = mountSite('wat')
    const f = h.store.factory
    const set = (s: string, p: string, o: string) => h.runtime.apply({ remove: h.store.match(f.namedNode(s), f.namedNode(p), null), add: [f.quad(f.namedNode(s), f.namedNode(p), f.namedNode(o))] })
    set(UI + 'app', UI + 'page', UI + 'Components')
    set(UI + 'app', UI + 'galleryGroup', UI + 'GroupInspection')
    h.shell.flush()
    const view = UI + 'in-qv-view'
    expect(h.shell.nodeOf(view + '/~root'), 'the query view is shown').toBeTruthy()
    for (const group of ['FeedbackGroup', 'InspectionGroup', 'DataGroup']) {
      set(UI + 'in-qv-pick', UI + 'in-qv-group', NS.c + group)
      h.shell.flush()
      const runs = runsOf(h, view)
      expect([...runs.keys()].sort(), group).toEqual([UI + 'in-qv-q-group', UI + 'in-qv-q-members'])
      const want = expected(h, view)
      for (const [q, rows] of want) {
        expect(rows.length, `${group} ${q}`).toBeGreaterThan(0)
        expect(runs.get(q), `${group} ${q}`).toEqual(rows)
      }
      // Bound: the view's own runs, by place in its list.
      expect(h.store.match(nn(h, view), nn(h, NS.iv + 'run'), null).map((q) => q.object.value).sort()).toEqual([view + '/~run-1', view + '/~run-2'])
    }
  })

  it('an unbound view that follows updates shares its queries\' runs, maintained as the graph changes', async () => {
    const h = mountShell(5, 'wat')
    h.runtime.refreshShare = 1
    const f = h.store.factory
    h.runtime.apply({ remove: h.store.match(f.namedNode(UI + 'views'), f.namedNode(NS.c + 'selected'), null), add: [f.quad(f.namedNode(UI + 'views'), f.namedNode(NS.c + 'selected'), f.namedNode(UI + 'logTab'))] })
    h.shell.flush()
    const view = UI + 'changeLogHead'
    expect(h.shell.nodeOf(view + '/~root'), 'the change log is shown').toBeTruthy()
    const check = (what: string) => {
      const runs = runsOf(h, view)
      expect([...runs.keys()].sort(), what).toEqual([UI + 'qStream', UI + 'qStreamView'])
      for (const [q, rows] of expected(h, view)) expect(runs.get(q), `${what} ${q}`).toEqual(rows)
      // Unbound: a run at the query's own IRI.
      expect(h.store.match(nn(h, view), nn(h, NS.iv + 'run'), null).map((q) => q.object.value).sort()).toEqual([UI + 'qStream', UI + 'qStreamView'])
    }
    check('first')
    h.runtime.apply({ add: [f.quad(f.namedNode(NS.beh + 'ChangeLog'), f.namedNode(NS.rdfs + 'comment'), f.literal('a note'))], remove: [] })
    h.shell.flush()
    // A followed run is written at the next refresh (a frame).
    await new Promise<void>((r) => setTimeout(r, 0))
    h.shell.flush()
    expect(runsOf(h, view).get(UI + 'qStream')!.some((r) => r.includes('a note'))).toBe(true)
    check('after a change')
  })

  it('a maintained run whose variable has no value reads nothing (no free $variable)', () => {
    const h = mountShell(5, 'wat')
    h.shell.flush()
    const view = UI + 'inspector'
    expect(h.shell.nodeOf(view + '/~root'), 'the inspector is shown').toBeTruthy()
    const runs = h.store.match(nn(h, view), nn(h, NS.iv + 'run'), null).map((q) => q.object.value)
    expect(runs.length).toBe(5)
    for (const run of runs) {
      expect(h.store.match(nn(h, run), nn(h, NS.rs + 'solution'), null).length, run).toBe(0)
      expect(one(h, run, NS.iv + 'error')?.value, run).toContain('$node')
    }
  })
})
