import { existsSync, readFileSync } from 'node:fs'
import type { Quad, Term } from '@rdfjs/types'
import { DataFactory } from 'n3'
import { describe, expect, it } from 'vitest'
import { engineStore, type EngineStore } from '../rdf-engine/host/store.ts'
import { termKey } from '../src/rdf.ts'

// Compaction by re-instantiation (#530): WebAssembly memory never shrinks, so an engine store that
// grew and then shrank copies itself into a fresh instance. What it holds, what its queries answer
// and the term objects it handed out are the same afterwards; the memory is smaller.

const built = (['wat', 'rust'] as const).filter((k) => existsSync(new URL(`../rdf-engine/build/${k}.wasm`, import.meta.url)))
const EX = 'https://example.org/'
const XSD = 'http://www.w3.org/2001/XMLSchema#'
const MiB = (n: number) => (n / 2 ** 20).toFixed(1) + ' MiB'

const quadKey = (q: Quad) => [q.subject, q.predicate, q.object, q.graph].map(termKey).join(' ')
const everything = (s: EngineStore) => s.match(null, null, null, null).map(quadKey).sort()
const rows = (s: EngineStore, query: string) =>
  s
    .select(query, [])
    .map((r) => [...r].map(([k, t]) => `${k}=${termKey(t)}`).sort().join(' '))
    .sort()

const QUERIES = [
  `SELECT ?s ?o WHERE { ?s <${EX}keep> ?o } ORDER BY ?s`,
  `SELECT ?s ?n WHERE { ?s <${EX}n> ?n FILTER(?n > 3) }`,
  `SELECT ?g (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g`,
  `SELECT ?b ?l WHERE { ?b <${EX}label> ?l FILTER(isBlank(?b)) }`,
  `SELECT ?r ?t WHERE { ?r <${EX}quotes> ?t FILTER(isTRIPLE(?t)) }`,
  `SELECT ?s ?l WHERE { ?s <${EX}name> ?l FILTER(lang(?l) = "uk") }`,
]

