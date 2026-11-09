// Function twins of the shared parts of series charts (ontology/components/charts.ttl, "Series charts").
// c:SeriesPlan reads a maintained view's rows once and mints the chart's series (legend items), categories
// and points (one per series and category, the sum of their rows' values); c:SeriesLayout adds what a point
// needs from its neighbours (its stack base, the next point of its series), the first tab stop, and the
// value scale with its ticks. The frame writes the scale as custom properties and each point its own
// values, so the theme places the marks: a new scale re-renders the frame, a changed row its point.
import type { NamedNode, Term } from '@rdfjs/types'
import type { FnRule, Out, RuleContext } from '../engine/context.ts'
import { formatLocale } from '../engine/context.ts'
import { C, NS, RDF_TYPE, SEM, XSD_BOOLEAN } from '../ns.ts'
import { compareKeys, tupleKey } from '../render/order-key.ts'
import { formatNumber } from '../../rdf-engine/host/intl.ts'
import { encoding, message } from './charts.ts'
import { md5Key } from './data.ts'
import { labelOf, rdfList, str, text } from './util.ts'

const RS = NS.rs
const c = (local: string) => NS.c + local
const XSD_DOUBLE = NS.xsd + 'double'

/** A number as the theme reads it in a custom property: plain, at most four decimals (float noise never shows). */
export const cssNumber = (n: number) => formatNumber(n + 0, 'en-US', 'useGrouping=false;maximumFractionDigits=4')
/** A series' color: one of the theme's six series tokens, by its place in the legend. */
export const seriesColor = (index: number) => `var(--sem-series-${(index % 6) + 1})`

/** What a series chart shows instead of a chart, if anything: no view, a view that is not maintained, or no rows and an empty text. */
export function seriesMessage(ctx: RuleContext, chart: NamedNode): string | undefined {
  const view = ctx.object(chart, C.view)
  if (!view || !ctx.object(view, SEM.select)) return 'No view.'
  if (!ctx.match(view, RDF_TYPE, RS + 'ResultSet').length) return `${labelOf(ctx, view)} is not a maintained view (iv:View, iv:materialize iv:Graph).`
  if (!ctx.objects(view, RS + 'solution').length) return text(ctx, chart, C.emptyText)
  return undefined
}

type Row = { pos: number | string; cat: string; ser?: string; y?: number; x?: number; z?: number }

/** A literal's number, if it is one (as xsd:double reads it): undefined for anything else. */
const numberOf = (t: Term | undefined) => {
  const x = t?.termType === 'Literal' && t.value.trim() !== '' ? Number(t.value) : NaN
  return Number.isNaN(x) ? undefined : x
}

/** The chart's rows in long form: position (rs:index, else the row's IRI), category, series ('' without a series variable), value, and x and size when the chart has them. */
function rowsOf(ctx: RuleContext, chart: NamedNode, view: Term): Row[] {
  const e = encoding(ctx, chart)
  const xv = str(ctx.object(chart, c('xVariable'))), zv = str(ctx.object(chart, c('sizeVariable')))
  return ctx.objects(view, RS + 'solution').map((r) => {
    // A row's value of a variable is the node <row>-<variable> (view.ttl), read by its IRI.
    const value = (variable: string) => ctx.object(ctx.nn(`${r.value}-${variable}`), RS + 'value')
    const index = ctx.object(r, RS + 'index')
    return {
      pos: index ? Number(index.value) : r.value, cat: str(value(e.category)) ?? '', ser: e.series ? str(value(e.series)) : '',
      y: numberOf(value(e.value)), x: xv === undefined ? undefined : numberOf(value(xv)), z: zv === undefined ? undefined : numberOf(value(zv)),
    }
  })
}
const before = (a: number | string, b: number | string) => compareKeys(tupleKey([a]), tupleKey([b])) < 0

/** First-seen order of some keys over the rows. */
function firstSeen(rows: Row[], key: (r: Row) => string | undefined): string[] {
  const first = new Map<string, number | string>()
  for (const r of rows) {
    const k = key(r)
    if (k === undefined) continue
    const p = first.get(k)
    if (p === undefined || before(r.pos, p)) first.set(k, r.pos)
  }
  return [...first].sort((a, b) => (before(a[1], b[1]) ? -1 : 1)).map(([k]) => k)
}

