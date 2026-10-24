// Function rules and reactions for the data components (ontology/components/data.ttl).
import type { NamedNode, Term } from '@rdfjs/types'
import type { ReactionContext, ReactionFn } from '../behaviour/events.ts'
import type { Attrs, FnRule, Out, RuleContext } from '../engine/context.ts'
import { BEH, C, H, MOD, NS, RDF_TYPE, SEM, XSD_BOOLEAN } from '../ns.ts'
import { isTrue, labelOf, named, nodes, num, str, text } from './util.ts'

const C_QUERY = NS.c + 'query'
const C_COLUMNS = NS.c + 'tableColumns'
const C_VARIABLE = NS.c + 'variable'
const C_ALIGN = NS.c + 'align'
const C_FORMAT = NS.c + 'format'
const C_SORT_COLUMN = NS.c + 'sortColumn'
const C_SORT_DESCENDING = NS.c + 'sortDescending'
const C_SORTS = NS.c + 'sorts'
const C_ITEMS = NS.c + 'items'
const C_DELTA = NS.c + 'delta'
const C_DELTA_UNIT = NS.c + 'deltaUnit'
const C_LOWER_IS_BETTER = NS.c + 'lowerIsBetter'
const C_IMAGE = NS.c + 'image'
const C_TIMELINE_ITEM = NS.c + 'TimelineItem'
const C_PARENT_PROPERTY = NS.c + 'parentProperty'
const C_EXPANDED = NS.c + 'expandedNode'
const C_DETAIL_PROPERTY = NS.c + 'detailProperty'
const C_TOGGLES = NS.c + 'expands'

/** A short, stable key for an IRI or a value (FNV-1a, base 36). */
export function hashKey(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** The viewer's first language that Intl knows, else en-US. */
const locale = (ctx: RuleContext) => ctx.memo('data:locale:' + ctx.languages.join(','), () => {
  try {
    return Intl.NumberFormat.supportedLocalesOf(ctx.languages)[0] ?? 'en-US'
  } catch {
    return 'en-US'
  }
})
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const isNumeric = (t: Term | undefined) => t?.termType === 'Literal' && NUMERIC.test(t.value)

/** A number written for the viewer's locale (grouped; at most `digits` decimals). */
function formatNumber(ctx: RuleContext, n: number, digits = 2): string {
  try {
    return new Intl.NumberFormat(locale(ctx), { maximumFractionDigits: digits }).format(n)
  } catch {
    return String(n)
  }
}

/** A value as text: IRIs by their label, numbers grouped, others as they are. */
function display(ctx: RuleContext, t: Term | undefined, format?: string): string {
  if (!t) return ''
  if (t.termType === 'NamedNode') return labelOf(ctx, t)
  if (t.termType !== 'Literal') return t.value
  const n = Number(t.value)
  switch (format) {
    case 'number':
      return Number.isFinite(n) ? formatNumber(ctx, n, 0) : t.value
    case 'decimal':
      return Number.isFinite(n) ? new Intl.NumberFormat(locale(ctx), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) : t.value
    case 'percent':
      return Number.isFinite(n) ? new Intl.NumberFormat(locale(ctx), { style: 'percent', maximumFractionDigits: 1 }).format(n) : t.value
    case 'time': {
      const d = new Date(t.value)
      return Number.isNaN(d.getTime()) ? t.value : d.toLocaleTimeString(locale(ctx), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    }
    case 'code':
      return t.value
  }
  return isNumeric(t) && Number.isFinite(n) ? formatNumber(ctx, n) : t.value
}

/** Find, from the event's node up through its RDF/HTML ancestors, the value of a marker predicate. */
export function marked(ctx: ReactionContext, predicate: string): Term | undefined {
  for (let node = ctx.object(ctx.event, BEH.node), hops = 0; node && hops < 32; hops++) {
    const value = ctx.object(node, predicate)
    if (value) return value
    node = ctx.match(null, H.hasChild, node)[0]?.subject
  }
  return undefined
}

/** An element; attribute names with a dash (aria-*, data-*) take the expanded form. */
export function el(o: Out, local: string, cls: string, attrs: Attrs = {}, children: NamedNode[] = []): NamedNode {
  const plain: Attrs = {}
  const dashed: [string, string][] = []
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) (k.includes('-') ? dashed.push([k, v]) : (plain[k] = v))
  const n = o.el(local, cls, plain, children)
  for (const [k, v] of dashed) o.attr(n, k, v)
  return n
}

const NONE = { add: [], remove: [] }

/** A muted one-line message in place of the component's content. */
function message(o: Out, tag: string, line: string) {
  o.renders(el(o, 'root', tag, { class: 'sem-empty' }, [o.text('empty', line)]))
  return o.quads
}

// --- Table ----------------------------------------------------------------------------------------

interface Column {
  node: NamedNode
  variable: string
  label: string
  align?: string
  format?: string
  unit?: string
}

type Row = Map<string, Term>

function columnsOf(ctx: RuleContext, focus: NamedNode, rows: Row[]): Column[] {
  const declared = nodes(ctx, ctx.object(focus, C_COLUMNS)).map((node) => {
    const variable = str(ctx.object(node, C_VARIABLE)) ?? labelOf(ctx, node)
    return {
      node,
      variable,
      label: text(ctx, node, C.label) ?? variable,
      align: str(ctx.object(node, C_ALIGN)),
      format: str(ctx.object(node, C_FORMAT)),
      unit: text(ctx, node, C.unit),
    }
  })
  if (declared.length) return declared
  // No declared columns: the variables of the first row, in its order.
  return [...(rows[0]?.keys() ?? [])].map((variable) => ({ node: ctx.nn(focus.value + '#' + variable), variable, label: variable }))
}

/** Compare two cells: numerically when both are numbers, else as their displayed text. */
function compareCells(ctx: RuleContext, a: Term | undefined, b: Term | undefined, format?: string): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0
  if (isNumeric(a) && isNumeric(b)) return Number(a.value) - Number(b.value)
  return display(ctx, a, format).localeCompare(display(ctx, b, format), locale(ctx), { numeric: true, sensitivity: 'base' })
}

