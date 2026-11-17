// Network capture (ontology/domain/network.ttl): a host effect that records
// what the page does on the network — fetch exchanges, WebSocket connections
// and their frames — plus the events and spans the application reports, as
// members of net:Capture in the network graph projections read. The stream is
// bounded by its view's retention policies, as every retained stream is (the
// shared retention module, src/retention/offload.ts: dropped or offloaded as
// they say), each entry with the nodes minted under it; bodies are cut at
// net:previewLimit; net:recording false on net:Capture pauses it. Writes are
// coalesced: everything that happens in one task lands as one change.
import type { NamedNode, Quad } from '@rdfjs/types'
import { NETWORK_GRAPH, NS, RDF_TYPE, XSD_INTEGER } from './ns.ts'
import type { RetainedStream } from './retention/offload.ts'
import type { Runtime } from './runtime.ts'

const NET = NS.net
const HTTP = NS.http
const TREE = NS.tree
const XSD_DOUBLE = NS.xsd + 'double'
/** Where entries are minted; their nodes are `<entry>/~<local>`. */
const ENTRY = 'urn:semblance:net:'
/** How much of a body is read without a net:previewLimit (the graph's own default). */
const PREVIEW_FALLBACK = 16_384

export interface CaptureOptions {
  /** Where fetch and WebSocket live (globalThis by default). */
  target?: { fetch?: typeof fetch; WebSocket?: typeof WebSocket }
  /** Milliseconds since the time origin (performance.now by default). */
  now?: () => number
  /** Called after each coalesced write, e.g. to build the DOM. */
  onWrite?: () => void
}

export interface EventDetail {
  /** net:Info (default), net:Success or net:Warning. */
  level?: 'Info' | 'Success' | 'Warning'
  /** A payload; objects are written as JSON. */
  data?: unknown
  correlation?: string
}

/**
 * The captures over each runtime: its net:Capture stream has one host (the first capture's), and an
 * entry that retires is let go by whichever capture began it.
 */
const capturesOf = new WeakMap<Runtime, Set<NetworkCapture>>()

export class NetworkCapture {
  private readonly f
  private readonly now: () => number
  private seq = 0
  /**
   * The retained entries, by IRI, with every subject that belongs to each (the entry, its response,
   * its headers): what arrives late for one retired (or cleared) is dropped.
   */
  private readonly alive = new Map<string, NamedNode[]>()
  private retained?: RetainedStream
  private pending: { add: Quad[]; remove: Quad[] } | undefined
  private readonly restore: (() => void)[] = []

  constructor(
    private readonly runtime: Runtime,
    private readonly opts: CaptureOptions = {},
  ) {
    this.f = runtime.store.factory
    this.now = opts.now ?? (() => performance.now())
    let captures = capturesOf.get(runtime)
    if (!captures) capturesOf.set(runtime, (captures = new Set()))
    captures.add(this)
  }

  /** Start recording the target's fetches and sockets. Returns a function that stops it. */
  attach(): () => void {
    const target = this.opts.target ?? (globalThis as CaptureOptions['target'] & object)
    if (target.fetch) {
      const original = target.fetch
      target.fetch = (input, init) => this.fetch(original, target, input, init)
      this.restore.push(() => (target.fetch = original))
    }
    if (target.WebSocket) {
      const original = target.WebSocket
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const capture = this
      const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]) {
        const socket = new original(url, protocols)
        capture.socket(socket, String(url))
        return socket
      } as unknown as typeof WebSocket
      Object.assign(Wrapped, { prototype: original.prototype, CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
      target.WebSocket = Wrapped
      this.restore.push(() => (target.WebSocket = original))
    }
    return () => this.restore.splice(0).forEach((r) => r())
  }

  /** Record an application event (net:Event). Returns its IRI. */
  event(label: string, detail: EventDetail = {}): string | undefined {
    const at = this.now()
    const e = this.begin(NET + 'Event', NET + 'EventKind', label, at)
    if (!e) return
    this.add(e, NET + 'endedAt', this.double(at))
    this.add(e, NET + 'status', this.nn(NET + 'Recorded'))
    this.detail(e, detail)
    return e.value
  }

