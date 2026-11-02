// Function rules and reactions for the data components (ontology/components/data.ttl).
import type { NamedNode, Term } from '@rdfjs/types'
import type { ReactionContext, ReactionFn } from '../behaviour/events.ts'
import type { Attrs, FnRule, Out, RuleContext } from '../engine/context.ts'
import { formatLocale } from '../engine/context.ts'
import { BEH, C, H, MOD, NS, RDF_TYPE, SEM, XSD_BOOLEAN, XSD_INTEGER } from '../ns.ts'
import { isTrue, labelOf, named, nodes, num, rdfList, str, text } from './util.ts'
import { dateOf, formatDateTime, formatNumber as intlNumber, numberOf, sortKey } from '../../rdf-engine/host/intl.ts'
import { compareKeys, TUPLE } from '../render/order-key.ts'
import { viewRows } from '../view/rows.ts'

const C_QUERY = NS.c + 'query'
const C_COLUMNS = NS.c + 'tableColumns'
const C_VARIABLE = NS.c + 'variable'
const C_ALIGN = NS.c + 'align'
const C_FORMAT = NS.c + 'format'
const C_SLOT_PREFIX = NS.c + 'slotPrefix'
const C_SLOT_VARIABLE = NS.c + 'slotVariable'
const C_SORTABLE = NS.c + 'sortable'
const C_SORT_COLUMN = NS.c + 'sortColumn'
const C_SORT_DESCENDING = NS.c + 'sortDescending'
const C_SORTS = NS.c + 'sorts'
const C_ITEMS = NS.c + 'items'
const C_PAIR_OF = NS.c + 'pairOf'
const C_TERM = NS.c + 'term'
const C_PAIR_ORDER = NS.c + 'pairOrder'
const C_PAIR_COMPONENT = NS.c + 'pairComponent'
const C_PIECE_OF = NS.c + 'pieceOf'
const C_PIECE_TEXT = NS.c + 'pieceText'
const C_DELTA = NS.c + 'delta'
const C_DELTA_UNIT = NS.c + 'deltaUnit'
const C_LOWER_IS_BETTER = NS.c + 'lowerIsBetter'
const C_IMAGE = NS.c + 'image'
const C_TIMELINE_ITEM = NS.c + 'TimelineItem'
const C_PARENT_PROPERTY = NS.c + 'parentProperty'
const C_EXPANDED = NS.c + 'expandedNode'
const C_DETAIL_PROPERTY = NS.c + 'detailProperty'
const C_TOGGLES = NS.c + 'expands'
const C_TREE_ITEM = NS.c + 'TreeItem'
const C_IN_TREE = NS.c + 'inTree'
const C_ITEM_LEVEL = NS.c + 'itemLevel'
const C_PARENT_ITEM = NS.c + 'parentItem'

/** A short, stable key for an IRI or a value (FNV-1a, base 36). */
export function hashKey(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)

/** MD5 of the UTF-8 bytes of `s`, as lower-case hex: SPARQL's MD5(). */
export function md5(s: string): string {
  const bytes = new TextEncoder().encode(s)
  const n = ((bytes.length + 8) >>> 6) + 1
  const words = new Uint32Array(n * 16)
  for (let i = 0; i < bytes.length; i++) words[i >> 2]! |= bytes[i]! << ((i % 4) * 8)
  words[bytes.length >> 2]! |= 0x80 << ((bytes.length % 4) * 8)
  words[n * 16 - 2] = (bytes.length * 8) >>> 0
  words[n * 16 - 1] = Math.floor(bytes.length / 0x20000000)
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]
  for (let chunk = 0; chunk < words.length; chunk += 16) {
    let [a, b, c, d] = [a0, b0, c0, d0]
    for (let i = 0; i < 64; i++) {
      const round = i >> 4
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d)
      const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16
      const shift = MD5_SHIFTS[round * 4 + (i % 4)]!
      const sum = (a + f + MD5_K[i]! + words[chunk + g]!) | 0
      ;[a, d, c] = [d, c, b]
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }
  let hex = ''
  for (const w of [a0, b0, c0, d0]) for (let i = 0; i < 4; i++) hex += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')
  return hex
}

