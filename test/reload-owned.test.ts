// Nothing a person owns is lost across a reload (docs/RETENTION.md §5.5, "Conservation"). A visit does
// what remembered state and kept files hold - saves settings, changes how the site looks, keeps a
// file in the explorer, switches the change log on and runs it far past its bounds - then reloads
// over the same storage. Every triple a remembered policy covers (what it would store now) is back,
// in the graph it is restored to; under simulated critical memory pressure too, and with a storage
// that refuses the last writes (the earlier copy comes back, and the policy said it was unsaved).
// Each run's retained streams conserve what they were given: appended + loaded = in memory +
// offloaded + pending + dropped. Offloaded history goes with the page that kept it: a new page
// sweeps an earlier one's chunks, by design (§8.2), so it is not owned and does not come back.
import type { Quad, Term } from '@rdfjs/types'
import { afterAll, describe, expect, it } from 'vitest'
import type { FileLike } from '../src/files.ts'
import { type FileStoreBackend, memoryFileStore } from '../src/file-store.ts'
import { BEH, EVENTS_GRAPH, LDES, NS, PERSIST_GRAPH } from '../src/ns.ts'
import { type Backend, memoryBackend } from '../src/persistence.ts'
import { RetainedStream } from '../src/retention/offload.ts'
import { MemoryPressure } from '../src/retention/pressure.ts'
import { mountSiteKeeping } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const FX = 'https://semblance.dev/demo/files#'
const SET = 'https://semblance.dev/demo/settings#'
const PER = NS.per
const RET = NS.ret

// What each retained stream was given, per stream (each run's are its own): appended and loaded members.
const given = new Map<RetainedStream, number>()
const { append, load } = RetainedStream.prototype
RetainedStream.prototype.append = function (this: RetainedStream, ...args: Parameters<typeof append>) {
  given.set(this, (given.get(this) ?? 0) + 1)
  return append.apply(this, args)
}
RetainedStream.prototype.load = function (this: RetainedStream, ...args: Parameters<typeof load>) {
  given.set(this, (given.get(this) ?? 0) + args[0].length)
  return load.apply(this, args)
}
afterAll(() => Object.assign(RetainedStream.prototype, { append, load }))

const file = (name: string, type: string, size: number): FileLike => ({ name, type, size, lastModified: Date.UTC(2026, 9, 24, 12) })

interface Browser {
  backends: Record<string, Backend>
  kept: FileStoreBackend
  /** Offloaded history (IndexedDB in a browser). */
  offload: Backend
}
const browser = (): Browser => ({
  backends: { [PER + 'Session']: memoryBackend(), [PER + 'Device']: memoryBackend(), [PER + 'Database']: memoryBackend() },
  kept: memoryFileStore(),
  offload: memoryBackend(),
})

