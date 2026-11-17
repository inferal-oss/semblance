// Remembered state by its retention (per:retention, a ret:Within; docs/RETENTION.md §8.9): measured from
// each stored triple's age, not the policy's last write; what is older leaves by the policy's exit (set
// aside in storage by default, dropped only where the policy says so), counted on the policy's horizon,
// recorded in the state log, announced once when the policy is person-facing, and recalled by Show older.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS, PERSIST_GRAPH, RETENTION_GRAPH } from '../src/ns.ts'
import { type Backend, memoryBackend, Persistence } from '../src/persistence.ts'
import { Runtime } from '../src/runtime.ts'

const X = 'https://example.org/aged#'
const PER = NS.per
const RET = NS.ret
const HOUR = 3_600_000
const T0 = Date.UTC(2026, 0, 1)

const prefixes = `
@prefix x: <${X}> .
@prefix per: <${PER}> .
@prefix ret: <${RET}> .
@prefix tree: <https://w3id.org/tree#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
x:prefixes sh:declare [ sh:prefix "x" ; sh:namespace "${X}"^^xsd:anyURI ] .
`
/** Settings: two properties of one node, a day's retention as a duration alone (ret:Drop). */
const settings = `${prefixes}
x:remember a per:Policy ; per:scope per:Session ; per:subject x:prefs ; per:properties ( x:a x:b ) ; per:retention "P1D" .`
/** Notes, one triple each, kept a day by a person-facing ret:Within with no exit (ret:Offload). */
const notes = (extra = '') => `${prefixes}
x:remember a per:Policy ; per:scope per:Session ; per:retention x:day ;
    per:construct """CONSTRUCT { ?n x:text ?t } WHERE { ?n x:text ?t }""" .
x:day a ret:Within ; tree:value "P1D" ; ret:announce true${extra} .`

const at = (t: number) => vi.spyOn(Date, 'now').mockReturnValue(t)
afterEach(() => vi.restoreAllMocks())

