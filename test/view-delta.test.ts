// A view's changes as a stream (docs/IVM.md §16, phase 4): "since" (everything that changed after a
// tick, consolidated), replicas that hold a view's output in another store from its messages alone
// (joining late, missing a message, the view compiled again), and a delta log whose members carry the
// triples themselves - each checked against the view after every tick of seeded random changes.
import type { Quad, Term } from '@rdfjs/types'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { quadKey, termKey } from '../src/rdf.ts'
import { publish, Replica, type ViewMessage } from '../src/view/replica.ts'
import { mapKey, type ViewHandle } from '../src/view/runtime.ts'
import { ZSet } from '../src/view/zset.ts'
import { runLaws, V } from './view-laws.ts'

const sorted = (qs: Quad[]) => qs.map((q) => `${termKey(q.subject)} ${q.predicate.value} ${termKey(q.object)}`).sort()
const rowSet = (rs: Map<string, Term>[]) => rs.map(mapKey).sort()

/** The view's whole output now: rows and triples. */
const state = (v: ViewHandle) => {
  const s = v.snapshot()
  return { rows: s.rows, quads: s.quads }
}

describe('maintained views: changes since a tick', () => {
  it('a state at tick t plus since(t) is the state now, for every view and many t', () => {
    // Record each view's output at some ticks, then check since() from each of them.
    const checkpoints: { tick: number; views: Map<string, ReturnType<typeof state> & { handle: ViewHandle }> }[] = []
    const { runtime: rt } = runLaws(22, 0)
    for (const v of rt.views.all()) v.keepHistory(1000)
    rt.views.afterTick((tick) => {
      // Views per instance come and go: each keeps its changes from when it exists.
      for (const v of rt.views.all()) v.keepHistory(1000)
      if (tick % 7) return
      checkpoints.push({ tick, views: new Map(rt.views.all().map((v) => [v.iri, { ...state(v), handle: v }])) })
    })
    stepsOn(rt, 22, 150)
    expect(checkpoints.length).toBeGreaterThan(5)
    for (const { tick, views } of checkpoints) {
      for (const v of rt.views.all()) {
        const then = views.get(v.iri)
        if (!then) continue
        const d = v.since(tick)
        // A view compiled again since (an instance that went and came back) does not reach back.
        if (then.handle !== v) {
          expect(d, `${v.iri} since ${tick}`).toBeUndefined()
          continue
        }
        expect(d, `${v.iri} since ${tick}`).toBeDefined()
        if (!d) continue
        const rows = new ZSet<Map<string, Term>>().plus(then.rows).plus(d.rows)
        const quads = new ZSet<Quad>().plus(then.quads).plus(d.quads)
        const now = state(v)
        expect([...rows.entries()].map(([k, , w]) => `${w} ${k}`).sort(), `${v.iri} rows since ${tick}`).toEqual([...now.rows.entries()].map(([k, , w]) => `${w} ${k}`).sort())
        expect([...quads.entries()].map(([k, , w]) => `${w} ${k}`).sort(), `${v.iri} triples since ${tick}`).toEqual([...now.quads.entries()].map(([k, , w]) => `${w} ${k}`).sort())
      }
    }
    // Past what a view keeps, since() says so instead of answering wrongly.
    const v = rt.views.view(V + 'join')!
    const fresh = runLaws(23, 0).runtime.views.view(V + 'join')!
    fresh.keepHistory(1)
    expect(fresh.since(-1)).toBeUndefined()
    expect(v.since(rt.views.tickNo)!.rows.size).toBe(0)
  }, 120_000)
})

