// Series charts (charts.ttl, "Series charts"): c:SeriesPlan and c:SeriesLayout mint a chart's series,
// categories and points from its maintained view's rows; the frame, the legend's items and each kind's
// points render the same HTML in SPARQL as their function twins on Oxigraph and on Semblance's own
// engine, after each change the rows go through; a changed row re-renders its points, not the chart.
import { describe, expect, it } from 'vitest'
import { niceScale, quantile } from '../src/components/series.ts'
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

const COLUMNS = `${PREFIXES}${SALES}
ex:a a c:ColumnChart ; rdfs:label "Grouped" ; c:view ex:Sales ; c:categoryVariable "month" ; c:seriesVariable "channel" ; c:valueVariable "amount" ; c:unit "€" .
ex:b a c:ColumnChart ; rdfs:label "Stacked" ; c:view ex:Sales ; c:categoryVariable "month" ; c:seriesVariable "channel" ; c:valueVariable "amount" ; c:stacked true ;
  c:legend ( ex:web ex:store ) .
ex:c a c:ColumnChart ; rdfs:label "Totals" ; c:view ex:Totals ; c:categoryVariable "month" .
ex:d a c:ColumnChart ; rdfs:label "Hidden" ; c:view ex:Sales ; c:categoryVariable "month" ; c:seriesVariable "channel" ; c:valueVariable "amount" ; c:hiddenSeries "Store" .
`

const SCATTER = `${PREFIXES}
ex:k1 ex:name "Kyiv" ; ex:region "East" ; ex:area 839 ; ex:people 2.95 ; ex:age 1482 .
ex:k2 ex:name "Lviv" ; ex:region "West" ; ex:area 182 ; ex:people 0.72 ; ex:age 770 .
ex:k3 ex:name "Odesa" ; ex:region "South" ; ex:area 236 ; ex:people 1.01 ; ex:age 230 .
ex:k4 ex:name "Kharkiv" ; ex:region "East" ; ex:area 350 ; ex:people 1.42 .
ex:k5 ex:name "Nowhere" ; ex:region "West" ; ex:people 0.1 ; ex:age 10 .
ex:Cities a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?name ?region ?area ?people ?age WHERE { ?c <https://example.org/#name> ?name ; <https://example.org/#region> ?region ; <https://example.org/#people> ?people . OPTIONAL { ?c <https://example.org/#area> ?area } OPTIONAL { ?c <https://example.org/#age> ?age } } ORDER BY ?name""" .
ex:a a c:ScatterChart ; rdfs:label "Cities" ; c:view ex:Cities ; c:categoryVariable "name" ; c:seriesVariable "region" ; c:xVariable "area" ; c:valueVariable "people" ;
  c:unit "M" ; c:xLabel "area, km²"@en , "площа, км²"@uk .
ex:b a c:ScatterChart ; rdfs:label "Bubbles" ; c:view ex:Cities ; c:categoryVariable "name" ; c:xVariable "area" ; c:valueVariable "people" ; c:sizeVariable "age" ; c:sizeLabel "years" .
`

const PIES = `${PREFIXES}${SALES}
ex:a a c:PieChart ; rdfs:label "Totals" ; c:view ex:Totals ; c:categoryVariable "month" ; c:unit "€" .
ex:b a c:DonutChart ; rdfs:label "Donut" ; c:view ex:Totals ; c:categoryVariable "month" ; c:unit "€" .
ex:c a c:PieChart ; rdfs:label "By channel" ; c:view ex:Sales ; c:categoryVariable "month" ; c:seriesVariable "channel" ; c:valueVariable "amount" .
ex:d a c:DonutChart ; c:view ex:None ; c:emptyText "Nothing yet." .
`

const HISTOGRAMS = `${PREFIXES}
${[12, 15, 15.5, 18, 21, 22, 22.5, 23, 27, 31, 33.3, 48].map((v, i) => `ex:h${i} ex:ms ${v} ; ex:kind "${i % 3 ? 'warm' : 'cold'}" .`).join('\n')}
ex:Times a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?ms ?kind WHERE { ?h <https://example.org/#ms> ?ms ; <https://example.org/#kind> ?kind }""" .
ex:a a c:Histogram ; rdfs:label "Times" ; c:view ex:Times ; c:valueVariable "ms" ; c:unit "ms" .
ex:b a c:Histogram ; rdfs:label "By kind" ; c:view ex:Times ; c:valueVariable "ms" ; c:seriesVariable "kind" ; c:binCount 4 ; c:stacked true .
ex:c a c:Histogram ; c:view ex:Times ; c:valueVariable "nothing" ; c:emptyText "x" .
`

