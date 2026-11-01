// The graphs a page needs (#209): a page's client loads them first and the rest in idle time, so it
// is interactive before it has every graph of the site. The build finds them from a render of the
// page with function rules, whose reads are traced: a graph is needed when it states a triple the
// page read (a subject and predicate a rule read for something shown), describes a rule that has
// output, or a node with output, or a class of one. Then it checks: the page rendered with only
// those graphs must be the page rendered with all of them, byte for byte, or it gets all of them.
import type { Quad } from '@rdfjs/types'
import { Parser } from 'n3'
import type { Engine } from '../engine/engine.ts'
import { superclasses } from '../engine/rules.ts'
import { RDF_TYPE } from '../ns.ts'
import type { GraphStore } from '../store/types.ts'
import { PAGE_GRAPHS_META } from '../web/takeover.ts'

/** Which named graphs state what: by subject, and by subject and predicate. */
export interface GraphIndex {
  readonly names: readonly string[]
  readonly bySubject: ReadonlyMap<string, ReadonlySet<string>>
  readonly byStatement: ReadonlyMap<string, ReadonlySet<string>>
}

/** Index named Turtle graphs (name -> text) by the subjects and predicates they state. */
export function graphIndex(graphs: Record<string, string>): GraphIndex {
  const bySubject = new Map<string, Set<string>>()
  const byStatement = new Map<string, Set<string>>()
  const add = (m: Map<string, Set<string>>, k: string, name: string) => {
    let s = m.get(k)
    if (!s) m.set(k, (s = new Set()))
    s.add(name)
  }
  for (const [name, text] of Object.entries(graphs)) {
    for (const q of new Parser().parse(text) as Quad[]) {
      if (q.subject.termType !== 'NamedNode') continue
      add(bySubject, q.subject.value, name)
      add(byStatement, q.subject.value + ' ' + q.predicate.value, name)
    }
  }
  return { names: Object.keys(graphs), bySubject, byStatement }
}

/**
 * The graphs a page rendered with function rules needs (by name, in the index's order), with
 * `always` (the graphs every page loads first). Reads made for the projection's own agent (the
 * viewer: every term's label in its languages, kept whether or not a page shows it) are not counted:
 * the check against the full render says whether the page needs them.
 */
export function neededGraphs(index: GraphIndex, engine: Engine, store: GraphStore, always: Iterable<string> = []): string[] {
  const need = new Set(always)
  const subjects = new Set<string>()
  for (const { subject, focus, predicates } of engine.tracedReads()) {
    if (focus === engine.agent.value) continue
    if (predicates.has('*')) subjects.add(subject)
    else for (const p of predicates) for (const n of index.byStatement.get(subject + ' ' + p) ?? []) need.add(n)
  }
  const f = store.factory
  const supers = superclasses(store)
  for (const { rule, focus } of engine.produced()) {
    subjects.add(rule.iri).add(rule.slot)
    subjects.add(focus)
    for (const q of store.match(f.namedNode(focus), f.namedNode(RDF_TYPE), null)) for (const c of supers(q.object.value)) subjects.add(c)
  }
  for (const s of subjects) for (const n of index.bySubject.get(s) ?? []) need.add(n)
  return index.names.filter((n) => need.has(n))
}

/** The <meta> naming a page's graphs. */
export function pageGraphsMeta(names: readonly string[]): string {
  return `<meta name="${PAGE_GRAPHS_META}" content="${names.join(' ').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`
}
