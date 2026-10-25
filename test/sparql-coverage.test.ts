import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { SPARQL_PREFIXES } from '../src/ns.ts'

// SPARQL is the primary implementation: every rendering has a SPARQL rule for every modality
// it renders in, and a function twin (the oracle and the faster path). The only way out is a
// SPARQL extension the engines do not have yet: sem:needsExtension, with a sem:functionOnly
// reason saying what it awaits.
const store = loadStore('oxigraph')
const rows = (query: string) =>
  store.select(SPARQL_PREFIXES + query, [store.factory.defaultGraph()]).map((r) => Object.fromEntries([...r].map(([k, v]) => [k, v.value.replace(/^.*[#/]/, '')])))

describe('SPARQL coverage', () => {
  it('every rendering has SPARQL for every modality it renders in, and a function twin', () => {
    const gaps = rows(`SELECT ?rendering ?missing WHERE {
  ?rendering a sem:Rendering .
  FILTER NOT EXISTS { ?rendering sem:needsExtension ?extension }
  BIND(EXISTS { ?fn sem:implements ?rendering ; sem:function ?name } AS ?hasFunction)
  BIND(EXISTS { ?q sem:implements ?rendering ; sem:construct ?text } AS ?hasSparql)
  OPTIONAL {
    FILTER NOT EXISTS { ?rendering sem:modality ?own }
    VALUES ?modality { mod:Screen mod:Text }
    ?some sem:implements ?rendering ; sem:construct ?someText ; sem:modality ?named .
    FILTER NOT EXISTS {
      ?q2 sem:implements ?rendering ; sem:construct ?text2 .
      FILTER(NOT EXISTS { ?q2 sem:modality ?m2 } || EXISTS { ?q2 sem:modality ?modality })
    }
  }
  FILTER(!?hasFunction || !?hasSparql || (BOUND(?modality) && ?hasFunction))
  BIND(IF(!?hasSparql, "SPARQL", IF(!?hasFunction, "function", CONCAT("SPARQL for ", STRAFTER(STR(?modality), "#")))) AS ?missing)
} ORDER BY ?rendering`)
    expect(gaps).toEqual([])
  })

  it('sem:functionOnly only says which extension a rendering awaits', () => {
    const loose = rows(`SELECT ?rendering ?why WHERE {
  ?rendering sem:functionOnly ?why .
  FILTER(NOT EXISTS { ?rendering sem:needsExtension ?extension } || !STRSTARTS(?why, "awaits sx:"))
} ORDER BY ?rendering`)
    expect(loose).toEqual([])
  })

  it('every reaction has SPARQL (beh:deletes / beh:inserts), unless it awaits an extension', () => {
    const loose = rows(`SELECT ?reaction WHERE {
  ?reaction a beh:Reaction .
  FILTER NOT EXISTS { ?reaction beh:inserts ?i } FILTER NOT EXISTS { ?reaction beh:deletes ?d }
  FILTER NOT EXISTS { ?reaction sem:needsExtension ?extension }
} ORDER BY ?reaction`)
    expect(loose).toEqual([])
  })
})
