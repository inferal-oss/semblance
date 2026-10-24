import type { Quad, Quad_Graph, Term } from '@rdfjs/types'
import type * as Ox from 'oxigraph'
import type { Factory, GraphStore } from './types.ts'

/**
 * Oxigraph adapter. The module is injected because Node (`oxigraph/node.js`)
 * and browsers (`oxigraph/web.js`, needs `init()`) load it differently.
 */
export function oxigraphStore(ox: typeof Ox): GraphStore {
  const store = new ox.Store()
  const factory = ox as unknown as Factory
  return {
    kind: 'oxigraph',
    factory,
    sparql: true,
    add: (q) => store.add(q as Ox.Quad),
    delete: (q) => store.delete(q as Ox.Quad),
    has: (q) => store.has(q as Ox.Quad),
    match: (s, p, o, g) => store.match(s as Ox.Term, p as Ox.Term, o as Ox.Term, g as Ox.Term) as unknown as Quad[],
    select(query: string, graphs: Quad_Graph[]) {
      return store.query(query, { default_graph: graphs as Ox.NamedNode[] }) as unknown as Map<string, Term>[]
    },
    construct(query: string, graphs: Quad_Graph[]): Quad[] {
      return store.query(query, { default_graph: graphs as Ox.NamedNode[] }) as unknown as Quad[]
    },
    loadTurtle: (text) => store.load(text, { format: 'text/turtle' }),
  }
}

