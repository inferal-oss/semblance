// Function rules and reactions for the navigation components (ontology/components/navigation.ttl).
import type { NamedNode, Term } from '@rdfjs/types'
import type { ReactionFn } from '../behaviour/events.ts'
import type { FnRule } from '../engine/context.ts'
import { C, MOD, NS, XSD_INTEGER } from '../ns.ts'
import { el, hashKey, marked } from './data.ts'
import { isTrue, labelOf, named, nodes, num, text } from './util.ts'

const C_ITEMS = NS.c + 'items'
const C_PARENT_PROPERTY = NS.c + 'parentProperty'
const C_PAGE = NS.c + 'page'
const C_PAGES = NS.c + 'pages'
const C_GOES_TO = NS.c + 'goesTo'
const C_STEPS = NS.c + 'steps'
const C_CURRENT = NS.c + 'current'
const C_NAVIGABLE = NS.c + 'navigable'

const NONE = { add: [], remove: [] }

// --- Breadcrumbs ----------------------------------------------------------------------------------

/** The path from the root down to `end`, following `parent` up (first parent by IRI; cycles stop). */
function trail(ctx: Parameters<FnRule>[0], end: NamedNode, parent: Term): NamedNode[] {
  const out: NamedNode[] = [end]
  const seen = new Set([end.value])
  for (let n: NamedNode | undefined = end; n && out.length < 32; ) {
    const up: NamedNode | undefined = ctx
      .objects(n, parent)
      .filter(named)
      .filter((p) => !seen.has(p.value))
      .sort((a, b) => (a.value < b.value ? -1 : 1))[0]
    if (up) {
      out.unshift(up)
      seen.add(up.value)
    }
    n = up
  }
  return out
}

const breadcrumbs: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const target = ctx.object(focus, C.controls)
  const property = ctx.object(focus, C.property)
  const navigates = named(target) && named(property)
  const items = nodes(ctx, ctx.object(focus, C_ITEMS))
  let crumbs = items
  if (!crumbs.length) {
    const parent = ctx.object(focus, C_PARENT_PROPERTY)
    const end = ctx.object(focus, C.of) ?? (navigates ? ctx.object(target, property) : undefined)
    if (named(end) && named(parent)) crumbs = trail(ctx, end, parent)
  }
  if (!crumbs.length) return []
  const name = text(ctx, focus, C.label) ?? 'Breadcrumb'
  if (ctx.modality === MOD.Text) {
    o.renders(el(o, 'root', 'Div', {}, [o.text('line', crumbs.map((c) => labelOf(ctx, c)).join(' › '))]))
    return o.quads
  }
  const last = crumbs.length - 1
  const lis = crumbs.map((crumb, i) => {
    const id = 'c' + hashKey(crumb.value)
    const label = labelOf(ctx, crumb)
    let content: NamedNode
    if (i === last) {
      content = el(o, `${id}-current`, 'Span', { class: 'sem-current' }, [o.text(`${id}-text`, label)])
      o.attr(content, 'aria-current', 'page')
    } else if (navigates) {
      content = el(o, `${id}-link`, 'Button', { type: 'button', class: 'sem-crumb' }, [o.text(`${id}-text`, label)])
      o.t(content, C.selects, crumb)
    } else content = el(o, `${id}-crumb`, 'Span', { class: 'sem-crumb' }, [o.text(`${id}-text`, label)])
    const parts = [content]
    if (i < last) parts.push(el(o, `${id}-sep`, 'Span', { class: 'sem-sep', 'aria-hidden': 'true' }, [o.text(`${id}-sep-text`, '/')]))
    return el(o, id, 'Li', {}, parts)
  })
  const nav = el(o, 'root', 'Nav', {}, [el(o, 'list', 'Ol', {}, lis)])
  o.attr(nav, 'aria-label', name)
  o.renders(nav)
  return o.quads
}

// --- Pagination -----------------------------------------------------------------------------------

/** Page numbers to show, with 0 for an ellipsis: the ends, and the neighbours of the current page. */
export function pageWindow(page: number, pages: number): number[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const keep = new Set([1, pages, page - 1, page, page + 1])
  if (page <= 4) for (let p = 2; p <= 5; p++) keep.add(p)
  if (page >= pages - 3) for (let p = pages - 4; p < pages; p++) keep.add(p)
  const sorted = [...keep].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b)
  const out: number[] = []
  for (const p of sorted) {
    const prev = out[out.length - 1]
    // A gap of one page shows that page; a longer gap is an ellipsis.
    if (prev !== undefined && p - prev === 2) out.push(prev + 1)
    else if (prev !== undefined && p - prev > 2) out.push(0)
    out.push(p)
  }
  return out
}