/** A short, stable key that SPARQL rules compute too: SUBSTR(MD5(STR(?x)), 1, 8). */
export const md5Key = (s: string): string => md5(s).slice(0, 8)

/** The viewer's first language that Intl knows, else en-US (the viewer's l10n:formatLocale). */
const locale = (ctx: RuleContext) => formatLocale(ctx.languages)
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const DATED = new Set([NS.xsd + 'dateTime', NS.xsd + 'dateTimeStamp', NS.xsd + 'date'])
const isNumeric = (t: Term | undefined) => t?.termType === 'Literal' && NUMERIC.test(t.value)

/** A number written for the viewer's locale as sx:formatNumber writes it (grouped; at most `digits` decimals). */
function formatNumber(ctx: RuleContext, n: number, digits = 2): string {
  return intlNumber(n, locale(ctx), `maximumFractionDigits=${digits}`)
}

/** A value as text, as c:TableRendering-sparql writes it: IRIs by their label, numbers in the viewer's locale, others as they are. */
function display(ctx: RuleContext, t: Term | undefined, format?: string): string {
  if (!t) return ''
  if (t.termType === 'NamedNode') return labelOf(ctx, t)
  if (t.termType !== 'Literal') return t.value
  const n = numberOf(t.value)
  switch (format) {
    case 'number':
      return isNumeric(t) ? formatNumber(ctx, n, 0) : t.value
    case 'decimal':
      return isNumeric(t) ? intlNumber(n, locale(ctx), 'minimumFractionDigits=2;maximumFractionDigits=2') : t.value
    case 'percent':
      return isNumeric(t) ? intlNumber(n, locale(ctx), 'style=percent;maximumFractionDigits=1') : t.value
    case 'time': {
      // As sx:formatDateTime writes it (in the store's time zone), which reads only dates and date-times.
      const d = DATED.has(t.datatype.value) ? dateOf(t.value) : undefined
      return !d || Number.isNaN(d.getTime()) ? t.value : formatDateTime(d, locale(ctx), 'hour=2-digit;minute=2-digit;second=2-digit;hour12=false', ctx.timeZone)
    }
    case 'code':
      return t.value
  }
  return isNumeric(t) ? formatNumber(ctx, n) : t.value
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
  slotPrefix?: string
  slotVariable?: string
  sortable?: boolean
}

type Row = Map<string, Term>
/** A row and its key: the run's row node (rs:solution) and its place in the run (rs:index), or for rows of a SELECT run here, its values. */
type Keyed = { row: Row; id: string; index: number }

function columnsOf(ctx: RuleContext, focus: NamedNode, variables: string[]): Column[] {
  const declared = nodes(ctx, ctx.object(focus, C_COLUMNS)).map((node) => {
    const variable = str(ctx.object(node, C_VARIABLE)) ?? labelOf(ctx, node)
    const sorting = ctx.object(node, C_SORTABLE)
    return {
      node,
      variable,
      label: text(ctx, node, C.label) ?? variable,
      align: str(ctx.object(node, C_ALIGN)),
      format: str(ctx.object(node, C_FORMAT)),
      unit: text(ctx, node, C.unit),
      slotPrefix: str(ctx.object(node, C_SLOT_PREFIX)),
      slotVariable: str(ctx.object(node, C_SLOT_VARIABLE)),
      sortable: sorting ? isTrue(sorting) : true,
    }
  })
  if (declared.length) return declared
  // No declared columns: the query's, in their order.
  return variables.map((variable) => ({ node: ctx.nn(focus.value + '#' + variable), variable, label: variable }))
}

/**
 * The rows of the table's query: the run that the table names (iv:run, c:TableRuns), one row per
 * solution, keyed by its node and placed by its index; without a run (a store with no views
 * runtime), the SELECT run here, keyed by its values. Undefined when the run failed (its message).
 */
