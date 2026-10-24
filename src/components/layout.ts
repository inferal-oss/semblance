// Function rules and reactions for the layout components (ontology/components/layout.ttl).
import type { ReactionFn } from '../behaviour/events.ts'
import type { FnRule } from '../engine/context.ts'
import { C, MOD, NS, SEM, STY } from '../ns.ts'
import { labelOf, nodes, str, text } from './util.ts'

const POS_DIRECTION = NS.pos + 'direction'
const POS_COLUMN = NS.pos + 'Column'
const C_COLUMNS = NS.c + 'columns'
const C_MIN_WIDTH = NS.c + 'minWidth'

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

/** A padded container; elevation, tone, inset and gap are style hooks on its root. */
const surface: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const children = nodes(ctx, ctx.object(focus, C.children))
  if (ctx.modality === MOD.Text) {
    o.renders(o.el('root', 'Div', {}, [o.text('top', '┌'), ...children, o.text('bottom', '└')]))
    return o.quads
  }
  o.renders(o.el('root', 'Div', {}, children))
  return o.quads
}

/** A separator: an <hr>, or with a label a separator role whose label sits in the line. */
const divider: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const label = text(ctx, focus, C.label)
  const vertical = ctx.object(focus, POS_DIRECTION)?.value === POS_COLUMN
  if (ctx.modality === MOD.Text) {
    o.renders(o.el('root', vertical ? 'Span' : 'Div', {}, [o.text('line', vertical ? ' │ ' : label ? `──── ${label} ────` : '────────')]))
    return o.quads
  }
  if (label === undefined) {
    const root = o.el('root', 'Hr')
    if (vertical) o.attr(root, 'aria-orientation', 'vertical')
    o.renders(root)
    return o.quads
  }
  const root = o.el('root', 'Div', {}, [o.el('label', 'Span', { class: 'sem-label' }, [o.text('label-text', label)])])
  o.attr(root, 'role', 'separator')
  o.attr(root, 'aria-label', label)
  if (vertical) o.attr(root, 'aria-orientation', 'vertical')
  o.renders(root)
  return o.quads
}

const CSS_LENGTH = /^\d+(\.\d+)?(px|rem|em|ch|vw|%)$/

/**
 * Tiles of equal width. The grid's parameters reach the theme as custom
 * properties (--grid-min, --grid-columns) on its root; the theme lays it out.
 */
const grid: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const children = nodes(ctx, ctx.object(focus, C.children))
  if (ctx.modality === MOD.Text) {
    o.renders(o.el('root', 'Div', {}, children))
    return o.quads
  }
  const columns = Math.round(Number(str(ctx.object(focus, C_COLUMNS))))
  const min = str(ctx.object(focus, C_MIN_WIDTH))?.trim()
  const vars = [
    ...(min && CSS_LENGTH.test(min) ? [`--grid-min: ${min}`] : []),
    ...(columns >= 1 && columns <= 24 ? [`--grid-columns: ${columns}`] : []),
  ]
  const root = o.el('root', 'Div', { style: vars.length ? vars.join('; ') : undefined }, children)
  if (columns >= 1 && columns <= 24) o.attr(root, 'data-columns', String(columns))
  o.renders(root)
  return o.quads
}

/** Space that grows to push its neighbours apart. */
const spacer: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const root = o.el('root', ctx.modality === MOD.Text ? 'Span' : 'Div')
  if (ctx.modality !== MOD.Text) o.attr(root, 'aria-hidden', 'true')
  o.renders(root)
  return o.quads
}

export const functions: Record<string, FnRule> = { specimen, swatches, surface, divider, grid, spacer }

export const reactions: Record<string, ReactionFn> = {}