describe('maintained views: replicas', () => {
  it('a replica in another store holds what the view holds after every tick, joining late and catching up', () => {
    const { runtime: rt } = runLaws(31, 0)
    const target = loadStore('oxigraph', '')
    const views = ['labelled', 'topRows', 'rows', 'join', 'chain']
    const replicas = new Map(views.map((n) => [V + n, new Replica(V + n, target)]))
    const late = new Replica(V + 'unionParts', target)
    const inbox: ViewMessage[] = []
    const publishers = new Map<string, ReturnType<typeof publish>>()
    for (const n of [...views, 'unionParts']) publishers.set(V + n, publish(rt.views, V + n, (m) => inbox.push(m)))
    let dropped = 0
    // A replica that lost a message is behind until the next one shows the gap.
    const behind = new Set<string>()
    const deliver = () => {
      for (const m of inbox.splice(0)) {
        const rep = replicas.get(m.view)
        // The late replica misses everything until it asks; every 9th message to one replica is lost.
        if (rep && m.view === V + 'chain' && ++dropped % 9 === 0) behind.add(m.view)
        else if (rep) {
          behind.delete(m.view)
          if (!rep.apply(m)) {
            const answer = publishers.get(m.view)!.answer(rep.catchUp())!
            expect(rep.apply(answer)).toBe(true)
          }
        }
      }
    }
    const check = () => {
      for (const [iri, rep] of replicas) {
        if (behind.has(iri)) continue
        const v = rt.views.view(iri)!
        const own = v.snapshot()
        expect(sorted(rep.quads()), iri).toEqual(sorted([...own.quads.entries()].map(([, q]) => q)))
        expect(rowSet(rep.rows()), iri).toEqual(rowSet([...own.rows.entries()].flatMap(([, r, w]) => Array.from({ length: w }, () => r))))
      }
    }
    rt.views.afterTick(() => {
      deliver()
      check()
    })
    stepsOn(rt, 31, 80)
    // The late one joins: it asks, gets the whole result, then follows.
    replicas.set(V + 'unionParts', late)
    expect(late.apply(publishers.get(V + 'unionParts')!.answer(late.catchUp())!)).toBe(true)
    stepsOn(rt, 32, 80)
    // The view is compiled again (its query changed): replicas get a reset, and follow the new one.
    const f = rt.store.factory
    const node = f.namedNode(V + 'labelled')
    const text = rt.store.match(node, f.namedNode('https://semblance.dev/ns/core#construct'), null)[0]!
    rt.apply({ remove: [text], add: [f.quad(node, text.predicate, f.literal(text.object.value.replace('v:labelled ?label', 'v:labelled ?label ; v:via ?t')))] })
    stepsOn(rt, 33, 60)
    expect(rt.views.view(V + 'labelled')!.quads().some((q) => q.predicate.value === V + 'via')).toBe(true)
    expect(replicas.get(V + 'labelled')!.quads().some((q) => q.predicate.value === V + 'via')).toBe(true)
    expect(dropped).toBeGreaterThan(18)
  }, 120_000)

  it('a delta log can carry the triples: integrating its statements from a tick gives the view now', () => {
    const { runtime: rt } = runLaws(41, 0)
    const f = rt.store.factory
    const IV = 'https://semblance.dev/ns/view#'
    const log = f.namedNode(V + 'log')
    const node = f.namedNode(V + 'labelled')
    rt.apply({ remove: [], add: [f.quad(log, f.namedNode(IV + 'recordsChanges'), f.literal('true', f.namedNode('http://www.w3.org/2001/XMLSchema#boolean'))), f.quad(node, f.namedNode(IV + 'deltaLog'), log)] })
    const from = rt.views.tickNo
    const before = new Set(rt.views.view(V + 'labelled')!.quads().map(quadKey))
    stepsOn(rt, 41, 10)
    const rows = rt.store.select(
      `PREFIX iv: <${IV}> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
       SELECT ?n ?change ?s ?p ?o WHERE { ?d iv:view <${V}labelled> ; iv:tick ?n ; ?change ?st . FILTER(?n > ${from} && ?change IN (iv:added, iv:removed))
         ?st rdf:subject ?s ; rdf:predicate ?p ; rdf:object ?o } ORDER BY ?n`,
      [f.namedNode('urn:semblance:views')],
    )
    expect(rows.length).toBeGreaterThan(0)
    // Ticks apply in order; within a tick a triple is either added or removed.
    const held = new Set(before)
    for (const r of rows) {
      const q = f.quad(r.get('s') as never, r.get('p') as never, r.get('o') as never)
      const k = quadKey(q)
      if (r.get('change')!.value === IV + 'added') held.add(k)
      else held.delete(k)
    }
    expect([...held].sort()).toEqual(rt.views.view(V + 'labelled')!.quads().map(quadKey).sort())
  }, 120_000)
})

/** `steps` seeded random changes on an existing law runtime (the generator of view-laws.ts). */
function stepsOn(rt: ReturnType<typeof runLaws>['runtime'], seed: number, steps: number) {
  runLaws(seed, steps, 'oxigraph', rt)
}
