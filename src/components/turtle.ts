// Function twins of the Turtle printer's building blocks (ontology/components/turtle.ttl, #284): each
// states what its SPARQL rule does, with the model in src/turtle.ts.
import type { NamedNode, Term } from '@rdfjs/types'
import type { FnRule, Out, RuleContext } from '../engine/context.ts'
import { H, NS, RDF_NIL, RDF_REST, RDF_TYPE, RDFS_SUBCLASS, SEM, XSD_BOOLEAN, XSD_INTEGER } from '../ns.ts'
import { type EntryView, type KeyedToken, type NodeView, type ObjectView, childBody, cpCompare, hash12, headerTokens, nodeTokens, sectionTokens, type TNode, topKey, TurtlePrinter, type TurtleSource, termKey } from '../turtle.ts'
import { TUPLE } from '../render/order-key.ts'
import { sortKey } from '../../rdf-engine/host/intl.ts'
import { declaredPrefixes, named, str } from './util.ts'

const C = NS.c
const RS = NS.rs
const PROV = NS.prov
export const T = {
  Node: C + 'TurtleNode',
  Entry: C + 'TurtleEntry',
  Section: C + 'TurtleSection',
  Head: C + 'TurtleHead',
  view: C + 'turtleView',
  term: C + 'turtleTerm',
  top: C + 'turtleTop',
  key: C + 'turtleKey',
  section: C + 'turtleSection',
  index: C + 'turtleIndex',
  title: C + 'turtleTitle',
  body: C + 'turtleBody',
  childBody: C + 'turtleChildBody',
  up: C + 'turtleUp',
  restOf: C + 'turtleRestOf',
  cell: C + 'turtleCell',
  listy: C + 'turtleListy',
  rows: C + 'turtleRows',
  results: C + 'turtleResults',
  limit: C + 'turtleLimit',
  in: C + 'turtleIn',
  child: C + 'turtleChild',
  predicate: C + 'turtlePredicate',
  object: C + 'turtleObject',
  inline: C + 'turtleInline',
  predText: C + 'turtlePredText',
  predSort: C + 'turtlePredSort',
  predName: C + 'turtlePredName',
  sort: C + 'turtleSort',
  entryKey: C + 'turtleEntryKey',
  text: C + 'turtleText',
  kind: C + 'turtleKind',
  lang: C + 'turtleLang',
  datatype: C + 'turtleDatatype',
  uses: C + 'turtleUses',
  into: C + 'turtleInto',
  elides: C + 'turtleElides',
  header: C + 'turtleHeader',
} as const

const truth = (ctx: RuleContext) => ctx.f.literal('true', ctx.nn(XSD_BOOLEAN))
const int = (ctx: RuleContext, n: number) => ctx.f.literal(String(n), ctx.nn(XSD_INTEGER))
const isTrue = (ctx: RuleContext, s: Term, p: string) => ctx.objects(s, p).some((o) => o.termType === 'Literal' && o.value === 'true' && o.datatype.value === XSD_BOOLEAN)
const num = (t: Term | undefined) => (t ? Number(t.value) : undefined)

/** The classes of a node and their superclasses. */
function classes(ctx: RuleContext, n: Term): Term[] {
  const out: Term[] = []
  const todo = ctx.objects(n, RDF_TYPE)
  const seen = new Set<string>()
  while (todo.length) {
    const c = todo.pop()!
    if (seen.has(c.value)) continue
    seen.add(c.value)
    out.push(c)
    todo.push(...ctx.objects(c, RDFS_SUBCLASS))
  }
  return out
}
const classValue = (ctx: RuleContext, view: Term, p: string) => classes(ctx, view).flatMap((c) => ctx.objects(c, p))

