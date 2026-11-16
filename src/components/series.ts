// Function twins of the shared parts of series charts (ontology/components/charts.ttl, "Series charts").
// c:SeriesPlan reads a maintained view's rows once and mints the chart's series (legend items), categories
// and points (one per series and category, the sum of their rows' values); c:SeriesLayout adds what a point
// needs from its neighbours (its stack base, the next point of its series), the first tab stop, and the
// value scale with its ticks. The frame writes the scale as custom properties and each point its own
// values, so the theme places the marks: a new scale re-renders the frame, a changed row its point.
import type { NamedNode, Term } from '@rdfjs/types'
import type { FnRule, Out, RuleContext } from '../engine/context.ts'
import type { ReactionFn } from '../behaviour/events.ts'
import { formatLocale } from '../engine/context.ts'
import { C, NS, RDF_TYPE, SEM, XSD_BOOLEAN } from '../ns.ts'
import { compareKeys, tupleKey } from '../render/order-key.ts'
import { formatNumber } from '../../rdf-engine/host/intl.ts'
import { encoding, message } from './charts.ts'
import { md5Key } from './data.ts'
import { labelOf, RDFS_LABEL, rdfList, str, text } from './util.ts'

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

type Row = { pos: number | string; fac: string; cat: string; ser?: string; y?: number; x?: number; z?: number; n: number; measured: boolean; flag: boolean }

/** A literal's number, if it is one (as xsd:double reads it): undefined for anything else. */
const numberOf = (t: Term | undefined) => {
  const x = t?.termType === 'Literal' && t.value.trim() !== '' ? Number(t.value) : NaN
  return Number.isNaN(x) ? undefined : x
}

