// c:ByteLayout's function twins (ontology/components/byte-layout.ttl): the frame, the member-wise
// fields (a c:ByteCell each) and brackets, and a cell's drawing, as one SVG strip or, for a wrapping
// schematic, as fields flowing in rows. Each says, byte for byte, what its SPARQL rule says.
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
/** A wrapping schematic: c:byteWrap true and no c:byteExtent. Its fields flow in rows (HTML), not one strip. */
const flows = (ctx: RuleContext, layout: Term) => isTrue(ctx.object(layout, C('byteWrap'))) && ctx.object(layout, C('byteExtent')) === undefined

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
  if (flows(ctx, focus)) return []
  const extent = extentOf(count)
  const appearance = appearanceOf(ctx, focus)
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
render.watches = () => new Set([RDF_TYPE, C('label'), NS.l10n + 'label', C('byteField'), C('byteSpan'), C('byteLayoutStyle'), C('byteAxisLabel'), C('byteWrap'), C('byteExtent')])

function appearanceOf(ctx: RuleContext, layout: Term) {
  const style = value(ctx, layout, 'byteLayoutStyle')
  return style === C('ByteRecord') ? 'record' : style === C('ByteOutline') ? 'outline' : 'ruler'
}

/** A field's nested layout (c:byteDetail), when its layout flows and the detail does not lead back to it. */
function detailOf(ctx: RuleContext, field: Term, layout: Term): NamedNode | undefined {
  if (!flows(ctx, layout)) return undefined
  for (const child of ctx.objects(field, C('byteDetail'))) {
    if (child.termType !== 'NamedNode' || !ctx.match(child, RDF_TYPE, ctx.nn(C('ByteLayout'))).length) continue
    // (c:byteField/c:byteDetail)* from the detail must not reach the layout.
    const stack: Term[] = [child]
    const seen = new Set<string>()
    let cycle = false
    while (stack.length && !cycle) {
      const current = stack.pop()!
      if (current.equals(layout)) cycle = true
      else if (!seen.has(current.value)) {
        seen.add(current.value)
        for (const member of fieldsOf(ctx, current)) stack.push(...ctx.objects(member, C('byteDetail')))
      }
    }
    if (!cycle) return child
  }
  return undefined
}

/** The frame of a wrapping schematic: a figure with its axis label and the list its fields flow in. */
const flow: FnRule = (ctx, focus) => {
  if (!flows(ctx, focus) || !fieldsOf(ctx, focus).length) return []
  const o = ctx.out(focus)
  const root = o.node('root')
  const plot = o.node('plot')
  const fields = o.node('fields')
  o.t(root, RDF_TYPE, ctx.nn(H('Div'))).t(root, H('class'), 'sem-byte-layout').t(root, H('hasChild'), plot)
  o.attr(root, 'data-layout-appearance', appearanceOf(ctx, focus))
  o.attr(root, 'data-byte-wrap', 'true')
  o.t(plot, RDF_TYPE, ctx.nn(H('Div'))).t(plot, H('hasChild'), fields)
  o.attr(plot, 'role', 'figure')
  o.attr(plot, 'aria-label', text(ctx, focus, C('label')) ?? '')
  const axisLabel = value(ctx, focus, 'byteAxisLabel')
  if (axisLabel !== undefined) {
    const axis = o.node('axis')
    o.t(axis, RDF_TYPE, ctx.nn(H('P'))).t(axis, H('class'), 'axis-label').t(axis, SEM.orderKey, '\u0001n1')
    o.t(axis, H('hasChild'), o.text('axis-text', axisLabel))
    o.t(plot, H('hasChild'), axis)
  }
  o.t(fields, RDF_TYPE, ctx.nn(H('Div'))).t(fields, SEM.orderKey, '\u0001n2')
  o.attr(fields, 'role', 'list')
  o.renders(root)
  return o.quads
}
flow.watches = () => new Set([RDF_TYPE, C('label'), NS.l10n + 'label', C('byteField'), C('byteLayoutStyle'), C('byteAxisLabel'), C('byteWrap'), C('byteExtent')])

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
    const nested = detailOf(ctx, of, layout)
    const lineNode = o.text('line', line)
    o.t(lineNode, SEM.orderKey, '\u0001n0')
    o.t(root, RDF_TYPE, ctx.nn(H(nested ? 'Div' : 'P'))).t(root, H('hasChild'), lineNode)
    if (nested) {
      const box = o.node('detail')
      o.t(box, RDF_TYPE, ctx.nn(H('Div'))).t(box, SEM.orderKey, '\u0001n1').t(box, H('hasChild'), nested)
      o.t(root, H('hasChild'), box)
    }
    o.renders(root)
    return o.quads
  }
  if (flows(ctx, layout)) return []
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
  if (first === undefined || last === undefined || flows(ctx, focus)) return []
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
span.watches = () => new Set([RDF_TYPE, C('byteField'), C('byteExtent'), C('byteWrap'), C('byteIndex'), C('byteOffset'), C('byteLength')])

/** An HTML element of class `cls` with its class attribute and order key. */
function el(ctx: RuleContext, o: ReturnType<RuleContext['out']>, local: string, cls: string, className: string | undefined, key?: string) {
  const n = o.node(local)
  o.t(n, RDF_TYPE, ctx.nn(H(cls)))
  if (className !== undefined) o.t(n, H('class'), className)
  if (key !== undefined) o.t(n, SEM.orderKey, key)
  return n
}
function textSpan(ctx: RuleContext, o: ReturnType<RuleContext['out']>, local: string, className: string, data: string, key?: string) {
  const n = el(ctx, o, local, 'Span', className, key)
  o.t(n, H('hasChild'), o.text(local + '-text', data))
  return n
}

