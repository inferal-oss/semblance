// What retention let go, and what still points at it (docs/RETENTION.md, ret:Reference): for the
// tests that check a long session leaves nothing behind its retired members.
import type { NamedNode, Quad } from '@rdfjs/types'
import { NS } from '../src/ns.ts'
import type { Runtime } from '../src/runtime.ts'
import type { GraphStore } from '../src/store/types.ts'

const TREE_MEMBER = NS.tree + 'member'

/**
 * Every member a retained stream let go, from now on: each leaves through its stream's closure. The
 * streams made later (the change log, at its first event) are watched as they are made.
 */
export function watchRetired(runtime: Runtime): Set<string> {
  const retired = new Set<string>()
  const r = runtime.retention
  const wrap = (host: { closure(m: NamedNode): Quad[] }) => {
    const closure = host.closure.bind(host)
    host.closure = (m) => (retired.add(m.value), closure(m))
  }
  for (const s of r.all()) wrap(s.host)
  const make = r.stream.bind(r)
  r.stream = (iri, host) => {
    const known = r.get(iri)
    if (known) return known
    wrap(host)
    return make(iri, host)
  }
  return retired
}

/**
 * The statements, in any graph, that point at a member no longer in memory (retired, and not a
 * member of any stream now), or that are about one.
 */
export function dangling(store: GraphStore, retired: Set<string>): string[] {
  const member = store.factory.namedNode(TREE_MEMBER)
  const gone = new Set([...retired].filter((iri) => !store.match(null, member, store.factory.namedNode(iri)).length))
  const out: string[] = []
  for (const q of store.match(null, null, null, null)) {
    if ((q.object.termType === 'NamedNode' && gone.has(q.object.value)) || gone.has(q.subject.value))
      out.push(`${q.subject.value} ${q.predicate.value} ${q.object.value} (${q.graph.value || 'default'})`)
  }
  return out
}
