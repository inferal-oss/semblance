// Stale storage keys are swept once every declared graph has loaded (docs/RETENTION.md §8.11): what a
// policy no longer declared left in storage, kept files no graph names, and what closed pages
// offloaded (test/retention.test.ts). Nothing is swept before a graph loaded later is in (it may
// declare what is stored), nothing another open page may use, and nothing under the prefix that is
// not remembered state.
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { Files } from '../src/files.ts'
import { memoryFileStore } from '../src/file-store.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS } from '../src/ns.ts'
import { memoryBackend, Persistence, SWEEP_GRACE_MS } from '../src/persistence.ts'
import { memoryPages, type OpenPages } from '../src/pages.ts'
import { Runtime } from '../src/runtime.ts'

const X = 'https://example.org/sweep#'
const PER = NS.per
const DAY = 86_400_000
const P = 'semblance:'

const prefixes = `@prefix x: <${X}> .
@prefix per: <${PER}> .
`
/** The app at start: one policy on the device. */
const app = `${prefixes}
x:kept a per:Policy ; per:scope per:Device ; per:subject x:prefs ; per:properties ( x:a ) .`
/** A graph loaded later (a page's own): its policy's state is stored too. */
const late = `${prefixes}
x:late a per:Policy ; per:scope per:Device ; per:subject x:prefs ; per:properties ( x:b ) .`

/** A policy's stored copy, as Persistence writes it. */
const copy = (property: string, value: string, extra: object = {}) =>
  JSON.stringify({ version: '1', savedAt: Date.now() - 50 * DAY, nt: `<${X}prefs> <${X}${property}> "${value}" .\n`, ...extra })

/** The device's storage as earlier pages left it. */
function device() {
  const b = memoryBackend()
  const set = (k: string, v: string) => void b.set(k, v)
  set(P + X + 'kept', copy('a', 'kept'))
  // Declared by the graph loaded later, with a chunk written since its copy.
  set(P + X + 'late', copy('b', 'old', { chunks: 1 }))
  set(P + X + 'late#1', JSON.stringify({ add: `<${X}prefs> <${X}b> "late" .\n`, remove: `<${X}prefs> <${X}b> "old" .\n` }))
  // A policy no page has declared for 40 days: its copy, a chunk and what its retention set aside.
  set(P + X + 'gone', copy('c', 'gone', { chunks: 1 }))
  set(P + X + 'gone#1', JSON.stringify({ add: '', remove: '' }))
  set(P + X + 'gone~aside', JSON.stringify({ version: '1', nt: '', ages: [] }))
  // One last declared a day ago (another version of the app, a page not visited since): within the grace.
  set(P + X + 'recent', copy('d', 'recent'))
  // One the record does not know (stored before there was one): its clock starts now.
  set(P + X + 'unknown', copy('e', 'unknown'))
  // Not remembered state, under the same prefix: another owner's.
  set(P + 'ret:run|stream|policy|000000000001', 'offloaded')
  // A remote write the store has not answered (a person's unsent change): owned, never swept, even
  // when it looks like a stored copy and the record says nothing declared it for long.
  set(P + 'src:' + X + 'source|place', copy('f', 'unsent'))
  set(P + 'other', 'kept')
  set(P + '~declared', JSON.stringify({ ['src:' + X + 'source|place']: Date.now() - 40 * DAY, [X + 'gone']: Date.now() - 40 * DAY, [X + 'recent']: Date.now() - DAY, [X + 'kept']: Date.now() - 40 * DAY }))
  return b
}

/** A page over `storage`, as the host runs it, with the graph loaded later held back until `loadLate`. */
async function page(storage: ReturnType<typeof memoryBackend>, opts: { pages?: OpenPages; sweep?: false } = {}) {
  const store = loadStore('oxigraph', app)
  const persistence = new Persistence(store, { [PER + 'Device']: storage, [PER + 'Session']: memoryBackend() }, { delayMs: 60_000, ...(opts.sweep === false && { sweep: false }) })
  await persistence.restore()
  const runtime = new Runtime(store)
  runtime.pages = opts.pages
  // The host loads a graph later: it holds "every graph has loaded" until it is in.
  const release = runtime.holdGraphs()
  const screen = runtime.project({ modality: MOD.Screen })
  persistence.attach(runtime, { bus: new EventBus(runtime, screen) })
  const value = (p: string) => store.match(store.factory.namedNode(X + 'prefs'), store.factory.namedNode(X + p), null).map((q) => q.object.value)
  const loadLate = async () => {
    runtime.load(late)
    await persistence.restoreAdded()
    release()
  }
  return { store, runtime, persistence, value, loadLate }
}

const idle = async (times = 5) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 5))
}
const keys = async (b: ReturnType<typeof memoryBackend>) => (await b.keys!('')).sort()
const ledger = async (b: ReturnType<typeof memoryBackend>) => JSON.parse((await b.get(P + '~declared')) ?? '{}') as Record<string, number>

