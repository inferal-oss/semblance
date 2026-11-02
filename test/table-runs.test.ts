// The Table's rows as graph data (#7): every table's query runs as a result set (c:TableRuns), which the
// table names by iv:run, so a SPARQL rule can read them.
import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

describe('tables run their queries as result sets', () => {
  it('every shown table names a run whose rows are in the views graph', () => {
    const h = mountSite('wat')
    const f = h.store.factory
    const set = (s: string, p: string, o: string) => h.runtime.apply({ remove: h.store.match(f.namedNode(s), f.namedNode(p), null), add: [f.quad(f.namedNode(s), f.namedNode(p), f.namedNode(o))] })
    const seen = new Map<string, string>()
    const check = () => {
      for (const q of h.store.match(null, f.namedNode(NS.rdf + 'type'), f.namedNode(NS.c + 'Table'))) {
        if (!h.shell.nodeOf(q.subject.value + '/~root')) continue
        const run = h.store.match(q.subject, f.namedNode(NS.iv + 'run'), null)[0]?.object
        const rows = run ? h.store.match(run, f.namedNode(NS.rs + 'solution'), null).length : -1
        const isSet = run ? h.store.match(run, f.namedNode(NS.rdf + 'type'), f.namedNode(NS.rs + 'ResultSet')).length > 0 : false
        seen.set(q.subject.value.replace(UI, ''), `${run ? run.value.replace(UI, '') : 'no run'} ${isSet ? 'result set' : 'not a result set'} ${rows} rows`)
      }
    }
    for (const ex of ['ExActivity', 'ExBudget', 'ExCalendar', 'ExCollab', 'ExDashboard', 'ExReader', 'ExWarehouse']) {
      set(UI + 'app', UI + 'page', UI + 'Examples')
      set(UI + 'app', UI + 'example', UI + ex)
      h.shell.flush()
      check()
    }
    set(UI + 'app', UI + 'page', UI + 'Components')
    set(UI + 'app', UI + 'galleryGroup', UI + 'GroupData')
    h.shell.flush()
    check()
    expect(seen.size, [...seen.keys()].join()).toBeGreaterThanOrEqual(10)
    expect([...seen].filter(([, v]) => v.startsWith('no run') || !v.includes(' result set ')), 'tables without a result set').toEqual([])
  })
})
