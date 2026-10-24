// Function rules for windows and progress bars.
import type { NamedNode, Term } from '@rdfjs/types'
import type { FnRule, RuleContext } from '../engine/context.ts'
import { C, MOD } from '../ns.ts'
import { text } from './util.ts'

const str = (t: Term | undefined) => t?.value
const int = (ctx: RuleContext, s: Term, p: string, fallback: number) => {
  const v = Number(str(ctx.object(s, p)))
  return Number.isFinite(v) ? Math.round(v) : fallback
}

/** Default geometry, staggered by the window's position among its siblings. */
const STAGGER = 28

export const window: FnRule = (ctx, focus) => {
  const body = ctx.object(focus, C.body)
  const title = text(ctx, focus, C.title) ?? 'Window'
  const o = ctx.out(focus)
  if (ctx.modality === MOD.Text) {
    o.renders(o.el('root', 'Div', {}, [o.el('title', 'Div', {}, [o.text('title-text', `┌ ${title} ┐`)]), ...(body?.termType === 'NamedNode' ? [body] : [])]))
    return o.quads
  }
  const index = int(ctx, focus, C.index, 0)
  const x = int(ctx, focus, C.x, 96 + index * STAGGER)
  const y = int(ctx, focus, C.y, 120 + index * STAGGER)
  const width = int(ctx, focus, C.width, 520)
  const height = int(ctx, focus, C.height, 440)
  const control = (local: string, label: string, aria: string) => {
    const b = o.el(local, 'Button', { type: 'button', class: 'sem-window-control' }, [o.text(local + '-text', label)])
    o.attr(b, 'aria-label', aria)
    o.t(b, C.docks, focus)
    return b
  }
  const bar = o.el('bar', 'Header', { class: 'sem-window-bar' }, [
    o.el('title', 'Strong', {}, [o.text('title-text', title)]),
    control('dock', '⇲', `Dock ${title} back into its tab`),
    control('close', '✕', `Close ${title} (returns it to its tab)`),
  ])
  o.attr(bar, 'data-sem-gesture', 'move')
  const content = o.el('body', 'Div', { class: 'sem-window-body' }, body?.termType === 'NamedNode' ? [body] : [])
  const grip = o.el('grip', 'Div', { class: 'sem-window-grip' })
  o.attr(grip, 'data-sem-gesture', 'resize').attr(grip, 'aria-hidden', 'true')
  const root = o.el('root', 'Section', { style: `left: ${x}px; top: ${y}px; width: ${width}px; height: ${height}px;` }, [bar, content, grip])
  o.attr(root, 'role', 'dialog').attr(root, 'aria-label', title)
  o.renders(root)
  return o.quads
}

export const progress: FnRule = (ctx, focus) => {
  const value = Number(str(ctx.object(focus, C.value)) ?? 0)
  const max = Number(str(ctx.object(focus, C.max)) ?? 1) || 1
  const label = text(ctx, focus, C.label) ?? ''
  const active = str(ctx.object(focus, C.active)) === 'true'
  const share = Math.max(0, Math.min(1, value / max))
  const o = ctx.out(focus)
  if (ctx.modality === MOD.Text) {
    const n = 20
    const done = Math.round(share * n)
    o.renders(o.el('root', 'Div', {}, [o.text('line', `[${'#'.repeat(done)}${'-'.repeat(n - done)}] ${label}`)]))
    return o.quads
  }
  const track = o.el('track', 'Span', { class: 'sem-track' }, [o.el('fill', 'I', { class: 'sem-fill' })])
  const status = o.el('status', 'Span', { class: 'sem-status' }, [o.text('status-text', label)])
  const root = o.el('root', 'Div', { hidden: active ? undefined : '', style: `--sem-progress: ${(share * 100).toFixed(1)}%` }, [track, status])
  o.attr(root, 'role', 'progressbar')
    .attr(root, 'aria-valuemin', '0')
    .attr(root, 'aria-valuemax', String(max))
    .attr(root, 'aria-valuenow', String(value))
    .attr(root, 'aria-valuetext', label)
  o.renders(root)
  return o.quads
}

/** Places the windows other components asked to put here (c:hosts). */
export const desktop: FnRule = (ctx, focus) => {
  const windows = ctx.objects(focus, C.hosts).filter((t): t is NamedNode => t.termType === 'NamedNode')
  const o = ctx.out(focus)
  o.renders(o.el('root', 'Div', {}, windows.sort((a, b) => (a.value < b.value ? -1 : 1))))
  return o.quads
}

export const containerFunctions: Record<string, FnRule> = { window, progress, desktop }

export type { NamedNode }
