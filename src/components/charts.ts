// Function rules for charts over sem:View SELECTs, and the finding list.
import type { NamedNode, Term } from '@rdfjs/types'
import type { FnRule, RuleContext } from '../engine/context.ts'
import { C, NS, RDF_TYPE, SEM } from '../ns.ts'
import { rdfList } from './views.ts'
import { labelOf, text } from './util.ts'
import { maintainedRows, viewRows } from '../view/rows.ts'
import { md5Key } from './data.ts'
import { compareKeys, tupleKey } from '../render/order-key.ts'

const NUMERIC = new Set(['integer', 'decimal', 'double', 'float', 'int', 'long', 'short', 'byte', 'nonNegativeInteger', 'positiveInteger', 'negativeInteger', 'nonPositiveInteger', 'unsignedInt', 'unsignedLong', 'unsignedShort', 'unsignedByte'].map((t) => NS.xsd + t))

const str = (t: Term | undefined) => t?.value
type Row = Map<string, Term>

/** v to k decimals, as the charts' SPARQL rules write it: ROUND(v × 10^k), the point put in its digits. */
const fixed = (v: number, k: number) => {
  const d = String(Math.round(v * 10 ** k))
  const p = d.length <= k ? '0'.repeat(k + 1 - d.length) + d : d
  return k ? p.slice(0, p.length - k) + '.' + p.slice(p.length - k) : p
}
const fmt = (v: number) => (v >= 100 ? fixed(v, 0) : v >= 10 ? fixed(v, 1) : v >= 1 ? fixed(v, 2) : v >= 0.01 ? fixed(v, 3) : '<0.01')
/** Counts (a chart without a unit) are whole: "5", not "5.00". */
const fmtIn = (unit: string) => (v: number) => (!unit && Number.isInteger(v) ? String(v) : fmt(v))
const num = (t: Term | undefined) => (t ? Number(t.value) : undefined)
/** A whole number (up to 15 digits) with thousands separators; anything else as it is. */
const grouped = (s: string) => (/^(0|[1-9][0-9]{0,14})$/.test(s) ? s.replace(/\B(?=(\d{3})+$)/g, ',') : s)