const SPARKS = `${PREFIXES}${SALES}
ex:WebTrend a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?month ?amount WHERE { ?s <https://example.org/#month> ?month ; <https://example.org/#channel> "Web" ; <https://example.org/#at> ?at ; <https://example.org/#amount> ?amount } ORDER BY ?at""" .
ex:StoreTrend a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?month ?amount WHERE { ?s <https://example.org/#month> ?month ; <https://example.org/#channel> "Store" ; <https://example.org/#at> ?at ; <https://example.org/#amount> ?amount } ORDER BY ?at""" .
ex:web-spark a c:Sparkline ; rdfs:label "Web trend" ; c:view ex:WebTrend ; c:categoryVariable "month" ; c:valueVariable "amount" ; c:unit "€" .
ex:store-spark a c:Sparkline ; rdfs:label "Store trend" ; c:view ex:StoreTrend ; c:categoryVariable "month" ; c:valueVariable "amount" ; c:unit "€" .
ex:web ex:spark ex:web-spark . ex:store ex:spark ex:store-spark .
ex:Channels a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?channel ?trend WHERE { ?c <https://semblance.dev/ns/component#key> ?channel ; <https://example.org/#spark> ?trend } ORDER BY ?channel""" .
ex:t a c:Table ; c:label "Channels" ; c:query ex:Channels ; c:tableColumns ( ex:col-channel ex:col-trend ) .
ex:col-channel a c:Column ; c:variable "channel" ; c:label "Channel" .
ex:col-trend a c:Column ; c:variable "trend" ; c:label "Trend" ; c:format "component" .
`

const BOXES = `${PREFIXES}
${[['a', 'x', 1], ['a', 'x', 2], ['a', 'x', 4], ['a', 'x', 4], ['a', 'x', 10], ['a', 'y', 3], ['a', 'y', 5], ['b', 'x', 7], ['b', 'y', 2], ['b', 'y', 8], ['b', 'y', 8.5]].map(([g, s, v], i) => `ex:v${i} ex:group "${g}" ; ex:set "${s}" ; ex:ms ${v} .`).join('\n')}
ex:Spread a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?group ?set ?ms WHERE { ?v <https://example.org/#group> ?group ; <https://example.org/#set> ?set ; <https://example.org/#ms> ?ms } ORDER BY ?group ?set ?ms""" .
ex:a a c:BoxPlot ; rdfs:label "Spread" ; c:view ex:Spread ; c:categoryVariable "group" ; c:seriesVariable "set" ; c:valueVariable "ms" ; c:unit "ms" .
ex:b a c:BoxPlot ; rdfs:label "One set" ; c:view ex:Spread ; c:categoryVariable "group" ; c:valueVariable "ms" ; c:hiddenSeries "nothing" .
`

