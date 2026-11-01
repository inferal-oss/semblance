// Triple lookups for dependency probes (deps.ts), for maintained views and for rules' exact
// dependencies alike: the store's matches over a dataset's graphs, with the change's removed
// triples put back (the old and the new state together). A probe crosses into the store once per
// lookup, and a batch makes thousands (docs/IVM.md §9.3, #137), so a lookup
// - asks across all graphs once where that costs what asking one does (store.crossGraphMatch) and
//   a node is bound (a few quads), then keeps the dataset's graphs, instead of asking graph by graph;
// - is answered once per probe set: the same lookup again (another change binding the same node,
//   another pattern through it) is remembered while the store holds still - the lifetime of one
//   Lookup, which its maker creates for one step and drops.
import type { Quad, Term } from '@rdfjs/types'
import { termKey } from '../rdf.ts'
import type { GraphStore } from '../store/types.ts'
import type { Lookup } from './deps.ts'

/** The removed triples by subject ('s' + term key), predicate ('p' + IRI) and object ('o' + term key). */
export function indexRemoved(removed: readonly Quad[], by = new Map<string, Quad[]>()): Map<string, Quad[]> {
  const index = (k: string, q: Quad) => {
    const l = by.get(k)
    if (l) l.push(q)
    else by.set(k, [q])
  }
  for (const q of removed) {
    index('s' + termKey(q.subject), q)
    index('p' + q.predicate.value, q)
    index('o' + termKey(q.object), q)
  }
  return by
}

export interface ProbeLookupOptions {
  store: GraphStore
  /** The dataset's graphs, in order. */
  graphs: readonly Term[]
  /** The change's removed triples, and (optional) their index by `indexRemoved`. */
  removed: readonly Quad[]
  removedBy?: Map<string, Quad[]>
  /**
   * What a lookup with a graph means. 'named' (views, SPARQL's GRAPH): `g` one named graph of the
   * dataset, null any of them, and quads count with their graph; without `g`, the union default
   * graph (a triple once). 'any' (rules): `g` that graph, else every graph; a triple once.
   */
  graphMode: 'named' | 'any'
}

/** A memoized lookup over a dataset's graphs with removed triples put back (see the top of this file). */
export function probeLookup({ store, graphs, removed, removedBy, graphMode }: ProbeLookupOptions): Lookup {
  const by = removed.length ? (removedBy ?? indexRemoved(removed)) : undefined
  const index = new Map(graphs.map((g, i) => [g.value, i]))
  const cross = !!store.crossGraphMatch && index.size === graphs.length
  const memo = new Map<string, Quad[]>()
  /** Matches in the graphs `wanted` lets through, graph by graph in the dataset's order. */
  const inGraphs = (s: Term | null, p: Term | null, o: Term | null, wanted: (i: number) => boolean): Quad[] => {
    if (cross && (s || o)) {
      // One call across all graphs: keep the dataset's (in its order: a stable sort by graph).
      const all = store.match(s as never, p as never, o as never)
      let out: Quad[] = []
      let sorted = true
      let last = -1
      for (const q of all) {
        const i = index.get(q.graph.value)
        if (i === undefined || !wanted(i)) continue
        if (i < last) sorted = false
        last = i
        out.push(q)
      }
      if (!sorted) out = out.map((q, n) => [q, index.get(q.graph.value)! * all.length + n] as const).sort((a, b) => a[1] - b[1]).map((x) => x[0])
      return out
    }
    let out: Quad[] = []
    for (let i = 0; i < graphs.length; i++) {
      if (!wanted(i)) continue
      const found = store.match(s as never, p as never, o as never, graphs[i] as never)
      if (found.length) out = out.length ? out.concat(found) : found
    }
    return out
  }
  const fresh = (s: Term | null, p: Term | null, o: Term | null, g: Term | null | undefined): Quad[] => {
    const named = graphMode === 'named' && g !== undefined
    const out: Quad[] = []
    const seen = new Set<string>()
    const put = (q: Quad) => {
      if (named && (q.graph.termType !== 'NamedNode' || (g && !q.graph.equals(g)))) return
      if (!named && graphMode === 'any' && g && !q.graph.equals(g)) return
      const k = termKey(q.subject) + ' ' + q.predicate.value + ' ' + termKey(q.object) + (named ? ' ' + q.graph.value : '')
      if (!seen.has(k)) seen.add(k), out.push(q)
    }
    // A literal never is a subject, nor anything but an IRI a predicate: nothing matches.
    if ((s && s.termType === 'Literal') || (p && p.termType !== 'NamedNode')) return out
    let wanted: (i: number) => boolean = () => true
    if (named) wanted = (i) => graphs[i]!.termType === 'NamedNode' && (!g || graphs[i]!.equals(g))
    if (graphMode === 'any' && g) {
      // A graph of its own (not necessarily the dataset's): asked directly.
      for (const q of store.match(s as never, p as never, o as never, g as never)) put(q)
    } else for (const q of inGraphs(s, p, o, wanted)) put(q)
    if (by) {
      const pool = s ? by.get('s' + termKey(s)) : o ? by.get('o' + termKey(o)) : p ? by.get('p' + p.value) : removed
      for (const q of pool ?? []) if ((!s || q.subject.equals(s)) && (!p || q.predicate.equals(p)) && (!o || q.object.equals(o))) put(q)
    }
    return out
  }
  return (s, p, o, g) => {
    const k = (s ? termKey(s) : '') + '\u0001' + (p ? termKey(p) : '') + '\u0001' + (o ? termKey(o) : '') + '\u0001' + (g === undefined ? '-' : g ? termKey(g) : '*')
    let hit = memo.get(k)
    if (!hit) memo.set(k, (hit = fresh(s, p, o, g)))
    return hit
  }
}