/** The chart's series, minted as its legend's items: a declared legend (c:legend: by c:key, else the node), else the series variable's values as first seen, else one named by the chart. */
function mintSeries(ctx: RuleContext, o: Out, focus: NamedNode, rows: Row[]) {
  const e = encoding(ctx, focus)
  const declared = rdfList(ctx, ctx.object(focus, C.legend))
  const series = declared.length
    ? declared.map((s) => ({ key: str(ctx.object(s, C.key)) ?? s.value, label: labelOf(ctx, s) }))
    : e.series
      ? firstSeen(rows, (r) => r.ser).map((k) => ({ key: k, label: k }))
      : [{ key: '', label: labelOf(ctx, focus) }]
  const hidden = new Set(ctx.objects(focus, c('hiddenSeries')).map((t) => t.value))
  series.forEach((s, i) => {
    const n = o.node(`series-${md5Key(s.key)}`)
    o.t(n, RDF_TYPE, ctx.nn(c('ChartSeries'))).t(n, c('inChart'), focus).t(n, C.key, s.key).t(n, C.label, s.label).t(n, c('index'), int(ctx, i)).t(n, SEM.orderKey, tupleKey([i]))
    if (hidden.has(s.key)) o.t(n, c('hidden'), ctx.f.literal('true', ctx.nn(XSD_BOOLEAN)))
    o.t(o.node('legend'), NS.rdfhtml + 'hasChild', n)
  })
  return { series, hidden }
}
const int = (ctx: RuleContext, n: number) => ctx.f.literal(String(n), ctx.nn(NS.xsd + 'integer'))

/** c:SeriesPlan: the chart's series, categories and points, from its view's rows (a binned kind has a plan of its own). */
const plan: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const view = ctx.object(focus, C.view)
  if (!view || !ctx.match(view, RDF_TYPE, RS + 'ResultSet').length || kindSays(ctx, focus, c('binned'), 'true')) return o.quads
  const rows = rowsOf(ctx, focus, view)
  const { series, hidden } = mintSeries(ctx, o, focus, rows)
  // Categories, as first seen in any row.
  const categories = firstSeen(rows, (r) => r.cat)
  categories.forEach((cat, i) => {
    const n = o.node(`category-${md5Key(cat)}`)
    o.t(n, RDF_TYPE, ctx.nn(c('ChartCategory'))).t(n, c('inChart'), focus).t(n, c('index'), int(ctx, i)).t(n, C.label, cat)
  })
  // A point per shown series and category with a value: the sum of its rows' (and of their x and size, when the
  // chart has them; a chart with an x variable has no point without one).
  const pointClass = ctx.objects(focus, RDF_TYPE).flatMap((t) => ctx.objects(t, c('pointClass')))[0]
  const hasX = !!ctx.object(focus, c('xVariable')), hasZ = !!ctx.object(focus, c('sizeVariable'))
  const sum = (xs: (number | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0)
  series.forEach((s, si) => {
    if (hidden.has(s.key)) return
    categories.forEach((cat, ci) => {
      const these = rows.filter((r) => r.ser === s.key && r.cat === cat && r.y !== undefined)
      const values = these.map((r) => r.y!)
      if (!values.length || (hasX && !these.some((r) => r.x !== undefined))) return
      const n = o.node(`point-${md5Key(s.key)}-${md5Key(cat)}`)
      o.t(n, RDF_TYPE, ctx.nn(c('ChartPoint'))).t(n, c('inChart'), focus).t(n, c('series'), o.node(`series-${md5Key(s.key)}`)).t(n, c('category'), cat)
      if (pointClass) o.t(n, RDF_TYPE, pointClass)
      o.t(n, c('value'), ctx.f.literal(String(values.reduce((a, b) => a + b, 0)), ctx.nn(XSD_DOUBLE)))
      if (hasX) o.t(n, c('x'), ctx.f.literal(String(sum(these.map((r) => r.x))), ctx.nn(XSD_DOUBLE)))
      if (hasZ) o.t(n, c('size'), ctx.f.literal(String(sum(these.map((r) => r.z))), ctx.nn(XSD_DOUBLE)))
      o.t(n, c('seriesIndex'), int(ctx, si)).t(n, c('categoryIndex'), int(ctx, ci)).t(n, SEM.orderKey, tupleKey([si, ci]))
      o.t(o.node('marks'), NS.rdfhtml + 'hasChild', n)
    })
  })
  return o.quads
}

