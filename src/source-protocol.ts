// The protocol between a page and a store elsewhere (docs/REMOTE.md): what a page binds to
// (patterns), and the messages that carry a snapshot, the store's changes and the page's
// writes. Statements travel as N-Triples. Shared by the client effect (src/remote.ts) and the
// reference server (src/node/source-server.ts); any server that speaks it will do.
import type { Quad, Term } from '@rdfjs/types'
import { Parser, Writer } from 'n3'
import type { Factory } from './store/types.ts'

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
