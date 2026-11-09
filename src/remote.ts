// Remote sources (ontology/layers/source.ttl, docs/REMOTE.md): a host effect that binds the
// graph's src:Source nodes to stores elsewhere. For each source it loads the part of the store
// its patterns cover, follows the store's changes - each applied as one input change, so the
// engine's cost is what changed - and, for a writable source, sends the page's changes to its
// statements back as writes, one at a time, in order. A refused write is repaired with what the
// store holds. The graph never names an endpoint: the host maps each source to one.
//
// What the effect knows is graph data in urn:semblance:sources (src:state, src:cursor,
// src:pending, src:attempts, src:lastError) and members of src:SyncLog; what a page should do
// about it is reactions to src:WentLive, src:Lost and src:WriteRefused, targeted at the source.
import type { Quad, Term } from '@rdfjs/types'
import type { EventBus } from './behaviour/events.ts'
import { BEH, NS, RDF_TYPE, SOURCES_GRAPH, XSD_INTEGER } from './ns.ts'
import { type Delta, quadKey } from './rdf.ts'
import type { Runtime } from './runtime.ts'
import { concerns, type DeltaMessage, fromNTriples, type Pattern, serverSentEvents, type Snapshot, toNTriples, type WriteRequest, type WriteResult } from './source-protocol.ts'

const SRC = NS.src
const PROV = NS.prov
const ST_BUSY = NS.st + 'busy'
const XSD_BOOLEAN = NS.xsd + 'boolean'
const XSD_DATETIME = NS.xsd + 'dateTime'

/** Where a source's store is, as the host decides: never read from the graph. */
export interface Endpoint {
  /** The protocol's base: `{url}/changes`, `{url}/writes`. */
  url: string
  /** Sent with every request (credentials). */
  headers?: Record<string, string>
  fetch?: typeof fetch
}

/** How the effect talks to a store: the protocol over HTTP (httpTransport), or anything that behaves the same. */
export interface SourceTransport {
  /** Deliver the stream's messages until it ends (resolve) or breaks (reject). */
  follow(patterns: Pattern[], after: number | undefined, on: (event: string, data: unknown) => void, signal: AbortSignal): Promise<void>
  /** A write's answer; rejects when the store cannot be reached. */
  write(req: WriteRequest, signal: AbortSignal): Promise<WriteResult>
}

