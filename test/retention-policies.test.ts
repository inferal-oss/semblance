// The rest of the ret: vocabulary (docs/RETENTION.md §8.1): ret:pinned, and LDES's own policies read as
// LDES defines them (ldes:DurationAgoPolicy a ret:Within, ldes:PointInTimePolicy from a point in time,
// ldes:LatestVersionSubset the newest versions of each entity), by StreamRetention, from the graph and
// on a retained stream whose members' triples are written after their append, as the logs write them.
import { describe, expect, it } from 'vitest'
import type { Quad } from '@rdfjs/types'
import { EventBus } from '../src/behaviour/events.ts'
import { todoReactions } from '../src/examples/todo.ts'
import { createStore } from '../src/node/stores.ts'
import { BEH, EVENTS_GRAPH, LDES, NS, RDF_TYPE, RDFS_SUBCLASS } from '../src/ns.ts'
import { memoryBackend } from '../src/persistence.ts'
import { Retention } from '../src/retention/offload.ts'
import { type Member, type Policy, policiesOf, StreamRetention } from '../src/retention/policy.ts'
import { setup } from './helpers.ts'

const RET = NS.ret
const XSD = NS.xsd
const EX = 'https://example.org/policies#'

const policy = (p: Partial<Policy>): Policy => ({ iri: 'urn:p', having: [], exit: 'drop', announce: false, ...p })
const member = (seq: number): Member => ({ iri: 'urn:m' + seq, seq, at: seq * 1000 })
const iris = (xs: readonly Member[]) => xs.map((m) => m.iri)

