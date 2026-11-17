// Retained streams: their policies, their horizons, and offloading to the browser's storage
// (docs/RETENTION.md). The effect that appends to a stream (the event bus, the persistence and sync
// logs, the stall log, network capture) asks its RetainedStream what retires with each append and
// removes it in the same write. What leaves by ret:Offload is taken at once (its triples, as terms)
// and written to storage in chunks, each one Jelly stream (./chunk.ts), off the interaction; until
// a write succeeds it is held (ret:pending), so a refused write loses nothing. A recall reads chunks
// back, newest first, and the stream puts their members back into the live graph. A member that
// leaves takes with it the statements elsewhere that point at it (ret:Reference): those of its
// stream's graph go to storage with it and come back with it, the others go for good.
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import { NS, RETENTION_GRAPH } from '../ns.ts'
import type { Delta } from '../rdf.ts'
import { applyEffective } from '../view/input.ts'
import type { Backend } from '../persistence.ts'
import type { GraphStore } from '../store/types.ts'
import { decodeChunk, encodeChunk, loadChunk, storeChunk } from './chunk.ts'
import { type Expiry, type Member, type Policy, policiesOf, StreamRetention } from './policy.ts'

const RET = NS.ret
const RDF_TYPE = NS.rdf + 'type'
const XSD = NS.xsd

/** Storage for offloaded history; `keys` lets a new page sweep what earlier pages left. */
export interface OffloadBackend extends Backend {
  keys?(prefix: string): Promise<string[]>
}

/** What a stream's owner tells retention about it. */
export interface StreamHost {
  /** The stream's members' graph. */
  graph: string
  /** A member's triples (with what is minted under it), as they leave the graph. */
  closure(member: NamedNode): Quad[]
  /** Write a change to the stream's graph (for a recall: the members coming back). */
  write(delta: Delta): void
  /** Members that may leave memory before any other (undone changes, whose redo is the least needed). */
  leaveFirst?(): Iterable<string>
  /** What of a member's closure goes to storage (all of it unless told otherwise). */
  storable?(member: NamedNode, closure: Quad[]): Quad[]
  /** Raise a horizon event (ret:Offloaded, ret:Dropped) on the stream, once per session. */
  crossed?(kind: 'offloaded' | 'dropped'): void
}

interface Chunk {
  key: string
  policy: string
  first: number
  count: number
}

/** Members waiting for storage, with what of their closures is stored, by policy. */
interface Pending {
  policy: Policy
  members: Member[]
  closures: Quad[][]
}

export interface RetentionOptions {
  /** Where offloaded members go (IndexedDB in a browser); without one, ret:Offload drops (and says so). */
  backend?: OffloadBackend
  /** This page's run: offloaded chunks of other runs are swept at start. */
  run?: string
  /** What stored keys start with. */
  prefix?: string
  /** Members per stored chunk. */
  chunk?: number
  /** Schedule a flush (a test runs it at once). */
  schedule?: (flush: () => void) => void
  /** Hear about a write storage refused (a quota). */
  onRefused?: (e: Error) => void
  /** Storage keeps refusing and history waits in memory past its bound: 'keep' it there, or let the oldest go. */
  onStorage?: (stream: string, waiting: number) => 'keep' | 'drop' | Promise<'keep' | 'drop'>
  /** The clock (ms). */
  now?: () => number
}

let created: ((r: Retention) => void) | undefined
/**
 * Hear about every Retention made (one listener; undefined stops): test/setup.ts stops each test's
 * before releasing its stores, so no write to storage or horizon outlives them.
 */
export function watchRetention(listener: ((r: Retention) => void) | undefined): void {
  created = listener
}

/** Every retained stream of a store. */
export class Retention {
  private readonly streams = new Map<string, RetainedStream>()
  readonly prefix: string
  readonly run: string
  private swept?: Promise<void>
  /** Its runtime ended: nothing more is written, to storage or to the graph. */
  stopped = false

  constructor(
    readonly store: GraphStore,
    /** Write a change to the retention graph (the horizons). */
    readonly report: (delta: Delta) => void,
    readonly opts: RetentionOptions = {},
    /**
     * Write a change to any graph (undefined: the default graph): references to a leaving member in
     * other graphs than its stream's leave this way (a runtime's write and apply).
     */
    readonly write: (graph: string | undefined, delta: Delta) => void = (graph, delta) => void applyEffective(store, graph, delta),
  ) {
    this.prefix = opts.prefix ?? 'semblance:ret:'
    this.run = opts.run ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    created?.(this)
  }

