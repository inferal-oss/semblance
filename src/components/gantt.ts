// Function twins of the Gantt chart (ontology/components/charts.ttl, "Gantt"). c:GanttPlan reads a
// maintained view's rows and mints the chart's tasks (c:GanttTask, one per task, with day numbers),
// its scale and its month ticks; the chart's frame and each task render from those, so a task that
// changes re-renders itself only, and a scale that moves changes the frame's custom properties.
import type { NamedNode, Term } from '@rdfjs/types'
import type { FnRule, RuleContext } from '../engine/context.ts'
import { C, L10N, NS, RDF_TYPE, SEM, XSD_INTEGER } from '../ns.ts'
import { tupleKey } from '../render/order-key.ts'
import { md5 } from './data.ts'
import { labelOf, RDFS_LABEL, text } from './util.ts'

const RS = NS.rs
const str = (t: Term | undefined) => t?.value
const c = (local: string) => NS.c + local

/** An ISO date (a date, or a date-time's date part) as days since 1970-01-01, by the civil calendar; the SPARQL rule computes the same. */
const ISO = /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])/
export function civilDay(value: string | undefined): number | undefined {
  const m = value === undefined ? null : ISO.exec(value)
  if (!m) return undefined
  const mo = Number(m[2])
  const y = Number(m[1]) - (mo <= 2 ? 1 : 0)
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (mo > 2 ? mo - 3 : mo + 9) + 2) / 5) + Number(m[3]) - 1
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468
}
/** Links a task may carry: http(s), or a path on the site. */
const SAFE_HREF = /^(https?:\/\/|\/([^/]|$))/
/** Month steps for the ticks: the smallest that needs at most twelve. */
const MONTH_STEPS = [1, 2, 3, 6, 12, 24, 60, 120, 240, 600, 1200]

/** A phrase of the chart (l10n:phrase): its derived label in the viewer's language, else the English one. */
export function phrase(ctx: RuleContext, chart: Term, local: string): string {
  const derived = str(ctx.object(ctx.nn(chart.value + '/~l10n-' + local), L10N.label))
  if (derived !== undefined) return derived
  return ctx.objects(ctx.nn(c(local)), RDFS_LABEL).find((t) => t.termType === 'Literal' && /^en(-|$)/i.test(t.language))?.value ?? local
}

/** What the chart shows instead of a chart, if anything: no view, a view that is not maintained, or no rows. */
function messageOf(ctx: RuleContext, chart: NamedNode): string | undefined {
  const view = ctx.object(chart, C.view)
  if (!view || !ctx.object(view, NS.sem + 'select')) return 'No view.'
  if (!ctx.match(view, RDF_TYPE, RS + 'ResultSet').length) return `${labelOf(ctx, view)} is not a maintained view (iv:View, iv:materialize iv:Graph).`
  if (!ctx.objects(view, RS + 'solution').length) return text(ctx, chart, C.emptyText) ?? phrase(ctx, chart, 'GanttNoRowsPhrase')
  return undefined
}

type Task = {
  id: string; pos: number | string; label?: string; start?: string; end?: string; baseStart?: string; baseEnd?: string
  uncertainty?: string; milestone: boolean; tone?: string; href?: string; byTask: boolean
}
const min = (a: string | undefined, b: string | undefined) => (a === undefined ? b : b === undefined || a <= b ? a : b)

