// Function rules and reactions for the RDF editor (ontology/components/rdf-editor.ttl): an RDF
// document as a tree of resources, predicates and objects, nested where blank nodes, lists and
// reifiers are. The twins of the SPARQL rules there: same rows, same IRIs, same HTML.
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import type { ReactionFn } from '../behaviour/events.ts'
import type { FnRule, Out, RuleContext } from '../engine/context.ts'
import { H, MOD, NS, VAL, RDF_FIRST, RDF_NIL, RDF_REST, RDF_TYPE, SEM, XSD_BOOLEAN, XSD_INTEGER } from '../ns.ts'
import { el, marked, md5 } from './data.ts'
import { compact } from './reference.ts'
import { named, rdfList, RDFS_LABEL, str, text } from './util.ts'

const C = NS.c
const RDF_REIFIES = NS.rdf + 'reifies'
const XSD = NS.xsd
const C_RDF_TERM = C + 'RdfTerm'
const C_RDF_PROPERTY = C + 'RdfProperty'
const C_TERM = C + 'term'
const C_IN_EDITOR = C + 'inEditor'
const C_DEPTH = C + 'depth'
const C_EDITABLE = C + 'editable'
const C_VALIDATED = C + 'validated'
const SH = NS.sh
const C_SUBJECT = C + 'subjectTerm'
const C_PREDICATE = C + 'predicateTerm'
const C_LIST_CELL = C + 'listCell'
const C_LIST_INDEX = C + 'listIndex'
const C_REIFIER_OF = C + 'reifierOf'
const C_EXPANDED = C + 'expanded'
const C_EXPANDS = C + 'expands'
const C_EXPANDS_TO = C + 'expandsTo'
const C_JUMPS_TO = C + 'jumpsTo'
const C_GOES_TO = C + 'goesTo'
const C_FOCUSED = C + 'focused'
const C_ENTRY = C + 'entry'
const C_CURRENT = C + 'current'
const C_ARROWS = C + 'arrows'
const C_LISTS = C + 'lists'
const C_EDITING = C + 'editing'
const C_ADDING = C + 'adding'
const C_EDITS_ROW = C + 'editsRow'
const C_COMMITS = C + 'commits'
const C_ADDS = C + 'adds'
const C_DRAFT = C + 'draft'
const C_SUGGESTS_FOR = C + 'suggestsFor'
const C_SUGGESTS_PREDICATE = C + 'suggestsPredicate'
const C_SUGGESTS_VALUE = C + 'suggestsValue'
const C_FILLS_WITH = C + 'fillsWith'
const MARKS = [C_EDITING, C_ADDING, C_FOCUSED, C_DRAFT]
const TUPLE = '\u0001'
const BARE = new Set([XSD + 'integer', XSD + 'decimal', XSD + 'double', XSD + 'boolean'])
const KINDS = [NS.rdfs + 'Class', NS.owl + 'Class', NS.rdf + 'Property', NS.owl + 'ObjectProperty', NS.owl + 'DatatypeProperty', NS.owl + 'AnnotationProperty']
const PROPERTY_KINDS = KINDS.slice(2)
const NONE = { add: [], remove: [] }

/** A row's key in its parent's IRI: the first 12 hex digits of the MD5 of what identifies it. */
const key12 = (s: string) => md5(s).slice(0, 12)
const bool = (ctx: RuleContext, v: boolean) => ctx.f.literal(String(v), ctx.nn(XSD_BOOLEAN))
const int = (ctx: RuleContext, n: number) => ctx.f.literal(String(n), ctx.nn(XSD_INTEGER))
const isSkolem = (t: Term) => t.termType === 'BlankNode' || (t.termType === 'NamedNode' && t.value.includes('/.well-known/genid/'))
const strOf = (t: Term) => (t.termType === 'Literal' || t.termType === 'NamedNode' ? t.value : undefined)
const typed = (ctx: RuleContext, t: Term, kinds: string[]) => ctx.untraced(() => kinds.some((k) => ctx.match(t, RDF_TYPE, k).length > 0))

/** A blank node's stand-in for a string: its least "p o" pair (an object without a string is "_"). */
function blankKey(ctx: RuleContext, b: Term): string {
  let min: string | undefined
  for (const q of ctx.match(b, null, null)) {
    const pair = `${q.predicate.value} ${strOf(q.object) ?? '_'}`
    if (min === undefined || pair < min) min = pair
  }
  return '_:' + (min ?? '')
}

/** What identifies an object among its predicate's objects (the SPARQL rule's ?okey). */
function objectKey(ctx: RuleContext, o: Term): string | undefined {
  if (o.termType === 'Literal') return `"${o.value}"` + (o.language ? '@' + o.language : '^^' + o.datatype.value)
  if (o.termType === 'NamedNode') return o.value
  if (o.termType === 'BlankNode') return blankKey(ctx, o)
  if (o.termType === 'Quad') {
    const s = strOf(o.subject)
    return s === undefined ? undefined : `<<${s} ${o.predicate.value} ${strOf(o.object) ?? '_'}>>`
  }
  return undefined
}

/** The reifiers of the statement s p o (read untraced, as the SPARQL rule declares no dependency on them). */
const reifiersOf = (ctx: RuleContext, s: Term, p: Term, o: Term): Term[] =>
  ctx.untraced(() =>
    ctx
      .match(null, RDF_REIFIES, null)
      .filter((q) => q.object.termType === 'Quad' && q.object.subject.equals(s) && q.object.predicate.equals(p) && q.object.object.equals(o))
      .map((q) => q.subject),
  )

