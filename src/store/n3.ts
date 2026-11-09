import { DataFactory, Parser, Store } from 'n3'
import type { Quad } from '@rdfjs/types'
import { dumpJellyOf, jellyFramesOf, jellyReaderInto, readJellyInto } from '../jelly/store.ts'
import type { Factory, GraphStore } from './types.ts'

/** N3.js adapter: fast JS-native matching, no SPARQL (function rules only). */
export function n3Store(): GraphStore {
  const store = new Store()
  return {
    kind: 'n3',
    factory: DataFactory as unknown as Factory,
    sparql: false,
    add: (q) => void store.addQuad(q as never),
    delete: (q) => void store.removeQuad(q as never),
    has: (q) => store.has(q as never),
    match: (s, p, o, g) => store.getQuads(s as never, p as never, o as never, g as never) as unknown as Quad[],
    select() {
      throw new Error('The N3.js store has no SPARQL engine')
    },
    construct() {
      throw new Error('The N3.js store has no SPARQL engine; use function rules (prefer: "function")')
    },
    loadTurtle: (text) => store.addQuads(new Parser().parse(text)),
    loadJelly: (bytes, graph) => readJellyInto((q) => void store.addQuad(q as never), bytes, graph),
    dumpJelly: (graph, options) => dumpJellyOf(store.getQuads(null, null, null, (graph ?? null) as never) as unknown as Quad[], options),
    jellyReader: (graph) => jellyReaderInto((q) => void store.addQuad(q as never), graph),
    jellyFrames: (graph, options) => jellyFramesOf(store.match(null, null, null, (graph ?? null) as never) as unknown as Iterable<Quad>, options),
  }
}