/**
 * c:HistogramPlan: a binned kind's series, bins and counts. The bins are nice steps (1, 2 or 5 × 10ⁿ) for about
 * c:binCount of them (default 10, at most 50) from a step below the least value to past the greatest; each is a
 * category (c:lower, c:upper) and a point per shown series counts its rows' values in it.
 */
const histogramPlan: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const view = ctx.object(focus, C.view)
  if (!view || !ctx.match(view, RDF_TYPE, RS + 'ResultSet').length) return o.quads
  const rows = rowsOf(ctx, focus, view)
  const values = rows.filter((r) => r.y !== undefined).map((r) => r.y!)
  if (!values.length) return o.quads
  const { series, hidden } = mintSeries(ctx, o, focus, rows)
  const asked = Math.floor(Number(str(ctx.object(focus, c('binCount'))) ?? 10))
  const bins = Number.isNaN(asked) ? 10 : Math.min(50, Math.max(1, asked))
  const lo = Math.min(...values), hi = Math.max(...values)
  const step = niceStep((hi - lo > 0 ? hi - lo : 1) / bins)
  const start = Math.floor(lo / step) * step
  const count = Math.floor((hi - start) / step) + 1
  const dbl = (n: number) => ctx.f.literal(String(n), ctx.nn(XSD_DOUBLE))
  const pointClass = ctx.objects(focus, RDF_TYPE).flatMap((t) => ctx.objects(t, c('pointClass')))[0]
  const binOf = (y: number) => Math.floor((y - start) / step)
  for (let k = 0; k < count; k++) {
    const lower = start + k * step, upper = start + (k + 1) * step
    const n = o.node(`category-${md5Key(String(k))}`)
    o.t(n, RDF_TYPE, ctx.nn(c('ChartCategory'))).t(n, c('inChart'), focus).t(n, c('index'), int(ctx, k)).t(n, C.label, `${cssNumber(lower)}–${cssNumber(upper)}`)
    o.t(n, c('lower'), dbl(lower)).t(n, c('upper'), dbl(upper))
    series.forEach((s, si) => {
      if (hidden.has(s.key)) return
      const counted = rows.filter((r) => r.ser === s.key && r.y !== undefined && binOf(r.y) === k).length
      if (!counted) return
      const p = o.node(`point-${md5Key(s.key)}-${md5Key(String(k))}`)
      o.t(p, RDF_TYPE, ctx.nn(c('ChartPoint'))).t(p, c('inChart'), focus).t(p, c('series'), o.node(`series-${md5Key(s.key)}`)).t(p, c('category'), `${cssNumber(lower)}–${cssNumber(upper)}`)
      if (pointClass) o.t(p, RDF_TYPE, pointClass)
      o.t(p, c('value'), dbl(counted)).t(p, c('lower'), dbl(lower)).t(p, c('upper'), dbl(upper))
      o.t(p, c('seriesIndex'), int(ctx, si)).t(p, c('categoryIndex'), int(ctx, k)).t(p, SEM.orderKey, tupleKey([si, k]))
      o.t(o.node('marks'), NS.rdfhtml + 'hasChild', p)
    })
  }
  return o.quads
}

type Point = { node: NamedNode; si: number; ci: number; v: number; base: number; x?: number; z?: number }

/** Whether the chart's class (or a class it is a subclass of) says `p value`: a kind's defaults, as c:fromZero false or c:polar true. */
export function kindSays(ctx: RuleContext, chart: Term, p: string, value: string): boolean {
  const seen = new Set<string>()
  const up = (t: Term): boolean => {
    if (seen.has(t.value)) return false
    seen.add(t.value)
    return ctx.objects(t, p).some((v) => v.value === value) || ctx.objects(t, NS.rdfs + 'subClassOf').some(up)
  }
  return ctx.objects(chart, RDF_TYPE).some(up)
}

