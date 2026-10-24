// Function rules and reactions for sheets (ontology/components/sheet.ttl): twins of the SPARQL
// there, rendering the same HTML.
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import type { ReactionFn } from '../behaviour/events.ts'
import type { FnRule, RuleContext } from '../engine/context.ts'
import { C, H, NS, SEM } from '../ns.ts'
import { named, str } from './util.ts'

const S = {
  cell: NS.c + 'cell',
  row: NS.c + 'row',
  column: NS.c + 'column',
  columns: NS.c + 'columns',
  formulaText: NS.c + 'formulaText',
  selectedCell: NS.c + 'selectedCell',
  recalculated: NS.c + 'recalculated',
  tick: NS.c + 'recalculationTick',
  valueQuery: NS.c + 'valueQuery',
  dataset: NS.c + 'dataset',
}
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const localName = (iri: string) => iri.replace(/^.*[#/]/, '')
const pad3 = (n: number | string) => String(n).padStart(3, '0').slice(-3)
const NUMBER = /^-?[0-9]+([.][0-9]+)?$/
const int = (ctx: RuleContext, s: Term, p: string) => Number(str(ctx.object(s, p)))

/** A cell's name, as a sheet spells it: its column's letter and its row ("D6"). */
const nameOf = (row: number, column: number) => `${LETTERS[column - 1] ?? '?'}${row}`

// --- the grid ---------------------------------------------------------------------------------------

const grid: FnRule = (ctx, focus) => {
  const columns = int(ctx, focus, S.columns)
  if (!Number.isFinite(columns)) return []
  const o = ctx.out(focus)
  const label = ctx.objects(focus, C.label).find((t) => t.termType === 'Literal')?.value ?? 'Sheet'
  const cells = ctx.objects(focus, S.cell).filter(named)
  const placed = cells.map((cell) => ({ cell, r: int(ctx, cell, S.row), c: int(ctx, cell, S.column) })).filter((x) => Number.isFinite(x.r) && Number.isFinite(x.c))
  const rows = [...new Set(placed.map((x) => x.r))]
  const height = 30 + Math.max(...placed.map((x) => x.r)) * 36
  const width = 44 + columns * 104
  const children: NamedNode[] = []
  const keyed = (n: NamedNode, key: string) => (o.t(n, SEM.orderKey, key), children.push(n))
  keyed(o.el('corner', 'Div', { class: 'sem-sheet-corner' }), '000.000')
  for (let c = 1; c <= Math.min(columns, 26); c++) {
    const letter = LETTERS[c - 1]!
    keyed(o.el(`col-${letter}`, 'Div', { class: 'sem-sheet-head', style: `grid-row: 1; grid-column: ${c + 1}` }, [o.text(`col-${letter}-text`, letter)]), `000.${pad3(c)}`)
  }
  for (const r of rows) keyed(o.el(`row-${r}`, 'Div', { class: 'sem-sheet-head', style: `grid-row: ${r + 1}; grid-column: 1` }, [o.text(`row-${r}-text`, String(r))]), `${pad3(r)}.000`)
  for (const { cell, r, c } of placed) keyed(cell, `${pad3(r)}.${pad3(c)}`)
  const links = o.svg('links', 'Svg', { viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true' })
  o.t(links, H.ns + 'class', 'sem-sheet-links')
  keyed(links, '999.999')
  const gridEl = o.el('grid', 'Div', { class: 'sem-sheet-grid', style: `grid-template-columns: 44px repeat(${columns}, 104px)`, 'aria-label': label })
  for (const ch of children) o.t(gridEl, H.hasChild, ch)
  const status = o.el('status', 'P', { class: 'sem-sheet-status', 'aria-live': 'polite' })
  o.renders(o.el('root', 'Div', {}, [o.el('bar', 'P', { class: 'sem-sheet-bar' }), o.el('scroll', 'Div', { class: 'sem-sheet-scroll' }, [gridEl]), status]))
  return o.quads
}

// --- a cell ------------------------------------------------------------------------------------------

const cell: FnRule = (ctx, focus) => {
  const r = int(ctx, focus, S.row)
  const c = int(ctx, focus, S.column)
  if (!Number.isFinite(r) || !Number.isFinite(c)) return []
  const o = ctx.out(focus)
  const formula = !!ctx.object(focus, S.valueQuery)
  const v = str(ctx.object(focus, C.value))
  const content = formula
    ? o.el('content', 'Output', {}, v === undefined ? [] : [o.text('content-text', v)])
    : o.el('content', 'Input', { type: 'text', value: v })
  o.attr(content, 'aria-label', nameOf(r, c))
  const root = o.el('root', 'Div', { class: 'sem-cell', style: `grid-row: ${r + 1}; grid-column: ${c + 1}`, 'data-sem-kind': formula ? 'formula' : 'value' }, [content])
  if (v !== undefined && NUMBER.test(v)) o.attr(root, 'data-sem-numeric', 'true')
  o.renders(root)
  return o.quads
}

// --- the selection, the arrows, the last recalculation ----------------------------------------------

/** An arrow between two cells' edges (the SPARQL rule's geometry, in integers). */
function arrow(from: { r: number; c: number }, to: { r: number; c: number }) {
  const y0 = 30 + (from.r - 1) * 36 + 18
  const y1 = 30 + (to.r - 1) * 36 + 18
  const dir = from.c === to.c ? 0 : to.c > from.c ? 1 : -1
  const x0 = dir === 0 ? 44 + from.c * 104 - 8 : dir === 1 ? 44 + from.c * 104 - 6 : 44 + (from.c - 1) * 104 + 6
  const x1 = dir === 0 ? x0 : dir === 1 ? 44 + (to.c - 1) * 104 + 6 : 44 + to.c * 104 - 6
  const k = dir === 0 ? 14 + 6 * Math.abs(to.r - from.r) : 32 + 8 * Math.abs(to.c - from.c)
  const cx0 = dir === 0 ? x0 + k : x0 + dir * k
  const cx1 = dir === 0 ? x1 + k : x1 - dir * k
  const back = dir === 1 ? -7 : 7
  return {
    d: `M${x0},${y0} C${cx0},${y0} ${cx1},${y1} ${x1},${y1}`,
    head: `M${x1},${y1} L${x1 + back},${y1 - 4} L${x1 + back},${y1 + 4} Z`,
  }
}

const focusRule: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const links = o.node('links')
  if (!ctx.match(links, NS.rdf + 'type', NS.svg + 'Svg').length) return o.quads
  const cells = new Set(ctx.objects(focus, S.cell).map((t) => t.value))
  const chosen = ctx.object(focus, S.selectedCell)
  const sel = named(chosen) && cells.has(chosen.value) ? chosen : undefined
  // The formula bar.
  let bar = 'Select a cell to see its formula, what it reads and what reads it.'
  if (sel) {
    const value = str(ctx.object(sel, C.value))
    const text = str(ctx.object(sel, S.formulaText))
    bar = `${nameOf(int(ctx, sel, S.row), int(ctx, sel, S.column))}  ${text !== undefined ? `${text}  →  ${value ?? '…'}` : (value ?? '')}`
  }
  o.t(o.node('bar'), H.hasChild, o.text('bar-text', bar))
  // How much the last change re-ran.
  const formulas = [...cells].filter((x) => ctx.object(ctx.nn(x), S.valueQuery)).length
  const recalculated = ctx.objects(focus, S.recalculated).filter(named)
  const tick = str(ctx.object(focus, S.tick))
  const status = tick !== undefined ? `The last change recalculated ${new Set(recalculated.map((t) => t.value)).size} of ${formulas} formulas.` : `${formulas} formulas. Change a number: only the formulas that read it recalculate.`
  o.t(o.node('status'), H.hasChild, o.text('status-text', status))
  if (sel) o.attr(ctx.nn(sel.value + '/~root'), 'data-sem-selected', 'true', `sel-${localName(sel.value)}`)
  if (tick !== undefined) {
    const parity = Number(tick) % 2 === 0 ? 'even' : 'odd'
    for (const rc of recalculated) o.attr(ctx.nn(rc.value + '/~root'), 'data-sem-recalculated', parity, `rec-${localName(rc.value)}`)
  }
  if (sel) {
    const at = (x: Term) => ({ r: int(ctx, x, S.row), c: int(ctx, x, S.column) })
    const pairs: [Term, Term, string][] = [
      ...ctx.objects(sel, S.dataset).map((from) => [from, sel, 'in'] as [Term, Term, string]),
      ...ctx.match(null, S.dataset, sel).map((q) => [q.subject, sel, 'out'] as [Term, Term, string]).map(([to, s, w]) => [s, to, w] as [Term, Term, string]),
    ]
    for (const [from, to, way] of pairs) {
      if (!cells.has(from.value) || !cells.has(to.value)) continue
      const a = arrow(at(from), at(to))
      const key = `${way}-${localName(from.value)}-${localName(to.value)}`
      const arc = o.svg(`link-${key}`, 'Path', { d: a.d, class: `sem-link sem-${way}` })
      const head = o.svg(`link-${key}-head`, 'Path', { d: a.head, class: `sem-head sem-${way}` })
      o.t(arc, SEM.orderKey, `${key}-a`).t(head, SEM.orderKey, `${key}-b`)
      o.t(links, H.hasChild, arc).t(links, H.hasChild, head)
    }
  }
  return o.quads
}

export const functions: Record<string, FnRule> = { 'sheet:grid': grid, 'sheet:cell': cell, 'sheet:focus': focusRule }

// --- reactions ------------------------------------------------------------------------------------------

type RCtx = Parameters<ReactionFn>[0]
const own = (ctx: RCtx, s: Term, p: string) => ctx.match(s, p, null).filter((q) => q.graph.termType === 'DefaultGraph')

const edit: ReactionFn = (ctx) => {
  if (ctx.object(ctx.target, S.valueQuery)) return { add: [], remove: [] }
  const f = ctx.runtime.store.factory
  const v = ctx.object(ctx.event, NS.beh + 'value')?.value
  const add: Quad[] = v !== undefined && v !== '' ? [f.quad(ctx.target, f.namedNode(C.value), NUMBER.test(v) ? f.literal(v, f.namedNode(NS.xsd + 'decimal')) : f.literal(v))] : []
  return { remove: own(ctx, ctx.target, C.value), add }
}

const select: ReactionFn = (ctx) => {
  const f = ctx.runtime.store.factory
  const out = { add: [] as Quad[], remove: [] as Quad[] }
  for (const q of ctx.match(null, S.cell, ctx.target)) {
    const sheet = q.subject
    const old = own(ctx, sheet, S.selectedCell)
    if (old.some((x) => x.object.equals(ctx.target))) continue
    out.remove.push(...old)
    out.add.push(f.quad(sheet as NamedNode, f.namedNode(S.selectedCell), ctx.target))
  }
  return out
}

export const reactions: Record<string, ReactionFn> = { 'sheet:edit': edit, 'sheet:select': select }