/** The chart's rows in long form: position (rs:index, else the row's IRI), category, series ('' without a series variable), value, and x and size when the chart has them. */
function rowsOf(ctx: RuleContext, chart: NamedNode, view: Term): Row[] {
  const e = encoding(ctx, chart)
  const xv = str(ctx.object(chart, c('xVariable'))), zv = str(ctx.object(chart, c('sizeVariable')))
  // Only a faceted kind reads its facet.
  const fv = kindSays(ctx, chart, c('faceted'), 'true') ? e.facet : undefined
  return ctx.objects(view, RS + 'solution').map((r) => {
    // A row's value of a variable is the node <row>-<variable> (view.ttl), read by its IRI.
    const value = (variable: string) => ctx.object(ctx.nn(`${r.value}-${variable}`), RS + 'value')
    const index = ctx.object(r, RS + 'index')
    return {
      pos: index ? Number(index.value) : r.value, fac: fv === undefined ? '' : str(value(fv)) ?? '', cat: str(value(e.category)) ?? '', ser: e.series ? str(value(e.series)) : '',
      measured: value(e.value) !== undefined, flag: e.flag !== undefined && str(value(e.flag)) === 'true',
      y: numberOf(value(e.value)), x: xv === undefined ? undefined : numberOf(value(xv)), z: zv === undefined ? undefined : numberOf(value(zv)),
      // A row the result has n times (iv:multiplicity) counts n times.
      n: Number(str(ctx.object(r, NS.iv + 'multiplicity')) ?? 1),
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
  const series: { key: string; label: string; secondary?: boolean }[] = declared.length
    ? declared.map((s) => ({ key: str(ctx.object(s, C.key)) ?? s.value, label: labelOf(ctx, s), secondary: ctx.object(s, c('axis'))?.value === c('SecondaryAxis') }))
    : e.series
      ? firstSeen(rows, (r) => r.ser).map((k) => ({ key: k, label: k }))
      : [{ key: '', label: labelOf(ctx, focus) }]
  const hidden = new Set(ctx.objects(focus, c('hiddenSeries')).map((t) => t.value))
  series.forEach((s, i) => {
    const n = o.node(`series-${md5Key(s.key)}`)
    o.t(n, RDF_TYPE, ctx.nn(c('ChartSeries'))).t(n, c('inChart'), focus).t(n, C.key, s.key).t(n, C.label, s.label).t(n, c('index'), int(ctx, i)).t(n, SEM.orderKey, tupleKey([i]))
    if (hidden.has(s.key)) o.t(n, c('seriesHidden'), ctx.f.literal('true', ctx.nn(XSD_BOOLEAN)))
    if (s.secondary) o.t(n, c('secondary'), ctx.f.literal('true', ctx.nn(XSD_BOOLEAN)))
    o.t(o.node('legend'), NS.rdfhtml + 'hasChild', n)
  })
  return { series, hidden }
}
const int = (ctx: RuleContext, n: number) => ctx.f.literal(String(n), ctx.nn(NS.xsd + 'integer'))

/** A category's text as xsd:double reads it: a number, or not one. */
const categoryNumber = (cat: string) => (cat.trim() !== '' && cat === cat.trim() && !Number.isNaN(Number(cat)) && !/^0[xob]/i.test(cat) ? Number(cat) : undefined)
/** The class a chart's kind names for its parts (c:pointClass, c:categoryClass): of its direct types only. */
const kindClass = (ctx: RuleContext, chart: NamedNode, p: string) => ctx.objects(chart, RDF_TYPE).flatMap((t) => ctx.objects(t, c(p)))[0]
/** What a chart's kind (or a kind it is a subclass of) says for p, if anything. */
function kindValue(ctx: RuleContext, chart: Term, p: string): string | undefined {
  const seen = new Set<string>()
  const up = (t: Term): string | undefined => {
    if (seen.has(t.value)) return undefined
    seen.add(t.value)
    return ctx.objects(t, p)[0]?.value ?? ctx.objects(t, NS.rdfs + 'subClassOf').map(up).find((v) => v !== undefined)
  }
  return ctx.objects(chart, RDF_TYPE).map(up).find((v) => v !== undefined)
}

/**
 * c:SeriesPlan: the chart's series, facets (a faceted kind's), categories (a facet's own) and points, from its view's
 * rows (a kind with c:ownPlan has a plan of its own). A full-grid kind (a heatmap) has a point for every series and
 * category of a facet, measured or not.
 */
const plan: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const view = ctx.object(focus, C.view)
  if (!view || !ctx.match(view, RDF_TYPE, RS + 'ResultSet').length || kindSays(ctx, focus, c('ownPlan'), 'true')) return o.quads
  const rows = rowsOf(ctx, focus, view)
  const { series, hidden } = mintSeries(ctx, o, focus, rows)
  const faceted = kindSays(ctx, focus, c('faceted'), 'true')
  const pfx = (fac: string) => (faceted ? `${md5Key(fac)}-` : '')
  const facetNode = (fac: string) => o.node(`facet-${md5Key(fac)}`)
  if (faceted) firstSeen(rows, (r) => r.fac).forEach((fac, i) => {
    const n = facetNode(fac)
    o.t(n, RDF_TYPE, ctx.nn(c('ChartFacet'))).t(n, c('inChart'), focus).t(n, c('index'), int(ctx, i)).t(n, C.label, fac)
  })
  // Categories, as first seen in any row (a facet's own, on a faceted kind); a kind with a class for them places them and says their totals.
  const pairKey = (r: Row) => `${r.fac}\u0002${r.cat}`
  const pairs = firstSeen(rows, pairKey).map((k) => {
    const r = rows.find((x) => pairKey(x) === k)!
    return { fac: r.fac, cat: r.cat }
  })
  const categoryClass = kindClass(ctx, focus, 'categoryClass')
  const dbl = (n: number) => ctx.f.literal(String(n), ctx.nn(XSD_DOUBLE))
  const categoryNode = (fac: string, cat: string) => o.node(`category-${pfx(fac)}${md5Key(cat)}`)
  pairs.forEach(({ fac, cat }, i) => {
    const n = categoryNode(fac, cat)
    o.t(n, RDF_TYPE, ctx.nn(c('ChartCategory'))).t(n, c('inChart'), focus).t(n, c('index'), int(ctx, i)).t(n, C.label, cat)
    if (faceted) o.t(n, c('facet'), facetNode(fac))
    if (!categoryClass) return
    const these = rows.filter((r) => r.fac === fac && r.cat === cat)
    o.t(n, RDF_TYPE, categoryClass).t(n, SEM.orderKey, tupleKey([1, i])).t(o.node(`f-${md5Key(fac)}`), NS.rdfhtml + 'hasChild', n)
    o.t(n, c('total'), dbl(these.filter((r) => r.ser === undefined || !hidden.has(r.ser)).reduce((a, r) => a + (r.y ?? 0) * r.n, 0)))
    if (these.some((r) => r.measured)) o.t(n, c('measured'), ctx.f.literal('true', ctx.nn(XSD_BOOLEAN)))
  })
  const pointClass = kindClass(ctx, focus, 'pointClass')
  const point = (fac: string, s: { key: string; secondary?: boolean }, si: number, cat: string, ci: number) => {
    const n = o.node(`point-${pfx(fac)}${md5Key(s.key)}-${md5Key(cat)}`)
    o.t(n, RDF_TYPE, ctx.nn(c('ChartPoint'))).t(n, c('inChart'), focus).t(n, c('series'), o.node(`series-${md5Key(s.key)}`)).t(n, c('category'), cat)
    if (pointClass) o.t(n, RDF_TYPE, pointClass)
    if (faceted) o.t(n, c('facet'), facetNode(fac))
    if (s.secondary) o.t(n, c('secondary'), ctx.f.literal('true', ctx.nn(XSD_BOOLEAN)))
    o.t(n, c('seriesIndex'), int(ctx, si)).t(n, c('categoryIndex'), int(ctx, ci)).t(n, SEM.orderKey, tupleKey([si, ci]))
    return n
  }
  if (kindSays(ctx, focus, c('fullGrid'), 'true')) {
    // A cell per series of a facet (a row its parent) and category of the facet, with the sum of its rows' values when it has any.
    series.forEach((s, si) => {
      if (hidden.has(s.key)) return
      for (const fac of new Set(rows.filter((r) => r.ser === s.key).map((r) => r.fac))) {
        pairs.forEach((p, ci) => {
          if (p.fac !== fac) return
          const n = point(fac, s, si, p.cat, ci)
          const these = rows.filter((r) => r.ser === s.key && r.fac === fac && r.cat === p.cat && r.y !== undefined)
          if (these.length) o.t(n, c('value'), dbl(these.reduce((a, r) => a + r.y! * r.n, 0)))
          if (these.some((r) => r.flag)) o.t(n, c('flagged'), ctx.f.literal('true', ctx.nn(XSD_BOOLEAN)))
          o.t(o.node(`r-${md5Key(fac)}-${md5Key(s.key)}`), NS.rdfhtml + 'hasChild', n)
        })
      }
    })
    return o.quads
  }
  // A point per shown series and category with a value (above zero, on a kind that says so): the sum of its rows' (and of their
  // x and size, when the chart has them; a chart with an x variable has no point without one). A numeric kind's category is its x.
  const hasX = !!ctx.object(focus, c('xVariable')), hasZ = !!ctx.object(focus, c('sizeVariable'))
  const positive = kindSays(ctx, focus, c('positiveValues'), 'true'), numeric = kindSays(ctx, focus, c('numericCategories'), 'true')
  const inCategory = kindValue(ctx, focus, c('pointsIn')) === 'category'
  const sum = (xs: (number | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0)
  series.forEach((s, si) => {
    if (hidden.has(s.key)) return
    pairs.forEach(({ fac, cat }, ci) => {
      if (numeric && categoryNumber(cat) === undefined) return
      const these = rows.filter((r) => r.ser === s.key && r.fac === fac && r.cat === cat && r.y !== undefined && (!positive || r.y > 0))
      const values = these.map((r) => r.y! * r.n)
      if (!values.length || (hasX && !these.some((r) => r.x !== undefined))) return
      const n = point(fac, s, si, cat, ci)
      o.t(n, c('value'), dbl(values.reduce((a, b) => a + b, 0)))
      if (hasX) o.t(n, c('x'), dbl(sum(these.map((r) => (r.x === undefined ? undefined : r.x * r.n)))))
      if (hasZ) o.t(n, c('size'), dbl(sum(these.map((r) => (r.z === undefined ? undefined : r.z * r.n)))))
      if (numeric) o.t(n, c('xAt'), dbl(categoryNumber(cat)!))
      o.t(inCategory ? ctx.nn(`${categoryNode(fac, cat).value}/~track`) : o.node('marks'), NS.rdfhtml + 'hasChild', n)
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
      const counted = rows.filter((r) => r.ser === s.key && r.y !== undefined && binOf(r.y) === k).reduce((a, r) => a + r.n, 0)
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

/** The p-quantile of ascending values, by linear interpolation between the closest ranks (h = (n − 1)p). */
export function quantile(sorted: number[], p: number): number {
  const h = (sorted.length - 1) * p
  const i = Math.floor(h)
  const j = Math.min(i + 1, sorted.length - 1)
  return sorted[i]! + (h - i) * (sorted[j]! - sorted[i]!)
}

/**
 * c:BoxPlan: a box plot's series, categories (first seen) and boxes: a box per shown series and category with
 * values, its median (c:value), quartiles (c:q1, c:q3) and extent (c:low, c:high: the least and greatest value).
 */
const boxPlan: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const view = ctx.object(focus, C.view)
  if (!view || !ctx.match(view, RDF_TYPE, RS + 'ResultSet').length) return o.quads
  const rows = rowsOf(ctx, focus, view)
  const { series, hidden } = mintSeries(ctx, o, focus, rows)
  const categories = firstSeen(rows, (r) => r.cat)
  categories.forEach((cat, i) => {
    const n = o.node(`category-${md5Key(cat)}`)
    o.t(n, RDF_TYPE, ctx.nn(c('ChartCategory'))).t(n, c('inChart'), focus).t(n, c('index'), int(ctx, i)).t(n, C.label, cat)
  })
  const pointClass = ctx.objects(focus, RDF_TYPE).flatMap((t) => ctx.objects(t, c('pointClass')))[0]
  const dbl = (n: number) => ctx.f.literal(String(n), ctx.nn(XSD_DOUBLE))
  series.forEach((s, si) => {
    if (hidden.has(s.key)) return
    categories.forEach((cat, ci) => {
      const values = rows.filter((r) => r.ser === s.key && r.cat === cat && r.y !== undefined).flatMap((r) => Array.from({ length: r.n }, () => r.y!)).sort((a, b) => a - b)
      if (!values.length) return
      const n = o.node(`point-${md5Key(s.key)}-${md5Key(cat)}`)
      o.t(n, RDF_TYPE, ctx.nn(c('ChartPoint'))).t(n, c('inChart'), focus).t(n, c('series'), o.node(`series-${md5Key(s.key)}`)).t(n, c('category'), cat)
      if (pointClass) o.t(n, RDF_TYPE, pointClass)
      o.t(n, c('value'), dbl(quantile(values, 0.5))).t(n, c('q1'), dbl(quantile(values, 0.25))).t(n, c('q3'), dbl(quantile(values, 0.75)))
      o.t(n, c('low'), dbl(values[0]!)).t(n, c('high'), dbl(values[values.length - 1]!))
      o.t(n, c('seriesIndex'), int(ctx, si)).t(n, c('categoryIndex'), int(ctx, ci)).t(n, SEM.orderKey, tupleKey([si, ci]))
      o.t(o.node('marks'), NS.rdfhtml + 'hasChild', n)
    })
  })
  return o.quads
}

type Point = { node: NamedNode; si: number; ci: number; v: number; base: number; x?: number; xAt?: number; z?: number; low?: number; high?: number; secondary: boolean }

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
    .filter((p) => ctx.match(p, RDF_TYPE, c('ChartPoint')).length && ctx.object(p, c('value')))
    .map((node) => ({
      node, si: Number(str(ctx.object(node, c('seriesIndex')))), ci: Number(str(ctx.object(node, c('categoryIndex')))), v: Number(str(ctx.object(node, c('value')))), base: 0,
      x: numberOf(ctx.object(node, c('x'))), xAt: numberOf(ctx.object(node, c('xAt'))), z: numberOf(ctx.object(node, c('size'))), low: numberOf(ctx.object(node, c('low'))), high: numberOf(ctx.object(node, c('high'))), secondary: !!ctx.object(node, c('secondary')),
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

/** A log scale over [lo, hi] (both above zero): in decades from the one at or below lo to the one at or above hi, a decade a step (more past twelve). */
export function logScale(lo: number, hi: number) {
  const loD = Math.floor(Math.log10(lo)), hiD0 = Math.ceil(Math.log10(hi))
  const hiD = hiD0 > loD ? hiD0 : loD + 1
  const step = hiD - loD > 12 ? Math.ceil((hiD - loD) / 12) : 1
  const max0 = loD + Math.ceil((hiD - loD) / step) * step
  const max = max0 >= loD + step ? max0 : loD + step
  const count = Math.round((max - loD) / step)
  return { min: loD, max, step, ticks: Array.from({ length: Math.min(count, 12) + 1 }, (_, k) => loD + k * step) }
}

/** c:SeriesLayout: each point's stack base and next point, the first tab stop, the value scale and its ticks. */
const layout: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const points = pointsOf(ctx, focus)
  const dbl = (n: number) => ctx.f.literal(String(n), ctx.nn(XSD_DOUBLE))
  // The longest bar of each facet: its categories' greatest total.
  const totals = new Map<string, { facet: Term; max: number }>()
  for (const q of ctx.match(null, c('inChart'), focus)) {
    const facet = ctx.object(q.subject, c('facet')), total = numberOf(ctx.object(q.subject, c('total')))
    if (!facet || total === undefined || !ctx.match(q.subject, RDF_TYPE, c('ChartCategory')).length) continue
    const m = totals.get(facet.value)
    if (!m || total > m.max) totals.set(facet.value, { facet, max: total })
  }
  for (const { facet, max } of totals.values()) o.t(facet as NamedNode, c('max'), dbl(max))
  if (!points.length) return o.quads
  let first = points[0]!
  // A point's rank: how many shown series with points come before its series (a group's place).
  const shown = [...new Set(points.map((p) => p.si))]
  const numeric = kindSays(ctx, focus, c('numericCategories'), 'true')
  for (const p of points) {
    o.t(p.node, c('base'), dbl(p.base)).t(p.node, c('rank'), ctx.f.literal(String(shown.filter((si) => si < p.si).length), ctx.nn(NS.xsd + 'integer')))
    // A numeric kind's next point is the next greater x of its series (over a category it has no value for).
    const next = numeric
      ? points.filter((q) => q.si === p.si && q.xAt !== undefined && p.xAt !== undefined && q.xAt > p.xAt).sort((a, b) => a.xAt! - b.xAt!)[0]
      : points.find((q) => q.si === p.si && q.ci === p.ci + 1)
    if (next) o.t(p.node, c('nextValue'), dbl(next.v)).t(p.node, c('nextBase'), dbl(numeric ? 0 : next.base))
    if (next && numeric) o.t(p.node, c('nextX'), dbl(next.xAt!))
    if (p.si < first.si || (p.si === first.si && p.ci < first.ci)) first = p
  }
  o.t(first.node, c('first'), ctx.f.literal('true', ctx.nn(XSD_BOOLEAN)))
  // The value scale spans every point's ends, and zero unless the kind says otherwise (c:fromZero false).
  const zero = kindSays(ctx, focus, c('fromZero'), 'false') ? [] : [0]
  // On a log axis (c:logValues; the x scale when c:logScale says so), the scale runs in decades, its ticks say their powers of ten.
  const logValues = kindSays(ctx, focus, c('logValues'), 'true')
  const writeScale = (local: string, link: string, lo: number, hi: number, log = logValues) => {
    const s = log ? logScale(lo, hi) : niceScale(lo, hi)
    const scale = o.node(local)
    o.t(focus, c(link), scale).t(scale, RDF_TYPE, ctx.nn(c('ValueScale'))).t(scale, c('min'), dbl(s.min)).t(scale, c('max'), dbl(s.max))
    s.ticks.forEach((at, k) => {
      const tick = o.node(`${local}-tick-${k}`)
      o.t(scale, c('tick'), tick).t(tick, c('at'), dbl(at)).t(tick, c('index'), ctx.f.literal(String(k), ctx.nn(NS.xsd + 'integer')))
      if (log) o.t(tick, c('value'), dbl(Math.pow(10, at)))
    })
  }
  // A point's ends: its value, and its base when it is stacked on others.
  const stacked = ctx.object(focus, c('stacked'))?.value === 'true'
  const endsOf = (ps: Point[]) => ps.flatMap((p) => (stacked ? [p.base, p.base + p.v] : [p.v, ...(p.low === undefined ? [] : [p.low]), ...(p.high === undefined ? [] : [p.high])]))
  // The primary scale also spans the annotations' values, so a threshold or a marked range is in view.
  const marked = ctx.objects(focus, c('annotation')).flatMap((a) => [c('at'), c('fromValue'), c('toValue')].map((p) => numberOf(ctx.object(a, p)))).filter((v): v is number => v !== undefined)
  const ends = [...endsOf(points.filter((p) => !p.secondary)), ...marked]
  if (ends.length) writeScale('scale', 'valueScale', Math.min(...zero, ...ends), Math.max(...zero, ...ends))
  // Points of a series on the secondary axis (c:axis c:SecondaryAxis) have a scale of their own.
  const ends2 = endsOf(points.filter((p) => p.secondary))
  if (ends2.length) writeScale('scale2', 'secondaryScale', Math.min(...zero, ...ends2), Math.max(...zero, ...ends2))
  // An x scale over the points' x, and the greatest size, when the chart has them.
  const xs = points.flatMap((p) => (p.x !== undefined ? [p.x] : p.xAt !== undefined ? [p.xAt] : []))
  if (xs.length) writeScale('xscale', 'xScale', Math.min(...zero, ...xs), Math.max(...zero, ...xs), logValues && ctx.object(focus, C.logScale)?.value === 'true')
  // c:referenceLine "linear" (a line chart's proportional growth): from the slowest series' first point, scaled by x, capped at the top decade.
  const placed = points.filter((p) => p.xAt !== undefined)
  if (ctx.object(focus, C.referenceLine)?.value === 'linear' && placed.length) {
    const rx1 = Math.min(...placed.map((p) => p.xAt!)), rx2 = Math.max(...placed.map((p) => p.xAt!))
    const ry1 = Math.max(...placed.filter((p) => p.xAt === rx1).map((p) => p.v))
    const cap = Math.pow(10, Math.ceil(Math.log10(Math.max(...placed.map((p) => p.v)))))
    const ry20 = (ry1 * rx2) / rx1
    o.t(focus, c('refX1'), dbl(rx1)).t(focus, c('refY1'), dbl(ry1)).t(focus, c('refX2'), dbl(rx2)).t(focus, c('refY2'), dbl(ry20 < cap ? ry20 : cap))
  }
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
export function valueText(ctx: RuleContext, chart: Term, v: number, secondary = false): string {
  ctx.readsLanguage()
  const unit = secondary ? text(ctx, chart, c('secondaryUnit')) ?? '' : unitOf(ctx, chart)
  return `${formatNumber(v, formatLocale(ctx.languages), 'maximumFractionDigits=2')}${unit ? ' ' + unit : ''}`
}

/** A chart's annotations (c:annotation), in order of their values: what each says, e.g. "Budget: 100 €" or "Peak: 20 – 40 €". */
function annotationsOf(ctx: RuleContext, chart: NamedNode) {
  ctx.readsLanguage()
  const locale = formatLocale(ctx.languages)
  const unit = unitOf(ctx, chart)
  return ctx
    .objects(chart, c('annotation'))
    .filter((a): a is NamedNode => a.termType === 'NamedNode')
    .map((a) => {
      const at = numberOf(ctx.object(a, c('at'))), from = numberOf(ctx.object(a, c('fromValue'))), to = numberOf(ctx.object(a, c('toValue')))
      const f = (v: number) => formatNumber(v, locale, 'maximumFractionDigits=2')
      const value = at !== undefined ? f(at) : from !== undefined && to !== undefined ? `${f(from)} – ${f(to)}` : undefined
      return { a, at, from, to, words: value === undefined ? undefined : `${labelOf(ctx, a)}: ${value}${unit ? ' ' + unit : ''}`, key: tupleKey([at ?? from ?? 0, a.value]) }
    })
    .filter((x) => x.words !== undefined)
    .sort((x, y) => compareKeys(x.key, y.key))
}

/** The annotations drawn on the plot: a threshold line at its value, a marked range as a band, each with its words. */
function annotations(ctx: RuleContext, o: Out, chart: NamedNode): NamedNode[] {
  const list = annotationsOf(ctx, chart)
  if (!list.length) return []
  return [o.el('annotations', 'Div', { class: 'sem-chart-annotations' }, list.map(({ a, at, from, to, words }) => {
    const id = `annotation-${md5Key(a.value)}`
    const style = at !== undefined ? `--at: ${cssNumber(at)}` : `--from: ${cssNumber(from!)}; --to: ${cssNumber(to!)}`
    return o.el(id, 'Span', { class: at !== undefined ? 'sem-threshold' : 'sem-marked-range', style }, [o.text(`${id}-text`, words!)])
  }))]
}

/** The reference line of proportional growth (c:referenceLine "linear"), its ends in the axes' own units, and its word. */
function reference(ctx: RuleContext, o: Out, chart: NamedNode): NamedNode[] {
  const [x1, y1, x2, y2] = ['refX1', 'refY1', 'refX2', 'refY2'].map((p) => numberOf(ctx.object(chart, c(p))))
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return []
  const logX = ctx.object(chart, C.logScale)?.value === 'true'
  const x = (v: number) => (logX ? Math.log10(v) : v)
  const style = `--x1: ${cssNumber(x(x1))}; --y1: ${cssNumber(Math.log10(y1))}; --x2: ${cssNumber(x(x2))}; --y2: ${cssNumber(Math.log10(y2))}`
  const line = o.el('reference', 'Span', { class: 'sem-reference', style })
  o.tip(line, phrase(ctx, 'ChartProportionalPhrase'))
  return [line, o.el('reference-label', 'Span', { class: 'sem-reference-label', style }, [o.text('reference-text', phrase(ctx, 'ChartLinearPhrase'))])]
}

/** A phrase in the viewer's language (its l10n:Terms twin), else its label. */
export const phrase = (ctx: RuleContext, local: string) => text(ctx, ctx.nn(c(local)), RDFS_LABEL) ?? local

/** What a kind that needs several numeric categories (c:minCategories: a line chart's two sizes) shows with fewer: its empty text, else the phrase. */
function shortOf(ctx: RuleContext, chart: NamedNode): string | undefined {
  const min = kindValue(ctx, chart, c('minCategories'))
  if (min === undefined) return undefined
  const xs = new Set(ctx.match(null, c('inChart'), chart).map((q) => ctx.object(q.subject, c('xAt'))?.value).filter((x) => x !== undefined))
  if (xs.size >= Number(min)) return undefined
  return text(ctx, chart, C.emptyText) ?? phrase(ctx, 'ChartNeedsTwoPhrase')
}

/** The frame of a chart with axes (its scale and number of categories as custom properties): the plot with its ticks and marks, the categories, the legend. */
const frame: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const msg = seriesMessage(ctx, focus) ?? shortOf(ctx, focus)
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
    .map((t) => ({ k: Number(str(ctx.object(t, c('index')))), at: Number(str(ctx.object(t, c('at')))), shows: numberOf(ctx.object(t, c('value'))) }))
    .sort((a, b) => a.k - b.k)
    .map(({ k, at, shows }) => o.el(`${local}-${k}`, 'Span', { class: cls, style: `--at: ${cssNumber(at)}` }, [o.text(`${local}-${k}-text`, formatNumber((shows ?? at) + 0, locale, 'maximumFractionDigits=4'))]))
  const ticks = tickEls(scale, 'tick', 'sem-chart-tick')
  const xScale = ctx.objects(focus, c('xScale')).find((s) => ctx.match(s, RDF_TYPE, c('ValueScale')).length)
  const sizeMax = ctx.object(focus, c('sizeMax'))
  const k = new Set(ctx.match(null, c('inChart'), focus).map((q) => q.subject).filter((p) => ctx.match(p, RDF_TYPE, c('ChartPoint')).length).map((p) => str(ctx.object(p, c('seriesIndex'))))).size
  const range = (s: Term | undefined, lo: string, hi: string) => (s ? [`${lo}: ${cssNumber(Number(str(ctx.object(s, c('min')))))}`, `${hi}: ${cssNumber(Number(str(ctx.object(s, c('max')))))}`] : [])
  const scale2 = ctx.objects(focus, c('secondaryScale')).find((s) => ctx.match(s, RDF_TYPE, c('ValueScale')).length)
  const style = [...range(scale, '--lo', '--hi'), ...range(scale2, '--lo2', '--hi2'), ...range(xScale, '--xlo', '--xhi'), ...(sizeMax ? [`--zmax: ${cssNumber(Number(sizeMax.value))}`] : []), `--n: ${categories.length}`, `--k: ${k}`].join('; ')
  const plot = o.el('plot', 'Div', { class: 'sem-chart-plot' }, [
    o.el('ticks', 'Div', { class: 'sem-chart-ticks', 'aria-hidden': 'true' }, ticks),
    ...(scale2 ? [o.el('ticks2', 'Div', { class: 'sem-chart-ticks sem-secondary', 'aria-hidden': 'true' }, tickEls(scale2, 'tick2', 'sem-chart-tick'))] : []),
    ...annotations(ctx, o, focus),
    ...reference(ctx, o, focus),
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

/** A legend item: a toggle button with the series' swatch and name, pressed while the series is shown (c:SeriesToggle hides it). */
const seriesItem: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  if (!ctx.object(focus, c('inChart'))) return o.quads
  const i = Number(str(ctx.object(focus, c('index'))))
  const toggle = o.el('toggle', 'Button', { type: 'button', 'aria-pressed': ctx.object(focus, c('seriesHidden')) ? 'false' : 'true' }, [
    o.el('swatch', 'I', { style: `background: ${seriesColor(i)}`, 'aria-hidden': 'true' }),
    o.text('label', str(ctx.object(focus, C.label)) ?? ''),
  ])
  o.renders(o.el('root', 'Li', { class: ctx.object(focus, c('secondary')) ? 'sem-secondary' : undefined }, [toggle]))
  return o.quads
}

/** c:SeriesToggle: a click on a legend item hides its series in its chart (c:hiddenSeries, by key), or shows it again. */
const toggleSeries: ReactionFn = (ctx) => {
  const chart = ctx.object(ctx.target, c('inChart')), key = ctx.object(ctx.target, C.key)
  if (!chart || !key) return { add: [], remove: [] }
  const hidden = ctx.match(chart, c('hiddenSeries'), null).filter((q) => q.object.value === key.value)
  const f = ctx.runtime.store.factory
  return hidden.length ? { remove: hidden, add: [] } : { remove: [], add: [f.quad(chart as NamedNode, f.namedNode(c('hiddenSeries')), f.literal(key.value))] }
}
export const seriesReactions: Record<string, ReactionFn> = { 'series:toggle': toggleSeries }

/** A point's x and size in words, around its value: "xLabel x, value unit, sizeLabel size" (the labels default to the variables' names). */
export function measures(ctx: RuleContext, chart: Term, y: number, x: number | undefined, z: number | undefined, secondary = false): string {
  ctx.readsLanguage()
  const locale = formatLocale(ctx.languages)
  const label = (p: string, v: string) => text(ctx, chart, c(p)) ?? str(ctx.object(chart, c(v))) ?? ''
  const xPart = x === undefined ? '' : `${label('xLabel', 'xVariable')} ${formatNumber(x, locale, 'maximumFractionDigits=2')}, `
  const zPart = z === undefined ? '' : `, ${label('sizeLabel', 'sizeVariable')} ${formatNumber(z, locale, 'maximumFractionDigits=2')}`
  return `${xPart}${valueText(ctx, chart, y, secondary)}${zPart}`
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
  // A box: its median, quartiles and range.
  const q1 = numberOf(ctx.object(point, c('q1')))
  if (q1 !== undefined) {
    ctx.readsLanguage()
    const locale = formatLocale(ctx.languages)
    const f = (p: string) => formatNumber(Number(str(ctx.object(point, c(p)))), locale, 'maximumFractionDigits=2')
    // The phrases in the viewer's language, as their l10n:Terms twins pick them.
    const words = (local: string) => text(ctx, ctx.nn(c(local)), RDFS_LABEL) ?? local
    return `${head}: ${words('BoxMedianPhrase')} ${valueText(ctx, chart, Number(str(ctx.object(point, c('value')))))}; ${words('BoxQuartilesPhrase')} ${f('q1')} – ${f('q3')}; ${words('BoxRangePhrase')} ${f('low')} – ${f('high')}`
  }
  const share = numberOf(ctx.object(point, c('share')))
  const percent = share === undefined ? '' : ` (${formatNumber(share, formatLocale(ctx.languages), 'style=percent;maximumFractionDigits=1')})`
  return `${head}: ${measures(ctx, chart, Number(str(ctx.object(point, c('value')))), numberOf(ctx.object(point, c('x'))), numberOf(ctx.object(point, c('size'))), !!ctx.object(point, c('secondary')))}${percent}`
}

/** The custom properties every point writes: its category, value, base, next point, x, size, share, and color (by its series, or its category in a pie). */
export function pointStyle(ctx: RuleContext, point: NamedNode, colorBy: 'seriesIndex' | 'categoryIndex' = 'seriesIndex'): string {
  const n = (p: string) => str(ctx.object(point, c(p)))
  const parts = [`--i: ${n('categoryIndex')}`, `--s: ${n('seriesIndex')}`, `--r: ${n('rank') ?? 0}`, `--v: ${cssNumber(Number(n('value')))}`, `--b: ${cssNumber(Number(n('base') ?? 0))}`]
  if (n('nextValue') !== undefined) parts.push(`--nv: ${cssNumber(Number(n('nextValue')))}`, `--nb: ${cssNumber(Number(n('nextBase') ?? 0))}`)
  if (n('x') !== undefined) parts.push(`--x: ${cssNumber(Number(n('x')))}`)
  if (n('size') !== undefined) parts.push(`--z: ${cssNumber(Number(n('size')))}`)
  if (n('q1') !== undefined) parts.push(`--q1: ${cssNumber(Number(n('q1')))}`, `--q3: ${cssNumber(Number(n('q3')))}`, `--low: ${cssNumber(Number(n('low')))}`, `--high: ${cssNumber(Number(n('high')))}`)
  if (n('share') !== undefined) parts.push(`--from: ${cssNumber(Number(n('from')))}`, `--share: ${cssNumber(Number(n('share')))}`)
  parts.push(`--color: ${seriesColor(Number(n(colorBy)))}`)
  return parts.join('; ')
}

/** A point: a list item (a tab stop when it is the first) holding its marks, its words hidden on screen, and its tooltip. */
export function pointItem(ctx: RuleContext, o: Out, point: NamedNode, chart: Term, cls: string, marks: NamedNode[], colorBy: 'seriesIndex' | 'categoryIndex' = 'seriesIndex', style = pointStyle(ctx, point, colorBy)) {
  const words = pointWords(ctx, point, chart)
  const li = o.el('root', 'Li', { class: `sem-point ${cls}${ctx.object(point, c('secondary')) ? ' sem-secondary' : ''}`, style, tabindex: ctx.object(point, c('first')) ? '0' : '-1' }, [
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
  // A kind that says its rows has the row lines (c:RowChartText) instead.
  if (kindSays(ctx, focus, c('saysRows'), 'true')) return o.quads
  const msg = seriesMessage(ctx, focus)
  if (msg !== undefined) return message(ctx, focus, msg)
  const notes = annotationsOf(ctx, focus).map(({ a, words }) => o.el(`annotation-${md5Key(a.value)}`, 'P', {}, [o.text(`annotation-${md5Key(a.value)}-text`, words!)]))
  o.renders(o.el('root', 'Div', {}, [o.el('title', 'P', {}, [o.text('title-text', labelOf(ctx, focus))]), o.el('marks', 'Div'), ...notes]))
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

/** A sparkline's frame: a small plot of its points (its scale as custom properties), no axes, no legend. */
const sparklineFrame: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const msg = seriesMessage(ctx, focus)
  if (msg !== undefined) return message(ctx, focus, msg)
  const scale = ctx.objects(focus, c('valueScale')).find((s) => ctx.match(s, RDF_TYPE, c('ValueScale')).length)
  const n = ctx.match(null, c('inChart'), focus).filter((q) => ctx.match(q.subject, RDF_TYPE, c('ChartCategory')).length).length
  const style = [...(scale ? [`--lo: ${cssNumber(Number(str(ctx.object(scale, c('min')))))}`, `--hi: ${cssNumber(Number(str(ctx.object(scale, c('max')))))}`] : []), `--n: ${n}`, '--k: 1'].join('; ')
  o.renders(o.el('root', 'Span', { style }, [o.el('marks', 'Ol', { class: 'sem-chart-marks', 'aria-label': labelOf(ctx, focus) })]))
  return o.quads
}

/** A box plot's point: a whisker over its range, a box over its quartiles, a line at its median. */
const boxPoint: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const chart = ctx.object(focus, c('inChart'))
  if (!chart) return o.quads
  const mark = (local: string) => o.el(local, 'Span', { class: `sem-${local}`, 'aria-hidden': 'true' })
  pointItem(ctx, o, focus, chart, 'sem-box-point', [mark('whisker'), mark('box'), mark('median')])
  return o.quads
}

/** The value a point's style writes: its logarithm on a log kind. */
const plotted = (ctx: RuleContext, chart: Term, v: number) => (kindSays(ctx, chart, c('logValues'), 'true') ? Math.log10(v) : v)

/** A line chart's point: a dot at its x and value (log values; log x with c:logScale), and the line to the next point of its series. */
const linePoint: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const chart = ctx.object(focus, c('inChart'))
  const xAt = numberOf(ctx.object(focus, c('xAt')))
  if (!chart || xAt === undefined || !ctx.object(focus, c('value'))) return o.quads
  const n = (p: string) => numberOf(ctx.object(focus, c(p)))
  const logX = ctx.object(chart, C.logScale)?.value === 'true'
  const x = (v: number) => (logX ? Math.log10(v) : v)
  const nv = n('nextValue'), nx = n('nextX')
  const style = [`--i: ${str(ctx.object(focus, c('categoryIndex')))}`, `--s: ${str(ctx.object(focus, c('seriesIndex')))}`, `--r: ${str(ctx.object(focus, c('rank'))) ?? 0}`,
    `--v: ${cssNumber(plotted(ctx, chart, n('value')!))}`, '--b: 0', ...(nv === undefined ? [] : [`--nv: ${cssNumber(plotted(ctx, chart, nv))}`, '--nb: 0']),
    `--x: ${cssNumber(x(xAt))}`, ...(nx === undefined ? [] : [`--nx: ${cssNumber(x(nx))}`]), `--color: ${seriesColor(Number(str(ctx.object(focus, c('seriesIndex')))))}`].join('; ')
  const words = pointWords(ctx, focus, chart)
  const li = o.el('root', 'Li', { class: `sem-point sem-line-point${ctx.object(focus, c('secondary')) ? ' sem-secondary' : ''}`, style, tabindex: ctx.object(focus, c('first')) ? '0' : '-1' }, [
    ...(nv === undefined ? [] : [o.el('line', 'Span', { class: 'sem-segment', 'aria-hidden': 'true' })]),
    o.el('dot', 'Span', { class: 'sem-dot', 'aria-hidden': 'true' }),
    o.el('words', 'Span', { class: 'sem-visually-hidden' }, [o.text('words-text', words)]),
  ])
  o.tip(li, words)
  o.renders(li)
  return o.quads
}

/** A bar chart's segment: a list item as wide as its value is of its facet's longest bar (the theme reads --v of --max). */
const barPoint: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const chart = ctx.object(focus, c('inChart'))
  if (!chart || !ctx.object(focus, c('value'))) return o.quads
  // Its own place and value only: a neighbour's change does not re-render it.
  const n = (p: string) => str(ctx.object(focus, c(p)))
  const style = `--i: ${n('categoryIndex')}; --s: ${n('seriesIndex')}; --r: ${n('rank') ?? 0}; --v: ${cssNumber(Number(n('value')))}; --b: ${cssNumber(Number(n('base') ?? 0))}; --color: ${seriesColor(Number(n('seriesIndex')))}`
  pointItem(ctx, o, focus, chart, 'sem-bar-point', [o.el('seg', 'Span', { class: 'sem-seg', 'aria-hidden': 'true' })], 'seriesIndex', style)
  return o.quads
}

/** A bar: its category's label, a track for its segments, its total (in the viewer's locale) or the running phrase while nothing is measured. */
const barCategory: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const chart = ctx.object(focus, c('inChart'))
  if (!chart) return o.quads
  const cat = str(ctx.object(focus, C.label)) ?? ''
  const measured = !!ctx.object(focus, c('measured'))
  ctx.readsLanguage()
  const total = measured ? valueText(ctx, chart, numberOf(ctx.object(focus, c('total'))) ?? 0) : phrase(ctx, 'ChartRunningPhrase')
  o.renders(o.el('root', 'Div', { class: 'sem-bar' }, [
    o.el('label', 'Span', { class: 'sem-category' }, [o.text('label-text', cat)]),
    o.el('track', 'Ol', { class: 'sem-track', 'aria-label': cat }),
    o.el('total', 'Span', { class: measured ? 'sem-total' : 'sem-total sem-pending' }, [o.text('total-text', total)]),
  ]))
  return o.quads
}

/** A value's digits by its size, as a heatmap's ramp reads it: whole from 100, 1 decimal from 10, 2 from 1, 3 from 0.01, below it "<0.01". */
export function rampText(v: number, locale: string) {
  const k = v >= 100 ? 0 : v >= 10 ? 1 : v >= 1 ? 2 : 3
  return v >= 0.01 ? formatNumber(v + 0, locale, `minimumFractionDigits=${k};maximumFractionDigits=${k}`) : `<${formatNumber(0.01, locale, 'maximumFractionDigits=2')}`
}

/** A heatmap's cell: its value on the ramp (thirteen steps on a log scale from 0.01 to 100), outlined when flagged; else a pending mark. */
const heatCell: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const chart = ctx.object(focus, c('inChart'))
  const series = ctx.object(focus, c('series'))
  if (!chart || !series) return o.quads
  const v = numberOf(ctx.object(focus, c('value')))
  const tabindex = ctx.object(focus, c('first')) ? '0' : '-1'
  if (v === undefined) {
    o.renders(o.el('root', 'Td', { class: 'sem-point sem-pending', tabindex }, [o.text('text', '…')]))
    return o.quads
  }
  ctx.readsLanguage()
  const shown = rampText(v, formatLocale(ctx.languages))
  const flagged = !!ctx.object(focus, c('flagged'))
  const step = Math.min(12, Math.round(((Math.log10(v > 0.01 ? v : 0.01) + 2) / 4) * 12))
  const unit = text(ctx, chart, C.unit) ?? ''
  const flagLabel = str(ctx.object(chart, C.flagLabel))
  const td = o.el('root', 'Td', { class: `sem-point sem-h${step}${flagged ? ' sem-flagged' : ''}`, tabindex }, [o.text('text', `${flagged ? '⚠ ' : ''}${shown}`)])
  o.tip(td, `${str(ctx.object(focus, c('category'))) ?? ''} · ${str(ctx.object(series, C.label)) ?? ''}: ${shown}${unit ? ' ' + unit : ''}${flagged && flagLabel !== undefined ? ` — ${flagLabel}` : ''}`)
  o.renders(td)
  return o.quads
}

export const seriesFunctions: Record<string, FnRule> = {
  'series:bar-point': barPoint,
  'series:bar-category': barCategory,
  'series:heat-cell': heatCell,
  'series:line-point': linePoint,
  'series:plan': plan,
  'series:histogram-plan': histogramPlan,
  'series:box-plan': boxPlan,
  'series:box-point': boxPoint,
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
  'series:sparkline-frame': sparklineFrame,
}
