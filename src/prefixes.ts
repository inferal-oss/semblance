import { NS, SPARQL_PREFIXES } from './ns.ts'
import type { GraphStore } from './store/types.ts'

const SH = 'http://www.w3.org/ns/shacl#'

/**
 * SPARQL prefix declarations for a store: the framework's, plus any declared
 * in the graph itself (sh:declare style: a node with sh:prefix and sh:namespace).
 */
export function prefixesFor(store: GraphStore): string {
  const f = store.factory
  const declared = store
    .match(null, f.namedNode(SH + 'prefix'), null)
    .map((q) => [q.object.value, store.match(q.subject, f.namedNode(SH + 'namespace'), null)[0]?.object.value] as const)
    .filter(([p, ns]) => ns && !(p in NS))
    .map(([p, ns]) => `PREFIX ${p}: <${ns}>`)
  return [SPARQL_PREFIXES, ...new Set(declared)].join('\n')
}