/** A field of a wrapping schematic: its offsets, its box and the place of its brackets' segments. */
const flowCell: FnRule = (ctx, focus) => {
  const of = ctx.object(focus, C('of'))
  const layout = ctx.object(focus, C('inLayout')) as NamedNode | undefined
  if (!of || !layout || !flows(ctx, layout)) return []
  const indexValue = value(ctx, of, 'byteIndex')
  if (indexValue === undefined) return []
  const o = ctx.out(focus)
  const { offset, length, metadata, line } = spoken(ctx, of)
  const index = Number(indexValue)
  const count = fieldsOf(ctx, layout).length
  const nested = detailOf(ctx, of, layout)
  const root = o.node('root')
  o.t(root, RDF_TYPE, ctx.nn(H('Div')))
  o.attr(root, 'role', 'listitem')
  o.attr(root, 'aria-label', line)
  if (nested) o.attr(root, 'data-byte-detail', '')
  const ruler = el(ctx, o, 'ruler', 'Div', 'ruler', '\u0001n0')
  if (offset !== undefined) {
    o.t(ruler, H('hasChild'), textSpan(ctx, o, 'offset', 'offset', offset, '\u0001n0'))
    o.t(ruler, H('hasChild'), textSpan(ctx, o, 'card', 'card-offset', '@' + offset, '\u0001n1'))
  }
  if (index + 1 === count && offset !== undefined && length !== undefined)
    o.t(ruler, H('hasChild'), textSpan(ctx, o, 'end', 'end', String(Number(offset) + Number(length)), '\u0001n2'))
  const tone = isTrue(ctx.object(of, C('byteEmphasis'))) ? 'emphasized' : length === undefined ? 'variable' : 'data'
  const bar = el(ctx, o, 'bar', 'Div', 'bar ' + tone, '\u0001n1')
  o.t(bar, H('hasChild'), textSpan(ctx, o, 'label', 'label', label(ctx, of), '\u0001n0'))
  o.t(bar, H('hasChild'), textSpan(ctx, o, 'meta', 'meta', metadata, '\u0001n1'))
  if (length === undefined) {
    const brk = el(ctx, o, 'break', 'Span', 'continuation', '\u0001n6')
    o.attr(brk, 'aria-hidden', 'true')
    o.t(bar, H('hasChild'), brk)
  }
  if (offset !== undefined && length !== undefined && Number(length) > 0) {
    for (const { object: mark } of ctx.match(of, C('byteMark'), null)) {
      const at = num(ctx, mark, 'byteOffset')
      const width = num(ctx, mark, 'byteLength')
      if (at === undefined || width === undefined) continue
      if (!(at >= Number(offset) && at < Number(offset) + Number(length) && width > 0)) continue
      const stripe = el(ctx, o, `stripe-${at}-${width}`, 'Span', 'used', `\u0001n7\u0001n${at}\u0001n${width}`)
      o.attr(stripe, 'style', `--at:${at - Number(offset)};--span:${width};--of:${length}`)
      o.t(bar, H('hasChild'), stripe)
    }
  }
  if (nested) o.t(bar, H('hasChild'), el(ctx, o, 'detail', 'Div', 'detail', '\u0001n9')).t(o.node('detail'), H('hasChild'), nested)
  const brackets = el(ctx, o, 'brackets', 'Div', 'brackets', '\u0001n2')
  for (const child of [ruler, bar, brackets]) o.t(root, H('hasChild'), child)
  o.renders(root)
  return o.quads
}

/** A bracket's segments in a wrapping schematic: one in each field it covers, the first with its label. */
const flowSpan: FnRule = (ctx, focus, member) => {
  if (!member || member.termType !== 'NamedNode' || !flows(ctx, focus)) return []
  const first = value(ctx, member, 'firstByteIndex')
  const last = value(ctx, member, 'lastByteIndex')
  if (first === undefined || last === undefined) return []
  const o = ctx.out(focus)
  const local = 'span-' + encodeForUri(member.value)
  for (const field of fieldsOf(ctx, focus)) {
    const index = value(ctx, field, 'byteIndex')
    if (index === undefined || Number(index) < Number(first) || Number(index) > Number(last)) continue
    const at = Number(index) === Number(first)
    const segment = el(ctx, o, `${local}-${index}`, 'Div', 'bracket' + (at ? ' start' : '') + (Number(index) === Number(last) ? ' end' : ''),
      `\u0001n${first}\u0001n${last}\u0001s${member.value}`)
    if (at) o.t(segment, H('hasChild'), textSpan(ctx, o, `${local}-${index}-caption`, 'annotation', label(ctx, member)))
    o.t(ctx.nn(`${focus.value}/~field-${encodeForUri(field.value)}/~brackets`), H('hasChild'), segment)
  }
  return o.quads
}
flowSpan.watches = () => new Set([RDF_TYPE, C('byteField'), C('byteExtent'), C('byteWrap'), C('byteIndex')])

export const functions = {
  'byte-layout:render': render,
  'byte-layout:field': field,
  'byte-layout:cell': cell,
  'byte-layout:span': span,
  'byte-layout:flow': flow,
  'byte-layout:flow-cell': flowCell,
  'byte-layout:flow-span': flowSpan,
}
