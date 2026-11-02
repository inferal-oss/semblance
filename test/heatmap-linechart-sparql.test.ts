// Heatmaps and line charts in SPARQL (#7): c:HeatmapRendering-sparql and c:LineChartRendering-sparql read
// the rows of the chart's maintained view (as a bar chart does) and lay them out with sx:log10 and
// sx:formatNumber; they render the same HTML as their function twins, as the rows change.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, SEM, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'

const EX = 'https://example.org/#'

const DATA = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix iv: <https://semblance.dev/ns/view#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.org/#> .

ex:m1 ex:size 100 ; ex:part "rules" ; ex:op "toggle" ; ex:ms 0.004 .
ex:m2 ex:size 100 ; ex:part "rules" ; ex:op "type" ; ex:ms 2.5 .
ex:m3 ex:size 100 ; ex:part "dom" ; ex:op "toggle" ; ex:ms 17.25 .
ex:m4 ex:size 1000 ; ex:part "rules" ; ex:op "toggle" ; ex:ms 150 .
ex:m5 ex:size 1000 ; ex:part "dom" ; ex:op "add" ; ex:ms 0.5 .
ex:m6 ex:size 1000 ; ex:part "dom" ; ex:op "type" .

ex:Matrix a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?items ?part ?label ?value ?overBudget WHERE { ?m <https://example.org/#size> ?items ; <https://example.org/#part> ?part ; <https://example.org/#op> ?label . OPTIONAL { ?m <https://example.org/#ms> ?value } BIND(COALESCE(?value > 16.7, false) AS ?overBudget) } ORDER BY ?items ?part ?label""" .
ex:Loose a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?label ?value WHERE { ?m <https://example.org/#op> ?label ; <https://example.org/#ms> ?value }""" .
ex:Scaling a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?part ?items (SUM(?ms) AS ?value) WHERE { ?m <https://example.org/#size> ?items ; <https://example.org/#part> ?part ; <https://example.org/#ms> ?ms } GROUP BY ?part ?items ORDER BY ?part ?items""" .
ex:Plain a sem:View ; rdfs:label "plain view" ; sem:select """SELECT ?label WHERE { ?m <https://example.org/#op> ?label }""" .

ex:heat a c:Heatmap ; rdfs:label "Latency" ; c:view ex:Matrix ; c:facetVariable "items" ; c:facetLabel "{value} items · ms" ;
  c:seriesVariable "part" ; c:categoryVariable "label" ; c:valueVariable "value" ; c:unit "ms" ;
  c:flagVariable "overBudget" ; c:flagLabel "over budget" .
ex:heat2 a c:Heatmap ; c:view ex:Loose ; c:categoryVariable "label" .
ex:heat3 a c:Heatmap ; c:view ex:Plain .
ex:heat4 a c:Heatmap .
ex:line a c:LineChart ; rdfs:label "Scaling" ; c:view ex:Scaling ; c:seriesVariable "part" ; c:categoryVariable "items" ; c:valueVariable "value" ; c:unit "ms" ;
  c:logScale true ; c:referenceLine "linear" ; c:emptyText "Two sizes, please." .
ex:dom a c:series ; c:key "dom" ; rdfs:label "DOM" .
ex:line2 a c:LineChart ; rdfs:label "Linear" ; c:view ex:Scaling ; c:seriesVariable "part" ; c:categoryVariable "items" ; c:valueVariable "value" ; c:legend ( ex:dom ) .
ex:line3 a c:LineChart ; c:view ex:Plain .
`

type Kind = 'wat' | 'rust'

function mount(kind: Kind, prefer: 'sparql' | 'function', roots: string[]) {
  const store = loadStore(kind, DATA)
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
    change: (add: [string, string, string | number][], remove: [string, string][] = []) => {
      const q = ([s, p, o]: [string, string, string | number]) => f.quad(f.namedNode(EX + s), f.namedNode(EX + p), typeof o === 'number' ? f.literal(String(o), f.namedNode('http://www.w3.org/2001/XMLSchema#decimal')) : f.literal(o))
      runtime.apply({ add: add.map(q), remove: remove.flatMap(([s, p]) => store.match(f.namedNode(EX + s), f.namedNode(EX + p), null)) })
    },
  }
}

describe('heatmaps and line charts in SPARQL', () => {
  for (const kind of ['wat'] as const) {
    it(`render as their function twins do, as the rows change (${kind})`, () => {
      const roots = (process.env.CHART_ROOTS ?? 'heat,heat2,heat3,heat4,line,line2,line3').split(',')
      const [s, fn] = [mount(kind, 'sparql', roots), mount(kind, 'function', roots)]
      const both = (step: (h: typeof s) => void) => {
        step(s)
        step(fn)
        const [a, b] = [s.html(), fn.html()]
        roots.forEach((r, i) => expect(a[i], r).toBe(b[i]))
      }
      both(() => {})
      if (!process.env.CHART_ROOTS) {
        const html = s.html()
        expect(html[0]).toContain('<figcaption>1,000 items · ms</figcaption>')
        expect(html[0]).toContain('class="sem-h12 sem-flagged"')
        expect(html[2]).toContain('plain view is not a maintained view')
        expect(html[3]).toBe('<p data-sem-c="heatmap" class="sem-empty">No view.</p>')
        expect(html[4]).toContain('class="sem-reference"')
        expect(html[5]).toContain('<text y="282" x="540.0" text-anchor="middle" class="sem-axis">1,000</text>')
      }
      both((h) => h.change([['m7', 'size', 100], ['m7', 'part', 'dom'], ['m7', 'op', 'add'], ['m7', 'ms', 3]]))
      both((h) => h.change([['m1', 'ms', 99.95]], [['m1', 'ms']]))
      both((h) => h.change([], [['m4', 'part']]))
      both((h) => h.change([['m8', 'size', 10000], ['m8', 'part', 'rules'], ['m8', 'op', 'toggle'], ['m8', 'ms', 2000]]))
    }, 300_000)
  }
})