/**
 * Rows of a SELECT under declared columns. Sorting is graph state (c:sortColumn,
 * c:sortDescending); rows are keyed by their content, so a re-sort only reorders them.
 */
const table: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const query = ctx.object(focus, C_QUERY)
  const caption = text(ctx, focus, C.label)
  const select = named(query) ? str(ctx.object(query, SEM.select)) : undefined
  if (!select) return message(o, 'P', text(ctx, focus, C.emptyText) ?? 'No query.')
  if (!ctx.sparql) return message(o, 'P', 'Tables run SPARQL; choose a store with SPARQL.')
  let rows: Row[]
  try {
    rows = ctx.select(select)
  } catch (e) {
    return message(o, 'P', `Query ${labelOf(ctx, query!)} failed: ${(e as Error).message}`)
  }
  const columns = columnsOf(ctx, focus, rows)
  const sortNode = ctx.object(focus, C_SORT_COLUMN)
  const descending = isTrue(ctx.object(focus, C_SORT_DESCENDING))
  const sortBy = sortNode ? columns.find((c) => c.node.equals(sortNode)) : undefined
  if (sortBy) {
    const sign = descending ? -1 : 1
    rows = rows
      .map((row, i) => ({ row, i }))
      .sort((a, b) => sign * compareCells(ctx, a.row.get(sortBy.variable), b.row.get(sortBy.variable), sortBy.format) || a.i - b.i)
      .map(({ row }) => row)
  }
  const cell = (row: Row, c: Column) => {
    const v = display(ctx, row.get(c.variable), c.format)
    return v && c.unit ? `${v} ${c.unit}` : v
  }

  if (ctx.modality === MOD.Text) {
    const shown = rows.slice(0, 12)
    const headers = columns.map((c) => (sortBy === c ? `${c.label} ${descending ? '↓' : '↑'}` : c.label))
    const widths = columns.map((c, i) => Math.min(28, Math.max(headers[i]!.length, ...shown.map((r) => cell(r, c).length))))
    const pad = (s: string, i: number) => (columns[i]!.align === 'end' ? s.padStart(widths[i]!) : s.padEnd(widths[i]!))
    const line = (cells: string[]) => cells.map((s, i) => pad(s.length > widths[i]! ? s.slice(0, widths[i]! - 1) + '…' : s, i)).join('  ').trimEnd()
    const lines = [
      ...(caption ? [caption] : []),
      line(headers),
      line(widths.map((w) => '─'.repeat(w))),
      ...shown.map((r) => line(columns.map((c) => cell(r, c)))),
      ...(rows.length > shown.length ? [`… ${rows.length - shown.length} more`] : []),
      ...(rows.length ? [] : [text(ctx, focus, C.emptyText) ?? 'No rows.']),
    ]
    o.renders(el(o, 'root', 'Div', {}, lines.map((l, i) => el(o, `line${i}`, 'Div', {}, [o.text(`line${i}-text`, l)]))))
    return o.quads
  }

  const alignClass = (c: Column) => (c.align === 'end' ? 'sem-end' : c.align === 'center' ? 'sem-center' : undefined)
  const head = el(o, 'head', 'Thead', {}, [
    el(o, 'head-row', 'Tr', {}, columns.map((c, ci) => {
      const id = `h${ci}`
      const sorted = sortBy === c
      const button = el(o, `${id}-sort`, 'Button', { type: 'button', class: 'sem-sort' }, [
        el(o, `${id}-label`, 'Span', {}, [o.text(`${id}-label-text`, c.label)]),
        el(o, `${id}-icon`, 'Span', { class: 'sem-sort-icon', 'aria-hidden': 'true' }, [o.text(`${id}-icon-text`, sorted ? (descending ? '↓' : '↑') : '↕')]),
      ])
      o.t(button, C_SORTS, c.node)
      const th = el(o, id, 'Th', { scope: 'col', class: alignClass(c) }, [button])
      if (sorted) o.attr(th, 'aria-sort', descending ? 'descending' : 'ascending')
      return th
    })),
  ])
  const seen = new Map<string, number>()
  const body = rows.length
    ? rows.map((row) => {
        // Keyed by content: the same row keeps its elements wherever it sorts to.
        const base = 'r' + hashKey(columns.map((c) => row.get(c.variable)?.value ?? '').join('\u0000'))
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        const id = n ? `${base}-${n}` : base
        return el(o, id, 'Tr', {}, columns.map((c, ci) => {
          const v = cell(row, c)
          const content = c.format === 'code' && v ? [el(o, `${id}-c${ci}-code`, 'Code', {}, [o.text(`${id}-c${ci}-text`, v)])] : [o.text(`${id}-c${ci}-text`, v)]
          return el(o, `${id}-c${ci}`, ci === 0 ? 'Th' : 'Td', { scope: ci === 0 ? 'row' : undefined, class: alignClass(c) }, content)
        }))
      })
    : [el(o, 'empty-row', 'Tr', {}, [el(o, 'empty-cell', 'Td', { colSpan: String(Math.max(1, columns.length)), class: 'sem-empty' }, [o.text('empty-text', text(ctx, focus, C.emptyText) ?? 'No rows.')])])]
  const tableEl = el(o, 'table', 'Table', {}, [head, el(o, 'body', 'Tbody', {}, body)])
  if (caption) o.attr(tableEl, 'aria-label', caption)
  o.attr(tableEl, 'aria-rowcount', String(rows.length + 1))
  // The root scrolls (the header sticks); a focusable region so keyboards can scroll it.
  const root = el(o, 'root', 'Div', { tabIndex: '0' }, [tableEl])
  o.attr(root, 'role', 'region')
  o.attr(root, 'aria-label', caption ?? 'Table')
  o.renders(root)
  return o.quads
}

