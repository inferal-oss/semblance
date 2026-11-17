import { DataFactory, Parser, Store } from 'n3'
import type { Quad } from '@rdfjs/types'
import { dumpJellyOf, jellyFramesOf, jellyReaderInto, readJellyInto } from '../jelly/store.ts'
import type { Factory, GraphStore, StoreCompaction } from './types.ts'

/** The numbers N3 has given out: one per distinct term it was ever given (its dictionary). */
const dictionary = (s: Store) => (s as unknown as { _entityIndex: { _id: number } })._entityIndex._id

/** N3.js adapter: fast JS-native matching, no SPARQL (function rules only). */
export function n3Store(): GraphStore {
  let store = new Store()
  // N3 never frees a term's number, so the terms of quads that went (each event's IRIs, each value
  // typed) stay in its dictionary. Once it has grown by half since the last copy, idle time copies the
  // live quads into a fresh store a slice at a time, writes going to both meanwhile, and swaps when
  // complete (as the hybrid store rebuilds Oxigraph's copy); compact() copies at once.
  let live = -1 // the dictionary after the last copy; -1 until the first upkeep measures it
  let rebuild: { fresh: Store; todo: Quad[]; next: number } | undefined
  const due = () => {
    if (live < 0) live = dictionary(store)
    return dictionary(store) > live * 1.5 + REBUILD_MIN
  }
  const add = (q: Quad) => {
    store.addQuad(q as never)
    rebuild?.fresh.addQuad(q as never)
  }
  /** Copy what is left of the rebuild, until `until` (performance.now()); whether it is complete. */
  const copy = (until: number) => {
    const r = rebuild!
    while (r.next < r.todo.length && performance.now() < until) {
      const end = Math.min(r.todo.length, r.next + 256)
      // A quad deleted since the snapshot was taken is gone from the store: skip it.
      for (; r.next < end; r.next++) if (store.has(r.todo[r.next] as never)) r.fresh.addQuad(r.todo[r.next] as never)
    }
    if (r.next < r.todo.length) return false
    store = r.fresh
    live = dictionary(store)
    rebuild = undefined
    return true
  }
  const start = () => (rebuild ??= { fresh: new Store(), todo: store.getQuads(null, null, null, null) as unknown as Quad[], next: 0 })
  return {
    kind: 'n3',
    factory: DataFactory as unknown as Factory,
    sparql: false,
    add,
    delete(q) {
      store.removeQuad(q as never)
      rebuild?.fresh.removeQuad(q as never)
    },
    has: (q) => store.has(q as never),
    match: (s, p, o, g) => store.getQuads(s as never, p as never, o as never, g as never) as unknown as Quad[],
    select() {
      throw new Error('The N3.js store has no SPARQL engine')
    },
    construct() {
      throw new Error('The N3.js store has no SPARQL engine; use function rules (prefer: "function")')
    },
    query: () => Promise.reject(new Error('The N3.js store has no SPARQL engine')),
    loadTurtle: (text) => {
      for (const q of new Parser().parse(text)) add(q as Quad)
    },
    loadJelly: (bytes, graph) => readJellyInto(add, bytes, graph),
    dumpJelly: (graph, options) => dumpJellyOf(store.getQuads(null, null, null, (graph ?? null) as never) as unknown as Quad[], options),
    jellyReader: (graph) => jellyReaderInto(add, graph),
    jellyFrames: (graph, options) => jellyFramesOf(store.match(null, null, null, (graph ?? null) as never) as unknown as Iterable<Quad>, options),
    size: () => store.size,
    footprint: () => ({ terms: dictionary(store) }),
    maintain(budgetMs) {
      if (!rebuild && !due()) return false
      if (budgetMs <= 0) return true
      // A copy that spans many writes keeps the terms of what they took away again: once it has
      // outgrown the bound itself, it starts over.
      if (rebuild && dictionary(rebuild.fresh) > live * 1.5 + REBUILD_MIN) rebuild = undefined
      start()
      return !copy(performance.now() + budgetMs)
    },
    // With `below`, only when the dictionary has outgrown the live terms (as idle time would copy).
    compact(opts = {}): StoreCompaction | undefined {
      if (opts.below !== undefined && !rebuild && !due()) return undefined
      const t = performance.now()
      // At once, from what is stored now (a copy under way may hold terms of quads gone since).
      rebuild = undefined
      start()
      copy(Infinity)
      // Nothing outside the JavaScript heap: no bytes to measure, before or after.
      return { before: 0, after: 0, quads: store.size, terms: live, ms: performance.now() - t }
    },
  }
}

// Not for small dictionaries: a copy of a store that has barely changed would not win.
const REBUILD_MIN = 5_000