const AXES = `${PREFIXES}${SALES}
ex:web2 a c:series ; rdfs:label "Online" ; c:key "Web" .
ex:store2 a c:series ; rdfs:label "Shop share" ; c:key "Store" ; c:axis c:SecondaryAxis .
ex:a a c:ColumnChart ; rdfs:label "Dual" ; c:view ex:Sales ; c:categoryVariable "month" ; c:seriesVariable "channel" ; c:valueVariable "amount" ;
  c:unit "€" ; c:secondaryUnit "%" ; c:legend ( ex:web2 ex:store2 ) ; c:annotation ex:budget , ex:normal , ex:broken .
ex:budget a c:Threshold ; rdfs:label "Budget"@en , "Бюджет"@uk ; c:at 300 .
ex:normal a c:MarkedRange ; rdfs:label "Normal" ; c:fromValue 100 ; c:toValue 130 .
ex:broken a c:Threshold ; rdfs:label "Nothing" .
ex:b a c:AreaChart ; rdfs:label "Notes" ; c:view ex:Totals ; c:categoryVariable "month" ; c:annotation ex:budget .
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
      expect(a).toContain('<figure style="--lo: -50; --hi: 150; --n: 3; --k: 2"')
      expect(a).toContain('Mar · Web: 100 €')
      expect(a!.match(/class="sem-area"/g)).toHaveLength(4)
      expect(a!.match(/tabindex="0"/g)).toHaveLength(1)
      expect(b).toContain('<li data-sem-c="chart-series"><button type="button" aria-pressed="true"><i style="background: var(--sem-series-1)" aria-hidden="true"></i>Shop</button></li>')
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
    }, 300_000)
  }

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders column charts, grouped and stacked, as their function twins do (${kind})`, () => {
      const { s, both } = parity(COLUMNS, kind, ['a', 'b', 'c', 'd'])
      const [a, b, c, d] = s.html()
      // Grouped: each series by its rank among the shown ones; stacked: on the earlier series.
      expect(a).toContain('<figure style="--lo: -50; --hi: 150; --n: 3; --k: 2"')
      expect(a).toContain('class="sem-point sem-column-point"')
      expect(a).toContain('--i: 0; --s: 1; --r: 1; --v: 120.5')
      expect(b).toContain('class="sem-point sem-column-point sem-stacked"')
      expect(b).toContain('--i: 0; --s: 1; --r: 1; --v: 80; --b: 120.5')
      expect(c!.match(/sem-column-point/g)).toHaveLength(3)
      expect(d).toContain('--k: 1"')
      expect(d).toContain('--i: 0; --s: 1; --r: 0;')
      both((h) => h.set('s2', 'amount', 95))
      both((h) => h.runtime.apply({ remove: h.store.match(h.store.factory.namedNode(EX + 'd'), h.store.factory.namedNode(C + 'hiddenSeries'), null), add: [] }))
      expect(s.html()[3]).toContain('--k: 2"')
      both((h) => h.runtime.apply({ add: [h.store.factory.quad(h.store.factory.namedNode(EX + 'a'), h.store.factory.namedNode(C + 'stacked'), h.store.factory.literal('true', h.store.factory.namedNode('http://www.w3.org/2001/XMLSchema#boolean')))], remove: [] }))
      expect(s.html()[0]).toContain('sem-stacked')
    }, 120_000)
  }

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders scatter and bubble charts as their function twins do (${kind})`, () => {
      const { s, both } = parity(SCATTER, kind, ['a', 'b'])
      const [a, b] = s.html()
      // Scales that need not start at zero; x ticks below the plot; no point without an x.
      expect(a).toContain('<figure style="--lo: 0.5; --hi: 3; --xlo: 0; --xhi: 1000; --n: 5; --k: 3"')
      expect(a).toContain('class="sem-chart-xticks"')
      expect(a).not.toContain('class="sem-chart-categories"')
      expect(a).toContain('Kyiv · East: area, km² 839, 2.95 M')
      expect(a).not.toContain('Nowhere')
      expect(b).toContain('--zmax: 1482;')
      expect(b).toContain('--x: 236; --z: 230')
      expect(b).toContain('Odesa: area 236, 1.01, years 230')
      expect(s.text()[0]).toContain('Kyiv · East: area, km² 839, 2.95 M')
      both((h) => h.set('k5', 'area', 1500))
      expect(s.html()[0]).toContain('--xhi: 1500')
      both((h) => h.set('k2', 'people', 3.5))
      both((h) => h.set('k1', 'area', undefined))
    }, 120_000)
  }

  it('speaks the viewer\'s language in its words', () => {
    const { s } = parity(SCATTER, 'wat', ['a'], ['uk'])
    expect(s.html()[0]).toMatch(/Kyiv · East: площа, км² 839, 2,95 M/u)
  }, 60_000)

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders pie and donut charts as their function twins do (${kind})`, () => {
      const { s, both } = parity(PIES, kind, ['a', 'b', 'c', 'd'])
      const [a, b, c, d] = s.html()
      // Shares of the positive total (Mar's 80 of 480.5), in each category's color; a key, no axes.
      expect(a).toContain('class="sem-pie"')
      expect(a).not.toContain('sem-chart-tick')
      expect(a).toMatch(/Mar: 80 € \(16\.6%\)/)
      expect(a).toContain('--from: 0.8335; --share: 0.1665; --color: var(--sem-series-3)')
      expect(a).not.toContain('sem-pie-total')
      expect(b).toContain('<span class="sem-pie-total" aria-hidden="true">480.5 €</span>')
      // Two series: each its slices; a negative value has no share.
      expect(c).toContain('Mar · Store: -20 (0%)')
      expect(d).toBe('<p data-sem-c="donut-chart" class="sem-empty">Nothing yet.</p>')
      both((h) => h.set('s1', 'amount', 400))
      both((h) => (h.set('s9', 'month', 'Apr'), h.set('s9', 'channel', 'Web'), h.set('s9', 'at', 4), h.set('s9', 'amount', 10)))
    }, 120_000)
  }

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders histograms as their function twins do (${kind})`, () => {
      const { s, both } = parity(HISTOGRAMS, kind, ['a', 'b', 'c'])
      const [a, b] = s.html()
      // Bins of 5 from 10 to 50 (about ten); each a column as tall as its count, named by its bounds.
      expect(a).toContain('--n: 8;')
      expect(a).toContain('>10 – 15</span>')
      expect(a).toContain('20 – 25 ms: 4')
      expect(a!.match(/sem-column-point/g)).toHaveLength(6)
      expect(b).toContain('--n: 4;')
      expect(s.text()[0]).toContain('20 – 25 ms: 4')
      both((h) => h.set('h11', 'ms', 24))
      expect(s.html()[0]).toContain('20 – 25 ms: 5')
      both((h) => h.set('h0', 'ms', -3))
    }, 120_000)
  }

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders sparklines, alone and in a table's cells, as their function twins do (${kind})`, () => {
      const { s, both } = parity(SPARKS, kind, ['web-spark', 't'])
      const [spark, table] = s.html()
      // A small plot on a scale of its own values; no axes, no legend.
      expect(spark).toMatch(/^<span style="--lo: 100; --hi: 140; --n: 3; --k: 1" data-sem-c="sparkline"><ol class="sem-chart-marks" aria-label="Web trend">/)
      expect(spark).not.toContain('sem-legend')
      expect(spark).toContain('Mar: 100 €')
      // The table's component column holds each row's sparkline.
      expect(table!.match(/data-sem-c="sparkline"/g)).toHaveLength(2)
      expect(table).toContain('aria-label="Store trend"')
      expect(s.text()[1]).toContain('Web trend')
      both((h) => h.set('s5', 'amount', 300))
      expect(s.html()[0]).toContain('--hi: 350')
    }, 120_000)
  }

  it('takes quantiles between the closest ranks', () => {
    expect(quantile([1, 2, 4, 4, 10], 0.25)).toBe(2)
    expect(quantile([1, 2, 4, 4, 10], 0.5)).toBe(4)
    expect(quantile([3, 5], 0.25)).toBe(3.5)
    expect(quantile([7], 0.75)).toBe(7)
  })

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders box plots as their function twins do (${kind})`, () => {
      const { s, both } = parity(BOXES, kind, ['a', 'b'])
      const [a, b] = s.html()
      // A box per series and category: median, quartiles, range; the scale spans the whiskers.
      expect(a).toContain('a · x: median 4 ms; quartiles 2 – 4; range 1 – 10')
      expect(a).toContain('a · y: median 4 ms; quartiles 3.5 – 4.5; range 3 – 5')
      expect(a).toContain('--q1: 2; --q3: 4; --low: 1; --high: 10')
      expect(a).toContain('<figure style="--lo: 0; --hi: 10;')
      expect(a!.match(/sem-box-point/g)).toHaveLength(4)
      expect(b).toContain('b: median 7.5; quartiles 5.75 – 8.13; range 2 – 8.5')
      expect(s.text()[0]).toContain('a · x: median 4 ms')
      both((h) => h.set('v4', 'ms', 3))
      expect(s.html()[0]).toContain('a · x: median 3 ms; quartiles 2 – 4; range 1 – 4')
      both((h) => h.set('v11', 'group', 'c') || h.set('v11', 'set', 'x') || h.set('v11', 'ms', 20))
    }, 120_000)
  }

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders dual axes and annotations as their function twins do (${kind})`, () => {
      const { s, both } = parity(AXES, kind, ['a', 'b'])
      const [a, b] = s.html()
      // A series on the secondary axis has a scale of its own; the primary spans the annotations.
      expect(a).toContain('<figure style="--lo: 0; --hi: 300; --lo2: -20; --hi2: 80;')
      expect(a).toContain('class="sem-chart-ticks sem-secondary"')
      expect(a).toContain('class="sem-point sem-column-point sem-secondary"')
      expect(a).toContain('<li data-sem-c="chart-series" class="sem-secondary">')
      expect(a).toContain('Jan · Shop share: 80 %')
      expect(a).toContain('<span style="--at: 300" class="sem-threshold">Budget: 300 €</span>')
      expect(a).toContain('<span style="--from: 100; --to: 130" class="sem-marked-range">Normal: 100 – 130 €</span>')
      expect(a).not.toContain('Nothing')
      expect(b).toContain('Budget: 300')
      expect(s.text()[0]).toContain('Budget: 300 €')
      both((h) => h.set('s4', 'amount', 160))
      both((h) => h.runtime.apply({ remove: h.store.match(h.store.factory.namedNode(EX + 'budget'), null, null), add: [] }))
      expect(s.html()[0]).not.toContain('Budget')
    }, 120_000)
  }

  it('says its annotations in the viewer\'s language', () => {
    const { s } = parity(AXES, 'wat', ['a'], ['uk'])
    expect(s.html()[0]).toContain('Бюджет: 300 €')
  }, 60_000)

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`toggles a series from its legend item, in SPARQL as its function twin does (${kind})`, () => {
      const { s, fn, both } = parity(AREAS, kind, ['a'])
      const toggle = (h: typeof s) => h.shown[0]!.click([...h.shown[0]!.app.querySelectorAll('[data-sem-c=chart-series] button')].find((b) => b.textContent === 'Store')!)
      both(toggle)
      for (const h of [s, fn]) {
        expect(h.store.match(h.store.factory.namedNode(EX + 'a'), h.store.factory.namedNode(C + 'hiddenSeries'), null).map((q) => q.object.value)).toEqual(['Store'])
        expect(h.html()[0]).not.toContain('Jan · Store')
        expect(h.html()[0]).toContain('aria-pressed="false"><i style="background: var(--sem-series-1)" aria-hidden="true"></i>Store</button>')
      }
      both(toggle)
      expect(s.html()[0]).toContain('Jan · Store')
      expect(s.html()[0]).not.toContain('aria-pressed="false"')
    }, 120_000)
  }

  for (const chart of ['AreaChart', 'ColumnChart']) it(`re-renders the points a changed row moves, whatever the number of categories (${chart}, wat, SPARQL)`, () => {
    const cost = (n: number) => {
      const rows = Array.from({ length: n }, (_, i) => `ex:r${i} ex:month "m${String(i).padStart(3, '0')}" ; ex:channel "${i % 2 ? 'Web' : 'Store'}" ; ex:amount ${10 + (i % 7)} ; ex:at ${i} .`).join('\n')
      const view = `ex:Sales a sem:View , iv:View ; iv:materialize iv:Graph ; sem:select """SELECT ?month ?channel ?amount WHERE { ?s <https://example.org/#month> ?month ; <https://example.org/#channel> ?channel ; <https://example.org/#at> ?at . OPTIONAL { ?s <https://example.org/#amount> ?amount } } ORDER BY ?at""" .`
      const h = mount(`${PREFIXES}${rows}\n${view}\nex:a a c:${chart} ; c:view ex:Sales ; c:categoryVariable "month" ; c:seriesVariable "channel" ; c:valueVariable "amount" .`, 'wat', 'sparql', ['a'])
      h.html()
      const { engine } = h.shown[0]!.screen
      const runs = () => [...engine.stats.byRule.entries()].filter(([rule]) => /PointRendering|ChartSeriesRendering|AxisChartRendering/.test(rule)).reduce((a, [, st]) => a + st.runs, 0)
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
