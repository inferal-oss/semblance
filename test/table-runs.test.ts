// The Table's rows as graph data (#7): every table's query runs as a result set (c:TableRuns), which the
// table names by iv:run, so a SPARQL rule can read them.
import { describe, expect, it } from 'vitest'
import { MOD, NS } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
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

// The Table in SPARQL (#7): its rows read from the run, placed by order keys, values in the viewer's
// locale; the same as its function twin on every page that shows one, as headers sort and languages
// change. On wat (Oxigraph has no sx: functions, so it runs the twin either way).
describe('tables, SPARQL and function rules alike (wat)', () => {
  const sites = () => (['sparql', 'function'] as const).map((prefer) => mountSite('wat', prefer))
  type H = ReturnType<typeof mountSite>
  const go = (h: H, page: string, p = 'example') => {
    const f = h.store.factory
    const set = (s: string, pr: string, o: string) => h.runtime.apply({ remove: h.store.match(f.namedNode(s), f.namedNode(pr), null), add: [f.quad(f.namedNode(s), f.namedNode(pr), f.namedNode(o))] })
    set(UI + 'app', UI + 'page', UI + (p === 'example' ? 'Examples' : 'Components'))
    set(UI + 'app', UI + (p === 'example' ? 'example' : 'galleryGroup'), UI + page)
    h.shell.flush()
  }
  const tables = (h: H) => [...h.document.querySelectorAll('[data-sem-c=table]')].map((t) => t.outerHTML)
  const same = (hs: H[], what: string) => {
    const [a, b] = hs.map(tables)
    expect(a!.length, what).toBeGreaterThan(0)
    for (let i = 0; i < a!.length; i++) {
      if (a![i] === b![i]) continue
      let j = 0
      while (a![i]![j] === b![i]![j]) j++
      expect(a![i]!.slice(Math.max(0, j - 200), j + 200), `${what}: table ${i}`).toBe(b![i]!.slice(Math.max(0, j - 200), j + 200))
    }
    expect(a!.length, what).toBe(b!.length)
  }

  it('chooses the SPARQL rule on wat', () => {
    const rules = (mountSite('wat').screen.engine as unknown as { rules: { slot: string; kind: string }[] }).rules
    expect(rules.find((r) => r.slot === NS.c + 'TableRendering')?.kind).toBe('sparql')
  })

  it.each([
    ['ExWarehouse', 'example'],
    ['ExDashboard', 'example'],
    ['ExBudget', 'example'],
    ['ExCalendar', 'example'],
    ['ExCollab', 'example'],
    ['ExReader', 'example'],
    ['ExActivity', 'example'],
    ['GroupData', 'group'],
  ])('renders the same tables on %s, sorted by each column both ways, in every language', (page, kind) => {
    const hs = sites()
    for (const h of hs) go(h, page, kind)
    const shownTables = [...hs[0]!.document.querySelectorAll('[data-sem-c=table]')].map((t) => hs[0]!.shell.keyOf(t)!.replace(/\/~root$/, ''))
    const texts = hs.map((h, i) => h.runtime.project({ modality: MOD.Text, prefer: i ? 'function' : 'sparql', name: 'text-tables', roots: shownTables }))
    const sameText = (what: string) => {
      for (const t of shownTables) {
        const [a, b] = texts.map((x) => toText(x.index, t))
        expect(a, `${what}: ${t} as text`).toBe(b)
        expect(a!.length, `${what}: ${t} as text`).toBeGreaterThan(10)
      }
    }
    same(hs, 'shown')
    sameText('shown')
    const headers = (h: H) => [...h.document.querySelectorAll('[data-sem-c=table] thead button.sem-sort')]
    const count = headers(hs[0]!).length
    for (let i = 0; i < count; i++) {
      for (const click of [1, 2]) {
        for (const h of hs) h.fire(headers(h)[i]!, 'click')
        for (const h of hs) h.shell.flush()
        same(hs, `header ${i}, click ${click}`)
        sameText(`header ${i}, click ${click}`)
      }
    }
    for (const languages of [['uk'], ['de'], ['ar'], ['en']]) {
      for (const h of hs) h.screen.engine.reconfigure({ languages })
      for (const x of texts) x.engine.reconfigure({ languages })
      for (const h of hs) h.shell.flush()
      same(hs, languages.join())
      sameText(languages.join())
    }
  })
})
