// The reference server for remote sources (src/node/source-server.ts, docs/REMOTE.md): what a
// subscription receives, writes and their refusal, resuming after a gap, and the cost of a change.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DataFactory, Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { SourceServer } from '../src/node/source-server.ts'
import { type DeltaMessage, fromNTriples, type Pattern, serverSentEvents, type Snapshot, toNTriples } from '../src/source-protocol.ts'

const f = DataFactory
const EX = 'https://example.org/s#'
const PREFIX = `@prefix ex: <${EX}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n`
const ttl = (s: string) => new Parser({ format: 'text/turtle' }).parse(PREFIX + (s.trim().endsWith('.') ? s : s + ' .'))
const nt = (s: string) => toNTriples(ttl(s))
const lines = (s: string) => s.split('\n').filter(Boolean).sort()

const TODOS: Pattern[] = [{ class: EX + 'Todo' }, { subject: EX + 'list', predicate: EX + 'item' }]

function server(extra = 0) {
  const s = new SourceServer()
  s.load(PREFIX + `ex:list ex:item ex:a , ex:b . ex:a a ex:Todo ; rdfs:label "A" . ex:b a ex:Todo ; rdfs:label "B" . ex:other ex:note "not the page's" .`)
  // Statements no page here binds to: the store's size, not the page's part of it.
  if (extra) s.change({ add: Array.from({ length: extra }, (_, i) => f.quad(f.namedNode(`${EX}n${i}`), f.namedNode(EX + 'note'), f.literal(String(i)))), remove: [] })
  return s
}

function follow(s: SourceServer, patterns: Pattern[], after?: number) {
  const got: { event: string; data: Snapshot & DeltaMessage }[] = []
  const stop = s.subscribe(patterns, after, (event, data) => void got.push({ event, data: data as Snapshot & DeltaMessage }))
  return { got, stop }
}

