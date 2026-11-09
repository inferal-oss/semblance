// Jelly for the stores without an engine of their own (N3, Oxigraph, hybrid): the TypeScript
// codec reads into a store and writes what it holds. Engine stores read and write natively
// (rdf-engine/host/store.ts). docs/JELLY.md.
import type { Quad, Quad_Graph } from '@rdfjs/types'
import { DataFactory } from 'n3'
import type { GraphStore } from '../store/types.ts'
import { FrameSplitter, type JellyFactory, frames, JellyReader } from './decode.ts'
import { delimit, JellyWriter, writeJelly, type JellyWriterOptions } from './encode.ts'

/** What `GraphStore.dumpJelly` takes: the writer's options, but always a stream of quads. */
export type JellyDumpOptions = Omit<JellyWriterOptions, 'physical'>

/** Read a whole stream (delimited, or one bare frame) and add its statements; a stream of triples goes to `graph`. */
export function readJellyInto(add: (q: Quad) => void, bytes: Uint8Array, graph?: Quad_Graph, f: JellyFactory = DataFactory as unknown as JellyFactory): number {
  const reader = new JellyReader(f, undefined, graph ?? f.defaultGraph())
  // All or nothing, as the engines' `load`: the statements are added once every frame has read.
  const quads: Quad[] = []
  const sink = { quad: (q: Quad) => void quads.push(q) }
  for (const frame of frames(bytes)) reader.frame(frame, sink)
  for (const q of quads) add(q)
  return quads.length
}

/** Statements as a whole Jelly stream of quads. */
export function dumpJellyOf(quads: Iterable<Quad>, options: JellyDumpOptions = {}): Uint8Array {
  return writeJelly(quads, { ...options, physical: 2 })
}

/** A store's reader of one Jelly stream (GraphStore.jellyReader): a frame at a time, each frame's statements added as it is read. */
export interface JellyStoreReader {
  /** Read one bare frame into the store; returns how many statements it had. A frame is all or nothing. */
  frame(bytes: Uint8Array): number
  /** The end of the stream (the reader may not be used afterwards). */
  end(): void
}

/** A reader that adds through `add`, with the TypeScript codec. */
export function jellyReaderInto(add: (q: Quad) => void, graph?: Quad_Graph, f: JellyFactory = DataFactory as unknown as JellyFactory): JellyStoreReader {
  const reader = new JellyReader(f, undefined, graph ?? f.defaultGraph())
  return {
    frame(bytes) {
      const quads: Quad[] = []
      reader.frame(bytes, { quad: (q) => void quads.push(q) })
      for (const q of quads) add(q)
      return quads.length
    },
    end() {},
  }
}

/** Statements as delimited Jelly frames, each as soon as it is written. */
export function* jellyFramesOf(quads: Iterable<Quad>, options: JellyDumpOptions = {}): Generator<Uint8Array> {
  const w = new JellyWriter({ ...options, physical: 2 })
  for (const q of quads) for (const f of w.add(q)) yield delimit(f)
  yield delimit(w.flush()!)
}

/** Chunks of a fetch body, a Node stream or any async iterable of bytes. */
async function* chunks(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    yield* body as AsyncIterable<Uint8Array>
    return
  }
  const r = (body as ReadableStream<Uint8Array>).getReader()
  try {
    for (;;) {
      const { value, done } = await r.read()
      if (done) return
      yield value
    }
  } finally {
    r.releaseLock()
  }
}

/**
 * Load a Jelly stream into a store as it arrives (a fetch body, a file read in pieces): each frame
 * is added once it is whole, so memory holds one frame at a time. Unlike loadJelly, a stream that
 * breaks part-way leaves the frames before the break in the store. Returns how many statements it read.
 */
export async function loadJellyStream(store: GraphStore, body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, graph?: Quad_Graph): Promise<number> {
  const reader = store.jellyReader?.(graph) ?? jellyReaderInto((q) => store.add(q), graph)
  const split = new FrameSplitter()
  let n = 0
  try {
    for await (const chunk of chunks(body)) for (const frame of split.push(chunk)) n += reader.frame(frame)
    split.end()
  } finally {
    reader.end()
  }
  return n
}

/** What a store holds (in `graph` or every graph) as a stream of Jelly frames, written as it is read. */
export function dumpJellyStream(store: GraphStore, graph?: Quad_Graph, options: JellyDumpOptions = {}): ReadableStream<Uint8Array> {
  let it: Iterator<Uint8Array> | undefined
  return new ReadableStream({
    pull(c) {
      it ??= (store.jellyFrames?.(graph, options) ?? jellyFramesOf(store.match(null, null, null, graph ?? null), options))[Symbol.iterator]()
      const x = it.next()
      if (x.done) c.close()
      else c.enqueue(x.value)
    },
    cancel() {
      it?.return?.()
    },
  })
}
