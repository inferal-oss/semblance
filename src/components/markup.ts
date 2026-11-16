// Function twins of the element markup's HTML blocks (ontology/components/markup.ttl, #284): the
// rendered element, one element per line, as markup nodes and tokens, as the SPARQL rules state them.
import type { NamedNode, Term } from '@rdfjs/types'
import type { FnRule, RuleContext } from '../engine/context.ts'
import { H, NS, ORD, RDF_TYPE, SEM, XSD_BOOLEAN, XSD_INTEGER } from '../ns.ts'
import { TUPLE } from '../render/order-key.ts'
import { ATTRIBUTE_NAMES } from '../vocab/rdfhtml.generated.ts'
import { hash12, type KeyedToken, type TokenKind } from '../turtle.ts'
import { emitTokens } from './turtle.ts'
import { named, str } from './util.ts'

const C = NS.c
const M = {
  Node: C + 'MarkupNode',
  of: C + 'markupOf',
  view: C + 'markupView',
  depth: C + 'markupDepth',
  key: C + 'markupKey',
  up: C + 'markupUp',
  inline: C + 'markupInline',
} as const
const PROV = NS.prov
const VOID = new Set(['Area', 'Base', 'Br', 'Col', 'Embed', 'Hr', 'Img', 'Input', 'Link', 'Meta', 'Source', 'Track', 'Wbr'].map((c) => H.ns + c))
const NUMERIC = /^[ \t\n\r]*[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]+)?[ \t\n\r]*$/
const trim = (s: string) => s.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '')
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;')
const cpLength = (s: string) => [...s].length
const int = (ctx: RuleContext, n: number) => ctx.f.literal(String(n), ctx.nn(XSD_INTEGER))
const newline = (depth: number) => '\n' + '  '.repeat(depth)
/** Code point order, as SPARQL's MIN compares strings. */
const cpLess = (a: string, b: string) => {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]!.codePointAt(0)! < y[i]!.codePointAt(0)!
  return x.length < y.length
}

/** A node's RDF/HTML or SVG class (not an attribute's). */
const htmlClass = (ctx: RuleContext, n: Term) =>
  ctx.objects(n, RDF_TYPE).find((t) => (t.value.startsWith(H.ns) || t.value.startsWith(NS.svg)) && t.value !== H.Attribute)
const isText = (ctx: RuleContext, n: Term) => ctx.match(n, RDF_TYPE, H.Text).length > 0

/** A rendered node's own element: itself when it has an RDF/HTML or SVG class, else the root that renders it. */
function resolve(ctx: RuleContext, n: Term): Term | undefined {
  return htmlClass(ctx, n) ? n : ctx.match(null, SEM.renders, n)[0]?.subject
}

/** The node an element markup shows, when it is on (c:active) and bound to one. */
export function shownNode(ctx: RuleContext, focus: NamedNode): NamedNode | undefined {
  if (str(ctx.object(focus, C + 'active')) !== 'true') return undefined
  const from = ctx.object(focus, C + 'bindFrom')
  const property = ctx.object(focus, C + 'bindProperty')
  const node = from && property ? ctx.object(from, property) : undefined
  return named(node) ? node : undefined
}

/** The component that rendered a node: its IRI before the first /~. */
export const componentOf = (ctx: RuleContext, node: NamedNode) => (node.value.includes('/~') ? ctx.nn(node.value.slice(0, node.value.indexOf('/~'))) : node)

/** The node shown, as the root markup node, and the "# the element as HTML" line. */
const root: FnRule = (ctx, focus) => {
  const node = shownNode(ctx, focus)
  const r = node && resolve(ctx, node)
  if (!node || !r) return []
  if (isText(ctx, r) && trim(str(ctx.object(r, H.data)) ?? '') === '') return []
  const o = ctx.out(focus)
  const m = ctx.nn(`${focus.value}/~mk-${hash12(r.value)}`)
  o.t(m, RDF_TYPE, ctx.nn(M.Node))
  o.t(m, M.of, r)
  o.t(m, M.view, focus)
  o.t(m, M.depth, int(ctx, 0))
  o.t(m, M.key, TUPLE + 'n3' + TUPLE + 'n1')
  const own = ctx.match(componentOf(ctx, node), null, null).some((q) => !q.predicate.value.startsWith(PROV))
  const lead: [TokenKind, string][] = [
    ['space', '\n\n'],
    ['comment', '# the element as HTML'],
    ['space', '\n'],
  ]
  emitTokens(
    ctx,
    o,
    focus,
    lead.flatMap(([kind, text], i) => (i === 0 && !own ? [] : [{ iri: `${focus.value}/~mc-${i}`, key: [TUPLE + 'n3', 'n0', 'n' + i].join(TUPLE), kind, text }])),
  )
  return o.quads
}