/** What a node prints, from its source: the store, a run's rows, or a run as a result set. */
function source(ctx: RuleContext, view: Term, node: Term): TurtleSource {
  const rows = ctx.object(node, T.rows)
  const results = ctx.object(node, T.results)
  const limit = num(ctx.object(node, T.limit))
  const within = (r: Term) => limit === undefined || Number(ctx.object(r, RS + 'index')?.value) <= limit
  const elided = new Set(classValue(ctx, view, T.elides).map((p) => p.value))
  const statements = (t: Term): { p: NamedNode; o: Term }[] => {
    if (rows) {
      const out: { p: NamedNode; o: Term }[] = []
      for (const r of ctx.objects(rows, RS + 'solution')) {
        if (!ctx.object(r, RS + 'index') || !within(r)) continue
        const value = (v: string) => ctx.objects(r, RS + 'binding').find((b) => ctx.object(b, RS + 'variable')?.value === v && ctx.object(b, RS + 'variable')?.termType === 'Literal')
        const s = value('subject')
        const p = value('predicate')
        const o = value('object')
        const sv = s && ctx.object(s, RS + 'value')
        const pv = p && ctx.object(p, RS + 'value')
        const ov = o && ctx.object(o, RS + 'value')
        if (sv && pv?.termType === 'NamedNode' && ov && sv.equals(t)) out.push({ p: pv, o: ov })
      }
      return out
    }
    if (results) {
      return ctx
        .match(t, null, null)
        .filter((q) => (q.predicate.value === RDF_TYPE && q.object.value.startsWith(RS)) || q.predicate.value.startsWith(RS))
        .filter((q) => q.predicate.value !== RS + 'solution' || limit === undefined || !ctx.objects(q.object, RS + 'index').some((i) => Number(i.value) > limit))
        .map((q) => ({ p: q.predicate as NamedNode, o: q.object }))
    }
    return ctx
      .match(t, null, null)
      .filter((q) => !q.predicate.value.startsWith(PROV))
      .map((q) => ({ p: q.predicate as NamedNode, o: elided.has(q.predicate.value) ? ctx.f.literal('…') : q.object }))
  }
  return { statements, inline: (p) => !!results && (p === RS + 'solution' || p === RS + 'binding') }
}

const printerFor = (ctx: RuleContext, view: Term, node: Term) => new TurtlePrinter(declaredPrefixes(ctx), source(ctx, view, node), str(ctx.object(view, C + 'baseIri')))

/** A node as the model takes it, its ancestors linked (for cycles). */
function tnode(ctx: RuleContext, n: NamedNode): TNode | undefined {
  const term = ctx.object(n, T.term)
  if (!term) return undefined
  const top = str(ctx.object(n, T.top)) as TNode['top']
  const up = ctx.object(n, T.up)
  return { iri: n.value, key: '', body: 0, term, top, up: named(up) ? tnode(ctx, up) : undefined }
}

/** Entries: each (predicate, object) a node prints, and a node for each inline object no ancestor prints. */
const entries: FnRule = (ctx, focus) => {
  const view = ctx.object(focus, T.view)
  const node = tnode(ctx, focus)
  if (!view || !node) return []
  const o = ctx.out(focus)
  const printer = printerFor(ctx, view, focus)
  const list = printer.entries(node)
  if (node.cell) o.t(focus, T.cell, truth(ctx))
  const inherited = [T.rows, T.results, T.limit].flatMap((p) => ctx.objects(focus, p).map((v) => [p, v] as const))
  for (const e of list) {
    const iri = ctx.nn(e.iri)
    o.t(iri, RDF_TYPE, ctx.nn(T.Entry))
    o.t(iri, T.in, focus)
    o.t(iri, T.view, view)
    o.t(iri, T.predicate, e.p)
    o.t(iri, T.object, e.o)
    if (e.inline) o.t(iri, T.inline, truth(ctx))
    if (!e.child) continue
    const child = ctx.nn(e.child.iri)
    o.t(iri, T.child, child)
    o.t(child, RDF_TYPE, ctx.nn(T.Node))
    o.t(child, T.view, view)
    o.t(child, T.term, e.o)
    o.t(child, T.up, focus)
    if (e.child.restOf) o.t(child, T.restOf, focus)
    for (const [p, v] of inherited) o.t(child, p, v)
  }
  return o.quads
}

/** A node's order key: a top node's own, else its entry's and n1. */
function nodeKey(ctx: RuleContext, n: Term): string | undefined {
  const top = str(ctx.object(n, T.key))
  if (top !== undefined) return top
  const pointer = ctx.match(null, T.child, n)[0]?.subject
  const up = pointer && str(ctx.object(pointer, T.entryKey))
  return up === undefined ? undefined : up + TUPLE + 'n1'
}