  get backend(): OffloadBackend | undefined {
    return this.storage ?? this.opts.backend
  }

  private storage?: OffloadBackend
  /** Offload to this storage from now on (a host gives IndexedDB once it has it), and sweep earlier pages' keys. */
  use(backend: OffloadBackend): Promise<void> {
    this.storage = backend
    this.swept = undefined
    return this.sweep()
  }

  now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** The retained stream of `iri`, made on first use. */
  stream(iri: string, host: StreamHost): RetainedStream {
    let s = this.streams.get(iri)
    if (!s) this.streams.set(iri, (s = new RetainedStream(this, iri, host)))
    return s
  }

  /**
   * The properties whose statements leave with the member they point at (ret:Reference), read from
   * the graph, so an app's own marks apply at once.
   */
  references(): NamedNode[] {
    const f = this.store.factory
    const seen = new Set<string>()
    const out: NamedNode[] = []
    for (const q of this.store.match(null, f.namedNode(RDF_TYPE), f.namedNode(RET + 'Reference')))
      if (q.subject.termType === 'NamedNode' && !seen.has(q.subject.value)) seen.add(q.subject.value), out.push(q.subject)
    return out
  }

  get(iri: string): RetainedStream | undefined {
    return this.streams.get(iri)
  }

  all(): RetainedStream[] {
    return [...this.streams.values()]
  }

  /** Remove what earlier pages offloaded (their runs' keys): history goes with the page that kept it. */
  sweep(): Promise<void> {
    const b = this.backend
    if (!b?.keys) return Promise.resolve()
    return (this.swept ??= b
      .keys(this.prefix)
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(this.prefix + this.run + '|')).map((k) => b.remove(k))))
      .then(() => undefined)
      .catch(() => undefined))
  }

  stop(): void {
    this.stopped = true
  }

  /** Write every stream's pending members now. */
  async flush(): Promise<void> {
    await Promise.all(this.all().map((s) => s.flush()))
  }

  /** Members and their closures as a stored chunk (a Jelly stream). */
  encode(members: Member[], closures: Quad[][]): Uint8Array {
    return encodeChunk(members, closures, this.store.factory)
  }

  /** A stored chunk (a Jelly stream, or the earlier N-Triples layout) back as members and their triples in `graph`. */
  decode(value: Uint8Array | string, graph: string): { members: Member[]; quads: Quad[] } {
    const f = this.store.factory
    return decodeChunk(value, f.namedNode(graph), f)
  }
}

/**
 * A log whose members are single nodes in one graph (the state, sync and stall logs): retained by its
 * policies in the graph, each member leaving with its triples and its tree:member link.
 */
export function logStream(retention: Retention, stream: string, graph: string, write: (d: Delta) => void): RetainedStream {
  const store = retention.store
  const f = store.factory
  const g = f.namedNode(graph)
  return retention.stream(stream, {
    graph,
    closure: (m) => [...store.match(f.namedNode(stream), f.namedNode(NS.tree + 'member'), m, g), ...store.match(m, null, null, g)],
    write,
  })
}

/** One retained stream: its queues, what it offloaded, and its horizon. */
export class RetainedStream {
  readonly retention: StreamRetention
  private readonly chunks: Chunk[] = []
  private readonly pending = new Map<string, Pending>()
  private offloaded = 0
  private dropped = 0
  private refused?: string
  private announced = new Set<string>()
  private flushing?: Promise<void>
  private scheduled = false
  /** The horizon as last written, to write only what changed. */
  private written = new Map<string, string>()

  constructor(
    readonly owner: Retention,
    readonly iri: string,
    readonly host: StreamHost,
  ) {
    const store = owner.store
    const f = store.factory
    const g = f.namedNode(host.graph)
    this.retention = new StreamRetention(
      () => this.policies(),
      (member, property) => store.match(f.namedNode(member), f.namedNode(property), null, g).length > 0,
      () => {
        const limit = store.match(f.namedNode(iri), f.namedNode(RET + 'recallLimit'), null)[0]
        return limit ? Number(limit.object.value) : 1000
      },
      () => host.leaveFirst?.() ?? [],
      // A ret:UntilAcknowledged policy holds back the events whose reaction names it (ann:retention:
      // an announcement that waits for a person) until one says it was seen (ret:acknowledged true).
      (member, policy) => {
        const m = f.namedNode(member)
        if (store.match(m, f.namedNode(RET + 'acknowledged'), null).some((q) => q.object.value === 'true')) return false
        const said = f.namedNode(NS.ann + 'retention')
        const p = f.namedNode(policy.iri)
        return store.match(m, f.namedNode(NS.beh + 'handledBy'), null, g).some((q) => store.match(q.object as NamedNode, said, p).length > 0)
      },
    )
  }

