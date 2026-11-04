import type { Quad } from '@rdfjs/types'
import type * as Ox from 'oxigraph'
import { Parser } from 'n3'
import { n3Store } from './n3.ts'
import { plainResult } from './oxigraph.ts'
import type { GraphStore } from './types.ts'

/**
 * Oxigraph for SPARQL, an N3.js mirror for pattern matching. Every write goes
 * to both; `match` (the hot path for function rules) never crosses into WASM.
 * Query results are copied into the mirror's terms (plainResult).
 */
export function hybridStore(ox: typeof Ox): GraphStore {
  let sparql = new ox.Store()
  const mirror = n3Store()
  const m = mirror.factory

  // Oxigraph keeps deleted quads as dead versions that later lookups walk (see
  // oxigraph.ts). Here the live quads are known in JS (the mirror), so the
  // SPARQL side is rebuilt a slice at a time in idle time, writes going to both
  // copies meanwhile, and swapped when complete: no pause, bounded dead weight.
  let deletes = 0
  let live = 0 // the size at the last rebuild: a good enough estimate of the live set
  let rebuild: { fresh: Ox.Store; todo: Quad[]; next: number } | undefined
  const due = () => deletes > Math.max(REBUILD_MIN, live / 2)

  const add = (q: Quad) => {
    sparql.add(q as Ox.Quad)
    rebuild?.fresh.add(q as Ox.Quad)
    mirror.add(q)
  }

  let disposed = false
  return {
    kind: 'hybrid',
    // Mirror terms are plain JS objects and Oxigraph accepts any RDF/JS term,
    // so the mirror's factory is the cheaper one to hand out.
    factory: m,
    sparql: true,
    add,
    delete(q) {
      sparql.delete(q as Ox.Quad)
      rebuild?.fresh.delete(q as Ox.Quad)
      mirror.delete(q)
      deletes++
    },
    has: (q) => mirror.has(q),
    match: (s, p, o, g) => mirror.match(s, p, o, g),
    select: (query, graphs) => plainResult(sparql.query(query, { default_graph: graphs as Ox.NamedNode[] })),
    construct: (query, graphs) => plainResult(sparql.query(query, { default_graph: graphs as Ox.NamedNode[] })),
    // Parsed once: two parsers would label a blank node two ways, and what a query answers (Oxigraph's
    // label) would name nothing `match` can find (the mirror's).
    loadTurtle(text) {
      for (const q of new Parser().parse(text)) add(q as Quad)
    },
    dispose() {
      if (disposed) return
      disposed = true
      const free = (st: Ox.Store | undefined) => (st as unknown as { free?: () => void } | undefined)?.free?.()
      free(sparql)
      free(rebuild?.fresh)
      rebuild = undefined
    },
    maintain(budgetMs) {
      const until = performance.now() + budgetMs
      if (!rebuild) {
        if (!due()) return false
        rebuild = { fresh: new ox.Store(), todo: mirror.match(null, null, null, null), next: 0 }
        deletes = 0
      }
      const r = rebuild
      while (r.next < r.todo.length && performance.now() < until) {
        const end = Math.min(r.todo.length, r.next + 256)
        // A quad deleted since the snapshot was taken is gone from the mirror: skip it.
        for (; r.next < end; r.next++) if (mirror.has(r.todo[r.next]!)) r.fresh.add(r.todo[r.next] as Ox.Quad)
      }
      if (r.next < r.todo.length) return true
      ;(sparql as unknown as { free?: () => void }).free?.()
      sparql = r.fresh
      live = r.todo.length
      rebuild = undefined
      return due()
    },
  }
}

const REBUILD_MIN = 5_000
