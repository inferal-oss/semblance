// How a change comes in, for the Runtime and for views on their own (src/views/): applied to the
// store as its effective part, and gathered into one consolidated change per transaction. One
// implementation, so the two take a change in the same way.
import type { Quad } from '@rdfjs/types'
import { type Delta, quadKey } from '../rdf.ts'
import type { GraphStore } from '../store/types.ts'

/**
 * Apply a change to one graph of a store (`graph` undefined: the default graph): what it removes
 * that the store holds goes, what it adds that the store lacks comes. Returns that effective part,
 * in the graph's terms; a change already held is no change.
 */
export function applyEffective(store: GraphStore, graph: string | undefined, delta: Delta): Delta {
  const f = store.factory
  const g = graph === undefined ? f.defaultGraph() : f.namedNode(graph)
  const effective: Delta = { add: [], remove: [] }
  for (const q of delta.remove) {
    const e = f.quad(q.subject, q.predicate, q.object, g)
    if (store.has(e)) store.delete(e), effective.remove.push(e)
  }
  for (const q of delta.add) {
    const e = f.quad(q.subject, q.predicate, q.object, g)
    if (!store.has(e)) store.add(e), effective.add.push(e)
  }
  return effective
}

/** The changes of one transaction, by graph and quad with their net weight: what one tick takes in. */
export class Consolidation {
  private readonly entries = new Map<string, { graph: string | undefined; q: Quad; w: number }>()

  /** Take in an effective change to a graph (undefined: the default graph). */
  add(graph: string | undefined, effective: Delta): void {
    for (const [w, qs] of [[-1, effective.remove], [1, effective.add]] as const) {
      for (const q of qs) {
        const k = (graph ?? '') + ' ' + quadKey(q)
        const e = this.entries.get(k)
        if (e) e.w += w
        else this.entries.set(k, { graph, q, w })
      }
    }
  }

  /** The net change: by graph, and all together. A quad added and removed again is in neither. */
  result(): { byGraph: Map<string | undefined, Delta>; all: Delta } {
    const all: Delta = { add: [], remove: [] }
    const byGraph = new Map<string | undefined, Delta>()
    for (const { graph, q, w } of this.entries.values()) {
      if (!w) continue
      let d = byGraph.get(graph)
      if (!d) byGraph.set(graph, (d = { add: [], remove: [] }))
      ;(w > 0 ? d.add : d.remove).push(q)
      ;(w > 0 ? all.add : all.remove).push(q)
    }
    return { byGraph, all }
  }
}
