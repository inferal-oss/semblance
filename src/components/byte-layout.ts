// c:ByteLayout's function twins (ontology/components/byte-layout.ttl): the frame, the member-wise
// fields (a c:ByteCell each) and brackets, and a cell's drawing. Each says, byte for byte, what its
// SPARQL rule says.
import type { NamedNode, Term } from '@rdfjs/types'
import type { FnRule, RuleContext } from '../engine/context.ts'
import { MOD, NS, RDF_TYPE, SEM } from '../ns.ts'
import { encodeForUri, isTrue, text } from './util.ts'

const C = (local: string) => NS.c + local
const H = (local: string) => NS.rdfhtml + local
const value = (ctx: RuleContext, subject: Term, local: string) => ctx.object(subject, C(local))?.value
const num = (ctx: RuleContext, subject: Term, local: string) => {
  const v = value(ctx, subject, local)
  return v === undefined ? undefined : Number(v)
}
const label = (ctx: RuleContext, node: Term) => text(ctx, node, C('label')) ?? ''

/** 132 units a field, at least 528; 18 on each side. */
const extentOf = (count: number) => Math.max(528, count * 132)
const fieldsOf = (ctx: RuleContext, layout: Term) => ctx.match(layout, C('byteField'), null).map((q) => q.object)
/** Where a position (an offset with an extent, else an index) falls on the strip. */
const point = (extent: number, total: number | undefined, count: number, position: number) =>
  18 + Math.floor(total === undefined ? (position * extent) / count : (extent * position) / total)

/** A field's line: "@offset · label · encoding · size", its Text and its name on screen. */
function spoken(ctx: RuleContext, field: Term) {
  const offset = value(ctx, field, 'byteOffset')
  const length = value(ctx, field, 'byteLength')
  const encoding = value(ctx, field, 'byteEncoding')
  const unit = text(ctx, ctx.nn(C('BytesPhrase')), NS.rdfs + 'label') ?? ''
  const detail = length === undefined ? (value(ctx, field, 'byteSizeLabel') ?? '…') : length + ' ' + unit
  const metadata = encoding === undefined ? detail : encoding + ' · ' + detail
  return { offset, length, metadata, line: (offset === undefined ? '' : '@' + offset + ' · ') + label(ctx, field) + ' · ' + metadata }
}

/** An SVG element whose attributes are expanded (<local>-a-<name>), placed by an order key. */
function svg(o: ReturnType<RuleContext['out']>, local: string, cls: string, attrs: Record<string, string | number>, key?: string) {
  const n = o.svg(local, cls, attrs)
  if (key !== undefined) o.t(n, SEM.orderKey, key)
  return n
}
function textEl(o: ReturnType<RuleContext['out']>, local: string, data: string, attrs: Record<string, string | number>, key: string) {
  const n = svg(o, local, 'Text', attrs, key)
  o.t(n, H('hasChild'), o.text(local + '-text', data))
  return n
}

