// Function rules for charts over sem:View SELECTs, and the finding list.
import type { NamedNode, Term } from '@rdfjs/types'
import type { FnRule, RuleContext } from '../engine/context.ts'
import { C, NS, RDF_TYPE, SEM } from '../ns.ts'
import { labelOf, rdfList, str, text } from './util.ts'
import { md5Key } from './data.ts'
import { compareKeys, tupleKey } from '../render/order-key.ts'
import { cssNumber, isKind, kindSays, measures, seriesMessage } from './series.ts'
import { formatLocale } from '../engine/context.ts'
import { formatNumber } from '../../rdf-engine/host/intl.ts'

const NUMERIC = new Set(['integer', 'decimal', 'double', 'float', 'int', 'long', 'short', 'byte', 'nonNegativeInteger', 'positiveInteger', 'negativeInteger', 'nonPositiveInteger', 'unsignedInt', 'unsignedLong', 'unsignedShort', 'unsignedByte'].map((t) => NS.xsd + t))

type Row = Map<string, Term>

/** The chart's encoding: which SELECT variables play which role. */
export function encoding(ctx: RuleContext, focus: NamedNode) {
  const v = (p: string) => str(ctx.object(focus, p))
  return {
    facet: v(C.facetVariable),
    facetLabel: v(C.facetLabel) ?? '{value}',
    category: v(C.categoryVariable) ?? 'category',
    series: v(C.seriesVariable),
    value: v(C.valueVariable) ?? 'value',
    flag: v(C.flagVariable),
    flagLabel: v(C.flagLabel),
    unit: text(ctx, focus, C.unit) ?? '',
    log: v(C.logScale) === 'true',
    reference: v(C.referenceLine),
  }
}

export function message(ctx: RuleContext, focus: NamedNode, text: string) {
  const o = ctx.out(focus)
  o.renders(o.el('root', 'P', { class: 'sem-empty' }, [o.text('empty', text)]))
  return o.quads
}

// --- bar chart and heatmap: faceted series charts ----------------------------------------------

/** A faceted chart's facets (c:SeriesPlan mints them), in the order first seen. */
function facetsOf(ctx: RuleContext, chart: NamedNode) {
  return ctx
    .match(null, NS.c + 'inChart', chart)
    .map((q) => q.subject as NamedNode)
    .filter((n) => ctx.match(n, RDF_TYPE, NS.c + 'ChartFacet').length)
    .map((n) => ({ n, i: Number(str(ctx.object(n, NS.c + 'index'))), fac: str(ctx.object(n, C.label)) ?? '', max: ctx.object(n, NS.c + 'max') }))
    .sort((a, b) => a.i - b.i)
}

/** A facet's caption: c:facetLabel with {value} its value, a number in the viewer's locale. */
function caption(ctx: RuleContext, chart: NamedNode, fac: string) {
  ctx.readsLanguage()
  const shown = /^-?(0|[1-9][0-9]*)([.][0-9]+)?([eE][+-]?[0-9]+)?$/.test(fac) ? formatNumber(Number(fac), formatLocale(ctx.languages), 'maximumFractionDigits=4') : fac
  return encoding(ctx, chart).facetLabel.replace('{value}', shown)
}

// A bar chart: a figure per facet (its bars are the plan's categories, their segments its points), then the legend.
const barchart: FnRule = (ctx, focus) => {
  const msg = seriesMessage(ctx, focus)
  if (msg !== undefined) return message(ctx, focus, msg)
  const o = ctx.out(focus)
  const faceted = !!ctx.object(focus, C.facetVariable)
  const figures = facetsOf(ctx, focus).map(({ fac, max }) => {
    const fid = `f-${md5Key(fac)}`
    const m = max === undefined ? undefined : Number(max.value)
    const cap = faceted ? [o.el(`${fid}-caption`, 'Figcaption', {}, [o.text(`${fid}-caption-text`, caption(ctx, focus, fac))])] : []
    // Its bars (the plan's categories) come after the caption.
    for (const n of cap) o.t(n, SEM.orderKey, tupleKey([0]))
    return o.el(fid, 'Figure', { style: m === undefined ? undefined : `--max: ${cssNumber(m > 0 ? m : 1)}` }, cap)
  })
  o.renders(o.el('root', 'Div', {}, [o.el('panels', 'Div', { class: 'sem-panels' }, figures), o.el('legend', 'Ul', { class: 'sem-legend' })]))
  return o.quads
}

