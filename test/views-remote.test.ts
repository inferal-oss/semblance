// Views over data that arrives as deltas from a store elsewhere (src/views/remote.ts, docs/VIEWS.md,
// docs/REMOTE.md's protocol): the example's views (examples/views/) following the reference server,
// in-process and over HTTP (Jelly and server-sent events). The snapshot replaces what the views held
// of the patterns, each delta is one tick, a broken stream resumes from its cursor (or takes a reset
// snapshot when the gap is longer than the server's log), and a change from the store costs what it
// changes, however large the store is.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DataFactory } from 'n3'
import { describe, expect, it } from 'vitest'
import { EX, patterns, todoViews } from '../examples/views/todos.ts'
import { todoStore } from '../examples/remote/store.ts'
import { SourceServer } from '../src/node/source-server.ts'
import { localTransport } from '../src/simulated-store.ts'
import { followSource, httpTransport, openViews, type Row } from '../src/views/node.ts'

const { namedNode: nn, literal, quad } = DataFactory
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label'
const bool = (v: boolean) => literal(String(v), nn('http://www.w3.org/2001/XMLSchema#boolean'))
const done = (id: string, v: boolean) => quad(nn(EX + id), nn(EX + 'done'), bool(v))
const markDone = (id: string) => ({ add: [done(id, true)], remove: [done(id, false)] })
const todo = (id: string, label: string, created: string) => [
  quad(nn(EX + id), nn(RDF_TYPE), nn(EX + 'Todo')),
  quad(nn(EX + id), nn(LABEL), literal(label)),
  quad(nn(EX + id), nn(EX + 'done'), bool(false)),
  quad(nn(EX + id), nn(EX + 'created'), literal(created, nn('http://www.w3.org/2001/XMLSchema#dateTime'))),
]
const labels = (rows: Row[]) => rows.map((r) => r.get('label')!.value)
const counts = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.get('done')!.value, Number(r.get('n')!.value)]))
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(ok()).toBe(true)
}