function tableRows(ctx: RuleContext, focus: NamedNode, query: Term, select: string): { rows: Keyed[]; variables: string[] } | { error: string } {
  const run = ctx.object(focus, NS.iv + 'run')
  if (run && ctx.match(run, RDF_TYPE, NS.rs + 'ResultSet').length) {
    const error = ctx.object(run, NS.iv + 'error')
    if (error) return { error: error.value }
    const variables = ctx
      .objects(run, NS.iv + 'column')
      .map((col) => ({ v: str(ctx.object(col, NS.rs + 'variable')) ?? '', i: num(ctx, col, NS.rs + 'index', 0) }))
      .sort((x, y) => x.i - y.i)
      .map((c) => c.v)
    const rows = ctx.objects(run, NS.rs + 'solution').map((r) => {
      const row: Row = new Map()
      for (const b of ctx.objects(r, NS.rs + 'binding')) {
        const v = str(ctx.object(b, NS.rs + 'variable'))
        const value = ctx.object(b, NS.rs + 'value')
        if (v && value) row.set(v, value)
      }
      return { row, id: 'r-' + md5Key(r.value), index: num(ctx, r, NS.rs + 'index', 0) }
    })
    return { rows, variables }
  }
  let found: Row[]
  try {
    found = viewRows(ctx, query, select)
  } catch (e) {
    return { error: (e as Error).message }
  }
  const seen = new Map<string, number>()
  const rows = found.map((row, i) => {
    const base = 'r' + hashKey([...row].map(([k, v]) => `${k}=${v.value}`).join('\u0000'))
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { row, id: n ? `${base}-${n}` : base, index: i + 1 }
  })
  return { rows, variables: [...(found[0]?.keys() ?? [])] }
}

/**
 * A row's order key (sem:orderKey), as the SPARQL rule writes it: by its place in the run, or sorted
 * by a column, (has a value, the value - a number, else its displayed text's sx:sortKey -, its place in
 * the run), the first two descending when the sort is.
 */
function rowKey(ctx: RuleContext, r: Keyed, sortBy: Column | undefined, descending: boolean): string {
  if (!sortBy) return String(r.index)
  const v = r.row.get(sortBy.variable)
  const d = descending ? '-' : ''
  const value = !v ? 's' : isNumeric(v) ? 'n' + v.value : 's' + sortKey(display(ctx, v, sortBy.format), locale(ctx))
  return `${TUPLE}${d}n${v ? 0 : 1}${TUPLE}${d}${value}${TUPLE}n${r.index}`
}

/**
 * Rows of a SELECT under declared columns. Sorting is graph state (c:sortColumn,
 * c:sortDescending); rows are keyed by their solution and placed by order keys, so a re-sort only
 * re-keys them.
 */
