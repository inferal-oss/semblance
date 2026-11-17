import { describe, expect, it } from 'vitest'
import type { NamedNode } from '@rdfjs/types'
import { EventBus } from '../src/behaviour/events.ts'
import { BEH, EVENTS_GRAPH, LDES, NS, SEM } from '../src/ns.ts'
import { logStream, type OffloadBackend } from '../src/retention/offload.ts'
import { SCREEN_LAYERS, setup } from './helpers.ts'
import { dangling, watchRetired } from './retired.ts'
import { todoReactions } from '../src/examples/todo.ts'

const EX = 'https://example.org/references#'
const DENSITY = 'https://example.org/todo#density'
const RET = NS.ret
const TREE_MEMBER = NS.tree + 'member'

// An undoable counter, a button whose click raises a click on it, and an undoer.
const FIXTURE = `
@prefix c: <https://semblance.dev/ns/component#> .
@prefix beh: <https://semblance.dev/ns/behaviour#> .
@prefix ex: <${EX}> .
ex:inc a c:Button ; c:label "Inc" .
ex:twice a c:Button ; c:label "Twice" .
ex:undo a c:Button , beh:Undoer ; c:label "Undo" .
ex:counter ex:n 0 .
ex:Inc a beh:Reaction ; beh:when beh:Click ; beh:source ex:inc ; beh:undoable true ;
  beh:deletes "CONSTRUCT { <${EX}counter> <${EX}n> ?n } WHERE { <${EX}counter> <${EX}n> ?n }" ;
  beh:inserts "CONSTRUCT { <${EX}counter> <${EX}n> ?m } WHERE { <${EX}counter> <${EX}n> ?n BIND(?n + 1 AS ?m) }" .
ex:Twice a beh:Reaction ; beh:when beh:Click ; beh:source ex:twice ;
  beh:inserts "CONSTRUCT { <${EX}inc> beh:raise beh:Click } WHERE { }" .
`

function storage() {
  const m = new Map<string, string>()
  return {
    get: async (k: string) => m.get(k),
    set: async (k: string, v: string) => void m.set(k, v),
    remove: async (k: string) => void m.delete(k),
    keys: async (prefix: string) => [...m.keys()].filter((k) => k.startsWith(prefix)),
  } satisfies OffloadBackend
}

function mounted(prefer: 'sparql' | 'function', general: number, undo: number) {
  const h = setup('wat', { prefer, layers: [...SCREEN_LAYERS, SEM.TooltipLayer] }, 5, [FIXTURE])
  const { store, runtime } = h
  const f = store.factory
  const set = (s: string, p: string, o: string) => {
    for (const q of store.match(f.namedNode(s), f.namedNode(p), null)) store.delete(q)
    store.add(f.quad(f.namedNode(s), f.namedNode(p), f.literal(o, f.namedNode(NS.xsd + 'integer'))))
  }
  set(NS.beh + 'ChangeLogRetention', LDES.amount, String(general))
  set(NS.beh + 'UndoRetention', LDES.amount, String(undo))
  Object.assign(runtime.retention.opts, { chunk: 4, schedule: (run: () => void) => run() })
  void runtime.retention.use(storage())
  const retired = watchRetired(runtime)
  const bus = new EventBus(runtime, h.screen, { prefer, functions: todoReactions })
  const log = f.namedNode(BEH.ChangeLog)
  const g = f.namedNode(EVENTS_GRAPH)
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0))
      await runtime.retention.flush()
    }
  }
  /** How many members a walk from the log's head reaches by beh:previous. */
  const walk = () => {
    let n = 0
    for (let m = store.match(log, f.namedNode(BEH.latest), null, g)[0]?.object; m && store.match(log, f.namedNode(TREE_MEMBER), m, g).length; n++)
      m = store.match(m as NamedNode, f.namedNode(NS.beh + 'previous'), null, g)[0]?.object
    return n
  }
  const counter = () => Number(store.match(f.namedNode(EX + 'counter'), f.namedNode(EX + 'n'), null)[0]?.object.value)
  return { ...h, f, bus, retired, settle, walk, counter, dangling: () => dangling(store, retired), stream: () => runtime.retention.get(BEH.ChangeLog)! }
}