/** A markup node's children: their order keys when they all have one, else their place in the order ord: says. */
const children: FnRule = (ctx, focus) => {
  const e = ctx.object(focus, M.of)
  const view = ctx.object(focus, M.view)
  const depth = Number(ctx.object(focus, M.depth)?.value)
  const key = str(ctx.object(focus, M.key))
  if (!e || !view || key === undefined || Number.isNaN(depth)) return []
  const slots = ctx.objects(e, H.hasChild)
  const keyed = slots.every((c) => ctx.object(c, SEM.orderKey))
  // How many siblings come before each, along ord: edges (either way round).
  const after = new Map<string, Term[]>()
  const edge = (a: Term, b: Term) => (after.get(a.value) ?? after.set(a.value, []).get(a.value)!).push(b)
  for (const a of slots) {
    for (const p of [ORD.immediatelyPrecedes, ORD.precedes]) for (const b of ctx.objects(a, p)) edge(a, b)
    for (const p of [ORD.immediatelyFollows, ORD.follows]) for (const b of ctx.objects(a, p)) edge(b, a)
  }
  const reach = (a: Term): Set<string> => {
    const seen = new Set<string>()
    const todo = [a]
    while (todo.length) for (const b of after.get(todo.pop()!.value) ?? []) if (!seen.has(b.value)) seen.add(b.value), todo.push(b)
    return seen
  }
  const reaches = new Map(slots.map((a) => [a.value, reach(a)]))
  const o = ctx.out(focus)
  for (const c of slots) {
    const r = resolve(ctx, c)
    if (!r) continue
    let place: string
    if (keyed) {
      const k = ctx.object(c, SEM.orderKey)!.value
      place = k.startsWith(TUPLE) ? k.slice(1) : NUMERIC.test(k) ? 'n' + k : 's' + k
    } else place = 'n' + slots.filter((b) => reaches.get(b.value)!.has(c.value)).length
    const child = ctx.nn(`${view.value}/~mk-${hash12(r.value)}`)
    o.t(child, RDF_TYPE, ctx.nn(M.Node))
    o.t(child, M.of, r)
    o.t(child, M.view, view)
    o.t(child, M.depth, int(ctx, depth + 1))
    o.t(child, M.key, [key, 'n1', place, 's', 's' + c.value].join(TUPLE))
    o.t(child, M.up, focus)
  }
  return o.quads
}