/** A node's depth: a top node's own, else what its entry says. */
function nodeBody(ctx: RuleContext, n: Term): number | undefined {
  const top = num(ctx.object(n, T.body))
  if (top !== undefined) return top
  const pointer = ctx.match(null, T.child, n)[0]?.subject
  return pointer && num(ctx.object(pointer, T.childBody))
}
const listyNode = (ctx: RuleContext, n: Term) => ctx.match(null, T.child, n).some((q) => isTrue(ctx, q.subject, T.listy))

/** Names, sorts, the order key and the depth of an entry's object's node. */
const names: FnRule = (ctx, focus) => {
  const node = ctx.object(focus, T.in)
  const view = ctx.object(focus, T.view)
  const p = ctx.object(focus, T.predicate)
  const obj = ctx.object(focus, T.object)
  if (!named(node) || !view || !named(p) || !obj) return []
  const key = nodeKey(ctx, node)
  if (key === undefined) return []
  const printer = printerFor(ctx, view, node)
  const o = ctx.out(focus)
  const inline = isTrue(ctx, focus, T.inline)
  const predText = p.value === RDF_TYPE ? 'a' : printer.name(p.value).text
  const { predSort, predName } = sortsOf(p.value, predText)
  let sort: string
  if (inline) {
    // Its own entries, inline objects as [] (none for a cycle), or a solution by its rs:index.
    const child = ctx.object(focus, T.child)
    const own = child ? ctx.match(null, T.in, child).map((q) => q.subject) : []
    const index = ctx.object(node, T.results) && p.value === RS + 'solution' ? own.find((y) => ctx.object(y, T.predicate)?.value === RS + 'index') : undefined
    const inlineKey = termKey(obj)
    const indexValue = index && ctx.object(index, T.object)
    if (indexValue) sort = pad(indexValue.value) + ' ' + inlineKey
    else {
      const items = own.map((y) => {
        const yo = ctx.object(y, T.object)!
        const yk = isTrue(ctx, y, T.inline) ? '[]' : yo.termType === 'Literal' ? termKey(yo) : yo.value
        return ctx.object(y, T.predicate)!.value + ' ' + yk
      })
      sort = '[' + items.sort(cpCompare).join('\n') + ' ' + inlineKey
    }
  } else {
    const tokens = printer.objectTokens(obj)
    const main = tokens[0]!
    o.t(focus, T.text, main.text)
    o.t(focus, T.kind, main.kind)
    const lang = tokens.find((t) => t.kind === 'lang')
    if (lang) o.t(focus, T.lang, lang.text)
    if (tokens[1]?.kind === 'punct') o.t(focus, T.datatype, tokens[2]!.text)
    const printed = tokens.map((t) => t.text).join('')
    sort = obj.termType === 'Literal' && !obj.language && obj.datatype.value === NS.xsd + 'integer' && /^[0-9]+$/.test(obj.value) ? pad(obj.value) + ' ' + printed : printed
  }
  o.t(focus, T.predText, predText)
  o.t(focus, T.predSort, predSort)
  o.t(focus, T.predName, predName)
  o.t(focus, T.sort, sort)
  o.t(focus, T.entryKey, key + TUPLE + ['n1', 's' + predSort, 's' + predName, 's' + sort].join(TUPLE))
  const child = ctx.object(focus, T.child)
  const body = nodeBody(ctx, node)
  if (child && body !== undefined) {
    const restOf = ctx.object(node, T.restOf)
    const kind: NodeView['kind'] = str(ctx.object(node, T.top)) ? 'named' : (restOf && listyNode(ctx, restOf)) ? 'cont' : listyNode(ctx, node) ? 'head' : 'bracket'
    const group = ctx.match(null, T.in, node).map((q) => q.subject).filter((e) => ctx.object(e, T.predicate)?.equals(p))
    const wide = group.filter((e) => isTrue(ctx, e, T.inline) && !isTrue(ctx, e, T.listy)).length
    const object: ObjectView = isTrue(ctx, focus, T.listy) ? 'list' : 'bracket'
    o.t(focus, T.childBody, int(ctx, childBody(body, kind, !!ctx.object(child, T.restOf)?.equals(node), object, group.length, wide)))
  }
  return o.quads
}

