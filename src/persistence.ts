// Persistence (ontology/layers/persistence.ttl, PERSISTENCE.md): policies in
// the graph say what to remember, where, and whether; this host effect
// restores them before the first projection and writes them back in idle
// time after input changes they cover. Writes, restores and forgets are
// members of per:StateLog, in the persistence graph projections read.
//
// A policy marked iv:strategy iv:Incremental keeps its CONSTRUCT as a maintained
// view (docs/IVM.md, phase 3): the view's changes say when it is dirty (exactly
// what its patterns read), and a write stores only what changed since the last
// one - a chunk of its own beside the stored base, compacted into the base when
// the chunks outgrow it - so writing costs the change, not the policy's size. A
// view reads the input graphs only (views step before projections), so a policy
// opts in when that is all it reads.
import type { Quad, Term } from '@rdfjs/types'
import { migrateQuads, readRetired } from './retired.ts'
import { Parser, Writer } from 'n3'
import type { EventBus, ReactionFn } from './behaviour/events.ts'
import type { FnRule } from './engine/context.ts'
import { formatLocale } from './engine/context.ts'
import { BEH, EVENTS_GRAPH, H, MOD, NS, PERSIST_GRAPH, RDF_TYPE, RETENTION_GRAPH, SEM, STY, XSD_BOOLEAN, XSD_INTEGER } from './ns.ts'
import { prefixesFor } from './prefixes.ts'
import { type Delta, mint, parseDuration, quadKey } from './rdf.ts'
import { logStream } from './retention/offload.ts'
import { policyOf } from './retention/policy.ts'
import type { ViewHandle } from './view/runtime.ts'
import type { Runtime } from './runtime.ts'
import type { GraphStore } from './store/types.ts'
import { labelOf, named, RDFS_LABEL, str, text } from './components/util.ts'
import { md5Key } from './components/data.ts'
import { TUPLE } from './render/order-key.ts'
import { dateOf, formatDateTime, formatNumber, numberOf, sortKey } from '../rdf-engine/host/intl.ts'

const PER = NS.per
const PROV = NS.prov
const TREE_MEMBER = NS.tree + 'member'
const XSD_DATETIME = NS.xsd + 'dateTime'
/** A term's kind and value, so an IRI and a blank node of the same label stay apart. */
const termKey = (t: Term) => t.termType + ':' + t.value

/** What a stored key starts with, unless Persistence is told otherwise. */
export const STORAGE_PREFIX = 'semblance:'

/** Where a scope keeps its strings. Asynchronous, so IndexedDB fits too. */
export interface Backend {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
  /** Hear about keys another tab changed (a scope other tabs share); returns a function that stops it. */
  watch?(listener: (key: string) => void): () => void
  /** The keys stored that start with `prefix` (for sweeping what nothing declares any more). */
  keys?(prefix: string): Promise<string[]>
  /**
   * Binary values, held as they are (IndexedDB, memory). A storage of strings only (web storage)
   * leaves these out, and a caller with bytes writes them as text (base64). `get` returns strings
   * only, `getBytes` bytes only.
   */
  getBytes?(key: string): Promise<Uint8Array | undefined>
  setBytes?(key: string, value: Uint8Array): Promise<void>
}

export function memoryBackend(): Backend {
  const m = new Map<string, string | Uint8Array>()
  return {
    get: async (k) => (typeof m.get(k) === 'string' ? (m.get(k) as string) : undefined),
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
    keys: async (prefix) => [...m.keys()].filter((k) => k.startsWith(prefix)),
    getBytes: async (k) => (ArrayBuffer.isView(m.get(k)) ? (m.get(k) as Uint8Array) : undefined),
    setBytes: async (k, v) => void m.set(k, v.slice()),
  }
}

/** `events` hears the `storage` events other tabs' writes to it fire (the window, in a browser). */
export function webStorageBackend(storage: Storage, events: EventTarget | undefined = 'addEventListener' in globalThis ? globalThis : undefined): Backend {
  return {
    get: async (k) => storage.getItem(k) ?? undefined,
    set: async (k, v) => storage.setItem(k, v),
    remove: async (k) => storage.removeItem(k),
    keys: async (prefix) => {
      const out: string[] = []
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i)
        if (k?.startsWith(prefix)) out.push(k)
      }
      return out
    },
    ...(events && {
      watch: (listener: (key: string) => void) => {
        const heard = (e: Event) => {
          const { key, storageArea } = e as StorageEvent
          if (storageArea === storage && key !== null) listener(key)
        }
        events.addEventListener('storage', heard)
        return () => events.removeEventListener('storage', heard)
      },
    }),
  }
}

