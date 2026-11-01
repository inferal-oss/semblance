// Views over what rules and the runtime derive (docs/IVM.md §27): a view that names a rendering
// (iv:reads <rendering>) reads what the rules derive, stepped in rounds after the projections, and
// equal to a from-scratch run after every change (strict); a view that names a view reads what the
// runtime writes about it (its figures), stepped when they are written.
import { describe, expect, it } from 'vitest'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { MOD, NS } from '../src/ns.ts'
import { Runtime } from '../src/runtime.ts'
import { maintainedRows } from '../src/view/rows.ts'
import { createContext } from '../src/engine/context.ts'
import { VIEW_GRAPH } from '../src/view/runtime.ts'

const X = 'https://example.org/derived#'

const ontology = `
@prefix x: <${X}> .
@prefix sem: <https://semblance.dev/ns/core#> .
@prefix iv: <https://semblance.dev/ns/view#> .
@prefix rs: <http://www.w3.org/2001/sw/DataAccess/tests/result-set#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
x:prefixes sh:declare [ sh:prefix "x" ; sh:namespace "${X}"^^xsd:anyURI ] ,
    [ sh:prefix "rs" ; sh:namespace "http://www.w3.org/2001/sw/DataAccess/tests/result-set#"^^xsd:anyURI ] .

# A rule derives each cell's double; a view sums the doubles (what the rule derives).
x:Doubling a sem:Rendering ; sem:targets x:Cell ; sem:stratum -1 .
x:Doubling-sparql a sem:Rule ; sem:implements x:Doubling ;
    sem:construct """CONSTRUCT { $this x:doubled ?d } WHERE { $this x:value ?v BIND(?v * 2 AS ?d) }""" .
x:Total a iv:View ; iv:materialize iv:Graph ; iv:reads x:Doubling ; iv:measured true ;
    sem:select """SELECT (SUM(?d) AS ?value) WHERE { ?c x:doubled ?d }""" .

# A chain: a rule copies the total onto a node (as the formula layer does), and a view reads that copy.
x:Copying a sem:Rendering ; sem:targets x:Copy ; sem:stratum -1 ; sem:watchesAnywhere rs:value .
x:Copying-sparql a sem:Rule ; sem:implements x:Copying ;
    sem:construct """CONSTRUCT { $this x:total ?t } WHERE { x:Total rs:solution ?row . ?b rs:value ?t . FILTER(STR(?b) = CONCAT(STR(?row), "-value")) }""" .
x:copy a x:Copy .
x:Half a iv:View ; iv:materialize iv:Graph ; iv:reads x:Copying ;
    sem:select """SELECT ?value WHERE { x:copy x:total ?t BIND(?t / 2 AS ?value) }""" .

# The runtime's figures about x:Total, read by a view.
x:Work a iv:View ; iv:materialize iv:Graph ; iv:reads x:Total ;
    sem:select """SELECT ?value WHERE { OPTIONAL { x:Total iv:ticks ?n } BIND(COALESCE(?n, -1) AS ?value) }""" .
`

function setup(kind: StoreKind) {
  const cells = Array.from({ length: 5 }, (_, i) => `x:c${i} a x:Cell ; x:value ${i + 1} .`).join('\n')
  const store = loadStore(kind, ontology, `@prefix x: <${X}> .\n${cells}`)
  const runtime = new Runtime(store)
  runtime.views.strict = true
  const screen = runtime.project({ modality: MOD.Screen, prefer: 'sparql' })
  const f = store.factory
  const nn = (s: string) => f.namedNode(X + s)
  const int = (v: number) => f.literal(String(v), f.namedNode(NS.xsd + 'integer'))
  const ctx = createContext(store, [f.defaultGraph(), f.namedNode(VIEW_GRAPH)], '')
  const value = (view: string) => maintainedRows(ctx, nn(view))?.[0]?.get('value')?.value
  const set = (cell: string, v: number) => runtime.apply({ remove: store.match(nn(cell), nn('value'), null), add: [f.quad(nn(cell), nn('value'), int(v))] })
  return { store, runtime, screen, f, nn, int, value, set }
}

describe('views over what rules and the runtime derive', () => {
  it.each(['wat', 'oxigraph'] as const)('reads what a rendering derives, round by round, equal to a from-scratch run (%s)', (kind) => {
    const h = setup(kind)
    // 2 + 4 + 6 + 8 + 10; the copy, halved.
    expect(h.value('Total')).toBe('30')
    expect(h.value('Half')).toBe('15')
    expect(h.runtime.views.view(X + 'Total')?.strategy).toBe('incremental')
    h.set('c2', 10)
    expect(h.value('Total')).toBe('44')
    expect(h.value('Half')).toBe('22')
    // A cell comes and goes: the rule derives its double, and the view hears it.
    h.runtime.apply({ remove: [], add: [h.f.quad(h.nn('c9'), h.f.namedNode(NS.rdf + 'type'), h.nn('Cell')), h.f.quad(h.nn('c9'), h.nn('value'), h.int(3))] })
    expect(h.value('Total')).toBe('50')
    h.runtime.apply({ remove: h.store.match(h.nn('c9'), null, null), add: [] })
    expect([h.value('Total'), h.value('Half')]).toEqual(['44', '22'])
  })

  it('a change costs the rounds of its chain, not a run of every view', () => {
    const h = setup('wat')
    const ticks = h.runtime.views.tickNo
    h.set('c0', 7)
    // The change, the doubles it derived (Total steps), the copy that derived (Half steps): three.
    expect(h.runtime.views.tickNo - ticks).toBe(3)
    expect(h.value('Half')).toBe(String((30 - 2 + 14) / 2))
  })

  it('reads the figures the runtime writes about a view, never stepped by its own', () => {
    const h = setup('wat')
    expect(h.value('Work')).toBe('-1')
    h.set('c1', 5)
    // Idle time writes the figures (x:Total is measured); the view over them steps.
    h.runtime.warm(5)
    expect(Number(h.value('Work'))).toBeGreaterThan(0)
    // Nothing changed: idle time writes nothing new, and the view does not step.
    const stepped: string[] = []
    const stop = h.runtime.views.onStep((v) => stepped.push(v.iri))
    h.runtime.warm(5)
    stop()
    expect(stepped).not.toContain(X + 'Work')
  })
})
