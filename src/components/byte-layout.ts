import type { Term } from '@rdfjs/types'
import type { FnRule } from '../engine/context.ts'
import { MOD, NS } from '../ns.ts'

const render: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const value = (subject: Term, property: string) => ctx.object(subject, NS.c + property)?.value
  const members = (subject: Term, property: string) => ctx.match(subject, NS.c + property, null).map(({ object }) => object)
  const fields = members(focus, 'byteField').sort((a, b) =>
    Number(value(a, 'byteIndex')) - Number(value(b, 'byteIndex')))
  if (!fields.length) return o.quads

  const total = Number(value(focus, 'byteExtent'))
  const extent = Math.max(704, fields.length * 132)
  const edge = extent + 18
  const width = extent + 36
  const title = value(focus, 'label') ?? ''
  const spanEntries = members(focus, 'byteSpan').map(span => {
    const first = Number(value(span, 'firstByteIndex'))
    const last = Number(value(span, 'lastByteIndex'))
    const label = value(span, 'label') ?? ''
    return [JSON.stringify([first, last, label]), { first, last, label }] as const
  })
  const spans = [...new Map(spanEntries).values()].sort((a, b) =>
    a.first - b.first || a.last - b.last || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  const geometry = fields.map((field, index) => {
    const offset = value(field, 'byteOffset')
    const length = value(field, 'byteLength')
    const point = (position: number) => 18 + Math.floor(position * extent / (total || fields.length))
    const x = point(total ? Number(offset) : index)
    const end = point(total ? Number(offset) + Number(length) : index + 1)
    const sizeLabel = length === undefined ? value(field, 'byteSizeLabel') ?? '…' : length + ' B'
    const encoding = value(field, 'byteEncoding')
    return { x, end, offset, length, detail: encoding === undefined ? sizeLabel : encoding + ' · ' + sizeLabel }
  })

  if (ctx.modality === MOD.Text) {
    const summary = [o.text('caption', title)]
    for (const [index, field] of fields.entries()) {
      const { offset, detail } = geometry[index]!
      const label = value(field, 'label') ?? ''
      const line = (offset === undefined ? '' : '@' + offset + ' · ') + label + ' · ' + detail
      summary.push(o.el(`entry-${index}`, 'P', {}, [o.text(`entry-${index}-text`, line)]))
    }
    o.renders(o.el('root', 'Div', {}, summary))
    return o.quads
  }

  const line = (id: string, label: string, x: number, y: number, className: string, anchor = 'middle') =>
    o.svg(id, 'Text', { x, y, class: className, 'text-anchor': anchor }, [o.text(id + '-text', label)])
  const path = (id: string, d: string, className: string) => o.svg(id, 'Path', { d, class: className })
  const ruler = [
    path('rail', `M18 37H${edge}`, 'rail'),
    line('axis-label', value(focus, 'byteAxisLabel') ?? '', 18, 13, 'axis-label', 'start'),
  ]
  const groups = fields.map((field, index) => {
    const { x, end, offset, length, detail } = geometry[index]!
    const size = end - x
    const id = 'field-' + index
    const label = value(field, 'label') ?? ''
    const isEmphasized = ['true', '1'].includes(value(field, 'byteEmphasis') ?? '')
    const tone = isEmphasized ? 'emphasized' : length === undefined ? 'variable' : 'data'
    const middle = Math.floor((x + end) / 2)
    const children = [
      o.svg(id + '-bar', 'Rect', { x, y: 38, width: size, height: 47, class: tone }),
      path(id + '-tick', `M${x} 30v8`, 'tick'),
      line(id + '-label', label, middle, 59, 'label'),
      line(id + '-meta', detail, middle, 76, 'meta'),
    ]
    if (offset !== undefined) children.push(
      line(id + '-offset', offset, x, 26, 'offset'),
      line(id + '-offset-card', '@' + offset, middle, 25, 'card-offset'),
    )
    if (length === undefined) {
      children.push(path(id + '-break', `M${end - 17} 47l5 -7m1 7l5 -7`, 'continuation'))
    }
    const markEntries = members(field, 'byteMark').map(mark => {
      const at = Number(value(mark, 'byteOffset'))
      const size = Number(value(mark, 'byteLength'))
      return [`${at}:${size}`, { at, size }] as const
    })
    const marks = [...new Map(markEntries).values()].sort((a, b) => a.at - b.at || a.size - b.size)
    for (const mark of marks) {
      const start = (mark.at - Number(offset)) / Number(length)
      const markX = x + Math.floor(start * size)
      const markWidth = Math.floor(Math.min(end - markX, Math.max(2, size * mark.size / Number(length))))
      if (start >= 0 && mark.size > 0 && markWidth > 0) children.push(o.svg(id + '-stripe-' + mark.at + '-' + mark.size,
        'Rect', { x: markX, y: 80, width: markWidth, height: 5, class: 'used' }))
    }
    return o.svg(id, 'G', {}, children)
  })
  const final = geometry.at(-1)!
  const endOffset = total || (Number(final.offset) + Number(final.length))
  const endLabels = Number.isNaN(endOffset) ? [] : [
    path('end-tick', `M${edge} 30v8`, 'tick'),
    line('end-offset', String(endOffset), edge, 26, 'offset'),
  ]
  const brackets = spans.flatMap(({ first, last, label }, index) => {
    if (!geometry[first] || !geometry[last]) return []
    const { x } = geometry[first]
    const { end } = geometry[last]
    return [
      path('bracket-' + index, `M${x} 93v7H${end}v-7`, 'bracket'),
      line('bracket-label-' + index, label, Math.floor((x + end) / 2), 116, 'annotation'),
    ]
  })
  const plot = o.svg('plot', 'Svg', {
    viewBox: `0 0 ${width} ${spans.length ? 122 : 90}`,
    role: 'group', 'aria-label': title,
    style: `min-width:${extent}px`,
  }, [...ruler, ...groups, ...endLabels, ...brackets])
  const style = value(focus, 'byteLayoutStyle')
  const appearance = style === NS.c + 'ByteRecord' ? 'record' : style === NS.c + 'ByteOutline' ? 'outline' : 'ruler'
  o.renders(o.el('root', 'Div', {
    class: 'sem-byte-layout',
    'data-layout-appearance': appearance,
  }, [plot]))
  return o.quads
}

export const functions = { 'byte-layout:render': render }
