// Views on their own cost what a change changes in them (docs/VIEWS.md, AGENTS.md rule 6): the work of
// one change - rows the views process, triples and rows read from the store - is the same for a store
// of 1 000 and of 50 000 statements the views do not read, and for views over 50 and over 2 000 todos.
import type { GraphStore } from '../src/store/types.ts'
import { describe, expect, it } from 'vitest'
import { openViews, type Views } from '../src/views/node.ts'

const EX = 'https://example.org/c#'
const P = `PREFIX ex: <${EX}>\n`

/** `todos` todos (half done), and `noise` statements no view reads: other predicates, and labels of things that are not todos. */
function data(todos: number, noise: number): string {
  const out = [`@prefix ex: <${EX}> .`]
  for (let i = 0; i < todos; i++) out.push(`ex:t${i} a ex:Todo ; ex:label "Todo ${String(i).padStart(5, '0')}" ; ex:n ${i % 7}${i % 2 ? ' ; ex:done true' : ''} .`)
  for (let i = 0; i < noise; i++) out.push(i % 2 ? `ex:o${i} ex:p${i % 13} "v${i}" .` : `ex:o${i} ex:label "Note ${i}" .`)
  return out.join('\n')
}

function counted(store: GraphStore) {
  const n = { read: 0, rows: 0 }
  const { match, select, construct } = store
  store.match = (...a) => {
    const r = match.apply(store, a)
    n.read += r.length
    return r
  }
  store.select = (...a) => {
    const r = select.apply(store, a)
    n.rows += r.length
    return r
  }
  store.construct = (...a) => {
    const r = construct.apply(store, a)
    n.rows += r.length
    return r
  }
  return n
}

async function measure(todos: number, noise: number) {
  const views = await openViews({ kind: 'wat' })
  views.store.loadTurtle(data(todos, noise))
  const open = views.select(EX + 'open', P + 'SELECT ?todo ?label WHERE { ?todo a ex:Todo ; ex:label ?label FILTER NOT EXISTS { ?todo ex:done true } } ORDER BY ?label LIMIT 20')
  const byN = views.select(EX + 'byN', P + 'SELECT ?n (COUNT(?todo) AS ?count) WHERE { ?todo a ex:Todo ; ex:n ?n } GROUP BY ?n')
  const labels = views.construct(EX + 'labels', P + 'CONSTRUCT { ?t rdfs:label ?l } WHERE { ?t a ex:Todo ; ex:label ?l }')
  const heard = { open: 0, byN: 0, labels: 0 }
  open.subscribe(() => heard.open++)
  byN.subscribe(() => heard.byN++)
  labels.subscribe(() => heard.labels++)
  const n = counted(views.store)
  const f = views.store.factory
  const done = f.quad(f.namedNode(EX + 't0'), f.namedNode(EX + 'done'), f.literal('true', f.namedNode('http://www.w3.org/2001/XMLSchema#boolean')))
  const toggle = (on: boolean) => views.apply(on ? { add: [done], remove: [] } : { add: [], remove: [done] })
  const relabel = (i: number) => {
    const s = f.namedNode(EX + 't2')
    const p = f.namedNode(EX + 'label')
    // Its place in the order stays: the change is the same in every size of view.
    return views.apply({ add: [f.quad(s, p, f.literal(`Todo 00002 v${i}`))], remove: views.store.match(s, p, null) })
  }
  // Warm: queries prepared, terms interned.
  for (let i = 0; i < 4; i++) toggle(i % 2 === 0), relabel(i)
  const work = (fn: () => void) => {
    const t = views.runtime.totals
    const before = { rowsIn: t.rowsIn, read: n.read, rows: n.rows, partitions: t.partitions, rebuilds: t.rebuilds }
    fn()
    return { rowsIn: t.rowsIn - before.rowsIn, read: n.read - before.read, rows: n.rows - before.rows, partitions: t.partitions - before.partitions, rebuilds: t.rebuilds - before.rebuilds }
  }
  const result = {
    toggle: work(() => (toggle(true), toggle(false))),
    relabel: work(() => relabel(9)),
    unrelated: work(() => views.apply({ add: [f.quad(f.namedNode(EX + 'o1'), f.namedNode(EX + 'p1'), f.literal('changed'))], remove: [] })),
    state: views.runtime.totals.state,
    heard,
  }
  views.dispose(true)
  return result
}

describe('views on their own: a change costs what it changes', () => {
  it('whatever the size of the store', async () => {
    const small = await measure(50, 1_000)
    const large = await measure(50, 50_000)
    expect(large.toggle).toEqual(small.toggle)
    expect(large.relabel).toEqual(small.relabel)
    expect(large.unrelated).toEqual(small.unrelated)
    // A change no view reads costs no view any work.
    expect(small.unrelated).toEqual({ rowsIn: 0, read: 0, rows: 0, partitions: 0, rebuilds: 0 })
    expect(small.toggle.rebuilds).toBe(0)
  })

  it('whatever the size of the views', async () => {
    const small = await measure(50, 1_000)
    const large = await measure(2_000, 1_000)
    expect(large.toggle).toEqual(small.toggle)
    expect(large.relabel).toEqual(small.relabel)
    // The views hold more, but a change does the same work.
    expect(large.state).toBeGreaterThan(small.state * 10)
  })
})