/** c:GanttPlan: the chart's tasks, scale, ticks and today, from its view's rows. */
const plan: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const view = ctx.object(focus, C.view)
  if (!view || !ctx.match(view, RDF_TYPE, RS + 'ResultSet').length) return o.quads
  const name = (p: string, fallback: string) => str(ctx.object(focus, c(p))) ?? fallback
  const v = {
    task: name('taskVariable', 'task'), label: name('labelVariable', 'label'), start: name('startVariable', 'start'), end: name('endVariable', 'end'),
    baseStart: name('baselineStartVariable', 'baselineStart'), baseEnd: name('baselineEndVariable', 'baselineEnd'),
    uncertainty: name('uncertaintyVariable', 'uncertainty'), dependency: name('dependencyVariable', 'dependsOn'),
    milestone: name('milestoneVariable', 'milestone'), tone: name('toneVariable', 'tone'), href: name('hrefVariable', 'href'),
  }
  // A row's value of a variable is the node <row>-<variable> (view.ttl), read by its IRI.
  const tasks = new Map<string, Task>()
  const edges: [string, string][] = []
  // The scale spans every valid date of every row (ISO dates compare as text).
  let firstIso: string | undefined, lastIso: string | undefined
  for (const r of ctx.objects(view, RS + 'solution')) {
    const value = (variable: string) => str(ctx.object(ctx.nn(`${r.value}-${variable}`), RS + 'value'))
    for (const iso of [v.start, v.end, v.baseStart, v.baseEnd, v.uncertainty].map(value)) {
      if (iso === undefined || !ISO.test(iso)) continue
      if (firstIso === undefined || iso < firstIso) firstIso = iso
      if (lastIso === undefined || iso > lastIso) lastIso = iso
    }
    const byTask = value(v.task)
    const id = byTask ?? value(v.label)
    if (id === undefined) continue
    const index = ctx.object(r, RS + 'index')
    const pos = index ? Number(index.value) : r.value
    const t = tasks.get(id) ?? { id, pos, milestone: false, byTask: byTask !== undefined }
    tasks.set(id, t)
    if (typeof pos === typeof t.pos ? pos < t.pos : typeof pos === 'number') t.pos = pos
    t.label = min(t.label, value(v.label))
    t.start = min(t.start, value(v.start))
    t.end = min(t.end, value(v.end))
    t.baseStart = min(t.baseStart, value(v.baseStart))
    t.baseEnd = min(t.baseEnd, value(v.baseEnd))
    t.uncertainty = min(t.uncertainty, value(v.uncertainty))
    t.href = min(t.href, value(v.href))
    const tone = ctx.object(ctx.nn(`${r.value}-${v.tone}`), RS + 'value')
    if (tone?.termType === 'NamedNode' && ctx.match(tone, RDF_TYPE, NS.sty + 'Tone').length) t.tone = min(t.tone, tone.value)
    if (['true', '1'].includes(value(v.milestone) ?? '')) t.milestone = true
    const dependency = value(v.dependency)
    if (dependency !== undefined) edges.push([id, dependency])
  }
  const int = (n: number) => ctx.f.literal(String(n), ctx.nn(XSD_INTEGER))
  const tasksNode = o.node('tasks')
  const node = (t: Task) => o.node('task-' + md5(t.id).slice(0, 8))
  for (const t of tasks.values()) {
    const n = node(t)
    o.t(n, RDF_TYPE, ctx.nn(c('GanttTask'))).t(n, c('inChart'), focus).t(n, SEM.orderKey, tupleKey([t.pos])).t(n, C.label, t.label ?? t.id)
    o.t(tasksNode, NS.rdfhtml + 'hasChild', n)
    if (t.milestone) o.t(n, c('milestone'), ctx.f.literal('true', ctx.nn(NS.xsd + 'boolean')))
    if (t.tone) o.t(n, NS.sty + 'tone', ctx.nn(t.tone))
    if (t.href !== undefined && SAFE_HREF.test(t.href)) o.t(n, c('href'), t.href)
    for (const [p, iso] of [['start', t.start], ['end', t.end], ['baselineStart', t.baseStart], ['baselineEnd', t.baseEnd], ['uncertaintyEnd', t.uncertainty]] as const) {
      const d = civilDay(iso)
      if (d !== undefined) o.t(n, c(p), int(d)).t(n, c(p + 'Date'), iso!.slice(0, 10))
    }
  }
  // Predecessors, by their task value: a lead line from where each ends (its end, else its start), and its name.
  for (const [id, dependency] of edges) {
    const t = tasks.get(id)!, p = tasks.get(dependency)
    if (!p?.byTask || p === t) continue
    o.t(node(t), c('afterLabel'), p.label ?? p.id)
    const end = civilDay(p.end) ?? civilDay(p.start)
    if (end !== undefined) o.t(node(t), c('leadFrom'), int(end))
  }
  if (firstIso === undefined || lastIso === undefined) return o.quads
  // The scale (c:scale): a day before the first date to two after the last (its end is exclusive), and today
  // (c:today, else the viewer's), which the frame marks when it is on the scale.
  const first = civilDay(firstIso)! - 1, last = civilDay(lastIso)!
  const scale = o.node('gantt-scale')
  o.t(focus, c('scale'), scale).t(scale, RDF_TYPE, ctx.nn(c('TimeScale'))).t(scale, c('start'), int(first)).t(scale, c('end'), int(last + 2))
  const today = civilDay(str(ctx.object(focus, c('today'))) ?? str(ctx.object(focus, NS.l10n + 'today')))
  if (today !== undefined) o.t(scale, c('todayAt'), int(today))
  // Month ticks: the first date's month at the scale's start, then every step months, to the last date.
  const month = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1
  const m0 = month(firstIso)
  const step = MONTH_STEPS.find((s) => (month(lastIso!) - m0) / s <= 12) ?? 1200
  for (let k = 0; k <= 12; k++) {
    const m = m0 + k * step, y = Math.floor(m / 12), mm = m - y * 12 + 1
    const at = k === 0 ? first : civilDay(`${y}-${String(mm).padStart(2, '0')}-01`)
    if (at === undefined || at > last) continue
    const tick = o.node(`gantt-tick-${k}`)
    o.t(scale, c('tick'), tick).t(tick, c('at'), int(at)).t(tick, c('month'), int(mm)).t(tick, c('year'), int(y))
  }
  return o.quads
}