describe('the reference source server', () => {
  it('sends a subscription its part of the store, then only the changes that concern it', () => {
    const s = server()
    const { got } = follow(s, TODOS)
    expect(got[0]!.event).toBe('snapshot')
    expect(lines(got[0]!.data.add)).toEqual(lines(nt(`ex:list ex:item ex:a , ex:b . ex:a a ex:Todo ; rdfs:label "A" . ex:b a ex:Todo ; rdfs:label "B" .`)))
    s.change({ add: ttl(`ex:other ex:note "still not"`), remove: [] })
    expect(got).toHaveLength(1)
    s.change({ add: ttl(`ex:a rdfs:label "A2"`), remove: ttl(`ex:a rdfs:label "A"`) })
    expect(got[1]!.event).toBe('delta')
    expect(got[1]!.data.add).toBe(nt(`ex:a rdfs:label "A2"`))
    expect(got[1]!.data.remove).toBe(nt(`ex:a rdfs:label "A"`))
    expect(got[1]!.data.cursor).toBe(s.cursor)
  })

  it('sends a subject whole when it becomes an instance of a bound class, and takes it back when it stops', () => {
    const s = server()
    s.change({ add: ttl(`ex:c rdfs:label "C" ; ex:note "n"`), remove: [] })
    const { got } = follow(s, [...TODOS, { predicate: EX + 'note' }])
    s.change({ add: ttl(`ex:c a ex:Todo`), remove: [] })
    expect(lines(got[1]!.data.add)).toEqual(lines(nt(`ex:c a ex:Todo ; rdfs:label "C" ; ex:note "n"`)))
    s.change({ add: [], remove: ttl(`ex:c a ex:Todo`) })
    // ex:note is bound by a pattern of its own, so it stays.
    expect(lines(got[2]!.data.remove)).toEqual(lines(nt(`ex:c a ex:Todo ; rdfs:label "C"`)))
  })

  it('takes a write as one step and refuses a stale one with what it holds', () => {
    const s = server()
    const { got } = follow(s, TODOS)
    const ok = s.write({ id: 'w1', add: nt(`ex:a rdfs:label "A2"`), remove: nt(`ex:a rdfs:label "A"`) })
    expect(ok).toEqual({ ok: true, cursor: s.cursor })
    expect(got[1]!.data.write).toBe('w1')
    // Based on what is no longer there: refused, and the repair says what the store holds.
    const stale = s.write({ id: 'w2', add: nt(`ex:a rdfs:label "A3"`), remove: nt(`ex:a rdfs:label "A"`) })
    expect(stale).toEqual({ ok: false, reason: 'stale', repair: { add: '', remove: nt(`ex:a rdfs:label "A3"`) } })
    expect(got).toHaveLength(2)
  })

  it('refuses what its validation refuses', () => {
    const s = new SourceServer({ validate: ({ add }) => (add.some((q) => q.object.value.length > 3) ? 'too long' : undefined) })
    s.load(PREFIX + `ex:a rdfs:label "A" .`)
    const r = s.write({ id: 'w', add: nt(`ex:a rdfs:label "long"`), remove: nt(`ex:a rdfs:label "A"`) })
    expect(r).toEqual({ ok: false, reason: 'too long', repair: { add: nt(`ex:a rdfs:label "A"`), remove: nt(`ex:a rdfs:label "long"`) } })
  })

  it('resumes from a cursor its log still reaches, and resets from one it does not', () => {
    const s = new SourceServer({ logSize: 2 })
    s.load(PREFIX + `ex:a a ex:Todo ; rdfs:label "A" .`)
    const at = s.cursor
    s.change({ add: ttl(`ex:a rdfs:label "A2"`), remove: ttl(`ex:a rdfs:label "A"`) })
    const resumed = follow(s, TODOS, at).got
    expect(resumed.map((m) => m.event)).toEqual(['delta', 'cursor'])
    expect(resumed[0]!.data.add).toBe(nt(`ex:a rdfs:label "A2"`))
    s.change({ add: ttl(`ex:b a ex:Todo`), remove: [] })
    s.change({ add: ttl(`ex:c a ex:Todo`), remove: [] })
    const reset = follow(s, TODOS, at).got
    expect(reset[0]!.event).toBe('snapshot')
    expect(reset[0]!.data.reset).toBe(true)
    expect(lines(reset[0]!.data.add)).toEqual(lines(nt(`ex:a a ex:Todo ; rdfs:label "A2" . ex:b a ex:Todo . ex:c a ex:Todo .`)))
  })

  it('costs the change, not the size of the store', () => {
    const work = (extra: number) => {
      const s = server(extra)
      follow(s, TODOS)
      follow(s, [{ predicate: EX + 'label' }])
      const before = s.work.checks
      s.change({ add: ttl(`ex:a rdfs:label "A2"`), remove: ttl(`ex:a rdfs:label "A"`) })
      s.change({ add: ttl(`ex:d a ex:Todo ; rdfs:label "D"`), remove: [] })
      return s.work.checks - before
    }
    expect(work(10_000)).toBe(work(10))
  })

  it('speaks the protocol over HTTP', async () => {
    const s = server()
    const handle = s.handler('/store/')
    const http = createServer((req, res) => void (handle(req, res) || res.writeHead(404).end()))
    await new Promise<void>((r) => http.listen(0, r))
    const base = `http://localhost:${(http.address() as AddressInfo).port}/store/`
    try {
      const res = await fetch(`${base}changes?patterns=${encodeURIComponent(JSON.stringify(TODOS))}`)
      expect(res.headers.get('content-type')).toBe('text/event-stream')
      const events = serverSentEvents(res.body!)
      const first = (await events.next()).value!
      expect(first.event).toBe('snapshot')
      expect(fromNTriples(JSON.parse(first.data).add, f)).toHaveLength(6)
      const w = await fetch(`${base}writes`, { method: 'POST', body: JSON.stringify({ id: 'w1', add: nt(`ex:b rdfs:label "B2"`), remove: nt(`ex:b rdfs:label "B"`) }) })
      expect(await w.json()).toEqual({ ok: true, cursor: s.cursor })
      const second = (await events.next()).value!
      expect(second.event).toBe('delta')
      expect(JSON.parse(second.data)).toMatchObject({ write: 'w1', add: nt(`ex:b rdfs:label "B2"`) })
      const refused = await fetch(`${base}writes`, { method: 'POST', body: JSON.stringify({ id: 'w2', add: '', remove: nt(`ex:b rdfs:label "B"`) }) })
      expect(refused.status).toBe(409)
      await events.return(undefined)
    } finally {
      s.drop()
      http.closeAllConnections()
      await new Promise((r) => http.close(r))
    }
  })
})
