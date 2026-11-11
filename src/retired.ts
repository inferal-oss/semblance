// What the ontology says has gone (ontology/layers/retired.ttl, #473): a page reads it, to move what
// arrives written against an older framework, or to report it. Costs nothing while nothing has retired.
import type { Quad, Term } from '@rdfjs/types'
import { frameworkPrefixes, renameText } from './migrate/rename.ts'
import { NS, RDF_TYPE } from './ns.ts'
import type { GraphStore } from './store/types.ts'

export interface Retired {
  /** Every retired term. */
  terms: ReadonlySet<string>
  /** Those that were renamed, with their name now. */
  renames: ReadonlyMap<string, string>
}

const NONE: Retired = { terms: new Set(), renames: new Map() }

export function readRetired(store: GraphStore): Retired {
  const f = store.factory
  const quads = store.match(null, f.namedNode(RDF_TYPE), f.namedNode(NS.sem + 'RetiredTerm'))
  if (!quads.length) return NONE
  return {
    terms: new Set(quads.map((q) => q.subject.value)),
    renames: new Map(store.match(null, f.namedNode(NS.mig + 'renamedTo'), null).map((q) => [q.subject.value, q.object.value])),
  }
}

/** Authored Turtle with every renamed term in its new name, and what it still names that has gone. */
export function migrateAuthored(text: string, retired: Retired): { text: string; moved: string[]; gone: string[] } {
  if (!retired.terms.size) return { text, moved: [], gone: [] }
  const moved = new Set<string>()
  const gone = new Set<string>()
  const renamed = renameText(text, { terms: new Map(retired.renames), slugs: new Map() }, frameworkPrefixes, (o) => void (o.place === 'code' && moved.add(o.term)))
  const remaining = new Map([...retired.terms].filter((t) => !retired.renames.has(t)).map((t) => [t, t]))
  renameText(renamed, { terms: remaining, slugs: new Map() }, frameworkPrefixes, (o) => void (o.place === 'code' && gone.add(o.term)))
  return { text: renamed, moved: [...moved], gone: [...gone] }
}

/** The first retired term a triple names, if any. */
export function retiredIn(q: Quad, retired: Retired): string | undefined {
  for (const t of [q.subject, q.predicate, q.object] as Term[]) if (t.termType === 'NamedNode' && retired.terms.has(t.value)) return t.value
  return undefined
}

/** Remembered triples under the names of today; undefined if one names a term that went without a new name. */
export function migrateQuads(quads: Quad[], retired: Retired, f: GraphStore['factory']): Quad[] | undefined {
  if (!retired.terms.size) return quads
  const out: Quad[] = []
  for (const q of quads) {
    const named = (t: Term): Term => (t.termType === 'NamedNode' && retired.renames.has(t.value) ? f.namedNode(retired.renames.get(t.value)!) : t)
    const moved = f.quad(named(q.subject) as Quad['subject'], named(q.predicate) as Quad['predicate'], named(q.object) as Quad['object'], q.graph)
    if ([moved.subject, moved.predicate, moved.object].some((t) => t.termType === 'NamedNode' && retired.terms.has(t.value) && !retired.renames.has(t.value))) return undefined
    out.push(moved)
  }
  return out
}