/** "%M %y" in the chart's locale, with its month names (l10n:Dated). */
function monthYear(ctx: RuleContext, chart: Term, month: string, year: string): string {
  const pattern = str(ctx.object(chart, NS.l10n + 'monthYearPattern')) ?? '%M %y'
  const name = str(ctx.object(ctx.nn(`${chart.value}/~l10n-month-${month}`), L10N.label)) ?? month
  return pattern.replace('%M', name).replace('%y', year)
}

/** The chart's frame on screen: a scrolling region with the plot (its scale as custom properties), the ticks, today, and the tasks' list. */
const screen: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const message = messageOf(ctx, focus)
  if (message !== undefined) {
    o.renders(o.el('root', 'P', { class: 'sem-empty' }, [o.text('empty', message)]))
    return o.quads
  }
  const scale = ctx.objects(focus, c('scale')).find((s) => ctx.match(s, RDF_TYPE, c('TimeScale')).length)
  const start = scale && str(ctx.object(scale, c('start'))), end = scale && str(ctx.object(scale, c('end')))
  const ticks: NamedNode[] = []
  const tickNodes = scale ? ctx.objects(scale, c('tick')) : []
  for (let k = 0; k <= 12; k++) {
    const tick = o.node(`gantt-tick-${k}`), at = tickNodes.some((t) => t.equals(tick)) ? str(ctx.object(tick, c('at'))) : undefined
    if (at === undefined) continue
    ticks.push(o.el(`tick-${k}`, 'Span', { class: 'sem-gantt-tick', style: `--at: ${at}` }, [o.text(`tick-${k}-text`, monthYear(ctx, focus, str(ctx.object(tick, c('month')))!, str(ctx.object(tick, c('year')))!))]))
  }
  const axis = o.el('axis', 'Div', { class: 'sem-gantt-axis', 'aria-hidden': 'true' }, ticks)
  const at = Number((scale && str(ctx.object(scale, c('todayAt')))) ?? NaN)
  const today = !(at >= Number(start) && at < Number(end)) ? [] : [o.el('today', 'Span', { class: 'sem-gantt-today', style: `--at: ${at}`, 'aria-hidden': 'true' }, [o.text('today-text', phrase(ctx, focus, 'GanttTodayPhrase'))])]
  const tasks = o.el('tasks', 'Ol', { class: 'sem-gantt-tasks' })
  const style = start === undefined || end === undefined ? undefined : `--first: ${start}; --days: ${Number(end) - Number(start)}`
  const plot = o.el('plot', 'Div', { class: 'sem-gantt-plot', style }, [axis, ...today, tasks])
  const scroll = o.el('scroll', 'Div', { class: 'sem-gantt-scroll', tabindex: '0', role: 'region', 'aria-label': labelOf(ctx, focus) }, [plot])
  o.renders(o.el('root', 'Figure', {}, [scroll]))
  return o.quads
}

/** The chart as text: its name, then a line per task. */
const textFrame: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const message = messageOf(ctx, focus)
  if (message !== undefined) {
    o.renders(o.el('root', 'P', { class: 'sem-empty' }, [o.text('empty', message)]))
    return o.quads
  }
  o.renders(o.el('root', 'Div', {}, [o.el('title', 'P', {}, [o.text('title-text', labelOf(ctx, focus))]), o.el('tasks', 'Div')]))
  return o.quads
}