// A heatmap: a table per facet (its column headings the plan's categories, a row per series of the facet that holds
// its cells), then the ramp's key.
const heatmap: FnRule = (ctx, focus) => {
  const msg = seriesMessage(ctx, focus)
  if (msg !== undefined) return message(ctx, focus, msg)
  const o = ctx.out(focus)
  const e = encoding(ctx, focus)
  const faceted = !!ctx.object(focus, C.facetVariable)
  const minted = ctx.match(null, NS.c + 'inChart', focus).map((q) => q.subject as NamedNode)
  const tables = facetsOf(ctx, focus).map(({ n: facet, fac }) => {
    const f = `f-${md5Key(fac)}`
    const columns = minted
      .filter((n) => ctx.match(n, RDF_TYPE, NS.c + 'ChartCategory').length && ctx.object(n, NS.c + 'facet')?.value === facet.value)
      .map((n) => ({ i: Number(str(ctx.object(n, NS.c + 'index'))), cat: str(ctx.object(n, C.label)) ?? '' }))
      .sort((a, b) => a.i - b.i)
    const seriesOf = new Map<string, Term>()
    for (const p of minted) {
      if (!ctx.match(p, RDF_TYPE, NS.c + 'ChartPoint').length || ctx.object(p, NS.c + 'facet')?.value !== facet.value) continue
      const s = ctx.object(p, NS.c + 'series')
      if (s) seriesOf.set(s.value, s)
    }
    const rowsOf = [...seriesOf.values()]
      .map((s) => ({ i: Number(str(ctx.object(s, NS.c + 'index'))), key: str(ctx.object(s, C.key)) ?? '', label: str(ctx.object(s, C.label)) ?? '' }))
      .sort((a, b) => a.i - b.i)
    const head = o.el(`${f}-head`, 'Thead', {}, [
      o.el(`${f}-head-row`, 'Tr', {}, [o.el(`${f}-corner`, 'Th'), ...columns.map(({ cat }) => o.el(`${f}-col-${md5Key(cat)}`, 'Th', { scope: 'col' }, [o.text(`${f}-col-${md5Key(cat)}-text`, cat)]))]),
    ])
    const body = o.el(`${f}-body`, 'Tbody', {}, rowsOf.map(({ key, label }) => {
      const rid = `r-${md5Key(fac)}-${md5Key(key)}`
      // Its name before its cells (the plan's points).
      const th = o.el(`${rid}-h`, 'Th', { scope: 'row' }, [o.text(`${rid}-h-text`, label)])
      o.t(th, SEM.orderKey, tupleKey([-1]))
      return o.el(rid, 'Tr', {}, [th])
    }))
    const cap = faceted ? [o.el(`${f}-caption`, 'Figcaption', {}, [o.text(`${f}-caption-text`, caption(ctx, focus, fac))])] : []
    return o.el(f, 'Figure', {}, [...cap, o.el(`${f}-scroll`, 'Div', { class: 'sem-scroll' }, [o.el(`${f}-table`, 'Table', {}, [head, body])])])
  })
  ctx.readsLanguage()
  const locale = formatLocale(ctx.languages)
  const withUnit = (v: string) => (e.unit ? `${v} ${e.unit}` : v)
  const ramp = o.el('ramp', 'Span', { class: 'sem-ramp' }, Array.from({ length: 13 }, (_, i) => o.el(`ramp-${i}`, 'I', { class: `sem-h${i}` })))
  const scale = o.el('scale', 'Div', { class: 'sem-scale' }, [
    o.el('scale-lo', 'Span', {}, [o.text('scale-lo-text', withUnit(formatNumber(0.01, locale, 'maximumFractionDigits=2')))]),
    ramp,
    o.el('scale-hi', 'Span', {}, [o.text('scale-hi-text', withUnit(formatNumber(100, locale, 'maximumFractionDigits=2')))]),
    ...(e.flagLabel !== undefined ? [o.el('scale-flag', 'Span', { class: 'sem-flag-note' }, [o.text('scale-flag-text', `⚠ ${e.flagLabel}`)])] : []),
  ])
  o.renders(o.el('root', 'Div', {}, [...tables, scale]))
  return o.quads
}

// --- a chart of rows, as text ------------------------------------------------------------------

/**
 * c:RowChartText: a bar chart, heatmap or line chart as text - its name, then a line per row of its view in
 * the view's order, "facet · category · series: value unit", the value in the viewer's locale.
 */
