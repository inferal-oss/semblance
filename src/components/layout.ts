// Function rules and reactions for the layout components (ontology/components/layout.ttl).
import type { ReactionFn } from '../behaviour/events.ts'
import type { FnRule } from '../engine/context.ts'
import { C, MOD, SEM, STY } from '../ns.ts'
import { labelOf, nodes, str, text } from './util.ts'

/** A titled example: a heading, a description and a stage holding the components shown. */
const specimen: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const title = labelOf(ctx, focus)
  const help = text(ctx, focus, C.help)
  const children = nodes(ctx, ctx.object(focus, C.children))
  if (ctx.modality === MOD.Text) {
    o.renders(o.el('root', 'Div', {}, [o.el('title', 'Div', {}, [o.text('title-text', `## ${title}`)]), ...children]))
    return o.quads
  }
  const header = o.el('header', 'Header', {}, [
    o.el('title', 'H3', {}, [o.text('title-text', title)]),
    ...(help ? [o.el('help', 'P', {}, [o.text('help-text', help)])] : []),
  ])
  o.renders(o.el('root', 'Section', {}, [header, o.el('stage', 'Div', { class: 'sem-stage' }, children)]))
  return o.quads
}

/**
 * The tokens of one scale whose slug starts with c:prefix (e.g. sty:Ramp, "accent-"),
 * as swatches in step order, each showing its value through the token itself.
 */
const swatches: FnRule = (ctx, focus) => {
  const scale = ctx.object(focus, C.of)
  const prefix = str(ctx.object(focus, C.prefix)) ?? ''
  if (!scale) return []
  const step = (slug: string) => Number(slug.slice(prefix.length)) || 0
  const tokens = ctx
    .match(null, STY.scale, scale)
    .map((q) => ({ token: q.subject, slug: str(ctx.object(q.subject, SEM.slug)) ?? '' }))
    .filter((t) => t.slug.startsWith(prefix))
    .sort((a, b) => step(a.slug) - step(b.slug) || (a.slug < b.slug ? -1 : 1))
  const o = ctx.out(focus)
  if (ctx.modality === MOD.Text) {
    o.renders(o.el('root', 'Div', {}, [o.text('line', tokens.map((t) => t.slug).join(' '))]))
    return o.quads
  }
  const items = tokens.map(({ slug }) =>
    o.el('s-' + slug, 'Div', { class: 'sem-swatch' }, [
      o.el('s-' + slug + '-chip', 'Span', { style: `background: var(--sem-${slug})` }),
      o.el('s-' + slug + '-name', 'Code', {}, [o.text('s-' + slug + '-name-text', slug.slice(prefix.length) || slug)]),
    ]),
  )
  const root = o.el('root', 'Div', {}, [o.el('caption', 'Strong', {}, [o.text('caption-text', labelOf(ctx, focus))]), o.el('row', 'Div', { class: 'sem-swatch-row' }, items)])
  o.renders(root)
  return o.quads
}

export const functions: Record<string, FnRule> = { specimen, swatches }

export const reactions: Record<string, ReactionFn> = {}