/** The protocol of docs/REMOTE.md over HTTP: server-sent events read with fetch (so headers go too), JSON writes. */
export function httpTransport(endpoint: Endpoint): SourceTransport {
  const base = endpoint.url.endsWith('/') ? endpoint.url : endpoint.url + '/'
  const go = (url: string, init: RequestInit) => (endpoint.fetch ?? globalThis.fetch)(url, init)
  return {
    async follow(patterns, after, on, signal) {
      const url = `${base}changes?patterns=${encodeURIComponent(JSON.stringify(patterns))}${after === undefined ? '' : `&after=${after}`}`
      const res = await go(url, { headers: { accept: 'text/event-stream', ...endpoint.headers }, signal })
      if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`)
      for await (const { event, data } of serverSentEvents(res.body)) on(event, JSON.parse(data))
    },
    async write(req, signal) {
      const res = await go(`${base}writes`, { method: 'POST', headers: { 'content-type': 'application/json', ...endpoint.headers }, body: JSON.stringify(req), signal })
      if (res.status !== 200 && res.status !== 409) throw new Error(`${res.status} ${res.statusText}`)
      return (await res.json()) as WriteResult
    },
  }
}

export interface RemoteSourcesOptions {
  /** Each source's store, by the source's IRI. A source without one stays src:Unbound. */
  endpoints: Record<string, Endpoint | SourceTransport>
  /** Where src:WentLive, src:Lost and src:WriteRefused are emitted (none: no events). */
  bus?: EventBus
  /** Called after the effect changed the graph, e.g. to patch the DOM (mount's flush). */
  onChange?: () => void
  /** Waits between attempts to reach a store: doubling from minMs up to maxMs (default 500, 10000). */
  backoff?: { minMs?: number; maxMs?: number }
  /** How many members src:SyncLog keeps (default 100). */
  logSize?: number
}

interface Queued {
  id: string
  member: Term
  add: Quad[]
  remove: Quad[]
}

interface Bound {
  iri: string
  node: Term
  patterns: Pattern[]
  graph?: string
  writable: boolean
  awaiters: Term[]
  transport?: SourceTransport
  state?: string
  cursor?: number
  attempts: number
  lastError?: string
  batch?: { add: Quad[]; remove: Quad[] }
  queue: Queued[]
  sending?: Promise<void>
}

const isTransport = (e: Endpoint | SourceTransport): e is SourceTransport => typeof (e as SourceTransport).follow === 'function'

/** The remote-sources effect for one runtime. */
export class RemoteSources {
  private bound: Bound[] = []
  /** Changes the effect makes itself (from the store, its own reports) are not writes. */
  private applying = 0
  private stopped = false
  private seq = 0
  private readonly members: Term[] = []
  private readonly controller = new AbortController()
  private detach?: () => void

  constructor(
    readonly runtime: Runtime,
    readonly opts: RemoteSourcesOptions,
  ) {}

  private get f() {
    return this.runtime.store.factory
  }
  private nn(iri: string) {
    return this.f.namedNode(iri)
  }

  /** Bind every src:Source in the graph and start following them. Returns a function that stops it (stop()). */
  attach(): () => void {
    this.bound = this.read()
    const stopInput = this.runtime.onInput((graph, delta) => this.changed(graph, delta))
    const stopEnd = this.runtime.onEnd(() => this.stop())
    this.detach = () => (stopInput(), stopEnd())
    for (const s of this.bound) {
      if (!s.transport) this.report(s, SRC + 'Unbound')
      else this.report(s, SRC + 'Loading'), void this.follow(s)
    }
    this.opts.onChange?.()
    return () => this.stop()
  }

  /** Stop following and sending: what is waiting stays unsent. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.controller.abort()
    this.detach?.()
  }

  /** Resolves once no write waits or is in flight (tests, and a host that wants to know before it leaves). */
  async settled(): Promise<void> {
    for (;;) {
      await Promise.resolve()
      const busy = this.bound.filter((s) => s.batch || s.sending)
      if (!busy.length || this.stopped) return
      await Promise.all(busy.map((s) => s.sending))
    }
  }

  /** The sources the graph declares, with the host's endpoints. */
  private read(): Bound[] {
    const store = this.runtime.store
    const dg = this.f.defaultGraph()
    const one = (s: Term, p: string) => store.match(s, this.nn(p), null, dg)[0]?.object
    return store.match(null, this.nn(RDF_TYPE), this.nn(SRC + 'Source'), dg).map(({ subject: node }) => {
      const patterns = store.match(node, this.nn(SRC + 'pattern'), null, dg).map(({ object: p }) => {
        const pattern: Pattern = {}
        for (const k of ['subject', 'predicate', 'object', 'class'] as const) {
          const v = one(p, SRC + k)
          if (v) pattern[k] = v.value
        }
        return pattern
      })
      const endpoint = this.opts.endpoints[node.value]
      return {
        iri: node.value,
        node,
        patterns,
        graph: one(node, SRC + 'graph')?.value,
        writable: one(node, SRC + 'writable')?.value === 'true',
        awaiters: store.match(null, this.nn(SRC + 'awaits'), node, dg).map((q) => q.subject),
        transport: endpoint === undefined ? undefined : isTransport(endpoint) ? endpoint : httpTransport(endpoint),
        attempts: 0,
        queue: [],
      }
    })
  }

  private graphTerm(s: Bound) {
    return s.graph ? this.nn(s.graph) : this.f.defaultGraph()
  }

  private typesOf(s: Bound) {
    const g = this.graphTerm(s)
    return (subject: Term) => new Set(this.runtime.store.match(subject, this.nn(RDF_TYPE), null, g).map((q) => q.object.value))
  }

  /** What the page holds of a source: its patterns, matched in its graph (the cost of that part, not of the page). */
  private held(s: Bound): Quad[] {
    const store = this.runtime.store
    const g = this.graphTerm(s)
    const typesOf = this.typesOf(s)
    const term = (v: string | undefined) => (v === undefined ? null : this.nn(v))
    const out = new Map<string, Quad>()
    for (const p of s.patterns) {
      const subjects = p.class !== undefined ? store.match(term(p.subject), this.nn(RDF_TYPE), this.nn(p.class), g).map((q) => q.subject) : [term(p.subject)]
      for (const subject of subjects)
        for (const q of store.match(subject, term(p.predicate), term(p.object), g)) if (concerns(q, [p], typesOf)) out.set(quadKey(q), q)
    }
    return [...out.values()]
  }

  // --- reading -----------------------------------------------------------------------------------

  private delay(attempt: number) {
    const min = this.opts.backoff?.minMs ?? 500
    const max = this.opts.backoff?.maxMs ?? 10_000
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.min(min * 2 ** Math.max(0, attempt - 1), max))
      this.controller.signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
    })
  }

  /** Follow a source's stream; when it breaks, try again from the cursor. */
  private async follow(s: Bound) {
    while (!this.stopped) {
      try {
        await s.transport!.follow(s.patterns, s.cursor, (event, data) => this.received(s, event, data), this.controller.signal)
        throw new Error('the stream ended')
      } catch (e) {
        if (this.stopped) return
        s.attempts++
        s.lastError = e instanceof Error ? e.message : String(e)
        this.report(s, SRC + 'Reconnecting')
        this.emit(SRC + 'Lost', s, [[SRC + 'lastError', this.f.literal(s.lastError)]])
        await this.delay(s.attempts)
      }
    }
  }

  private received(s: Bound, event: string, data: unknown) {
    if (this.stopped) return
    const f = this.f
    if (event === 'snapshot') {
      const snap = data as Snapshot
      const add = fromNTriples(snap.add, f)
      // The store is the authority: what the page held of it and the store no longer has goes.
      const keep = new Set(add.map(quadKey))
      const remove = this.held(s).filter((q) => !keep.has(quadKey(q)))
      this.fromStore(s, { add, remove })
      this.record(SRC + 'Snapshot', s, { added: add.length, removed: remove.length, cursor: snap.cursor, ...(snap.reset && { reset: true }) })
    } else if (event === 'delta') {
      const d = data as DeltaMessage
      const applied = this.fromStore(s, { add: fromNTriples(d.add, f), remove: fromNTriples(d.remove, f) })
      this.record(SRC + 'Received', s, { added: applied.add.length, removed: applied.remove.length, cursor: d.cursor })
    }
    const cursor = (data as { cursor?: number }).cursor
    if (typeof cursor === 'number') s.cursor = cursor
    const wasLive = s.state === SRC + 'Live'
    s.attempts = 0
    s.lastError = undefined
    this.report(s, SRC + 'Live')
    if (!wasLive) this.emit(SRC + 'WentLive', s)
    this.opts.onChange?.()
  }

  /** Apply what the store holds: as it is, and not as a write. */
  private fromStore(s: Bound, delta: Delta): Delta {
    // The page's changes so far are one write, made from the state before this: a write must not
    // span a change from the store (one that undoes the store's change would cancel out).
    if (s.batch) this.enqueue(s)
    this.applying++
    try {
      return s.graph ? this.runtime.write(s.graph, delta) : this.runtime.apply(delta)
    } finally {
      this.applying--
    }
  }

  // --- writing -----------------------------------------------------------------------------------

  /** A change to the input: what of it a writable source covers is that source's next write. */
  private changed(graph: string | undefined, delta: Delta) {
    if (this.applying || this.stopped) return
    for (const s of this.bound) {
      if (!s.writable || !s.transport || graph !== s.graph) continue
      const typesOf = this.typesOf(s)
      const add = delta.add.filter((q) => concerns(q, s.patterns, typesOf))
      // A removed statement is judged by its subject's types before the change: a removed instance has lost its type by now.
      const before = (subject: Term) => {
        const types = new Set(typesOf(subject))
        for (const q of delta.remove) if (q.subject.equals(subject) && q.predicate.value === RDF_TYPE) types.add(q.object.value)
        return types
      }
      const remove = delta.remove.filter((q) => concerns(q, s.patterns, before))
      if (!add.length && !remove.length) continue
      if (!s.batch) {
        s.batch = { add: [], remove: [] }
        // Everything one tick changes (an event's reactions, together) is one write.
        queueMicrotask(() => this.enqueue(s))
      }
      s.batch.add.push(...add)
      s.batch.remove.push(...remove)
    }
  }

  private enqueue(s: Bound) {
    const batch = s.batch
    s.batch = undefined
    if (!batch || this.stopped) return
    // Added and removed within the tick: no change.
    const added = new Map(batch.add.map((q) => [quadKey(q), q]))
    const removed = new Map(batch.remove.map((q) => [quadKey(q), q]))
    for (const k of [...added.keys()]) if (removed.delete(k)) added.delete(k)
    if (!added.size && !removed.size) return
    const id = `${Date.now().toString(36)}-${++this.seq}`
    const member = this.record(SRC + 'Write', s, { added: added.size, removed: removed.size, cause: true })
    s.queue.push({ id, member, add: [...added.values()], remove: [...removed.values()] })
    this.report(s)
    this.send(s)
  }

  /** Send a source's writes one at a time, in order; one the store cannot be reached for waits and is sent again. */
  private send(s: Bound) {
    if (s.sending) return
    s.sending = (async () => {
      let failures = 0
      while (s.queue.length && !this.stopped) {
        const w = s.queue[0]!
        let result: WriteResult
        try {
          result = await s.transport!.write({ id: w.id, add: toNTriples(w.add), remove: toNTriples(w.remove) }, this.controller.signal)
        } catch {
          if (this.stopped) return
          await this.delay(++failures)
          continue
        }
        failures = 0
        s.queue.shift()
        if (this.stopped) return
        if (result.ok) {
          this.record(SRC + 'Confirmed', s, { of: w.member, cursor: result.cursor })
          this.report(s)
        } else {
          this.fromStore(s, { add: fromNTriples(result.repair.add, this.f), remove: fromNTriples(result.repair.remove, this.f) })
          this.record(SRC + 'Refused', s, { of: w.member, reason: result.reason })
          this.report(s)
          this.emit(SRC + 'WriteRefused', s, [[SRC + 'reason', this.f.literal(result.reason)]])
        }
        this.opts.onChange?.()
      }
    })().finally(() => (s.sending = undefined))
  }

  // --- reporting ---------------------------------------------------------------------------------

  /** The source's state in urn:semblance:sources, and st:busy on what awaits it. */
  private report(s: Bound, state = s.state) {
    const f = this.f
    const store = this.runtime.store
    const g = this.nn(SOURCES_GRAPH)
    const int = (n: number) => f.literal(String(n), this.nn(XSD_INTEGER))
    const props = ['state', 'cursor', 'pending', 'attempts', 'lastError'].map((p) => SRC + p)
    const remove = props.flatMap((p) => store.match(s.node, this.nn(p), null, g))
    const add: Quad[] = []
    if (state) add.push(f.quad(s.node, this.nn(SRC + 'state'), this.nn(state)))
    if (s.cursor !== undefined) add.push(f.quad(s.node, this.nn(SRC + 'cursor'), int(s.cursor)))
    add.push(f.quad(s.node, this.nn(SRC + 'pending'), int(s.queue.length + (s.batch ? 1 : 0))))
    add.push(f.quad(s.node, this.nn(SRC + 'attempts'), int(s.attempts)))
    if (s.lastError) add.push(f.quad(s.node, this.nn(SRC + 'lastError'), f.literal(s.lastError)))
    const keep = new Set(add.map(quadKey))
    this.applying++
    try {
      this.runtime.write(SOURCES_GRAPH, { remove: remove.filter((q) => !keep.has(quadKey(q))), add })
      if (state !== s.state) {
        const busy = state === SRC + 'Loading' || state === SRC + 'Reconnecting'
        const wasBusy = s.state === SRC + 'Loading' || s.state === SRC + 'Reconnecting'
        if (busy !== wasBusy && s.awaiters.length) {
          const quads = s.awaiters.map((c) => f.quad(c, this.nn(ST_BUSY), f.literal('true', this.nn(XSD_BOOLEAN))))
          this.runtime.apply(busy ? { add: quads, remove: [] } : { add: [], remove: quads })
        }
      }
    } finally {
      this.applying--
    }
    s.state = state
  }

  /** A member of src:SyncLog (bounded by logSize). */
  private record(kind: string, s: Bound, about: { added?: number; removed?: number; cursor?: number; reset?: boolean; of?: Term; reason?: string; cause?: boolean }): Term {
    const f = this.f
    const store = this.runtime.store
    const g = this.nn(SOURCES_GRAPH)
    const int = (n: number) => f.literal(String(n), this.nn(XSD_INTEGER))
    const m = this.nn(`${s.iri}/~sync-${Date.now().toString(36)}-${++this.seq}`)
    const log = this.nn(SRC + 'SyncLog')
    const add = [
      f.quad(m, this.nn(RDF_TYPE), this.nn(kind)),
      f.quad(m, this.nn(SRC + 'source'), s.node),
      f.quad(m, this.nn(PROV + 'generatedAtTime'), f.literal(new Date().toISOString(), this.nn(XSD_DATETIME))),
      f.quad(log, this.nn(NS.tree + 'member'), m),
    ]
    if (about.added !== undefined) add.push(f.quad(m, this.nn(SRC + 'added'), int(about.added)))
    if (about.removed !== undefined) add.push(f.quad(m, this.nn(SRC + 'removed'), int(about.removed)))
    if (about.cursor !== undefined) add.push(f.quad(m, this.nn(SRC + 'cursor'), int(about.cursor)))
    if (about.reset) add.push(f.quad(m, this.nn(SRC + 'reset'), f.literal('true', this.nn(XSD_BOOLEAN))))
    if (about.of) add.push(f.quad(m, this.nn(SRC + 'of'), about.of))
    if (about.reason !== undefined) add.push(f.quad(m, this.nn(SRC + 'reason'), f.literal(about.reason)))
    // Which interaction made a write: the newest member of the change log.
    const cause = about.cause && store.match(this.nn(BEH.ChangeLog), this.nn(BEH.latest), null)[0]?.object
    if (cause) add.push(f.quad(m, this.nn(PROV + 'wasInformedBy'), cause))
    this.members.push(m)
    const remove: Quad[] = []
    while (this.members.length > (this.opts.logSize ?? 100)) {
      const old = this.members.shift()!
      remove.push(...store.match(old, null, null, g), ...store.match(log, this.nn(NS.tree + 'member'), old, g))
    }
    this.applying++
    try {
      this.runtime.write(SOURCES_GRAPH, { add, remove })
    } finally {
      this.applying--
    }
    return m
  }

  /** An event targeted at the source, for the page's reactions. */
  private emit(type: string, s: Bound, about: [string, Term][] = []) {
    if (!this.opts.bus || this.stopped) return
    this.opts.bus.emit(type, s.iri, { about })
    this.opts.onChange?.()
  }
}
