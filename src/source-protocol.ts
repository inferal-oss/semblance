// The protocol between a page and a store elsewhere (docs/REMOTE.md): what a page binds to
// (patterns), and the messages that carry a snapshot, the store's changes and the page's
// writes. Statements travel as N-Triples in server-sent events, or, when both ends speak it, as a
// Jelly stream (docs/JELLY.md: a frame per message). Shared by the client effect (src/remote.ts)
// and the reference server (src/node/source-server.ts); any server that speaks it will do.
import type { Quad, Term } from '@rdfjs/types'
import { DataFactory, Parser, Writer } from 'n3'
import { FrameSplitter, type JellyFactory, JellyReader } from './jelly/decode.ts'
import { delimit, JellyWriter } from './jelly/encode.ts'
import { quadKey } from './rdf.ts'
import type { Factory, GraphStore } from './store/types.ts'

/**
 * Part of a store a page needs: a triple pattern (any of subject, predicate, object; an omitted
 * one matches anything), or every statement whose subject is an instance of `class`.
 */
export interface Pattern {
  subject?: string
  predicate?: string
  object?: string
  class?: string
}

/** The first message of a subscription: the page's part of the store, as of `cursor`. */
export interface Snapshot {
  cursor: number
  add: string
  /** A resumed subscription whose gap is longer than the server's log: replace, don't add. */
  reset?: boolean
}

/** One step of the store that touches the patterns. `write` is the id of the page's write it was, if it was one. */
export interface DeltaMessage {
  cursor: number
  add: string
  remove: string
  write?: string
}

/** A write: what a page changed, under an id of its own. */
export interface WriteRequest {
  id: string
  add: string
  remove: string
}

/** A write the store took, at `cursor`; or one it refused, with what it holds of the statements the write touched. */
export type WriteResult = { ok: true; cursor: number } | { ok: false; reason: string; repair: { add: string; remove: string } }

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

/**
 * Whether a statement belongs to the patterns. `typesOf` gives the classes of a subject (for
 * src:class patterns): the caller decides whether that is before or after a change.
 */
export function concerns(q: Quad, patterns: readonly Pattern[], typesOf: (subject: Term) => ReadonlySet<string>): boolean {
  for (const p of patterns) {
    if (p.subject !== undefined && !(q.subject.termType === 'NamedNode' && q.subject.value === p.subject)) continue
    if (p.predicate !== undefined && q.predicate.value !== p.predicate) continue
    if (p.object !== undefined && !(q.object.termType === 'NamedNode' && q.object.value === p.object)) continue
    if (p.class !== undefined && !typesOf(q.subject).has(p.class)) continue
    return true
  }
  return false
}

/**
 * What a store holds of the patterns in one graph: each pattern matched in its own index (a class's
 * instances, then their statements), so it costs that part of the store, not the store. What a
 * snapshot replaces (the remote-sources effect, and views following a source).
 */
export function heldOf(store: GraphStore, patterns: readonly Pattern[], graph: Term): Quad[] {
  const f = store.factory
  const type = f.namedNode(RDF_TYPE)
  const typesOf = (subject: Term) => new Set(store.match(subject, type, null, graph).map((q) => q.object.value))
  const term = (v: string | undefined) => (v === undefined ? null : f.namedNode(v))
  const out = new Map<string, Quad>()
  for (const p of patterns) {
    const subjects = p.class !== undefined ? store.match(term(p.subject), type, f.namedNode(p.class), graph).map((q) => q.subject) : [term(p.subject)]
    for (const subject of subjects)
      for (const q of store.match(subject, term(p.predicate), term(p.object), graph)) if (concerns(q, [p], typesOf)) out.set(quadKey(q), q)
  }
  return [...out.values()]
}

/** Statements as N-Triples (graphs dropped: a source's statements land where the page says). */
export function toNTriples(quads: Iterable<Quad>): string {
  const w = new Writer({ format: 'N-Triples' })
  let out = ''
  for (const q of quads) out += w.quadToString(q.subject, q.predicate, q.object)
  return out
}

/**
 * N-Triples back into statements, made by `f` (a store's factory, so they are in its terms).
 * A source's statements name things by IRI: one with a blank node has no identity across
 * the wire, and is left out.
 */
export function fromNTriples(nt: string, f: Pick<Factory, 'namedNode' | 'literal' | 'quad'>): Quad[] {
  if (!nt) return []
  const term = (t: Term): Term => (t.termType === 'Literal' ? f.literal(t.value, t.language || f.namedNode(t.datatype.value)) : f.namedNode(t.value))
  return new Parser({ format: 'N-Triples' })
    .parse(nt)
    .filter((q) => q.subject.termType === 'NamedNode' && q.object.termType !== 'BlankNode')
    .map((q) => f.quad(term(q.subject as Term), term(q.predicate as Term), term(q.object as Term)))
}