/** What a task says in words, as (local name, text) parts: its dates, baseline, uncertainty, milestone, and what it follows (by name). */
function details(ctx: RuleContext, task: NamedNode, chart: Term): [string, string][] {
  const date = (p: string) => str(ctx.object(task, c(p + 'Date')))
  const start = date('start'), end = date('end')
  const parts: [string, string][] = [['dates-0', start === undefined ? phrase(ctx, chart, 'GanttUnscheduledPhrase') : end === undefined || end === start ? start : `${start} – ${end}`]]
  const bs = date('baselineStart'), be = date('baselineEnd')
  if (bs !== undefined || be !== undefined) parts.push(['dates-baseline', `${phrase(ctx, chart, 'GanttBaselinePhrase')}: ${bs ?? ''} – ${be ?? ''}`])
  const u = date('uncertaintyEnd')
  if (u !== undefined) parts.push(['dates-uncertainty', `${phrase(ctx, chart, 'GanttUncertaintyPhrase')}: ${u}`])
  if (ctx.object(task, c('milestone'))) parts.push(['dates-milestone', phrase(ctx, chart, 'GanttMilestonePhrase')])
  for (const after of ctx.objects(task, c('afterLabel')).map((t) => t.value).sort()) parts.push([`dates-after-${md5(after).slice(0, 8)}`, `${phrase(ctx, chart, 'GanttAfterPhrase')} ${after}`])
  return parts
}

/** A task on screen: its name (a link when it has one), its track (bar or milestone, baseline, uncertainty, lead lines), its dates in words. */
const taskScreen: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const chart = ctx.object(focus, c('inChart'))
  if (!chart) return o.quads
  const label = str(ctx.object(focus, C.label)) ?? ''
  const href = str(ctx.object(focus, c('href')))
  const name = o.el('label', 'Span', { class: 'sem-gantt-label' }, [href ? o.el('link', 'A', { href }, [o.text('link-text', label)]) : o.text('label-text', label)])
  const num = (p: string) => { const t = str(ctx.object(focus, c(p))); return t === undefined ? undefined : Number(t) }
  const start = num('start'), end = num('end'), bs = num('baselineStart'), be = num('baselineEnd'), u = num('uncertaintyEnd')
  const marks: NamedNode[] = []
  if (bs !== undefined || be !== undefined) {
    const from = bs ?? be!, to = Math.max(be ?? from, from)
    marks.push(o.el('baseline', 'Span', { class: 'sem-gantt-baseline', style: `--from: ${from}; --to: ${to}` }))
  }
  if (start !== undefined) {
    for (const lead of ctx.objects(focus, c('leadFrom')).map((t) => Number(t.value)).sort((a, b) => a - b)) {
      if (lead + 1 < start) marks.push(o.el(`lead-${lead}`, 'Span', { class: 'sem-gantt-lead', style: `--from: ${lead + 1}; --to: ${start - 1}` }))
    }
    const milestone = !!ctx.object(focus, c('milestone'))
    const to = milestone ? start : Math.max(end ?? start, start)
    const startDate = str(ctx.object(focus, c('startDate')))!
    const endDate = str(ctx.object(focus, c('endDate')))
    const tip = milestone || to === start || endDate === undefined ? `${label}: ${startDate}` : `${label}: ${startDate} – ${endDate}`
    const bar = o.el('bar', 'Span', { class: milestone ? 'sem-gantt-milestone' : 'sem-gantt-bar', style: `--from: ${start}; --to: ${to}` })
    o.tip(bar, tip)
    marks.push(bar)
    if (u !== undefined && u > to) marks.push(o.el('uncertainty', 'Span', { class: 'sem-gantt-uncertainty', style: `--from: ${to + 1}; --to: ${u}` }))
  }
  const track = o.el('track', 'Span', { class: 'sem-gantt-track', 'aria-hidden': 'true' }, marks)
  const words = o.el('dates', 'Span', { class: 'sem-visually-hidden' }, details(ctx, focus, chart).map(([local, part], i) => o.text(local, i ? ` · ${part}` : part)))
  o.renders(o.el('root', 'Li', {}, [name, track, words]))
  return o.quads
}

/** A task as a line of text: "Name: dates · details". */
const taskText: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const chart = ctx.object(focus, c('inChart'))
  if (!chart) return o.quads
  const parts = details(ctx, focus, chart).map(([local, part], i) => o.text(local, i ? `· ${part}` : part))
  o.renders(o.el('root', 'P', {}, [o.text('label-text', `${str(ctx.object(focus, C.label)) ?? ''}:`), ...parts]))
  return o.quads
}
export const ganttFunctions: Record<string, FnRule> = { 'gantt:plan': plan, 'gantt:screen': screen, 'gantt:text': textFrame, 'gantt-task:screen': taskScreen, 'gantt-task:text': taskText }
