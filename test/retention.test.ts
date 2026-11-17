import { describe, expect, it } from 'vitest'
import type { NamedNode } from '@rdfjs/types'
import { EventBus } from '../src/behaviour/events.ts'
import { BEH, EVENTS_GRAPH, LDES, MOD, NS, RETENTION_GRAPH } from '../src/ns.ts'
import { toHTML, toText } from '../src/render/serialize.ts'
import { type Member, type Policy, StreamRetention } from '../src/retention/policy.ts'
import type { OffloadBackend } from '../src/retention/offload.ts'
import { setup } from './helpers.ts'
import { todoReactions } from '../src/examples/todo.ts'

const EX = 'https://example.org/retention#'
const DENSITY = 'https://example.org/todo#density'
const RET = NS.ret

// An undoable counter, an undoer, and a list of horizons.
const FIXTURE = `
@prefix c: <https://semblance.dev/ns/component#> .
@prefix beh: <https://semblance.dev/ns/behaviour#> .
@prefix ex: <${EX}> .
ex:inc a c:Button ; c:label "Inc" .
ex:undo a c:Button , beh:Undoer ; c:label "Undo" .
ex:counter ex:n 0 .
ex:Inc a beh:Reaction ; beh:when beh:Click ; beh:source ex:inc ; beh:undoable true ;
  beh:deletes "CONSTRUCT { <${EX}counter> <${EX}n> ?n } WHERE { <${EX}counter> <${EX}n> ?n }" ;
  beh:inserts "CONSTRUCT { <${EX}counter> <${EX}n> ?m } WHERE { <${EX}counter> <${EX}n> ?n BIND(?n + 1 AS ?m) }" .
ex:horizons a c:HorizonList .
`

/** Storage in memory, with keys (for sweeping) and a switch that refuses writes, as a full quota does. */
function storage() {
  const m = new Map<string, string>()
  const b = {
    full: false,
    map: m,
    get: async (k: string) => m.get(k),
    set: async (k: string, v: string) => {
      if (b.full) throw new Error('QuotaExceededError: the quota has been exceeded')
      m.set(k, v)
    },
    remove: async (k: string) => void m.delete(k),
    keys: async (prefix: string) => [...m.keys()].filter((k) => k.startsWith(prefix)),
  }
  return b satisfies OffloadBackend
}

function mounted(prefer: 'sparql' | 'function' = 'sparql', general = 5, undo = 10) {
  const h = setup('wat', { prefer }, 5, [FIXTURE])
  const { store, runtime } = h
  const f = store.factory
  const set = (s: string, p: string, o: string) => {
    for (const q of store.match(f.namedNode(s), f.namedNode(p), null)) store.delete(q)
    store.add(f.quad(f.namedNode(s), f.namedNode(p), f.literal(o, f.namedNode(NS.xsd + 'integer'))))
  }
  set(BEH.ChangeLog.replace('ChangeLog', 'ChangeLogRetention'), LDES.amount, String(general))
  set(NS.beh + 'UndoRetention', LDES.amount, String(undo))
  const backend = storage()
  Object.assign(runtime.retention.opts, { chunk: 4, schedule: (run: () => void) => run() })
  void runtime.retention.use(backend)
  const bus = new EventBus(runtime, h.screen, { prefer, functions: todoReactions })
  const horizon = () => runtime.retention.get(BEH.ChangeLog)!.figures()
  const counter = () => Number(store.match(f.namedNode(EX + 'counter'), f.namedNode(EX + 'n'), null)[0]?.object.value)
  const members = () => store.match(f.namedNode(BEH.ChangeLog), f.namedNode(LDES.member), null, f.namedNode(EVENTS_GRAPH)).length
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0))
      await runtime.retention.flush()
    }
  }
  return { ...h, bus, backend, horizon, counter, members, settle, f }
}