/** An element's attributes by name: RDF/HTML's (the least value), else attribute nodes', but the inspector's mark. */
function attributes(ctx: RuleContext, e: Term): [string, string][] {
  const props = new Map<string, string>()
  const nodes = new Map<string, string>()
  const least = (m: Map<string, string>, name: string, value: string) => {
    const had = m.get(name)
    if (had === undefined || cpLess(value, had)) m.set(name, value)
  }
  for (const q of ctx.match(e, null, null)) {
    const p = q.predicate.value
    if (!p.startsWith(H.ns)) continue
    const name = ATTRIBUTE_NAMES[p.slice(H.ns.length)]
    if (name) least(props, name, q.object.value)
  }
  for (const a of ctx.objects(e, H.attribute)) {
    const name = str(ctx.object(a, H.attributeName))
    const value = str(ctx.object(a, H.attributeValue))
    if (name !== undefined && value !== undefined && name !== 'data-sem-highlighted') least(nodes, name, value)
  }
  const out = new Map(nodes)
  for (const [k, v] of props) out.set(k, v)
  return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

const tagOf = (cls: Term | undefined) => {
  if (!cls) return 'sem-unknown'
  if (cls.value.startsWith(H.ns)) return cls.value.slice(H.ns.length).toLowerCase()
  const local = cls.value.slice(cls.value.indexOf('#') + 1)
  return local === 'LinearGradient' ? 'linearGradient' : local.toLowerCase()
}

/** A markup node's lines. */
const tokens: FnRule = (ctx, focus) => {
  const e = ctx.object(focus, M.of)
  const view = ctx.object(focus, M.view)
  const depth = Number(ctx.object(focus, M.depth)?.value)
  const K = str(ctx.object(focus, M.key))
  if (!e || !view || K === undefined || Number.isNaN(depth)) return []
  const o = ctx.out(focus)
  const out: KeyedToken[] = []
  const at = (slot: string, n: string[], kind: TokenKind, text: string) => out.push({ iri: `${focus.value}-${slot}`, key: [K, ...n].join(TUPLE), kind, text })
  const lead = depth > 0 ? newline(depth) : undefined
  if (isText(ctx, e)) {
    const up = ctx.object(focus, M.up)
    const inParentLine = !!up && ctx.objects(up, M.inline).some((v) => v.value === 'true')
    const data = str(ctx.object(e, H.data)) ?? ''
    const trimmed = trim(data)
    if (inParentLine) {
      if (data !== '') at('a1', ['n0', 'n1'], 'punct', escapeText(data))
    } else if (trimmed !== '') {
      if (lead !== undefined) at('a0', ['n0', 'n0'], 'space', lead)
      at('a1', ['n0', 'n1'], 'punct', escapeText(trimmed))
    }
    emitTokens(ctx, o, view, out)
    return o.quads
  }
  const cls = ctx.objects(e, RDF_TYPE).find((t) => (t.value.startsWith(H.ns) || t.value.startsWith(NS.svg)) && t.value !== H.Attribute && t.value !== H.Text)
  const tag = tagOf(cls)
  const isVoid = ctx.objects(e, RDF_TYPE).some((t) => VOID.has(t.value))
  const kids = ctx.match(null, M.up, focus).flatMap((q) => ctx.objects(q.subject, M.of))
  const texts = kids.filter((k) => isText(ctx, k))
  const flat = texts.reduce((n, k) => n + cpLength(escapeText(str(ctx.object(k, H.data)) ?? '')), 0)
  const attrs = attributes(ctx, e)
  const attrLength = attrs.reduce((n, [name, v]) => n + 1 + cpLength(name) + (v === '' ? 0 : 3 + cpLength(escapeAttr(v))), 0)
  const inline = !isVoid && kids.length > 0 && texts.length === kids.length && 2 * depth + 2 + cpLength(tag) + attrLength + flat < 100
  if (inline) o.t(focus, M.inline, ctx.f.literal('true', ctx.nn(XSD_BOOLEAN)))
  const empty = !kids.length && !isVoid
  const closes = !isVoid && !empty
  if (lead !== undefined) at('a0', ['n0', 'n0'], 'space', lead)
  at('a1', ['n0', 'n1'], 'punct', '<')
  at('a2', ['n0', 'n2'], 'keyword', tag)
  for (const [name, v] of attrs) {
    const id = hash12(name)
    const n = (i: number) => [K, 'n0', 'n3', 's' + name, 'n' + i].join(TUPLE)
    out.push({ iri: `${focus.value}-t${id}-0`, key: n(0), kind: 'punct', text: ' ' })
    out.push({ iri: `${focus.value}-t${id}-1`, key: n(1), kind: 'pname', text: name })
    if (v !== '') {
      out.push({ iri: `${focus.value}-t${id}-2`, key: n(2), kind: 'punct', text: '=' })
      out.push({ iri: `${focus.value}-t${id}-3`, key: n(3), kind: 'literal', text: `"${escapeAttr(v)}"` })
    }
  }
  at('a3', ['n0', 'n4'], 'punct', '>')
  if (empty) {
    at('a4', ['n0', 'n5'], 'punct', '</')
    at('a5', ['n0', 'n6'], 'keyword', tag)
    at('a6', ['n0', 'n7'], 'punct', '>')
  }
  if (closes) {
    if (!inline && lead !== undefined) at('z0', ['n2', 'n0'], 'space', lead)
    at('z1', ['n2', 'n1'], 'punct', '</')
    at('z2', ['n2', 'n2'], 'keyword', tag)
    at('z3', ['n2', 'n3'], 'punct', '>')
  }
  emitTokens(ctx, o, view, out)
  return o.quads
}

export const markupFunctions: Record<string, FnRule> = {
  'element-markup:root': root,
  'markup:children': children,
  'markup:tokens': tokens,
}