/** Clicking a header sorts by its column; clicking the sorted column again reverses it. */
const tableSort: ReactionFn = (ctx) => {
  const column = marked(ctx, C_SORTS)
  if (!column) return NONE
  const f = ctx.runtime.store.factory
  const current = ctx.match(ctx.target, C_SORT_COLUMN, null)
  const directions = ctx.match(ctx.target, C_SORT_DESCENDING, null)
  const descending = current.some((q) => q.object.equals(column)) && !directions.some((q) => isTrue(q.object))
  return {
    remove: [...current, ...directions],
    add: [
      f.quad(ctx.target, f.namedNode(C_SORT_COLUMN), column as NamedNode),
      f.quad(ctx.target, f.namedNode(C_SORT_DESCENDING), f.literal(String(descending), f.namedNode(XSD_BOOLEAN))),
    ],
  }
}

// --- DescriptionList ----------------------------------------------------------------------------

const descriptionList: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const of = ctx.object(focus, C.of)
  const items = nodes(ctx, ctx.object(focus, C_ITEMS))
  const pairs: { key: string; term: string; value: string }[] = items.length
    ? items.map((item) => ({ key: hashKey(item.value), term: labelOf(ctx, item), value: display(ctx, ctx.object(item, C.value)) }))
    : of
      ? nodes(ctx, ctx.object(focus, C.fields)).flatMap((p) => {
          const values = ctx.objects(of, p)
          if (!values.length) return []
          const unit = text(ctx, p, C.unit)
          const value = values.map((v) => display(ctx, v)).join(', ')
          return [{ key: hashKey(p.value), term: labelOf(ctx, p), value: unit ? `${value} ${unit}` : value }]
        })
      : []
  if (!pairs.length) return message(o, 'P', text(ctx, focus, C.emptyText) ?? 'Nothing to describe.')
  if (ctx.modality === MOD.Text) {
    const width = Math.max(...pairs.map((p) => p.term.length))
    o.renders(el(o, 'root', 'Div', {}, pairs.map((p) => el(o, `p${p.key}`, 'Div', {}, [o.text(`p${p.key}-text`, `${p.term.padEnd(width)}  ${p.value}`)]))))
    return o.quads
  }
  const groups = pairs.map((p) =>
    el(o, `p${p.key}`, 'Div', { class: 'sem-pair' }, [
      el(o, `p${p.key}-dt`, 'Dt', {}, [o.text(`p${p.key}-dt-text`, p.term)]),
      el(o, `p${p.key}-dd`, 'Dd', {}, [o.text(`p${p.key}-dd-text`, p.value)]),
    ]),
  )
  o.renders(el(o, 'root', 'Dl', {}, groups))
  return o.quads
}

