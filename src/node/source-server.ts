// A reference server for remote sources (docs/REMOTE.md): an in-memory store behind an HTTP
// handler that speaks the protocol in src/source-protocol.ts. Each subscription names the
// part of the store a page needs (patterns); every change to the store is one step of a
// cursor, kept in a bounded log, and reaches a subscription only when it touches its
// patterns. A changed statement is matched by its predicate, subject or subject's type, so
// what a change costs here is the change, not the size of the store.
//
// It is a starting point and a test double, not a database: a real deployment puts the same
// protocol in front of its triple store, and checks who may read and write what.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Quad, Term } from '@rdfjs/types'
import { DataFactory, Parser, Store } from 'n3'
import { concerns, fromNTriples, JELLY_MEDIA_TYPE, JellyEventWriter, type Pattern, RDF_TYPE, type SourceEvent, toNTriples, wireMessage, type WriteRequest, type WriteResult } from '../source-protocol.ts'

const f = DataFactory
const TYPE = f.namedNode(RDF_TYPE)
const key = (q: Quad) => `${q.subject.termType}:${q.subject.value} ${q.predicate.value} ${q.object.termType}:${q.object.value}:${(q.object as { language?: string }).language ?? ''}:${(q.object as { datatype?: Term }).datatype?.value ?? ''}`

export interface SourceServerOptions {
  /** How many steps the log keeps for subscriptions that resume (default 1000). */
  logSize?: number
  /** Refuse a write: return the reason, or undefined to take it. Sees the store before the write. */
  validate?: (change: { add: Quad[]; remove: Quad[] }, store: Store) => string | undefined
  /** How often an open subscription hears the cursor when nothing concerns it (ms, default 15000). */
  heartbeatMs?: number
}

/** One step of the store, with what it takes to tell, later, which subscriptions it concerns. */
interface Step {
  cursor: number
  add: Quad[]
  remove: Quad[]
  write?: string
  /** The classes of each subject it touched, before and after it. */
  before: Map<string, Set<string>>
  after: Map<string, Set<string>>
  /** A subject that became (or stopped being) an instance of a class: its whole description, for src:class patterns. */
  described: Quad[]
  undescribed: Quad[]
}

interface Subscription {
  patterns: Pattern[]
  send(event: string, data: SourceEvent): void
  end(): void
}

const NONE: ReadonlySet<string> = new Set()

export class SourceServer {
  readonly store = new Store()
  cursor = 0
  /** Pattern checks made (tests: a change costs the change, not the store). */
  readonly work = { checks: 0 }
  private readonly log: Step[] = []
  private readonly subscriptions = new Set<Subscription>()

  constructor(readonly opts: SourceServerOptions = {}) {}

  /** Load Turtle into the store, as one step. */
  load(turtle: string): number {
    return this.change({ add: new Parser({ format: 'text/turtle' }).parse(turtle), remove: [] })
  }

  /** How many subscriptions are open. */
  get subscribers(): number {
    return this.subscriptions.size
  }

  /** Change the store as one step, and send it to the subscriptions it concerns. Returns the cursor. */
  change(delta: { add: Quad[]; remove: Quad[] }, write?: string): number {
    const s = this.store
    const adding = new Set(delta.add.map(key))
    const remove = dedupe(delta.remove.filter((q) => s.has(q) && !adding.has(key(q))))
    const add = dedupe(delta.add.filter((q) => !s.has(q)))
    if (!add.length && !remove.length) return this.cursor
    const subjects = new Map<string, Term>()
    for (const q of [...add, ...remove]) subjects.set(q.subject.termType + ':' + q.subject.value, q.subject)
    const typesNow = (t: Term) => new Set(s.getQuads(t, TYPE, null, null).map((q) => q.object.value))
    const before = new Map([...subjects].map(([k, t]) => [k, typesNow(t)]))
    // A subject that stops being an instance of a class: what it was, while it still is.
    const undescribed = remove.filter((q) => q.predicate.equals(TYPE)).flatMap((q) => s.getQuads(q.subject, null, null, null))
    for (const q of remove) s.removeQuad(q)
    for (const q of add) s.addQuad(q)
    const after = new Map([...subjects].map(([k, t]) => [k, typesNow(t)]))
    const described = add.filter((q) => q.predicate.equals(TYPE)).flatMap((q) => s.getQuads(q.subject, null, null, null))
    const step: Step = { cursor: ++this.cursor, add, remove, write, before, after, described, undescribed }
    this.log.push(step)
    if (this.log.length > (this.opts.logSize ?? 1000)) this.log.shift()
    for (const sub of this.subscriptions) {
      const d = this.deltaFor(step, sub.patterns)
      if (d) sub.send('delta', d)
    }
    return this.cursor
  }