describe('retirement takes the references to a member with it (ret:Reference)', () => {
  for (const prefer of ['sparql', 'function'] as const) {
    it(`leaves nothing pointing at what the change log let go, through raises, undos and recalls (${prefer})`, async () => {
      const h = mounted(prefer, 4, 6)
      for (let round = 0; round < 6; round++) {
        for (let i = 0; i < 5; i++) h.bus.emit(NS.beh + 'Click', EX + 'inc')
        h.bus.emit(NS.beh + 'Click', EX + 'twice')
        // The raised click names its raiser (beh:raisedBy).
        expect(h.store.match(null, h.f.namedNode(NS.beh + 'raisedBy'), null).length).toBeGreaterThan(0)
        for (let i = 0; i < 3; i++) h.bus.emit(NS.beh + 'Click', DENSITY)
        // Undone members (beh:undone, in the input graph) leave first.
        for (let i = 0; i < 2; i++) h.bus.emit(NS.beh + 'Click', EX + 'undo')
        await h.settle()
        expect(h.dangling()).toEqual([])
      }
      expect(h.retired.size).toBeGreaterThan(30)
      // Undo still reaches past the horizon: what was offloaded comes back for it.
      const before = h.counter()
      for (let i = 0; i < before; i++) {
        h.bus.emit(NS.beh + 'Click', EX + 'undo')
        await h.settle()
      }
      expect(h.counter()).toBe(0)
      expect(h.dangling()).toEqual([])
    })
  }

  it('stores the log’s own references with what it offloads, and a recall brings the walk from the head back', async () => {
    const h = mounted('sparql', 5, 6)
    for (let i = 0; i < 30; i++) h.bus.emit(NS.beh + 'Click', DENSITY)
    await h.settle()
    expect(h.dangling()).toEqual([])
    // The oldest kept no longer names its predecessor, which is in storage.
    expect(h.walk()).toBe(5)
    await h.stream().recall(8)
    await h.settle()
    const recalled = h.stream().figures().recalled
    expect(recalled).toBeGreaterThanOrEqual(8)
    // Back in memory, they are reached again from the head: the oldest kept names its predecessor once more.
    expect(h.walk()).toBe(5 + recalled)
    expect(h.dangling()).toEqual([])
    // Let go again (memory pressure), the link goes with them, and comes back with them.
    h.stream().relieve(0)
    await h.settle()
    expect(h.walk()).toBe(5)
    expect(h.dangling()).toEqual([])
    await h.stream().recall(4)
    await h.settle()
    expect(h.walk()).toBe(5 + h.stream().figures().recalled)
  })

  it('follows the properties the graph marks, in every graph, and only those', () => {
    const h = setup('wat', {}, 1, [
      `@prefix ex: <${EX}> . @prefix ret: <https://semblance.dev/ns/retention#> .
       @prefix ldes: <https://w3id.org/ldes#> . @prefix tree: <https://w3id.org/tree#> .
       ex:cause a ret:Reference .
       ex:A a ldes:EventStream ; tree:view ex:AView . ex:AView ldes:retentionPolicy [ a ret:Latest ; ldes:amount 3 ] .`,
    ])
    const { store, runtime } = h
    const f = store.factory
    const nn = (x: string) => f.namedNode(x)
    const retired = watchRetired(runtime)
    const a = logStream(runtime.retention, EX + 'A', 'urn:example:a', (d) => runtime.write('urn:example:a', d))
    for (let i = 1; i <= 10; i++) {
      const m = nn(`${EX}a${i}`)
      const leaving = a.append({ iri: m.value, seq: i, at: i })
      runtime.write('urn:example:a', { add: [f.quad(nn(EX + 'A'), nn(TREE_MEMBER), m), f.quad(m, nn(EX + 'n'), f.literal(String(i)))], remove: leaving })
      // Pointing at it: from another graph (the app's own mark and PROV's), from the input graph, and unmarked.
      runtime.write('urn:example:b', { add: [f.quad(nn(`${EX}b${i}`), nn(EX + 'cause'), m), f.quad(nn(`${EX}b${i}`), nn(NS.prov + 'wasInformedBy'), m)], remove: [] })
      runtime.apply({ add: [f.quad(nn(EX + 'pin'), nn(EX + 'cause'), m), f.quad(nn(EX + 'plain'), nn(EX + 'mentions'), m)], remove: [] })
    }
    expect(retired.size).toBe(7)
    const pointing = (p: string, g?: string) =>
      store
        .match(null, nn(p), null, g === undefined ? f.defaultGraph() : nn(g))
        .map((q) => q.object.value.replace(EX, ''))
        .sort()
    expect(pointing(EX + 'cause', 'urn:example:b')).toEqual(['a10', 'a8', 'a9'])
    expect(pointing(NS.prov + 'wasInformedBy', 'urn:example:b')).toEqual(['a10', 'a8', 'a9'])
    expect(pointing(EX + 'cause')).toEqual(['a10', 'a8', 'a9'])
    // A property the graph does not mark is left alone: its statements are not retention's to remove.
    expect(pointing(EX + 'mentions')).toHaveLength(10)
  })
})