/** The site over a browser's storage, as the host runs it, with offloaded history written at once. */
async function visit(b: Browser) {
  const h = await mountSiteKeeping(b.backends, b.kept)
  Object.assign(h.runtime.retention.opts, { schedule: (run: () => void) => run() })
  await h.runtime.retention.use(b.offload)
  const f = h.store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((x) => x.textContent!.trim() === text && visible(x))!
  const example = (name: string) => {
    click(button('Examples'))
    click([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((x) => x.textContent!.trim() === name && visible(x))!)
  }
  const root = (local: string) => h.shell.nodeOf(UI + local + '/~root') as HTMLElement
  const type = (local: string, text: string) => {
    const el = root(local).querySelector('input, textarea') as HTMLInputElement
    el.value = text
    h.fire(el, 'input')
  }
  /**
   * Every triple an enabled policy covers now (what it would store), counted by a key of the graph it
   * is restored to and its terms: a blank node by what it says (an rdf:List cell by its items), since
   * a reload gives it a new label. `history`: the remembered change log's (bounded history, by
   * retention), else the rest (data a person owns).
   */
  const owned = (only?: 'data' | 'history') => {
    const out = new Map<string, number>()
    for (const policy of h.persistence.policies()) {
      if (!policy.enabled) continue
      const history = policy.graph === EVENTS_GRAPH
      if (only && history !== (only === 'history')) continue
      const g = policy.graph ? nn(policy.graph) : f.defaultGraph()
      const term = (t: Term, depth = 0): string =>
        t.termType !== 'BlankNode' || depth > 16
          ? t.termType + ':' + t.value
          : '[' + h.store.match(t as Quad['subject'], null, null, g).map((q) => q.predicate.value + ' ' + term(q.object, depth + 1)).sort().join('; ') + ']'
      for (const q of h.persistence.collect(policy)) {
        const k = (policy.graph ?? '') + ' ' + term(q.subject) + ' ' + q.predicate.value + ' ' + term(q.object)
        out.set(k, (out.get(k) ?? 0) + 1)
      }
    }
    return out
  }
  /** What of `before` the policies of this page do not cover (as many times as it was there). */
  const missing = (before: Map<string, number>, only?: 'data' | 'history') => {
    const now = owned(only)
    return [...before].filter(([k, n]) => (now.get(k) ?? 0) < n).map(([k]) => k)
  }
  /** Each retained stream: what it was given against where its members are. */
  const conservation = () =>
    h.runtime.retention.all().map((s) => {
      const x = s.figures()
      return { stream: s.iri, given: given.get(s) ?? 0, accounted: x.inMemory + x.offloaded + x.pending + x.dropped, offloaded: x.offloaded }
    })
  const unsaved = (policy: string) => h.store.match(nn(policy), nn(PER + 'unsaved'), null, nn(PERSIST_GRAPH)).map((q) => q.object.value)
  return { ...h, f, nn, click, example, root, type, owned, missing, conservation, unsaved }
}
type Visit = Awaited<ReturnType<typeof visit>>

/** What a person does that remembered state and kept files hold, with the change log on and run past its bounds. */
async function use(h: Visit) {
  const { f, nn } = h
  // The change log, switched on (Tools → Change log), with small bounds so a visit passes them.
  const policy = nn(UI + 'rememberChangeLog')
  h.runtime.apply({ remove: h.store.match(policy, nn(PER + 'enabled'), null), add: [f.quad(policy, nn(PER + 'enabled'), f.literal('true', nn(NS.xsd + 'boolean')))] })
  for (const [name, n] of [['ChangeLogRetention', 20], ['UndoRetention', 30]] as const) {
    const p = nn(NS.beh + name)
    for (const q of h.store.match(p, nn(LDES.amount), null)) h.store.delete(q)
    h.store.add(f.quad(p, nn(LDES.amount), f.literal(String(n), nn(NS.xsd + 'integer'))))
  }
  // Settings, saved (on this device), after typing a name a keystroke at a time.
  h.example('Settings')
  const name = 'Augusta Ada King, Countess of Lovelace'
  for (let i = 1; i <= name.length; i++) h.type('set-name', name.slice(0, i))
  h.click(h.root('set-public').querySelector('[role=switch]')!)
  const save = h.root('set-save')
  h.click(save.closest('button') ?? save.querySelector('button')!)
  // How the site looks (remembered on this device): its theme.
  h.runtime.apply({ remove: h.store.match(nn(UI + 'shell'), nn(NS.sty + 'theme'), null), add: [f.quad(nn(UI + 'shell'), nn(NS.sty + 'theme'), nn(NS.sty + 'Classic'))] })
  // A file of one's own, kept in the explorer (the bytes in the file store, what is said of it in the database).
  h.example('File explorer')
  h.picker.next = [file('Sunset.png', 'image/png', 120_000)]
  h.click((h.shell.nodeOf(UI + 'ex-files/~root') as HTMLElement).querySelector('[data-sem-c=file-drop] .sem-zone') as HTMLElement)
  await h.files.settled()
  h.shell.flush()
  await h.persistence.flush()
  await h.runtime.retention.flush()
}

const named = (h: Visit, name: string) => h.store.match(null, h.nn(NS.file + 'name'), h.f.literal(name), h.f.defaultGraph())[0]?.subject.value

describe('nothing a person owns is lost across a reload', () => {
  it('every owned triple is back, and each run conserves its history', async () => {
    const b = browser()
    const a = await visit(b)
    await use(a)
    const before = a.owned()
    expect(before.size).toBeGreaterThan(100)
    // The change log ran past its bounds: some of it offloaded, none dropped, all accounted for.
    const log = a.runtime.retention.get(BEH.ChangeLog)!.figures()
    expect(log.offloaded).toBeGreaterThan(0)
    expect(log.dropped).toBe(0)
    for (const x of a.conservation()) expect(x.accounted, x.stream).toBe(x.given)
    const offloadedKeys = await b.offload.keys!('semblance:ret:')
    expect(offloadedKeys.length).toBeGreaterThan(0)
    a.persistence.stop()

    const c = await visit(b)
    expect(c.missing(before)).toEqual([])
    expect(c.store.match(c.nn(UI + 'set-saved'), c.nn(SET + 'displayName'), null).map((q) => q.object.value)).toEqual(['Augusta Ada King, Countess of Lovelace'])
    const sunset = named(c, 'Sunset.png')!
    expect((await c.files.contentsOf(sunset))?.size).toBe(120_000)
    // History offloaded by the earlier page went with it (swept); this run's streams conserve their own.
    expect((await b.offload.keys!('semblance:ret:')).filter((k) => offloadedKeys.includes(k))).toEqual([])
    for (const x of c.conservation()) expect(x.accounted, x.stream).toBe(x.given)
    expect(c.runtime.retention.get(BEH.ChangeLog)?.figures().offloaded ?? 0).toBe(0)
    c.persistence.stop()
  })

  it('under critical memory pressure, nothing owned goes, before the reload or after it', async () => {
    const b = browser()
    const a = await visit(b)
    await use(a)
    const data = a.owned('data')
    // The Memory tool's Simulate: Critical, then the pressure effect's steps (evict, compact, offload, ret:Pressure, the host).
    const budget = a.nn(UI + 'memoryBudget')
    a.runtime.apply({ remove: a.store.match(budget, a.nn(RET + 'simulate'), null), add: [a.f.quad(budget, a.nn(RET + 'simulate'), a.nn(RET + 'Critical'))] })
    const pressure = new MemoryPressure(a.runtime, { bus: a.bus, sample: () => ({ wasmBytes: 0, heapBytes: 0 }) })
    for (let i = 0; i < 3; i++) expect(await pressure.step()).toBe('critical')
    a.shell.flush()
    expect(Number(a.store.match(budget, a.nn(RET + 'evicted'), null)[0]?.object.value)).toBeGreaterThan(0)
    // Data is what it was: eviction took derived state, offloading took history (and kept count of it).
    expect([...a.owned('data')].sort()).toEqual([...data].sort())
    await a.persistence.flush()
    await a.runtime.retention.flush()
    const log = a.runtime.retention.get(BEH.ChangeLog)!.figures()
    expect(log.dropped).toBe(0)
    for (const x of a.conservation()) expect(x.accounted, x.stream).toBe(x.given)
    const remembered = a.owned()
    pressure.stop()
    a.persistence.stop()

    const c = await visit(b)
    expect(c.missing(data, 'data')).toEqual([])
    expect(c.missing(remembered)).toEqual([]) // the change log as it was remembered, too
    for (const x of c.conservation()) expect(x.accounted, x.stream).toBe(x.given)
    c.persistence.stop()
  })

  it('with a storage that refuses the last writes, the earlier copy comes back, and it said it was unsaved', async () => {
    const b = browser()
    let full = false
    const quota = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })
    for (const [scope, backend] of Object.entries(b.backends)) b.backends[scope] = { ...backend, set: (k, v) => (full ? Promise.reject(quota()) : backend.set(k, v)) }
    const a = await visit(b)
    await use(a)
    const saved = a.owned()

    // Storage fills up: what changes from here is not stored, and the graph says so.
    full = true
    const warn = console.warn
    console.warn = () => {}
    try {
      a.example('Settings')
      a.type('set-name', 'Not stored')
      const save = a.root('set-save')
      a.click(save.closest('button') ?? save.querySelector('button')!)
      await a.persistence.flush()
    } finally {
      console.warn = warn
    }
    expect(a.unsaved(UI + 'rememberExampleSettings')).toEqual(['true'])
    expect(a.unsaved(UI + 'rememberChangeLog')).toEqual(['true'])
    a.persistence.stop()

    full = false
    const c = await visit(b)
    expect(c.missing(saved)).toEqual([])
    expect(c.store.match(c.nn(UI + 'set-saved'), c.nn(SET + 'displayName'), null).map((q) => q.object.value)).toEqual(['Augusta Ada King, Countess of Lovelace'])
    expect((await c.files.contentsOf(named(c, 'Sunset.png')!))?.size).toBe(120_000)
    c.persistence.stop()
  })
})
