// Function rules for charts over sem:View SELECTs, and the finding list.
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import type { FnRule, RuleContext } from '../engine/context.ts'
import { C, NS, RDF_TYPE, SEM } from '../ns.ts'
import { labelOf, rdfList } from './views.ts'
import { labelOf as localizedLabelOf, text } from './util.ts'
import { viewRows } from '../view/rows.ts'

const str = (t: Term | undefined) => t?.value
type Row = Map<string, Term>

const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : '<0.01')
/** Counts (a chart without a unit) are whole: "5", not "5.00". */
const fmtIn = (unit: string) => (v: number) => (!unit && Number.isInteger(v) ? String(v) : fmt(v))
const num = (t: Term | undefined) => (t ? Number(t.value) : undefined)
const key = (s: string) => encodeURIComponent(s).replace(/%/g, '')

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
    unit: v(C.unit) ?? '',
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

const barchart: FnRule = (ctx, focus) => {
  const data = rows(ctx, focus)
  if (typeof data === 'string') return message(ctx, focus, data)
  // No rows: the chart's own c:emptyText, when it has one, instead of an empty figure.
  const empty = data.length ? undefined : text(ctx, focus, C.emptyText)
  if (empty) return message(ctx, focus, empty)
  const e = encoding(ctx, focus)
  const series = legendOf(ctx, focus, data, e.series)
  const o = ctx.out(focus)
  const facets = groupBy(data, (r) => (e.facet ? str(r.get(e.facet)) ?? '' : ''))
  const panels = [...facets].map(([facet, rs], fi) => {
    const categories = groupBy(rs, (r) => str(r.get(e.category)) ?? '')
    const totals = [...categories.values()].map((c) => c.reduce((a, r) => a + (num(r.get(e.value)) ?? 0), 0))
    const max = Math.max(...totals, 1e-9)
    const bars = [...categories].map(([category, cs], ci) => {
      const id = `f${fi}-c${key(category)}`
      const measured = cs.some((r) => r.get(e.value))
      const total = cs.reduce((a, r) => a + (num(r.get(e.value)) ?? 0), 0)
      const segments = measured
        ? series.flatMap((s, si) => {
            const v = num(cs.find((r) => (e.series ? str(r.get(e.series)) === s.key : true))?.get(e.value))
            if (v === undefined || v <= 0) return []
            const seg = o.el(`${id}-s${si}`, 'Span', { class: 'sem-seg', style: `width: ${((v / max) * 100).toFixed(2)}%; background: var(--sem-series-${(si % 6) + 1})` })
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
    const caption = e.facet ? [o.el(`f${fi}-caption`, 'Figcaption', {}, [o.text(`f${fi}-caption-text`, e.facetLabel.replace('{value}', Number.isFinite(Number(facet)) ? Number(facet).toLocaleString('en-US') : facet))])] : []
    return o.el(`f${fi}`, 'Figure', {}, [...caption, ...bars])
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

// --- dated rows (Gantt) -----------------------------------------------------------------------

/** ISO dates are days in UTC; invalid calendar dates do not enter the chart. */
const day = (value: string | undefined): number | undefined => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10))) return undefined
  const iso = value.slice(0, 10)
  const d = Date.parse(`${iso}T00:00:00Z`)
  return Number.isFinite(d) && new Date(d).toISOString().slice(0, 10) === iso ? d / 86_400_000 : undefined
}
const isoDay = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10)
const safeHref = (value: string | undefined) => value && (/^https?:\/\//.test(value) || /^\/(?!\/)/.test(value)) ? value : undefined
type GanttRow = {
  id: string; label: string; start?: number; end?: number; baseStart?: number; baseEnd?: number
  uncertainty?: number; milestone: boolean; tone: string; href?: string; dependsOn: Set<string>
}

const ganttchart: FnRule = (ctx, focus) => {
  const data = rows(ctx, focus)
  if (typeof data === 'string') return message(ctx, focus, data)
  if (!data.length) return message(ctx, focus, text(ctx, focus, C.emptyText) ?? localizedLabelOf(ctx, ctx.nn(NS.c + 'GanttNoRows')))
  const variable = (property: string, fallback: string) => str(ctx.object(focus, property)) ?? fallback
  const v = {
    task: variable(C.taskVariable, 'task'), label: variable(C.labelVariable, 'label'),
    start: variable(C.startVariable, 'start'), end: variable(C.endVariable, 'end'),
    baseStart: variable(C.baselineStartVariable, 'baselineStart'), baseEnd: variable(C.baselineEndVariable, 'baselineEnd'),
    uncertainty: variable(C.uncertaintyVariable, 'uncertainty'), dependency: variable(C.dependencyVariable, 'dependsOn'),
    milestone: variable(C.milestoneVariable, 'milestone'), tone: variable(C.toneVariable, 'tone'), href: variable(C.hrefVariable, 'href'),
  }
  const tasks = new Map<string, GanttRow>()
  for (const r of data) {
    const id = str(r.get(v.task)) ?? str(r.get(v.label))
    if (!id) continue
    const dependency = str(r.get(v.dependency))
    const existing = tasks.get(id)
    if (existing) { if (dependency) existing.dependsOn.add(dependency); continue }
    const tone = (str(r.get(v.tone)) ?? 'accent').replace(/^.*[#/]/, '').toLowerCase()
    const task: GanttRow = {
      id, label: str(r.get(v.label)) ?? id, start: day(str(r.get(v.start))), end: day(str(r.get(v.end))),
      baseStart: day(str(r.get(v.baseStart))), baseEnd: day(str(r.get(v.baseEnd))),
      uncertainty: day(str(r.get(v.uncertainty))), milestone: ['true', '1'].includes(str(r.get(v.milestone)) ?? ''),
      tone: ['accent', 'neutral', 'info', 'success', 'warning', 'danger'].includes(tone) ? tone : 'accent',
      href: safeHref(str(r.get(v.href))), dependsOn: new Set(dependency ? [dependency] : []),
    }
    tasks.set(id, task)
  }
  const dated = [...tasks.values()].flatMap((t) => [t.start, t.end, t.baseStart, t.baseEnd, t.uncertainty].filter((n): n is number => n !== undefined))
  if (!dated.length) return message(ctx, focus, text(ctx, focus, C.emptyText) ?? localizedLabelOf(ctx, ctx.nn(NS.c + 'GanttNoRows')))
  let first = Number.POSITIVE_INFINITY, last = Number.NEGATIVE_INFINITY
  for (const d of dated) { first = Math.min(first, d); last = Math.max(last, d) }
  first -= 2
  last += 2
  if (last - first > 3657) return message(ctx, focus, localizedLabelOf(ctx, ctx.nn(NS.c + 'GanttRangeTooWide')))
  const tick = Math.max(2, Math.min(18, 10_000 / (last - first + 1)))
  const left = 150, header = 44, rowHeight = 30
  const width = Math.ceil(left + (last - first + 1) * tick)
  const height = header + Math.max(tasks.size, 1) * rowHeight + 12
  const x = (d: number) => left + (d - first) * tick
  const o = ctx.out(focus)
  const phrase = (name: string) => localizedLabelOf(ctx, ctx.nn(NS.c + name))
  ctx.readsLanguage()
  const locale = ctx.languages.find((language) => ['en', 'uk', 'de', 'ar'].includes(language)) ?? 'en'
  const monthFormat = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' })
  const plotted: NamedNode[] = []
  const arrowId = `sem-gantt-arrow-${key(focus.value)}`
  plotted.push(o.svg('defs', 'Defs', {}, [o.svg('arrow-marker', 'Marker', { id: arrowId, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto' }, [o.svg('arrow-head', 'Path', { d: 'M0 0 8 4 0 8z', class: 'sem-gantt-arrowhead' })])]))
  const all = [...tasks.values()]
  const positions = new Map<string, { x: number; y: number; w: number }>()
  for (let d = first; d <= last; d++) {
    const date = new Date(d * 86_400_000)
    if (date.getUTCDate() === 1 || d === first) {
      plotted.push(o.svg(`month-line-${d}`, 'Line', { x1: x(d), x2: x(d), y1: 0, y2: height, class: 'sem-gantt-month-line' }))
      plotted.push(o.svg(`month-${d}`, 'Text', { x: x(d) + 4, y: 18, class: 'sem-gantt-month' }, [o.text(`month-text-${d}`, monthFormat.format(date))]))
    } else if (date.getUTCDay() === 1 && tick >= 10) plotted.push(o.svg(`week-${d}`, 'Line', { x1: x(d), x2: x(d), y1: 26, y2: height, class: 'sem-gantt-week' }))
  }
  all.forEach((t, i) => {
    const k = key(t.id), y = header + i * rowHeight
    plotted.push(o.svg(`lane-${k}`, 'Rect', { x: 0, y, width, height: rowHeight, class: i % 2 ? 'sem-gantt-lane sem-gantt-lane-alt' : 'sem-gantt-lane' }))
    const label = o.svg(`label-${k}`, 'Text', { x: 10, y: y + 20, class: 'sem-gantt-label' }, [o.text(`label-text-${k}`, t.label.length > 21 ? t.label.slice(0, 20) + '…' : t.label)])
    o.tip(label, t.label)
    plotted.push(t.href ? o.svg(`label-link-${k}`, 'A', { href: t.href }, [label]) : label)
    if (t.start === undefined) return
    if (t.milestone) {
      const cx = x(t.start) + tick / 2
      const diamond = o.svg(`milestone-${k}`, 'Path', { d: `M${cx} ${y + 8}l7 7-7 7-7-7z`, class: `sem-gantt-milestone sem-gantt-tone-${t.tone}` })
      o.tip(diamond, `${t.label}: ${isoDay(t.start)}`)
      plotted.push(t.href ? o.svg(`milestone-link-${k}`, 'A', { href: t.href }, [diamond]) : diamond)
      positions.set(t.id, { x: cx, y: y + 15, w: 0 })
      return
    }
    const end = Math.max(t.end ?? t.start, t.start)
    const barX = x(t.start), barW = (end - t.start + 1) * tick
    if (t.baseStart !== undefined || t.baseEnd !== undefined) {
      const bs = t.baseStart ?? t.baseEnd!, be = Math.max(t.baseEnd ?? bs, bs)
      plotted.push(o.svg(`baseline-${k}`, 'Rect', { x: x(bs), y: y + 4, width: (be - bs + 1) * tick, height: 22, rx: 4, class: 'sem-gantt-baseline' }))
    }
    const bar = o.svg(`bar-${k}`, 'Rect', { x: barX, y: y + 9, width: barW, height: 13, rx: 4, class: `sem-gantt-bar sem-gantt-tone-${t.tone}` })
    o.tip(bar, `${t.label}: ${isoDay(t.start)} – ${isoDay(end)}`)
    plotted.push(t.href ? o.svg(`bar-link-${k}`, 'A', { href: t.href }, [bar]) : bar)
    if (t.uncertainty !== undefined && t.uncertainty > end) {
      const tipX = x(t.uncertainty) + tick
      const uncertainty = o.svg(`uncertainty-${k}`, 'Line', { x1: barX + barW, x2: tipX, y1: y + 15, y2: y + 15, class: 'sem-gantt-uncertainty' })
      o.tip(uncertainty, `${t.label}: ${isoDay(t.uncertainty)}`)
      plotted.push(uncertainty)
      plotted.push(o.svg(`uncertainty-cap-${k}`, 'Line', { x1: tipX, x2: tipX, y1: y + 9, y2: y + 21, class: 'sem-gantt-uncertainty' }))
    }
    positions.set(t.id, { x: barX, y: y + 15, w: barW })
  })
  all.forEach((t) => t.dependsOn.forEach((id) => {
    const from = positions.get(id), to = positions.get(t.id)
    if (!from || !to) return
    const bend = Math.max(from.x + from.w + 8, to.x - 9)
    plotted.push(o.svg(`dependency-${key(id)}-${key(t.id)}`, 'Path', { d: `M${from.x + from.w} ${from.y}H${bend}V${to.y}H${to.x - 3}`, class: 'sem-gantt-dependency', 'marker-end': `url(#${arrowId})` }))
  }))
  const today = Math.floor(Date.now() / 86_400_000)
  if (today >= first && today <= last) {
    plotted.push(o.svg('today', 'Line', { x1: x(today) + tick / 2, x2: x(today) + tick / 2, y1: 26, y2: height, class: 'sem-gantt-today' }))
    plotted.push(o.svg('today-label', 'Text', { x: x(today) + tick / 2 + 3, y: 38, class: 'sem-gantt-today-label' }, [o.text('today-text', phrase('GanttToday'))]))
  }
  const svg = o.svg('plot', 'Svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': labelOf(ctx, focus) }, plotted)
  const scroll = o.el('scroll', 'Div', { class: 'sem-gantt-scroll', tabindex: '0', role: 'region', 'aria-label': labelOf(ctx, focus) }, [svg])
  const heading = o.el('table-head', 'Tr', {}, ['GanttTask', 'GanttStart', 'GanttEnd', 'GanttBaseline', 'GanttDetails'].map((name) => o.el(`th-${name}`, 'Th', { scope: 'col' }, [o.text(`th-${name}-text`, phrase(name))])))
  const body = o.el('table-body', 'Tbody', {}, all.map((t, i) => {
    const k = `table-${i}`
    const task = t.href ? o.el(`${k}-link`, 'A', { href: t.href }, [o.text(`${k}-link-text`, t.label)]) : o.text(`${k}-label`, t.label)
    const notes = [
      t.milestone ? phrase('GanttMilestone') : undefined,
      t.uncertainty === undefined ? undefined : `${phrase('GanttUncertainty')}: ${isoDay(t.uncertainty)}`,
      ...[...t.dependsOn].map((id) => `${phrase('GanttAfter')} ${tasks.get(id)?.label ?? id}`),
    ].filter((note): note is string => note !== undefined)
    return o.el(k, 'Tr', {}, [
      o.el(`${k}-name`, 'Th', { scope: 'row' }, [task]),
      o.el(`${k}-start`, 'Td', {}, [o.text(`${k}-start-text`, t.start === undefined ? phrase('GanttUnscheduled') : isoDay(t.start))]),
      o.el(`${k}-end`, 'Td', {}, [o.text(`${k}-end-text`, t.end === undefined ? '' : isoDay(t.end))]),
      o.el(`${k}-baseline`, 'Td', {}, [o.text(`${k}-baseline-text`, t.baseStart === undefined && t.baseEnd === undefined ? '' : `${t.baseStart === undefined ? '' : isoDay(t.baseStart)} – ${t.baseEnd === undefined ? '' : isoDay(t.baseEnd)}`)]),
      o.el(`${k}-details`, 'Td', {}, [o.text(`${k}-details-text`, notes.join(' · '))]),
    ])
  }))
  const table = o.el('table', 'Table', {}, [o.el('table-header', 'Thead', {}, [heading]), body])
  const details = o.el('details', 'Details', {}, [o.el('summary', 'Summary', {}, [o.text('summary-text', phrase('GanttAsTable'))]), table])
  o.renders(o.el('root', 'Figure', {}, [scroll, details]))
  return o.quads
}

// --- findings ----------------------------------------------------------------------------------

const PERF = 'https://semblance.dev/ns/perf#'

const findings: FnRule = (ctx, focus) => {
  if (!ctx.sparql) return message(ctx, focus, 'Judgements run SPARQL; choose a store with SPARQL.')
  const cls = ctx.object(focus, C.judgementClass)
  if (!cls) return []
  const judgements = ctx
    .match(null, RDF_TYPE, cls)
    .map((q) => q.subject)
    .filter((t): t is NamedNode => t.termType === 'NamedNode')
    .sort((a, b) => Number(str(ctx.object(a, SEM.order)) ?? 99) - Number(str(ctx.object(b, SEM.order)) ?? 99))
  const o = ctx.out(focus)
  const sections: NamedNode[] = []
  judgements.forEach((j, ji) => {
    // A judgement that is a maintained view (iv:View) has its findings in the views graph,
    // kept up to date as observations arrive; any other is run.
    let quads: Quad[]
    if (ctx.match(j, RDF_TYPE, NS.iv + 'View').length) quads = ctx.match(null, PERF + 'judgement', j).flatMap((q) => ctx.match(q.subject, null, null))
    else
      try {
        quads = ctx.construct(str(ctx.object(j, SEM.construct)) ?? '')
      } catch (e) {
        quads = []
        sections.push(o.el(`j${ji}-error`, 'P', { class: 'sem-empty' }, [o.text(`j${ji}-error-t`, `${labelOf(ctx, j)} failed: ${(e as Error).message}`)]))
      }
    const items = [...groupBy(quads, (q) => q.subject.value)]
      .map(([, qs]) => ({
        text: qs.find((q) => q.predicate.value === SEM.text)?.object.value ?? '',
        verdict: qs.find((q) => q.predicate.value === SEM.verdict)?.object,
        sort: qs.find((q) => q.predicate.value === SEM.sortKey)?.object.value ?? '',
      }))
      .sort((a, b) => a.sort.localeCompare(b.sort, undefined, { numeric: true }) || a.text.localeCompare(b.text))
    if (!items.length) return
    const lis = items.map((f, fi) => {
      const v = f.verdict
      const slug = v ? str(ctx.object(v, SEM.slug)) ?? 'insight' : 'insight'
      const pill = o.el(`j${ji}-f${fi}-v`, 'Span', { class: `sem-verdict sem-${slug}` }, [
        o.el(`j${ji}-f${fi}-v-icon`, 'B', { 'aria-hidden': 'true' }, [o.text(`j${ji}-f${fi}-v-icon-t`, v ? str(ctx.object(v, SEM.symbol)) ?? '·' : '·')]),
        o.text(`j${ji}-f${fi}-v-t`, v ? labelOf(ctx, v) : 'insight'),
      ])
      return o.el(`j${ji}-f${fi}`, 'Li', {}, [pill, o.el(`j${ji}-f${fi}-p`, 'P', {}, [o.text(`j${ji}-f${fi}-p-t`, f.text)])])
    })
    sections.push(o.el(`j${ji}`, 'Section', {}, [o.el(`j${ji}-h`, 'H3', {}, [o.text(`j${ji}-h-t`, labelOf(ctx, j))]), o.el(`j${ji}-ul`, 'Ul', {}, lis)]))
  })
  if (!sections.length) return message(ctx, focus, text(ctx, focus, C.emptyText) ?? 'No findings yet.')
  o.renders(o.el('root', 'Div', {}, sections))
  return o.quads
}

export const chartFunctions: Record<string, FnRule> = { barchart, heatmap, linechart, ganttchart, findings }
