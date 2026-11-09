import type { Quad, Quad_Graph, Quad_Object, Quad_Predicate, Quad_Subject, Term } from '@rdfjs/types'
import type * as Ox from 'oxigraph'
import { DataFactory } from 'n3'
import { dumpJellyOf, jellyFramesOf, jellyReaderInto, readJellyInto } from '../jelly/store.ts'
import type { Factory, GraphStore } from './types.ts'

const COMPACT_MIN = 5_000

const free = (t: unknown) => (t as { free?: () => void }).free?.()

/** A term of Oxigraph's as a plain RDF/JS one, its WebAssembly object released. */
function plainTerm(t: Ox.Term): Term {
  if (t.termType === 'Quad') return plainQuad(t as Ox.Quad)
  const f = DataFactory
  const plain = (): Term => {
    switch (t.termType) {
      case 'NamedNode':
        return f.namedNode(t.value)
      case 'BlankNode':
        return f.blankNode(t.value)
      case 'DefaultGraph':
        return f.defaultGraph()
      case 'Literal': {
        if (t.language) return f.literal(t.value, t.direction ? ({ language: t.language, direction: t.direction } as never) : t.language)
        const datatype = t.datatype
        const literal = f.literal(t.value, f.namedNode(datatype.value))
        free(datatype)
        return literal
      }
      default:
        throw new Error(`Oxigraph returned a ${t.termType} term`)
    }
  }
  const term = plain()
  free(t)
  return term
}

/** A quad of Oxigraph's as a plain RDF/JS one, its WebAssembly objects released. */
export function plainQuad(q: Ox.Quad): Quad {
  const quad = DataFactory.quad(plainTerm(q.subject as Ox.Term) as Quad_Subject, plainTerm(q.predicate as Ox.Term) as Quad_Predicate, plainTerm(q.object as Ox.Term) as Quad_Object, plainTerm(q.graph as Ox.Term) as Quad_Graph)
  free(q)
  return quad
}

/**
 * A query's result in plain RDF/JS terms: solutions, quads, or a boolean as it is. Each of Oxigraph's
 * own terms is a WebAssembly object that lives in its one memory, capped at 4 GiB, until it is freed
 * or a finalizer does so, and finalizers run only between tasks: a synchronous stretch of queries (a
 * test that sweeps a site) fills the memory with terms it no longer holds, and Oxigraph traps
 * ("RuntimeError: unreachable"). So no term of Oxigraph's outlives the call that returned it.
 */
export function plainResult<T>(result: unknown): T {
  if (!Array.isArray(result)) return result as T
  return result.map((r: Map<string, Ox.Term> | Ox.Quad) => (r instanceof Map ? new Map([...r].map(([k, t]) => [k, plainTerm(t)])) : plainQuad(r))) as T
}

/**
 * Oxigraph adapter. The module is injected because Node (`oxigraph/node.js`)
 * and browsers (`oxigraph/web.js`, needs `init()`) load it differently.
 */
export function oxigraphStore(ox: typeof Ox): GraphStore {
  let store = new ox.Store()
  // Terms the engine makes are plain RDF/JS objects (N3's), which Oxigraph accepts: each of its
  // own terms is a WASM object registered with a FinalizationRegistry, and making millions of them
  // (every namedNode() of every rule) left V8 a backlog of weak cells that made every collection,
  // and so every turn, slower the longer a page or a test process ran.
  const factory = DataFactory as unknown as Factory
  // Oxigraph's in-memory store keeps deleted quads as dead versions that every
  // later lookup of the same pattern walks, so a sliding window (a bounded log,
  // replaced metrics) gets slower forever. Rebuild from the live quads once the
  // deletions since the last rebuild reach half of them: amortized O(1) per write.
  // (The hybrid store rebuilds in idle slices instead; see hybrid.ts.)
  let deletes = 0
  let disposed = false
  let threshold = COMPACT_MIN
  const compact = () => {
    const live = store.match(null, null, null, null).map(plainQuad)
    const fresh = new ox.Store(live as Ox.Quad[])
    free(store)
    store = fresh
    deletes = 0
    threshold = Math.max(COMPACT_MIN, live.length / 2)
  }
  return {
    kind: 'oxigraph',
    factory,
    sparql: true,
    crossGraphMatch: true,
    add: (q) => store.add(q as Ox.Quad),
    delete: (q) => {
      store.delete(q as Ox.Quad)
      if (++deletes > threshold) compact()
    },
    has: (q) => store.has(q as Ox.Quad),
    match: (s, p, o, g) => store.match(s as Ox.Term, p as Ox.Term, o as Ox.Term, g as Ox.Term).map(plainQuad),
    select(query: string, graphs: Quad_Graph[]) {
      return plainResult(store.query(query, { default_graph: graphs as Ox.NamedNode[] }))
    },
    construct(query: string, graphs: Quad_Graph[]): Quad[] {
      return plainResult(store.query(query, { default_graph: graphs as Ox.NamedNode[] }))
    },
    loadTurtle: (text) => store.load(text, { format: 'text/turtle' }),
    loadJelly: (bytes, graph) => readJellyInto((q) => store.add(q as Ox.Quad), bytes, graph),
    dumpJelly: (graph, options) => dumpJellyOf(store.match(null, null, null, (graph ?? null) as Ox.Term).map(plainQuad), options),
    jellyReader: (graph) => jellyReaderInto((q) => store.add(q as Ox.Quad), graph),
    jellyFrames: (graph, options) => jellyFramesOf(store.match(null, null, null, (graph ?? null) as Ox.Term).map(plainQuad), options),
    size: () => store.size,
    dispose() {
      // Once only: freeing twice would hand Oxigraph a dangling pointer.
      if (disposed) return
      disposed = true
      free(store)
    },
  }
}