/** The minted points of a chart, with their stack bases (the sum of the earlier shown series' values in the category, when c:stacked). */
function pointsOf(ctx: RuleContext, chart: NamedNode): Point[] {
  const stacked = ctx.object(chart, c('stacked'))?.value === 'true'
  const points = ctx
    .match(null, c('inChart'), chart)
    .map((q) => q.subject as NamedNode)
    .filter((p) => ctx.match(p, RDF_TYPE, c('ChartPoint')).length)
    .map((node) => ({
      node, si: Number(str(ctx.object(node, c('seriesIndex')))), ci: Number(str(ctx.object(node, c('categoryIndex')))), v: Number(str(ctx.object(node, c('value')))), base: 0,
      x: numberOf(ctx.object(node, c('x'))), z: numberOf(ctx.object(node, c('size'))),
    }))
  if (stacked) for (const p of points) p.base = points.filter((q) => q.ci === p.ci && q.si < p.si).reduce((a, q) => a + q.v, 0)
  return points
}

/** A nice scale over [lo, hi] (each at least including 0): a step of 1, 2 or 5 × 10ⁿ that needs about five, its ends on steps. */
/** The least step of 1, 2 or 5 × 10ⁿ at least `raw`. */
export function niceStep(raw: number) {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const r = raw / mag
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * mag
}

export function niceScale(lo: number, hi: number) {
  const span = hi - lo > 0 ? hi - lo : 1
  const step = niceStep(span / 5)
  const min = Math.floor(lo / step) * step
  const max = Math.max(Math.ceil(hi / step) * step, min + step)
  const count = Math.round((max - min) / step)
  return { min, max, step, ticks: Array.from({ length: Math.min(count, 12) + 1 }, (_, k) => min + k * step) }
}

/** c:SeriesLayout: each point's stack base and next point, the first tab stop, the value scale and its ticks. */
const layout: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const points = pointsOf(ctx, focus)
  if (!points.length) return o.quads
  const dbl = (n: number) => ctx.f.literal(String(n), ctx.nn(XSD_DOUBLE))
  let first = points[0]!
  // A point's rank: how many shown series with points come before its series (a group's place).
  const shown = [...new Set(points.map((p) => p.si))]
  for (const p of points) {
    o.t(p.node, c('base'), dbl(p.base)).t(p.node, c('rank'), ctx.f.literal(String(shown.filter((si) => si < p.si).length), ctx.nn(NS.xsd + 'integer')))
    const next = points.find((q) => q.si === p.si && q.ci === p.ci + 1)
    if (next) o.t(p.node, c('nextValue'), dbl(next.v)).t(p.node, c('nextBase'), dbl(next.base))
    if (p.si < first.si || (p.si === first.si && p.ci < first.ci)) first = p
  }
  o.t(first.node, c('first'), ctx.f.literal('true', ctx.nn(XSD_BOOLEAN)))
  // The value scale spans every point's ends, and zero unless the kind says otherwise (c:fromZero false).
  const zero = kindSays(ctx, focus, c('fromZero'), 'false') ? [] : [0]
  const writeScale = (local: string, link: string, lo: number, hi: number) => {
    const s = niceScale(lo, hi)
    const scale = o.node(local)
    o.t(focus, c(link), scale).t(scale, RDF_TYPE, ctx.nn(c('ValueScale'))).t(scale, c('min'), dbl(s.min)).t(scale, c('max'), dbl(s.max))
    s.ticks.forEach((at, k) => {
      const tick = o.node(`${local}-tick-${k}`)
      o.t(scale, c('tick'), tick).t(tick, c('at'), dbl(at)).t(tick, c('index'), ctx.f.literal(String(k), ctx.nn(NS.xsd + 'integer')))
    })
  }
  // A point's ends: its value, and its base when it is stacked on others.
  const stacked = ctx.object(focus, c('stacked'))?.value === 'true'
  const ends = points.flatMap((p) => (stacked ? [p.base, p.base + p.v] : [p.v]))
  writeScale('scale', 'valueScale', Math.min(...zero, ...ends), Math.max(...zero, ...ends))
  // An x scale over the points' x, and the greatest size, when the chart has them.
  const xs = points.filter((p) => p.x !== undefined).map((p) => p.x!)
  if (xs.length) writeScale('xscale', 'xScale', Math.min(...zero, ...xs), Math.max(...zero, ...xs))
  const zs = points.filter((p) => p.z !== undefined).map((p) => p.z!)
  if (zs.length) o.t(focus, c('sizeMax'), dbl(Math.max(...zs)))
  // A polar kind (a pie): each point's share of the positive total, and where it starts (the shares before it).
  if (kindSays(ctx, focus, c('polar'), 'true')) {
    const positive = (p: Point) => (p.v > 0 ? p.v : 0)
    const total = points.reduce((a, p) => a + positive(p), 0)
    o.t(focus, c('total'), dbl(total))
    const order = (p: Point) => p.si * 1000000 + p.ci
    if (total > 0) for (const p of points) {
      o.t(p.node, c('from'), dbl(points.filter((q) => order(q) < order(p)).reduce((a, q) => a + positive(q), 0) / total)).t(p.node, c('share'), dbl(positive(p) / total))
    }
  }
  return o.quads
}

