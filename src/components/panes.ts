// Function rules and reactions for the panes (ontology/components/panes.ttl): c:SplitView and
// c:DockPanel. Both are sized by one-axis size handles whose beh:Size events the reactions
// turn into graph state (c:ratio; c:height or c:width).
import type { NamedNode, Term } from '@rdfjs/types'
import type { ReactionFn } from '../behaviour/events.ts'
import type { FnRule } from '../engine/context.ts'
import { MOD, NS, SEM, XSD_INTEGER } from '../ns.ts'
import { el } from './data.ts'
import { isTrue, named, nodes, str, text } from './util.ts'

const C = NS.c
const XSD_DECIMAL = NS.xsd + 'decimal'
const DEFAULT_MIN = 120
const DEFAULT_DOCK = 280

/** An integer-valued property, or `fallback` (truncated, as SPARQL's xsd:integer cast does). */
function int(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return value !== undefined && Number.isInteger(n) ? n : fallback
}

// --- SplitView ------------------------------------------------------------------------------------

/**
 * Two panes and a divider (role=separator, a size handle on the primary pane). The primary's
 * share is c:ratio; c:collapsed hides the secondary pane and drops the divider.
 */
const splitView: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const primary = ctx.object(focus, C + 'primary')
  const secondary = ctx.object(focus, C + 'secondary')
  const collapsed = isTrue(ctx.object(focus, C + 'collapsed'))
  if (ctx.modality === MOD.Text) {
    const parts: NamedNode[] = named(primary) ? [primary] : []
    if (!collapsed) parts.push(o.text('divider', '────────'), ...(named(secondary) ? [secondary] : []))
    o.renders(el(o, 'root', 'Div', {}, parts))
    return o.quads
  }
  const raw = Number(str(ctx.object(focus, C + 'ratio')))
  const ratio = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5
  const min = int(str(ctx.object(focus, C + 'minSize')), DEFAULT_MIN)
  const stacked = ctx.object(focus, NS.pos + 'direction')?.value === NS.pos + 'Column'
  const caption = text(ctx, focus, C + 'label')
  const first = o.node('first')
  el(o, 'first', 'Div', { class: 'sem-pane sem-primary', id: first.value }, named(primary) ? [primary] : [])
  const second = el(o, 'second', 'Div', { class: 'sem-pane sem-secondary', hidden: collapsed ? '' : undefined }, named(secondary) ? [secondary] : [])
  const parts = [first]
  if (!collapsed) {
    parts.push(
      el(o, 'divider', 'Div', {
        class: 'sem-divider',
        tabIndex: '0',
        role: 'separator',
        'aria-orientation': stacked ? 'horizontal' : 'vertical',
        'aria-valuenow': String(Math.round(ratio * 100)),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-controls': first.value,
        'aria-label': caption ? `Resize ${caption}` : 'Resize panes',
        'data-sem-gesture': 'size',
        'data-sem-axis': stacked ? 'y' : 'x',
        'data-sem-sizes': 'previous',
        'data-sem-min': String(min),
        'data-sem-step': '24',
      }),
    )
  }
  parts.push(second)
  o.renders(el(o, 'root', 'Div', { style: `--split-ratio: ${ratio}` }, parts))
  return o.quads
}

/** The new size over the room there was, to three places, kept c:minSize from either end (5-95%). */
const splitResize: ReactionFn = (ctx) => {
  const size = Number(str(ctx.object(ctx.event, NS.beh + 'size')))
  const extent = Number(str(ctx.object(ctx.event, NS.beh + 'extent')))
  if (!Number.isFinite(size) || !(extent > 0)) return { add: [], remove: [] }
  const min = int(str(ctx.object(ctx.target, C + 'minSize')), DEFAULT_MIN)
  const lo = Math.min(0.5, Math.max(0.05, Math.round((min * 1000) / extent) / 1000))
  const raw = Math.round((size * 1000) / extent) / 1000
  const ratio = Math.min(1 - lo, Math.max(lo, raw))
  const f = ctx.runtime.store.factory
  return {
    remove: ctx.match(ctx.target, C + 'ratio', null),
    add: [f.quad(ctx.target, f.namedNode(C + 'ratio'), f.literal(String(Math.round(ratio * 1000) / 1000), f.namedNode(XSD_DECIMAL)))],
  }
}

// --- DockPanel ------------------------------------------------------------------------------------

/** The panel's edge slug (bottom when unattached) and whether its size is a width. */
function edgeOf(ctx: { object(s: Term, p: string): Term | undefined }, focus: NamedNode) {
  const node = ctx.object(focus, NS.c + 'attachedTo')
  const edge = (node && str(ctx.object(node, SEM.slug))) ?? 'bottom'
  return { edge, across: edge === 'start' || edge === 'end' }
}

/**
 * A panel attached to an edge of its container: a size handle on its free edge, a header (fold
 * control and title, badge, actions), then toolbar, body and footer, which folding hides.
 */
