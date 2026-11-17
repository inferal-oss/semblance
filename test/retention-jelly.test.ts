// Offloaded history as Jelly (src/retention/chunk.ts, docs/RETENTION.md §6.2): every term comes back
// as it left, on every store; storage of strings only gets base64; chunks of the earlier N-Triples
// layout still read; and a change-log chunk takes less room than it did as N-Triples.
import { describe, expect, it } from 'vitest'
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import { DataFactory, Writer } from 'n3'
import { EventBus } from '../src/behaviour/events.ts'
import { todoReactions } from '../src/examples/todo.ts'
import { createStore, type StoreKind } from '../src/node/stores.ts'
import { BEH, LDES, NS } from '../src/ns.ts'
import { type Backend, memoryBackend } from '../src/persistence.ts'
import { decodeChunk, loadChunk } from '../src/retention/chunk.ts'
import { Retention } from '../src/retention/offload.ts'
import type { Member } from '../src/retention/policy.ts'
import { setup } from './helpers.ts'

const RET = NS.ret
const XSD = NS.xsd
const S = 'https://example.org/jelly#log'
const G = 'https://example.org/jelly#graph'

/** A canonical key of a term, every part of it (a blank node by its label). */
function key(t: Term): string {
  if (t.termType === 'Literal') return `L:${t.value}@${t.language}^${t.datatype.value}~${(t as { direction?: string }).direction ?? ''}`
  if (t.termType === 'Quad') return `Q:(${key(t.subject)} ${key(t.predicate)} ${key(t.object)})`
  return `${t.termType}:${t.value}`
}
const quadKey = (q: Quad) => `${key(q.subject)} ${key(q.predicate)} ${key(q.object)} ${key(q.graph)}`

/** A log whose members record terms of every kind, retained by one policy that keeps 2 and offloads the rest. */
function log(kind: StoreKind, backend: Backend) {
  const store = createStore(kind)
  const f = store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const g = nn(G)
  const policy = nn(S + '/~policy')
  store.add(f.quad(nn(S), nn(LDES.view), nn(S + '/~view')))
  store.add(f.quad(nn(S + '/~view'), nn(LDES.retentionPolicy), policy))
  store.add(f.quad(policy, nn(LDES.amount), f.literal('2', nn(XSD + 'integer'))))
  store.add(f.quad(policy, nn(RET + 'onExpiry'), nn(RET + 'Offload')))
  const apply = (d: { add: Quad[]; remove: Quad[] }) => {
    for (const q of d.remove) store.delete(q)
    for (const q of d.add) store.add(q)
  }
  const retention = new Retention(store, apply, { backend, run: 'test', chunk: 64, schedule: (run) => run() })
  const closure = (m: NamedNode) => store.match(null, null, null, g).filter((q) => q.subject.value === m.value || q.subject.value.startsWith(m.value + '/~') || (q.subject.value === S && q.object.equals(m)))
  const stream = retention.stream(S, { graph: G, closure, write: apply })
  const member = (i: number): Quad[] => {
    const m = nn(`${S}/e${i}`)
    const st = nn(`${S}/e${i}/~asserted0`)
    const lit = (v: string, t: string) => f.literal(v, nn(t))
    return [
      f.quad(nn(S), nn(LDES.member), m, g),
      f.quad(m, nn(BEH.sequence), lit(String(i), XSD + 'integer'), g),
      f.quad(m, nn(BEH.at), lit(`2026-11-16T10:00:0${i}.000Z`, XSD + 'dateTime'), g),
      f.quad(m, nn(NS.rdfs + 'label'), f.literal('Changed', 'en'), g),
      f.quad(m, nn(NS.rdfs + 'label'), f.literal('Змінено', 'uk'), g),
      f.quad(m, nn(NS.rdfs + 'label'), f.literal('تغيّر', 'ar'), g),
      f.quad(m, nn(NS.rdfs + 'comment'), f.literal(`a "quoted"\nline\twith \\ and 🙂 ${i}`), g),
      f.quad(m, nn(NS.rdfs + 'comment'), f.literal(''), g),
      f.quad(m, nn(BEH.asserted), st, g),
      f.quad(st, nn(NS.rdf + 'type'), nn(NS.rdf + 'Statement'), g),
      f.quad(st, nn(NS.rdf + 'subject'), DataFactory.blankNode(`node${i}`), g),
      f.quad(st, nn(NS.rdf + 'predicate'), nn('https://example.org/jelly#p'), g),
      f.quad(st, nn(NS.rdf + 'object'), lit('3.50', XSD + 'decimal'), g),
      f.quad(st, nn('https://example.org/jelly#also'), lit('x', 'https://example.org/jelly#Custom'), g),
      f.quad(st, nn('https://example.org/jelly#also'), lit('true', XSD + 'boolean'), g),
      f.quad(st, nn('https://example.org/jelly#shared'), DataFactory.blankNode('shared'), g),
    ]
  }
  const left: Quad[] = []
  for (let i = 1; i <= 10; i++) {
    for (const q of member(i)) store.add(q)
    const leaving = stream.append({ iri: `${S}/e${i}`, seq: i, at: 1000 * i })
    left.push(...leaving)
    apply({ add: [], remove: leaving })
  }
  return { store, stream, left, g }
}

