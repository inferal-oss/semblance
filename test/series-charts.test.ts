// Series charts (charts.ttl, "Series charts"): c:SeriesPlan and c:SeriesLayout mint a chart's series,
// categories and points from its maintained view's rows; the frame, the legend's items and each kind's
// points render the same HTML in SPARQL as their function twins on Oxigraph and on Semblance's own
// engine, after each change the rows go through; a changed row re-renders its points, not the chart.
import { describe, expect, it } from 'vitest'
import { niceScale } from '../src/components/series.ts'
import { EX, mount, parity, PREFIXES, SALES } from './series-harness.ts'

const C = 'https://semblance.dev/ns/component#'

const AREAS = `${PREFIXES}${SALES}
ex:a a c:AreaChart ; rdfs:label "Sales" ; c:view ex:Sales ; c:categoryVariable "month" ; c:seriesVariable "channel" ; c:valueVariable "amount" ; c:unit "€" .
ex:b a c:AreaChart ; rdfs:label "Stacked" ; c:view ex:Sales ; c:categoryVariable "month" ; c:seriesVariable "channel" ; c:valueVariable "amount" ; c:stacked true ;
  c:legend ( ex:store ex:web ) .
ex:c a c:AreaChart ; rdfs:label "Totals" ; c:view ex:Totals ; c:categoryVariable "month" .
ex:d a c:AreaChart ; c:view ex:None ; c:emptyText "Nothing yet." .
ex:e a c:AreaChart ; c:view ex:Plain .
ex:f a c:AreaChart .
ex:g a c:AreaChart ; rdfs:label "Hidden" ; c:view ex:Sales ; c:categoryVariable "month" ; c:seriesVariable "channel" ; c:valueVariable "amount" ; c:hiddenSeries "Store" .
`

describe('series charts', () => {
  it('scales on steps of 1, 2 or 5 × 10ⁿ', () => {
    expect(niceScale(0, 201)).toMatchObject({ min: 0, max: 250, step: 50 })
    expect(niceScale(-20, 260.5)).toMatchObject({ min: -100, max: 300, step: 100 })
    expect(niceScale(0, 0)).toMatchObject({ min: 0, max: 0.2, step: 0.2 })
    expect(niceScale(0, 0.37).ticks).toHaveLength(5)
  })

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders area charts in SPARQL as their function twins do, as the rows change (${kind})`, () => {
      const roots = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
      const { s, both } = parity(AREAS, kind, roots)
      const [a, b, c, d, e, f, g] = s.html()
      expect(a).toContain('<figure style="--lo: -50; --hi: 150; --n: 3"')
      expect(a).toContain('Mar · Web: 100 €')
      expect(a!.match(/class="sem-area"/g)).toHaveLength(4)
      expect(a!.match(/tabindex="0"/g)).toHaveLength(1)
      expect(b).toContain('<li data-sem-c="chart-series"><i style="background: var(--sem-series-1)" aria-hidden="true"></i>Shop</li>')
      expect(b).toContain('--b: 80')
      expect(c!.match(/data-sem-c="chart-series"/g)).toHaveLength(1)
      expect(d).toBe('<p data-sem-c="area-chart" class="sem-empty">Nothing yet.</p>')
      expect(e).toContain('plain view is not a maintained view')
      expect(f).toBe('<p data-sem-c="area-chart" class="sem-empty">No view.</p>')
      expect(g).not.toContain('Mar · Store')
      expect(s.text()[0]).toContain('Jan · Web: 120.5 €')
      // A value changes, a month is added, a row loses its value, a series is shown again.
      both((h) => h.set('s3', 'amount', 1400))
      both((h) => (h.set('s8', 'month', 'Apr'), h.set('s8', 'channel', 'Store'), h.set('s8', 'at', 4), h.set('s8', 'amount', 30)))
      both((h) => h.set('s5', 'amount', undefined))
      both((h) => h.runtime.apply({ remove: h.store.match(h.store.factory.namedNode(EX + 'g'), h.store.factory.namedNode(C + 'hiddenSeries'), null), add: [] }))
      expect(s.html()[6]).toContain('Mar · Store')
    }, 120_000)
  }

  it('re-renders the points a changed row moves, whatever the number of categories (wat, SPARQL)', () => {
    const cost = (n: number) => {
      const rows = Array.from({ length: n }, (_, i) => `ex:r${i} ex:month "m${String(i).padStart(3, '0')}" ; ex:channel "${i % 2 ? 'Web' : 'Store'}" ; ex:amount ${10 + (i % 7)} ; ex:at ${i} .`).join('\n')
      const view = `ex:Sales a sem:View , iv:View ; iv:materialize iv:Graph ; sem:select """SELECT ?month ?channel ?amount WHERE { ?s <https://example.org/#month> ?month ; <https://example.org/#channel> ?channel ; <https://example.org/#at> ?at . OPTIONAL { ?s <https://example.org/#amount> ?amount } } ORDER BY ?at""" .`
      const h = mount(`${PREFIXES}${rows}\n${view}\nex:a a c:AreaChart ; c:view ex:Sales ; c:categoryVariable "month" ; c:seriesVariable "channel" ; c:valueVariable "amount" .`, 'wat', 'sparql', ['a'])
      h.html()
      const { engine } = h.shown[0]!.screen
      const runs = () => [...engine.stats.byRule.entries()].filter(([rule]) => /AreaPointRendering|ChartSeriesRendering|AxisChartRendering/.test(rule)).reduce((a, [, st]) => a + st.runs, 0)
      const before = { written: engine.stats.derivedAdded + engine.stats.derivedRemoved, runs: runs() }
      // Within the scale: the frame and the other points stay as they are.
      h.set('r3', 'amount', 12.5)
      h.html()
      return { written: engine.stats.derivedAdded + engine.stats.derivedRemoved - before.written, runs: runs() - before.runs }
    }
    const small = cost(10)
    const large = cost(80)
    expect(small.runs).toBeLessThanOrEqual(2)
    expect(large).toEqual(small)
  }, 120_000)
})