  /** Begin a span (net:Span); the returned function ends it. */
  span(label: string, detail: EventDetail = {}): (end?: EventDetail) => void {
    const e = this.begin(NET + 'Span', NET + 'EventKind', label, this.now())
    if (!e) return () => {}
    this.add(e, NET + 'status', this.nn(NET + 'Pending'))
    this.detail(e, detail)
    return (end = {}) => {
      this.set(e, NET + 'status', this.nn(NET + 'Complete'))
      this.add(e, NET + 'endedAt', this.double(this.now()))
      if (end.data !== undefined) this.set(e, NET + 'data', this.f.literal(this.text(end.data)))
    }
  }

  /** Forget everything captured so far (the inspector's Clear). */
  clear(): void {
    const g = this.nn(NETWORK_GRAPH)
    const store = this.runtime.store
    for (const [entry, subjects] of [...this.alive]) {
      this.alive.delete(entry)
      this.batch().remove.push(...store.match(this.nn(NET + 'Capture'), this.nn(TREE + 'member'), this.nn(entry), g))
      for (const s of subjects) this.batch().remove.push(...store.match(s, null, null, g))
    }
  }

  // --- what is captured ------------------------------------------------------------------------

  private async fetch(original: typeof fetch, self: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : undefined
    const url = request?.url ?? String(input instanceof URL ? input.href : input)
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const e = this.begin(NET + 'Exchange', NET + 'HttpKind', `${method} ${url}`, this.now())
    if (e) {
      this.add(e, RDF_TYPE, this.nn(HTTP + 'Request'))
      this.add(e, HTTP + 'methodName', this.f.literal(method))
      this.add(e, HTTP + 'absoluteURI', this.f.literal(url))
      this.add(e, NET + 'initiator', this.f.literal('fetch'))
      this.add(e, NET + 'status', this.nn(NET + 'Pending'))
      this.headers(e, e, new Headers(init?.headers ?? request?.headers))
      if (typeof init?.body === 'string') this.add(e, NET + 'body', this.f.literal(this.cut(init.body)))
    }
    try {
      const response = await original.call(self, input, init)
      if (e) await this.response(e, response)
      return response
    } catch (error) {
      if (e) {
        this.set(e, NET + 'status', this.nn(NET + 'Failed'))
        this.add(e, NET + 'endedAt', this.double(this.now()))
        this.add(e, NET + 'data', this.f.literal(String(error)))
      }
      throw error
    }
  }

  private async response(e: NamedNode, response: Response) {
    const r = this.mint(e, 'response')
    this.add(r, RDF_TYPE, this.nn(HTTP + 'Response'))
    this.add(e, HTTP + 'resp', r)
    this.add(r, HTTP + 'statusCodeValue', this.f.literal(String(response.status), this.nn(XSD_INTEGER)))
    this.headers(e, r, response.headers)
    const type = response.headers.get('content-type')
    if (type) this.add(r, NET + 'contentType', this.f.literal(type))
    let size = Number(response.headers.get('content-length') ?? NaN)
    const body = await this.preview(response)
    if (body) {
      if (Number.isNaN(size) && body.whole) size = body.bytes
      this.add(r, NET + 'body', this.f.literal(this.cut(body.text)))
    }
    if (!Number.isNaN(size)) this.add(e, NET + 'size', this.integer(size))
    this.set(e, NET + 'status', this.nn(response.ok ? NET + 'Complete' : NET + 'Failed'))
    this.add(e, NET + 'endedAt', this.double(this.now()))
  }