describe('ret:pinned', () => {
  it('holds a pinned member wherever a policy lets it go, and lets it go as the policy would once unpinned', () => {
    const pins = new Set(['urn:m2'])
    const r = new StreamRetention(
      () => [policy({ iri: 'urn:a', amount: 2, exit: 'offload' })],
      () => false,
      undefined,
      undefined,
      undefined,
      (m) => pins.has(m),
    )
    const out: string[] = []
    for (let i = 1; i <= 6; i++) for (const e of r.append(member(i), i * 1000)) out.push(e.member.iri)
    expect(out).toEqual(['urn:m1', 'urn:m3', 'urn:m4'])
    expect(iris(r.pinnedMembers())).toEqual(['urn:m2'])
    // In memory, and the oldest there.
    expect(r.size).toBe(3)
    expect(r.oldest()?.iri).toBe('urn:m2')
    // Unpinned: it leaves at the next append, by the exit of the policy that let it go.
    pins.delete('urn:m2')
    expect(r.append(member(7), 7000).map((e) => `${e.member.iri}:${e.policy?.iri}`)).toEqual(['urn:m2:urn:a', 'urn:m5:urn:a'])
    expect(r.pinnedMembers()).toHaveLength(0)
  })

  it('is not let go by a ret:having policy, by the recall limit or by memory pressure either', () => {
    const pins = new Set<string>()
    const r = new StreamRetention(
      () => [policy({ iri: 'urn:a', amount: 1 }), policy({ iri: 'urn:u', amount: 2, having: ['urn:asserted'] })],
      () => true,
      () => 1,
      undefined,
      undefined,
      (m) => pins.has(m),
    )
    for (let i = 1; i <= 3; i++) r.append(member(i), i)
    // m1 and m2 are in the ret:having queue; pinning m1 keeps it when the queue lets it go.
    pins.add('urn:m1')
    expect(r.append(member(4), 4).map((e) => e.member.iri)).toEqual([])
    expect(iris(r.queue('urn:u'))).toEqual(['urn:m2', 'urn:m3'])
    expect(iris(r.pinnedMembers())).toEqual(['urn:m1'])
    // Pressure: half of the queue leaves, but not what is pinned.
    pins.add('urn:m2')
    expect(r.shrink(0.5)).toEqual([])
    expect(iris(r.pinnedMembers())).toEqual(['urn:m1', 'urn:m2'])
    // The recall limit (1): of what comes back, the pinned one stays.
    pins.add('urn:m0')
    expect(r.recall([member(0), { iri: 'urn:mx', seq: 0.5, at: 0 }]).map((e) => e.member.iri)).toEqual([])
    expect(iris(r.pinnedMembers())).toEqual(['urn:m0', 'urn:m1', 'urn:m2'])
    expect(iris(r.recalled())).toEqual(['urn:mx'])
    pins.add('urn:mx')
    expect(r.releaseRecalled()).toEqual([])
    expect(r.recalled()).toHaveLength(0)
  })

  it('keeps a pinned event of the change log past its bound, counted in memory, and offloads it once unpinned', async () => {
    const h = setup('wat', { prefer: 'sparql' }, 5, [
      `@prefix c: <https://semblance.dev/ns/component#> . @prefix beh: <https://semblance.dev/ns/behaviour#> . @prefix ex: <${EX}> .
       ex:inc a c:Button ; c:label "Inc" .
       ex:counter ex:n 0 .
       ex:Inc a beh:Reaction ; beh:when beh:Click ; beh:source ex:inc ; beh:undoable true ;
         beh:deletes "CONSTRUCT { <${EX}counter> <${EX}n> ?n } WHERE { <${EX}counter> <${EX}n> ?n }" ;
         beh:inserts "CONSTRUCT { <${EX}counter> <${EX}n> ?m } WHERE { <${EX}counter> <${EX}n> ?n BIND(?n + 1 AS ?m) }" .`,
    ])
    const { store, runtime } = h
    const f = store.factory
    const nn = (iri: string) => f.namedNode(iri)
    const amount = (p: string, n: number) => {
      for (const q of store.match(nn(p), nn(LDES.amount), null)) store.delete(q)
      store.add(f.quad(nn(p), nn(LDES.amount), f.literal(String(n), nn(XSD + 'integer'))))
    }
    amount(NS.beh + 'ChangeLogRetention', 3)
    amount(NS.beh + 'UndoRetention', 3)
    const backend = memoryBackend()
    Object.assign(runtime.retention.opts, { chunk: 4, schedule: (run: () => void) => run() })
    void runtime.retention.use(backend)
    const bus = new EventBus(runtime, h.screen, { prefer: 'sparql', functions: todoReactions })
    const members = () => store.match(nn(BEH.ChangeLog), nn(LDES.member), null, nn(EVENTS_GRAPH)).map((q) => q.object.value)
    bus.emit(NS.beh + 'Click', EX + 'inc')
    const first = store.match(nn(BEH.ChangeLog), nn(BEH.latest), null)[0]!.object.value
    // A person pins the first click (a reaction writes it in the input graph).
    runtime.apply({ add: [f.quad(nn(first), nn(RET + 'pinned'), f.literal('true', nn(XSD + 'boolean')))], remove: [] })
    for (let i = 0; i < 20; i++) bus.emit(NS.beh + 'Click', EX + 'inc')
    await runtime.retention.flush()
    const log = runtime.retention.get(BEH.ChangeLog)!
    expect(members()).toContain(first)
    expect(iris(log.retention.pinnedMembers())).toEqual([first])
    let x = log.figures()
    expect(x.inMemory).toBe(members().length)
    expect(x.inMemory).toBe(3 + 3 + 1)
    // Conservation: every member appended is somewhere (one more: the announcement of the first offload).
    expect(x.inMemory + x.offloaded + x.pending + x.dropped).toBe(21 + 1)
    // Unpinned, it leaves with the next append, to storage as its policy says.
    runtime.apply({ add: [], remove: store.match(nn(first), nn(RET + 'pinned'), null) })
    bus.emit(NS.beh + 'Click', EX + 'inc')
    await runtime.retention.flush()
    expect(members()).not.toContain(first)
    x = log.figures()
    expect(x.inMemory).toBe(3 + 3)
    expect(x.inMemory + x.offloaded + x.pending + x.dropped).toBe(22 + 1)
    expect(x.dropped).toBe(0)
  })
})