/** The chart's encoding: which SELECT variables play which role. */
function encoding(ctx: RuleContext, focus: NamedNode) {
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

/** Run the chart's view; returns undefined (and renders a message) if it cannot. */
function rows(ctx: RuleContext, focus: NamedNode): Row[] | string {
  if (!ctx.sparql) return 'Charts run SPARQL; choose a store with SPARQL.'
  const view = ctx.object(focus, C.view)
  const query = view && str(ctx.object(view, SEM.select))
  if (!query) return 'No view.'
  try {
    return viewRows(ctx, view!, query)
  } catch (e) {
    return `View ${labelOf(ctx, view!)} failed: ${(e as Error).message}`
  }
}

/** Series in legend order (c:legend: nodes with c:key + rdfs:label), else first-seen. */
function legendOf(ctx: RuleContext, focus: NamedNode, data: Row[], variable: string | undefined) {
  const declared = rdfList(ctx, ctx.object(focus, C.legend)).map((s) => ({ key: str(ctx.object(s, C.key)) ?? s.value, label: labelOf(ctx, s) }))
  if (declared.length) return declared
  // Without a series variable every value is one series, named by the chart.
  if (!variable) return [{ key: '', label: labelOf(ctx, focus) }]
  const seen = [...new Set(data.map((r) => (variable ? str(r.get(variable)) : undefined)).filter((x): x is string => x !== undefined))]
  return seen.map((k) => ({ key: k, label: k }))
}

const groupBy = <T,>(xs: T[], k: (x: T) => string) => {
  const m = new Map<string, T[]>()
  for (const x of xs) m.set(k(x), [...(m.get(k(x)) ?? []), x])
  return m
}

function message(ctx: RuleContext, focus: NamedNode, text: string) {
  const o = ctx.out(focus)
  o.renders(o.el('root', 'P', { class: 'sem-empty' }, [o.text('empty', text)]))
  return o.quads
}

function legend(o: ReturnType<RuleContext['out']>, series: { label: string }[]) {
  return o.el('legend', 'Ul', { class: 'sem-legend' }, series.map((s, i) =>
    o.el(`legend-${i}`, 'Li', {}, [o.el(`legend-${i}-swatch`, 'I', { style: `background: var(--sem-series-${(i % 6) + 1})` }), o.text(`legend-${i}-text`, s.label)]),
  ))
}

// --- bar chart --------------------------------------------------------------------------------

// A bar chart reads its view's rows from the views graph (a maintained SELECT: iv:View with
// iv:materialize iv:Graph), as its SPARQL rule does; c:BarChartRendering-sparql says the same in SPARQL.
const barchart: FnRule = (ctx, focus) => {
  const view = ctx.object(focus, C.view)
  if (!view || !ctx.object(view, SEM.select)) return message(ctx, focus, 'No view.')
  const data = maintainedRows(ctx, view)
  if (!data) return message(ctx, focus, `${labelOf(ctx, view)} is not a maintained view (iv:View, iv:materialize iv:Graph).`)
  // No rows: the chart's own c:emptyText, when it has one, instead of an empty figure.
  const empty = data.length ? undefined : text(ctx, focus, C.emptyText)
  if (empty) return message(ctx, focus, empty)
  const e = encoding(ctx, focus)
  const series = legendOf(ctx, focus, data, e.series)
  const o = ctx.out(focus)
  const facets = groupBy(data, (r) => (e.facet ? str(r.get(e.facet)) ?? '' : ''))
  const panels = [...facets].map(([facet, rs]) => {
    const fid = `f-${md5Key(facet)}`
    const categories = groupBy(rs, (r) => str(r.get(e.category)) ?? '')
    const totals = [...categories.values()].map((c) => c.reduce((a, r) => a + (num(r.get(e.value)) ?? 0), 0))
    const max = Math.max(...totals, 1e-9)
    const bars = [...categories].map(([category, cs]) => {
      const id = `b-${md5Key(facet)}-${md5Key(category)}`
      const measured = cs.some((r) => r.get(e.value))
      const total = cs.reduce((a, r) => a + (num(r.get(e.value)) ?? 0), 0)
      const segments = measured
        ? series.flatMap((s, si) => {
            const v = num(cs.find((r) => (e.series ? str(r.get(e.series)) === s.key : true))?.get(e.value))
            if (v === undefined || v <= 0) return []
            const seg = o.el(`${id}-s${si}`, 'Span', { class: 'sem-seg', style: `width: ${fixed((v / max) * 100, 2)}%; background: var(--sem-series-${(si % 6) + 1})` })
            o.tip(seg, `${category} · ${s.label}: ${fmtIn(e.unit)(v)} ${e.unit}`.trim())
            return [seg]
          })
        : []
      const track = o.el(`${id}-track`, 'Span', { class: 'sem-track' }, segments)
      const value = o.el(`${id}-total`, 'Span', { class: measured ? 'sem-total' : 'sem-total sem-pending' }, [
        o.text(`${id}-total-text`, measured ? `${fmtIn(e.unit)(total)} ${e.unit}`.trim() : 'running…'),
      ])
      return o.el(id, 'Div', { class: 'sem-bar' }, [o.el(`${id}-label`, 'Span', { class: 'sem-category' }, [o.text(`${id}-label-text`, category)]), track, value])
    })
    // Small multiples are captioned; an unfaceted chart is one figure without one.
    const caption = e.facet ? [o.el(`${fid}-caption`, 'Figcaption', {}, [o.text(`${fid}-caption-text`, e.facetLabel.replace('{value}', grouped(facet)))])] : []
    return o.el(fid, 'Figure', {}, [...caption, ...bars])
  })
  const parts = [o.el('panels', 'Div', { class: 'sem-panels' }, panels)]
  if (e.series && series.length > 1) parts.push(legend(o, series))
  o.renders(o.el('root', 'Div', {}, parts))
  return o.quads
}

// --- heatmap ---------------------------------------------------------------------------------

const heatmap: FnRule = (ctx, focus) => {
  const data = rows(ctx, focus)
  if (typeof data === 'string') return message(ctx, focus, data)
  const e = encoding(ctx, focus)
  const o = ctx.out(focus)
  const lo = Math.log10(0.01)
  const hi = Math.log10(100)
  const step = (v: number) => Math.round(Math.min(1, Math.max(0, (Math.log10(Math.max(v, 0.01)) - lo) / (hi - lo))) * 12)
  const facets = groupBy(data, (r) => (e.facet ? str(r.get(e.facet)) ?? '' : ''))
  const tables = [...facets].map(([facet, rs], fi) => {
    const columns = [...new Set(rs.map((r) => str(r.get(e.category)) ?? ''))]
    const rowsBy = groupBy(rs, (r) => (e.series ? str(r.get(e.series)) ?? '' : ''))
    const head = o.el(`f${fi}-head`, 'Thead', {}, [
      o.el(`f${fi}-head-row`, 'Tr', {}, [o.el(`f${fi}-corner`, 'Th'), ...columns.map((c, ci) => o.el(`f${fi}-col${ci}`, 'Th', { scope: 'col' }, [o.text(`f${fi}-col${ci}-text`, c)]))]),
    ])
    const body = o.el(`f${fi}-body`, 'Tbody', {}, [...rowsBy].map(([row, cs], ri) =>
      o.el(`f${fi}-r${ri}`, 'Tr', {}, [
        o.el(`f${fi}-r${ri}-h`, 'Th', { scope: 'row' }, [o.text(`f${fi}-r${ri}-h-text`, row)]),
        ...columns.map((c, ci) => {
          const r = cs.find((x) => str(x.get(e.category)) === c)
          const v = num(r?.get(e.value))
          const id = `f${fi}-r${ri}-c${ci}`
          if (v === undefined) return o.el(id, 'Td', { class: 'sem-pending' }, [o.text(id + '-text', '…')])
          const flagged = e.flag !== undefined && str(r!.get(e.flag)) === 'true'
          const cell = o.el(id, 'Td', { class: `sem-h${step(v)}${flagged ? ' sem-flagged' : ''}` }, [o.text(id + '-text', `${flagged ? '⚠ ' : ''}${fmt(v)}`)])
          o.tip(cell, `${c} · ${row}: ${fmt(v)} ${e.unit}${flagged && e.flagLabel ? ` — ${e.flagLabel}` : ''}`.trim())
          return cell
        }),
      ]),
    ))
    const caption = o.el(`f${fi}-caption`, 'Figcaption', {}, [o.text(`f${fi}-caption-text`, e.facetLabel.replace('{value}', Number.isFinite(Number(facet)) ? Number(facet).toLocaleString('en-US') : facet))])
    return o.el(`f${fi}`, 'Figure', {}, [caption, o.el(`f${fi}-scroll`, 'Div', { class: 'sem-scroll' }, [o.el(`f${fi}-table`, 'Table', {}, [head, body])])])
  })
  const ramp = o.el('ramp', 'Span', { class: 'sem-ramp' }, Array.from({ length: 13 }, (_, i) => o.el(`ramp-${i}`, 'I', { class: `sem-h${i}` })))
  const scale = o.el('scale', 'Div', { class: 'sem-scale' }, [
    o.el('scale-lo', 'Span', {}, [o.text('scale-lo-text', `0.01 ${e.unit}`)]),
    ramp,
    o.el('scale-hi', 'Span', {}, [o.text('scale-hi-text', `100 ${e.unit}`)]),
    ...(e.flagLabel ? [o.el('scale-flag', 'Span', { class: 'sem-flag-note' }, [o.text('scale-flag-text', `⚠ ${e.flagLabel}`)])] : []),
  ])
  o.renders(o.el('root', 'Div', {}, [...tables, scale]))
  return o.quads
}

// --- line chart (SVG) -----------------------------------------------------------------------------

const linechart: FnRule = (ctx, focus) => {
  const data = rows(ctx, focus)
  if (typeof data === 'string') return message(ctx, focus, data)
  const e = encoding(ctx, focus)
  const points = data
    .map((r) => ({ s: e.series ? str(r.get(e.series)) ?? '' : '', x: num(r.get(e.category)), y: num(r.get(e.value)) }))
    .filter((p): p is { s: string; x: number; y: number } => p.x !== undefined && p.y !== undefined && p.y > 0)
  const xs = [...new Set(points.map((p) => p.x))].sort((a, b) => a - b)
  if (xs.length < 2) return message(ctx, focus, text(ctx, focus, C.emptyText) ?? 'Needs at least two sizes.')
  const series = legendOf(ctx, focus, data, e.series)
  const o = ctx.out(focus)
  const W = 560
  const Hh = 300
  const m = { l: 62, r: 20, t: 16, b: 40 }
  const tx = (v: number) => (e.log ? Math.log10(v) : v)
  const ys = points.map((p) => p.y)
  const yLo = Math.floor(Math.log10(Math.min(...ys)))
  const yHi = Math.ceil(Math.log10(Math.max(...ys)))
  const x = (v: number) => m.l + ((tx(v) - tx(xs[0]!)) / (tx(xs[xs.length - 1]!) - tx(xs[0]!) || 1)) * (W - m.l - m.r)
  const y = (v: number) => Hh - m.b - ((Math.log10(v) - yLo) / (yHi - yLo || 1)) * (Hh - m.t - m.b)
  const parts: NamedNode[] = []
  for (let k = yLo; k <= yHi; k++) {
    const v = 10 ** k
    parts.push(o.svg(`grid${k}`, 'Line', { x1: m.l, x2: W - m.r, y1: y(v).toFixed(1), y2: y(v).toFixed(1), class: 'sem-grid' }))
    parts.push(o.svg(`ylab${k}`, 'Text', { x: m.l - 8, y: y(v).toFixed(1), 'text-anchor': 'end', 'dominant-baseline': 'central', class: 'sem-axis' }, [o.text(`ylab${k}-t`, `${v >= 1 ? v : v.toFixed(2)} ${e.unit}`.trim())]))
  }
  xs.forEach((v, i) => parts.push(o.svg(`xlab${i}`, 'Text', { x: x(v).toFixed(1), y: Hh - m.b + 22, 'text-anchor': 'middle', class: 'sem-axis' }, [o.text(`xlab${i}-t`, `${v.toLocaleString('en-US')}`)])))
  if (e.reference === 'linear') {
    const firsts = series.map((s) => points.find((p) => p.s === s.key && p.x === xs[0])).filter(Boolean) as { y: number }[]
    const start = Math.max(...firsts.map((p) => p.y))
    const end = Math.min(start * (xs[xs.length - 1]! / xs[0]!), 10 ** yHi)
    const ref = o.svg('reference', 'Line', { x1: x(xs[0]!).toFixed(1), y1: y(start).toFixed(1), x2: x(xs[xs.length - 1]!).toFixed(1), y2: y(end).toFixed(1), class: 'sem-reference' })
    o.tip(ref, 'proportional (linear) growth from the slowest configuration')
    parts.push(ref, o.svg('reference-label', 'Text', { x: (x(xs[xs.length - 1]!) - 4).toFixed(1), y: (y(end) - 8).toFixed(1), 'text-anchor': 'end', class: 'sem-axis' }, [o.text('reference-label-t', 'linear')]))
  }
  series.forEach((s, si) => {
    const ps = points.filter((p) => p.s === s.key).sort((a, b) => a.x - b.x)
    if (!ps.length) return
    const color = `var(--sem-series-${(si % 6) + 1})`
    parts.push(o.svg(`line${si}`, 'Path', { d: ps.map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' '), class: 'sem-line', style: `stroke: ${color}` }))
    ps.forEach((p, pi) => {
      const dot = o.svg(`dot${si}-${pi}`, 'Circle', { cx: x(p.x).toFixed(1), cy: y(p.y).toFixed(1), r: 4.5, class: 'sem-dot', style: `fill: ${color}` })
      o.tip(dot, `${s.label} · ${p.x.toLocaleString('en-US')}: ${fmt(p.y)} ${e.unit}`.trim())
      parts.push(dot)
    })
  })
  const svg = o.svg('plot', 'Svg', { viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': labelOf(ctx, focus) }, parts)
  o.renders(o.el('root', 'Div', {}, [svg, legend(o, series)]))
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

export const chartFunctions: Record<string, FnRule> = { barchart, heatmap, linechart, findings }