/** A label, when it says more than the IRI's local name (ignoring case, spaces, dashes and underscores). */
function saysMore(label: string | undefined, iri: string): string | undefined {
  const plain = (x: string) => x.replace(/[ _-]/g, '').toLowerCase()
  return label !== undefined && plain(label) !== plain(iri.replace(/^.*[#/]/, '')) ? label : undefined
}

/** A phrase in the viewer's language. */
const phrase = (ctx: RuleContext, name: string) => text(ctx, ctx.nn(C + name), RDFS_LABEL) ?? ''

/** The prefixed name of a predicate as its rows sort it: rdf:type first, then by name. */
const predicateKey = (ctx: RuleContext, p: Term) => `${TUPLE}n1${TUPLE}n${p.value === RDF_TYPE ? 0 : 1}${TUPLE}s${compact(ctx, p.value)}`

// --- the editor --------------------------------------------------------------------------------------

/** The root: the tree (named by the editor's label) and the arrows' layer. */
const editor: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  if (ctx.modality === MOD.Text) {
    o.renders(el(o, 'root', 'Div', {}, [el(o, 'tree', 'Div')]))
    return o.quads
  }
  const label = text(ctx, focus, C + 'label')
  const tree = el(o, 'tree', 'Ul', { class: 'sem-tree', role: 'tree', 'aria-label': label })
  o.renders(el(o, 'root', 'Div', {}, [tree, el(o, 'arrows', 'Div', { class: 'sem-arrows' })]))
  return o.quads
}

/** One resource of the document: its row, placed in the tree by its IRI. */
const entry: FnRule = (ctx, focus, member) => {
  if (!member || !named(member)) return []
  const o = ctx.out(focus)
  const row = o.node('t-' + key12(member.value))
  const editable = ctx.match(focus, C_EDITABLE, bool(ctx, true)).length > 0
  const validated = ctx.match(focus, C_VALIDATED, bool(ctx, true)).length > 0
  o.t(o.node('tree'), H.hasChild, row)
  o.t(row, RDF_TYPE, ctx.nn(C_RDF_TERM)).t(row, C_TERM, member).t(row, C_IN_EDITOR, focus).t(row, C_DEPTH, int(ctx, 0))
  o.t(row, C_EDITABLE, bool(ctx, editable)).t(row, C_VALIDATED, bool(ctx, validated)).t(row, SEM.orderKey, member.value)
  return o.quads
}

/** What the editor lists: its resources. */
const listing: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  for (const e of ctx.objects(focus, C_ENTRY)) if (named(e)) o.t(focus, C_LISTS, e)
  return o.quads
}

/** An arrow from each top-level object that is a resource of the document to that resource's row. */
const arrows: FnRule = (ctx, focus) => {
  const mode = ctx.object(focus, C_ARROWS)?.value
  if (mode !== C + 'ArrowsOn' && mode !== C + 'ArrowsCurrent') return []
  const o = ctx.out(focus)
  const current = ctx.object(focus, C_CURRENT)
  const entries = ctx.objects(focus, C_ENTRY).filter(named)
  const isEntry = new Set(entries.map((e) => e.value))
  const layer = o.node('arrows')
  for (const s of entries) {
    for (const q of ctx.match(s, null, null)) {
      const obj = q.object
      if (!named(obj) || obj.equals(s) || !isEntry.has(obj.value)) continue
      const touches = !!current && (s.equals(current) || obj.equals(current))
      if (mode !== C + 'ArrowsOn' && !touches) continue
      const k = `${s.value} ${q.predicate.value} ${obj.value}`
      const arrow = o.node('arrow-' + key12(k))
      const from = ctx.nn(`${focus.value}/~t-${key12(s.value)}/~p-${key12(q.predicate.value)}/~t-${key12(obj.value)}/~label`)
      const to = ctx.nn(`${focus.value}/~t-${key12(obj.value)}/~label`)
      o.t(layer, H.hasChild, arrow)
      o.t(arrow, RDF_TYPE, ctx.nn(C + 'Connector')).t(arrow, C + 'from', from).t(arrow, C + 'to', to).t(arrow, C + 'route', ctx.nn(C + 'Arc'))
      o.t(arrow, NS.sty + 'tone', ctx.nn(NS.sty + 'Accent')).t(arrow, SEM.orderKey, k)
      if (touches) o.t(arrow, NS.sty + 'emphasis', ctx.nn(NS.sty + 'Solid'))
    }
  }
  return o.quads
}

// --- what does not conform (c:validated) ---------------------------------------------------------------

const is = (ctx: RuleContext, s: Term, p: string, o: Term) => ctx.untraced(() => ctx.match(s, p, o).length > 0)

/** The editor's SHACL results (val:EntryShapes) that pass a test: read untraced, as the SPARQL rules declare no dependency on them. */
const results = (ctx: RuleContext, editor: Term, test: (r: Term) => boolean): Term[] =>
  ctx.untraced(() => ctx.objects(editor, VAL.violation)).filter(test)

/** A row's problems, one each (ordered by message), described for its label (aria-invalid, aria-describedby). */
function problemList(ctx: RuleContext, o: Out, focus: NamedNode, label: NamedNode, editing: boolean, found: Term[]): NamedNode {
  const list = el(o, 'problems', 'Span', { class: 'sem-problems', id: o.node('problems').value })
  for (const r of found) {
    const message = ctx.untraced(() => str(ctx.object(r, SH + 'resultMessage'))) ?? ''
    const local = 'problem-' + key12(r.value)
    const item = el(o, local, 'Span', { class: 'sem-problem' }, [o.text(local + '-text', message)])
    o.t(item, SEM.orderKey, message).t(list, H.hasChild, item)
  }
  if (!editing) o.attr(label, 'aria-invalid', 'true').attr(label, 'aria-describedby', list.value)
  return list
}

// --- what the shapes expect (suggestions under an adding field) ----------------------------------------

interface Suggestion {
  label: string
  key: string
  required: boolean
  p?: Term
  v?: Term
}

/** A suggested value as it is written: a name, a number or boolean bare, other literals quoted. */
const valueText = (ctx: RuleContext, v: Term) =>
  v.termType === 'NamedNode' ? compact(ctx, v.value) : v.termType === 'Literal' && BARE.has(v.datatype.value) ? v.value : `"${v.value}"`

/** The property shapes of a node's classes (sh:targetClass, through rdfs:subClassOf). */
function propertyShapes(ctx: RuleContext, node: Term): Term[] {
  const classes = new Set<string>()
  const todo = ctx.objects(node, RDF_TYPE).map((t) => t.value)
  while (todo.length) {
    const c = todo.pop()!
    if (classes.has(c)) continue
    classes.add(c)
    for (const sup of ctx.objects(c, NS.rdfs + 'subClassOf')) todo.push(sup.value)
  }
  return [...classes].flatMap((c) => ctx.match(null, SH + 'targetClass', ctx.nn(c)).flatMap((q) => ctx.objects(q.subject, SH + 'property')))
}

/** Values a property shape names: fixed (sh:hasValue, sh:defaultValue) or allowed (sh:in). */
const namedValues = (ctx: RuleContext, ps: Term): Term[] => [
  ...ctx.objects(ps, SH + 'hasValue'),
  ...ctx.objects(ps, SH + 'defaultValue'),
  ...ctx.objects(ps, SH + 'in').flatMap((l) => rdfList(ctx, l)),
]

/** For a new statement of a resource: its shapes' predicates, alone and with the values they name; if it has no class, the classes shapes target that the document uses. */
function statementSuggestions(ctx: RuleContext, t: Term, editor: Term): Suggestion[] {
  return ctx.untraced(() => {
    const byLabel = new Map<string, Suggestion>()
    const add = (p: Term, v: Term | undefined, required: boolean) => {
      const pText = p.value === RDF_TYPE ? 'a' : compact(ctx, p.value)
      const label = v ? `${pText} ${valueText(ctx, v)}` : pText
      const had = byLabel.get(label)
      const req = required || !!had?.required
      byLabel.set(label, { label, p, v, required: req, key: `${TUPLE}n${req ? 0 : 1}${TUPLE}s${label}` })
    }
    for (const ps of propertyShapes(ctx, t)) {
      const path = ctx.object(ps, SH + 'path')
      if (!named(path)) continue
      const used = ctx.match(t, path.value, null).length > 0
      const max = Number(ctx.object(ps, SH + 'maxCount')?.value)
      if (Number.isFinite(max) && max <= 1 && used) continue
      const required = !used && ctx.objects(ps, SH + 'minCount').some((m) => Number(m.value) >= 1)
      add(path, undefined, required)
      for (const v of namedValues(ctx, ps)) if (!ctx.match(t, path.value, v).length) add(path, v, required)
    }
    if (!ctx.objects(t, RDF_TYPE).length) {
      const used = new Set(ctx.objects(editor, C_ENTRY).flatMap((e) => ctx.objects(e, RDF_TYPE)).map((c) => c.value))
      for (const q of ctx.match(null, SH + 'targetClass', null)) if (named(q.object) && used.has(q.object.value)) add(ctx.nn(RDF_TYPE), q.object, false)
    }
    return [...byLabel.values()]
  })
}

/** For a new object of a predicate: the values its shapes name, and instances of their sh:class (the first 20 by IRI). */
function valueSuggestions(ctx: RuleContext, s: Term, p: Term): Suggestion[] {
  return ctx.untraced(() => {
    const values = new Map<string, Term>()
    for (const ps of propertyShapes(ctx, s)) {
      if (!ctx.object(ps, SH + 'path')?.equals(p)) continue
      for (const v of namedValues(ctx, ps)) values.set(objectKey(ctx, v) ?? v.value, v)
      for (const cls of ctx.objects(ps, SH + 'class'))
        for (const q of ctx.match(null, RDF_TYPE, null))
          if (named(q.subject) && instanceOf(ctx, q.subject, cls.value)) values.set(q.subject.value, q.subject)
    }
    return [...values.values()]
      .filter((v) => !ctx.match(s, p.value, v).length)
      .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
      .slice(0, 20)
      .map((v) => {
        const label = valueText(ctx, v)
        return { label, v, required: false, key: label }
      })
  })
}

/** Whether a node is an instance of a class, through rdfs:subClassOf. */
function instanceOf(ctx: RuleContext, node: Term, cls: string): boolean {
  const seen = new Set<string>()
  const todo = ctx.objects(node, RDF_TYPE).map((t) => t.value)
  while (todo.length) {
    const c = todo.pop()!
    if (c === cls) return true
    if (seen.has(c)) continue
    seen.add(c)
    for (const sup of ctx.objects(c, NS.rdfs + 'subClassOf')) todo.push(sup.value)
  }
  return false
}

// --- fields: editing a term, adding a statement ---------------------------------------------------------

/** A row's term in a field in its place: it takes the focus; Enter commits it (c:commits). */
function field(ctx: RuleContext, o: Out, focus: NamedNode, local: string, marker: string, value: string): NamedNode {
  const input = el(o, local, 'Input', { type: 'text', class: 'sem-label sem-edit', value, 'aria-label': phrase(ctx, 'RdfEditPhrase'), 'data-sem-takes-focus': '' })
  o.t(input, marker, focus)
  return input
}

/** The last item of a row's group: a field for a new object or statement (c:adds), and what the shapes expect under it. */
function addItem(ctx: RuleContext, o: Out, focus: NamedNode, key: string, phraseName: string, options: Suggestion[]): NamedNode {
  const words = phrase(ctx, phraseName)
  const draft = ctx.object(focus, C_DRAFT)?.value
  const input = el(o, 'add', 'Input', { type: 'text', class: 'sem-edit', value: draft, placeholder: words, 'aria-label': words, 'data-sem-takes-focus': '' })
  o.t(input, C_ADDS, focus)
  const list = el(o, 'suggestions', 'Div', { class: 'sem-suggestions', role: 'group', 'aria-label': phrase(ctx, 'RdfSuggestionsPhrase') })
  const wanted = draft?.toLowerCase() ?? ''
  for (const s of options) {
    if (wanted && !s.label.toLowerCase().includes(wanted)) continue
    const local = 'opt-' + key12(s.label)
    const button = el(o, local, 'Button', { type: 'button', class: s.required ? 'sem-option sem-required' : 'sem-option' }, [o.text(local + '-text', s.label)])
    o.t(button, SEM.orderKey, s.key).t(button, C_SUGGESTS_FOR, focus).t(list, H.hasChild, button)
    if (s.p) o.t(button, C_SUGGESTS_PREDICATE, s.p)
    if (s.v) o.t(button, C_SUGGESTS_VALUE, s.v)
    else o.t(button, C_FILLS_WITH, s.label + ' ')
  }
  const item = el(o, 'add-item', 'Li', { class: 'sem-adding' }, [input, list])
  o.t(item, SEM.orderKey, key)
  return item
}

// --- a term at a place -------------------------------------------------------------------------------

interface TermFacts {
  t: Term
  editor: Term
  depth: number
  editable: Term
  validated: Term
  s?: Term
  p?: Term
  reifier: boolean
  lit: boolean
  bare: boolean
  lang: string
  list: boolean
  blank: boolean
  hasStatements: boolean
  reified: boolean
  vocab: boolean
  expandable: boolean
  open: boolean
  nest: boolean
  named?: string
  compactName?: string
  count: number
}

function termFacts(ctx: RuleContext, focus: NamedNode): TermFacts | undefined {
  const t = ctx.object(focus, C_TERM)
  const editor = ctx.object(focus, C_IN_EDITOR)
  if (!t || !editor) return undefined
  const depth = Number(str(ctx.object(focus, C_DEPTH)) ?? 0) || 0
  const editable = ctx.object(focus, C_EDITABLE) ?? bool(ctx, false)
  const validated = ctx.object(focus, C_VALIDATED) ?? bool(ctx, false)
  const s = ctx.object(focus, C_SUBJECT)
  const p = s ? ctx.object(focus, C_PREDICATE) : undefined
  const reifier = !!ctx.object(focus, C_REIFIER_OF)
  const lit = t.termType === 'Literal'
  const dt = lit ? t.datatype.value : undefined
  const lang = lit ? t.language : ''
  const bare = lit && BARE.has(dt!)
  const list = t.value === RDF_NIL || (!lit && ctx.match(t, RDF_FIRST, null).length > 0)
  const blank = isSkolem(t)
  const resource = t.termType === 'NamedNode' || t.termType === 'BlankNode'
  const hasStatements = resource && ctx.match(t, null, null).length > 0
  const reified = !!s && !!p && reifiersOf(ctx, s, p, t).length > 0
  const vocab = t.termType === 'NamedNode' && !blank && typed(ctx, t, KINDS)
  const expandable = (hasStatements && (depth === 0 || !vocab)) || reified
  const own = ctx.object(focus, C_EXPANDED)
  const openByDefault = depth === 0 || blank || list || reifier || reified
  const open = expandable && (own ? own.value === 'true' : openByDefault)
  const nest = open && hasStatements && (depth === 0 || blank || list || reifier || own?.value === 'true')
  const namedIri = t.termType === 'NamedNode' && !blank ? t.value : lit && !bare && lang === '' && dt !== XSD + 'string' ? dt : undefined
  const count = list ? rdfList(ctx, t).length : 0
  return {
    t, editor, depth, editable, validated, s, p, reifier, lit, bare, lang, list, blank, hasStatements, reified, vocab, expandable, open, nest,
    named: namedIri, compactName: namedIri === undefined ? undefined : compact(ctx, namedIri), count,
  }
}

/** The rows under an open term: its list's members, its predicates, the reifiers of its statement. */
function children(ctx: RuleContext, o: Out, focus: NamedNode, f: TermFacts): NamedNode[] {
  if (!f.open) return []
  const out: NamedNode[] = []
  const depth = int(ctx, f.depth + 1)
  const common = (child: NamedNode, cls: string, key: string) => {
    o.t(child, RDF_TYPE, ctx.nn(cls)).t(child, C_IN_EDITOR, f.editor).t(child, C_DEPTH, depth).t(child, C_EDITABLE, f.editable).t(child, C_VALIDATED, f.validated).t(child, SEM.orderKey, key)
    out.push(child)
  }
  if (f.nest && f.list) {
    let i = 0
    for (let cell: Term | undefined = f.t; cell && cell.value !== RDF_NIL && i < 10_000; cell = ctx.object(cell, RDF_REST)) {
      const first = ctx.object(cell, RDF_FIRST)
      if (!first) continue
      i++
      const child = o.node('i-' + i)
      common(child, C_RDF_TERM, `${TUPLE}n0${TUPLE}n${i}`)
      o.t(child, C_TERM, first).t(child, C_LIST_CELL, cell).t(child, C_LIST_INDEX, int(ctx, i))
    }
  } else if (f.nest) {
    const seen = new Set<string>()
    for (const q of ctx.match(f.t, null, null)) {
      const p = q.predicate
      if (seen.has(p.value) || (p.value === RDF_REIFIES && f.reifier)) continue
      seen.add(p.value)
      const child = o.node('p-' + key12(p.value))
      common(child, C_RDF_PROPERTY, predicateKey(ctx, p))
      o.t(child, C_SUBJECT, f.t).t(child, C_PREDICATE, p)
    }
  }
  if (f.reified && f.s && f.p) {
    for (const r of reifiersOf(ctx, f.s, f.p, f.t)) {
      const rkey = r.termType === 'NamedNode' ? r.value : blankKey(ctx, r)
      const child = o.node('r-' + key12(rkey))
      common(child, C_RDF_TERM, `${TUPLE}n2${TUPLE}s${rkey}`)
      o.t(child, C_TERM, r).t(child, C_REIFIER_OF, focus)
    }
  }
  return out
}

const term: FnRule = (ctx, focus) => {
  const f = termFacts(ctx, focus)
  if (!f) return []
  const o = ctx.out(focus)
  const { t } = f
  const kids = children(ctx, o, focus, f)
  if (ctx.modality === MOD.Text) return termText(ctx, o, f, kids)
  // What the term looks like.
  const shownTerm = f.lit
    ? f.bare ? t.value : `"${t.value}"`
    : f.list ? `( ${f.count} )`
    : f.blank ? '[ ]'
    : t.termType === 'NamedNode' ? f.compactName!
    : '<<( … )>>'
  const shown = f.reifier ? '~ ' + shownTerm : shownTerm
  const badge = f.lit && f.lang !== '' ? '@' + f.lang : f.named !== undefined && f.lit ? f.compactName : undefined
  const note = t.termType === 'NamedNode' && !f.blank ? saysMore(text(ctx, t, RDFS_LABEL), t.value) : undefined
  const jumps = f.depth > 0 && t.termType === 'NamedNode' && !f.blank && ctx.untraced(() => ctx.match(f.editor, C_ENTRY, t).length > 0)
  const goes = !jumps && f.vocab
  const link = jumps ? 'resource' : goes ? 'term' : undefined
  const description = f.reifier ? phrase(ctx, 'RdfReifierPhrase') : f.list ? phrase(ctx, 'RdfListPhrase').replace('{n}', String(f.count)) : f.blank ? phrase(ctx, 'RdfNestedPhrase') : undefined
  const kind = f.lit ? 'literal' : f.list ? 'list' : f.blank ? 'blank' : t.termType === 'NamedNode' ? 'iri' : 'triple'
  // The markup.
  const lead = f.expandable
    ? el(o, 'twisty', 'Button', { type: 'button', class: 'sem-twisty', tabIndex: '-1', 'aria-label': `${f.open ? 'Collapse' : 'Expand'} ${shownTerm}` }, [
        el(o, 'twisty-icon', 'Span', { 'aria-hidden': 'true' }, [o.text('twisty-text', '▸')]),
      ])
    : el(o, 'leaf', 'Span', { class: 'sem-leaf', 'aria-hidden': 'true' })
  if (f.expandable) o.t(lead, C_EXPANDS, focus).t(lead, C_EXPANDS_TO, bool(ctx, f.open && !f.nest && f.hasStatements ? true : !f.open))
  const editable = f.editable.value === 'true'
  const editing = editable && (f.lit || (t.termType === 'NamedNode' && !f.blank)) && ctx.match(focus, C_EDITING, bool(ctx, true)).length > 0
  const adding = editable && f.nest && !f.list && ctx.match(focus, C_ADDING, bool(ctx, true)).length > 0
  const focused = ctx.match(focus, C_FOCUSED, bool(ctx, true)).length > 0
  const label = editing ? field(ctx, o, focus, 'edit', C_COMMITS, f.lit ? t.value : f.compactName!) : el(o, 'label', 'Span', { class: `sem-label sem-${kind}`, tabIndex: f.depth === 0 ? '0' : '-1', 'data-sem-link': link, 'data-sem-takes-focus': focused ? '' : undefined, 'aria-description': description }, [
    o.text('label-text', shown),
  ])
  if (!editing) {
    if (jumps) o.t(label, C_JUMPS_TO, t)
    if (goes) o.t(label, C_GOES_TO, t)
    if (editable) o.t(label, C_EDITS_ROW, focus)
  }
  const parts = [lead, label]
  if (badge !== undefined) parts.push(el(o, 'badge', 'Span', { class: 'sem-datatype' }, [o.text('badge-text', badge)]))
  if (note !== undefined) parts.push(el(o, 'note', 'Span', { class: 'sem-note' }, [o.text('note-text', note)]))
  // What does not conform: a value's own problems on its row; a resource's (its node shape's, a
  // required predicate it lacks) on the resource's row.
  const problems =
    f.validated.value !== 'true'
      ? []
      : results(ctx, f.editor, (r) =>
          f.s && f.p
            ? is(ctx, r, SH + 'focusNode', f.s) && is(ctx, r, SH + 'resultPath', f.p) && is(ctx, r, SH + 'value', t)
            : f.depth === 0 && is(ctx, r, SH + 'focusNode', t) && ctx.untraced(() => ctx.objects(r, SH + 'resultPath').every((path) => !ctx.match(t, path, null).length)),
        )
  if (problems.length) parts.push(problemList(ctx, o, focus, label, editing, problems))
  const rows = [el(o, 'row', 'Div', { class: 'sem-row' }, parts)]
  if (f.open) {
    const group = el(o, 'group', 'Ul', { role: 'group' })
    for (const k of kids) o.t(group, H.hasChild, k)
    if (adding) o.t(group, H.hasChild, addItem(ctx, o, focus, `${TUPLE}n9`, 'RdfNewStatementPhrase', statementSuggestions(ctx, t, f.editor)))
    rows.push(group)
  }
  const root = el(o, 'root', 'Li', { class: 'sem-term' + (f.depth === 0 ? ' sem-resource' : '') + (problems.length ? ' sem-invalid' : '') }, rows)
  o.attr(root, 'role', 'treeitem').attr(root, 'aria-level', String(f.depth + 1))
  if (f.expandable) o.attr(root, 'aria-expanded', String(f.open))
  o.renders(root)
  return o.quads
}

/** The Text modality: a Turtle-like outline. */
function termText(ctx: RuleContext, o: Out, f: TermFacts, kids: NamedNode[]): Quad[] {
  const { t } = f
  const literal = () => `"${t.value}"` + (f.lang !== '' ? '@' + f.lang : f.named !== undefined ? '^^' + f.compactName : '')
  const shownTerm = f.lit ? (f.bare ? t.value : literal()) : t.termType === 'NamedNode' && !f.blank ? f.compactName! : f.list ? '(' : f.blank ? '[' : '<<( … )>>'
  const data = f.reifier
    ? `~ ${shownTerm} {|`
    : f.open || !f.expandable || f.depth === 0 || !(f.blank || f.list) ? shownTerm : `${shownTerm} … ${f.list ? ')' : ']'}`
  const block = f.depth === 0
  const tag = block ? 'Div' : 'Span'
  const groupTag = f.list || !f.nest ? 'Span' : 'Div'
  const parts = [el(o, 'line', tag, {}, [o.text('line-text', data)])]
  if (f.open) {
    const group = el(o, 'group', groupTag)
    for (const k of kids) o.t(group, H.hasChild, k)
    parts.push(group)
  }
  const closes = f.open && (f.reifier || (f.depth > 0 && (f.blank || f.list)))
  if (closes) parts.push(el(o, 'close', groupTag, {}, [o.text('close-text', (f.list && !f.reifier ? '' : ' '.repeat(f.reifier ? f.depth - 1 : f.depth)) + (f.reifier ? '|}' : f.list ? ')' : ']'))]))
  o.renders(el(o, 'root', tag, {}, parts))
  return o.quads
}

// --- a predicate of a resource ---------------------------------------------------------------------------

const property: FnRule = (ctx, focus) => {
  const s = ctx.object(focus, C_SUBJECT)
  const p = ctx.object(focus, C_PREDICATE)
  const editor = ctx.object(focus, C_IN_EDITOR)
  if (!s || !p || !editor) return []
  const o = ctx.out(focus)
  const depth = Number(str(ctx.object(focus, C_DEPTH)) ?? 1) || 1
  const editable = ctx.object(focus, C_EDITABLE) ?? bool(ctx, false)
  const validated = ctx.object(focus, C_VALIDATED) ?? bool(ctx, false)
  const own = ctx.object(focus, C_EXPANDED)
  const open = own ? own.value === 'true' : true
  const name = compact(ctx, p.value)
  const shown = p.value === RDF_TYPE ? 'a' : name
  const kids: NamedNode[] = []
  if (open) {
    for (const q of ctx.match(s, p, null)) {
      const okey = objectKey(ctx, q.object)
      if (okey === undefined) continue
      const child = o.node('t-' + key12(okey))
      o.t(child, RDF_TYPE, ctx.nn(C_RDF_TERM)).t(child, C_TERM, q.object).t(child, C_SUBJECT, s).t(child, C_PREDICATE, p).t(child, C_IN_EDITOR, editor)
      o.t(child, C_DEPTH, int(ctx, depth + 1)).t(child, C_EDITABLE, editable).t(child, C_VALIDATED, validated).t(child, SEM.orderKey, okey)
      kids.push(child)
    }
  }
  if (ctx.modality === MOD.Text) {
    const parts = [el(o, 'label', 'Span', {}, [o.text('label-text', ' '.repeat(depth + 1) + shown + (open ? '' : ' …'))])]
    if (open) {
      const group = el(o, 'group', 'Span')
      for (const k of kids) o.t(group, H.hasChild, k)
      parts.push(group)
    }
    o.renders(el(o, 'root', 'Div', {}, parts))
    return o.quads
  }
  const goes = typed(ctx, p, PROPERTY_KINDS)
  const note = p.value === RDF_TYPE ? undefined : saysMore(text(ctx, p, RDFS_LABEL), p.value)
  const lead = el(o, 'twisty', 'Button', { type: 'button', class: 'sem-twisty', tabIndex: '-1', 'aria-label': `${open ? 'Collapse' : 'Expand'} ${shown}` }, [
    el(o, 'twisty-icon', 'Span', { 'aria-hidden': 'true' }, [o.text('twisty-text', '▸')]),
  ])
  o.t(lead, C_EXPANDS, focus).t(lead, C_EXPANDS_TO, bool(ctx, !open))
  const isEditable = editable.value === 'true'
  const editing = isEditable && ctx.match(focus, C_EDITING, bool(ctx, true)).length > 0
  const adding = isEditable && open && ctx.match(focus, C_ADDING, bool(ctx, true)).length > 0
  const label = editing
    ? field(ctx, o, focus, 'edit', C_COMMITS, shown)
    : el(o, 'label', 'Span', { class: 'sem-label sem-predicate', tabIndex: '-1', 'data-sem-link': goes ? 'term' : undefined }, [o.text('label-text', shown)])
  if (!editing && goes) o.t(label, C_GOES_TO, p)
  if (!editing && isEditable) o.t(label, C_EDITS_ROW, focus)
  const parts = [lead, label]
  if (note !== undefined) parts.push(el(o, 'note', 'Span', { class: 'sem-note' }, [o.text('note-text', note)]))
  // Its count problems: too few or too many values.
  const problems =
    validated.value !== 'true'
      ? []
      : results(ctx, editor, (r) => is(ctx, r, SH + 'focusNode', s) && is(ctx, r, SH + 'resultPath', p) && !ctx.untraced(() => ctx.object(r, SH + 'value')))
  if (problems.length) parts.push(problemList(ctx, o, focus, label, editing, problems))
  const rows = [el(o, 'row', 'Div', { class: 'sem-row' }, parts)]
  if (open) {
    const group = el(o, 'group', 'Ul', { role: 'group' })
    for (const k of kids) o.t(group, H.hasChild, k)
    if (adding) o.t(group, H.hasChild, addItem(ctx, o, focus, '\uffff', 'RdfNewObjectPhrase', valueSuggestions(ctx, s, p)))
    rows.push(group)
  }
  const root = el(o, 'root', 'Li', { class: 'sem-property' + (problems.length ? ' sem-invalid' : '') }, rows)
  o.attr(root, 'role', 'treeitem').attr(root, 'aria-level', String(depth + 1)).attr(root, 'aria-expanded', String(open))
  o.renders(root)
  return o.quads
}

// --- reactions -----------------------------------------------------------------------------------------

/** The focus marks (c:focused) on the rows of the editor an event is addressed to. */
const focusMarks = (ctx: Parameters<ReactionFn>[0]): Quad[] =>
  ctx.match(null, C_FOCUSED, null).filter((q) => q.subject.value.startsWith(ctx.target.value + '/~'))

/** A twisty sets its row's c:expanded to what it says. */
const toggle: ReactionFn = (ctx) => {
  const to = marked(ctx, C_EXPANDS_TO)
  const row = marked(ctx, C_EXPANDS)
  if (!to || !row || !ctx.object(row, C_IN_EDITOR)?.equals(ctx.target)) return NONE
  const f = ctx.runtime.store.factory
  return { remove: [...ctx.match(row, C_EXPANDED, null), ...focusMarks(ctx)], add: [f.quad(row as NamedNode, f.namedNode(C_EXPANDED), to)] }
}

/** A link: a resource of the document becomes the current one (its row takes the focus); a term is gone to. */
const follow: ReactionFn = (ctx) => {
  const f = ctx.runtime.store.factory
  const editor = ctx.target
  const withMod = ctx.match(ctx.event, NS.beh + 'modifiers', null).some((q) => `+${q.object.value}+`.includes('+mod+'))
  if (marked(ctx, C_EDITS_ROW) && !withMod) return NONE
  const goes = marked(ctx, C_GOES_TO)
  if (goes) return { remove: [], add: [f.quad(editor, f.namedNode(NS.nav + 'goTo'), goes)] }
  const to = marked(ctx, C_JUMPS_TO)
  if (!to) return NONE
  const focused = focusMarks(ctx)
  const row = f.namedNode(`${editor.value}/~t-${key12(to.value)}`)
  return {
    remove: [...ctx.match(editor, C_CURRENT, null), ...focused],
    add: [f.quad(editor, f.namedNode(C_CURRENT), to), f.quad(row, f.namedNode(C_FOCUSED), f.literal('true', f.namedNode(XSD_BOOLEAN)))],
  }
}

// --- editing ---------------------------------------------------------------------------------------------

type RCtx = Parameters<ReactionFn>[0]
const XSD_STRING = XSD + 'string'

/** The namespace a declared prefix names (the least, when it is declared more than once). */
function namespaceOf(ctx: RCtx, prefix: string): string | undefined {
  let min: string | undefined
  for (const q of ctx.match(null, NS.sh + 'prefix', null)) {
    if (q.object.value !== prefix) continue
    const ns = ctx.object(q.subject, NS.sh + 'namespace')?.value
    if (ns !== undefined && (min === undefined || ns < min)) min = ns
  }
  return min
}

/**
 * The term typed in a field, as Turtle writes it ("text"@lang, "text"^^datatype, a number or a
 * boolean, <iri>, prefix:local); text without quotes keeps the old literal's datatype and language.
 * The SPARQL reactions' parse, step for step.
 */
export function parseTerm(ctx: RCtx, raw: string, old?: Term): Term | undefined {
  const f = ctx.runtime.store.factory
  const text = raw.replace(/^\s+|\s+$/g, '')
  if (text === '') return undefined
  const lang = /^"[^"]*"@[A-Za-z]+(-[A-Za-z0-9]+)*$/.test(text)
  const typed = /^"[^"]*"\^\^[^ ]+$/.test(text)
  const quoted = /^"[^"]*"$/.test(text)
  const inner = text.replace(/^"([^"]*)".*$/, '$1')
  const name = typed ? text.slice(text.indexOf('"^^') + 3) : text
  const iri = /^<[^<>" ]+>$/.test(name)
  const pname = !iri && /^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9_.-]*$/.test(name)
  const ns = pname ? namespaceOf(ctx, name.slice(0, name.indexOf(':'))) : undefined
  const named = iri ? f.namedNode(name.slice(1, -1)) : pname && ns !== undefined ? f.namedNode(ns + name.slice(name.indexOf(':') + 1)) : undefined
  const oldLiteral = old?.termType === 'Literal' ? old : undefined
  if (lang) return f.literal(inner, text.slice(text.indexOf('"@') + 2))
  if (typed && named) return f.literal(inner, named)
  if (quoted) return f.literal(inner)
  if (!typed && named) return named
  if (!oldLiteral && /^[+-]?[0-9]+$/.test(text)) return f.literal(text, f.namedNode(XSD_INTEGER))
  if (!oldLiteral && /^[+-]?[0-9]*\.[0-9]+$/.test(text)) return f.literal(text, f.namedNode(XSD + 'decimal'))
  if (!oldLiteral && (text === 'true' || text === 'false')) return f.literal(text, f.namedNode(XSD_BOOLEAN))
  if (oldLiteral && oldLiteral.language) return f.literal(text, oldLiteral.language)
  if (oldLiteral) return f.literal(text, oldLiteral.datatype.value === XSD_STRING ? undefined : oldLiteral.datatype)
  return f.literal(text)
}