const table: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const query = ctx.object(focus, C_QUERY)
  const caption = text(ctx, focus, C.label)
  const select = named(query) ? str(ctx.object(query, SEM.select)) : undefined
  if (!select) return message(o, 'P', text(ctx, focus, C.emptyText) ?? 'No query.')
  if (!ctx.sparql) return message(o, 'P', 'Tables run SPARQL; choose a store with SPARQL.')
  const found = tableRows(ctx, focus, query!, select)
  if ('error' in found) return message(o, 'P', `Query ${labelOf(ctx, query!)} failed: ${found.error}`)
  const columns = columnsOf(ctx, focus, found.variables)
  const sortNode = ctx.object(focus, C_SORT_COLUMN)
  const descending = isTrue(ctx.object(focus, C_SORT_DESCENDING))
  const sortBy = sortNode ? columns.find((c) => c.sortable !== false && c.node.equals(sortNode)) : undefined
  ctx.readsLanguage()
  const rows = found.rows.map((r) => ({ ...r, key: rowKey(ctx, r, sortBy, descending) }))
  const cell = (row: Row, c: Column) => {
    if (c.slotPrefix !== undefined) return ''
    const v = display(ctx, row.get(c.variable), c.format)
    return v && c.unit ? `${v} ${c.unit}` : v
  }

  if (ctx.modality === MOD.Text) {
    // The first 12 rows in their order fix the widths; they are placed by their order keys in a group.
    const shown = [...rows].sort((a, b) => compareKeys(a.key, b.key)).slice(0, 12)
    const headers = columns.map((c) => (sortBy === c ? `${c.label} ${descending ? '↓' : '↑'}` : c.label))
    const widths = columns.map((c, i) => Math.min(28, Math.max([...headers[i]!].length, ...shown.map((r) => [...cell(r.row, c)].length))))
    const fit = (s: string, i: number) => {
      const chars = [...s]
      const w = widths[i]!
      const cut = chars.length > w ? chars.slice(0, w - 1).join('') + '…' : s
      const pad = ' '.repeat(Math.max(0, w - [...cut].length))
      return columns[i]!.align === 'end' ? pad + cut : cut + pad
    }
    const line = (cells: string[]) => cells.map(fit).join('  ').replace(/[ ]+$/, '')
    const lineEl = (local: string, data: string) => el(o, `line-${local}`, 'Div', {}, [o.text(`line-${local}-text`, data)])
    const group = el(o, 'rows', 'Div')
    for (const r of shown) o.t(group, H.hasChild, o.t(lineEl(r.id, line(columns.map((c) => cell(r.row, c)))), SEM.orderKey, r.key).node(`line-${r.id}`))
    const lines = [
      ...(caption ? [lineEl('caption', caption)] : []),
      lineEl('header', line(headers)),
      lineEl('rule', line(widths.map((w) => '─'.repeat(w)))),
      ...(rows.length ? [group] : []),
      ...(rows.length > shown.length ? [lineEl('more', `… ${rows.length - shown.length} more`)] : []),
      ...(rows.length ? [] : [lineEl('empty', text(ctx, focus, C.emptyText) ?? 'No rows.')]),
    ]
    o.renders(el(o, 'root', 'Div', {}, lines))
    return o.quads
  }

  const alignClass = (c: Column) => (c.align === 'end' ? 'sem-end' : c.align === 'center' ? 'sem-center' : undefined)
  const head = el(o, 'head', 'Thead', {}, [
    el(o, 'head-row', 'Tr', {}, columns.map((c, ci) => {
      const id = `h${ci}`
      const sorted = sortBy === c
      const content = c.sortable === false
        ? [el(o, `${id}-label`, 'Span', { class: 'sem-head-label' }, [o.text(`${id}-label-text`, c.label)])]
        : [el(o, `${id}-sort`, 'Button', { type: 'button', class: 'sem-sort' }, [
            el(o, `${id}-label`, 'Span', {}, [o.text(`${id}-label-text`, c.label)]),
            el(o, `${id}-icon`, 'Span', { class: 'sem-sort-icon', 'aria-hidden': 'true' }, [o.text(`${id}-icon-text`, sorted ? (descending ? '↓' : '↑') : '↕')]),
          ])]
      if (c.sortable !== false) o.t(content[0]!, C_SORTS, c.node)
      const th = el(o, id, 'Th', { scope: 'col', class: alignClass(c) }, content)
      if (sorted) o.attr(th, 'aria-sort', descending ? 'descending' : 'ascending')
      return th
    })),
  ])
  const body = el(o, 'body', 'Tbody')
  if (rows.length)
    for (const { row, id, key } of rows) {
      const tr = el(o, id, 'Tr', {}, columns.map((c, ci) => {
        const slotKey = row.get(c.slotVariable ?? c.variable)?.value
        const slotName = c.slotPrefix !== undefined && slotKey !== undefined ? c.slotPrefix + slotKey : undefined
        const v = cell(row, c)
        const content = c.slotPrefix !== undefined ? [] : c.format === 'code' && v ? [el(o, `${id}-c${ci}-code`, 'Code', {}, [o.text(`${id}-c${ci}-text`, v)])] : [o.text(`${id}-c${ci}-text`, v)]
        const cellEl = el(o, `${id}-c${ci}`, ci === 0 ? 'Th' : 'Td', { scope: ci === 0 ? 'row' : undefined, class: alignClass(c) }, content)
        if (slotName !== undefined) o.t(cellEl, SEM.slot, slotName)
        return cellEl
      }))
      o.t(tr, SEM.orderKey, key).t(body, H.hasChild, tr)
    }
  else o.t(body, H.hasChild, el(o, 'empty-row', 'Tr', {}, [el(o, 'empty-cell', 'Td', { colSpan: String(Math.max(1, columns.length)), class: 'sem-empty' }, [o.text('empty-text', text(ctx, focus, C.emptyText) ?? 'No rows.')])]))
  const tableEl = el(o, 'table', 'Table', {}, [head, body])
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