const dockPanel: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const caption = text(ctx, focus, C + 'label') || undefined
  const open = ctx.object(focus, C + 'expanded')?.value !== 'false'
  const content = ctx.object(focus, C + 'content')
  const toolbar = ctx.object(focus, C + 'toolbar')
  const footer = ctx.object(focus, C + 'footer')
  if (ctx.modality === MOD.Text) {
    const parts: NamedNode[] = [o.text('caption', `═ ${caption ?? ''} ${open ? '▾' : '▸'} ═`)]
    if (open) parts.push(...[toolbar, content, footer].filter(named))
    o.renders(el(o, 'root', 'Div', {}, parts))
    return o.quads
  }
  const { edge, across } = edgeOf(ctx, focus)
  const size = int(str(ctx.object(focus, C + (across ? 'width' : 'height'))), DEFAULT_DOCK)
  const min = int(str(ctx.object(focus, C + 'minSize')), DEFAULT_MIN)
  const badge = ctx.objects(focus, C + 'badge').find((t) => t.termType === 'Literal')
  const actions = nodes(ctx, ctx.object(focus, C + 'actions'))
  const main = o.node('main')
  const fold = el(o, 'fold', 'Button', { type: 'button', class: 'sem-fold', 'aria-expanded': String(open), 'aria-controls': main.value }, [
    el(o, 'chevron', 'Span', { class: 'sem-chevron', 'aria-hidden': 'true' }),
    ...(caption ? [el(o, 'title', 'Strong', {}, [o.text('title-text', caption)])] : []),
  ])
  o.t(fold, C + 'folds', focus)
  const header = el(o, 'header', 'Header', { class: 'sem-dock-header' }, [
    fold,
    ...(badge ? [el(o, 'badge', 'Span', { class: 'sem-dock-badge' }, [o.text('badge-text', badge.value)])] : []),
    ...(actions.length ? [el(o, 'actions', 'Div', { class: 'sem-dock-actions' }, actions)] : []),
  ])
  el(o, 'main', 'Div', { class: 'sem-dock-main', id: main.value, hidden: open ? undefined : '' }, [
    ...(named(toolbar) ? [el(o, 'toolbar', 'Div', { class: 'sem-dock-toolbar' }, [toolbar])] : []),
    el(o, 'body', 'Div', { class: 'sem-dock-body' }, named(content) ? [content] : []),
    ...(named(footer) ? [el(o, 'footer', 'Div', { class: 'sem-dock-footer' }, [footer])] : []),
  ])
  const parts: NamedNode[] = []
  if (open) {
    parts.push(
      el(o, 'handle', 'Div', {
        class: 'sem-dock-handle',
        tabIndex: '0',
        role: 'separator',
        'aria-orientation': across ? 'vertical' : 'horizontal',
        'aria-valuenow': String(size),
        'aria-valuemin': String(min),
        'aria-label': caption ? `Resize ${caption}` : 'Resize panel',
        'data-sem-gesture': 'size',
        'data-sem-axis': across ? 'x' : 'y',
        'data-sem-sign': edge === 'start' || edge === 'top' ? '1' : '-1',
        'data-sem-min': String(min),
      }),
    )
  }
  parts.push(header, main)
  const root = el(o, 'root', 'Section', { style: `--dock-size: ${size}px`, 'data-expanded': String(open) }, parts)
  if (caption) o.attr(root, 'aria-label', caption)
  if (isTrue(ctx.object(focus, C + 'overViewport'))) o.attr(root, 'data-viewport', 'true')
  o.renders(root)
  return o.quads
}

/** The free edge's new size: c:width at the start or end, else c:height; at least c:minSize, at most the room. */
const dockResize: ReactionFn = (ctx) => {
  const raw = Number(str(ctx.object(ctx.event, NS.beh + 'size')))
  if (!Number.isFinite(raw)) return { add: [], remove: [] }
  const extent = Number(str(ctx.object(ctx.event, NS.beh + 'extent')))
  const { across } = edgeOf(ctx, ctx.target)
  const p = C + (across ? 'width' : 'height')
  const min = int(str(ctx.object(ctx.target, C + 'minSize')), DEFAULT_MIN)
  const capped = Number.isFinite(extent) && extent > min && raw > extent ? extent : raw
  const size = Math.trunc(Math.max(min, capped))
  const f = ctx.runtime.store.factory
  return { remove: ctx.match(ctx.target, p, null), add: [f.quad(ctx.target, f.namedNode(p), f.literal(String(size), f.namedNode(XSD_INTEGER)))] }
}

export const functions: Record<string, FnRule> = {
  'panes:split-view': splitView,
  'panes:dock-panel': dockPanel,
}

export const reactions: Record<string, ReactionFn> = {
  'panes:split-resize': splitResize,
  'panes:dock-resize': dockResize,
}