/** A predicate typed in a field: a name, or "a" for rdf:type. */
function parsePredicate(ctx: RCtx, raw: string): NamedNode | undefined {
  const p = parseTerm(ctx, raw)
  if (p?.termType === 'NamedNode') return p
  return p?.value === 'a' ? ctx.runtime.store.factory.namedNode(RDF_TYPE) : undefined
}

/** The key a new object's row is minted under (the SPARQL rules' ?okey, for a literal or an IRI). */
const termKey = (t: Term) => (t.termType === 'Literal' ? `"${t.value}"` + (t.language ? '@' + t.language : '^^' + t.datatype.value) : t.value)

/** The editing marks (c:editing, c:adding, c:focused) on the rows of the editor. */
const marks = (ctx: RCtx): Quad[] => MARKS.flatMap((m) => ctx.match(null, m, null)).filter((q) => q.subject.value.startsWith(ctx.target.value + '/~'))
const inThisEditor = (ctx: RCtx, row: Term | undefined): row is NamedNode => named(row) && !!ctx.object(row, C_IN_EDITOR)?.equals(ctx.target)
const isA = (ctx: RCtx, row: Term, cls: string) => ctx.match(row, RDF_TYPE, ctx.runtime.store.factory.namedNode(cls)).length > 0
const yes = (ctx: RCtx) => ctx.runtime.store.factory.literal('true', ctx.runtime.store.factory.namedNode(XSD_BOOLEAN))
const valueOf = (ctx: RCtx) => ctx.object(ctx.event, NS.beh + 'value')?.value ?? ''