const render: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const count = fieldsOf(ctx, focus).length
  if (!count) return o.quads
  const title = text(ctx, focus, C('label')) ?? ''
  const root = o.node('root')
  const fields = o.node('fields')
  if (ctx.modality === MOD.Text) {
    o.t(root, RDF_TYPE, ctx.nn(H('Div')))
    const caption = o.text('caption', title)
    o.t(caption, SEM.orderKey, '\u0001n0')
    o.t(fields, RDF_TYPE, ctx.nn(H('Div'))).t(fields, SEM.orderKey, '\u0001n1')
    o.t(root, H('hasChild'), caption).t(root, H('hasChild'), fields)
    o.renders(root)
    return o.quads
  }
  const extent = extentOf(count)
  const style = value(ctx, focus, 'byteLayoutStyle')
  const appearance = style === C('ByteRecord') ? 'record' : style === C('ByteOutline') ? 'outline' : 'ruler'
  const spans = ctx.match(focus, C('byteSpan'), null).length
  const plot = svg(o, 'plot', 'Svg', {
    viewBox: `0 0 ${extent + 36} ${spans ? 122 : 90}`,
    style: `min-width:${extent}px`,
    role: 'figure',
    'aria-label': title,
  })
  const rail = svg(o, 'rail', 'Path', { d: `M18 37H${extent + 18}`, class: 'rail' }, '\u0001n0')
  const axis = textEl(o, 'axis', value(ctx, focus, 'byteAxisLabel') ?? '', { x: 18, y: 13, class: 'axis-label', 'text-anchor': 'start' }, '\u0001n1')
  svg(o, 'fields', 'G', { role: 'list' }, '\u0001n2')
  for (const child of [rail, axis, fields]) o.t(plot, H('hasChild'), child)
  o.t(root, RDF_TYPE, ctx.nn(H('Div'))).t(root, H('class'), 'sem-byte-layout').t(root, H('hasChild'), plot)
  o.attr(root, 'data-layout-appearance', appearance)
  o.renders(root)
  return o.quads
}
render.watches = () => new Set([RDF_TYPE, C('label'), NS.l10n + 'label', C('byteField'), C('byteSpan'), C('byteLayoutStyle'), C('byteAxisLabel')])

/** One c:ByteCell per field, in the list of fields by its index. */
const field: FnRule = (ctx, focus, member) => {
  if (!member || member.termType !== 'NamedNode') return []
  const index = value(ctx, member, 'byteIndex')
  if (index === undefined) return []
  const o = ctx.out(focus)
  const cell = o.node('field-' + encodeForUri(member.value))
  o.t(cell, RDF_TYPE, ctx.nn(C('ByteCell'))).t(cell, C('of'), member).t(cell, C('inLayout'), focus)
  o.t(cell, SEM.orderKey, `\u0001n${index}\u0001s${member.value}`)
  o.t(o.node('fields'), H('hasChild'), cell)
  return o.quads
}
field.watches = () => new Set([RDF_TYPE])

/** A field's drawing (Screen) or its line (Text). */
const cell: FnRule = (ctx, focus) => {
  const of = ctx.object(focus, C('of'))
  const layout = ctx.object(focus, C('inLayout')) as NamedNode | undefined
  if (!of || !layout || value(ctx, of, 'byteIndex') === undefined) return []
  const o = ctx.out(focus)
  const { offset, length, metadata, line } = spoken(ctx, of)
  const root = o.node('root')
  if (ctx.modality === MOD.Text) {
    o.t(root, RDF_TYPE, ctx.nn(H('P'))).t(root, H('hasChild'), o.text('line', line))
    o.renders(root)
    return o.quads
  }
  const index = Number(value(ctx, of, 'byteIndex'))
  const count = fieldsOf(ctx, layout).length
  const total = num(ctx, layout, 'byteExtent')
  const extent = extentOf(count)
  const edge = extent + 18
  const x = point(extent, total, count, total === undefined ? index : Number(offset))
  const end = point(extent, total, count, total === undefined ? index + 1 : Number(offset) + Number(length))
  if (Number.isNaN(x) || Number.isNaN(end)) return []
  const size = end - x
  const middle = Math.floor((x + end) / 2)
  const tone = isTrue(ctx.object(of, C('byteEmphasis'))) ? 'emphasized' : length === undefined ? 'variable' : 'data'
  const children = [
    svg(o, 'bar', 'Rect', { x, y: 38, width: size, height: 47, class: tone }, '\u0001n0'),
    svg(o, 'tick', 'Path', { d: `M${x} 30v8`, class: 'tick' }, '\u0001n1'),
    textEl(o, 'label', label(ctx, of), { x: middle, y: 59, class: 'label', 'text-anchor': 'middle' }, '\u0001n2'),
    textEl(o, 'meta', metadata, { x: middle, y: 76, class: 'meta', 'text-anchor': 'middle' }, '\u0001n3'),
  ]
  if (offset !== undefined) children.push(
    textEl(o, 'offset', offset, { x, y: 26, class: 'offset', 'text-anchor': 'middle' }, '\u0001n4'),
    textEl(o, 'card', '@' + offset, { x: middle, y: 25, class: 'card-offset', 'text-anchor': 'middle' }, '\u0001n5'),
  )
  if (length === undefined) children.push(svg(o, 'break', 'Path', { d: `M${end - 17} 47l5 -7m1 7l5 -7`, class: 'continuation' }, '\u0001n6'))
  const seen = new Set<string>()
  for (const { object: mark } of ctx.match(of, C('byteMark'), null)) {
    const at = num(ctx, mark, 'byteOffset')
    const span = num(ctx, mark, 'byteLength')
    if (at === undefined || span === undefined || seen.has(at + '-' + span)) continue
    seen.add(at + '-' + span)
    const markX = x + Math.floor(((at - Number(offset)) * size) / Number(length))
    const markWidth = Math.floor(Math.min(end - markX, Math.max(2, (size * span) / Number(length))))
    if (at >= Number(offset) && span > 0 && markWidth > 0)
      children.push(svg(o, `stripe-${at}-${span}`, 'Rect', { x: markX, y: 80, width: markWidth, height: 5, class: 'used' }, `\u0001n7\u0001n${at}\u0001n${span}`))
  }
  const last = index + 1 === count && (total !== undefined || (offset !== undefined && length !== undefined))
  if (last) children.push(
    svg(o, 'end-tick', 'Path', { d: `M${edge} 30v8`, class: 'tick' }, '\u0001n8\u0001n0'),
    textEl(o, 'end', String(total ?? Number(offset) + Number(length)), { x: edge, y: 26, class: 'offset', 'text-anchor': 'middle' }, '\u0001n8\u0001n1'),
  )
  o.t(root, RDF_TYPE, ctx.nn(NS.svg + 'G'))
  for (const child of children) o.t(root, H('hasChild'), child)
  o.attr(root, 'role', 'listitem')
  o.attr(root, 'aria-label', line)
  o.renders(root)
  return o.quads
}