describe('retention policies (StreamRetention)', () => {
  const policy = (p: Partial<Policy>): Policy => ({ iri: 'urn:p', having: [], exit: 'drop', announce: false, ...p })
  const member = (seq: number, undoable = false): Member => ({ iri: (undoable ? 'urn:u' : 'urn:m') + seq, seq, at: seq * 1000 })

  it('keeps the latest ldes:amount, and offers what it lets go to a ret:having policy', () => {
    const policies = [policy({ iri: 'urn:a', amount: 3 }), policy({ iri: 'urn:b', amount: 2, having: ['urn:asserted'], exit: 'offload' })]
    const r = new StreamRetention(
      () => policies,
      (m) => m.startsWith('urn:u'),
    )
    const out: string[] = []
    for (let i = 1; i <= 10; i++) for (const e of r.append(member(i, i % 2 === 0), i * 1000)) out.push(`${e.member.iri}:${e.policy?.iri}`)
    // The three newest stay; of the undoable ones older than those, the two newest stay too.
    expect(r.size).toBe(5)
    expect(r.queue('urn:b').map((m) => m.iri)).toEqual(['urn:u4', 'urn:u6'])
    expect(out).toEqual(['urn:m1:urn:a', 'urn:m3:urn:a', 'urn:m5:urn:a', 'urn:u2:urn:b', 'urn:m7:urn:a'])
  })

  it('keeps by age, and keeps everything without a policy', () => {
    const r = new StreamRetention(
      () => [policy({ withinMs: 2500 })],
      () => false,
    )
    for (let i = 1; i <= 5; i++) r.append(member(i), i * 1000)
    expect(r.size).toBe(3)
    const none = new StreamRetention(
      () => [],
      () => false,
    )
    for (let i = 1; i <= 50; i++) none.append(member(i), i)
    expect(none.size).toBe(50)
  })

  it('holds what was recalled besides what the policies keep, up to a limit; undone members leave first, else the oldest', () => {
    let undone: string[] = []
    const r = new StreamRetention(
      () => [policy({ amount: 2 })],
      () => false,
      () => 3,
      () => undone,
    )
    for (let i = 10; i <= 12; i++) r.append(member(i), i)
    expect(r.recall([member(5), member(6), member(7), member(8)]).map((e) => e.member.iri)).toEqual(['urn:m5'])
    expect(r.recalled().map((m) => m.iri)).toEqual(['urn:m6', 'urn:m7', 'urn:m8'])
    expect(r.size).toBe(5)
    undone = ['urn:m7', 'urn:m8']
    expect(r.recall([member(4)]).map((e) => e.member.iri)).toEqual(['urn:m8'])
    expect(r.recalled().map((m) => m.iri)).toEqual(['urn:m4', 'urn:m6', 'urn:m7'])
  })

  it('keeps what a ret:having policy holds contiguous with what was recalled', () => {
    const policies = [policy({ iri: 'urn:a', amount: 1 }), policy({ iri: 'urn:b', amount: 3, having: ['x'] })]
    const r = new StreamRetention(
      () => policies,
      () => true,
    )
    for (let i = 10; i <= 14; i++) r.append(member(i), i)
    // urn:b holds 11-13 (14 in the window); 1-3 come back; the next release must push out 1, not 11.
    r.recall([member(1), member(2), member(3)], policies[1])
    const out = r.append(member(15), 15)
    expect(out.map((e) => e.member.iri)).toEqual(['urn:m1'])
  })
})

