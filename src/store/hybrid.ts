import type * as Ox from 'oxigraph'
import { n3Store } from './n3.ts'
import { oxigraphStore } from './oxigraph.ts'
import type { GraphStore } from './types.ts'

/**
 * Oxigraph for SPARQL, an N3.js mirror for pattern matching. Every write goes
 * to both; `match` (the hot path for function rules) never crosses into WASM.
 * Terms are created with Oxigraph's factory and copied for the mirror.
 */
export function hybridStore(ox: typeof Ox): GraphStore {
  const sparql = oxigraphStore(ox)
  const mirror = n3Store()
  const m = mirror.factory
  const copy = (t: Ox.Term) =>
    t.termType === 'NamedNode'
      ? m.namedNode(t.value)
      : t.termType === 'Literal'
        ? m.literal(t.value, t.language || m.namedNode(t.datatype.value))
        : t.termType === 'DefaultGraph'
          ? m.defaultGraph()
          : (t as never)
  const mirrorQuad = (q: Ox.Quad) =>
    m.quad(copy(q.subject as Ox.Term), copy(q.predicate as Ox.Term), copy(q.object as Ox.Term), copy(q.graph as Ox.Term))
  return {
    kind: 'hybrid',
    // Mirror terms are plain JS objects and Oxigraph accepts any RDF/JS term,
    // so the mirror's factory is the cheaper one to hand out.
    factory: m,
    sparql: true,
    add(q) {
      sparql.add(q)
      mirror.add(q)
    },
    delete(q) {
      sparql.delete(q)
      mirror.delete(q)
    },
    has: (q) => mirror.has(q),
    match: (s, p, o, g) => mirror.match(s, p, o, g),
    select: (query, graphs) => sparql.select(query, graphs),
    construct: (query, graphs) => sparql.construct(query, graphs).map((q) => mirrorQuad(q as Ox.Quad)),
    loadTurtle(text) {
      sparql.loadTurtle(text)
      mirror.loadTurtle(text)
    },
  }
}
