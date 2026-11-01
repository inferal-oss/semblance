// Charts, finding lists and formulas over maintained views, in SPARQL (#1): c:BarChartRendering-sparql,
// c:FindingListRendering-sparql and c:Formula-sparql read the rows and findings the views runtime keeps
// in the views graph (a formula's per component, iv:perReferrer),
// and render the same HTML as their function twins - faceted and not, with and without a declared
// legend, ordered (rs:index) and unordered rows, no rows, a view that is not maintained - on Oxigraph
// and on Semblance's own engine, after each change the data goes through.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, SEM, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'

const EX = 'https://example.org/#'

const BARS = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix iv: <https://semblance.dev/ns/view#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <https://example.org/#> .

ex:o1 ex:region "East" ; ex:channel "Web" ; ex:value 1200.5 ; ex:items 1000 .
ex:o2 ex:region "East" ; ex:channel "Store" ; ex:value 30 ; ex:items 100 .
ex:o3 ex:region "West (far)" ; ex:channel "Web" ; ex:value 7.25 ; ex:items 1000 .
ex:o4 ex:region "West (far)" ; ex:channel "Partner" ; ex:value 0.004 ; ex:items 100 .
ex:o5 ex:region "North" ; ex:channel "Store" ; ex:value 0 ; ex:items 100 .
ex:o6 ex:region "North" ; ex:channel "Web" ; ex:items 1000 .