export function indexedDbBackend(name = 'semblance'): Backend {
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => req.result.createObjectStore('state')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const tx = async <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) => {
    const d = await db
    return new Promise<T>((resolve, reject) => {
      const r = run(d.transaction('state', mode).objectStore('state'))
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  }
  const read = (k: string) => tx<unknown>('readonly', (s) => s.get(k))
  return {
    get: async (k) => {
      const v = await read(k)
      return typeof v === 'string' ? v : undefined
    },
    set: async (k, v) => void (await tx('readwrite', (s) => s.put(v, k))),
    getBytes: async (k) => {
      const v = await read(k)
      return ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : undefined
    },
    setBytes: async (k, v) => void (await tx('readwrite', (s) => s.put(v, k))),
    remove: async (k) => void (await tx('readwrite', (s) => s.delete(k))),
    keys: async (prefix) => ((await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff')))) as string[]).filter((k) => typeof k === 'string'),
  }
}

interface Policy {
  iri: string
  scope: string
  enabled: boolean
  version: string
  graph?: string
  /** per:retention: what is restored, by each stored triple's age, and what leaves by. */
  retention?: Within
  subject?: Term
  properties: string[]
  construct?: string
  /** iv:strategy iv:Incremental: kept as a view (it reads input graphs only). */
  incremental: boolean
  /** Predicates whose changes make the policy dirty. */
  watches: Set<string>
  /** A storage-carried nav:Dimension rather than a declared policy (no switch of its own). */
  dimension?: true
  /** per:acrossTabs: an open tab takes what another tab stores. */
  acrossTabs?: true
  /** The triple patterns of per:construct's template: what it may store, and so restore (read once). */
  template?: Quad[]
}

/**
 * A policy's retention (per:retention, a ret:Within): a stored triple is restored while it was stored
 * (or last changed) within the duration. What is older leaves by the exit: set aside in storage,
 * where a recall finds it (ret:Offload, the default: remembered state is owned), or removed
 * (ret:Drop, only when the policy says so). Either is counted on the policy's horizon.
 */
interface Within {
  withinMs: number
  exit: 'drop' | 'offload'
  announce: boolean
  /** ret:storageAmount: how many triples set aside storage keeps; past it the oldest are dropped (counted). */
  storageAmount?: number
}

/** Ages as runs over a list in order: `[at, n]`, the next n were stored at `at` (ms since the epoch). */
type Runs = [number, number][]

interface Blob {
  version: string
  savedAt: number
  /** The base: every triple stored at the last full write. */
  nt: string
  /** Changes written since, each its own entry (`<key>#<i>`, i from 1), applied in order. */
  chunks?: number
  /** A policy with a retention: when each of nt's lines was stored, oldest first (without: savedAt). */
  ages?: Runs
}

/** A change written on its own (see Blob.chunks). */
interface Chunk {
  add: string
  remove: string
  /** When it was written: the age of what it adds (without: the base's savedAt). */
  at?: number
}

/** What a policy's retention set aside (`<key>~aside`): kept in storage, not restored, recallable. */
interface Aside {
  version: string
  nt: string
  ages: Runs
}

/** A stored triple and when it was stored. */
interface Aged {
  q: Quad
  at: number
}

/** What restoring a policy changes, and what its retention no longer restores. */
interface Change {
  add: Quad[]
  remove: Quad[]
  /** Older than the policy's retention: not restored. */
  expired: Aged[]
  /** What stays in the base, aged (a policy with a retention). */
  kept: Aged[]
}

/** A policy's horizon: what it restored, set aside and dropped (this session). */
interface Horizon {
  inMemory: number
  aside: number
  dropped: number
  oldest?: number
  /** Expiries not yet in the state log (restored before the runtime was there). */
  unrecorded: number
  /** Kinds crossed and not yet announced. */
  crossing: Set<'offloaded' | 'dropped'>
}

const runs = (ages: number[]): Runs => {
  const out: Runs = []
  for (const at of ages) {
    const last = out[out.length - 1]
    if (last && last[0] === at) last[1]++
    else out.push([at, 1])
  }
  return out
}
const unrun = (r: Runs | undefined, n: number, fallback: number): number[] => {
  const out: number[] = []
  for (const [at, k] of r ?? []) for (let i = 0; i < k; i++) out.push(at)
  while (out.length < n) out.push(fallback)
  return out
}

/** A policy kept by a view: what was last written (its tick), and the chunks and triples since the base. */
interface Kept {
  view: ViewHandle
  tick: number
  chunks: number
  chunkTriples: number
  baseTriples: number
  stop: () => void
}

let created: ((p: Persistence) => void) | undefined
/**
 * Hear about every Persistence made (one listener; undefined stops): test/setup.ts stops each
 * test's before releasing its stores, so no write waiting for its delay outlives them.
 */
export function watchPersistence(listener: ((p: Persistence) => void) | undefined): void {
  created = listener
}

/** The persistence effect for one store. */
export class Persistence {
  private runtime?: Runtime
  private dirty = new Set<string>()
  private timer?: ReturnType<typeof setTimeout>
  private detachInput?: () => void
  private stopped = false
  private seq = 0
  private log: Term[] = []
  private restoredCounts = new Map<string, number>()
  /** CONSTRUCT policies maintained as views, by policy IRI. */
  private kept = new Map<string, Kept>()
  /** What writes cost (tests): entries set, and the triples in them. */
  readonly writes = { entries: 0, triples: 0 }

  constructor(
    readonly store: GraphStore,
    readonly backends: Record<string, Backend>,
    /**
     * onFollowed: another tab's write was taken (per:acrossTabs), so the host shows the change, as after an event.
     * trusted: where the policies are declared (per:Policy, its subject, properties, query, scope and
     * graph, and storage-carried dimensions): the trusted graphs when the page renders authored
     * content (mount's `trusted`), so an author cannot add a policy or pick a storage key; the store
     * otherwise. Whether a policy is on (per:enabled) is state, read from the store.
     */
    readonly opts: { prefix?: string; delayMs?: number; onFollowed?: () => void; trusted?: GraphStore } = {},
  ) {
    created?.(this)
  }

  /** Stop following changes and drop a write waiting for its delay (flush first to keep it). */
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer), (this.timer = undefined)
    this.detachInput?.()
    this.detachInput = undefined
  }

  private key(policy: string) {
    return (this.opts.prefix ?? STORAGE_PREFIX) + policy
  }
  private backend(scope: string) {
    return this.backends[scope] ?? this.backends[PER + 'Session']!
  }

  private cachedPolicies?: Policy[]

  /** The policies declared in the graph (cached until a change touches per: terms). */
  policies(): Policy[] {
    return (this.cachedPolicies ??= this.readPolicies())
  }

  /** Where the policies are declared. */
  private get declared(): GraphStore {
    return this.opts.trusted ?? this.store
  }

  private readPolicies(): Policy[] {
    const s = this.declared
    const f = s.factory
    const nn = (x: string) => f.namedNode(x)
    const one = (subject: Term, p: string) => s.match(subject, nn(p), null)[0]?.object
    const enabled = (p: Term) => this.store.match(p, nn(PER + 'enabled'), null)[0]?.object.value !== 'false'
    const policies = s.match(null, nn(RDF_TYPE), nn(PER + 'Policy')).map(({ subject: p }) => {
      const construct = one(p, PER + 'construct')?.value
      const listHead = one(p, PER + 'properties')
      const properties: string[] = []
      for (let n = listHead; n && n.value !== NS.rdf + 'nil'; n = one(n, NS.rdf + 'rest')) {
        const first = one(n, NS.rdf + 'first')
        if (first) properties.push(first.value)
      }
      const retention = this.retentionOf(one(p, PER + 'retention'))
      return {
        iri: p.value,
        scope: one(p, PER + 'scope')?.value ?? PER + 'Session',
        enabled: enabled(p),
        version: one(p, PER + 'version')?.value ?? '1',
        graph: one(p, PER + 'graph')?.value,
        ...(retention && { retention }),
        subject: one(p, PER + 'subject'),
        properties,
        construct,
        incremental: one(p, NS.iv + 'strategy')?.value === NS.iv + 'Incremental',
        watches: new Set([...properties, ...(construct ? this.mentioned(construct) : [])]),
        ...(one(p, PER + 'acrossTabs')?.value === 'true' && { acrossTabs: true as const }),
      }
    })
    // A dimension of a location (nav:Dimension) carried by a storage scope is remembered like a
    // policy over its subject and property: storage has one writer.
    const dimensions = s.match(null, nn(NS.nav + 'carriedBy'), null).flatMap(({ subject: d, object: scope }): Policy[] => {
      const subject = one(d, NS.nav + 'subject')
      const property = one(d, NS.nav + 'property')?.value
      if (!subject || !property || !s.match(scope, nn(RDF_TYPE), nn(PER + 'Scope')).length) return []
      return [{ iri: d.value, scope: scope.value, enabled: true, version: '1', subject, properties: [property], incremental: false, watches: new Set([property]), dimension: true }]
    })
    return [...policies, ...dimensions]
  }

  /**
   * per:retention: a ret:Within (its duration in tree:value, its ret:onExpiry, by default ret:Offload),
   * or a duration alone, short for a ret:Within of it with ret:onExpiry ret:Drop.
   */
  private retentionOf(t: Term | undefined): Within | undefined {
    if (!t) return undefined
    if (t.termType === 'Literal') {
      const ms = parseDuration(t.value)
      return ms === undefined ? undefined : { withinMs: ms, exit: 'drop', announce: false }
    }
    const r = policyOf(this.declared, t, 'offload')
    if (r.withinMs === undefined) return undefined
    return { withinMs: r.withinMs, exit: r.exit, announce: r.announce, ...(r.storageAmount !== undefined && { storageAmount: r.storageAmount }) }
  }

  /** IRIs a query mentions (full or prefixed), for deciding what changes concern it. */
  private mentioned(query: string): string[] {
    const prefixes = { ...Object.fromEntries(Object.entries(NS)), ...this.declaredPrefixes() }
    const out = [...query.matchAll(/<([^>\s]+)>/g)].map((m) => m[1]!)
    for (const m of query.matchAll(/\b([a-z][\w-]*):([A-Za-z_][\w-]*)/g)) if (prefixes[m[1]!]) out.push(prefixes[m[1]!] + m[2])
    return out
  }
  private declaredPrefixes(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of prefixesFor(this.declared).split('\n')) {
      const m = /^PREFIX (\S*): <([^>]*)>/.exec(line)
      if (m) out[m[1]!] = m[2]!
    }
    return out
  }

  /**
   * Put enabled policies' stored triples back. Call before projecting, so the
   * first render already shows them. Returns how many triples were restored.
   */
  async restore(): Promise<number> {
    const f = this.store.factory
    // The switches themselves are remembered on the device.
    const flags = await this.backend(PER + 'Device').get(this.key('enabled'))
    if (flags) {
      // Only the switches of the policies declared: a stored flag names no other node.
      const declared = new Set(this.policies().filter((p) => !p.dimension).map((p) => p.iri))
      for (const [iri, on] of Object.entries(JSON.parse(flags) as Record<string, boolean>)) {
        if (!declared.has(iri) || typeof on !== 'boolean') continue
        const p = f.namedNode(iri)
        for (const q of this.store.match(p, f.namedNode(PER + 'enabled'), null)) this.store.delete(q)
        this.store.add(f.quad(p, f.namedNode(PER + 'enabled'), f.literal(String(on), f.namedNode(XSD_BOOLEAN))))
      }
    }
    this.cachedPolicies = undefined
    let total = 0
    for (const policy of this.policies()) {
      this.considered.add(policy.iri)
      const change = await this.restorable(policy)
      if (!change) continue
      for (const q of change.remove) this.store.delete(q)
      for (const q of change.add) if (!this.store.has(q)) this.store.add(q)
      this.restoredCounts.set(policy.iri, change.add.length)
      total += change.add.length
    }
    return total
  }

  /** The policies restore() has seen (a graph loaded later may bring more: restoreAdded). */
  private considered = new Set<string>()

  /**
   * Put back what the policies added since restore() stored (a graph loaded after start brought
   * them), as one change through the runtime, so what shows them updates. Returns how many triples.
   */
  async restoreAdded(): Promise<number> {
    const runtime = this.runtime
    if (!runtime) return 0
    const change: { add: Quad[]; remove: Quad[] } = { add: [], remove: [] }
    for (const policy of this.policies()) {
      if (this.considered.has(policy.iri)) continue
      this.considered.add(policy.iri)
      const c = await this.restorable(policy)
      if (!c) continue
      change.add.push(...c.add)
      change.remove.push(...c.remove)
      this.restoredCounts.set(policy.iri, c.add.length)
      this.record(PER + 'Restore', policy, c.add.length)
      this.reportExpiry(policy)
    }
    // Named graphs are input graphs too: each part goes where its policy keeps it.
    const byGraph = new Map<string, { add: Quad[]; remove: Quad[] }>()
    for (const [k, qs] of [['add', change.add], ['remove', change.remove]] as const) {
      for (const q of qs) {
        const g = q.graph.termType === 'DefaultGraph' ? '' : q.graph.value
        let d = byGraph.get(g)
        if (!d) byGraph.set(g, (d = { add: [], remove: [] }))
        d[k].push(q)
      }
    }
    for (const [g, d] of byGraph) (g ? runtime.write(g, d) : runtime.apply(d))
    return change.add.length
  }

  /**
   * What restoring a policy changes, with its retention settled: what is older than it is set aside
   * or dropped in storage first (write, then remove), and what could not be set aside is restored
   * after all, so nothing leaves without a trace.
   */
  private async restorable(policy: Policy): Promise<Change | undefined> {
    const change = await this.storedChange(policy)
    if (!change || !policy.retention) return change
    const back = await this.settle(policy, change)
    if (back.length) {
      // Restored after all: they replace the current values of their subjects and properties, as the rest do.
      const add = back.map((e) => this.into(policy, e.q))
      change.add.push(...add)
      const keep = new Set(change.add.map(quadKey))
      if (!policy.graph) for (const q of add) for (const x of this.store.match(q.subject, q.predicate, null, q.graph)) if (!keep.has(quadKey(x))) change.remove.push(x)
    }
    const h = this.horizonOf(policy)
    h.inMemory = change.add.length
    h.oldest = this.oldestOf(policy)
    return change
  }

  /** What restoring a policy changes: its stored triples, replacing the current values of their subjects and properties (none: nothing stored, or disabled). */
  private async storedChange(policy: Policy): Promise<Change | undefined> {
    const f = this.store.factory
    if (!policy.enabled) return undefined
    const raw = await this.backend(policy.scope).get(this.key(policy.iri))
    if (!raw) {
      if (policy.retention) await this.countAside(policy)
      return undefined
    }
    let blob: Blob
    try {
      blob = JSON.parse(raw)
    } catch {
      return undefined
    }
    if (blob.version !== policy.version) {
      await this.removeStored(policy)
      return undefined
    }
    const retired = readRetired(this.store)
    const remembered = migrateQuads(this.parse(blob.nt), retired, f)
    // A remembered triple that names a term which went without a new name cannot be carried over.
    if (!remembered) {
      await this.removeStored(policy)
      return undefined
    }
    const held = new Map(remembered.map((q) => [quadKey(q), q]))
    // When each was stored (a policy with a retention): the base's lines, then what each chunk added.
    const born = new Map<string, number>()
    if (policy.retention) {
      const ages = unrun(blob.ages, remembered.length, blob.savedAt)
      remembered.forEach((q, i) => born.set(quadKey(q), ages[i]!))
    }
    for (let i = 1; i <= (blob.chunks ?? 0); i++) {
      const raw = await this.backend(policy.scope).get(this.key(policy.iri) + '#' + i)
      if (!raw) break
      const chunk = JSON.parse(raw) as Chunk
      const [removed, added] = [migrateQuads(this.parse(chunk.remove), retired, f), migrateQuads(this.parse(chunk.add), retired, f)]
      if (!removed || !added) {
        await this.removeStored(policy)
        return undefined
      }
      for (const q of removed) held.delete(quadKey(q)), born.delete(quadKey(q))
      for (const q of added) {
        held.set(quadKey(q), q)
        if (policy.retention) born.set(quadKey(q), chunk.at ?? blob.savedAt)
      }
    }
    // Only what the policy covers comes back: whatever else storage holds stays there.
    let covered = [...held.values()].filter((q) => this.covers(policy, q))
    // Its retention: what was stored longer ago than it says is not restored.
    const expired: Aged[] = []
    const kept: Aged[] = []
    if (policy.retention) {
      const cut = Date.now() - policy.retention.withinMs
      const age = (q: Quad) => born.get(quadKey(q)) ?? blob.savedAt
      for (const q of held.values()) (age(q) < cut && this.covers(policy, q) ? expired : kept).push({ q, at: age(q) })
      kept.sort((a, b) => a.at - b.at)
      if (expired.length) covered = covered.filter((q) => age(q) >= cut)
      this.ages.set(policy.iri, new Map(kept.map((e) => [quadKey(e.q), e.at])))
    }
    const add = covered.map((q) => this.into(policy, q))
    // What is restored replaces the current values of the same subject and property.
    // Keyed by the terms themselves (a remembered subject may be a blank node, not an IRI).
    const g = policy.graph ? f.namedNode(policy.graph) : f.defaultGraph()
    const pairs = new Map(add.map((q) => [termKey(q.subject) + ' ' + termKey(q.predicate), q] as const))
    const keep = new Set(add.map(quadKey))
    const remove: Quad[] = []
    if (!policy.graph) for (const { subject, predicate } of pairs.values()) for (const q of this.store.match(subject, predicate, null, g)) if (!keep.has(quadKey(q))) remove.push(q)
    return { add, remove, expired, kept }
  }

  /** A stored triple in the graph its policy restores into. */
  private into(policy: Policy, q: Quad): Quad {
    const f = this.store.factory
    return f.quad(q.subject, q.predicate, q.object, policy.graph ? f.namedNode(policy.graph) : f.defaultGraph())
  }

  // --- retention (per:retention) ---------------------------------------------------------------------

  /** When each stored triple of a policy with a retention was stored (by quadKey). */
  private ages = new Map<string, Map<string, number>>()
  private horizons = new Map<string, Horizon>()

  private horizonOf(policy: Policy): Horizon {
    let h = this.horizons.get(policy.iri)
    if (!h) this.horizons.set(policy.iri, (h = { inMemory: 0, aside: 0, dropped: 0, unrecorded: 0, crossing: new Set() }))
    return h
  }

  private oldestOf(policy: Policy): number | undefined {
    let o: number | undefined
    for (const at of this.ages.get(policy.iri)?.values() ?? []) if (o === undefined || at < o) o = at
    return o
  }

  private asideKey(policy: Policy) {
    return this.key(policy.iri) + '~aside'
  }

  /** What a policy's retention set aside, by quadKey (none when it does not parse or is of another version). */
  private async readAside(policy: Policy): Promise<Map<string, Aged>> {
    const out = new Map<string, Aged>()
    const raw = await this.backend(policy.scope).get(this.asideKey(policy))
    if (!raw) return out
    try {
      const a = JSON.parse(raw) as Aside
      if (a.version !== policy.version) return out
      const quads = migrateQuads(this.parse(a.nt), readRetired(this.store), this.store.factory) ?? []
      const ages = unrun(a.ages, quads.length, 0)
      quads.forEach((q, i) => out.set(quadKey(q), { q, at: ages[i]! }))
    } catch {
      return out
    }
    return out
  }

  private async writeAside(policy: Policy, aside: Map<string, Aged>) {
    if (!aside.size) return this.backend(policy.scope).remove(this.asideKey(policy))
    const sorted = [...aside.values()].sort((x, y) => x.at - y.at)
    const value: Aside = { version: policy.version, nt: this.serialize(sorted.map((e) => e.q)), ages: runs(sorted.map((e) => e.at)) }
    await this.set(policy, this.asideKey(policy), JSON.stringify(value), sorted.length)
  }

  private async countAside(policy: Policy) {
    this.horizonOf(policy).aside = (await this.readAside(policy)).size
  }

  /**
   * What a restore found older than the policy's retention leaves storage's live copy by its exit:
   * set aside (written first, then the base without it) or dropped (the base without it). Returns
   * what could not be set aside (storage refused): it is restored after all.
   */
  private async settle(policy: Policy, change: Change): Promise<Aged[]> {
    const r = policy.retention!
    const h = this.horizonOf(policy)
    const aside = await this.readAside(policy)
    h.aside = aside.size
    if (!change.expired.length) return []
    let dropped = 0
    if (r.exit === 'offload') {
      for (const e of change.expired) aside.set(quadKey(e.q), e)
      // Past ret:storageAmount, the oldest set aside go, and are counted.
      if (r.storageAmount !== undefined && aside.size > r.storageAmount) {
        const oldest = [...aside.entries()].sort((x, y) => x[1].at - y[1].at)
        for (const [k] of oldest.slice(0, aside.size - r.storageAmount)) aside.delete(k), dropped++
      }
      try {
        await this.writeAside(policy, aside)
      } catch (e) {
        console.warn(`semblance: could not set aside what ${policy.iri} no longer restores; it is restored`, e)
        const ages = this.ages.get(policy.iri)
        for (const x of change.expired) ages?.set(quadKey(x.q), x.at)
        return change.expired
      }
    } else dropped = change.expired.length
    // The live copy without what left: the new base first, then the chunks it no longer counts. A
    // refused write leaves it there (not restored), settled again at the next load or write.
    try {
      await this.writeBase(policy, change.kept)
      const k = this.kept.get(policy.iri)
      if (k) k.tick = -1
    } catch (e) {
      console.warn(`semblance: could not rewrite ${policy.iri} without what its retention let go`, e)
    }
    h.aside = aside.size
    h.dropped += dropped
    h.unrecorded += change.expired.length
    if (r.announce) {
      if (r.exit === 'offload' && aside.size) h.crossing.add('offloaded')
      if (dropped) h.crossing.add('dropped')
    }
    return []
  }

  /** A base of these triples, oldest first, with their ages; then the chunks it replaces go. */
  private async writeBase(policy: Policy, aged: Aged[]) {
    const b = this.backend(policy.scope)
    const before = this.storedChunks(await b.get(this.key(policy.iri)))
    const blob: Blob = { version: policy.version, savedAt: Date.now(), nt: this.serialize(aged.map((e) => e.q)), ages: runs(aged.map((e) => e.at)) }
    await this.set(policy, this.key(policy.iri), JSON.stringify(blob), aged.length)
    for (let i = 1; i <= before; i++) await b.remove(this.key(policy.iri) + '#' + i)
  }

  /**
   * A policy's horizon (`<policy>/~horizon`, in urn:semblance:retention), its expiries in the state
   * log, and the first crossing announced: what its retention let go never goes unseen.
   */
  private reportExpiry(policy: Policy) {
    const runtime = this.runtime
    const h = this.horizons.get(policy.iri)
    if (!runtime || !h || !policy.retention) return
    const f = this.store.factory
    const nn = (x: string) => f.namedNode(x)
    const node = nn(mint(policy.iri, 'horizon'))
    const g = nn(RETENTION_GRAPH)
    const int = (n: number) => f.literal(String(n), nn(XSD_INTEGER))
    const want = [
      f.quad(node, nn(RDF_TYPE), nn(NS.ret + 'Horizon'), g),
      f.quad(node, nn(NS.ret + 'of'), nn(policy.iri), g),
      f.quad(node, nn(NS.ret + 'inMemory'), int(h.inMemory), g),
      f.quad(node, nn(NS.ret + 'offloaded'), int(h.aside), g),
      f.quad(node, nn(NS.ret + 'dropped'), int(h.dropped), g),
      ...(h.oldest !== undefined ? [f.quad(node, nn(NS.ret + 'oldestKept'), f.literal(new Date(h.oldest).toISOString(), nn(XSD_DATETIME)), g)] : []),
    ]
    const keys = new Set(want.map(quadKey))
    const have = this.store.match(node, null, null, g)
    const had = new Set(have.map(quadKey))
    const remove = have.filter((q) => !keys.has(quadKey(q)))
    const add = want.filter((q) => !had.has(quadKey(q)))
    if (add.length || remove.length) runtime.write(RETENTION_GRAPH, { add, remove })
    if (h.unrecorded) this.record(PER + 'Expire', policy, h.unrecorded), (h.unrecorded = 0)
    const bus = this.bus
    if (bus && h.crossing.size) {
      const kinds = [...h.crossing]
      h.crossing.clear()
      // After the tick that restored them, not inside it; once a session (the reaction says so).
      queueMicrotask(() => {
        if (this.stopped || runtime.ended) return
        for (const kind of kinds) bus.emit(NS.ret + (kind === 'offloaded' ? 'Offloaded' : 'Dropped'), policy.iri)
      })
    }
  }

  /**
   * Bring back the `n` most recent triples a policy's retention set aside (`?policy ret:recall ?n`),
   * as one change, never over a value the graph holds now. They are stored with the policy again,
   * with their ages, and only then leave what was set aside. Returns how many came back.
   */
  async recall(policyIri: string, n: number): Promise<number> {
    const runtime = this.runtime
    const policy = this.policies().find((p) => p.iri === policyIri)
    if (!runtime || !policy?.retention || !policy.enabled) return 0
    const aside = await this.readAside(policy)
    if (this.stopped) return 0
    const f = this.store.factory
    const g = policy.graph ? f.namedNode(policy.graph) : f.defaultGraph()
    const free = (q: Quad) => !!policy.graph || !this.store.match(q.subject, q.predicate, null, g).length
    const picked = [...aside.entries()].sort((x, y) => y[1].at - x[1].at).filter(([, e]) => free(e.q)).slice(0, n)
    if (!picked.length) return 0
    const add = picked.map(([, e]) => this.into(policy, e.q))
    let ages = this.ages.get(policy.iri)
    if (!ages) this.ages.set(policy.iri, (ages = new Map()))
    for (const [k, e] of picked) ages.set(k, e.at)
    if (policy.graph) runtime.write(policy.graph, { add, remove: [] })
    else runtime.apply({ add, remove: [] })
    this.dirty.add(policy.iri)
    await this.flush()
    const unsaved = this.store.match(f.namedNode(policy.iri), f.namedNode(PER + 'unsaved'), null, f.namedNode(PERSIST_GRAPH)).length > 0
    if (this.stopped || unsaved) return picked.length
    for (const [k] of picked) aside.delete(k)
    try {
      await this.writeAside(policy, aside)
    } catch {
      // Held in both: what was set aside still has it, and the policy's copy too.
    }
    // The write above counted them in memory.
    this.horizonOf(policy).aside = aside.size
    this.reportExpiry(policy)
    return picked.length
  }

  /**
   * Whether a policy covers a stored triple, so restoring it may bring the triple back: its
   * subject's properties (per:subject, per:properties), else a pattern of its query's template
   * (per:construct), a sensitive property never. A policy with a graph (per:graph) restores into
   * that graph alone, but the same holds there.
   */
  private covers(policy: Policy, q: Quad): boolean {
    if (this.isSensitive(q.predicate)) return false
    if (policy.subject) return termKey(q.subject) === termKey(policy.subject) && policy.properties.includes(q.predicate.value)
    if (!policy.construct) return false
    policy.template ??= this.templateOf(policy.construct)
    const fits = (pattern: Term, t: Term) => pattern.termType === 'Variable' || pattern.termType === 'BlankNode' || pattern.equals(t)
    return policy.template.some((p) => fits(p.subject, q.subject) && fits(p.predicate, q.predicate) && fits(p.object, q.object))
  }

  /** The triple patterns of a CONSTRUCT query's template (none when it cannot be read: nothing is restored). */
  private templateOf(query: string): Quad[] {
    const at = /\bCONSTRUCT\s*\{/i.exec(query)
    if (!at) return []
    const start = at.index + at[0].length
    // Braces outside IRIs, strings and comments, until the template's own closes.
    const token = /<[^>\s]*>|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|#[^\n]*|[{}]/g
    token.lastIndex = start
    let depth = 1
    let end = -1
    for (let m; end < 0 && (m = token.exec(query)); ) {
      if (m[0] === '{') depth++
      else if (m[0] === '}' && !--depth) end = m.index
    }
    if (end < 0) return []
    try {
      return new Parser({ format: 'N3' }).parse(prefixesFor(this.declared) + '\n' + query.slice(start, end).trim().replace(/\.?$/, ' .')) as Quad[]
    } catch {
      return []
    }
  }

  /** Whether the last restore put back what a policy (or a storage-carried dimension) stored. */
  restored(policy: string): boolean {
    return (this.restoredCounts.get(policy) ?? 0) > 0
  }

  /** Where a policy's retention announces what it let go (ret:Offloaded, ret:Dropped on the policy). */
  private bus?: EventBus

  /**
   * Follow input changes from now on; report restores in the state log, and what policies' retentions
   * let go on their horizons (announced on `bus`, when given). Returns a function that stops it (stop()).
   */
  attach(runtime: Runtime, opts: { bus?: EventBus } = {}): () => void {
    this.runtime = runtime
    this.bus = opts.bus
    for (const [policy, n] of this.restoredCounts) this.record(PER + 'Restore', this.policies().find((p) => p.iri === policy)!, n)
    for (const policy of this.policies()) this.report(policy), this.reportExpiry(policy)
    // Where we are may have come from the address since: storage-carried dimensions are written once.
    for (const policy of this.policies()) if (policy.dimension) this.dirty.add(policy.iri)
    if (this.dirty.size) this.schedule()
    this.keep()
    const stop = runtime.onInput((graph, delta) => this.changed(graph, delta))
    const unwatch = Object.entries(this.backends).flatMap(([scope, b]) => (b.watch ? [b.watch((key) => void this.follow(scope, key))] : []))
    // The runtime ending (a web mount's unmount) releases the store: a waiting write must not run.
    const unend = runtime.onEnd(() => this.stop())
    this.detachInput = () => {
      stop()
      unend()
      for (const u of unwatch) u()
      for (const [iri, k] of this.kept) k.stop(), runtime.views.unhost(mint(iri, 'view'))
      this.kept.clear()
    }
    return () => this.stop()
  }

  /**
   * Another tab stored `key` in `scope`: a policy across tabs (per:acrossTabs) takes it, as one change
   * through the runtime, so what shows it updates. Not written back: it is what is stored already.
   */
  private async follow(scope: string, key: string) {
    const policy = this.policies().find((p) => p.acrossTabs && p.enabled && p.scope === scope && this.key(p.iri) === key)
    const runtime = this.runtime
    if (!policy || !runtime || this.stopped) return
    const change = await this.restorable(policy)
    if (!change || this.stopped) return
    this.reportExpiry(policy)
    const add = change.add.filter((q) => !this.store.has(q))
    if (!add.length && !change.remove.length) return
    const dirty = this.dirty.has(policy.iri)
    const d = { add, remove: change.remove }
    if (policy.graph) runtime.write(policy.graph, d)
    else runtime.apply(d)
    if (!dirty) this.dirty.delete(policy.iri)
    this.restoredCounts.set(policy.iri, change.add.length)
    this.record(PER + 'Restore', policy, change.add.length)
    this.opts.onFollowed?.()
  }

  /**
   * Each CONSTRUCT policy marked iv:strategy iv:Incremental as a view, checked against a run of its
   * query (a policy that reads a projection's derived graph after all stays a run at each write).
   */
  private keep() {
    const runtime = this.runtime
    if (!runtime || !this.store.sparql) return
    for (const policy of this.policies()) {
      // A policy that is off keeps no view: its query would step on every tick for nothing.
      if (!policy.enabled || !policy.construct || !policy.incremental || policy.subject || this.kept.has(policy.iri)) continue
      const iri = mint(policy.iri, 'view')
      const view = runtime.views.host(iri, policy.construct)
      if (!view) continue
      const ours = new Set(view.quads().map(quadKey))
      const theirs = this.collect(policy).map(quadKey)
      const sensitive = new Set(view.quads().filter((q) => this.isSensitive(q.predicate)).map(quadKey))
      if (theirs.length !== ours.size - sensitive.size || theirs.some((k) => !ours.has(k))) {
        runtime.views.unhost(iri)
        continue
      }
      view.keepHistory(64)
      const stop = view.subscribe(() => {
        if (!policy.enabled) return
        this.dirty.add(policy.iri)
        this.schedule()
      })
      this.kept.set(policy.iri, { view, tick: -1, chunks: 0, chunkTriples: 0, baseTriples: 0, stop })
    }
  }

  private changed(graph: string | undefined, delta: Delta) {
    if (graph === PERSIST_GRAPH) return
    if (graph === undefined && [...delta.add, ...delta.remove].some((q) => q.predicate.value.startsWith(PER) || q.predicate.value.startsWith(NS.nav) || q.object.value === PER + 'Policy')) {
      this.cachedPolicies = undefined
      // A policy's view follows its query and its switch: turned off, it is let go; turned on, it is
      // kept again and written whole.
      for (const [iri, k] of [...this.kept]) {
        const p = this.policies().find((x) => x.iri === iri)
        if (p && p.enabled && p.construct && p.incremental) continue
        k.stop()
        this.runtime?.views.unhost(mint(iri, 'view'))
        this.kept.delete(iri)
      }
      this.keep()
    }
    const policies = this.policies()
    for (const q of [...delta.add, ...delta.remove]) {
      const p = q.predicate.value
      // Show older on a policy's horizon: what its retention set aside comes back.
      if (p === NS.ret + 'recall' && graph === undefined && delta.add.includes(q)) {
        if (policies.some((x) => x.iri === q.subject.value && x.retention)) void this.recall(q.subject.value, Number(q.object.value) || 50)
        continue
      }
      if (p === PER + 'enabled' || p === PER + 'request') {
        const policy = policies.find((x) => x.iri === q.subject.value)
        if (policy) void this.control(policy, delta)
        continue
      }
      for (const policy of policies) {
        if (!policy.enabled || this.dirty.has(policy.iri) || this.kept.has(policy.iri)) continue
        const covers = policy.graph
          ? graph === policy.graph
          : graph === undefined && (policy.subject ? q.subject.equals(policy.subject) && policy.watches.has(p) : policy.watches.has(p))
        if (covers) this.dirty.add(policy.iri)
      }
    }
    if (this.dirty.size) this.schedule()
  }

  private schedule() {
    if (this.timer || this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.opts.delayMs ?? 250)
  }

  /** A switch or a request on a policy: remember the switch, forget when asked or turned off. */
  private async control(policy: Policy, delta: Delta) {
    const f = this.store.factory
    const flags: Record<string, boolean> = {}
    for (const p of this.policies()) if (!p.dimension) flags[p.iri] = p.enabled
    await this.backend(PER + 'Device').set(this.key('enabled'), JSON.stringify(flags))
    if (this.stopped) return
    const forgetting = delta.add.some((q) => q.subject.value === policy.iri && q.predicate.value === PER + 'request' && q.object.value === 'forget')
    if (!policy.enabled || forgetting) {
      await this.removeStored(policy)
      if (this.stopped) return
      const k = this.kept.get(policy.iri)
      if (k) k.tick = -1
      this.record(PER + 'Forget', policy, 0)
      this.report(policy, 0)
      this.reportExpiry(policy)
    } else if (delta.add.some((q) => q.subject.value === policy.iri && q.predicate.value === PER + 'enabled')) {
      this.dirty.add(policy.iri)
      this.schedule()
    }
    if (forgetting) {
      const requests = this.store.match(f.namedNode(policy.iri), f.namedNode(PER + 'request'), null, f.defaultGraph())
      if (requests.length) this.runtime?.apply({ remove: requests, add: [] })
    }
  }

  /** Write every dirty policy now. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer), (this.timer = undefined)
    const dirty = [...this.dirty]
    this.dirty.clear()
    for (const policy of this.policies()) {
      // Stopped while a write was awaited: its store may be released.
      if (this.stopped) return
      if (!dirty.includes(policy.iri) || !policy.enabled) continue
      try {
        await this.write(policy)
      } catch (e) {
        // A failed write (a full storage: QuotaExceededError) loses nothing: what was stored before
        // stays, the policy stays dirty for the next change to retry, and the graph says it is unsaved.
        if (this.stopped) return
        this.dirty.add(policy.iri)
        console.warn(`semblance: could not remember ${policy.iri}; the earlier copy is kept`, e)
        this.unsaved(policy, true)
        continue
      }
      if (this.stopped) return
      this.unsaved(policy, false)
    }
  }

  /** Write one policy: a chunk of its change when it can be, else whole. Throws when storage refuses. */
  private async write(policy: Policy): Promise<void> {
    const k = this.kept.get(policy.iri)
    if (k && (await this.writeChange(policy, k))) return
    // The tick the triples are of: what changes after it is the next write's.
    const tick = this.runtime?.views.tickNo ?? -1
    const quads = k ? k.view.quads().filter((q) => !this.isSensitive(q.predicate)) : this.collect(policy)
    // The new base replaces the old in one write, before the old chunks go: a write that fails
    // leaves the earlier copy whole, and the chunks a new base no longer counts are never read.
    const b = this.backend(policy.scope)
    const before = this.storedChunks(await b.get(this.key(policy.iri)))
    const blob = this.blobOf(policy, quads)
    await this.set(policy, this.key(policy.iri), JSON.stringify(blob), quads.length)
    for (let i = 1; i <= before; i++) await b.remove(this.key(policy.iri) + '#' + i)
    if (this.stopped) return
    if (k) Object.assign(k, { tick, chunks: 0, chunkTriples: 0, baseTriples: quads.length })
    this.record(PER + 'Write', policy, quads.length)
    this.report(policy, quads.length)
    this.reportExpiry(policy)
  }

  /** per:unsaved on a policy (the persistence graph): its last write failed, what is stored is older. */
  private unsaved(policy: Policy, on: boolean) {
    const runtime = this.runtime
    if (!runtime) return
    const f = this.store.factory
    const p = f.namedNode(policy.iri)
    const g = f.namedNode(PERSIST_GRAPH)
    const remove = this.store.match(p, f.namedNode(PER + 'unsaved'), null, g)
    if (!on && !remove.length) return
    if (on && remove.length) return
    runtime.write(PERSIST_GRAPH, { remove, add: on ? [f.quad(p, f.namedNode(PER + 'unsaved'), f.literal('true', f.namedNode(XSD_BOOLEAN)))] : [] })
  }

  /**
   * A kept policy's change since its last write, as one more chunk; false when it cannot be (nothing
   * written yet, the view no longer reaches back, or the chunks outgrew the base: write it whole).
   */
  private async writeChange(policy: Policy, k: Kept): Promise<boolean> {
    if (k.tick < 0) return false
    const change = k.view.since(k.tick)
    if (!change) return false
    const add: Quad[] = []
    const remove: Quad[] = []
    for (const [, q, w] of change.quads.entries()) if (!this.isSensitive(q.predicate)) (w > 0 ? add : remove).push(q)
    const n = add.length + remove.length
    if (k.chunks >= 64 || k.chunkTriples + n > Math.max(16, k.baseTriples)) return false
    if (!n) return (k.tick = change.tick), true
    const raw = await this.backend(policy.scope).get(this.key(policy.iri))
    if (!raw) return false
    const blob = JSON.parse(raw) as Blob
    const was = { tick: k.tick, chunks: k.chunks, chunkTriples: k.chunkTriples }
    k.tick = change.tick
    const at = Date.now()
    try {
      // The chunk first, then the base that counts it: a failure of either leaves the base counting
      // only what was stored before, and the change is written again (from the same tick) next time.
      await this.set(policy, this.key(policy.iri) + '#' + (k.chunks + 1), JSON.stringify({ add: this.serialize(add), remove: this.serialize(remove), ...(policy.retention && { at }) } satisfies Chunk), n)
      await this.set(policy, this.key(policy.iri), JSON.stringify({ ...blob, savedAt: Date.now(), chunks: k.chunks + 1 } satisfies Blob), 0)
    } catch (e) {
      Object.assign(k, was)
      throw e
    }
    k.chunks++
    k.chunkTriples += n
    // What it adds is stored now; the oldest changes only when what it removes held it.
    let oldestGone = false
    const ages = policy.retention && this.ages.get(policy.iri)
    if (ages) {
      const oldest = this.horizons.get(policy.iri)?.oldest
      for (const q of remove) oldestGone ||= ages.get(quadKey(q)) === oldest, ages.delete(quadKey(q))
      for (const q of add) if (!ages.has(quadKey(q))) ages.set(quadKey(q), at)
    }
    // Stopped while the write was awaited: its store may be released.
    if (this.stopped) return true
    const size = k.view.quads().filter((q) => !this.isSensitive(q.predicate)).length
    this.record(PER + 'Write', policy, n)
    this.report(policy, size)
    if (policy.retention) {
      const h = this.horizonOf(policy)
      h.inMemory = size
      if (oldestGone || h.oldest === undefined) h.oldest = this.oldestOf(policy)
      this.reportExpiry(policy)
    }
    return true
  }

  private async set(policy: Policy, key: string, value: string, triples: number) {
    this.writes.entries++
    this.writes.triples += triples
    await this.backend(policy.scope).set(key, value)
  }

  /** Remove what a policy stored: the base and its chunks, and what its retention set aside. */
  private async removeStored(policy: Policy) {
    const b = this.backend(policy.scope)
    const chunks = this.storedChunks(await b.get(this.key(policy.iri)))
    for (let i = 1; i <= chunks; i++) await b.remove(this.key(policy.iri) + '#' + i)
    await b.remove(this.key(policy.iri))
    if (!policy.retention) return
    await b.remove(this.asideKey(policy))
    this.ages.delete(policy.iri)
    const h = this.horizons.get(policy.iri)
    if (h) Object.assign(h, { inMemory: 0, aside: 0, oldest: undefined })
  }

  /**
   * A base blob of `quads`. A policy with a retention stores them oldest first, with when each was
   * stored: what it held already keeps its age, what is new is stored now.
   */
  private blobOf(policy: Policy, quads: Quad[]): Blob {
    const now = Date.now()
    if (!policy.retention) return { version: policy.version, savedAt: now, nt: this.serialize(quads) }
    const was = this.ages.get(policy.iri)
    const aged = quads.map((q) => ({ q, k: quadKey(q), at: was?.get(quadKey(q)) ?? now })).sort((a, b) => a.at - b.at)
    this.ages.set(policy.iri, new Map(aged.map((x) => [x.k, x.at])))
    const h = this.horizonOf(policy)
    h.inMemory = aged.length
    h.oldest = aged[0]?.at
    return { version: policy.version, savedAt: now, nt: this.serialize(aged.map((x) => x.q)), ages: runs(aged.map((x) => x.at)) }
  }

  /** How many chunks a stored base counts (0 for none, or one that does not parse). */
  private storedChunks(raw: string | undefined): number {
    try {
      return raw ? ((JSON.parse(raw) as Blob).chunks ?? 0) : 0
    } catch {
      return 0
    }
  }

  private isSensitive(p: Term): boolean {
    return this.store.match(p, this.store.factory.namedNode(PER + 'sensitive'), null).some((q) => q.object.value === 'true')
  }

  /** The triples a policy covers right now (sensitive properties left out). */
  collect(policy: Policy): Quad[] {
    const s = this.store
    const f = s.factory
    const sensitive = (p: Term) => s.match(p, f.namedNode(PER + 'sensitive'), null).some((q) => q.object.value === 'true')
    let quads: Quad[] = []
    if (policy.subject) {
      for (const p of policy.properties) quads.push(...s.match(policy.subject, f.namedNode(p), null, f.defaultGraph()))
    } else if (policy.construct && s.sparql) {
      const graphs = [f.defaultGraph(), f.namedNode(EVENTS_GRAPH), ...(this.runtime?.projections.map((p) => p.engine.graph) ?? [])]
      if (policy.graph) graphs.push(f.namedNode(policy.graph))
      quads = s.construct(prefixesFor(this.declared) + '\n' + policy.construct, graphs)
    }
    return quads.filter((q) => !sensitive(q.predicate))
  }

  private serialize(quads: Quad[]): string {
    const w = new Writer({ format: 'N-Triples' })
    for (const q of quads) w.addQuad(q.subject as never, q.predicate as never, q.object as never)
    let out = ''
    w.end((_e, r) => (out = r ?? ""))
    return out
  }

  private parse(nt: string): Quad[] {
    const f = this.store.factory
    const term = (t: Term): Term =>
      t.termType === 'NamedNode' ? f.namedNode(t.value) : t.termType === 'Literal' ? f.literal(t.value, t.language || f.namedNode(t.datatype.value)) : t
    return new Parser({ format: 'N-Triples' }).parse(nt).map((q) => f.quad(term(q.subject as Term), term(q.predicate as Term), term(q.object as Term)))
  }

  /** A member of per:StateLog (bounded to 100). */
  private record(kind: string, policy: Policy, size: number) {
    const runtime = this.runtime
    if (!runtime) return
    const f = this.store.factory
    const nn = (x: string) => f.namedNode(x)
    const m = nn(`urn:semblance:state:${Date.now().toString(36)}-${++this.seq}`)
    const stream = nn(PER + 'StateLog')
    const add = [
      f.quad(m, nn(RDF_TYPE), nn(kind)),
      f.quad(m, nn(PER + 'policy'), nn(policy.iri)),
      f.quad(m, nn(PER + 'scope'), nn(policy.scope)),
      f.quad(m, nn(PER + 'size'), f.literal(String(size), nn(XSD_INTEGER))),
      f.quad(m, nn(PROV + 'generatedAtTime'), f.literal(new Date().toISOString(), nn(XSD_DATETIME))),
      f.quad(stream, nn(TREE_MEMBER), m),
    ]
    // Which interaction led to it: the newest member of the change log.
    const cause = this.store.match(nn(BEH.ChangeLog), nn(BEH.latest), null)[0]?.object
    if (cause && kind === PER + 'Write') add.push(f.quad(m, nn(PROV + 'wasInformedBy'), cause))
    // Bounded by its policies in the graph (per:StateLogView), as every retained stream is (docs/RETENTION.md).
    const log = logStream(runtime.retention, PER + 'StateLog', PERSIST_GRAPH, (d) => runtime.write(PERSIST_GRAPH, d))
    const remove = log.append({ iri: m.value, seq: this.seq, at: Date.now() })
    runtime.write(PERSIST_GRAPH, { add, remove })
  }

  /** The policy's current size and last write, for c:PolicyList. */
  private report(policy: Policy, size?: number) {
    const runtime = this.runtime
    if (!runtime) return
    const f = this.store.factory
    const nn = (x: string) => f.namedNode(x)
    const p = nn(policy.iri)
    const g = nn(PERSIST_GRAPH)
    const remove = [PER + 'storedSize', PER + 'lastWritten', PER + 'restored'].flatMap((x) => this.store.match(p, nn(x), null, g))
    const add: Quad[] = []
    if (size !== undefined) {
      add.push(f.quad(p, nn(PER + 'storedSize'), f.literal(String(size), nn(XSD_INTEGER))))
      if (size > 0) add.push(f.quad(p, nn(PER + 'lastWritten'), f.literal(new Date().toISOString(), nn(XSD_DATETIME))))
    }
    const restored = this.restoredCounts.get(policy.iri)
    if (restored !== undefined) add.push(f.quad(p, nn(PER + 'restored'), f.literal(String(restored), nn(XSD_INTEGER))))
    if (!add.length && !remove.length) return
    runtime.write(PERSIST_GRAPH, { remove, add })
  }
}

// --- c:PolicyList ------------------------------------------------------------------------------

const DATED = new Set([NS.xsd + 'dateTime', NS.xsd + 'dateTimeStamp', NS.xsd + 'date'])

/** A phrase's first `code` replaced by `value`, as the SPARQL rule's STRBEFORE / STRAFTER do. */
const fill = (phrase: string, code: string, value: string) => {
  const i = phrase.indexOf(code)
  return i < 0 ? phrase : phrase.slice(0, i) + value + phrase.slice(i + code.length)
}

/**
 * Every policy, in the viewer's collation of their labels (an order key from sx:sortKey; a row is keyed
 * by its policy), its size and last write as sx:formatNumber and sx:formatDateTime write them in the
 * viewer's locale, its status in the viewer's language: as c:PolicyListRendering-sparql does.
 */
const policyList: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  ctx.readsLanguage()
  const lang = formatLocale(ctx.languages)
  const policies = ctx
    .match(null, RDF_TYPE, PER + 'Policy')
    .map((q) => q.subject)
    .filter(named)
    .map((p) => {
      const label = labelOf(ctx, p)
      return { p, label, on: ctx.object(p, PER + 'enabled')?.value !== 'false', k: 'p-' + md5Key(p.value), order: TUPLE + 's' + sortKey(label, lang) }
    })
  if (ctx.modality === MOD.Text) {
    const root = o.el('root', 'Div')
    for (const { label, on, k, order } of policies) {
      const line = o.text(k + '-line', `[${on ? 'x' : ' '}] ${label}\n`)
      o.t(line, SEM.orderKey, order).t(root, H.hasChild, line)
    }
    o.renders(root)
    return o.quads
  }
  const phrase = (name: string) => text(ctx, ctx.nn(PER + name), RDFS_LABEL) ?? ''
  const rows = policies.map(({ p, label, on, k, order }) => {
    const scope = ctx.object(p, PER + 'scope')
    const size = Number(str(ctx.object(p, PER + 'storedSize')) ?? 0)
    const restored = str(ctx.object(p, PER + 'restored'))
    const when = ctx.object(p, PER + 'lastWritten')
    const at = when?.termType === 'Literal' && DATED.has(when.datatype.value) ? dateOf(when.value) : undefined
    const time = at && !Number.isNaN(at.getTime()) ? formatDateTime(at, lang, 'hour=2-digit;minute=2-digit;second=2-digit;hour12=false', ctx.timeZone) : when?.value
    const toggle = o.el(k + '-switch', 'Button', { type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': label }, [o.el(k + '-thumb', 'Span', { 'aria-hidden': 'true' })])
    o.t(toggle, PER + 'toggles', p)
    const forget = o.el(k + '-forget', 'Button', { type: 'button', class: 'sem-forget', disabled: size > 0 ? undefined : '' }, [o.text(k + '-forget-text', '⌫')])
    o.attr(forget, 'aria-label', fill(phrase('ForgetPhrase'), '{label}', label))
    o.t(forget, PER + 'forgets', p)
    const status = [
      scope ? labelOf(ctx, scope) : '',
      on ? (size ? fill(phrase('StoredPhrase'), '{n}', formatNumber(size, lang)) : phrase('NothingStoredPhrase')) : phrase('OffPhrase'),
      restored ? fill(phrase('RestoredPhrase'), '{n}', formatNumber(numberOf(restored), lang)) : '',
      time ? fill(phrase('SavedPhrase'), '{time}', time) : '',
    ].filter(Boolean)
    const row = o.el(k, 'Li', {}, [
      toggle,
      o.el(k + '-what', 'Div', { class: 'sem-what' }, [
        o.el(k + '-label', 'Strong', {}, [o.text(k + '-label-text', label)]),
        o.el(k + '-status', 'Span', {}, [o.text(k + '-status-text', status.join(' · '))]),
      ]),
      forget,
    ])
    o.t(row, SEM.orderKey, order)
    return row
  })
  const root = o.el('root', 'Ul', { 'aria-label': labelOf(ctx, ctx.nn(PER + 'Policy')) })
  for (const row of rows) o.t(root, H.hasChild, row)
  o.renders(root)
  return o.quads
}

/** The policy a click hit, through the marker on the rendered element. */
function hitPolicy(ctx: Parameters<ReactionFn>[0], marker: string): Term | undefined {
  for (let n = ctx.object(ctx.event, BEH.node), hops = 0; n && hops < 32; hops++, n = ctx.match(null, NS.rdfhtml + 'hasChild', n)[0]?.subject) {
    const p = ctx.object(n, marker)
    if (p) return p
  }
  return undefined
}

const togglePolicy: ReactionFn = (ctx) => {
  const p = hitPolicy(ctx, PER + 'toggles')
  if (!p) return { add: [], remove: [] }
  const f = ctx.runtime.store.factory
  const current = ctx.match(p, PER + 'enabled', null)
  const on = !current.some((q) => q.object.value === 'false')
  return { remove: current, add: [f.quad(p as never, f.namedNode(PER + 'enabled'), f.literal(String(!on), f.namedNode(XSD_BOOLEAN)))] }
}

const forgetPolicy: ReactionFn = (ctx) => {
  const p = hitPolicy(ctx, PER + 'forgets')
  if (!p) return { add: [], remove: [] }
  const f = ctx.runtime.store.factory
  return { remove: [], add: [f.quad(p as never, f.namedNode(PER + 'request'), f.literal('forget'))] }
}

/** A chooser bound to a remembered, hooked property says so on its root (per:RememberedChooser). */
const rememberedChooser: FnRule = (ctx, focus) => {
  const subject = ctx.object(focus, NS.c + 'controls')
  const property = ctx.object(focus, NS.c + 'property')
  if (!subject || !property || !ctx.object(property, STY.hookAttribute)) return []
  const covers = ctx.match(null, PER + 'subject', subject).some((q) => isPolicy(ctx, q.subject) && inList(ctx, ctx.object(q.subject, PER + 'properties'), property.value))
  if (!covers) return []
  const o = ctx.out(focus)
  o.attr(o.node('root'), 'data-sem-remembered', subject.value + ' ' + property.value, 'root-remembered')
  return o.quads
}
const isPolicy = (ctx: Parameters<FnRule>[0], node: Term) => ctx.match(node, RDF_TYPE, PER + 'Policy').length > 0
const inList = (ctx: Parameters<FnRule>[0], head: Term | undefined, value: string): boolean => {
  for (let n = head; n && n.value !== NS.rdf + 'nil'; n = ctx.object(n, NS.rdf + 'rest')) if (ctx.object(n, NS.rdf + 'first')?.value === value) return true
  return false
}

export const persistenceFunctions: Record<string, FnRule> = { 'policy-list': policyList, 'persistence:remembered-chooser': rememberedChooser }
export const persistenceReactions: Record<string, ReactionFn> = { 'persistence:toggle': togglePolicy, 'persistence:forget': forgetPolicy }