/** Enter or a double click on a row: its term in a field. */
const startEdit: ReactionFn = (ctx) => {
  const row = marked(ctx, C_EDITS_ROW)
  if (!inThisEditor(ctx, row)) return NONE
  const f = ctx.runtime.store.factory
  return { remove: marks(ctx), add: [f.quad(row, f.namedNode(C_EDITING), yes(ctx))] }
}

/** Shift+Enter: a field for a new object (beside an object) or a new statement (on a predicate, a resource). */
const startAdd: ReactionFn = (ctx) => {
  const row = marked(ctx, C_EDITS_ROW)
  if (!inThisEditor(ctx, row)) return NONE
  const f = ctx.runtime.store.factory
  const object = isA(ctx, row, C_RDF_TERM) && !!ctx.object(row, C_SUBJECT)
  const up = object || isA(ctx, row, C_RDF_PROPERTY) ? f.namedNode(row.value.replace(/\/~[tp]-[0-9a-f]{12}$/, '')) : row
  return { remove: marks(ctx), add: [f.quad(up, f.namedNode(C_ADDING), yes(ctx))] }
}

/** Enter in a row's field: the statement (or a predicate's statements) with the new term. */
const commitEdit: ReactionFn = (ctx) => {
  const row = marked(ctx, C_COMMITS)
  if (!inThisEditor(ctx, row)) return NONE
  const f = ctx.runtime.store.factory
  const remove = marks(ctx)
  const add: Quad[] = []
  const focus = (iri: string) => add.push(f.quad(f.namedNode(iri), f.namedNode(C_FOCUSED), yes(ctx)))
  if (isA(ctx, row, C_RDF_TERM)) {
    const old = ctx.object(row, C_TERM)
    const nw = old && parseTerm(ctx, valueOf(ctx), old)
    if (!old || !nw) return { remove, add }
    const s = ctx.object(row, C_SUBJECT)
    const p = s && ctx.object(row, C_PREDICATE)
    const cell = ctx.object(row, C_LIST_CELL)
    if (!nw.equals(old)) {
      if (s && p) remove.push(f.quad(s, p, old))
      if (cell) remove.push(f.quad(cell, f.namedNode(RDF_FIRST), old))
    }
    if (s && p) add.push(f.quad(s, p, nw))
    if (cell) add.push(f.quad(cell, f.namedNode(RDF_FIRST), nw))
    focus(s ? `${row.value.replace(/\/~t-[0-9a-f]{12}$/, '')}/~t-${key12(termKey(nw))}` : row.value)
  } else if (isA(ctx, row, C_RDF_PROPERTY)) {
    const s = ctx.object(row, C_SUBJECT)
    const p = ctx.object(row, C_PREDICATE)
    const np = parsePredicate(ctx, valueOf(ctx))
    if (!s || !p || !np) return { remove, add }
    for (const q of ctx.match(s, p.value, null)) {
      if (!np.equals(p)) remove.push(q)
      add.push(f.quad(s, np, q.object))
    }
    if (add.length) focus(`${row.value.replace(/\/~p-[0-9a-f]{12}$/, '')}/~p-${key12(np.value)}`)
  }
  return { remove, add }
}