  /** A page's write: taken as one step, or refused - stale (a statement it removes is not here) or by validation. */
  write(req: WriteRequest): WriteResult {
    const add = fromNTriples(req.add, f)
    const remove = fromNTriples(req.remove, f)
    const stale = remove.some((q) => !this.store.has(q))
    const reason = stale ? 'stale' : this.opts.validate?.({ add, remove }, this.store)
    if (reason !== undefined) {
      // What the store holds of what the write touched: the page puts its statements back to that.
      return {
        ok: false,
        reason,
        repair: { add: toNTriples(remove.filter((q) => this.store.has(q))), remove: toNTriples(add.filter((q) => !this.store.has(q))) },
      }
    }
    return { ok: true, cursor: this.change({ add, remove }, req.id) }
  }

  /** The part of the store the patterns cover, now. */
  snapshot(patterns: Pattern[]): Quad[] {
    const s = this.store
    const out = new Map<string, Quad>()
    const typesNow = (t: Term) => new Set(s.getQuads(t, TYPE, null, null).map((q) => q.object.value))
    const nn = (v: string | undefined) => (v === undefined ? null : f.namedNode(v))
    for (const p of patterns) {
      const subjects = p.class !== undefined ? s.getQuads(nn(p.subject), TYPE, f.namedNode(p.class), null).map((q) => q.subject) : [nn(p.subject)]
      for (const subject of subjects) {
        for (const q of s.getQuads(subject, nn(p.predicate), nn(p.object), null)) {
          this.work.checks++
          if (concerns(q, [p], typesNow)) out.set(key(q), q)
        }
      }
    }
    return [...out.values()]
  }

  /**
   * Follow the store from `after` (a cursor the subscriber holds; undefined: from now, with a
   * snapshot first). A cursor the log no longer reaches back to gets a snapshot with reset.
   * Messages are sent as they travel in server-sent events (statements as N-Triples).
   * Returns a function that ends the subscription.
   */
  subscribe(patterns: Pattern[], after: number | undefined, send: (event: string, data: unknown) => void, end: () => void = () => {}): () => void {
    return this.follow(patterns, after, (event, e) => send(event, wireMessage(event, e)), end)
  }

  /** As subscribe, with each message's statements as statements (for a Jelly stream). */
  follow(patterns: Pattern[], after: number | undefined, send: (event: string, data: SourceEvent) => void, end: () => void = () => {}): () => void {
    const start = this.log.length ? this.log[0]!.cursor - 1 : this.cursor
    if (after === undefined || after > this.cursor || after < start) {
      send('snapshot', { cursor: this.cursor, add: this.snapshot(patterns), remove: [], ...(after !== undefined && { reset: true }) })
    } else {
      for (const step of this.log) {
        if (step.cursor <= after) continue
        const d = this.deltaFor(step, patterns)
        if (d) send('delta', d)
      }
      send('cursor', { cursor: this.cursor, add: [], remove: [] })
    }
    const sub: Subscription = { patterns, send, end }
    this.subscriptions.add(sub)
    return () => void this.subscriptions.delete(sub)
  }