// --- Stat -------------------------------------------------------------------------------------

const stat: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const label = labelOf(ctx, focus)
  const valueTerm = ctx.object(focus, C.value)
  const value = display(ctx, valueTerm)
  const unit = text(ctx, focus, C.unit)
  const help = text(ctx, focus, C.help)
  const deltaTerm = ctx.object(focus, C_DELTA)
  const delta = deltaTerm ? Number(deltaTerm.value) : undefined
  const deltaUnit = text(ctx, focus, C_DELTA_UNIT) ?? ''
  const lowerIsBetter = isTrue(ctx.object(focus, C_LOWER_IS_BETTER))
  const trend = delta === undefined || !Number.isFinite(delta) ? undefined : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
  const arrow = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'
  const magnitude = delta === undefined ? '' : `${formatNumber(ctx, Math.abs(delta), 2)}${deltaUnit}`
  const signed = delta === undefined ? '' : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${magnitude}`
  if (ctx.modality === MOD.Text) {
    const line = `${label}: ${value}${unit ? ' ' + unit : ''}${trend ? `  ${arrow} ${signed}` : ''}`
    o.renders(el(o, 'root', 'Div', {}, [o.text('line', line)]))
    return o.quads
  }
  const parts: NamedNode[] = [
    el(o, 'label', 'Span', { class: 'sem-label' }, [o.text('label-text', label)]),
    el(o, 'figure', 'Div', { class: 'sem-figure' }, [
      el(o, 'value', 'Span', { class: 'sem-value' }, [o.text('value-text', value || '–')]),
      ...(unit ? [el(o, 'unit', 'Span', { class: 'sem-unit' }, [o.text('unit-text', unit)])] : []),
    ]),
  ]
  if (trend) {
    const good = trend === 'flat' ? 'neutral' : (trend === 'up') !== lowerIsBetter ? 'good' : 'bad'
    const d = el(o, 'delta', 'Span', { class: `sem-delta sem-${good}` }, [
      el(o, 'delta-arrow', 'Span', { 'aria-hidden': 'true' }, [o.text('delta-arrow-text', arrow)]),
      el(o, 'delta-value', 'Span', { 'aria-hidden': 'true' }, [o.text('delta-value-text', signed)]),
    ])
    o.attr(d, 'data-trend', trend)
    o.attr(d, 'role', 'img')
    o.attr(d, 'aria-label', trend === 'flat' ? 'unchanged' : `${trend === 'up' ? 'up' : 'down'} ${magnitude}`)
    parts.push(d)
  }
  if (help) parts.push(el(o, 'help', 'P', { class: 'sem-help' }, [o.text('help-text', help)]))
  o.renders(el(o, 'root', 'Div', {}, parts))
  return o.quads
}

// --- Avatar and AvatarGroup -----------------------------------------------------------------------

/** Up to two initials: the first letters of the first and last words. */
export function initials(label: string): string {
  const words = label.trim().split(/[\s\-_.·]+/u).filter(Boolean)
  if (!words.length) return '?'
  const first = (w: string) => [...w][0] ?? ''
  const chars = words.length > 1 ? first(words[0]!) + first(words[words.length - 1]!) : [...words[0]!].slice(0, 2).join('')
  return chars.toLocaleUpperCase()
}

/** A hue (0-359) derived from a label: the same label always gets the same color. */
export function hueOf(label: string): number {
  return parseInt(hashKey(label), 36) % 360
}

const avatar: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const label = labelOf(ctx, focus)
  const image = str(ctx.object(focus, C_IMAGE))
  if (ctx.modality === MOD.Text) {
    o.renders(el(o, 'root', 'Span', {}, [o.text('line', `(${initials(label)})`)]))
    return o.quads
  }
  const content = image
    ? el(o, 'image', 'Img', { src: image, alt: '', loading: 'lazy' })
    : el(o, 'initials', 'Span', { 'aria-hidden': 'true' }, [o.text('initials-text', initials(label))])
  const root = el(o, 'root', 'Span', { style: `--avatar-hue: ${hueOf(label)}` }, [content])
  o.attr(root, 'role', 'img')
  o.attr(root, 'aria-label', label)
  o.tip(root, label)
  o.renders(root)
  return o.quads
}

const avatarGroup: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const members = nodes(ctx, ctx.object(focus, C.children))
  const max = Math.max(1, num(ctx, focus, C.max, members.length))
  const shown = members.slice(0, max)
  const rest = members.length - shown.length
  const label = text(ctx, focus, C.label) ?? `${members.length} ${members.length === 1 ? 'member' : 'members'}`
  if (ctx.modality === MOD.Text) {
    o.renders(el(o, 'root', 'Div', {}, [...shown, ...(rest > 0 ? [o.text('more', ` +${rest}`)] : [])]))
    return o.quads
  }
  const parts: NamedNode[] = [...shown]
  if (rest > 0) {
    const more = el(o, 'more', 'Span', { class: 'sem-more' }, [el(o, 'more-text-wrap', 'Span', { 'aria-hidden': 'true' }, [o.text('more-text', `+${rest}`)])])
    o.attr(more, 'role', 'img')
    o.attr(more, 'aria-label', `${rest} more`)
    o.tip(more, members.slice(max).map((m) => labelOf(ctx, m)).join(', '))
    parts.push(more)
  }
  const root = el(o, 'root', 'Div', {}, parts)
  o.attr(root, 'role', 'group')
  o.attr(root, 'aria-label', label)
  o.renders(root)
  return o.quads
}

// --- Timeline -------------------------------------------------------------------------------------

/** The newest members of a head-linked stream; one c:TimelineItem per member, keyed by it. */
const timeline: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const stream = ctx.object(focus, C.of)
  if (!named(stream)) return []
  const limit = Math.max(1, num(ctx, focus, C.limit, 8))
  const members: NamedNode[] = []
  for (let m = ctx.object(stream, BEH.latest); named(m) && members.length < limit && ctx.object(m, RDF_TYPE); m = ctx.object(m, BEH.previous)) members.push(m)
  if (!members.length) return message(o, ctx.modality === MOD.Text ? 'Div' : 'P', text(ctx, focus, C.emptyText) ?? 'No events yet.')
  const items = members.map((m) => {
    const item = o.node('e-' + hashKey(m.value))
    o.t(item, RDF_TYPE, ctx.nn(C_TIMELINE_ITEM))
    o.t(item, C.of, m)
    return item
  })
  const root = el(o, 'root', ctx.modality === MOD.Text ? 'Div' : 'Ol', {}, items)
  if (ctx.modality !== MOD.Text) o.attr(root, 'aria-label', text(ctx, focus, C.label) ?? labelOf(ctx, stream))
  o.renders(root)
  return o.quads
}

/** One event: what happened (its class), to what (beh:target), when (beh:at) and its effect. */
const timelineItem: FnRule = (ctx, focus) => {
  const event = ctx.object(focus, C.of)
  if (!named(event)) return []
  const o = ctx.out(focus)
  const at = ctx.object(event, BEH.at)
  const type = ctx.objects(event, RDF_TYPE).find(named)
  const target = ctx.object(event, BEH.target)
  const what = type ? labelOf(ctx, type) : 'Event'
  const on = named(target) ? labelOf(ctx, target) : undefined
  const time = display(ctx, at, 'time')
  const added = Number(str(ctx.object(event, BEH.added)) ?? 0)
  const removed = Number(str(ctx.object(event, BEH.removed)) ?? 0)
  const effect = added || removed ? `+${added} −${removed}` : ''
  if (ctx.modality === MOD.Text) {
    o.renders(el(o, 'root', 'Div', {}, [o.text('line', `${time}  ${what}${on ? ' → ' + on : ''}${effect ? '  ' + effect : ''}`)]))
    return o.quads
  }
  const body = el(o, 'body', 'Div', { class: 'sem-body' }, [
    el(o, 'what', 'Strong', {}, [o.text('what-text', what)]),
    ...(on ? [el(o, 'target', 'Span', { class: 'sem-target' }, [o.text('target-text', on)])] : []),
  ])
  const meta = el(o, 'meta', 'Div', { class: 'sem-meta' }, [
    el(o, 'time', 'Time', { dateTime: at?.value }, [o.text('time-text', time)]),
    ...(effect ? [el(o, 'effect', 'Span', { class: 'sem-effect' }, [o.text('effect-text', effect)])] : []),
  ])
  if (effect) o.tip(o.node('effect'), `${added} triples added, ${removed} removed`)
  o.renders(el(o, 'root', 'Li', {}, [el(o, 'dot', 'Span', { class: 'sem-dot', 'aria-hidden': 'true' }), body, meta]))
  return o.quads
}

// --- Tree ---------------------------------------------------------------------------------------

/**
 * An expandable hierarchy from c:of: a node's children are the subjects that point at it
 * through c:parentProperty. Open nodes are graph state (c:expandedNode) on the tree.
 */
const tree: FnRule = (ctx, focus) => {
  const root = ctx.object(focus, C.of)
  const parent = ctx.object(focus, C_PARENT_PROPERTY)
  if (!named(root) || !named(parent)) return []
  const o = ctx.out(focus)
  const expanded = new Set(ctx.objects(focus, C_EXPANDED).map((t) => t.value))
  const detail = ctx.object(focus, C_DETAIL_PROPERTY)
  const target = ctx.object(focus, C.controls)
  const property = ctx.object(focus, C.property)
  const selectable = named(target) && named(property)
  const selected = selectable ? ctx.object(target, property)?.value : undefined
  const children = (n: NamedNode) =>
    ctx
      .match(null, parent, n)
      .map((q) => q.subject)
      .filter(named)
      .map((t) => ({ t, label: labelOf(ctx, t) }))
      .sort((a, b) => a.label.localeCompare(b.label, locale(ctx)) || (a.t.value < b.t.value ? -1 : 1))
  const caption = text(ctx, focus, C.label) ?? labelOf(ctx, root)

  if (ctx.modality === MOD.Text) {
    const lines: string[] = []
    const walk = (n: NamedNode, label: string, depth: number, path: Set<string>) => {
      const kids = path.has(n.value) ? [] : children(n)
      const open = expanded.has(n.value) && kids.length > 0
      lines.push(`${'  '.repeat(depth)}${kids.length ? (open ? '▾ ' : '▸ ') : '  '}${label}${n.value === selected ? '  ◂' : ''}`)
      if (open) for (const k of kids) walk(k.t, k.label, depth + 1, new Set([...path, n.value]))
    }
    walk(root, labelOf(ctx, root), 0, new Set())
    o.renders(el(o, 'root', 'Div', {}, lines.map((l, i) => el(o, `line${i}`, 'Div', {}, [o.text(`line${i}-text`, l)]))))
    return o.quads
  }

  // Elements are keyed by the node's path, so a node under two parents is two items.
  const item = (n: NamedNode, label: string, level: number, key: string, path: Set<string>): NamedNode => {
    const id = 'n' + key
    const kids = path.has(n.value) ? [] : children(n)
    const open = expanded.has(n.value) && kids.length > 0
    const rowParts: NamedNode[] = []
    if (kids.length) {
      const twisty = el(o, `${id}-twisty`, 'Button', { type: 'button', class: 'sem-twisty' }, [el(o, `${id}-twisty-icon`, 'Span', { 'aria-hidden': 'true' }, [o.text(`${id}-twisty-text`, '▸')])])
      o.attr(twisty, 'aria-label', `${open ? 'Collapse' : 'Expand'} ${label}`)
      o.t(twisty, C_TOGGLES, n)
      rowParts.push(twisty)
    } else rowParts.push(el(o, `${id}-leaf`, 'Span', { class: 'sem-leaf', 'aria-hidden': 'true' }))
    const labelEl = selectable
      ? el(o, `${id}-label`, 'Button', { type: 'button', class: 'sem-label' }, [o.text(`${id}-label-text`, label)])
      : el(o, `${id}-label`, 'Span', { class: 'sem-label' }, [o.text(`${id}-label-text`, label)])
    if (selectable) o.t(labelEl, C.selects, n)
    // Without selection, the label toggles too (a larger hit area than the twisty).
    else if (kids.length) o.t(labelEl, C_TOGGLES, n)
    rowParts.push(labelEl)
    const detailText = named(detail) ? display(ctx, ctx.object(n, detail)) : ''
    if (detailText) rowParts.push(el(o, `${id}-detail`, 'Code', { class: 'sem-detail' }, [o.text(`${id}-detail-text`, detailText)]))
    if (kids.length) rowParts.push(el(o, `${id}-count`, 'Span', { class: 'sem-count' }, [o.text(`${id}-count-text`, String(kids.length))]))
    const parts = [el(o, `${id}-row`, 'Div', { class: 'sem-row' }, rowParts)]
    if (open) {
      const inner = new Set([...path, n.value])
      const group = el(o, `${id}-group`, 'Ul', {}, kids.map((k) => item(k.t, k.label, level + 1, hashKey(key + ' ' + k.t.value), inner)))
      o.attr(group, 'role', 'group')
      parts.push(group)
    }
    const li = el(o, id, 'Li', { style: `--tree-level: ${level - 1}` }, parts)
    o.attr(li, 'role', 'treeitem')
    o.attr(li, 'aria-level', String(level))
    if (kids.length) o.attr(li, 'aria-expanded', String(open))
    if (selectable) o.attr(li, 'aria-selected', String(n.value === selected))
    return li
  }
  const list = el(o, 'root', 'Ul', {}, [item(root, labelOf(ctx, root), 1, hashKey(root.value), new Set())])
  o.attr(list, 'role', 'tree')
  o.attr(list, 'aria-label', caption)
  o.renders(list)
  return o.quads
}

/** The twisty opens a closed node and closes an open one (c:expandedNode on the tree). */
const treeToggle: ReactionFn = (ctx) => {
  const node = marked(ctx, C_TOGGLES)
  if (!named(node)) return NONE
  const f = ctx.runtime.store.factory
  const current = ctx.match(ctx.target, C_EXPANDED, node)
  return current.length ? { remove: current, add: [] } : { remove: [], add: [f.quad(ctx.target, f.namedNode(C_EXPANDED), node)] }
}

export const functions: Record<string, FnRule> = {
  'data:table': table,
  'data:description-list': descriptionList,
  'data:stat': stat,
  'data:avatar': avatar,
  'data:avatar-group': avatarGroup,
  'data:timeline': timeline,
  'data:timeline-item': timelineItem,
  'data:tree': tree,
}

export const reactions: Record<string, ReactionFn> = {
  'data:table-sort': tableSort,
  'data:tree-toggle': treeToggle,
}