/** The chart's unit in the viewer's language, if any. */
const unitOf = (ctx: RuleContext, chart: Term) => text(ctx, chart, C.unit) ?? ''

/** A value in the viewer's locale, with the chart's unit: what a point says and its tooltip shows. */
export function valueText(ctx: RuleContext, chart: Term, v: number): string {
  ctx.readsLanguage()
  const unit = unitOf(ctx, chart)
  return `${formatNumber(v, formatLocale(ctx.languages), 'maximumFractionDigits=2')}${unit ? ' ' + unit : ''}`
}

/** The frame of a chart with axes (its scale and number of categories as custom properties): the plot with its ticks and marks, the categories, the legend. */
const frame: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const msg = seriesMessage(ctx, focus)
  if (msg !== undefined) return message(ctx, focus, msg)
  const scale = ctx.objects(focus, c('valueScale')).find((s) => ctx.match(s, RDF_TYPE, c('ValueScale')).length)
  const categories = ctx
    .match(null, c('inChart'), focus)
    .map((q) => q.subject as NamedNode)
    .filter((n) => ctx.match(n, RDF_TYPE, c('ChartCategory')).length)
    .map((n) => ({ n, i: Number(str(ctx.object(n, c('index')))), label: str(ctx.object(n, C.label)) ?? '' }))
    .sort((a, b) => a.i - b.i)
  ctx.readsLanguage()
  const locale = formatLocale(ctx.languages)
  // A bin is named by its bounds, in the viewer's locale.
  for (const cat of categories) {
    const lower = numberOf(ctx.object(cat.n, c('lower'))), upper = numberOf(ctx.object(cat.n, c('upper')))
    if (lower !== undefined && upper !== undefined) cat.label = `${formatNumber(lower + 0, locale, 'maximumFractionDigits=4')} – ${formatNumber(upper + 0, locale, 'maximumFractionDigits=4')}`
  }
  const tickEls = (s: Term | undefined, local: string, cls: string) => (s ? ctx.objects(s, c('tick')) : [])
    .map((t) => ({ k: Number(str(ctx.object(t, c('index')))), at: Number(str(ctx.object(t, c('at')))) }))
    .sort((a, b) => a.k - b.k)
    .map(({ k, at }) => o.el(`${local}-${k}`, 'Span', { class: cls, style: `--at: ${cssNumber(at)}` }, [o.text(`${local}-${k}-text`, formatNumber(at + 0, locale, 'maximumFractionDigits=4'))]))
  const ticks = tickEls(scale, 'tick', 'sem-chart-tick')
  const xScale = ctx.objects(focus, c('xScale')).find((s) => ctx.match(s, RDF_TYPE, c('ValueScale')).length)
  const sizeMax = ctx.object(focus, c('sizeMax'))
  const k = new Set(ctx.match(null, c('inChart'), focus).map((q) => q.subject).filter((p) => ctx.match(p, RDF_TYPE, c('ChartPoint')).length).map((p) => str(ctx.object(p, c('seriesIndex'))))).size
  const range = (s: Term | undefined, lo: string, hi: string) => (s ? [`${lo}: ${cssNumber(Number(str(ctx.object(s, c('min')))))}`, `${hi}: ${cssNumber(Number(str(ctx.object(s, c('max')))))}`] : [])
  const style = [...range(scale, '--lo', '--hi'), ...range(xScale, '--xlo', '--xhi'), ...(sizeMax ? [`--zmax: ${cssNumber(Number(sizeMax.value))}`] : []), `--n: ${categories.length}`, `--k: ${k}`].join('; ')
  const plot = o.el('plot', 'Div', { class: 'sem-chart-plot' }, [
    o.el('ticks', 'Div', { class: 'sem-chart-ticks', 'aria-hidden': 'true' }, ticks),
    o.el('marks', 'Ol', { class: 'sem-chart-marks', 'aria-label': labelOf(ctx, focus) }),
  ])
  // Below the plot: the x scale's ticks when the chart has one, else its categories.
  const axis = xScale
    ? o.el('xticks', 'Div', { class: 'sem-chart-xticks', 'aria-hidden': 'true' }, tickEls(xScale, 'xtick', 'sem-chart-xtick'))
    : o.el('categories', 'Div', { class: 'sem-chart-categories', 'aria-hidden': 'true' }, categories.map(({ i, label }) =>
        o.el(`cat-${i}`, 'Span', { style: `--i: ${i}` }, [o.text(`cat-${i}-text`, label)]),
      ))
  o.renders(o.el('root', 'Figure', { style }, [plot, axis, o.el('legend', 'Ul', { class: 'sem-legend' })]))
  return o.quads
}