/** The node a view describes: c:of, or the value of c:bindProperty on c:bindFrom (e.g. a selection); then one c:via hop. */
function describedNode(ctx: RuleContext, focus: NamedNode): Term | undefined {
  const from = ctx.object(focus, C.bindFrom)
  const bound = ctx.object(focus, C.bindProperty)
  const subject = ctx.object(focus, C.of) ?? (named(from) && named(bound) ? ctx.object(from, bound) : undefined)
  const via = ctx.object(focus, NS.c + 'via')
  return subject && named(via) ? ctx.object(subject, via) : subject
}

/** A pair a description list shows: its key, term, order key, and its component or the pieces of its value. */
interface Pair { key: string; term: string; order: string; component?: NamedNode; pieces: { key: string; text: string; order: string }[] }

/** A term's key, as the SPARQL rule writes it (an IRI as it is; a literal with its language and datatype). */
const termKey = (t: Term) => (t.termType === 'Literal' ? `${t.value}@${t.language}^${t.datatype.value}` : t.value)

/** The members of an RDF list with their positions (as the SPARQL rule counts the cells before each). */
function positioned(ctx: RuleContext, head: Term | undefined): { member: NamedNode; at: number }[] {
  return rdfList(ctx, head).flatMap((member, at) => (named(member) ? [{ member, at }] : []))
}

/**
 * c:DescriptionPairs: the pairs a description list shows, as data under it (<list>/~pair-<key>):
 * explicit c:items, else the entries of the node it describes (c:entryProperty, by sem:order, then
 * by term in the viewer's collation), else the values of c:fields on it. A field's values are
 * pieces in the viewer's collation of their texts, each after ", " but the first, and its unit a last piece.
 */
function pairsOf(ctx: RuleContext, focus: NamedNode): Pair[] {
  const of = describedNode(ctx, focus)
  const lang = formatLocale(ctx.languages)
  const items = positioned(ctx, ctx.object(focus, C_ITEMS))
  if (items.length) {
    return items.map(({ member: item, at }) => {
      const content = ctx.object(item, C.content)
      const component = named(content) ? content : undefined
      const value = ctx.object(item, C.value)
      const key = md5Key(item.value)
      return { key, term: labelOf(ctx, item), order: TUPLE + 'n' + at, component,
        pieces: value !== undefined || !component ? [{ key: key + '-v', text: display(ctx, value), order: TUPLE + 'n0' }] : [] }
    })
  }
  if (!of) return []
  if (ctx.object(focus, NS.c + 'entryProperty')) {
    const entry = ctx.object(focus, NS.c + 'entryProperty')
    const keyP = ctx.object(focus, NS.c + 'keyProperty')
    const valueP = ctx.object(focus, NS.c + 'valueProperty')
    if (!named(entry) || !named(keyP) || !named(valueP)) return []
    return ctx.objects(of, entry).filter(named).map((e) => {
      const position = str(ctx.object(e, SEM.order))
      const term = display(ctx, ctx.object(e, keyP))
      const sorted = TUPLE + 's' + sortKey(term, lang)
      const key = md5Key(e.value)
      return { key, term, order: position !== undefined && Number.isFinite(Number(position)) ? TUPLE + 'n0' + TUPLE + 'n' + position + sorted : TUPLE + 'n1' + sorted,
        pieces: [{ key: key + '-v', text: display(ctx, ctx.object(e, valueP)), order: TUPLE + 'n0' }] }
    })
  }
  return positioned(ctx, ctx.object(focus, C.fields)).flatMap(({ member: p, at }) => {
    const values = ctx.objects(of, p)
    if (!values.length) return []
    const key = md5Key(p.value)
    const pieces = values
      .map((v) => {
        const value = display(ctx, v)
        const k = key + '-v' + md5Key(termKey(v))
        return { key: k, value, order: TUPLE + 'n0' + TUPLE + 's' + sortKey(value, lang) + TUPLE + 's' + k }
      })
      .sort((x, y) => compareKeys(x.order, y.order))
      .map((x, i) => ({ key: x.key, text: (i ? ', ' : '') + x.value, order: x.order }))
    const unit = text(ctx, p, C.unit)
    if (unit) pieces.push({ key: key + '-unit', text: ' ' + unit, order: TUPLE + 'n1' })
    return [{ key, term: labelOf(ctx, p), order: TUPLE + 'n' + at, pieces }]
  })
}