describe("LDES's own retention policies", () => {
  it('are ret:Policy subclasses in the vocabulary: the duration a ret:Within, the others policies of their own', () => {
    const h = setup('wat', {}, 5, [])
    const f = h.store.factory
    const supers = (c: string): Set<string> => {
      const seen = new Set<string>()
      const todo = [c]
      while (todo.length) {
        const x = todo.pop()!
        if (seen.has(x)) continue
        seen.add(x)
        for (const q of h.store.match(f.namedNode(x), f.namedNode(RDFS_SUBCLASS), null)) todo.push(q.object.value)
      }
      return seen
    }
    expect(supers(LDES.DurationAgoPolicy).has(RET + 'Within')).toBe(true)
    expect(supers(NS.beh + 'LatestMembersPolicy').has(RET + 'Latest')).toBe(true)
    for (const c of [LDES.LatestVersionSubset, LDES.PointInTimePolicy]) {
      expect(supers(c).has(RET + 'Policy')).toBe(true)
      expect(supers(c).has(RET + 'Latest') || supers(c).has(RET + 'Within')).toBe(false)
    }
    for (const c of [LDES.DurationAgoPolicy, LDES.LatestVersionSubset, LDES.PointInTimePolicy, RET + 'Latest', RET + 'Within', RET + 'UntilAcknowledged'])
      expect(supers(c).has(NS.ldes + 'RetentionPolicy')).toBe(true)
  })

  it('are read from the graph as LDES defines them, an app subclass included', () => {
    const store = createStore('wat')
    const f = store.factory
    const nn = (iri: string) => f.namedNode(iri)
    const s = nn(EX + 'log')
    const view = nn(EX + 'view')
    const int = (n: number) => f.literal(String(n), nn(XSD + 'integer'))
    store.add(f.quad(s, nn(LDES.view), view))
    store.add(f.quad(s, nn(LDES.versionOfPath), nn(EX + 'of')))
    const add = (p: string, type: string, ...more: [string, Quad['object']][]) => {
      store.add(f.quad(view, nn(LDES.retentionPolicy), nn(EX + p)))
      store.add(f.quad(nn(EX + p), nn(RDF_TYPE), nn(type)))
      for (const [k, v] of more) store.add(f.quad(nn(EX + p), nn(k), v))
    }
    add('a-versions', LDES.LatestVersionSubset, [LDES.amount, int(2)])
    add('b-one', EX + 'OneVersion')
    store.add(f.quad(nn(EX + 'OneVersion'), nn(RDFS_SUBCLASS), nn(LDES.LatestVersionSubset)))
    add('c-since', LDES.PointInTimePolicy, [LDES.pointInTime, f.literal('2026-11-17T00:00:00Z', nn(XSD + 'dateTime'))])
    add('d-ago', LDES.DurationAgoPolicy, [NS.tree + 'value', f.literal('PT10M', nn(XSD + 'duration'))])
    add('e-latest', NS.beh + 'LatestMembersPolicy', [LDES.amount, int(5)])
    const [versions, one, since, ago, latest] = policiesOf(store, s)
    expect(versions).toMatchObject({ versions: 2, versionOf: EX + 'of', amount: undefined })
    expect(one).toMatchObject({ versions: 1, versionOf: EX + 'of', amount: undefined })
    expect(since).toMatchObject({ since: Date.parse('2026-11-17T00:00:00Z'), amount: undefined, withinMs: undefined })
    expect(ago).toMatchObject({ withinMs: 600_000 })
    expect(latest).toMatchObject({ amount: 5, versions: undefined })
    expect(latest!.versionOf).toBeUndefined()
  })

  it('ldes:PointInTimePolicy keeps what was appended from its point in time on', () => {
    const r = new StreamRetention(
      () => [policy({ since: 3500 })],
      () => false,
    )
    const out: string[] = []
    for (let i = 1; i <= 6; i++) for (const e of r.append(member(i), i * 1000)) out.push(e.member.iri)
    expect(out).toEqual(['urn:m1', 'urn:m2', 'urn:m3'])
    expect(r.size).toBe(3)
  })

  it('ldes:LatestVersionSubset keeps the newest versions of each entity, besides what the other policies keep', () => {
    // Members urn:m1..m9 are versions of three entities, in turn: a, b, c, a, b, c, ...
    const entity = (m: string) => 'urn:' + 'abc'[(Number(m.slice(5)) - 1) % 3]
    const r = new StreamRetention(
      () => [policy({ iri: 'urn:latest', amount: 2 }), policy({ iri: 'urn:versions', versions: 1, versionOf: 'urn:of', exit: 'offload' })],
      () => false,
      undefined,
      undefined,
      undefined,
      undefined,
      (m) => entity(m),
    )
    const out: string[] = []
    for (let i = 1; i <= 9; i++) for (const e of r.append(member(i), i)) out.push(`${e.member.iri}:${e.policy?.iri}`)
    // Each leaves once a newer version of its entity came and the two newest of the stream are newer still,
    // by the exit of the version policy, which let it go last.
    expect(out).toEqual(['urn:m1:urn:versions', 'urn:m2:urn:versions', 'urn:m3:urn:versions', 'urn:m4:urn:versions', 'urn:m5:urn:versions'])
    // In memory: the two newest (m8, m9), and set aside the newest version of a (m7) and of c (m6: m9's
    // entity is read at the next append, once its write has put its triples in the graph).
    expect(iris(r.versioned())).toEqual(['urn:m6', 'urn:m7'])
    expect(r.size).toBe(4)
    expect(r.oldest()?.iri).toBe('urn:m6')
    expect(r.append(member(10), 10).map((e) => e.member.iri)).toEqual(['urn:m6'])
  })

  it('ldes:LatestVersionSubset alone keeps one member per entity; without ldes:versionOfPath, every member', () => {
    const entity = (m: string) => 'urn:' + (Number(m.slice(5)) % 2 ? 'odd' : 'even')
    const r = new StreamRetention(
      () => [policy({ versions: 1, versionOf: 'urn:of' })],
      () => false,
      undefined,
      undefined,
      undefined,
      undefined,
      (m) => entity(m),
    )
    const out: string[] = []
    for (let i = 1; i <= 6; i++) for (const e of r.append(member(i), i)) out.push(e.member.iri)
    // m6 is not read yet (its write is still to come), so m4 still counts as the newest even.
    expect(out).toEqual(['urn:m1', 'urn:m2', 'urn:m3'])
    expect(r.size).toBe(3)
    expect(r.append(member(7), 7).map((e) => e.member.iri)).toEqual(['urn:m4'])
    expect(r.size).toBe(3)
    const every = new StreamRetention(
      () => [policy({ versions: 1 })],
      () => false,
    )
    for (let i = 1; i <= 20; i++) expect(every.append(member(i), i)).toEqual([])
    expect(every.size).toBe(20)
  })

  it("a retained stream reads each member's entity once its triples are written, and lets older versions go", () => {
    const store = createStore('wat')
    const f = store.factory
    const nn = (iri: string) => f.namedNode(iri)
    const S = EX + 'prices'
    const g = nn(EX + 'graph')
    store.add(f.quad(nn(S), nn(LDES.view), nn(S + '/~view')))
    store.add(f.quad(nn(S), nn(LDES.versionOfPath), nn(EX + 'of')))
    store.add(f.quad(nn(S + '/~view'), nn(LDES.retentionPolicy), nn(S + '/~versions')))
    store.add(f.quad(nn(S + '/~versions'), nn(RDF_TYPE), nn(LDES.LatestVersionSubset)))
    store.add(f.quad(nn(S + '/~versions'), nn(LDES.amount), f.literal('2', nn(XSD + 'integer'))))
    const apply = (d: { add: Quad[]; remove: Quad[] }) => {
      for (const q of d.remove) store.delete(q)
      for (const q of d.add) store.add(q)
    }
    const retention = new Retention(store, apply, { run: 'test', schedule: (run) => run() })
    const stream = retention.stream(S, {
      graph: g.value,
      closure: (m) => [...store.match(nn(S), nn(LDES.member), m, g), ...store.match(m, null, null, g)],
      write: apply,
    })
    const products = ['apple', 'pear']
    for (let i = 1; i <= 10; i++) {
      const m = nn(`${S}/v${i}`)
      // The append first, then the write that holds it and what leaves with it, as the logs do.
      const leaving = stream.append({ iri: m.value, seq: i, at: i })
      apply({
        add: [f.quad(nn(S), nn(LDES.member), m, g), f.quad(m, nn(EX + 'of'), nn(EX + products[i % 2]!), g), f.quad(m, nn(EX + 'price'), f.literal(String(i)), g)],
        remove: leaving,
      })
    }
    const kept = store
      .match(nn(S), nn(LDES.member), null, g)
      .map((q) => q.object.value.replace(S + '/', ''))
      .sort()
    // The two newest of each product; v10 is not read yet, so apple keeps v6 and v8 besides it.
    expect(kept).toEqual(['v10', 'v6', 'v7', 'v8', 'v9'])
    const x = stream.figures()
    expect(x.inMemory).toBe(5)
    expect(x.inMemory + x.offloaded + x.pending + x.dropped).toBe(10)
    // Nothing is left of what went.
    expect(store.match(nn(`${S}/v1`), null, null, g)).toHaveLength(0)
  })
})