/** A legend item: the series' swatch and name. */
const seriesItem: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  if (!ctx.object(focus, c('inChart'))) return o.quads
  const i = Number(str(ctx.object(focus, c('index'))))
  o.renders(o.el('root', 'Li', {}, [o.el('swatch', 'I', { style: `background: ${seriesColor(i)}`, 'aria-hidden': 'true' }), o.text('label', str(ctx.object(focus, C.label)) ?? '')]))
  return o.quads
}

/** A point's x and size in words, around its value: "xLabel x, value unit, sizeLabel size" (the labels default to the variables' names). */
export function measures(ctx: RuleContext, chart: Term, y: number, x: number | undefined, z: number | undefined): string {
  ctx.readsLanguage()
  const locale = formatLocale(ctx.languages)
  const label = (p: string, v: string) => text(ctx, chart, c(p)) ?? str(ctx.object(chart, c(v))) ?? ''
  const xPart = x === undefined ? '' : `${label('xLabel', 'xVariable')} ${formatNumber(x, locale, 'maximumFractionDigits=2')}, `
  const zPart = z === undefined ? '' : `, ${label('sizeLabel', 'sizeVariable')} ${formatNumber(z, locale, 'maximumFractionDigits=2')}`
  return `${xPart}${valueText(ctx, chart, y)}${zPart}`
}

/** What a point says: "category · series: value unit" (the series when the chart has more than one; x and size when it has them). */
export function pointWords(ctx: RuleContext, point: NamedNode, chart: Term): string {
  const series = ctx.object(point, c('series'))
  const many = !!ctx.object(chart, C.seriesVariable) || !!ctx.object(chart, C.legend)
  const seriesLabel = many && series ? str(ctx.object(series, C.label)) ?? '' : ''
  // A bin: its bounds with the chart's unit, then how many values fall in it.
  const lower = numberOf(ctx.object(point, c('lower'))), upper = numberOf(ctx.object(point, c('upper')))
  if (lower !== undefined && upper !== undefined) {
    ctx.readsLanguage()
    const locale = formatLocale(ctx.languages), unit = unitOf(ctx, chart)
    const bounds = `${formatNumber(lower + 0, locale, 'maximumFractionDigits=4')} – ${formatNumber(upper + 0, locale, 'maximumFractionDigits=4')}${unit ? ' ' + unit : ''}`
    return `${[bounds, seriesLabel].filter((x) => x !== '').join(' · ')}: ${formatNumber(Number(str(ctx.object(point, c('value')))), locale, 'maximumFractionDigits=2')}`
  }
  const head = [str(ctx.object(point, c('category'))) ?? '', seriesLabel].filter((x) => x !== '').join(' · ')
  const share = numberOf(ctx.object(point, c('share')))
  const percent = share === undefined ? '' : ` (${formatNumber(share, formatLocale(ctx.languages), 'style=percent;maximumFractionDigits=1')})`
  return `${head}: ${measures(ctx, chart, Number(str(ctx.object(point, c('value')))), numberOf(ctx.object(point, c('x'))), numberOf(ctx.object(point, c('size'))))}${percent}`
}

