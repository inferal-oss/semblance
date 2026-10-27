// Rule selection by SPARQL extension (#7, rdf-engine/EXTENSIONS.md): a SPARQL rule that needs a
// group (sem:needsExtension) is chosen only on a store that has it; elsewhere its function twin runs.
import { describe, expect, it } from 'vitest'
import { loadRules, selectRules } from '../src/engine/rules.ts'
import { createStore, type StoreKind } from '../src/node/load.ts'

const TTL = `
@prefix sem: <https://semblance.dev/ns/core#> .
@prefix sx: <https://semblance.dev/ns/sparql#> .
@prefix ex: <https://example.org/sel#> .
ex:Hex a sem:Rendering ; sem:targets ex:Thing .
ex:HexSparql a sem:Rule ; sem:implements ex:Hex ; sem:needsExtension sx:Text ;
  sem:construct """CONSTRUCT { $this ex:hex ?h } WHERE { $this ex:text ?t BIND(sx:utf8Hex(?t) AS ?h) }""" .
ex:HexFunction a sem:Rule ; sem:implements ex:Hex ; sem:function "ex-hex" .
ex:Both a sem:Rendering ; sem:targets ex:Thing .
ex:BothSparql a sem:Rule ; sem:implements ex:Both ; sem:needsExtension sx:Text, sx:Json ;
  sem:construct """CONSTRUCT { $this ex:n 1 } WHERE { $this ex:text ?t }""" .
ex:BothFunction a sem:Rule ; sem:implements ex:Both ; sem:function "ex-both" .
ex:Plain a sem:Rendering ; sem:targets ex:Thing .
ex:PlainSparql a sem:Rule ; sem:implements ex:Plain ; sem:construct """CONSTRUCT { $this ex:p 1 } WHERE { $this ex:text ?t }""" .
ex:PlainFunction a sem:Rule ; sem:implements ex:Plain ; sem:function "ex-plain" .
`

function chosen(kind: StoreKind, prefer: 'sparql' | 'function') {
  const store = createStore(kind)
  store.loadTurtle(TTL)
  const rules = selectRules(loadRules(store), { modality: '', layers: new Set(), prefer, sparql: store.sparql, extensions: store.extensions })
  return Object.fromEntries(rules.map((r) => [r.slot.replace(/.*#/, ''), r.kind]))
}

describe('rules that need a SPARQL extension', () => {
  it.each(['wat', 'rust'] as const)('are chosen on %s, which has every group', (kind) => {
    expect(chosen(kind, 'sparql')).toEqual({ Hex: 'sparql', Both: 'sparql', Plain: 'sparql' })
    expect(chosen(kind, 'function')).toEqual({ Hex: 'function', Both: 'function', Plain: 'function' })
  })

  it.each(['oxigraph', 'hybrid', 'n3'] as const)('fall back to the function on %s', (kind) => {
    const sparql = kind !== 'n3'
    expect(chosen(kind, 'sparql')).toEqual({ Hex: 'function', Both: 'function', Plain: sparql ? 'sparql' : 'function' })
  })

  it('need every group they name', () => {
    const store = createStore('wat')
    store.loadTurtle(TTL)
    const only = selectRules(loadRules(store), { modality: '', layers: new Set(), prefer: 'sparql', sparql: true, extensions: new Set(['https://semblance.dev/ns/sparql#Text']) })
    expect(Object.fromEntries(only.map((r) => [r.slot.replace(/.*#/, ''), r.kind]))).toEqual({ Hex: 'sparql', Both: 'function', Plain: 'sparql' })
  })

  it('read sem:needsExtension from the rule itself', () => {
    const store = createStore('oxigraph')
    store.loadTurtle(TTL)
    const byIri = Object.fromEntries(loadRules(store).map((r) => [r.iri.replace(/.*#/, ''), r.needs.map((g) => g.replace(/.*#/, '')).sort()]))
    expect(byIri).toEqual({ HexSparql: ['Text'], HexFunction: [], BothSparql: ['Json', 'Text'], BothFunction: [], PlainSparql: [], PlainFunction: [] })
  })
})