  /**
   * The start of a response's body, read from a clone up to net:previewLimit characters and no
   * further: a stream (server-sent events, Jelly) is never buffered whole, and its reading is
   * cancelled once the preview is full. `whole` when the body ended within it.
   */
  private async preview(response: Response): Promise<{ text: string; whole: boolean; bytes: number } | undefined> {
    let body: ReadableStream<Uint8Array> | null
    try {
      body = response.clone().body
    } catch {
      return undefined
    }
    if (!body) return { text: '', whole: true, bytes: 0 }
    const limit = this.limit() ?? PREVIEW_FALLBACK
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return { text: text + decoder.decode(), whole: true, bytes }
        bytes += value.byteLength
        text += decoder.decode(value, { stream: true })
        if (text.length > limit) {
          void reader.cancel().catch(() => {})
          return { text, whole: false, bytes }
        }
      }
    } catch {
      return undefined
    }
  }

  private socket(socket: WebSocket, url: string) {
    const c = this.begin(NET + 'Connection', NET + 'SocketKind', url, this.now())
    if (!c) return
    this.add(c, NET + 'url', this.f.literal(url))
    this.add(c, NET + 'status', this.nn(NET + 'Pending'))
    socket.addEventListener('open', () => this.set(c, NET + 'status', this.nn(NET + 'Open')))
    socket.addEventListener('close', () => {
      this.set(c, NET + 'status', this.nn(NET + 'Closed'))
      this.add(c, NET + 'endedAt', this.double(this.now()))
    })
    socket.addEventListener('error', () => this.set(c, NET + 'status', this.nn(NET + 'Failed')))
    socket.addEventListener('message', (m) => this.frame(c, NET + 'Received', m.data))
    const send = socket.send
    socket.send = (data) => {
      this.frame(c, NET + 'Sent', data)
      send.call(socket, data)
    }
  }

  private frame(connection: NamedNode, status: string, data: unknown) {
    const at = this.now()
    const text = typeof data === 'string' ? data : data instanceof ArrayBuffer ? `[${data.byteLength} bytes]` : String(data)
    const fr = this.begin(NET + 'Frame', NET + 'FrameKind', text.slice(0, 80), at)
    if (!fr) return
    this.add(fr, NET + 'connection', connection)
    this.add(fr, NET + 'status', this.nn(status))
    this.add(fr, NET + 'endedAt', this.double(at))
    this.add(fr, NET + 'size', this.integer(typeof data === 'string' ? new TextEncoder().encode(data).length : data instanceof ArrayBuffer ? data.byteLength : 0))
    this.add(fr, NET + 'data', this.f.literal(this.cut(text)))
  }

  private headers(entry: NamedNode, message: NamedNode, headers: Headers) {
    let i = 0
    headers.forEach((value, name) => {
      const h = this.mint(entry, `${message === entry ? 'req' : 'resp'}-h${i}`)
      this.add(h, RDF_TYPE, this.nn(HTTP + 'MessageHeader'))
      this.add(h, HTTP + 'fieldName', this.f.literal(name))
      this.add(h, HTTP + 'fieldValue', this.f.literal(value))
      this.add(h, NS.sem + 'order', this.integer(i++))
      this.add(message, HTTP + 'headers', h)
    })
  }

  private detail(e: NamedNode, d: EventDetail) {
    this.add(e, NET + 'level', this.nn(NET + (d.level ?? 'Info')))
    if (d.data !== undefined) this.add(e, NET + 'data', this.f.literal(this.cut(this.text(d.data))))
    if (d.correlation) this.add(e, NET + 'correlation', this.f.literal(d.correlation))
  }

  // --- the stream --------------------------------------------------------------------------------

  /** A new member of net:Capture, or nothing while recording is off. Retires what retention drops. */
  private begin(type: string, kind: string, label: string, at: number): NamedNode | undefined {
    if (!this.recording()) return
    const n = ++this.seq
    const e = this.nn(`urn:semblance:net:${Date.now().toString(36)}-${n}`)
    this.alive.set(e.value, [e])
    this.add(e, RDF_TYPE, this.nn(type))
    this.add(e, NET + 'kind', this.nn(kind))
    this.add(e, NET + 'label', this.f.literal(label))
    this.add(e, NET + 'sequence', this.integer(n))
    this.add(e, NET + 'startedAt', this.double(at))
    this.add(this.nn(NET + 'Capture'), TREE + 'member', e)
    // Bounded by its policies in the graph (net:CaptureView), as every retained stream is (docs/RETENTION.md).
    const leaving = this.stream().append({ iri: e.value, seq: n, at: Date.now() })
    if (leaving.length) this.batch().remove.push(...leaving)
    return e
  }

  /** A node that belongs to an entry (its response, a header), retired with it. */
  private mint(entry: NamedNode, local: string): NamedNode {
    const n = this.nn(`${entry.value}/~${local}`)
    this.alive.get(entry.value)?.push(n)
    return n
  }

  private recording(): boolean {
    const q = this.runtime.store.match(this.nn(NET + 'Capture'), this.nn(NET + 'recording'), null)
    return q.every((x) => x.object.value !== 'false')
  }

  /** net:Capture as a retained stream (src/retention/offload.ts): what its policies retire, and how. */
  private stream(): RetainedStream {
    const g = this.nn(NETWORK_GRAPH)
    const runtime = this.runtime
    const store = runtime.store
    const capture = this.nn(NET + 'Capture')
    return (this.retained ??= runtime.retention.stream(NET + 'Capture', {
      graph: NETWORK_GRAPH,
      // An entry leaves with every node minted under it, and with what is still to be written about
      // them in this task; from then on nothing more is written about it.
      closure: (m) => {
        const out = store.match(capture, this.nn(TREE + 'member'), m, g)
        let subjects: NamedNode[] = [m]
        for (const c of capturesOf.get(runtime) ?? []) {
          const left = c.letGo(m)
          if (!left) continue
          subjects = left.subjects
          out.push(...left.pending)
        }
        for (const s of subjects) out.push(...store.match(s, null, null, g))
        return out
      },
      write: (d) => runtime.write(NETWORK_GRAPH, d),
    }))
  }

  /** An entry of this capture retires: its subjects, and what was still to be written about them (taken out). */
  private letGo(m: NamedNode): { subjects: NamedNode[]; pending: Quad[] } | undefined {
    const subjects = this.alive.get(m.value)
    if (!subjects) return undefined
    this.alive.delete(m.value)
    const b = this.pending
    if (!b) return { subjects, pending: [] }
    const g = this.nn(NETWORK_GRAPH)
    const mine = new Set(subjects.map((s) => s.value))
    const theirs = (q: Quad) => mine.has(q.subject.value) || (q.predicate.value === TREE + 'member' && q.object.equals(m))
    const pending = b.add.filter(theirs).map((q) => this.f.quad(q.subject, q.predicate, q.object, g))
    b.add = b.add.filter((q) => !theirs(q))
    return { subjects, pending }
  }

  /** net:previewLimit, in characters (undefined: none given). */
  private limit(): number | undefined {
    const limit = this.runtime.store.match(this.nn(NET + 'Capture'), this.nn(NET + 'previewLimit'), null)[0]
    return limit ? Number(limit.object.value) : undefined
  }

  private cut(text: string): string {
    const n = this.limit() ?? Infinity
    return text.length > n ? text.slice(0, n) + '…' : text
  }

  /** Whether a node may still be written: not one of an entry retired (or cleared) since it began. */
  private live(s: NamedNode): boolean {
    if (!s.value.startsWith(ENTRY)) return true
    const i = s.value.indexOf('/~')
    return this.alive.has(i < 0 ? s.value : s.value.slice(0, i))
  }

  // --- writing -----------------------------------------------------------------------------------

  private batch() {
    if (!this.pending) {
      this.pending = { add: [], remove: [] }
      queueMicrotask(() => this.flush())
    }
    return this.pending
  }

  /** Write what is pending now (otherwise at the end of the current task). */
  flush(): void {
    const delta = this.pending
    this.pending = undefined
    if (!delta || (!delta.add.length && !delta.remove.length)) return
    this.runtime.write(NETWORK_GRAPH, delta)
    this.opts.onWrite?.()
  }

  private add(s: NamedNode, p: string, o: Quad['object']) {
    if (!this.live(s)) return
    this.batch().add.push(this.f.quad(s, this.nn(p), o))
  }

  /** Replace a single-valued property (from the graph and from what is pending). */
  private set(s: NamedNode, p: string, o: Quad['object']) {
    if (!this.live(s)) return
    const b = this.batch()
    const pred = this.nn(p)
    b.add = b.add.filter((q) => !(q.subject.equals(s) && q.predicate.equals(pred)))
    b.remove.push(...this.runtime.store.match(s, pred, null, this.nn(NETWORK_GRAPH)))
    b.add.push(this.f.quad(s, pred, o))
  }

  private nn(iri: string) {
    return this.f.namedNode(iri)
  }
  private double(n: number) {
    return this.f.literal(String(Math.round(n * 1000) / 1000), this.nn(XSD_DOUBLE))
  }
  private integer(n: number) {
    return this.f.literal(String(n), this.nn(XSD_INTEGER))
  }
  private text(data: unknown) {
    return typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  }
}