/** The custom properties every point writes: its category, value, base, next point, x, size, share, and color (by its series, or its category in a pie). */
export function pointStyle(ctx: RuleContext, point: NamedNode, colorBy: 'seriesIndex' | 'categoryIndex' = 'seriesIndex'): string {
  const n = (p: string) => str(ctx.object(point, c(p)))
  const parts = [`--i: ${n('categoryIndex')}`, `--s: ${n('seriesIndex')}`, `--r: ${n('rank') ?? 0}`, `--v: ${cssNumber(Number(n('value')))}`, `--b: ${cssNumber(Number(n('base') ?? 0))}`]
  if (n('nextValue') !== undefined) parts.push(`--nv: ${cssNumber(Number(n('nextValue')))}`, `--nb: ${cssNumber(Number(n('nextBase') ?? 0))}`)
  if (n('x') !== undefined) parts.push(`--x: ${cssNumber(Number(n('x')))}`)
  if (n('size') !== undefined) parts.push(`--z: ${cssNumber(Number(n('size')))}`)
  if (n('share') !== undefined) parts.push(`--from: ${cssNumber(Number(n('from')))}`, `--share: ${cssNumber(Number(n('share')))}`)
  parts.push(`--color: ${seriesColor(Number(n(colorBy)))}`)
  return parts.join('; ')
}

/** A point: a list item (a tab stop when it is the first) holding its marks, its words hidden on screen, and its tooltip. */
export function pointItem(ctx: RuleContext, o: Out, point: NamedNode, chart: Term, cls: string, marks: NamedNode[], colorBy: 'seriesIndex' | 'categoryIndex' = 'seriesIndex') {
  const words = pointWords(ctx, point, chart)
  const li = o.el('root', 'Li', { class: `sem-point ${cls}`, style: pointStyle(ctx, point, colorBy), tabindex: ctx.object(point, c('first')) ? '0' : '-1' }, [
    ...marks,
    o.el('words', 'Span', { class: 'sem-visually-hidden' }, [o.text('words-text', words)]),
  ])
  o.tip(li, words)
  o.renders(li)
}

/** An area chart's point: a dot, and when its series goes on, the area and the line to the next. */
const areaPoint: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const chart = ctx.object(focus, c('inChart'))
  if (!chart) return o.quads
  const next = ctx.object(focus, c('nextValue')) !== undefined
  const marks = next
    ? [o.el('area', 'Span', { class: 'sem-area', 'aria-hidden': 'true' }), o.el('line', 'Span', { class: 'sem-segment', 'aria-hidden': 'true' })]
    : []
  pointItem(ctx, o, focus, chart, 'sem-area-point', [...marks, o.el('dot', 'Span', { class: 'sem-dot', 'aria-hidden': 'true' })])
  return o.quads
}

/** A column chart's point: a bar from its base to its value; side by side with the other series' (grouped), or on them (c:stacked). */
const columnPoint: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const chart = ctx.object(focus, c('inChart'))
  if (!chart) return o.quads
  const stacked = ctx.object(chart, c('stacked'))?.value === 'true'
  pointItem(ctx, o, focus, chart, stacked ? 'sem-column-point sem-stacked' : 'sem-column-point', [o.el('bar', 'Span', { class: 'sem-bar', 'aria-hidden': 'true' })])
  return o.quads
}