describe('the change log, bounded and offloaded', () => {
  it('offloads what it lets go to storage, says where everything is, and loses nothing', async () => {
    const h = mounted()
    for (let i = 0; i < 12; i++) h.bus.emit(NS.beh + 'Click', EX + 'inc')
    for (let i = 0; i < 12; i++) h.bus.emit(NS.beh + 'Click', NS.c + 'nothing') // not recorded: no reaction
    for (let i = 0; i < 9; i++) h.bus.emit(NS.beh + 'Click', DENSITY)
    await h.settle()
    const x = h.horizon()
    // 5 newest kept; of the older ones, the undoable are kept up to 10 more; the rest offloaded.
    expect(x.inMemory).toBe(h.members())
    expect(x.inMemory).toBe(5 + 10)
    // Conservation: every member appended is somewhere (one more: the announcement of the first offload).
    const appended = 12 + 9 + 1
    expect(x.inMemory + x.offloaded + x.pending + x.dropped).toBe(appended)
    expect(x.dropped).toBe(0)
    expect(h.backend.map.size).toBeGreaterThan(0)
    // The horizon is in the graph, for views to read.
    const hz = h.f.namedNode(BEH.ChangeLog + '/~horizon')
    const g = h.f.namedNode(RETENTION_GRAPH)
    expect(h.store.match(hz, h.f.namedNode(RET + 'offloaded'), null, g)[0]?.object.value).toBe(String(x.offloaded))
    expect(h.store.match(hz, h.f.namedNode(RET + 'inMemory'), null, g)[0]?.object.value).toBe(String(x.inMemory))
  })

  it('announces the first offload, once', async () => {
    const h = mounted()
    for (let i = 0; i < 30; i++) h.bus.emit(NS.beh + 'Click', DENSITY)
    await h.settle()
    const g = h.f.namedNode(EVENTS_GRAPH)
    const announced = h.store.match(null, h.f.namedNode(BEH.handledBy), h.f.namedNode(RET + 'AnnounceOffloaded'), g)
    const crossed = h.store.match(h.f.namedNode(BEH.ChangeLog), h.f.namedNode(RET + 'crossed'), null)
    expect(crossed.map((q) => q.object.value)).toEqual([RET + 'Offloaded'])
    expect(announced.length).toBeLessThanOrEqual(1)
  })

  for (const prefer of ['sparql', 'function'] as const) {
    it(`undoes past the horizon: what was offloaded comes back before the undo needs it (${prefer})`, async () => {
      const h = mounted(prefer, 3, 6)
      for (let i = 0; i < 40; i++) h.bus.emit(NS.beh + 'Click', EX + 'inc')
      await h.settle()
      expect(h.counter()).toBe(40)
      expect(h.horizon().offloaded).toBeGreaterThan(20)
      for (let i = 0; i < 40; i++) {
        h.bus.emit(NS.beh + 'Click', EX + 'undo')
        await h.settle()
      }
      expect(h.counter()).toBe(0)
      // Memory stayed bounded: the policies' members, plus what was recalled (at most the limit).
      expect(h.horizon().inMemory).toBeLessThanOrEqual(3 + 6 + 1000)
    })
  }

  it('keeps what storage refused, in memory, and writes it once storage takes it again', async () => {
    const h = mounted()
    h.backend.full = true
    for (let i = 0; i < 20; i++) h.bus.emit(NS.beh + 'Click', DENSITY)
    await h.settle()
    const x = h.horizon()
    expect(x.dropped).toBe(0)
    expect(x.pending).toBeGreaterThan(0)
    expect(x.refused).toMatch(/quota/i)
    h.backend.full = false
    h.bus.emit(NS.beh + 'Click', DENSITY)
    await h.settle()
    const y = h.horizon()
    expect(y.pending).toBe(0)
    expect(y.refused).toBeUndefined()
    expect(y.inMemory + y.offloaded + y.dropped).toBe(21 + 1)
  })

  it('recalls on request (ret:recall), into the live graph, and removes the request', async () => {
    const h = mounted()
    for (let i = 0; i < 30; i++) h.bus.emit(NS.beh + 'Click', DENSITY)
    await h.settle()
    const before = h.horizon()
    const stream = h.f.namedNode(BEH.ChangeLog)
    h.runtime.apply({ add: [h.f.quad(stream, h.f.namedNode(RET + 'recall'), h.f.literal('8', h.f.namedNode(NS.xsd + 'integer')))], remove: [] })
    await h.settle()
    const after = h.horizon()
    expect(after.recalled).toBeGreaterThanOrEqual(8)
    expect(after.inMemory).toBe(before.inMemory + after.recalled)
    expect(after.offloaded).toBe(before.offloaded - after.recalled)
    expect(h.members()).toBe(after.inMemory)
    expect(h.store.match(stream, h.f.namedNode(RET + 'recall'), null)).toHaveLength(0)
  })

  it('drops past ret:storageAmount, and counts it', async () => {
    const h = mounted()
    const f = h.f
    const policy = f.namedNode(NS.beh + 'ChangeLogRetention')
    for (const q of h.store.match(policy, f.namedNode(RET + 'storageAmount'), null)) h.store.delete(q)
    h.store.add(f.quad(policy, f.namedNode(RET + 'storageAmount'), f.literal('8', f.namedNode(NS.xsd + 'integer'))))
    for (let i = 0; i < 40; i++) h.bus.emit(NS.beh + 'Click', DENSITY)
    await h.settle()
    const x = h.horizon()
    expect(x.offloaded).toBeLessThanOrEqual(8)
    expect(x.dropped).toBeGreaterThan(0)
    expect(x.inMemory + x.offloaded + x.pending + x.dropped).toBe(40 + 2)
  })

  it('sweeps what earlier pages offloaded', async () => {
    const h = mounted()
    h.backend.map.set('semblance:ret:earlier|' + BEH.ChangeLog + '|x|000000000001', '{}')
    h.backend.map.set('semblance:other', 'kept')
    h.runtime.retention.use(h.backend)
    await h.settle()
    expect([...h.backend.map.keys()]).toEqual(['semblance:other'])
  })
})

describe('c:HorizonList', () => {
  it('renders the same with SPARQL and function rules, in every language', async () => {
    const sites = (['sparql', 'function'] as const).map((prefer) => {
      const h = mounted(prefer)
      return { ...h, text: h.runtime.project({ modality: MOD.Text, prefer, name: 'text' }) }
    })
    const same = (what: string) => {
      const [a, b] = sites.map((h) => toHTML(h.screen.index, EX + 'horizons'))
      expect(a, what).toBe(b)
      const [ta, tb] = sites.map((h) => toText(h.text.index, EX + 'horizons'))
      expect(ta, what).toBe(tb)
      return a!
    }
    same('empty')
    for (const h of sites) for (let i = 0; i < 30; i++) h.bus.emit(NS.beh + 'Click', DENSITY)
    for (const h of sites) await h.settle()
    const html = same('offloaded')
    expect(html).toContain('in this browser')
    expect(html).toMatch(/<button[^>]*class="sem-older"/)
    for (const languages of [['uk'], ['de'], ['ar'], ['en']]) {
      for (const h of sites) for (const p of [h.screen, h.text]) p.engine.reconfigure({ languages })
      same(languages.join())
    }
  })

  it('Show older recalls the stream it names', async () => {
    const h = mounted('sparql')
    for (let i = 0; i < 30; i++) h.bus.emit(NS.beh + 'Click', DENSITY)
    await h.settle()
    const older = h.store.match(null, h.f.namedNode(RET + 'recalls'), h.f.namedNode(BEH.ChangeLog))[0]?.subject as NamedNode
    expect(older).toBeDefined()
    h.bus.emit(NS.beh + 'Click', EX + 'horizons', { node: older.value })
    await h.settle()
    expect(h.horizon().recalled).toBeGreaterThan(0)
  })
})
