import { describe, expect, it } from 'vitest'
import { loadRules, namedPredicates } from '../src/engine/rules.ts'
import { loadStore } from '../src/node/load.ts'
import { prefixesFor } from '../src/prefixes.ts'
import { parseTurtle } from '../src/runtime.ts'
import { sliceAddition } from '../src/slices.ts'

// The rest of a page's graphs taken in as several changes (#263, #254): whole descriptions per
// slice, what defines rules first; and each query read once for every engine that has it.

const TTL = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <https://example.org/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:r a sem:Rule ; sem:follows ( ex:a [ sem:inverse ex:b ] ) .
ex:Sub rdfs:subClassOf ex:Super .
ex:ont sh:declare [ sh:prefix "ex" ; sh:namespace "https://example.org/" ] .
ex:x ex:p 1 ; ex:q [ ex:r [ ex:s 2 ] ] .
ex:y ex:p 2 .
ex:z ex:p 3 .
[] ex:p 4 .`

describe('sliceAddition', () => {
  const store = loadStore('n3')
  const quads = parseTurtle(TTL, store.factory)
  const subjects = (qs: typeof quads) => new Set(qs.filter((q) => q.subject.termType === 'NamedNode').map((q) => q.subject.value))

  it('puts what defines rules first, with every blank node it reaches', () => {
    const { rules, rest } = sliceAddition(quads, 2)
    expect(subjects(rules)).toEqual(new Set(['https://example.org/r', 'https://example.org/Sub', 'https://example.org/ont']))
    // The rule's sem:follows list and the prefix declaration, whole.
    expect(rules.filter((q) => q.subject.termType === 'BlankNode').length).toBe(2 * 2 + 1 + 2)
    expect(rules.length + rest.reduce((n, s) => n + s.length, 0)).toBe(quads.length)
    for (const slice of rest) expect(slice.some((q) => subjects(rules).has(q.subject.value))).toBe(false)
  })

  it('puts the slot a rule implements, and the rule it takes its query from, with the rules, whatever their class', () => {
    // A building block (#291), a slot of no class at all, and a query taken from another rule's description:
    // each read by loadRules for the rule, so each goes in the change that defines it.
    const ttl = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix ex: <https://example.org/> .
ex:block a sem:BuildingBlock ; sem:targets ex:C ; sem:stratum -9 .
ex:slot sem:targets ex:D .
ex:query sem:construct "CONSTRUCT {} WHERE {}" .
ex:a a sem:Rule ; sem:implements ex:block ; sem:function "ex:a" .
ex:b a sem:Rule ; sem:implements ex:slot ; sem:constructFrom ex:query .
ex:data ex:p 1 .`
    const { rules, rest } = sliceAddition(parseTurtle(ttl, store.factory), 1)
    expect(subjects(rules)).toEqual(new Set(['block', 'slot', 'query', 'a', 'b'].map((n) => 'https://example.org/' + n)))
    expect(rest.flat().map((q) => q.subject.value)).toEqual(['https://example.org/data'])
  })

  it('puts shapes with the rules, whole: a shape names the others it needs', () => {
    const { rules, rest } = sliceAddition(parseTurtle(`@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <https://example.org/> .
ex:own a sh:PropertyShape ; sh:path ex:p ; sh:minCount 1 .
ex:node a sh:NodeShape ; sh:targetClass ex:C ; sh:or ( ex:own ) ; sh:property [ sh:path ex:q ; sh:maxCount 1 ] .
ex:data ex:p 1 .`, store.factory), 1)
    expect(subjects(rules)).toEqual(new Set(['https://example.org/own', 'https://example.org/node']))
    expect(rest.flat().map((q) => q.subject.value)).toEqual(['https://example.org/data'])
  })

  it('slices the rest without splitting a description', () => {
    const { rest } = sliceAddition(quads, 2)
    expect(rest.length).toBeGreaterThan(1)
    // ex:x and the blank nodes it reaches are in one slice (4 triples, past the size: never split).
    const withX = rest.find((s) => s.some((q) => q.subject.value === 'https://example.org/x'))!
    expect(withX.filter((q) => q.subject.termType === 'BlankNode').length).toBe(2)
    expect(withX.length).toBe(4)
    for (const slice of rest) expect(slice.length === withX.length || slice.length <= 2).toBe(true)
  })
})

describe('the rules read by every engine', () => {
  it('watch what each query watches with the whole prefix header', () => {
    const store = loadStore('wat')
    const header = prefixesFor(store)
    const f = store.factory
    let compared = 0
    for (const rule of loadRules(store)) {
      if (rule.kind !== 'sparql') continue
      // Declared watches (on the rule or its rendering) are not the query's.
      const declared = [rule.iri, rule.slot].some((s) => store.match(f.namedNode(s), f.namedNode('https://semblance.dev/ns/core#watches'), null).length)
      if (declared) continue
      const query = rule.queryParts!.join('$this').slice(header.length + 1)
      const whole = namedPredicates(header + '\n' + query, [])
      // The rule's watches are the query's, with what it requires, follows and iterates (`also`).
      if (!whole.watches) expect(rule.watches).toBeUndefined()
      else for (const p of whole.watches) expect(rule.watches!.has(p)).toBe(true)
      expect(rule.watchesVia).toEqual(whole.watchesVia)
      expect(rule.watchesMarked).toEqual(whole.watchesMarked)
      compared++
    }
    expect(compared).toBeGreaterThan(200)
  })

  it('share one reading of a query between engines', () => {
    const store = loadStore('wat')
    const f = store.factory
    const declared = (iri: string) => store.match(f.namedNode(iri), f.namedNode('https://semblance.dev/ns/core#watches'), null).length > 0
    const a = loadRules(store)
    const b = loadRules(store)
    const sparql = a.filter((r) => r.kind === 'sparql' && r.watches && !declared(r.iri) && !declared(r.slot))
    expect(sparql.length).toBeGreaterThan(200)
    for (const r of sparql) expect(b.find((x) => x.iri === r.iri)!.watches).toBe(r.watches)
  })
})