const descriptionPairs: FnRule = (ctx, focus) => {
  ctx.readsLanguage()
  const o = ctx.out(focus)
  for (const p of pairsOf(ctx, focus)) {
    const pair = o.node('pair-' + p.key)
    o.t(pair, C_PAIR_OF, focus).t(pair, C_TERM, p.term).t(pair, C_PAIR_ORDER, p.order)
    if (p.component) o.t(pair, C_PAIR_COMPONENT, p.component)
    for (const piece of p.pieces) {
      const n = o.node('pair-' + piece.key)
      o.t(n, C_PIECE_OF, pair).t(n, C_PIECE_TEXT, piece.text).t(n, C_PAIR_ORDER, piece.order)
    }
  }
  return o.quads
}

/** The pairs c:DescriptionPairs wrote under the list. */
function writtenPairs(ctx: RuleContext, focus: NamedNode) {
  return ctx.match(null, C_PAIR_OF, focus).map((q) => {
    const pair = q.subject as NamedNode
    const key = pair.value.slice(focus.value.length + '/~pair-'.length)
    const component = ctx.object(pair, C_PAIR_COMPONENT)
    const pieces = ctx.match(null, C_PIECE_OF, pair).map((pq) => ({ node: pq.subject as NamedNode, text: str(ctx.object(pq.subject, C_PIECE_TEXT)) ?? '', order: str(ctx.object(pq.subject, C_PAIR_ORDER)) ?? '' }))
    return { key, term: str(ctx.object(pair, C_TERM)) ?? '', order: str(ctx.object(pair, C_PAIR_ORDER)) ?? '', component: named(component) ? component : undefined, pieces }
  })
}

const descriptionList: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const pairs = writtenPairs(ctx, focus)
  if (!pairs.length) return message(o, 'P', text(ctx, focus, C.emptyText) ?? 'Nothing to describe.')
  const root = o.el('root', ctx.modality === MOD.Text ? 'Div' : 'Dl')
  // Each piece of a value is a text node of its own, in its order (they read as one text):
  // <local><what the piece's key adds to its pair's>.
  const pieces = (p: (typeof pairs)[number], local: string) =>
    p.pieces.map((piece) => {
      const n = o.node(local + piece.node.value.slice(focus.value.length + '/~pair-'.length + p.key.length))
      o.t(n, RDF_TYPE, ctx.nn(H.Text)).t(n, H.data, piece.text).t(n, SEM.orderKey, TUPLE + 'n1' + piece.order)
      return n
    })
  if (ctx.modality === MOD.Text) {
    // Terms padded to the longest (in characters), then the value; without one, the component follows the term.
    const width = Math.max(...pairs.map((p) => [...p.term].length))
    for (const p of pairs) {
      const pair = el(o, `p${p.key}`, 'Div')
      o.t(pair, SEM.orderKey, p.order).t(root, H.hasChild, pair)
      const head = o.text(`p${p.key}-text`, `${p.term}${' '.repeat(width - [...p.term].length)}  `)
      o.t(pair, H.hasChild, head)
      if (p.pieces.length) {
        o.t(head, SEM.orderKey, TUPLE + 'n0')
        for (const n of pieces(p, `p${p.key}-text`)) o.t(pair, H.hasChild, n)
      } else if (p.component) o.t(pair, H.hasChild, p.component).t(head, NS.ord + 'immediatelyPrecedes', p.component)
    }
    o.renders(root)
    return o.quads
  }
  for (const p of pairs) {
    const pair = el(o, `p${p.key}`, 'Div', { class: 'sem-pair' }, [
      el(o, `p${p.key}-dt`, 'Dt', {}, [o.text(`p${p.key}-dt-text`, p.term)]),
      el(o, `p${p.key}-dd`, 'Dd', {}, p.component ? [p.component] : pieces(p, `p${p.key}-dd-text`)),
    ])
    o.t(pair, SEM.orderKey, p.order).t(root, H.hasChild, pair)
  }
  o.renders(root)
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