  /** The stream's policies, read from the graph (so a change there applies at the next append). */
  policies(): Policy[] {
    return policiesOf(this.owner.store, this.owner.store.factory.namedNode(this.iri))
  }

  get horizon(): NamedNode {
    return this.owner.store.factory.namedNode(this.iri + '/~horizon')
  }

  /**
   * A member was appended: the quads that leave the stream's graph with it (members no policy keeps
   * any more, with their closures), for the caller to remove in the same write.
   */
  append(member: Member, now = this.owner.now()): Quad[] {
    return this.leave(this.retention.append(member, now))
  }

  /** Members restored with the stream (a remembered log, or the graph as found). */
  load(members: Member[], now = this.owner.now()): Quad[] {
    return this.leave(this.retention.load(members, now))
  }

  /**
   * Members leave: their closures, and the statements that point at them through a ret:Reference
   * property (found by the store's match on each, so it costs what refers to them). Those in the
   * stream's graph go in the caller's write, and with an offloaded member into storage; those in
   * other graphs are written away here, once what is stored was taken.
   */
  private leave(expired: Expiry[]): Quad[] {
    if (!expired.length) {
      this.report()
      return []
    }
    const store = this.owner.store
    const f = store.factory
    const g = this.host.graph
    const references = this.owner.references()
    const leaving = new Set(expired.map((e) => e.member.iri))
    const elsewhere = new Map<string | undefined, Quad[]>()
    const out: Quad[] = []
    for (const { member, policy } of expired) {
      const m = f.namedNode(member.iri)
      const closure = this.host.closure(m)
      out.push(...closure)
      const inbound: Quad[] = []
      for (const p of references)
        for (const q of store.match(null, p, m, null)) {
          const here = q.graph.termType === 'NamedNode' && q.graph.value === g
          // On a member leaving with it, it is that member's own, in its closure.
          if (here && leaving.has(q.subject.value)) continue
          if (here) {
            inbound.push(q)
            continue
          }
          const graph = q.graph.termType === 'DefaultGraph' ? undefined : q.graph.value
          let qs = elsewhere.get(graph)
          if (!qs) elsewhere.set(graph, (qs = []))
          qs.push(q)
        }
      out.push(...inbound)
      if (policy?.exit === 'offload' && this.owner.backend) {
        let p = this.pending.get(policy.iri)
        if (!p) this.pending.set(policy.iri, (p = { policy, members: [], closures: [] }))
        p.members.push(member)
        p.closures.push([...(this.host.storable ? this.host.storable(m, closure) : closure), ...inbound])
        if (policy.announce) this.cross('offloaded')
      } else {
        this.dropped++
        if (policy?.announce) this.cross('dropped')
      }
    }
    for (const [graph, quads] of elsewhere) this.owner.write(graph, { add: [], remove: quads })
    this.schedule()
    this.report()
    return out
  }

  private cross(kind: 'offloaded' | 'dropped') {
    if (this.announced.has(kind)) return
    this.announced.add(kind)
    // After the tick that retired them, not inside it.
    queueMicrotask(() => {
      if (!this.owner.stopped) this.host.crossed?.(kind)
    })
  }

  private schedule() {
    if (this.scheduled || !this.pending.size) return
    this.scheduled = true
    const run = () => {
      this.scheduled = false
      void this.flush()
    }
    if (this.owner.opts.schedule) this.owner.opts.schedule(run)
    else setTimeout(run, 0)
  }