/** Enter in an adding field: a new object of the predicate, or a new statement ("predicate value") of the resource. */
const commitAdd: ReactionFn = (ctx) => {
  const row = marked(ctx, C_ADDS)
  if (!inThisEditor(ctx, row)) return NONE
  const f = ctx.runtime.store.factory
  const remove = marks(ctx)
  const add: Quad[] = []
  const raw = valueOf(ctx)
  if (isA(ctx, row, C_RDF_PROPERTY)) {
    const s = ctx.object(row, C_SUBJECT)
    const p = ctx.object(row, C_PREDICATE)
    const nw = parseTerm(ctx, raw)
    if (s && p && nw) add.push(f.quad(s, p, nw), f.quad(f.namedNode(`${row.value}/~t-${key12(termKey(nw))}`), f.namedNode(C_FOCUSED), yes(ctx)))
  } else if (isA(ctx, row, C_RDF_TERM)) {
    const s = ctx.object(row, C_TERM)
    const trimmed = raw.replace(/^\s+/, '')
    const p = parsePredicate(ctx, trimmed.split(' ')[0]!)
    const nw = parseTerm(ctx, trimmed.includes(' ') ? trimmed.slice(trimmed.indexOf(' ') + 1) : '')
    if (s && p && nw) add.push(f.quad(s, p, nw), f.quad(f.namedNode(`${row.value}/~p-${key12(p.value)}`), f.namedNode(C_FOCUSED), yes(ctx)))
  }
  return { remove, add }
}

