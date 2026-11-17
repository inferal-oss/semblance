// A chunk of offloaded history as it is stored (docs/RETENTION.md §6.2): one Jelly stream of
// triples (src/jelly/, the TypeScript codec, so every store reads and writes it alike), the
// members' closures in order, and the members themselves (IRI, sequence, time) in its last frame's
// metadata. Bytes where the storage holds them (IndexedDB), base64 text where it holds strings.
//
// What a stored value is, it says itself, so no marker of its own is needed: bytes, or text that is
// not JSON, are a Jelly stream (whose options carry the Jelly version); text that starts with '{' is
// a chunk of the earlier layout, `{ members, nt }` with the closures as N-Triples, still read.
import type { BlankNode, NamedNode, Quad, Term } from '@rdfjs/types'
import { DataFactory, Parser } from 'n3'
import { frames, type JellyFactory, JellyReader } from '../jelly/decode.ts'
import { delimit, JellyWriter } from '../jelly/encode.ts'
import { ProtoReader, ProtoWriter } from '../jelly/wire.ts'
import type { Backend } from '../persistence.ts'
import type { Factory } from '../store/types.ts'
import type { Member } from './policy.ts'

/** The metadata key of a chunk's members. */
export const MEMBERS = 'semblance:members'

/**
 * A reader that keeps blank-node labels: a label read back is the node that was written, not a
 * fresh one per document. Offloaded members are minted IRIs, but what they recorded (an undo's
 * rdf:Statement objects) can be any term of the app's graph, a blank node included.
 */
class KeepingReader extends JellyReader {
  override blankNode(label: string): BlankNode {
    return DataFactory.blankNode(label)
  }
}

/**
 * A store's factory as a reader's: blank nodes by label (a store takes any blank node by its label;
 * the stores' factories make none of their own).
 */
function readerFactory(f: Factory): JellyFactory {
  return {
    namedNode: (v) => f.namedNode(v),
    blankNode: (label) => DataFactory.blankNode(label),
    literal: (v, l) => f.literal(v, l as string | NamedNode),
    defaultGraph: () => f.defaultGraph(),
    quad: (s, p, o, g) => f.quad(s, p, o, g),
  }
}

const utf8 = new TextEncoder()
const text = new TextDecoder()
const zig = (d: number) => (d >= 0 ? 2 * d : -2 * d - 1)
const unzig = (z: number) => (z % 2 === 0 ? z / 2 : -(z + 1) / 2)

/** Members, compactly: each IRI as what it shares with the one before and the rest, sequence and time as differences. */
function writeMembers(members: Member[]): Uint8Array {
  const w = new ProtoWriter()
  w.varint(members.length)
  let iri = new Uint8Array(0)
  let seq = 0
  let at = 0
  for (const m of members) {
    const b = utf8.encode(m.iri)
    let shared = 0
    while (shared < b.length && shared < iri.length && b[shared] === iri[shared]) shared++
    w.varint(shared)
    w.varint(b.length - shared)
    w.bytes(b.subarray(shared))
    w.varint(zig(m.seq - seq))
    w.varint(zig(m.at - at))
    ;[iri, seq, at] = [b, m.seq, m.at]
  }
  return w.finish().slice()
}

function readMembers(bytes: Uint8Array): Member[] {
  const r = new ProtoReader(bytes)
  const out: Member[] = []
  let iri = new Uint8Array(0)
  let seq = 0
  let at = 0
  for (let n = r.varint(); n > 0; n--) {
    const shared = r.varint()
    const [s, e] = r.len()
    const b = new Uint8Array(shared + e - s)
    b.set(iri.subarray(0, shared))
    b.set(bytes.subarray(s, e), shared)
    iri = b
    seq += unzig(r.varint())
    at += unzig(r.varint())
    out.push({ iri: text.decode(b), seq, at })
  }
  return out
}

/** Members and their closures (in one graph) as one Jelly stream of triples. */
export function encodeChunk(members: Member[], closures: Quad[][], f: Factory): Uint8Array {
  const w = new JellyWriter({ physical: 1 })
  const parts: Uint8Array[] = []
  for (const quads of closures) for (const q of quads) for (const frame of w.add(f.quad(q.subject, q.predicate, q.object))) parts.push(delimit(frame))
  parts.push(delimit(w.flush({ [MEMBERS]: writeMembers(members) })!))
  let size = 0
  for (const p of parts) size += p.length
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) out.set(p, (at += p.length) - p.length)
  return out
}

/** A stored chunk read back: its members, and their triples in `graph`. */
export function decodeChunk(value: Uint8Array | string, graph: Term, f: Factory): { members: Member[]; quads: Quad[] } {
  if (typeof value === 'string') {
    const { members, nt } = JSON.parse(value) as { members: Member[]; nt: string }
    const term = (t: Term): Term => (t.termType === 'NamedNode' ? f.namedNode(t.value) : t.termType === 'BlankNode' ? DataFactory.blankNode(t.value) : t.termType === 'Literal' ? f.literal(t.value, t.language || f.namedNode(t.datatype.value)) : t)
    // blankNodePrefix '': the labels as written, not renamed per document.
    const quads = new Parser({ format: 'N-Triples', blankNodePrefix: '' }).parse(nt).map((q) => f.quad(term(q.subject as Term), term(q.predicate as Term), term(q.object as Term), graph))
    return { members, quads }
  }
  const reader = new KeepingReader(readerFactory(f))
  let members: Member[] | undefined
  const quads: Quad[] = []
  const sink = {
    quad: (q: Quad) => void quads.push(f.quad(q.subject, q.predicate, q.object, graph)),
    metadata: (m: Map<string, Uint8Array>) => {
      const b = m.get(MEMBERS)
      if (b) members = readMembers(b)
    },
  }
  for (const frame of frames(value)) reader.frame(frame, sink)
  reader.end(sink)
  if (!members) throw new Error('a stored chunk without its members')
  return { members, quads }
}

/** Write a chunk: as bytes where the storage holds them, else as base64 text. */
export function storeChunk(b: Backend, key: string, bytes: Uint8Array): Promise<void> {
  return b.setBytes ? b.setBytes(key, bytes) : b.set(key, toBase64(bytes))
}

/** Read a chunk as it was stored: bytes, or a chunk of the earlier layout (JSON text). Undefined when it is gone. */
export async function loadChunk(b: Backend, key: string): Promise<Uint8Array | string | undefined> {
  const bytes = await b.getBytes?.(key)
  if (bytes) return bytes
  const raw = await b.get(key)
  if (raw === undefined) return undefined
  return raw.startsWith('{') ? raw : fromBase64(raw)
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