describe('remembered state no policy declares is swept once every declared graph has loaded', () => {
  it('removes only the undeclared policy past its grace, and only after the late graph is in', async () => {
    const storage = device()
    const before = await keys(storage)
    const h = await page(storage)
    expect(h.value('a')).toEqual(['kept'])
    // The late graph is not in yet: nothing is swept, even what no graph has declared for 40 days.
    await idle()
    expect(await keys(storage)).toEqual(before)

    await h.loadLate()
    expect(h.value('b')).toEqual(['late'])
    const removed = await h.persistence.sweep()
    expect(removed.sort()).toEqual([P + X + 'gone', P + X + 'gone#1', P + X + 'gone~aside'])
    expect(await keys(storage)).toEqual(before.filter((k) => !removed.includes(k)))
    // What this page declares is stamped now; what is within its grace keeps its stamp; what the
    // record did not know starts its clock; what is not remembered state is not in the record.
    const stamps = await ledger(storage)
    expect(Object.keys(stamps).sort()).toEqual(['kept', 'late', 'recent', 'unknown'].map((n) => X + n))
    for (const n of ['kept', 'late', 'unknown']) expect(Date.now() - stamps[X + n]!).toBeLessThan(DAY)
    expect(Date.now() - stamps[X + 'recent']!).toBeGreaterThanOrEqual(DAY)
    // Once per page load.
    expect(await h.persistence.sweep()).toBe(removed)
  })

  it('a name the record started the clock on goes once no page has declared it for the grace', async () => {
    const storage = device()
    const h = await page(storage)
    await h.loadLate()
    await h.persistence.sweep()
    h.runtime.end()
    // The grace later, as the record says: the name it found undeclared is still undeclared.
    const stamps = await ledger(storage)
    await storage.set(P + '~declared', JSON.stringify({ ...stamps, [X + 'unknown']: Date.now() - SWEEP_GRACE_MS - 1 }))
    const next = await page(storage)
    await next.loadLate()
    expect(await next.persistence.sweep()).toEqual([P + X + 'unknown'])
    expect(next.value('a')).toEqual(['kept'])
  })

  it('leaves everything while another page of the app is open (it may be of another version)', async () => {
    const storage = device()
    const before = await keys(storage)
    const pages = memoryPages()
    const other = pages.open(P + 'open|another-tab')
    const h = await page(storage, { pages })
    await h.loadLate()
    expect(await h.persistence.sweep()).toEqual([])
    expect(await keys(storage)).toEqual(before)
    // The other page closes; the next page sweeps.
    other()
    h.runtime.end()
    expect(await pages.marked(P + 'open|')).toEqual([])
    const next = await page(storage, { pages })
    await next.loadLate()
    expect(await pages.marked(P + 'open|')).toEqual([P + 'open|' + next.runtime.run])
    expect((await next.persistence.sweep()).sort()).toEqual([P + X + 'gone', P + X + 'gone#1', P + X + 'gone~aside'])
  })

  it('sweeps nothing when told not to', async () => {
    const storage = device()
    const before = await keys(storage)
    const h = await page(storage, { sweep: false })
    await h.loadLate()
    expect(await h.persistence.sweep()).toEqual([])
    await idle()
    expect(await keys(storage)).toEqual(before)
  })

  it('a late graph that never loads leaves storage as it is', async () => {
    const storage = device()
    const before = await keys(storage)
    const h = await page(storage)
    let swept = false
    void h.persistence.sweep().then(() => (swept = true))
    await idle(10)
    expect(swept).toBe(false)
    expect(await keys(storage)).toEqual(before)
  })
})

describe('kept files no graph names are freed once every declared graph has loaded', () => {
  const contents = { name: 'a.png', type: 'image/png', size: 10, lastModified: 0 }
  const record = (by?: string) => ({ store: X + 'store', name: 'a.png', type: 'image/png', size: 10, contents, ...(by && { keptBy: by, keptAt: Date.now() }) })

  async function files(kept: ReturnType<typeof memoryFileStore>, pages: OpenPages | undefined) {
    const store = loadStore('oxigraph', app)
    const runtime = new Runtime(store)
    runtime.pages = pages
    const release = runtime.holdGraphs()
    const bus = new EventBus(runtime, runtime.project({ modality: MOD.Screen }))
    const effect = new Files(bus, { keep: kept, thumbnail: null, urls: { create: () => 'blob:x', revoke: () => {} } })
    effect.attach()
    return { runtime, effect, release }
  }

  it('frees a closed page\'s file, and holds one an open page kept (it may not have remembered its node yet)', async () => {
    const kept = memoryFileStore()
    await kept.put('of-open-tab', record('tab'))
    await kept.put('of-closed-tab', record('closed'))
    await kept.put('of-earlier-version', record())
    const pages = memoryPages()
    pages.open('semblance-files:open|tab')
    const h = await files(kept, pages)
    await idle()
    // Not before every graph is in: a graph loaded later may name them.
    expect([...kept.files.keys()].sort()).toEqual(['of-closed-tab', 'of-earlier-version', 'of-open-tab'])
    h.release()
    await h.effect.ready
    // One kept before pages said who kept it: held while any other page that keeps files is open.
    expect([...kept.files.keys()].sort()).toEqual(['of-earlier-version', 'of-open-tab'])
  })

  it('without marks of open pages, holds a file for the grace after it was kept', async () => {
    const kept = memoryFileStore()
    await kept.put('recent', record('tab'))
    await kept.put('old', { ...record('tab'), keptAt: Date.now() - 2 * DAY })
    await kept.put('of-earlier-version', record())
    const h = await files(kept, undefined)
    h.release()
    await h.effect.ready
    expect([...kept.files.keys()]).toEqual(['recent'])
  })
})