/** A bracket under the fields from its first to its last index, with its label. */
const span: FnRule = (ctx, focus, member) => {
  if (!member || member.termType !== 'NamedNode') return []
  const first = value(ctx, member, 'firstByteIndex')
  const last = value(ctx, member, 'lastByteIndex')
  if (first === undefined || last === undefined) return []
  const fields = fieldsOf(ctx, focus)
  const at = (index: string) => fields.find((f) => value(ctx, f, 'byteIndex') === index)
  const from = at(first)
  const to = at(last)
  if (!from || !to) return []
  const count = fields.length
  const total = num(ctx, focus, 'byteExtent')
  const extent = extentOf(count)
  const x = point(extent, total, count, total === undefined ? Number(first) : Number(value(ctx, from, 'byteOffset')))
  const end = point(extent, total, count, total === undefined ? Number(last) + 1 : Number(value(ctx, to, 'byteOffset')) + Number(value(ctx, to, 'byteLength')))
  if (Number.isNaN(x) || Number.isNaN(end)) return []
  const o = ctx.out(focus)
  const local = 'span-' + encodeForUri(member.value)
  const group = svg(o, local, 'G', {}, `\u0001n3\u0001n${first}\u0001n${last}\u0001s${member.value}`)
  const bracket = svg(o, local + '-bracket', 'Path', { d: `M${x} 93v7H${end}v-7`, class: 'bracket' }, '\u0001n0')
  const caption = textEl(o, local + '-caption', label(ctx, member), { x: Math.floor((x + end) / 2), y: 116, class: 'annotation', 'text-anchor': 'middle' }, '\u0001n1')
  o.t(group, H('hasChild'), bracket).t(group, H('hasChild'), caption)
  o.t(o.node('plot'), H('hasChild'), group)
  return o.quads
}
span.watches = () => new Set([RDF_TYPE, C('byteField'), C('byteExtent'), C('byteIndex'), C('byteOffset'), C('byteLength')])

export const functions = {
  'byte-layout:render': render,
  'byte-layout:field': field,
  'byte-layout:cell': cell,
  'byte-layout:span': span,
}
