// The dependency probes' lookups (src/view/lookup.ts, #137): one call across graphs (where the
// store says that costs one) answers as asking graph by graph does, with removed triples put back,
// in both graph modes; and the same lookup again does not cross into the store again.
import type { Quad, Term } from '@rdfjs/types'
import { describe, expect, it } from 'vitest'
import { createStore, type StoreKind } from '../src/node/load.ts'
import { probeLookup } from '../src/view/lookup.ts'

const EX = 'https://example.org/'

function setup(kind: StoreKind) {
  const store = createStore(kind)
  const f = store.factory
  const nn = (x: string) => f.namedNode(EX + x)
  const [a, b, c, p, q] = ['a', 'b', 'c', 'p', 'q'].map(nn) as [Term, Term, Term, Term, Term]
  const g1 = nn('g1')
  const g2 = nn('g2')
  const outside = nn('outside')
  const quads = [
    f.quad(a, p, b),
    f.quad(a, p, b, g1),
    f.quad(a, q, c, g2),
    f.quad(b, p, c, g2),
    f.quad(a, p, c, outside),
    f.quad(c, q, a, g1),
  ]
  for (const x of quads) store.add(x)
  const removed = [f.quad(a, q, b, g1), f.quad(b, q, a)]
  return { store, f, a, b, c, p, q, g1, g2, graphs: [f.defaultGraph(), g1, g2] as Term[], removed }
}

const key = (qs: Quad[]) => qs.map((x) => `${x.subject.value} ${x.predicate.value} ${x.object.value} ${x.graph.value}`).sort()

describe('probe lookups', () => {
  for (const kind of ['wat', 'oxigraph'] as StoreKind[]) {
    it(`across graphs answers as graph by graph does (${kind})`, () => {
      const { store, a, b, c, p, q, g1, graphs, removed } = setup(kind)
      const byGraph = { ...store, crossGraphMatch: false, match: store.match.bind(store) }
      for (const graphMode of ['named', 'any'] as const) {
        const one = probeLookup({ store, graphs, removed, graphMode })
        const each = probeLookup({ store: byGraph, graphs, removed, graphMode })
        for (const [s, pp, o] of [[a, null, null], [a, p, null], [null, null, c], [null, q, a], [b, null, null], [null, p, null], [c, q, a]] as (Term | null)[][]) {
          for (const g of [undefined, null, g1]) expect(key(one(s!, pp!, o!, g)), `${graphMode} ${s?.value} ${pp?.value} ${o?.value} ${g?.value}`).toEqual(key(each(s!, pp!, o!, g)))
        }
        // The graph outside the dataset is not read; removed triples are.
        expect(key(one(a, p, null))).toEqual([`${EX}a ${EX}p ${EX}b `])
        expect(key(one(a, q, null))).toEqual([`${EX}a ${EX}q ${EX}b ${EX}g1`, `${EX}a ${EX}q ${EX}c ${EX}g2`])
      }
    })
  }

  it('asks the store once per distinct lookup', () => {
    const { store, a, p, graphs, removed } = setup('wat')
    let calls = 0
    const counted = { ...store, crossGraphMatch: true, match: (...x: Parameters<typeof store.match>) => (calls++, store.match(...x)) }
    const look = probeLookup({ store: counted, graphs, removed, graphMode: 'named' })
    look(a, p, null)
    look(a, p, null)
    expect(calls).toBe(1)
    look(a, null, null)
    expect(calls).toBe(2)
  })
})