const rowsText: FnRule = (ctx, focus) => {
  // A series chart says its points instead (c:SeriesChartText), unless its kind says its rows.
  if (isKind(ctx, focus, NS.c + 'SeriesChart') && !kindSays(ctx, focus, NS.c + 'saysRows', 'true')) return []
  const view = ctx.object(focus, C.view)
  if (!view || !ctx.object(view, SEM.select)) return message(ctx, focus, 'No view.')
  if (!ctx.match(view, RDF_TYPE, NS.rs + 'ResultSet').length) return message(ctx, focus, `${labelOf(ctx, view)} is not a maintained view (iv:View, iv:materialize iv:Graph).`)
  const solutions = ctx.objects(view, NS.rs + 'solution')
  const empty = solutions.length ? undefined : text(ctx, focus, C.emptyText)
  if (empty !== undefined) return message(ctx, focus, empty)
  const e = encoding(ctx, focus)
  const legend = rdfList(ctx, ctx.object(focus, C.legend))
  const seriesLabel = (key: string) => {
    const s = legend.find((n) => (str(ctx.object(n, C.key)) ?? n.value) === key)
    return s ? labelOf(ctx, s) : key
  }
  const o = ctx.out(focus)
  const lines = solutions
    .map((r) => ({ r, key: tupleKey([ctx.object(r, NS.rs + 'index') ? Number(ctx.object(r, NS.rs + 'index')!.value) : r.value]) }))
    .sort((a, b) => compareKeys(a.key, b.key))
    .map(({ r }) => {
      // A row's value of a variable is the node <row>-<variable> (view.ttl), read by its IRI.
      const value = (variable: string | undefined) => (variable === undefined ? undefined : str(ctx.object(ctx.nn(`${r.value}-${variable}`), NS.rs + 'value')))
      const facet = value(e.facet)
      const series = value(e.series)
      const head = [facet === undefined ? '' : e.facetLabel.replace('{value}', facet), value(e.category) ?? '', series === undefined ? '' : seriesLabel(series)].filter((x) => x !== '').join(' · ')
      const number = (variable: string | undefined) => {
        const raw = value(variable)
        const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
        return Number.isNaN(n) ? undefined : n
      }
      const v = number(e.value)
      // The value, with the x and size of a chart that has them (as its points say them).
      const shown = v === undefined ? '…' : measures(ctx, focus, v, number(str(ctx.object(focus, NS.c + 'xVariable'))), number(str(ctx.object(focus, NS.c + 'sizeVariable'))))
      const id = `row-${md5Key(r.value)}`
      return o.el(id, 'P', {}, [o.text(`${id}-text`, `${head}: ${shown}`)])
    })
  o.renders(o.el('root', 'Div', {}, [o.el('title', 'P', {}, [o.text('title-text', labelOf(ctx, focus))]), ...lines]))
  return o.quads
}

// --- findings ----------------------------------------------------------------------------------

const PERF = 'https://semblance.dev/ns/perf#'

// Each judgement is a maintained view (iv:View): its findings are in the views graph, kept up to
// date as the observations it reads arrive. Judgements are in sem:order (then by IRI), findings by
// sem:sortKey (numbers as numbers) and text - the order keys c:FindingListRendering-sparql writes.
const findings: FnRule = (ctx, focus) => {
  const cls = ctx.object(focus, C.judgementClass)
  if (!cls) return []
  const order = (j: NamedNode) => tupleKey([Number(str(ctx.object(j, SEM.order)) ?? 99), j.value])
  const judgements = ctx
    .match(null, RDF_TYPE, cls)
    .map((q) => q.subject)
    .filter((t): t is NamedNode => t.termType === 'NamedNode')
    .sort((a, b) => compareKeys(order(a), order(b)) || (a.value < b.value ? -1 : 1))
  const o = ctx.out(focus)
  const sections: NamedNode[] = []
  for (const j of judgements) {
    const jid = `j${md5Key(j.value)}`
    if (!ctx.match(j, RDF_TYPE, NS.iv + 'View').length) {
      sections.push(o.el(`${jid}-error`, 'P', { class: 'sem-empty' }, [o.text(`${jid}-error-t`, `${labelOf(ctx, j)} is not a maintained view (iv:View).`)]))
      continue
    }
    const items = ctx
      .match(null, PERF + 'judgement', j)
      .map((q) => q.subject)
      .filter((f): f is NamedNode => f.termType === 'NamedNode')
      .map((f) => {
        const sort = ctx.object(f, SEM.sortKey)
        const text = str(ctx.object(f, SEM.text)) ?? ''
        const numeric = sort?.termType === 'Literal' && NUMERIC.has(sort.datatype.value)
        return { id: `${jid}-f${md5Key(f.value)}`, text, verdict: ctx.object(f, SEM.verdict), key: tupleKey([numeric ? Number(sort.value) : sort?.value ?? '', text]) }
      })
      .sort((a, b) => compareKeys(a.key, b.key) || (a.id < b.id ? -1 : 1))
    if (!items.length) continue
    const lis = items.map(({ id, text, verdict: v }) => {
      const slug = v ? str(ctx.object(v, SEM.slug)) ?? 'insight' : 'insight'
      const pill = o.el(`${id}-v`, 'Span', { class: `sem-verdict sem-${slug}` }, [
        o.el(`${id}-v-icon`, 'B', { 'aria-hidden': 'true' }, [o.text(`${id}-v-icon-t`, v ? str(ctx.object(v, SEM.symbol)) ?? '·' : '·')]),
        o.text(`${id}-v-t`, v ? labelOf(ctx, v) : 'insight'),
      ])
      return o.el(id, 'Li', {}, [pill, o.el(`${id}-p`, 'P', {}, [o.text(`${id}-p-t`, text)])])
    })
    sections.push(o.el(jid, 'Section', {}, [o.el(`${jid}-h`, 'H3', {}, [o.text(`${jid}-h-t`, labelOf(ctx, j))]), o.el(`${jid}-ul`, 'Ul', {}, lis)]))
  }
  if (!sections.length) return message(ctx, focus, text(ctx, focus, C.emptyText) ?? 'No findings yet.')
  o.renders(o.el('root', 'Div', {}, sections))
  return o.quads
}

export const chartFunctions: Record<string, FnRule> = { barchart, heatmap, findings, 'chart:rows-text': rowsText }