/** A page over `storage`: remembered state restored before the first projection, as the host does. */
async function page(turtle: string, storage: Record<string, Backend>, prefer: 'sparql' | 'function' = 'sparql') {
  const store = loadStore('oxigraph', turtle)
  const persistence = new Persistence(store, storage, { delayMs: 60_000 })
  await persistence.restore()
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, prefer })
  const bus = new EventBus(runtime, screen, { prefer })
  persistence.attach(runtime, { bus })
  const f = store.factory
  const nn = (s: string) => f.namedNode(X + s)
  const set = (s: string, p: string, v: string) => runtime.apply({ remove: store.match(nn(s), nn(p), null), add: [f.quad(nn(s), nn(p), f.literal(v))] })
  const value = (s: string, p: string) => store.match(nn(s), nn(p), null, f.defaultGraph()).map((q) => q.object.value)
  const horizon = () => {
    const h = f.namedNode(X + 'remember/~horizon')
    const n = (p: string) => Number(store.match(h, f.namedNode(RET + p), null, f.namedNode(RETENTION_GRAPH))[0]?.object.value ?? NaN)
    return { inMemory: n('inMemory'), offloaded: n('offloaded'), dropped: n('dropped') }
  }
  const expiries = () => store.match(null, f.namedNode(NS.rdf + 'type'), f.namedNode(PER + 'Expire'), f.namedNode(PERSIST_GRAPH)).length
  const crossed = () => store.match(nn('remember'), f.namedNode(RET + 'crossed'), null).map((q) => q.object.value)
  return { store, runtime, persistence, bus, f, nn, set, value, horizon, expiries, crossed }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('remembered state by its retention (per:retention as ret:Within)', () => {
  it('measures from each triple\'s age, not the last write: a duration alone drops, counted and logged', async () => {
    const session = memoryBackend()
    const storage = { [PER + 'Session']: session }
    at(T0)
    const a = await page(settings, storage)
    a.set('prefs', 'a', 'old')
    a.set('prefs', 'b', 'first')
    await a.persistence.flush()
    // A day later, one of them changes: the policy is written again, the other keeps its age.
    at(T0 + 20 * HOUR)
    a.set('prefs', 'b', 'second')
    await a.persistence.flush()
    a.persistence.stop()

    // Thirty hours after the first write, ten after the last: only what was changed within a day comes back.
    at(T0 + 30 * HOUR)
    const b = await page(settings, storage)
    expect(b.value('prefs', 'a')).toEqual([])
    expect(b.value('prefs', 'b')).toEqual(['second'])
    // Dropped (the policy says so, by its duration alone), not silently: storage no longer holds it,
    // the horizon counts it, and the state log says so.
    expect(await session.get('semblance:' + X + 'remember')).not.toContain('"old"')
    expect(await session.get('semblance:' + X + 'remember~aside')).toBeUndefined()
    expect(b.horizon()).toEqual({ inMemory: 1, offloaded: 0, dropped: 1 })
    expect(b.expiries()).toBe(1)
    expect(b.crossed()).toEqual([]) // not person-facing: nothing announced
    b.persistence.stop()

    // What is left keeps its own age: a reload later the same day restores it.
    at(T0 + 40 * HOUR)
    const c = await page(settings, storage)
    expect(c.value('prefs', 'b')).toEqual(['second'])
    expect(c.horizon()).toEqual({ inMemory: 1, offloaded: 0, dropped: 0 })
    c.persistence.stop()
  })

  it.each(['sparql', 'function'] as const)('sets aside by default, announces it once, and Show older brings it back (%s)', async (prefer) => {
    const session = memoryBackend()
    const storage = { [PER + 'Session']: session }
    at(T0)
    const a = await page(notes(), storage, prefer)
    a.set('n1', 'text', 'kept since January')
    await a.persistence.flush()
    at(T0 + 30 * HOUR)
    a.set('n2', 'text', 'written today')
    await a.persistence.flush()
    a.persistence.stop()

    at(T0 + 36 * HOUR)
    const b = await page(notes(), storage, prefer)
    expect(b.value('n1', 'text')).toEqual([])
    expect(b.value('n2', 'text')).toEqual(['written today'])
    // Set aside, in the same storage, not dropped.
    expect(await session.get('semblance:' + X + 'remember~aside')).toContain('kept since January')
    expect(b.horizon()).toEqual({ inMemory: 1, offloaded: 1, dropped: 0 })
    expect(b.expiries()).toBe(1)
    await settle()
    expect(b.crossed()).toEqual([RET + 'Offloaded'])

    // Show older (ret:recall on the policy): it comes back, is stored with the policy again, and
    // leaves what was set aside.
    b.runtime.apply({ remove: [], add: [b.f.quad(b.nn('remember'), b.f.namedNode(RET + 'recall'), b.f.literal('50', b.f.namedNode(NS.xsd + 'integer')))] })
    await settle()
    await b.persistence.flush()
    await settle()
    expect(b.value('n1', 'text')).toEqual(['kept since January'])
    expect(b.store.match(b.nn('remember'), b.f.namedNode(RET + 'recall'), null)).toHaveLength(0)
    expect(await session.get('semblance:' + X + 'remember~aside')).toBeUndefined()
    expect(await session.get('semblance:' + X + 'remember')).toContain('kept since January')
    expect(b.horizon()).toEqual({ inMemory: 2, offloaded: 0, dropped: 0 })
    b.persistence.stop()

    // Recalled, it keeps its age: the next load sets it aside again, as the policy says.
    const c = await page(notes(), storage, prefer)
    expect(c.value('n1', 'text')).toEqual([])
    expect(c.horizon().offloaded).toBe(1)
    c.persistence.stop()
  })

  it('a storage that refuses to set aside restores it after all: nothing leaves unstored', async () => {
    const session = memoryBackend()
    let refuse = false
    const storage = { [PER + 'Session']: { ...session, set: (k: string, v: string) => (refuse && k.endsWith('~aside') ? Promise.reject(Object.assign(new Error('full'), { name: 'QuotaExceededError' })) : session.set(k, v)) } }
    at(T0)
    const a = await page(notes(), storage)
    a.set('n1', 'text', 'old note')
    await a.persistence.flush()
    a.persistence.stop()
    refuse = true
    at(T0 + 30 * HOUR)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = await page(notes(), storage)
    expect(warn).toHaveBeenCalled()
    expect(b.value('n1', 'text')).toEqual(['old note'])
    expect(await session.get('semblance:' + X + 'remember')).toContain('old note')
    expect(b.horizon()).toEqual({ inMemory: 1, offloaded: 0, dropped: 0 })
    b.persistence.stop()
  })

  it('ret:storageAmount bounds what is set aside: past it the oldest are dropped, and counted', async () => {
    const storage = { [PER + 'Session']: memoryBackend() }
    at(T0)
    const a = await page(notes(' ; ret:storageAmount 1'), storage)
    a.set('n1', 'text', 'first')
    await a.persistence.flush()
    at(T0 + HOUR)
    a.set('n2', 'text', 'second')
    await a.persistence.flush()
    a.persistence.stop()
    at(T0 + 30 * HOUR)
    const b = await page(notes(' ; ret:storageAmount 1'), storage)
    expect(b.horizon()).toEqual({ inMemory: 0, offloaded: 1, dropped: 1 })
    await settle()
    expect(b.crossed().sort()).toEqual([RET + 'Dropped', RET + 'Offloaded'])
    b.persistence.stop()
  })
})
