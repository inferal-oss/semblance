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

type Row = { pos: number | string; cat: string; ser?: string; x?: number }

/** The chart's rows in long form: position (rs:index, else the row's IRI), category, series ('' without a series variable), value. */
function rowsOf(ctx: RuleContext, chart: NamedNode, view: Term): Row[] {
  const e = encoding(ctx, chart)
  return ctx.objects(view, RS + 'solution').map((r) => {
    // A row's value of a variable is the node <row>-<variable> (view.ttl), read by its IRI.
    const value = (variable: string) => ctx.object(ctx.nn(`${r.value}-${variable}`), RS + 'value')
    const index = ctx.object(r, RS + 'index')
    const raw = value(e.value)
    const x = raw?.termType === 'Literal' && raw.value.trim() !== '' ? Number(raw.value) : NaN
    return { pos: index ? Number(index.value) : r.value, cat: str(value(e.category)) ?? '', ser: e.series ? str(value(e.series)) : '', x: Number.isNaN(x) ? undefined : x }
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

/** c:SeriesPlan: the chart's series, categories and points, from its view's rows. */
const plan: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const view = ctx.object(focus, C.view)
  if (!view || !ctx.match(view, RDF_TYPE, RS + 'ResultSet').length) return o.quads
  const e = encoding(ctx, focus)
  const rows = rowsOf(ctx, focus, view)
  // Series: a declared legend (c:legend: by c:key, else the node), else the series variable's values as first seen, else one named by the chart.
  const declared = rdfList(ctx, ctx.object(focus, C.legend))
  const series = declared.length
    ? declared.map((s) => ({ key: str(ctx.object(s, C.key)) ?? s.value, label: labelOf(ctx, s) }))
    : e.series
      ? firstSeen(rows, (r) => r.ser).map((k) => ({ key: k, label: k }))
      : [{ key: '', label: labelOf(ctx, focus) }]
  const hidden = new Set(ctx.objects(focus, c('hiddenSeries')).map((t) => t.value))
  const int = (n: number) => ctx.f.literal(String(n), ctx.nn(NS.xsd + 'integer'))
  series.forEach((s, i) => {
    const n = o.node(`series-${md5Key(s.key)}`)
    o.t(n, RDF_TYPE, ctx.nn(c('ChartSeries'))).t(n, c('inChart'), focus).t(n, C.key, s.key).t(n, C.label, s.label).t(n, c('index'), int(i)).t(n, SEM.orderKey, tupleKey([i]))
    if (hidden.has(s.key)) o.t(n, c('hidden'), ctx.f.literal('true', ctx.nn(XSD_BOOLEAN)))
    o.t(o.node('legend'), NS.rdfhtml + 'hasChild', n)
  })
  // Categories, as first seen in any row.
  const categories = firstSeen(rows, (r) => r.cat)
  categories.forEach((cat, i) => {
    const n = o.node(`category-${md5Key(cat)}`)
    o.t(n, RDF_TYPE, ctx.nn(c('ChartCategory'))).t(n, c('inChart'), focus).t(n, c('index'), int(i)).t(n, C.label, cat)
  })
  // A point per shown series and category with a value: the sum of its rows'.
  const pointClass = ctx.objects(focus, RDF_TYPE).flatMap((t) => ctx.objects(t, c('pointClass')))[0]
  series.forEach((s, si) => {
    if (hidden.has(s.key)) return
    categories.forEach((cat, ci) => {
      const values = rows.filter((r) => r.ser === s.key && r.cat === cat && r.x !== undefined).map((r) => r.x!)
      if (!values.length) return
      const n = o.node(`point-${md5Key(s.key)}-${md5Key(cat)}`)
      o.t(n, RDF_TYPE, ctx.nn(c('ChartPoint'))).t(n, c('inChart'), focus).t(n, c('series'), o.node(`series-${md5Key(s.key)}`)).t(n, c('category'), cat)
      if (pointClass) o.t(n, RDF_TYPE, pointClass)
      o.t(n, c('value'), ctx.f.literal(String(values.reduce((a, b) => a + b, 0)), ctx.nn(XSD_DOUBLE)))
      o.t(n, c('seriesIndex'), int(si)).t(n, c('categoryIndex'), int(ci)).t(n, SEM.orderKey, tupleKey([si, ci]))
      o.t(o.node('marks'), NS.rdfhtml + 'hasChild', n)
    })
  })
  return o.quads
}

type Point = { node: NamedNode; si: number; ci: number; v: number; base: number }

/** The minted points of a chart, with their stack bases (the sum of the earlier shown series' values in the category, when c:stacked). */
function pointsOf(ctx: RuleContext, chart: NamedNode): Point[] {
  const stacked = ctx.object(chart, c('stacked'))?.value === 'true'
  const points = ctx
    .match(null, c('inChart'), chart)
    .map((q) => q.subject as NamedNode)
    .filter((p) => ctx.match(p, RDF_TYPE, c('ChartPoint')).length)
    .map((node) => ({ node, si: Number(str(ctx.object(node, c('seriesIndex')))), ci: Number(str(ctx.object(node, c('categoryIndex')))), v: Number(str(ctx.object(node, c('value')))), base: 0 }))
  if (stacked) for (const p of points) p.base = points.filter((q) => q.ci === p.ci && q.si < p.si).reduce((a, q) => a + q.v, 0)
  return points
}

/** A nice scale over [lo, hi] (each at least including 0): a step of 1, 2 or 5 × 10ⁿ that needs about five, its ends on steps. */
export function niceScale(lo: number, hi: number) {
  const span = hi - lo > 0 ? hi - lo : 1
  const raw = span / 5
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const r = raw / mag
  const step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * mag
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
  const lo = Math.min(0, ...points.map((p) => Math.min(p.base, p.base + p.v)))
  const hi = Math.max(0, ...points.map((p) => Math.max(p.base, p.base + p.v)))
  const s = niceScale(lo, hi)
  const scale = o.node('scale')
  o.t(focus, c('valueScale'), scale).t(scale, RDF_TYPE, ctx.nn(c('ValueScale'))).t(scale, c('min'), dbl(s.min)).t(scale, c('max'), dbl(s.max))
  s.ticks.forEach((at, k) => {
    const tick = o.node(`scale-tick-${k}`)
    o.t(scale, c('tick'), tick).t(tick, c('at'), dbl(at)).t(tick, c('index'), ctx.f.literal(String(k), ctx.nn(NS.xsd + 'integer')))
  })
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
  const ticks = (scale ? ctx.objects(scale, c('tick')) : [])
    .map((t) => ({ k: Number(str(ctx.object(t, c('index')))), at: Number(str(ctx.object(t, c('at')))) }))
    .sort((a, b) => a.k - b.k)
    .map(({ k, at }) => o.el(`tick-${k}`, 'Span', { class: 'sem-chart-tick', style: `--at: ${cssNumber(at)}` }, [o.text(`tick-${k}-text`, formatNumber(at, locale, 'maximumFractionDigits=4'))]))
  const k = new Set(ctx.match(null, c('inChart'), focus).map((q) => q.subject).filter((p) => ctx.match(p, RDF_TYPE, c('ChartPoint')).length).map((p) => str(ctx.object(p, c('seriesIndex'))))).size
  const counts = `--n: ${categories.length}; --k: ${k}`
  const style = scale ? `--lo: ${cssNumber(Number(str(ctx.object(scale, c('min')))))}; --hi: ${cssNumber(Number(str(ctx.object(scale, c('max')))))}; ${counts}` : counts
  const plot = o.el('plot', 'Div', { class: 'sem-chart-plot' }, [
    o.el('ticks', 'Div', { class: 'sem-chart-ticks', 'aria-hidden': 'true' }, ticks),
    o.el('marks', 'Ol', { class: 'sem-chart-marks', 'aria-label': labelOf(ctx, focus) }),
  ])
  const axis = o.el('categories', 'Div', { class: 'sem-chart-categories', 'aria-hidden': 'true' }, categories.map(({ i, label }) =>
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

/** What a point says: "category · series: value unit" (the series when the chart has more than one). */
export function pointWords(ctx: RuleContext, point: NamedNode, chart: Term): string {
  const series = ctx.object(point, c('series'))
  const many = !!ctx.object(chart, C.seriesVariable) || !!ctx.object(chart, C.legend)
  const head = [str(ctx.object(point, c('category'))) ?? '', many && series ? str(ctx.object(series, C.label)) ?? '' : ''].filter((x) => x !== '').join(' · ')
  return `${head}: ${valueText(ctx, chart, Number(str(ctx.object(point, c('value')))))}`
}

/** The custom properties every point writes: its category, value, base, next point, and color. */
export function pointStyle(ctx: RuleContext, point: NamedNode): string {
  const n = (p: string) => str(ctx.object(point, c(p)))
  const parts = [`--i: ${n('categoryIndex')}`, `--s: ${n('seriesIndex')}`, `--r: ${n('rank') ?? 0}`, `--v: ${cssNumber(Number(n('value')))}`, `--b: ${cssNumber(Number(n('base') ?? 0))}`]
  if (n('nextValue') !== undefined) parts.push(`--nv: ${cssNumber(Number(n('nextValue')))}`, `--nb: ${cssNumber(Number(n('nextBase') ?? 0))}`)
  parts.push(`--color: ${seriesColor(Number(n('seriesIndex')))}`)
  return parts.join('; ')
}

/** A point: a list item (a tab stop when it is the first) holding its marks, its words hidden on screen, and its tooltip. */
export function pointItem(ctx: RuleContext, o: Out, point: NamedNode, chart: Term, cls: string, marks: NamedNode[]) {
  const words = pointWords(ctx, point, chart)
  const li = o.el('root', 'Li', { class: `sem-point ${cls}`, style: pointStyle(ctx, point), tabindex: ctx.object(point, c('first')) ? '0' : '-1' }, [
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

export const seriesFunctions: Record<string, FnRule> = {
  'series:plan': plan,
  'series:layout': layout,
  'series:frame': frame,
  'series:legend-item': seriesItem,
  'series:area-point': areaPoint,
  'series:column-point': columnPoint,
}
