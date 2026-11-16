// Bar charts, heatmaps and line charts as text (c:RowChartText, charts.ttl): their name, then a line per
// row of the view in its order, the value in the viewer's locale. The SPARQL rule writes the same text as
// its function twin on Oxigraph and on Semblance's own engine, as the rows change, in every language.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'

const EX = 'https://example.org/#'

const DATA = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix iv: <https://semblance.dev/ns/view#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.org/#> .

ex:o1 ex:region "East" ; ex:channel "Web" ; ex:value 1200.5 ; ex:items 1000 .
ex:o2 ex:region "East" ; ex:channel "Store" ; ex:value 30 ; ex:items 100 .
ex:o3 ex:region "West" ; ex:channel "Web" ; ex:value 7.255 ; ex:items 1000 .
ex:o4 ex:region "North" ; ex:channel "Store" ; ex:items 100 .

ex:Ordered a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?region ?channel ?value ?items WHERE { ?o <https://example.org/#region> ?region ; <https://example.org/#channel> ?channel . OPTIONAL { ?o <https://example.org/#value> ?value } OPTIONAL { ?o <https://example.org/#items> ?items } } ORDER BY ?region DESC(?channel)""" .
ex:Unordered a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?region ?value WHERE { ?o <https://example.org/#region> ?region ; <https://example.org/#value> ?value }""" .
ex:None a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?region ?value WHERE { ?o <https://example.org/#nothing> ?region ; <https://example.org/#value> ?value }""" .
ex:Plain a sem:View ; rdfs:label "plain view" ; sem:select """SELECT ?region WHERE { ?o <https://example.org/#region> ?region }""" .

ex:web a c:series ; rdfs:label "Online"@en , "Онлайн"@uk ; c:key "Web" .
ex:a a c:BarChart ; rdfs:label "Sales" ; c:view ex:Ordered ; c:facetVariable "items" ; c:facetLabel "{value} items" ;
  c:categoryVariable "region" ; c:seriesVariable "channel" ; c:valueVariable "value" ; c:unit "€" ; c:legend ( ex:web ) .
ex:b a c:Heatmap ; rdfs:label "Unordered" ; c:view ex:Unordered ; c:categoryVariable "region" .
ex:c a c:LineChart ; rdfs:label "Lines" ; c:view ex:Ordered ; c:categoryVariable "items" ; c:seriesVariable "region" .
ex:d a c:BarChart ; c:view ex:None ; c:categoryVariable "region" ; c:emptyText "Nothing yet." .
ex:e a c:Heatmap ; c:label "Empty" ; c:view ex:None .
ex:f a c:LineChart ; c:view ex:Plain .
ex:g a c:BarChart .
`
const ROOTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

function mount(kind: 'oxigraph' | 'wat', prefer: 'sparql' | 'function', languages: string[] = []) {
  const store = loadStore(kind, DATA)
  const runtime = new Runtime(store)
  const shown = ROOTS.map((root) => {
    const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    const text = runtime.project({ modality: MOD.Text, layers: [], prefer, languages, name: root, roots: [EX + root] }, (e) => {
      throw e
    })
    return { renderer: new DomRenderer(text.index, document.getElementById('app')!, EX + root), app: document.getElementById('app')!, text, root }
  })
  const f = store.factory
  return {
    html: () => shown.map(({ renderer, app }) => (renderer.flush(), app.innerHTML)),
    text: () => shown.map(({ text, root }) => toText(text.index, EX + root)),
    change: (add: [string, string, string | number][], remove: [string, string][] = []) => {
      const q = ([s, p, o]: [string, string, string | number]) => f.quad(f.namedNode(EX + s), f.namedNode(EX + p), typeof o === 'number' ? f.literal(String(o), f.namedNode('http://www.w3.org/2001/XMLSchema#decimal')) : f.literal(o))
      runtime.apply({ add: add.map(q), remove: remove.flatMap(([s, p]) => store.match(f.namedNode(EX + s), f.namedNode(EX + p), null)) })
    },
  }
}

describe('charts of rows as text', () => {
  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`writes the same text in SPARQL as its function twin, as the rows change (${kind})`, () => {
      const [s, fn] = [mount(kind, 'sparql'), mount(kind, 'function')]
      const both = (step: (h: typeof s) => void) => {
        step(s)
        step(fn)
        expect(s.html()).toEqual(fn.html())
        expect(s.text()).toEqual(fn.text())
      }
      both(() => {})
      const [a, b, c, d, e, f, g] = s.text()
      // The view's order; the facet by its caption, a series by its legend label; a value not yet measured.
      expect(a!.split('\n')).toEqual(['Sales', '1000 items · East · Online: 1,200.5 €', '100 items · East · Store: 30 €', '100 items · North · Store: …', '1000 items · West · Online: 7.26 €'])
      expect(b!.split('\n').sort()).toEqual(['East: 1,200.5', 'East: 30', 'Unordered', 'West: 7.26'])
      expect(c).toContain('1000 · East: 1,200.5')
      expect(d).toBe('Nothing yet.')
      expect(e).toBe('Empty')
      expect(f).toBe('plain view is not a maintained view (iv:View, iv:materialize iv:Graph).')
      expect(g).toBe('No view.')
      both((h) => h.change([['o5', 'region', 'South'], ['o5', 'channel', 'Partner'], ['o5', 'value', 12]]))
      both((h) => h.change([['o4', 'value', 2]]))
      expect(s.text()[0]).toContain('100 items · North · Store: 2 €')
      both((h) => h.change([], [['o1', 'channel']]))
      both((h) => h.change([['n1', 'nothing', 'Somewhere'], ['n1', 'value', 3]]))
      expect(s.text()[3]).toBe('d\nSomewhere: 3')
    }, 120_000)
  }

  it('speaks the viewer\'s language', () => {
    const [s, fn] = [mount('wat', 'sparql', ['uk']), mount('wat', 'function', ['uk'])]
    expect(s.text()).toEqual(fn.text())
    expect(s.text()[0]).toMatch(/1000 items · East · Онлайн: 1\s200,5 €/u)
  }, 60_000)
})
