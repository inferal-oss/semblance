// Lookups for dependency probes (deps.ts), shared within a tick (#137). A probe walks from a
// changed triple toward a partition key through the store's indexes; a tick's probes - every view's,
// every pattern's, every changed triple's - ask the same few questions again and again (in a batch
// of fifty orders, 8,466 lookups, 524 distinct). Within a tick the input graphs do not change (views
// write only the views graph; rules only their derived graphs), so each distinct lookup is asked of
// the store once and remembered until the tick ends; and where one match across graphs costs what
// one in a graph does (GraphStore.crossGraphMatch: each call crosses into WebAssembly), it is one
// call for all of the dataset's graphs instead of one per graph.
import type { Quad, Term } from '@rdfjs/types'
import { termKey } from '../rdf.ts'
import type { GraphStore } from '../store/types.ts'
import type { Lookup } from './deps.ts'

/** Store calls made by lookups (the cost tests and the profile read it). */
export const probeCounters = { lookups: 0, storeCalls: 0 }

/**
 * Triples matching (s, p, o) in any of `graphs`: one call across graphs where that is as cheap as
 * one in a graph (store.crossGraphMatch), filtered to those graphs; else one call per graph.
 */
export function matchIn(store: GraphStore, graphs: readonly Term[], keys: ReadonlySet<string>, s: Term | null, p: Term | null, o: Term | null): Quad[] {
  if (store.crossGraphMatch && graphs.length > 1) {
    probeCounters.storeCalls++
    return store.match(s, p, o, null).filter((q) => keys.has(q.graph.value))
  }
  const out: Quad[] = []
  for (const g of graphs) {
    probeCounters.storeCalls++
    for (const q of store.match(s, p, o, g)) out.push(q)
  }
  return out
}

/**
 * A lookup over a dataset (`graphs`) with some triples put back (`removed`: the tick's removals, so
 * the old and the new state are seen together), remembered for as long as the object lives: one per
 * dataset per tick. Without `g`: the union default graph (a triple once). With it: quads of the named
 * graphs (`g` one of them, or null: any), each with its graph.
 */
export class GraphLookup {
  private readonly keys: Set<string>
  private readonly memo = new Map<string, Quad[]>()
  private readonly by = new Map<string, Quad[]>()

  constructor(
    private readonly store: GraphStore,
    private readonly graphs: readonly Term[],
    private readonly removed: readonly Quad[],
  ) {
    this.keys = new Set(graphs.map((g) => g.value))
    for (const q of removed) for (const k of ['s' + termKey(q.subject), 'p' + q.predicate.value, 'o' + termKey(q.object)]) {
      const l = this.by.get(k)
      if (l) l.push(q)
      else this.by.set(k, [q])
    }
  }

  readonly lookup: Lookup = (s, p, o, g) => {
    probeCounters.lookups++
    // A literal is never a subject, nor a predicate anything but an IRI: nothing matches (and a store may refuse to look).
    if ((s && s.termType === 'Literal') || (p && p.termType !== 'NamedNode')) return []
    const key = `${s ? termKey(s) : ''}\t${p ? p.value : ''}\t${o ? termKey(o) : ''}\t${g === undefined ? 'u' : g === null ? 'n' : termKey(g)}`
    const hit = this.memo.get(key)
    if (hit) return hit
    const named = g !== undefined
    const graphs = named ? this.graphs.filter((x) => x.termType === 'NamedNode' && (!g || x.equals(g))) : this.graphs
    const seen = new Set<string>()
    const out: Quad[] = []
    const put = (q: Quad) => {
      if (named && (q.graph.termType !== 'NamedNode' || (g && !q.graph.equals(g)))) return
      const k = termKey(q.subject) + ' ' + q.predicate.value + ' ' + termKey(q.object) + (named ? ' ' + q.graph.value : '')
      if (!seen.has(k)) seen.add(k), out.push(q)
    }
    if (graphs.length) for (const q of matchIn(this.store, graphs, named ? new Set(graphs.map((x) => x.value)) : this.keys, s ?? null, p ?? null, o ?? null)) put(q)
    if (this.removed.length) {
      const pool = s ? this.by.get('s' + termKey(s)) : o ? this.by.get('o' + termKey(o)) : p ? this.by.get('p' + p.value) : this.removed
      for (const q of pool ?? []) if ((!s || q.subject.equals(s)) && (!p || q.predicate.equals(p)) && (!o || q.object.equals(o))) put(q)
    }
    this.memo.set(key, out)
    return out
  }
}