describe.skipIf(!built.length).each(built)('%s engine store compaction', (kind) => {
  const module = new WebAssembly.Module(readFileSync(new URL(`../rdf-engine/build/${kind}.wasm`, import.meta.url)))

  /** A store with a small lasting part (blank nodes, triple terms, languages, named graphs) and a large passing one. */
  function grown() {
    const s = engineStore(module, kind)
    const f = s.factory
    const iri = (x: string) => f.namedNode(EX + x)
    for (let i = 0; i < 200; i++) {
      const it = iri('item/' + i)
      const g = i % 3 ? f.defaultGraph() : iri('graph/' + (i % 5))
      s.add(f.quad(it, iri('keep'), f.literal('kept ' + i), g))
      s.add(f.quad(it, iri('n'), f.literal(String(i % 7), f.namedNode(XSD + 'integer'))))
      s.add(f.quad(it, iri('name'), f.literal('назва ' + i, 'uk')))
      s.add(f.quad(it, iri('name'), DataFactory.literal('name ' + i, { language: 'en', direction: 'ltr' } as never)))
      // A blank node from Turtle (a label of the engine's own) and one of a label given here.
      s.add(f.quad(DataFactory.blankNode('given' + i), iri('label'), f.literal('b' + i)))
    }
    s.loadTurtle(`@prefix ex: <${EX}> . ex:list ex:items ( ex:a ex:b [ ex:label "nested" ] ) .`)
    s.add(f.quad(iri('r'), iri('quotes'), f.quad(iri('a'), iri('says'), iri('b')) as never))
    s.add(f.quad(iri('r'), iri('says'), f.literal('quoted')))
    const lasting = s.size!()
    // The passing part: many terms and quads, then gone.
    for (let i = 0; i < 60_000; i++) s.add(f.quad(iri('passing/' + i), iri('text'), f.literal('a passing literal of some length, number ' + i), iri('graph/passing')))
    for (const q of s.match(null, null, null, iri('graph/passing'))) s.delete(q)
    expect(s.size!()).toBe(lasting)
    // Idle time frees the passing terms (and compacts nothing yet).
    s.setCompaction({ below: 0 })
    s.maintain!(10)
    s.setCompaction({})
    return s
  }

  it('compacts a store that grew and shrank to a smaller memory, with the same answers', () => {
    const s = grown()
    const before = { all: everything(s), answers: QUERIES.map((q) => rows(s, q)), memory: s.memoryBytes(), live: s.liveBytes() }
    expect(before.live).toBeLessThan(before.memory / 2)
    const c = s.compact()!
    expect(c).toBeDefined()
    expect(c.before).toBe(before.memory)
    expect(c.after).toBe(s.memoryBytes())
    expect(c.after).toBeLessThan(c.before / 2)
    expect(c.quads).toBe(s.size!())
    expect(everything(s)).toEqual(before.all)
    expect(QUERIES.map((q) => rows(s, q))).toEqual(before.answers)
    // The estimate is of a fresh instance: after compaction it is close to the memory.
    expect(Math.abs(s.liveBytes() - c.after)).toBeLessThan(c.after / 4)
    console.log(`${kind}: ${MiB(c.before)} -> ${MiB(c.after)} (live estimate before ${MiB(before.live)}, after ${MiB(s.liveBytes())}), ${c.quads} quads, ${c.terms} terms, ${c.ms.toFixed(1)} ms`)
    // Changes after compaction land as before, and a second one keeps everything too.
    const f = s.factory
    s.add(f.quad(f.namedNode(EX + 'late'), f.namedNode(EX + 'keep'), f.literal('late')))
    s.loadTurtle(`@prefix ex: <${EX}> . ex:late ex:label [ ex:label "late" ] .`)
    const later = everything(s)
    s.compact()
    expect(everything(s)).toEqual(later)
    s.dispose!()
  })

  it('keeps the term objects it handed out', () => {
    const s = grown()
    const f = s.factory
    const keepP = f.namedNode(EX + 'keep')
    const kept = s.match(null, keepP, null, null)
    const blank = s.match(null, f.namedNode(EX + 'label'), f.literal('nested'), null)[0]!.subject
    const given = s.match(null, f.namedNode(EX + 'label'), f.literal('b7'), null)[0]!.subject
    const quoted = s.match(null, f.namedNode(EX + 'quotes'), null, null)[0]!.object
    const named = s.match(null, f.namedNode(EX + 'name'), null, null).map((q) => q.object)
    const fresh = f.namedNode(EX + 'never-stored')
    expect(blank.termType).toBe('BlankNode')
    expect(quoted.termType).toBe('Quad')
    s.compact()
    // Each quad handed out is still in the store, and matches find it by its own terms.
    for (const q of kept) expect(s.has(q)).toBe(true)
    const again = s.match(null, keepP, null, null)
    expect(again.map(quadKey).sort()).toEqual(kept.map(quadKey).sort())
    // The shared term objects are the very ones results give now.
    const bySubject = new Map<string, Term>(kept.map((q) => [q.subject.value, q.subject]))
    for (const q of again) expect(q.subject).toBe(bySubject.get(q.subject.value))
    expect(f.namedNode(EX + 'keep')).toBe(keepP)
    // Blank nodes keep their identity (a reload would have renamed them).
    expect(s.match(blank, null, null, null).map((q) => q.object.value)).toEqual(['nested'])
    expect(s.match(given, null, null, null).map((q) => q.object.value)).toEqual(['b7'])
    expect(s.match(null, null, null, null).find((q) => q.object.equals(f.literal('nested')))!.subject).toBe(blank)
    // Triple terms, literals with languages and directions, a term the store never held.
    expect(s.match(null, null, quoted, null).map((q) => q.subject.value)).toEqual([EX + 'r'])
    for (const o of named) expect(s.match(null, null, o, null)).toHaveLength(1)
    expect(s.match(fresh, null, null, null)).toEqual([])
    s.add(f.quad(fresh, keepP, blank))
    expect(s.match(null, keepP, blank, null).map((q) => q.subject)).toEqual([fresh])
    // constructFor binds handed-out terms.
    const one = kept.find((q) => q.graph.termType === 'DefaultGraph')!
    const built = s.constructFor!(`CONSTRUCT { ?this <${EX}copy> ?o } WHERE { ?this <${EX}keep> ?o }`, 'this', [one.subject], [])
    expect(built.map((q) => q.object.value)).toEqual([one.object.value])
    s.dispose!()
  })

  it('does not compact while a Jelly stream is open, and compacts in idle time by its policy', () => {
    const s = grown()
    const reader = s.jellyReader!()
    expect(s.compact()).toBeUndefined()
    reader.end()
    // A floor above the memory spares the store, and so does a policy that wants live state lower.
    const memory = s.memoryBytes()
    s.setCompaction({ floor: memory + 1 })
    s.maintain!(10)
    expect(s.memoryBytes()).toBe(memory)
    s.setCompaction({ floor: 0, below: s.liveBytes() / memory / 2 })
    s.maintain!(10)
    expect(s.memoryBytes()).toBe(memory)
    // Asked with a threshold, it compacts only when it would win.
    expect(s.compact({ below: s.liveBytes() / memory / 2 })).toBeUndefined()
    expect(s.memoryBytes()).toBe(memory)
    s.setCompaction({ floor: 0 })
    const all = everything(s)
    s.maintain!(10)
    expect(s.memoryBytes()).toBeLessThan(memory / 2)
    expect(everything(s)).toEqual(all)
    // Right after, the store is not churned: live state is not below half of what it now has.
    const compacted = s.memoryBytes()
    const q = s.match(null, null, null, null)[0]!
    s.maintain!(10)
    expect(s.has(q)).toBe(true)
    expect(s.memoryBytes()).toBe(compacted)
    s.dispose!()
  })
})
