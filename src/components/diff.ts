import type { FnRule } from '../engine/context.ts'
import { C, NS } from '../ns.ts'
import { nodes, RDFS_LABEL, text } from './util.ts'

const change = (value: string | undefined) => value === NS.c + 'DiffAdded' ? ['added', '+']
  : value === NS.c + 'DiffRemoved' ? ['removed', '-'] : ['context', ' ']

const viewScreen: FnRule = (ctx, focus) => {
  const out = ctx.out(focus)
  const lines = nodes(ctx, ctx.object(focus, NS.c + 'items'))
  out.renders(out.el('root', 'Div', { role: 'list', 'aria-label': text(ctx, focus, C.label) ?? 'Text changes' }, lines))
  return out.quads
}

const viewText: FnRule = (ctx, focus) => {
  const out = ctx.out(focus)
  const lines = nodes(ctx, ctx.object(focus, NS.c + 'items'))
  out.renders(out.el('root', 'Div', {}, lines))
  return out.quads
}

const lineScreen: FnRule = (ctx, focus) => {
  const value = ctx.object(focus, C.value)
  if (!value) return []
  const [kind, sign] = change(ctx.object(focus, NS.c + 'diffKind')?.value)
  const status = ctx.object(focus, NS.c + 'diffKind') ?? ctx.nn(NS.c + 'DiffContext')
  const description = `${text(ctx, status, RDFS_LABEL) ?? 'Unchanged'}: ${value.value}`
  const out = ctx.out(focus)
  const marker = out.el('sign', 'Span', { class: 'sem-sign', 'aria-hidden': 'true' }, [out.text('sign-text', sign!)])
  const code = out.el('code', 'Code', {}, [out.text('text', value.value)])
  out.renders(out.el('root', 'Div', { role: 'listitem', 'data-sem-change': kind!, 'aria-label': description }, [marker, code]))
  return out.quads
}

const lineText: FnRule = (ctx, focus) => {
  const value = ctx.object(focus, C.value)
  if (!value) return []
  const [, sign] = change(ctx.object(focus, NS.c + 'diffKind')?.value)
  const out = ctx.out(focus)
  out.renders(out.el('root', 'Div', {}, [out.text('text', `${sign}${value.value}`)]))
  return out.quads
}

export const diffFunctions: Record<string, FnRule> = {
  'diff:view-screen': viewScreen,
  'diff:view-text': viewText,
  'diff:line-screen': lineScreen,
  'diff:line-text': lineText,
}