const pad = (v: string) => '0'.repeat(Math.max(0, 20 - [...v].length)) + v
const sortsOf = (p: string, predText: string) => (p === RDF_TYPE ? { predSort: '', predName: '' } : { predSort: sortKey(predText, 'en'), predName: predText })

/** Lists: a cell whose rest is rdf:nil or a list. */
const lists: FnRule = (ctx, focus) => {
  if (!isTrue(ctx, focus, T.cell)) return []
  const rest = ctx.match(null, T.in, focus).find((q) => ctx.object(q.subject, T.predicate)?.value === RDF_REST)?.subject
  if (!rest) return []
  const ro = ctx.object(rest, T.object)
  if (!((ro?.termType === 'NamedNode' && ro.value === RDF_NIL) || isTrue(ctx, rest, T.listy))) return []
  const o = ctx.out(focus)
  for (const q of ctx.match(null, T.child, focus)) o.t(q.subject, T.listy, truth(ctx))
  return o.quads
}

/** The element a view's tokens go into. */
function into(ctx: RuleContext, view: Term): NamedNode | undefined {
  const local = classValue(ctx, view, T.into)[0]
  return local ? ctx.nn(`${view.value}/~${local.value}`) : undefined
}

/** Tokens put in a view's element (c:turtleInto). */
export function emitTokens(ctx: RuleContext, o: Out, view: Term, tokens: KeyedToken[]) {
  const parent = into(ctx, view)
  if (parent) emit(ctx, o, parent, tokens)
}

/** Tokens as RDF/HTML: plain ones (spaces, punctuation) as text, the others as spans of class ttl-<kind>. */
function emit(ctx: RuleContext, o: Out, parent: NamedNode, tokens: KeyedToken[], view?: Term) {
  for (const t of tokens) {
    const tok = ctx.nn(t.iri)
    o.t(parent, H.hasChild, tok)
    o.t(tok, SEM.orderKey, t.key)
    if (t.kind === 'space' || t.kind === 'punct') {
      o.t(tok, RDF_TYPE, ctx.nn(H.Text))
      o.t(tok, H.data, t.text)
      continue
    }
    const text = ctx.nn(t.iri + '-x')
    o.t(tok, RDF_TYPE, ctx.nn(H.ns + 'Span'))
    o.t(tok, H.ns + 'class', 'ttl-' + t.kind)
    o.t(tok, H.hasChild, text)
    o.t(text, RDF_TYPE, ctx.nn(H.Text))
    o.t(text, H.data, t.text)
    if (view && t.kind === 'pname') o.t(ctx.nn(view.value + '/~th'), T.uses, t.text.slice(0, t.text.indexOf(':')))
  }
}

/** Tokens: what a node prints, opening and closing, and each entry's. */
const tokens: FnRule = (ctx, focus) => {
  const view = ctx.object(focus, T.view)
  const term = ctx.object(focus, T.term)
  const body = nodeBody(ctx, focus)
  const key = nodeKey(ctx, focus)
  const parent = view && into(ctx, view)
  if (!view || !term || body === undefined || key === undefined || !parent) return []
  const printer = printerFor(ctx, view, focus)
  const top = str(ctx.object(focus, T.top)) as 'named' | 'root' | undefined
  const restOf = ctx.object(focus, T.restOf)
  const kind: NodeView['kind'] = top ?? (restOf && listyNode(ctx, restOf) ? 'cont' : listyNode(ctx, focus) ? 'head' : 'bracket')
  const entryViews: EntryView[] = []
  for (const q of ctx.match(null, T.in, focus)) {
    const e = q.subject
    const p = ctx.object(e, T.predicate)
    const predText = str(ctx.object(e, T.predText))
    const predSort = str(ctx.object(e, T.predSort))
    const predName = str(ctx.object(e, T.predName))
    const sort = str(ctx.object(e, T.sort))
    const entryKey = str(ctx.object(e, T.entryKey))
    if (!p || predText === undefined || predSort === undefined || predName === undefined || sort === undefined || entryKey === undefined) continue
    let object: ObjectView
    if (isTrue(ctx, e, T.inline)) object = ctx.object(e, T.child) ? (isTrue(ctx, e, T.listy) ? 'list' : 'bracket') : 'empty'
    else {
      const text = str(ctx.object(e, T.text))
      const k = str(ctx.object(e, T.kind))
      const lang = str(ctx.object(e, T.lang))
      const dt = str(ctx.object(e, T.datatype))
      object = text === undefined || k === undefined ? [] : [{ kind: k as never, text }]
      if (lang !== undefined) object.push({ kind: 'lang', text: lang })
      else if (dt !== undefined) object.push({ kind: 'punct', text: '^^' }, { kind: dt.startsWith('<') ? 'iri' : 'pname', text: dt })
    }
    entryViews.push({ iri: e.value, key: entryKey, p: p.value, predText, predSort, predName, sort, object })
  }
  const subject = top === 'named' ? printer.name(term.value) : undefined
  const o = ctx.out(focus)
  emit(ctx, o, parent, nodeTokens({ iri: focus.value, key, body, kind, subject, entries: entryViews }), view)
  return o.quads
}