/** A message of the stream with its statements as statements: what a server holds, and what a Jelly stream carries. */
export interface SourceEvent {
  cursor: number
  add: readonly Quad[]
  remove: readonly Quad[]
  write?: string
  reset?: boolean
}

/** The media type of a Jelly stream; a page asks for it first, and takes server-sent events from a server that answers with those. */
export const JELLY_MEDIA_TYPE = 'application/x-jelly-rdf'

/** A message as it travels in server-sent events: statements as N-Triples. */
export function wireMessage(event: string, e: SourceEvent): Snapshot | DeltaMessage | { cursor: number } {
  if (event === 'snapshot') return { cursor: e.cursor, add: toNTriples(e.add), ...(e.reset && { reset: true }) }
  if (event === 'delta') return { cursor: e.cursor, add: toNTriples(e.add), remove: toNTriples(e.remove), ...(e.write && { write: e.write }) }
  return { cursor: e.cursor }
}

/** A message's statements, in `f`'s terms, from N-Triples or from statements; those with a blank node are left out (fromNTriples). */
export function statementsOf(x: string | readonly Quad[], f: Pick<Factory, 'namedNode' | 'literal' | 'quad'>): Quad[] {
  if (typeof x === 'string') return fromNTriples(x, f)
  const term = (t: Term): Term => (t.termType === 'Literal' ? f.literal(t.value, t.language || f.namedNode(t.datatype.value)) : f.namedNode(t.value))
  return x.filter((q) => q.subject.termType === 'NamedNode' && q.object.termType !== 'BlankNode').map((q) => f.quad(term(q.subject), term(q.predicate), term(q.object)))
}

const utf8 = new TextEncoder()
const text = new TextDecoder()

/**
 * The stream as Jelly: one stream of triples (RDF Messages), a frame per message (a large one, a
 * snapshot, spans several); a delta's removals come first. The metadata of a message's last frame
 * says which message it is: `event`, `cursor`, and `remove` (how many of its statements are
 * removals), `write`, `reset` when there are some. One writer per subscription: its lookups carry
 * the IRIs from one message to the next.
 */
export class JellyEventWriter {
  private readonly w = new JellyWriter({ physical: 1, streamType: 1 })

  frame(event: string, e: Partial<SourceEvent> & { cursor: number }): Uint8Array {
    const remove = e.remove ?? []
    const out: Uint8Array[] = []
    for (const q of [...remove, ...(e.add ?? [])]) for (const f of this.w.add(q)) out.push(delimit(f))
    if (e.add?.length || remove.length) this.w.endMessage()
    const meta: Record<string, Uint8Array> = { event: utf8.encode(event), cursor: utf8.encode(String(e.cursor)) }
    if (remove.length) meta.remove = utf8.encode(String(remove.length))
    if (e.write) meta.write = utf8.encode(e.write)
    if (e.reset) meta.reset = utf8.encode('true')
    out.push(delimit(this.w.flush(meta)!))
    if (out.length === 1) return out[0]!
    const bytes = new Uint8Array(out.reduce((n, f) => n + f.length, 0))
    out.reduce((at, f) => (bytes.set(f, at), at + f.length), 0)
    return bytes
  }
}

/** The messages of a Jelly stream (JellyEventWriter's), as they arrive. */
export async function* jellySourceEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: SourceEvent }> {
  const reader = body.getReader()
  const split = new FrameSplitter()
  const jelly = new JellyReader(DataFactory as unknown as JellyFactory)
  let quads: Quad[] = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return split.end()
      for (const frame of split.push(value)) {
        let meta = new Map<string, Uint8Array>()
        jelly.frame(frame, { quad: (q) => void quads.push(q), metadata: (m) => void (meta = m) })
        const get = (k: string) => (meta.has(k) ? text.decode(meta.get(k)) : undefined)
        const event = get('event')
        // A message's statements may span frames; its last frame says what it is.
        if (!event) continue
        const removes = Number(get('remove') ?? 0)
        const write = get('write')
        const data: SourceEvent = { cursor: Number(get('cursor')), remove: quads.slice(0, removes), add: quads.slice(removes), ...(write && { write }), ...(get('reset') && { reset: true }) }
        quads = []
        yield { event, data }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Server-sent events from a stream of text: each `event:` with its `data:` (comments, used to keep the connection alive, are skipped). */
export async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        if (data.length) yield { event, data: data.join('\n') }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
