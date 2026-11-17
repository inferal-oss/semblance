// Host caches without a cap or an owner (docs/RETENTION.md, §3.3): each keeps at most a fixed number
// of entries, or goes with what owns it, however many distinct keys a long session brings.
import { describe, expect, it } from 'vitest'
import { CappedMap } from '../src/capped.ts'
import { createContext } from '../src/engine/context.ts'
import { ruleDeps, ruleDepsCached } from '../src/engine/exact.ts'
import type { Rule } from '../src/engine/rules.ts'
import { MOD } from '../src/ns.ts'
import { createStore } from '../src/node/stores.ts'
import { DomRenderer } from '../src/render/dom.ts'
import type { GraphStore } from '../src/store/types.ts'
import { mountShell } from './harness.ts'

describe('host caches', () => {
  it('a capped map forgets its oldest key past its cap', () => {
    const m = new CappedMap<string, number>(3)
    for (let i = 0; i < 10; i++) m.set('k' + i, i)
    expect([...m.keys()]).toEqual(['k7', 'k8', 'k9'])
    m.set('k8', 80) // an existing key is not a new one
    expect(m.size).toBe(3)
  })

  it("a rule context's NamedNodes by IRI stay capped", () => {
    const store = createStore('oxigraph')
    const ctx = createContext(store, [store.factory.defaultGraph()], MOD.Screen)
    for (let i = 0; i < 20_000; i++) ctx.nn(`urn:test:subject-${i}`)
    expect(ctx.footprint!().names).toBeLessThanOrEqual(8192)
  })

  it('the exact-dependency cache stays capped however many rule texts come', () => {
    const store = createStore('oxigraph')
    const f = store.factory
    for (let i = 0; i < 2100; i++) {
      const rule = { queryParts: [`CONSTRUCT { `, ` <urn:p> ?o } WHERE { `, ` <urn:p${i}> ?o }`] } as unknown as Rule
      ruleDeps(f, rule)
    }
    expect(ruleDepsCached(f)).toBeLessThanOrEqual(2048)
  })

  it("the engine store's term objects for IRIs it never took do not stay", () => {
    const store = createStore('wat') as GraphStore & { footprint(): Record<string, number> }
    const f = store.factory
    store.loadTurtle('<urn:a> <urn:p> "x" .')
    // Looked up, never stored: a subject per URL served, say.
    for (let i = 0; i < 50_000; i++) store.match(f.namedNode(`urn:unknown:${i}`), null, null)
    for (let i = 0; i < 50_000; i++) f.literal(`never stored ${i}`)
    const { freshIris, freshLiterals } = store.footprint()
    expect(freshIris + freshLiterals).toBeLessThanOrEqual(8192)
    // What is stored is still found, by a term made again.
    expect(store.match(f.namedNode('urn:a'), null, null)).toHaveLength(1)
    expect(store.match(null, null, f.literal('x'))).toHaveLength(1)
  })

  it('a renderer or islands let go no longer hear of the index', () => {
    const h = mountShell(1)
    const consumers = () => h.screen.index.footprint().consumers!
    const before = consumers()
    const other = new DomRenderer(h.screen.index, h.document.createElement('div'), 'https://semblance.dev/demo#shell')
    expect(consumers()).toBe(before + 1)
    other.dispose()
    expect(consumers()).toBe(before)
  })

  it("a few clipboard documents' text projections are kept, not one per document ever copied", () => {
    const h = mountShell(1)
    const projections = () => h.runtime.footprint().projections!
    const before = projections()
    const textOf = (root: string) => (h.bus as unknown as { textOf(root: string): unknown }).textOf(root)
    for (let i = 0; i < 12; i++) textOf(`urn:test:document-${i}`)
    expect(projections() - before).toBeLessThanOrEqual(4)
    h.runtime.apply({ add: [h.store.factory.quad(h.store.factory.namedNode('urn:test:x'), h.store.factory.namedNode('urn:test:p'), h.store.factory.literal('y'))], remove: [] })
  })

  // N3 numbers every term it is given and never frees a number: the store copies itself once the
  // dictionary has outgrown what is stored, in idle time a slice at a time, writes going to both.
  for (const kind of ['n3', 'hybrid'] as const)
    it(`the ${kind} store's dictionary follows what is stored`, () => {
      const store = createStore(kind)
      const f = store.factory
      const p = f.namedNode('urn:p')
      store.loadTurtle('<urn:a> <urn:p> "kept" .')
      const terms = () => store.footprint!().terms!
      store.maintain!(0) // the first upkeep measures the dictionary
      const start = terms()
      // Events come and go: each brings terms of its own, and the log keeps its latest 10.
      const quad = (i: number) => f.quad(f.namedNode(`urn:event:${i}`), p, f.literal(`value ${i}`))
      for (let i = 0; i < 30_000; i++) {
        store.add(quad(i))
        if (i >= 10) store.delete(quad(i - 10))
        // Idle time, in slices too short to copy everything at once: the copy spans writes.
        if (i % 100 === 0) store.maintain!(0.05)
      }
      while (store.maintain!(5));
      expect(terms()).toBeLessThan(start + 3 * 5_000)
      // What is stored is all there, in both copies.
      expect(store.size!()).toBe(11)
      expect(store.match(null, p, null).map((q) => q.object.value).sort()).toEqual(['kept', ...Array.from({ length: 10 }, (_, k) => `value ${29_990 + k}`)].sort())
      if (kind === 'hybrid') expect(store.select('SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }', [f.defaultGraph()])[0]!.get('n')!.value).toBe('11')
      // compact() copies at once.
      for (let i = 0; i < 20_000; i++) store.add(f.quad(f.namedNode(`urn:more:${i}`), p, f.literal('x')))
      for (let i = 0; i < 20_000; i++) store.delete(f.quad(f.namedNode(`urn:more:${i}`), p, f.literal('x')))
      expect(store.compact!()!.terms).toBeLessThan(start + 100)
      expect(terms()).toBeLessThan(start + 100)
      expect(store.size!()).toBe(11)
    })
})