/** The header and the sections of a view. */
const header: FnRule = (ctx, focus) => {
  const view = ctx.object(focus, T.view)
  const parent = view && into(ctx, view)
  if (!named(view) || !parent) return []
  const o = ctx.out(focus)
  const headed = classValue(ctx, view, T.header).some((v) => v.value === 'true')
  const prefixes = declaredPrefixes(ctx)
  const used = headed
    ? ctx
        .objects(focus, T.uses)
        .map((p) => p.value)
        .filter((p) => prefixes[p] !== undefined)
        .map((p): [string, string] => [p, prefixes[p]!])
    : []
  const head = headed ? headerTokens(view.value, str(ctx.object(view, C + 'baseIri')), used) : []
  const sections = ctx
    .match(null, T.view, view)
    .map((q) => q.subject)
    .filter((s) => ctx.match(s, RDF_TYPE, T.Section).length && ctx.match(null, T.section, s).some((q) => ctx.match(null, T.in, q.subject).length))
    .map((s) => ({ index: num(ctx.object(s, T.index))!, title: str(ctx.object(s, T.title)) }))
    .sort((a, b) => a.index - b.index)
  const out = [...head, ...sections.flatMap((s, i) => sectionTokens(view.value, s.index, s.title, !head.length && i === 0))]
  emit(ctx, o, parent, out)
  return o.quads
}

export const turtleFunctions: Record<string, FnRule> = {
  'turtle:entries': entries,
  'turtle:names': names,
  'turtle:lists': lists,
  'turtle:tokens': tokens,
  'turtle:header': header,
}

/** A top node of a view (what its own block mints): a subject at the top of a section. */
export function topNode(
  ctx: RuleContext,
  o: Out,
  index: number,
  subject: Term,
  opts: { root?: boolean; rows?: Term; results?: Term; limit?: number; rank?: { missing: number; value: number; lexical?: string } } = {},
): NamedNode {
  const view = o.focus
  const n = ctx.nn(`${view.value}/~tt-${hash12(index + ' ' + termKey(subject))}`)
  o.t(n, RDF_TYPE, ctx.nn(T.Node))
  o.t(n, T.view, view)
  o.t(n, T.term, subject)
  o.t(n, T.key, topKey(index, subject, opts.rank))
  o.t(n, T.body, int(ctx, 1))
  o.t(n, T.top, opts.root || subject.termType === 'BlankNode' ? 'root' : 'named')
  o.t(n, T.section, ctx.nn(`${view.value}/~ts-${index}`))
  if (opts.rows) o.t(n, T.rows, opts.rows)
  if (opts.results) o.t(n, T.results, opts.results)
  if (opts.limit !== undefined) o.t(n, T.limit, int(ctx, opts.limit))
  return n
}

/** A section of a view: its place and # title (and the view's header, once). */
export function section(ctx: RuleContext, o: Out, index: number, title?: string) {
  const head = ctx.nn(`${o.focus.value}/~th`)
  o.t(head, RDF_TYPE, ctx.nn(T.Head))
  o.t(head, T.view, o.focus)
  const s = ctx.nn(`${o.focus.value}/~ts-${index}`)
  o.t(s, RDF_TYPE, ctx.nn(T.Section))
  o.t(s, T.view, o.focus)
  o.t(s, T.index, int(ctx, index))
  if (title !== undefined) o.t(s, T.title, title)
}
