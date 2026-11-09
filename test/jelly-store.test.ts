// GraphStore.loadJelly / dumpJelly (#433) on every store: the engines natively, N3.js, Oxigraph and
// the hybrid store through src/jelly/. What one store dumps, every store loads to the same graph,
// whole or frame by frame as the bytes arrive.
import type { Quad, Term } from '@rdfjs/types'
import { DataFactory as F } from 'n3'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dumpJellyStream, loadJellyStream } from '../src/jelly/store.ts'
import { createStore, type StoreKind } from '../src/node/load.ts'
import type { GraphStore } from '../src/store/types.ts'

const KINDS: StoreKind[] = ['n3', 'oxigraph', 'hybrid', 'wat', 'rust']
const read = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const TTL = [read('examples/hello/tally.ttl'), read('examples/hello/app.ttl'), read('ontology/core.ttl')]

const key = (t: Term): string =>
  t.termType === 'BlankNode' ? '_' : t.termType === 'Quad' ? `<<${key(t.subject)} ${key(t.predicate)} ${key(t.object)}>>` : t.termType === 'Literal' ? `${JSON.stringify(t.value)}@${t.language}^${t.datatype.value}` : `${t.termType}:${t.value}`
const graph = (s: GraphStore) => s.match(null, null, null, null).map((q: Quad) => [q.subject, q.predicate, q.object, q.graph].map(key).join(' ')).sort()

describe('GraphStore Jelly load and dump', () => {
  const stores = Object.fromEntries(
    KINDS.map((k) => {
      const s = createStore(k)
      for (const t of TTL) s.loadTurtle(t)
      return [k, s]
    }),
  ) as Record<StoreKind, GraphStore>
  const want = graph(stores.n3)

  it('every store dumps what it holds, and every store loads every dump to the same graph', () => {
    for (const from of KINDS) {
      const bytes = stores[from].dumpJelly!()
      expect(bytes.length).toBeGreaterThan(1000)
      for (const to of KINDS) {
        const s = createStore(to)
        expect(s.loadJelly!(bytes), `${from} -> ${to}`).toBe(want.length)
        expect(graph(s), `${from} -> ${to}`).toEqual(want)
        s.dispose?.()
      }
    }
  })

  it('dumps one graph, and loads a stream of triples into a named graph', () => {
    for (const k of KINDS) {
      const s = createStore(k)
      const g = F.namedNode('https://example.org/g')
      s.add(F.quad(F.namedNode('https://example.org/a'), F.namedNode('https://example.org/p'), F.literal('in g'), g))
      s.add(F.quad(F.namedNode('https://example.org/a'), F.namedNode('https://example.org/p'), F.literal('in the default graph')))
      const one = createStore(k)
      expect(one.loadJelly!(s.dumpJelly!(g))).toBe(1)
      expect(graph(one)).toEqual([`NamedNode:https://example.org/a NamedNode:https://example.org/p "in g"@^http://www.w3.org/2001/XMLSchema#string NamedNode:https://example.org/g`])
      s.dispose?.()
      one.dispose?.()
    }
  })

  it('leaves the store as it was when a stream is malformed', () => {
    const bytes = stores.wat.dumpJelly!()
    for (const k of KINDS) {
      const s = createStore(k)
      expect(() => s.loadJelly!(bytes.subarray(0, bytes.length - 3)), k).toThrow()
      expect(s.match(null, null, null, null).length, k).toBe(0)
      s.dispose?.()
    }
  })
})

describe('GraphStore Jelly streams', () => {
  const source = createStore('n3')
  for (const t of TTL) source.loadTurtle(t)
  const want = graph(source)

  it('dump frame by frame, and load as the bytes arrive, in chunks of any size, on every store', async () => {
    for (const from of KINDS) {
      const s = createStore(from)
      for (const t of TTL) s.loadTurtle(t)
      // Small frames, so the dump is many of them.
      const parts: Uint8Array[] = []
      const r = dumpJellyStream(s, undefined, { frameRows: 16 }).getReader()
      for (let x = await r.read(); !x.done; x = await r.read()) parts.push(x.value)
      expect(parts.length, from).toBeGreaterThan(10)
      const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      parts.reduce((at, p) => (bytes.set(p, at), at + p.length), 0)
      for (const to of KINDS) {
        const t = createStore(to)
        const size = 1 + ((from.length * 31 + to.length * 7) % 97)
        async function* arriving() {
          for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size)
        }
        expect(await loadJellyStream(t, arriving()), `${from} -> ${to}`).toBe(want.length)
        expect(graph(t), `${from} -> ${to}`).toEqual(want)
        t.dispose?.()
      }
      s.dispose?.()
    }
  })

  it('keeps the frames that arrived before a stream broke', async () => {
    const bytes = dumpJellyFrom(source)
    for (const k of KINDS) {
      const t = createStore(k)
      async function* broken() {
        yield bytes.subarray(0, Math.floor(bytes.length / 2))
      }
      await expect(loadJellyStream(t, broken()), k).rejects.toThrow()
      const n = t.match(null, null, null, null).length
      expect(n, k).toBeGreaterThan(0)
      expect(n, k).toBeLessThan(want.length)
      t.dispose?.()
    }
  })
})

function dumpJellyFrom(s: GraphStore): Uint8Array {
  return s.dumpJelly!(undefined, { frameRows: 64 })
}