const pagination: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const pages = Math.max(1, Math.floor(num(ctx, focus, C_PAGES, 1)))
  const page = Math.min(pages, Math.max(1, Math.floor(num(ctx, focus, C_PAGE, 1))))
  const shown = pageWindow(page, pages)
  if (ctx.modality === MOD.Text) {
    const line = ['‹', ...shown.map((p) => (p === 0 ? '…' : p === page ? `[${p}]` : String(p))), '›'].join(' ')
    o.renders(el(o, 'root', 'Div', {}, [o.text('line', line)]))
    return o.quads
  }
  const f = ctx.f
  const go = (el: NamedNode, p: number) => o.t(el, C_GOES_TO, f.literal(String(p), ctx.nn(XSD_INTEGER)))
  const step = (local: string, glyph: string, label: string, to: number) => {
    const disabled = to < 1 || to > pages
    const b = el(o, local, 'Button', { type: 'button', class: 'sem-step', disabled: disabled ? '' : undefined }, [
      el(o, `${local}-icon`, 'Span', { 'aria-hidden': 'true' }, [o.text(`${local}-icon-text`, glyph)]),
    ])
    o.attr(b, 'aria-label', label)
    if (!disabled) go(b, to)
    return el(o, `${local}-li`, 'Li', {}, [b])
  }
  let gaps = 0
  const numbered = shown.map((p) => {
    if (p === 0) {
      const id = `gap${gaps++}`
      return el(o, id, 'Li', { class: 'sem-gap', 'aria-hidden': 'true' }, [o.text(`${id}-text`, '…')])
    }
    const b = el(o, `p${p}`, 'Button', { type: 'button', class: 'sem-page' }, [o.text(`p${p}-text`, String(p))])
    o.attr(b, 'aria-label', `Page ${p}`)
    if (p === page) o.attr(b, 'aria-current', 'page')
    else go(b, p)
    return el(o, `p${p}-li`, 'Li', {}, [b])
  })
  const list = el(o, 'list', 'Ul', {}, [step('prev', '‹', 'Previous page', page - 1), ...numbered, step('next', '›', 'Next page', page + 1)])
  const nav = el(o, 'root', 'Nav', {}, [list])
  o.attr(nav, 'aria-label', text(ctx, focus, C.label) ?? 'Pagination')
  o.renders(nav)
  return o.quads
}

const paginationGo: ReactionFn = (ctx) => {
  const page = marked(ctx, C_GOES_TO)
  if (!page || page.termType !== 'Literal') return NONE
  const f = ctx.runtime.store.factory
  return { remove: ctx.match(ctx.target, C_PAGE, null), add: [f.quad(ctx.target, f.namedNode(C_PAGE), page)] }
}

// --- Stepper ------------------------------------------------------------------------------------

const stepper: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const steps = nodes(ctx, ctx.object(focus, C_STEPS))
  if (!steps.length) return []
  const current = ctx.object(focus, C_CURRENT)
  const at = Math.max(0, steps.findIndex((s) => s.equals(current)))
  const navigable = isTrue(ctx.object(focus, C_NAVIGABLE))
  const stateOf = (i: number) => (i < at ? 'complete' : i === at ? 'current' : 'upcoming')
  if (ctx.modality === MOD.Text) {
    const mark = { complete: '✓', current: '●', upcoming: '○' }
    o.renders(el(o, 'root', 'Div', {}, [o.text('line', steps.map((s, i) => `${mark[stateOf(i)]} ${labelOf(ctx, s)}`).join(' → '))]))
    return o.quads
  }
  const lis = steps.map((s, i) => {
    const id = 's' + hashKey(s.value)
    const state = stateOf(i)
    const label = labelOf(ctx, s)
    const help = text(ctx, s, C.help)
    const marker = el(o, `${id}-marker`, 'Span', { class: 'sem-marker', 'aria-hidden': 'true' }, [o.text(`${id}-marker-text`, state === 'complete' ? '✓' : String(i + 1))])
    const body = el(o, `${id}-body`, 'Span', { class: 'sem-body' }, [
      el(o, `${id}-label`, 'Span', { class: 'sem-label' }, [o.text(`${id}-label-text`, label)]),
      ...(help ? [el(o, `${id}-help`, 'Span', { class: 'sem-help' }, [o.text(`${id}-help-text`, help)])] : []),
    ])
    // Screen readers hear the state the marker shows.
    const status = el(o, `${id}-status`, 'Span', { class: 'sem-visually-hidden' }, [o.text(`${id}-status-text`, state === 'complete' ? ' (completed)' : state === 'current' ? ' (current)' : '')])
    const parts = [marker, body, ...(state === 'current' ? [] : [status])]
    let content: NamedNode
    if (navigable) {
      content = el(o, `${id}-go`, 'Button', { type: 'button', class: 'sem-step' }, parts)
      o.t(content, C.selects, s)
    } else content = el(o, `${id}-step`, 'Div', { class: 'sem-step' }, parts)
    if (state === 'current') o.attr(content, 'aria-current', 'step')
    const li = el(o, id, 'Li', {}, [content])
    o.attr(li, 'data-state', state)
    return li
  })
  const root = el(o, 'root', 'Ol', {}, lis)
  o.attr(root, 'aria-label', text(ctx, focus, C.label) ?? 'Progress')
  o.renders(root)
  return o.quads
}

const stepperGo: ReactionFn = (ctx) => {
  if (!isTrue(ctx.object(ctx.target, C_NAVIGABLE))) return NONE
  const step = marked(ctx, C.selects)
  if (!named(step)) return NONE
  const f = ctx.runtime.store.factory
  return { remove: ctx.match(ctx.target, C_CURRENT, null), add: [f.quad(ctx.target, f.namedNode(C_CURRENT), step)] }
}

export const functions: Record<string, FnRule> = {
  'nav:breadcrumbs': breadcrumbs,
  'nav:pagination': pagination,
  'nav:stepper': stepper,
}

export const reactions: Record<string, ReactionFn> = {
  'nav:pagination-go': paginationGo,
  'nav:stepper-go': stepperGo,
}
