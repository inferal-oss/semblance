import { describe, expect, it } from 'vitest'
import * as ox from 'oxigraph'
import { DataFactory as f } from 'n3'
import type { Quad, Term } from '@rdfjs/types'
import { hybridStore } from '../src/store/hybrid.ts'
import { oxigraphStore } from '../src/store/oxigraph.ts'
import { type GraphStore, storeFailure } from '../src/store/types.ts'

// Oxigraph's own terms are WebAssembly objects in its one memory, capped at 4 GiB, freed by finalizers
// only between tasks: a synchronous stretch of queries (a language sweep over the site, #317) filled
// it with terms nothing held any more, and Oxigraph trapped ("RuntimeError: unreachable"). So the
// adapters hand out plain terms and free Oxigraph's at once.

const EX = 'https://semblance.dev/test#'
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer'
const g = f.namedNode(EX + 'g')
const held = [
  f.quad(f.namedNode(EX + 's'), f.namedNode(EX + 'name'), f.literal('مرحبا', 'ar'), g),
  f.quad(f.namedNode(EX + 's'), f.namedNode(EX + 'count'), f.literal('3', f.namedNode(XSD_INTEGER)), g),
  f.quad(f.namedNode(EX + 's'), f.namedNode(EX + 'text'), f.literal('plain'), g),
  f.quad(f.blankNode('b'), f.namedNode(EX + 'to'), f.namedNode(EX + 's'), g),
  f.quad(f.namedNode(EX + 'd'), f.namedNode(EX + 'in'), f.literal('default')),
] as Quad[]

const isPlain = (t: Term): boolean => !('__wbg_ptr' in t) && (t.termType !== 'Quad' || [t.subject, t.predicate, t.object, t.graph].every(isPlain))
const key = (q: Quad) => [q.subject, q.predicate, q.object].map((t) => `${t.termType} ${t.value} ${(t as { language?: string }).language ?? ''} ${(t as { datatype?: Term }).datatype?.value ?? ''}`).join(' | ')

const stores: Record<string, () => GraphStore> = { oxigraph: () => oxigraphStore(ox), hybrid: () => hybridStore(ox) }

describe.each(Object.keys(stores))('%s results are plain terms (#317)', (kind) => {
  const filled = () => {
    const store = stores[kind]!()
    for (const q of held) store.add(q)
    return store
  }

  it('match and construct return what was stored', () => {
    const store = filled()
    const of = (quads: Quad[]) => quads.map(key).sort()
    const named = held.filter((q) => q.graph.equals(g))
    const matched = store.match(null, null, null, g)
    expect(of(matched)).toEqual(of(named))
    expect(matched.every((q) => q.graph.equals(g))).toBe(true)
    const built = store.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', [g])
    expect(built.every(isPlain)).toBe(true)
    expect(of(built.filter((q) => q.subject.termType === 'NamedNode'))).toEqual(of(named.filter((q) => q.subject.termType === 'NamedNode')))
    expect(store.match(null, null, null, null).every(isPlain)).toBe(true)
  })

  it('select returns solutions in plain terms, and a boolean as it is', () => {
    const store = filled()
    const rows = store.select(`SELECT ?o WHERE { <${EX}s> <${EX}name> ?o }`, [g])
    expect(rows).toHaveLength(1)
    const o = rows[0]!.get('o') as Term & { language: string; datatype: Term }
    expect(isPlain(o)).toBe(true)
    expect([o.termType, o.value, o.language, o.datatype.value]).toEqual(['Literal', 'مرحبا', 'ar', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString'])
    expect(store.select(`ASK { <${EX}s> <${EX}name> ?o }`, [g]) as unknown).toBe(true)
  })

  it('a quoted triple comes back plain, whole', () => {
    const store = stores[kind]!()
    const quoted = f.quad(f.namedNode(EX + 'a'), f.namedNode(EX + 'b'), f.literal('c', 'de'))
    const about = f.quad(f.namedNode(EX + 'd'), f.namedNode(EX + 'says'), quoted, g) as Quad
    store.add(about)
    for (const [q] of [store.match(null, null, null, g), store.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', [g])]) {
      expect(isPlain(q!.object)).toBe(true)
      expect(q!.object.equals(quoted)).toBe(true)
    }
    expect(store.match(null, f.namedNode(EX + 'says'), null, g)[0]!.equals(about)).toBe(true)
  })

  it('a synchronous stretch of queries returning more than the memory can hold does not trap', () => {
    const store = stores[kind]!()
    // 16 MB of terms a query, 4.8 GB in all: past what Oxigraph's memory can hold if they stayed in it.
    const long = EX + 'x'.repeat(8192)
    for (let i = 0; i < 2000; i++) store.add(f.quad(f.namedNode(long + i), f.namedNode(EX + 'p'), f.literal('v')))
    for (let i = 0; i < 300; i++) expect(store.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', [f.defaultGraph()])).toHaveLength(2000)
    store.dispose?.()
  })
})

describe('a store that traps says so', () => {
  const store = { kind: 'oxigraph' } as GraphStore
  it('names the store and the query', () => {
    expect(storeFailure(store, new WebAssembly.RuntimeError('unreachable'), 'SELECT * WHERE { ?s ?p ?o }')).toBe('the oxigraph store trapped (unreachable) running:\nSELECT * WHERE { ?s ?p ?o }')
  })
  it('leaves a query error as it is', () => {
    expect(storeFailure(store, new Error('line 1: bad IRI'), 'SELECT')).toBe('line 1: bad IRI')
  })
})