  /** End every open subscription (a dropped connection, in tests and demos). */
  drop(): void {
    for (const sub of [...this.subscriptions]) this.subscriptions.delete(sub), sub.end()
  }

  /** What of a step concerns the patterns, or undefined when nothing does. */
  private deltaFor(step: Step, patterns: Pattern[]): SourceEvent | undefined {
    const types = (m: Map<string, Set<string>>) => (t: Term) => m.get(t.termType + ':' + t.value) ?? NONE
    const check = (q: Quad, m: Map<string, Set<string>>) => (this.work.checks++, concerns(q, patterns, types(m)))
    const add = new Map<string, Quad>()
    const remove = new Map<string, Quad>()
    for (const q of [...step.add, ...step.described]) if (check(q, step.after)) add.set(key(q), q)
    for (const q of step.remove) if (check(q, step.before)) remove.set(key(q), q)
    // A subject that left a class: what concerned the patterns only through it leaves the page;
    // what still concerns them (another pattern) stays.
    const kept = new Set(step.remove.map(key))
    for (const q of step.undescribed) if (check(q, step.before) && (kept.has(key(q)) || !check(q, step.after))) remove.set(key(q), q)
    // A statement that is in both (described, and changed in the same step) is where it ends up.
    for (const k of add.keys()) remove.delete(k)
    if (!add.size && !remove.size) return undefined
    return { cursor: step.cursor, add: [...add.values()], remove: [...remove.values()], ...(step.write && { write: step.write }) }
  }

  /**
   * The HTTP side, under `base` (default "/"): GET {base}changes?patterns=…&after=… streams
   * server-sent events; POST {base}writes takes a write. Returns false for any other request,
   * so it composes with other handlers.
   */
  handler(base = '/'): (req: IncomingMessage, res: ServerResponse) => boolean {
    return (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(base)) return false
      const path = url.pathname.slice(base.length)
      if (req.method === 'GET' && path === 'changes') {
        let patterns: Pattern[]
        try {
          patterns = JSON.parse(url.searchParams.get('patterns') ?? '[]')
          if (!Array.isArray(patterns)) throw new Error('patterns is not a list')
        } catch (e) {
          res.writeHead(400, { 'content-type': 'text/plain' }).end(String(e))
          return true
        }
        const afterParam = url.searchParams.get('after')
        // A page that takes Jelly gets a Jelly stream (a frame per message); others, server-sent events.
        const jelly = (req.headers.accept ?? '').includes(JELLY_MEDIA_TYPE)
        res.writeHead(200, { 'content-type': jelly ? JELLY_MEDIA_TYPE : 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.flushHeaders()
        const frames = jelly ? new JellyEventWriter() : undefined
        const send = (event: string, data: SourceEvent) =>
          void res.write(frames ? frames.frame(event, data) : `event: ${event}\ndata: ${JSON.stringify(wireMessage(event, data))}\n\n`)
        const stop = this.follow(patterns, afterParam === null ? undefined : Number(afterParam), send, () => res.end())
        const beat = setInterval(() => send('cursor', { cursor: this.cursor, add: [], remove: [] }), this.opts.heartbeatMs ?? 15000)
        res.on('close', () => (clearInterval(beat), stop()))
        return true
      }
      if (req.method === 'POST' && path === 'writes') {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => (body += chunk))
        req.on('end', () => {
          let result: WriteResult
          try {
            result = this.write(JSON.parse(body) as WriteRequest)
          } catch (e) {
            res.writeHead(400, { 'content-type': 'text/plain' }).end(String(e))
            return
          }
          res.writeHead(result.ok ? 200 : 409, { 'content-type': 'application/json' }).end(JSON.stringify(result))
        })
        return true
      }
      return false
    }
  }
}

function dedupe(quads: Quad[]): Quad[] {
  const seen = new Map<string, Quad>()
  for (const q of quads) seen.set(key(q), q)
  return [...seen.values()]
}
