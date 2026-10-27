import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { SPARQL_PREFIXES } from '../src/ns.ts'

// SPARQL is the primary implementation: every rendering has a SPARQL rule for every modality
// it renders in, and a function twin (the oracle and the faster path). The only way out is a
// SPARQL extension the engines do not have yet (sem:needsExtension), or tracked work
// (sem:awaitsWork, an issue), with a sem:functionOnly reason saying what it awaits.
const store = loadStore('oxigraph')
const rows = (query: string) =>
  store.select(SPARQL_PREFIXES + query, [store.factory.defaultGraph()]).map((r) => Object.fromEntries([...r].map(([k, v]) => [k, v.value.replace(/^.*[#/]/, '')])))

describe('SPARQL coverage', () => {
  it('every rendering has SPARQL for every modality it renders in, and a function twin', () => {
    const gaps = rows(`SELECT ?rendering ?missing WHERE {
  ?rendering a sem:Rendering .
  FILTER NOT EXISTS { ?rendering sem:needsExtension ?extension }
  FILTER NOT EXISTS { ?rendering sem:awaitsWork ?issue }
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

  it('sem:functionOnly only says which extension or tracked work a rendering awaits', () => {
    const loose = rows(`SELECT ?rendering ?why WHERE {
  ?rendering sem:functionOnly ?why .
  FILTER(!(EXISTS { ?rendering sem:needsExtension ?extension } && STRSTARTS(?why, "awaits sx:"))
    && !(EXISTS { ?rendering sem:awaitsWork ?issue } && STRSTARTS(?why, "awaits #")))
} ORDER BY ?rendering`)
    expect(loose).toEqual([])
  })

  it('what awaits tracked work (sem:awaitsWork) is this list, which only shrinks', () => {
    const awaiting = rows(`SELECT ?rendering ?issue WHERE { ?rendering sem:awaitsWork ?issue } ORDER BY ?issue ?rendering`)
    expect(awaiting).toEqual([
      // The combobox work (#14) brings the typeahead's function twins.
      ...['TagInputPills', 'TypeaheadMatches', 'TypeaheadOptionRendering', 'TypeaheadOptions', 'TypeaheadRendering'].map((rendering) => ({ rendering, issue: '14' })),
      // Views over derived triples (#147): formulas over a sheet's derived inputs or a view's figures.
      { rendering: 'QueryFormula', issue: '147' },
      // Query runs as graph data (#148): the result table, of a query run when asked.
      { rendering: 'ResultTableRendering', issue: '148' },
    ])
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