describe('offloaded history as Jelly', () => {
  for (const kind of ['n3', 'wat', 'oxigraph'] as const) {
    it(`brings every term back as it left: literals with language and datatype, blank nodes by label (${kind})`, async () => {
      const backend = memoryBackend()
      const { store, stream, left, g } = log(kind, backend)
      await stream.flush()
      expect(stream.figures()).toMatchObject({ inMemory: 2, offloaded: 8, pending: 0, dropped: 0 })
      expect(left.length).toBe(8 * 16)
      expect(left.some((q) => q.object.termType === 'BlankNode')).toBe(true)
      // Stored as bytes, where the storage holds bytes.
      const [k] = await backend.keys!('semblance:ret:')
      expect(await backend.getBytes!(k!)).toBeInstanceOf(Uint8Array)
      expect(await backend.get(k!)).toBeUndefined()
      const present = () => new Set(store.match(null, null, null, g).map(quadKey))
      for (const q of left) expect(present().has(quadKey(q))).toBe(false)
      expect(await stream.recall(8)).toBe(8)
      const back = present()
      for (const q of left) expect(back.has(quadKey(q)), quadKey(q)).toBe(true)
      // Nothing came back that had not left: the graph is what it was before the offload.
      expect(back.size).toBe(10 * 16)
      expect(stream.figures()).toMatchObject({ inMemory: 10, offloaded: 0, pending: 0, dropped: 0, recalled: 8 })
    })
  }

  it('writes base64 text to a storage of strings only, and reads it back', async () => {
    const m = new Map<string, string>()
    const backend: Backend = { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v), remove: async (k) => void m.delete(k), keys: async (p) => [...m.keys()].filter((k) => k.startsWith(p)) }
    const { store, stream, left, g } = log('n3', backend)
    await stream.flush()
    const [value] = [...m.values()]
    expect(value).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(await stream.recall(8)).toBe(8)
    const back = new Set(store.match(null, null, null, g).map(quadKey))
    for (const q of left) expect(back.has(quadKey(q))).toBe(true)
  })

  it('reads a chunk of the earlier layout (JSON with N-Triples), labels and literals as they were', async () => {
    const store = createStore('n3')
    const f = store.factory
    const g = f.namedNode(G)
    const quads = [
      f.quad(f.namedNode(S + '/e1'), f.namedNode(NS.rdfs + 'label'), f.literal('Змінено', 'uk')),
      f.quad(f.namedNode(S + '/e1'), f.namedNode(BEH.sequence), f.literal('1', f.namedNode(XSD + 'integer'))),
      f.quad(f.namedNode(S + '/e1/~asserted0'), f.namedNode(NS.rdf + 'subject'), DataFactory.blankNode('kept')),
    ]
    const w = new Writer({ format: 'N-Triples' })
    for (const q of quads) w.addQuad(q.subject as never, q.predicate as never, q.object as never)
    let nt = ''
    w.end((_e, r) => (nt = r ?? ''))
    const members: Member[] = [{ iri: S + '/e1', seq: 1, at: 1000 }]
    const backend = memoryBackend()
    await backend.set('legacy', JSON.stringify({ members, nt }))
    const raw = await loadChunk(backend, 'legacy')
    expect(typeof raw).toBe('string')
    const read = decodeChunk(raw!, g, f)
    expect(read.members).toEqual(members)
    expect(read.quads.map(quadKey)).toEqual(quads.map((q) => quadKey(f.quad(q.subject, q.predicate, q.object, g))))
  })

  it('stores a change-log chunk in less room than N-Triples', async () => {
    const EX = 'https://example.org/retention#'
    const h = setup('wat', {}, 5, [
      `@prefix c: <https://semblance.dev/ns/component#> .
@prefix beh: <https://semblance.dev/ns/behaviour#> .
@prefix ex: <${EX}> .
ex:inc a c:Button ; c:label "Inc" .
ex:counter ex:n 0 .
ex:Inc a beh:Reaction ; beh:when beh:Click ; beh:source ex:inc ; beh:undoable true ;
  beh:deletes "CONSTRUCT { <${EX}counter> <${EX}n> ?n } WHERE { <${EX}counter> <${EX}n> ?n }" ;
  beh:inserts "CONSTRUCT { <${EX}counter> <${EX}n> ?m } WHERE { <${EX}counter> <${EX}n> ?n BIND(?n + 1 AS ?m) }" .`,
    ])
    const { store, runtime } = h
    const f = store.factory
    const set = (s: string, p: string, o: string) => {
      for (const q of store.match(f.namedNode(s), f.namedNode(p), null)) store.delete(q)
      store.add(f.quad(f.namedNode(s), f.namedNode(p), f.literal(o, f.namedNode(XSD + 'integer'))))
    }
    set(NS.beh + 'ChangeLogRetention', LDES.amount, '5')
    set(NS.beh + 'UndoRetention', LDES.amount, '5')
    const backend = memoryBackend()
    Object.assign(runtime.retention.opts, { chunk: 64, schedule: (run: () => void) => run() })
    await runtime.retention.use(backend)
    const bus = new EventBus(runtime, h.screen, { functions: todoReactions })
    // Undoable changes (with their recorded statements) and plain events, as a session has them.
    for (let i = 0; i < 160; i++) bus.emit(NS.beh + 'Click', i % 3 === 2 ? 'https://example.org/todo#density' : EX + 'inc')
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0))
      await runtime.retention.flush()
    }
    const x = runtime.retention.get(BEH.ChangeLog)!.figures()
    expect(x.offloaded).toBeGreaterThanOrEqual(64)
    const sizes: { members: number; triples: number; jelly: number; base64: number; ntriples: number }[] = []
    for (const k of await backend.keys!('semblance:ret:')) {
      const bytes = (await backend.getBytes!(k))!
      const read = decodeChunk(bytes, f.namedNode(G), f)
      if (read.members.length !== 64) continue
      // The same chunk as it was stored before: JSON, its members and their closures as N-Triples.
      const w = new Writer({ format: 'N-Triples' })
      for (const q of read.quads) w.addQuad(q.subject as never, q.predicate as never, q.object as never)
      let nt = ''
      w.end((_e, r) => (nt = r ?? ''))
      const legacy = new TextEncoder().encode(JSON.stringify({ members: read.members, nt })).length
      sizes.push({ members: read.members.length, triples: read.quads.length, jelly: bytes.length, base64: Math.ceil(bytes.length / 3) * 4, ntriples: legacy })
    }
    expect(sizes.length).toBeGreaterThan(0)
    console.log('change-log chunks, bytes:', JSON.stringify(sizes))
    for (const s of sizes) {
      expect(s.jelly).toBeLessThan(s.ntriples / 2)
      expect(s.base64).toBeLessThan(s.ntriples)
    }
  })
})