ex:Ordered a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?region ?channel ?value ?items WHERE { ?o <https://example.org/#region> ?region ; <https://example.org/#channel> ?channel . OPTIONAL { ?o <https://example.org/#value> ?value } OPTIONAL { ?o <https://example.org/#items> ?items } } ORDER BY ?region DESC(?channel)""" .
ex:Unordered a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?region ?value WHERE { ?o <https://example.org/#region> ?region ; <https://example.org/#value> ?value }""" .
ex:Counts a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?region (COUNT(?o) AS ?value) WHERE { ?o <https://example.org/#region> ?region } GROUP BY ?region ORDER BY ?region""" .
ex:None a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?region ?value WHERE { ?o <https://example.org/#nothing> ?region ; <https://example.org/#value> ?value }""" .
ex:Plain a sem:View ; rdfs:label "plain view" ; sem:select """SELECT ?region WHERE { ?o <https://example.org/#region> ?region }""" .

ex:a a c:BarChart ; rdfs:label "Sales" ; c:view ex:Ordered ; c:categoryVariable "region" ; c:seriesVariable "channel" ; c:valueVariable "value" ; c:unit "€" .
ex:b a c:BarChart ; rdfs:label "Sales by size" ; c:view ex:Ordered ; c:facetVariable "items" ; c:facetLabel "{value} items" ; c:categoryVariable "region" ; c:seriesVariable "channel" ; c:valueVariable "value" ;
  c:legend ( ex:web ex:store ) .
ex:web a c:series ; rdfs:label "Online"@en , "Онлайн"@uk ; c:key "Web" .
ex:store a c:series ; rdfs:label "Shop" ; c:key "Store" .
ex:c a c:BarChart ; rdfs:label "Unordered" ; c:view ex:Unordered ; c:categoryVariable "region" .
ex:d a c:BarChart ; c:label "Counts" ; c:view ex:Counts ; c:categoryVariable "region" .
ex:e a c:BarChart ; c:view ex:None ; c:emptyText "Nothing yet." .
ex:f a c:BarChart ; c:view ex:None .
ex:g a c:BarChart ; c:view ex:Plain .
ex:h a c:BarChart .
`

const FINDINGS = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix iv: <https://semblance.dev/ns/view#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix perf: <https://semblance.dev/ns/perf#> .
@prefix ex: <https://example.org/#> .

ex:J a rdfs:Class .
ex:o1 ex:n 100 ; ex:t 3.5 . ex:o2 ex:n 1000 ; ex:t 40 . ex:o3 ex:n 20 ; ex:t 1 .
ex:Big a ex:J , iv:View ; rdfs:label "Big ones" ; sem:order 2 ;
  sem:construct """CONSTRUCT { ?f <https://semblance.dev/ns/perf#judgement> <https://example.org/#Big> ; sem:verdict <https://semblance.dev/ns/perf#Concern> ; sem:sortKey ?n ; sem:text ?text } WHERE { ?o <https://example.org/#n> ?n ; <https://example.org/#t> ?t FILTER(?t > 2) BIND(IRI(CONCAT("https://example.org/#big-", STR(?n))) AS ?f) BIND(CONCAT("At ", STR(?n), " it took ", STR(?t)) AS ?text) }""" .
ex:Words a ex:J , iv:View ; rdfs:label "Words" ; sem:order 1 ;
  sem:construct """CONSTRUCT { ?f <https://semblance.dev/ns/perf#judgement> <https://example.org/#Words> ; sem:sortKey ?k ; sem:text ?text } WHERE { VALUES (?k ?text) { ("b" "beta") ("a" "alpha") ("a" "aardvark") } BIND(IRI(CONCAT("https://example.org/#w-", ?text)) AS ?f) }""" .
ex:Nothing a ex:J , iv:View ; rdfs:label "Nothing" ;
  sem:construct """CONSTRUCT { ?f <https://semblance.dev/ns/perf#judgement> <https://example.org/#Nothing> } WHERE { ?f <https://example.org/#none> ?x }""" .
ex:Plain a ex:J ; rdfs:label "Plain" ; sem:order 3 ; sem:construct "CONSTRUCT {} WHERE {}" .
ex:K a rdfs:Class .
ex:list a c:FindingList ; c:judgementClass ex:J .
ex:empty a c:FindingList ; c:judgementClass ex:K ; c:emptyText "Run something." .
ex:empty2 a c:FindingList ; c:judgementClass ex:K .
`

const FORMULAS = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sty: <https://semblance.dev/ns/style#> .
@prefix iv: <https://semblance.dev/ns/view#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.org/#> .

ex:e1 ex:kind ex:In ; ex:amount 100 . ex:e2 ex:kind ex:Out ; ex:amount 30 . ex:e3 ex:kind ex:Out ; ex:amount 12.5 .
ex:Total a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT (SUM(?a) AS ?value) (IF(SUM(?a) > 100, sty:Warning, sty:Success) AS ?tone) WHERE { ?e <https://example.org/#amount> ?a }""" .
ex:Of a sem:View , iv:View ; iv:materialize iv:Graph ; iv:perReferrer c:valueQuery ;
  sem:select """SELECT (SUM(?amount) AS ?value) WHERE { $this <https://example.org/#sums> ?k . OPTIONAL { ?e <https://example.org/#kind> ?k ; <https://example.org/#amount> ?a } BIND(COALESCE(?a, 0) AS ?amount) }""" .
ex:Biggest a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?value ?label ?max WHERE { ?e <https://example.org/#amount> ?value BIND(CONCAT("biggest: ", STR(?value)) AS ?label) BIND(200 AS ?max) } ORDER BY DESC(?value) LIMIT 2""" .
ex:Unordered a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?value WHERE { ?e <https://example.org/#amount> ?value }""" .
ex:Count a sem:View , iv:View ; iv:materialize iv:Graph ; sem:select """SELECT (COUNT(?e) AS ?value) WHERE { ?e <https://example.org/#amount> ?x }""" .
ex:Nothing a sem:View , iv:View ; iv:materialize iv:Graph ; sem:select """SELECT ?value WHERE { ?e <https://example.org/#none> ?value }""" .

ex:page a c:Stack ; c:children ( ex:a ex:b ex:c ex:d ex:e ex:f ex:g ) .
ex:a a c:Stat ; c:label "Total" ; c:valueQuery ex:Total .
ex:b a c:Stat ; c:label "In" ; c:valueQuery ex:Of ; ex:sums ex:In .
ex:c a c:Stat ; c:label "Out" ; c:valueQuery ex:Of ; ex:sums ex:Out .
ex:d a c:Progress ; c:valueQuery ex:Biggest .
ex:e a c:Stat ; c:label "Some" ; c:valueQuery ex:Unordered .
ex:f a c:Stat ; c:label "Count" ; c:valueQuery ex:Count .
ex:g a c:Stat ; c:label "None" ; c:value 7 ; c:valueQuery ex:Nothing .
`

type Kind = 'oxigraph' | 'wat'

/** The components rendered on their own, with SPARQL or with function rules; html() after each change. */
function mount(turtle: string, kind: Kind, prefer: 'sparql' | 'function', roots: string[]) {
  const store = loadStore(kind, turtle)
  const runtime = new Runtime(store)
  const shown = roots.map((root) => {
    const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    const screen = runtime.project({ modality: MOD.Screen, layers: [STY.Layer, SEM.TooltipLayer], prefer, name: root, roots: [EX + root] }, (e) => {
      throw e
    })
    const renderer = new DomRenderer(screen.index, document.getElementById('app')!, EX + root)
    return { renderer, app: document.getElementById('app')! }
  })
  const f = store.factory
  return {
    html: () => shown.map(({ renderer, app }) => (renderer.flush(), app.innerHTML)),
    set: (s: string, p: string, o: string) => runtime.apply({ remove: store.match(f.namedNode(EX + s), f.namedNode(EX + p), null), add: [f.quad(f.namedNode(EX + s), f.namedNode(EX + p), f.namedNode(EX + o))] }),
    change: (add: [string, string, string | number][], remove: [string, string, string | number][] = []) => {
      const q = ([s, p, o]: [string, string, string | number]) => f.quad(f.namedNode(EX + s), f.namedNode(EX + p), typeof o === 'number' ? f.literal(String(o), f.namedNode('http://www.w3.org/2001/XMLSchema#decimal')) : f.literal(o))
      runtime.apply({ add: add.map(q), remove: remove.flatMap(([s, p]) => store.match(f.namedNode(EX + s), f.namedNode(EX + p), null)) })
    },
  }
}

describe('charts and finding lists over maintained views, in SPARQL', () => {
  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders bar charts as their function twins do, as the rows change (${kind})`, () => {
      const roots = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
      const [s, fn] = [mount(BARS, kind, 'sparql', roots), mount(BARS, kind, 'function', roots)]
      const both = (step: (h: typeof s) => void) => {
        step(s)
        step(fn)
        expect(s.html()).toEqual(fn.html())
      }
      both(() => {})
      const html = s.html()
      expect(html[0]).toContain('East · Web: 1201 €')
      expect(html[1]).toContain('<figcaption>1,000 items</figcaption>')
      expect(html[4]).toBe('<p data-sem-c="bar-chart" class="sem-empty">Nothing yet.</p>')
      expect(html[6]).toContain('plain view is not a maintained view')
      expect(html[7]).toBe('<p data-sem-c="bar-chart" class="sem-empty">No view.</p>')
      // A new region, a value changed, a series gone.
      both((h) => h.change([['o7', 'region', 'South'], ['o7', 'channel', 'Partner'], ['o7', 'value', 12]]))
      both((h) => h.change([['o1', 'value', 9.995]], [['o1', 'value', 0]]))
      both((h) => h.change([], [['o2', 'channel', 0]]))
      // The first rows of an empty view arrive.
      both((h) => h.change([['n1', 'nothing', 'Somewhere'], ['n1', 'value', 3]]))
      expect(s.html()[4]).not.toContain('Nothing yet.')
    }, 120_000)

    it(`renders finding lists as their function twins do, as the observations change (${kind})`, () => {
      const roots = ['list', 'empty', 'empty2']
      const [s, fn] = [mount(FINDINGS, kind, 'sparql', roots), mount(FINDINGS, kind, 'function', roots)]
      const both = (step: (h: typeof s) => void) => {
        step(s)
        step(fn)
        expect(s.html()).toEqual(fn.html())
      }
      both(() => {})
      const html = s.html()
      // Judgements in sem:order, findings by sort key, numbers as numbers.
      expect(html[0]!.indexOf('Words')).toBeLessThan(html[0]!.indexOf('Big ones'))
      expect(html[0]!.indexOf('At 100 ')).toBeLessThan(html[0]!.indexOf('At 1000 '))
      expect(html[0]).toContain('Plain is not a maintained view (iv:View).')
      expect(html[1]).toBe('<p data-sem-c="finding-list" class="sem-empty">Run something.</p>')
      expect(html[2]).toBe('<p data-sem-c="finding-list" class="sem-empty">No findings yet.</p>')
      both((h) => h.change([['o4', 'n', 50], ['o4', 't', 9]]))
      expect(s.html()[0]).toContain('At 50 it took 9')
      both((h) => h.change([], [['o2', 't', 0]]))
      expect(s.html()[0]).not.toContain('At 1000 ')
    }, 120_000)

    it(`writes formulas' values as their function twins do, a view per component that asks (${kind})`, () => {
      const [s, fn] = [mount(FORMULAS, kind, 'sparql', ['page']), mount(FORMULAS, kind, 'function', ['page'])]
      const both = (step: (h: typeof s) => void) => {
        step(s)
        step(fn)
        expect(s.html()).toEqual(fn.html())
      }
      const values = () => [...s.html()[0]!.matchAll(/class="sem-value">([^<]*)</g)].map((m) => m[1])
      both(() => {})
      // Total (toned), In and Out (one view each), the first of an unordered view, an aggregate, a stated value.
      expect(values()).toEqual(['142.5', '100', '42.5', '12.5', '3', '7'])
      expect(s.html()[0]).toContain('data-sem-tone="warning"')
      expect(s.html()[0]).toContain('aria-valuetext="biggest: 100"')
      both((h) => h.change([['e4', 'kind', 'x'], ['e4', 'amount', 250]]))
      both((h) => h.set('e4', 'kind', 'Out'))
      expect(values().slice(0, 3)).toEqual(['392.5', '100', '292.5'])
      both((h) => h.set('c', 'sums', 'In'))
      expect(values().slice(1, 3)).toEqual(['100', '100'])
    }, 120_000)
  }
})