/** Escape in a field: nothing changes; the focus goes back to its row. */
const cancel: ReactionFn = (ctx) => {
  const f = ctx.runtime.store.factory
  const edited = marked(ctx, C_COMMITS)
  const row = edited ?? marked(ctx, C_ADDS)
  if (!inThisEditor(ctx, row)) return NONE
  return {
    remove: [...ctx.match(row, C_EDITING, null), ...ctx.match(row, C_ADDING, null), ...ctx.match(row, C_DRAFT, null)],
    add: edited ? [f.quad(row, f.namedNode(C_FOCUSED), yes(ctx))] : [],
  }
}

/** Delete on a row: its statement, a predicate's statements, a list member (the list closes up), or a resource. */
const remove: ReactionFn = (ctx) => {
  const row = marked(ctx, C_EDITS_ROW)
  if (!inThisEditor(ctx, row)) return NONE
  const f = ctx.runtime.store.factory
  const out = { remove: marks(ctx), add: [] as Quad[] }
  const s = ctx.object(row, C_SUBJECT)
  const p = ctx.object(row, C_PREDICATE)
  const t = ctx.object(row, C_TERM)
  if (isA(ctx, row, C_RDF_TERM) && s && p && t) out.remove.push(f.quad(s, p, t))
  if (isA(ctx, row, C_RDF_PROPERTY) && s && p) out.remove.push(...ctx.match(s, p.value, null))
  if (isA(ctx, row, C_RDF_TERM) && t && ctx.object(row, C_DEPTH)?.value === '0') {
    out.remove.push(...ctx.match(t, null, null), ...ctx.match(ctx.target, C_ENTRY, t))
  }
  const cell = ctx.object(row, C_LIST_CELL)
  const first = cell && ctx.object(cell, RDF_FIRST)
  const next = cell && ctx.object(cell, RDF_REST)
  if (cell && first && next) {
    out.remove.push(f.quad(cell, f.namedNode(RDF_FIRST), first), f.quad(cell, f.namedNode(RDF_REST), next))
    const prev = ctx.match(null, RDF_REST, cell)
    if (prev.length) for (const q of prev) out.remove.push(q), out.add.push(f.quad(q.subject, q.predicate, next))
    else for (const q of ctx.match(null, null, cell)) out.remove.push(q), out.add.push(f.quad(q.subject, q.predicate, next))
  }
  const up = row.value.replace(/\/~[tpir]-[^/]*$/, '')
  if (up.startsWith(ctx.target.value + '/~')) out.add.push(f.quad(f.namedNode(up), f.namedNode(C_FOCUSED), yes(ctx)))
  return out
}