/** A hue (0-359) derived from a label: the same label always gets the same color (as SPARQL computes it, from MD5). */
export function hueOf(label: string): number {
  return parseInt(md5(label).slice(0, 4), 16) % 360
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
  if (!ctx.object(focus, C.children)) return []
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

/** At most this many events, whatever c:limit says (the SPARQL rule ranks this many newest members). */
const TIMELINE_MAX = 50

/** The newest members of a head-linked stream; one c:TimelineItem per member, keyed by it. */
const timeline: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const stream = ctx.object(focus, C.of)
  if (!named(stream)) return []
  const limit = Math.min(TIMELINE_MAX, Math.max(1, num(ctx, focus, C.limit, 8)))
  const members: NamedNode[] = []
  for (let m = ctx.object(stream, BEH.latest); named(m) && members.length < limit && ctx.object(m, RDF_TYPE); m = ctx.object(m, BEH.previous)) members.push(m)
  if (!members.length) return message(o, ctx.modality === MOD.Text ? 'Div' : 'P', text(ctx, focus, C.emptyText) ?? 'No events yet.')
  const items = members.map((m) => {
    const item = o.node('e-' + md5Key(m.value))
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
 * through c:parentProperty. Open nodes are graph state (c:expandedNode) on the tree. The tree
 * mints the item of its root; each item renders its node and mints the items of its children
 * when it is open (keyed by the path to it, so a node under two parents is two items).
 */
const tree: FnRule = (ctx, focus) => {
  const root = ctx.object(focus, C.of)
  const parent = ctx.object(focus, C_PARENT_PROPERTY)
  if (!named(root) || !named(parent)) return []
  const o = ctx.out(focus)
  const item = treeItemOf(ctx, o, 'n' + md5Key(root.value), focus, root, 1)
  if (ctx.modality === MOD.Text) {
    o.renders(el(o, 'root', 'Div', {}, [item]))
    return o.quads
  }
  const list = el(o, 'root', 'Ul', {}, [item])
  o.attr(list, 'role', 'tree')
  o.attr(list, 'aria-label', text(ctx, focus, C.label) ?? labelOf(ctx, root))
  o.renders(list)
  return o.quads
}

/** Mint the item of a node in a tree, at a level. */
function treeItemOf(ctx: RuleContext, o: Out, local: string, tree: NamedNode, n: NamedNode, level: number, parentItem?: NamedNode): NamedNode {
  const item = o.node(local)
  o.t(item, RDF_TYPE, ctx.nn(C_TREE_ITEM)).t(item, C_IN_TREE, tree).t(item, C.of, n).t(item, C_ITEM_LEVEL, ctx.f.literal(String(level), ctx.nn(XSD_INTEGER)))
  if (parentItem) o.t(item, C_PARENT_ITEM, parentItem)
  return item
}

/**
 * One node of a tree: its row (a twisty or a leaf, the label, the detail, how many children),
 * and, when open, the items of its children, placed by their order key (the label in the viewer's
 * collation, then the IRI). A node already on the path to it has no children here (a cycle).
 */
const treeItem: FnRule = (ctx, focus) => {
  const tree = ctx.object(focus, C_IN_TREE)
  const n = ctx.object(focus, C.of)
  if (!named(tree) || !named(n)) return []
  const parent = ctx.object(tree, C_PARENT_PROPERTY)
  if (!named(parent)) return []
  const o = ctx.out(focus)
  const level = num(ctx, focus, C_ITEM_LEVEL, 1)
  const path = new Set<string>()
  for (let a = ctx.object(focus, C_PARENT_ITEM); named(a); a = ctx.object(a, C_PARENT_ITEM)) {
    const at = ctx.object(a, C.of)
    if (at) path.add(at.value)
  }
  const label = labelOf(ctx, n)
  o.t(focus, SEM.orderKey, TUPLE + 's' + sortKey(label, formatLocale(ctx.languages)) + TUPLE + 's' + n.value)
  const kids = path.has(n.value) ? [] : [...new Set(ctx.match(null, parent, n).map((q) => q.subject).filter(named).map((t) => t.value))]
  const open = kids.length > 0 && ctx.match(tree, C_EXPANDED, n).length > 0
  const target = ctx.object(tree, C.controls)
  const property = ctx.object(tree, C.property)
  const selectable = named(target) && named(property)
  const selected = selectable && ctx.match(target, property, n).length > 0
  const children = open ? kids.map((k) => treeItemOf(ctx, o, 'c' + md5Key(k), tree, ctx.f.namedNode(k), level + 1, focus)) : []
  const group = (tag: string) => {
    const g = el(o, 'group', tag)
    for (const c of children) o.t(g, H.hasChild, c)
    return g
  }
  if (ctx.modality === MOD.Text) {
    const line = `${'  '.repeat(level - 1)}${kids.length ? (open ? '▾ ' : '▸ ') : '  '}${label}${selected ? '  ◂' : ''}`
    o.renders(el(o, 'root', 'Div', {}, [el(o, 'line', 'Div', {}, [o.text('line-text', line)]), ...(open ? [group('Div')] : [])]))
    return o.quads
  }
  const rowParts: NamedNode[] = []
  if (kids.length) {
    const twisty = el(o, 'twisty', 'Button', { type: 'button', class: 'sem-twisty' }, [el(o, 'twisty-icon', 'Span', { 'aria-hidden': 'true' }, [o.text('twisty-text', '▸')])])
    o.attr(twisty, 'aria-label', `${open ? 'Collapse' : 'Expand'} ${label}`)
    o.t(twisty, C_TOGGLES, n)
    rowParts.push(twisty)
  } else rowParts.push(el(o, 'leaf', 'Span', { class: 'sem-leaf', 'aria-hidden': 'true' }))
  const labelEl = el(o, 'label', selectable ? 'Button' : 'Span', { type: selectable ? 'button' : undefined, class: 'sem-label' }, [o.text('label-text', label)])
  if (selectable) o.t(labelEl, C.selects, n)
  // Without selection, the label toggles too (a larger hit area than the twisty).
  else if (kids.length) o.t(labelEl, C_TOGGLES, n)
  rowParts.push(labelEl)
  const detail = ctx.object(tree, C_DETAIL_PROPERTY)
  // The least value, if the node has several.
  const detailValue = named(detail) ? ctx.objects(n, detail).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))[0] : undefined
  const detailText = display(ctx, detailValue)
  if (detailText) rowParts.push(el(o, 'detail', 'Code', { class: 'sem-detail' }, [o.text('detail-text', detailText)]))
  if (kids.length) rowParts.push(el(o, 'count', 'Span', { class: 'sem-count' }, [o.text('count-text', String(kids.length))]))
  const row = el(o, 'row', 'Div', { class: 'sem-row' }, rowParts)
  // A tree that is a drop target receives into each node: its row is the node's zone.
  if (ctx.match(tree, RDF_TYPE, null).some((q) => q.object.value === NS.dnd + 'DropTarget' || q.object.value === NS.dnd + 'Sortable')) o.t(tree, NS.dnd + 'zone', row).t(row, NS.dnd + 'receptacle', n)
  const li = el(o, 'root', 'Li', { style: `--tree-level: ${level - 1}` }, [row, ...(open ? [group('Ul')] : [])])
  if (open) o.attr(o.node('group'), 'role', 'group')
  o.attr(li, 'role', 'treeitem')
  o.attr(li, 'aria-level', String(level))
  if (kids.length) o.attr(li, 'aria-expanded', String(open))
  if (selectable) o.attr(li, 'aria-selected', String(selected))
  o.renders(li)
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
  'data:description-pairs': descriptionPairs,
  'data:stat': stat,
  'data:avatar': avatar,
  'data:avatar-group': avatarGroup,
  'data:timeline': timeline,
  'data:timeline-item': timelineItem,
  'data:tree': tree,
  'data:tree-item': treeItem,
}

export const reactions: Record<string, ReactionFn> = {
  'data:table-sort': tableSort,
  'data:tree-toggle': treeToggle,
}