  /** Write what is pending to storage, a chunk at a time. A refused write keeps it pending. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing.then(() => (this.pending.size ? this.flush() : undefined))
    const b = this.owner.backend
    if (!b || !this.pending.size || this.owner.stopped) return Promise.resolve()
    const size = this.owner.opts.chunk ?? 64
    const work = async () => {
      for (const [iri, p] of [...this.pending]) {
        while (p.members.length) {
          const members = p.members.slice(0, size)
          const key = `${this.owner.prefix}${this.owner.run}|${this.iri}|${iri}|${String(members[0]!.seq).padStart(12, '0')}`
          if (this.owner.stopped) return
          try {
            await storeChunk(b, key, this.owner.encode(members, p.closures.slice(0, size)))
          } catch (e) {
            this.refused = e instanceof Error ? e.message : String(e)
            this.owner.opts.onRefused?.(e instanceof Error ? e : new Error(String(e)))
            await this.overflow()
            this.report()
            return
          }
          this.refused = undefined
          p.members.splice(0, members.length)
          p.closures.splice(0, members.length)
          // In the stream's order, whenever it was written (what memory pressure sends back is older
          // than what left since), so a recall finds the most recent and a trim the oldest.
          const chunk = { key, policy: iri, first: Math.min(...members.map((m) => m.seq)), count: members.length }
          const at = this.chunks.findIndex((c) => c.first > chunk.first)
          this.chunks.splice(at < 0 ? this.chunks.length : at, 0, chunk)
          this.offloaded += members.length
          await this.trim(p.policy)
        }
        this.pending.delete(iri)
      }
      this.report()
    }
    this.flushing = work().finally(() => (this.flushing = undefined))
    return this.flushing
  }

  /**
   * Storage refused, and more waits in memory than twice what the policies keep: the host is asked
   * (onStorage, mount's onRetention); unless it says to keep it, the oldest of what waits beyond that
   * is dropped, counted and announced.
   */
  private async overflow() {
    let waiting = 0
    for (const p of this.pending.values()) waiting += p.members.length
    const cap = 2 * Math.max(64, ...this.policies().map((p) => p.amount ?? 0))
    if (waiting <= cap) return
    const keep = (await this.owner.opts.onStorage?.(this.iri, waiting)) === 'keep'
    if (keep || this.owner.stopped) return
    for (const p of this.pending.values()) {
      const over = Math.min(p.members.length, waiting - cap)
      if (over <= 0) continue
      p.members.splice(0, over)
      p.closures.splice(0, over)
      waiting -= over
      this.dropped += over
      if (p.policy.announce) this.cross('dropped')
    }
  }

  /** Past the policy's ret:storageAmount, the oldest chunks go (and are counted as dropped). */
  private async trim(policy: Policy) {
    if (policy.storageAmount === undefined) return
    const b = this.owner.backend!
    let held = this.chunks.filter((c) => c.policy === policy.iri).reduce((n, c) => n + c.count, 0)
    while (held > policy.storageAmount) {
      const i = this.chunks.findIndex((c) => c.policy === policy.iri)
      if (i < 0) break
      const [c] = this.chunks.splice(i, 1)
      await b.remove(c!.key).catch(() => undefined)
      held -= c!.count
      this.offloaded -= c!.count
      this.dropped += c!.count
      if (policy.announce) this.cross('dropped')
    }
  }

  /**
   * Memory pressure: what was recalled goes back to storage, and the oldest `share` of what ret:having
   * policies keep (0: none). Removed from the graph now; written to storage as any offload is.
   */
  relieve(share: number): void {
    const leaving = this.leave([...this.retention.releaseRecalled(), ...(share > 0 ? this.retention.shrink(share) : [])].sort((a, b) => a.member.seq - b.member.seq))
    if (leaving.length) this.host.write({ add: [], remove: leaving })
  }

  /** Offloaded members, by policy (all when not given), in storage now. */
  stored(policy?: string): number {
    return this.chunks.filter((c) => !policy || c.policy === policy).reduce((n, c) => n + c.count, 0)
  }

  /**
   * Bring back at least `n` of the most recent offloaded members (of one policy, or any), into the
   * live graph. Returns how many came back. What no longer fits beside them goes back to storage.
   * One recall at a time: two at once (Undo pressed again before the first came back) would pick
   * the same chunks and bring their members back twice.
   */
  recall(n: number, policy?: string): Promise<number> {
    const run = (this.recalling ?? Promise.resolve()).then(() => this.recallNow(n, policy))
    this.recalling = run.catch(() => undefined)
    return run
  }

  private recalling?: Promise<unknown>