/** A scatter chart's point: a dot at its x and value, as large as its size when the chart has one (a bubble). */
const scatterPoint: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const chart = ctx.object(focus, c('inChart'))
  if (!chart) return o.quads
  pointItem(ctx, o, focus, chart, 'sem-scatter-point', [o.el('dot', 'Span', { class: 'sem-dot', 'aria-hidden': 'true' })])
  return o.quads
}

/** A pie's slice: a wedge from where the shares before it end, as wide as its share, in its category's color. */
const slicePoint: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const chart = ctx.object(focus, c('inChart'))
  if (!chart) return o.quads
  pointItem(ctx, o, focus, chart, 'sem-slice-point', [o.el('slice', 'Span', { class: 'sem-slice', 'aria-hidden': 'true' })], 'categoryIndex')
  return o.quads
}

/** A pie's frame: the pie (its slices, a donut's total in the hole), and a key of its categories in their colors. */
const pieFrame: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const msg = seriesMessage(ctx, focus)
  if (msg !== undefined) return message(ctx, focus, msg)
  const categories = ctx
    .match(null, c('inChart'), focus)
    .map((q) => q.subject as NamedNode)
    .filter((n) => ctx.match(n, RDF_TYPE, c('ChartCategory')).length)
    .map((n) => ({ i: Number(str(ctx.object(n, c('index')))), label: str(ctx.object(n, C.label)) ?? '' }))
    .sort((a, b) => a.i - b.i)
  const total = numberOf(ctx.object(focus, c('total')))
  const hole = kindSays(ctx, focus, c('hole'), 'true') && total !== undefined
    ? [o.el('total', 'Span', { class: 'sem-pie-total', 'aria-hidden': 'true' }, [o.text('total-text', valueText(ctx, focus, total))])]
    : []
  const pie = o.el('pie', 'Div', { class: 'sem-pie' }, [o.el('marks', 'Ol', { class: 'sem-chart-marks', 'aria-label': labelOf(ctx, focus) }), ...hole])
  const keys = o.el('keys', 'Ul', { class: 'sem-legend' }, categories.map(({ i, label }) =>
    o.el(`key-${i}`, 'Li', {}, [o.el(`key-${i}-swatch`, 'I', { style: `background: ${seriesColor(i)}`, 'aria-hidden': 'true' }), o.text(`key-${i}-text`, label)]),
  ))
  o.renders(o.el('root', 'Figure', {}, [pie, keys]))
  return o.quads
}

/** Whether a node is an instance of the class, or of a subclass of it. */
export function isKind(ctx: RuleContext, node: Term, cls: string): boolean {
  const seen = new Set<string>()
  const up = (t: Term): boolean => {
    if (seen.has(t.value)) return false
    seen.add(t.value)
    return t.value === cls || ctx.objects(t, NS.rdfs + 'subClassOf').some(up)
  }
  return ctx.objects(node, RDF_TYPE).some(up)
}

/** A series chart as text: its name, then its points, each a line of its words. */
const textFrame: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const msg = seriesMessage(ctx, focus)
  if (msg !== undefined) return message(ctx, focus, msg)
  o.renders(o.el('root', 'Div', {}, [o.el('title', 'P', {}, [o.text('title-text', labelOf(ctx, focus))]), o.el('marks', 'Div')]))
  return o.quads
}

/** A point as a line of text: its words. */
const pointText: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const chart = ctx.object(focus, c('inChart'))
  if (!chart) return o.quads
  o.renders(o.el('root', 'P', {}, [o.text('words-text', pointWords(ctx, focus, chart))]))
  return o.quads
}

export const seriesFunctions: Record<string, FnRule> = {
  'series:plan': plan,
  'series:histogram-plan': histogramPlan,
  'series:text': textFrame,
  'series:point-text': pointText,
  'series:layout': layout,
  'series:frame': frame,
  'series:legend-item': seriesItem,
  'series:area-point': areaPoint,
  'series:column-point': columnPoint,
  'series:scatter-point': scatterPoint,
  'series:slice-point': slicePoint,
  'series:pie-frame': pieFrame,
}