/** Typing in an adding field narrows its suggestions. */
const draft: ReactionFn = (ctx) => {
  const row = marked(ctx, C_ADDS)
  if (!inThisEditor(ctx, row)) return NONE
  const f = ctx.runtime.store.factory
  return { remove: ctx.match(row, C_DRAFT, null), add: [f.quad(row, f.namedNode(C_DRAFT), f.literal(valueOf(ctx)))] }
}

/** A suggested predicate alone goes into the field, for the value to follow. */
const fill: ReactionFn = (ctx) => {
  const text = marked(ctx, C_FILLS_WITH)
  const row = marked(ctx, C_SUGGESTS_FOR)
  if (!text || !inThisEditor(ctx, row)) return NONE
  const f = ctx.runtime.store.factory
  return { remove: ctx.match(row, C_DRAFT, null), add: [f.quad(row, f.namedNode(C_DRAFT), f.literal(text.value))] }
}

/** A suggestion with its value adds the whole statement. */
const pick: ReactionFn = (ctx) => {
  const v = marked(ctx, C_SUGGESTS_VALUE)
  const row = marked(ctx, C_SUGGESTS_FOR)
  if (!v || !inThisEditor(ctx, row)) return NONE
  const f = ctx.runtime.store.factory
  const out = { remove: marks(ctx), add: [] as Quad[] }
  if (isA(ctx, row, C_RDF_PROPERTY)) {
    const s = ctx.object(row, C_SUBJECT)
    const p = ctx.object(row, C_PREDICATE)
    if (s && p) out.add.push(f.quad(s, p, v), f.quad(row, f.namedNode(C_FOCUSED), yes(ctx)))
  } else {
    const s = ctx.object(row, C_TERM)
    const p = marked(ctx, C_SUGGESTS_PREDICATE)
    if (s && p) out.add.push(f.quad(s, p, v), f.quad(f.namedNode(`${row.value}/~p-${key12(p.value)}`), f.namedNode(C_FOCUSED), yes(ctx)))
  }
  return out
}

export const functions: Record<string, FnRule> = {
  'rdf-editor': editor,
  'rdf-editor:entry': entry,
  'rdf-editor:listing': listing,
  'rdf-editor:arrows': arrows,
  'rdf-editor:term': term,
  'rdf-editor:property': property,
}

export const reactions: Record<string, ReactionFn> = {
  'rdf-editor:toggle': toggle,
  'rdf-editor:follow': follow,
  'rdf-editor:follow-key': (ctx) => (marked(ctx, C_EDITS_ROW) ? NONE : follow(ctx)),
  'rdf-editor:start-edit': startEdit,
  'rdf-editor:start-add': startAdd,
  'rdf-editor:commit-edit': commitEdit,
  'rdf-editor:commit-add': commitAdd,
  'rdf-editor:cancel': cancel,
  'rdf-editor:delete': remove,
  'rdf-editor:draft': draft,
  'rdf-editor:fill': fill,
  'rdf-editor:pick': pick,
}