  private async recallNow(n: number, policy?: string): Promise<number> {
    await this.flush()
    const b = this.owner.backend
    if (!b) return 0
    const picked: Chunk[] = []
    let count = 0
    for (let i = this.chunks.length - 1; i >= 0 && count < n; i--) {
      const c = this.chunks[i]!
      if (policy && c.policy !== policy) continue
      picked.push(c)
      count += c.count
    }
    if (!picked.length) return 0
    // Newest first in storage order: recall them oldest first, as they were appended.
    picked.sort((a, b) => a.first - b.first)
    const policies = new Map(this.policies().map((p) => [p.iri, p]))
    // References come back once every chunk is in, where both ends are members in memory then.
    const references = new Set(this.owner.references().map((p) => p.value))
    const referring: Quad[] = []
    let back = 0
    for (const c of picked) {
      const raw = await loadChunk(b, c.key).catch(() => undefined)
      if (this.owner.stopped) return back
      this.chunks.splice(this.chunks.indexOf(c), 1)
      this.offloaded -= c.count
      let stored: { members: Member[]; quads: Quad[] } | undefined
      try {
        stored = raw === undefined ? undefined : this.owner.decode(raw, this.host.graph)
      } catch {
        // Unreadable: counted as dropped, as a chunk storage lost is.
      }
      if (!stored || stored.members.length !== c.count) {
        this.dropped += c.count
        await b.remove(c.key).catch(() => undefined)
        continue
      }
      // Its key goes before its members come back: one that leaves again at once is written under
      // the same key (its first member's), and must not be removed with this chunk.
      await b.remove(c.key).catch(() => undefined)
      if (this.owner.stopped) return back
      const quads = stored.quads.filter((q) => !references.has(q.predicate.value) || (referring.push(q), false))
      const f = this.owner.store.factory
      const g = f.namedNode(this.host.graph)
      const links = stored.members.map((m) => f.quad(f.namedNode(this.iri), f.namedNode(NS.tree + 'member'), f.namedNode(m.iri), g))
      // Recalled members beyond the limit leave again (back to storage), in the same write.
      const leaving = this.leave(this.retention.recall(stored.members, policies.get(c.policy)))
      this.host.write({ add: [...quads, ...links], remove: leaving })
      back += c.count
    }
    if (referring.length && !this.owner.stopped) {
      const store = this.owner.store
      const member = store.factory.namedNode(NS.tree + 'member')
      const present = (t: Term) => t.termType === 'NamedNode' && store.match(null, member, t).length > 0
      const restored = referring.filter((q) => present(q.subject) && present(q.object))
      if (restored.length) this.host.write({ add: restored, remove: [] })
    }
    this.report()
    return back
  }

  /** The horizon's figures. */
  figures() {
    let pending = 0
    for (const p of this.pending.values()) pending += p.members.length
    return { inMemory: this.retention.size, offloaded: this.offloaded, pending, recalled: this.retention.recalled().length, dropped: this.dropped, refused: this.refused, oldest: this.retention.oldest() }
  }

  /** Write the horizon into the retention graph, what changed only. */
  report() {
    if (this.owner.stopped) return
    const f = this.owner.store.factory
    const nn = (iri: string) => f.namedNode(iri)
    const h = this.horizon
    const x = this.figures()
    const int = (n: number) => f.literal(String(n), nn(XSD + 'integer'))
    const want = new Map<string, Term>([
      [RDF_TYPE, nn(RET + 'Horizon')],
      [RET + 'of', nn(this.iri)],
      [RET + 'inMemory', int(x.inMemory)],
      [RET + 'offloaded', int(x.offloaded)],
      [RET + 'pending', int(x.pending)],
      [RET + 'recalled', int(x.recalled)],
      [RET + 'dropped', int(x.dropped)],
    ])
    if (x.oldest?.at) want.set(RET + 'oldestKept', f.literal(new Date(x.oldest.at).toISOString(), nn(XSD + 'dateTime')))
    if (x.refused) want.set(RET + 'refused', f.literal(x.refused))
    const add: Quad[] = []
    const remove: Quad[] = []
    const g = nn(RETENTION_GRAPH)
    for (const [p, o] of want) {
      const key = o.termType + ':' + o.value
      const was = this.written.get(p)
      if (was === key) continue
      if (was !== undefined) remove.push(...this.owner.store.match(h, nn(p), null, g))
      add.push(f.quad(h, nn(p), o as NamedNode))
      this.written.set(p, key)
    }
    for (const p of [...this.written.keys()]) {
      if (want.has(p)) continue
      remove.push(...this.owner.store.match(h, nn(p), null, g))
      this.written.delete(p)
    }
    if (add.length || remove.length) this.owner.report({ add, remove })
  }
}