describe('views following a remote store', () => {
  it('take the snapshot, then each delta as one tick', async () => {
    const server = todoStore()
    const views = await openViews({ kind: 'wat', strict: true })
    const { open, counts: byDone } = todoViews(views)
    const events: string[] = []
    const source = followSource(views, localTransport(server), { patterns, onChange: (e, d) => events.push(`${e} +${d.add.length} -${d.remove.length}`) })
    await source.ready
    expect(source.live).toBe(true)
    expect(source.cursor).toBe(server.cursor)
    expect(labels(open.orderedRows())).toEqual(['Sketch the style layer', 'Wire up behaviour'])
    expect(counts(byDone.rows())).toEqual({ true: 1, false: 2 })

    const tick = views.tick
    server.change(markDone('t2'))
    expect(views.tick).toBe(tick + 1)
    expect(labels(open.orderedRows())).toEqual(['Wire up behaviour'])
    expect(counts(byDone.rows())).toEqual({ true: 2, false: 1 })
    server.change({ add: todo('t4', 'Ship it', '2026-11-04T09:00:00Z'), remove: [] })
    expect(labels(open.orderedRows())).toEqual(['Wire up behaviour', 'Ship it'])
    // What the patterns do not cover never arrives.
    server.change({ add: [quad(nn(EX + 'elsewhere'), nn(LABEL), literal('not a todo'))], remove: [] })
    expect(views.tick).toBe(tick + 2)
    expect(events).toEqual(['snapshot +12 -0', 'delta +1 -1', 'delta +4 -0'])
    source.stop()
    views.dispose(true)
  })

  it('resume from their cursor after a break, or replace what they hold after a long one', async () => {
    const server = new SourceServer({ logSize: 3 })
    server.load(`@prefix ex: <${EX}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      ex:t1 a ex:Todo ; rdfs:label "One" ; ex:done false ; ex:created "2026-11-01T09:00:00Z"^^xsd:dateTime .
      ex:t2 a ex:Todo ; rdfs:label "Two" ; ex:done false ; ex:created "2026-11-02T09:00:00Z"^^xsd:dateTime .`)
    const views = await openViews({ kind: 'wat', strict: true })
    const { open } = todoViews(views)
    // Local data beside the source's: a snapshot replaces only what the patterns cover.
    views.load(`@prefix ex: <${EX}> . ex:mine ex:note "kept" .`)
    const errors: unknown[] = []
    const source = followSource(views, localTransport(server), { patterns, backoff: { minMs: 1, maxMs: 1 }, onError: (e) => errors.push(e) })
    await source.ready
    expect(labels(open.orderedRows())).toEqual(['One', 'Two'])

    // A short break: what was missed arrives as deltas.
    server.drop()
    server.change(markDone('t1'))
    await until(() => source.live && labels(open.orderedRows()).join() === 'Two')
    expect(errors).toHaveLength(1)
    expect(source.cursor).toBe(server.cursor)

    // A long one (more steps than the log keeps): a reset snapshot, and what went in the meantime goes.
    server.drop()
    server.change({ add: [], remove: todo('t2', 'Two', '2026-11-02T09:00:00Z') })
    for (let i = 3; i < 8; i++) server.change({ add: todo('t' + i, 'Todo ' + i, `2026-11-0${i}T09:00:00Z`), remove: [] })
    server.change({ add: [], remove: todo('t7', 'Todo 7', '2026-11-07T09:00:00Z') })
    await until(() => source.live && source.cursor === server.cursor)
    expect(labels(open.orderedRows())).toEqual(['Todo 3', 'Todo 4', 'Todo 5', 'Todo 6'])
    const f = views.store.factory
    expect(views.store.match(f.namedNode(EX + 't2'), null, null)).toHaveLength(0)
    expect(views.store.match(f.namedNode(EX + 'mine'), null, null)).toHaveLength(1)
    source.stop()
    views.dispose(true)
  })

  it.each([true, false])('follow over HTTP (Jelly: %s)', async (jelly) => {
    const server = todoStore()
    const handle = server.handler('/store/')
    const http = createServer((req, res) => void (handle(req, res) || res.writeHead(404).end())).listen(0)
    await new Promise((r) => http.once('listening', r))
    const url = `http://localhost:${(http.address() as AddressInfo).port}/store/`
    const views = await openViews({ kind: 'wat', strict: true })
    const { open, counts: byDone } = todoViews(views)
    const source = followSource(views, httpTransport({ url, jelly }), { patterns })
    await source.ready
    expect(labels(open.orderedRows())).toEqual(['Sketch the style layer', 'Wire up behaviour'])
    server.change(markDone('t3'))
    await until(() => labels(open.orderedRows()).join() === 'Sketch the style layer')
    expect(counts(byDone.rows())).toEqual({ true: 2, false: 1 })
    source.stop()
    await new Promise((r) => http.close(r))
    views.dispose(true)
  })

  it('cost what a change changes, however large the store', async () => {
    const measure = async (unrelated: number) => {
      const server = todoStore()
      // Statements the patterns do not cover, on the server; and as many in the views' own store.
      const noise = Array.from({ length: unrelated }, (_, i) => quad(nn(EX + 'n' + i), nn(EX + 'p' + (i % 11)), literal('v' + i)))
      server.change({ add: noise, remove: [] })
      const views = await openViews({ kind: 'wat' })
      views.store.loadTurtle(`@prefix ex: <${EX}> .\n` + Array.from({ length: unrelated }, (_, i) => `ex:m${i} ex:q${i % 11} "w${i}" .`).join('\n'))
      todoViews(views)
      const source = followSource(views, localTransport(server), { patterns })
      await source.ready
      const t = views.runtime.totals
      const checks = server.work.checks
      const before = { rowsIn: t.rowsIn, partitions: t.partitions }
      server.change(markDone('t2'))
      server.change({ add: todo('t9', 'Nine', '2026-11-09T09:00:00Z'), remove: [] })
      const work = { rowsIn: t.rowsIn - before.rowsIn, partitions: t.partitions - before.partitions, checks: server.work.checks - checks }
      source.stop()
      views.dispose(true)
      return work
    }
    const small = await measure(10)
    const large = await measure(20_000)
    expect(large).toEqual(small)
    expect(small.rowsIn).toBeGreaterThan(0)
  })
})
