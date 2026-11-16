// Numbers for #433: a remote source's stream (docs/REMOTE.md) as it is sent now (server-sent
// events, JSON with N-Triples) and as Jelly frames (one per event, the cursor and the number of
// removals in the frame's metadata), for a todo list: a snapshot of 300 todos, then 2,000 deltas
// (labels edited, todos ticked, added, removed). Bytes raw, and gzip with a flush after every event
// (what a server compressing a live stream sends). Not a test.
//   npx tsx scripts/jelly-remote-measure.ts
import { constants, createGzip } from 'node:zlib'
import type { Quad } from '@rdfjs/types'
import { DataFactory as F } from 'n3'
import { delimit, JellyWriter } from '../src/jelly/encode.ts'
import { frames, JellyReader } from '../src/jelly/decode.ts'
import { fromNTriples, toNTriples } from '../src/source-protocol.ts'

const EX = 'https://example.org/todo#'
const p = { type: F.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), label: F.namedNode(EX + 'label'), done: F.namedNode(EX + 'done') }
const Todo = F.namedNode(EX + 'Todo')
const bool = (b: boolean) => F.literal(String(b), F.namedNode('http://www.w3.org/2001/XMLSchema#boolean'))
const todo = (n: number) => F.namedNode(EX + 'item-' + n)
let seed = 7
const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n)
const WORDS = ['buy', 'milk', 'call', 'mom', 'fix', 'the', 'bike', 'write', 'report', 'water', 'plants', 'book', 'flights']
const label = () => Array.from({ length: 2 + rand(4) }, () => WORDS[rand(WORDS.length)]).join(' ')

const state = new Map<number, { label: string; done: boolean }>()
const statements = (n: number) => {
  const t = state.get(n)!
  return [F.quad(todo(n), p.type, Todo), F.quad(todo(n), p.label, F.literal(t.label)), F.quad(todo(n), p.done, bool(t.done))]
}
for (let n = 0; n < 300; n++) state.set(n, { label: label(), done: false })
const snapshot = [...state.keys()].flatMap(statements)
type Event = { cursor: number; add: Quad[]; remove: Quad[] }
const events: Event[] = []
let next = 300
for (let cursor = 1; cursor <= 2000; cursor++) {
  const ids = [...state.keys()]
  const n = ids[rand(ids.length)]!
  const t = state.get(n)!
  const k = rand(10)
  if (k < 5) {
    const old = F.quad(todo(n), p.label, F.literal(t.label))
    t.label = label()
    events.push({ cursor, remove: [old], add: [F.quad(todo(n), p.label, F.literal(t.label))] })
  } else if (k < 8) {
    const old = F.quad(todo(n), p.done, bool(t.done))
    t.done = !t.done
    events.push({ cursor, remove: [old], add: [F.quad(todo(n), p.done, bool(t.done))] })
  } else if (k < 9) {
    state.set(next, { label: label(), done: false })
    events.push({ cursor, remove: [], add: statements(next++) })
  } else {
    events.push({ cursor, remove: statements(n), add: [] })
    state.delete(n)
  }
}

// Now: server-sent events, as SourceServer writes them.
const sse = [`event: snapshot\ndata: ${JSON.stringify({ cursor: 0, add: toNTriples(snapshot) })}\n\n`, ...events.map((e) => `event: delta\ndata: ${JSON.stringify({ cursor: e.cursor, add: toNTriples(e.add), remove: toNTriples(e.remove) })}\n\n`)].map((s) => new TextEncoder().encode(s))

// Jelly: one stream, a frame per event; removals first, their number and the cursor in the metadata.
const w = new JellyWriter({ physical: 1, streamType: 1 })
const meta = (cursor: number, remove: number) => ({ cursor: new TextEncoder().encode(String(cursor)), ...(remove ? { remove: new TextEncoder().encode(String(remove)) } : {}) })
const frame = (add: Quad[], remove: Quad[], cursor: number) => {
  for (const q of [...remove, ...add]) if (w.add(q).length) throw new Error('frame ended early')
  w.endMessage()
  return delimit(w.flush(meta(cursor, remove.length))!)
}
const jelly = [frame(snapshot, [], 0), ...events.map((e) => frame(e.add, e.remove, e.cursor))]

const flushed = async (chunks: Uint8Array[]) => {
  const z = createGzip({ level: 6 })
  let n = 0
  z.on('data', (d: Buffer) => (n += d.length))
  for (const c of chunks) {
    z.write(c)
    await new Promise<void>((done) => z.flush(constants.Z_SYNC_FLUSH, () => done()))
  }
  await new Promise<void>((done) => z.end(done))
  return n
}
const sum = (cs: Uint8Array[]) => cs.reduce((n, c) => n + c.length, 0)
const kib = (n: number) => (n / 1024).toFixed(1) + ' KiB'
console.log(`a snapshot of ${snapshot.length} statements, then ${events.length} deltas (${events.reduce((n, e) => n + e.add.length + e.remove.length, 0)} statements)`)
for (const [name, chunks] of [['SSE, JSON + N-Triples (now)', sse], ['Jelly, a frame per event', jelly]] as const) {
  const deltas = chunks.slice(1)
  console.log(`  ${name.padEnd(28)} snapshot ${kib(chunks[0]!.length).padStart(10)}, deltas ${kib(sum(deltas)).padStart(10)} (${(sum(deltas) / deltas.length).toFixed(1)} B each); gzip, flushed per event: ${kib(await flushed(chunks))}`)
}
// Reading: parse every event.
const t0 = performance.now()
for (let i = 0; i < 20; i++)
  for (const c of sse) {
    const m = JSON.parse(new TextDecoder().decode(c).split('data: ')[1]!)
    fromNTriples(m.add, F)
    if (m.remove) fromNTriples(m.remove, F)
  }
const t1 = performance.now()
const all = new Uint8Array(sum(jelly))
jelly.reduce((at, c) => (all.set(c, at), at + c.length), 0)
for (let i = 0; i < 20; i++) {
  const r = new JellyReader(F as never)
  for (const f of frames(all)) r.frame(f, { quad() {}, metadata() {} })
}
const t2 = performance.now()
console.log(`  decode (TypeScript, no store): SSE (JSON and N-Triples) ${((t1 - t0) / 20).toFixed(1)} ms, Jelly to statements ${((t2 - t1) / 20).toFixed(1)} ms`)
