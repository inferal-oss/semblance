// Function rules and reactions for the feedback components (ontology/components/feedback.ttl).
import type { ReactionFn } from '../behaviour/events.ts'
import type { FnRule } from '../engine/context.ts'
import { C, MOD, STY } from '../ns.ts'
import { labelOf, nodes, text } from './util.ts'

/** A short status label. Tone and emphasis come from the style layer (sty:tone, sty:emphasis). */
const badge: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const label = labelOf(ctx, focus)
  const icon = text(ctx, focus, C.icon)
  if (ctx.modality === MOD.Text) {
    o.renders(o.el('root', 'Span', {}, [o.text('label', `[${icon ? icon + ' ' : ''}${label}]`)]))
    return o.quads
  }
  const parts = [...(icon ? [o.el('icon', 'Span', { class: 'sem-icon', 'aria-hidden': 'true' }, [o.text('icon-text', icon)])] : []), o.text('label', label)]
  o.renders(o.el('root', 'Span', {}, parts))
  return o.quads
}

/** Default glyph per tone, when an alert names none. */
const TONE_ICONS: Record<string, string> = { info: 'ℹ', success: '✓', warning: '!', danger: '✕', accent: '✦', neutral: '•' }

/**
 * A message that stands out from the page: a title (c:label), a body (c:help), an
 * icon and optional actions (c:children). Danger alerts are announced (role=alert);
 * others are polite status messages.
 */
const alert: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const title = text(ctx, focus, C.label)
  const body = text(ctx, focus, C.help)
  const tone = ctx.object(focus, STY.tone)
  const toneSlug = tone ? (ctx.object(tone, 'https://semblance.dev/ns/core#slug')?.value ?? 'neutral') : 'neutral'
  const icon = text(ctx, focus, C.icon) ?? TONE_ICONS[toneSlug] ?? '•'
  const actions = nodes(ctx, ctx.object(focus, C.children))
  if (ctx.modality === MOD.Text) {
    o.renders(o.el('root', 'Div', {}, [o.text('line', `${icon} ${[title, body].filter(Boolean).join(' — ')}`), ...actions]))
    return o.quads
  }
  const content = o.el('content', 'Div', { class: 'sem-content' }, [
    ...(title ? [o.el('title', 'Strong', {}, [o.text('title-text', title)])] : []),
    ...(body ? [o.el('body', 'P', {}, [o.text('body-text', body)])] : []),
  ])
  const parts = [o.el('icon', 'Span', { class: 'sem-icon', 'aria-hidden': 'true' }, [o.text('icon-text', icon)]), content]
  if (actions.length) parts.push(o.el('actions', 'Div', { class: 'sem-actions' }, actions))
  const root = o.el('root', 'Div', {}, parts)
  o.attr(root, 'role', toneSlug === 'danger' ? 'alert' : 'status')
  o.renders(root)
  return o.quads
}

export const functions: Record<string, FnRule> = { badge, alert }

export const reactions: Record<string, ReactionFn> = {}
