// The Turtle printer (#284): triples as syntax-colored Turtle tokens, each with its place as an order
// key (sem:orderKey) and its own node, so one changed triple re-keys only its own tokens. It is one
// model of what the SPARQL building blocks state (ontology/components/turtle.ttl) and their function
// twins (src/components/turtle.ts) emit:
//
//   nodes      what prints a body: a subject (at the top of a section), an inline blank node ([ … ]),
//              a list's cell (( … )); a node per place a blank node prints, under its parent
//   entries    a node's (predicate, object) pairs, in order: rdf:type first, then by the predicate's
//              name's sort key (sortKey(name, "en")) and name, then by the object's printed text
//   tokens     what a node and its entries print, keyed by the node's key, the entry's and a slot
//
// Every blank node shown is inlined (no _: labels); a blank node already printed above (a cycle)
// prints as []. A blank node whose rest chain is rdf:first / rdf:rest cells ending in rdf:nil prints
// as a list. A name is the longest namespace that fits (then the least prefix), else <iri>.
import type { Literal, NamedNode, Quad, Term } from '@rdfjs/types'
import { sortKey } from '../rdf-engine/host/intl.ts'
import { md5 } from './components/data.ts'
import { NS, RDF_FIRST, RDF_NIL, RDF_REST, RDF_TYPE } from './ns.ts'
import { compareKeys, TUPLE } from './render/order-key.ts'

export type TokenKind = 'comment' | 'pname' | 'iri' | 'bnode' | 'literal' | 'number' | 'datatype' | 'lang' | 'keyword' | 'punct' | 'space'
export interface Token {
  kind: TokenKind
  text: string
}
/** A token with its node's IRI and its place (an order key). */
export interface KeyedToken extends Token {
  iri: string
  key: string
}

export interface TurtleSection {
  /** Rendered as a `# comment` line above the section. */
  title?: string
  quads: Quad[]
}

const XSD = NS.xsd
const BARE: Record<string, RegExp> = {
  [XSD + 'integer']: /^[+-]?[0-9]+$/,
  [XSD + 'decimal']: /^[+-]?[0-9]*\.[0-9]+$/,
  [XSD + 'boolean']: /^(true|false)$/,
}
const LOCAL = /^([A-Za-z_][A-Za-z0-9_.-]*)?$/
const NATURAL = /^[0-9]+$/

/** Code point order, as SPARQL compares strings. */
export function cpCompare(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!
    if (d) return d
  }
  return x.length - y.length
}
const cpLength = (s: string) => [...s].length

/** A new line, indented by `depth` steps of four spaces. */
export const newline = (depth: number) => '\n' + '    '.repeat(Math.max(0, depth))

export const hash12 = (s: string) => md5(s).slice(0, 12)

/** The statements a node prints, and what prints inline. */
export interface TurtleSource {
  /** The statements printed under a term. */
  statements(t: Term): { p: NamedNode; o: Term }[]
  /** Objects printed inline besides blank nodes (a result set's solutions and bindings). */
  inline?(p: string, o: Term): boolean
  /** An inline object's place among its siblings when the source orders them (solutions by rs:index). */
  order?(p: string, o: Term): string | undefined
}

/** A node: a subject at the top of a section, or an inline object under its parent's entry. */
export interface TNode {
  iri: string
  /** Its order key (a tuple), which its tokens' keys extend. */
  key: string
  /** The depth its predicates are indented by (an inline node's: childBody, once lists are known). */
  body: number
  term: Term
  /** At the top of a section: "named" (subject ex:s …) or "root" ([ … ] .). */
  top?: 'named' | 'root'
  up?: TNode
  /** The cell whose rdf:rest this node is, when that cell is one (a list's next cell). */
  restOf?: TNode
  /** A top node prints its section's own statements about its subject. */
  own?: { p: NamedNode; o: Term }[]
  /** A list cell: exactly one rdf:first and one rdf:rest, the rest rdf:nil or a node of its own. */
  cell?: boolean
}

export interface TEntry {
  iri: string
  node: TNode
  p: NamedNode
  o: Term
  /** `a`, a prefixed name or <iri>. */
  predText: string
  /** The predicate's sort key and name ("" for rdf:type, which comes first). */
  predSort: string
  predName: string
  sort: string
  key: string
  inline: boolean
  child?: TNode
}

/** How an entry's object prints: its tokens, or the kind of node it is. */
export type ObjectView = Token[] | 'list' | 'bracket' | 'empty'
export interface EntryView {
  iri: string
  key: string
  p: string
  predText: string
  predSort: string
  predName: string
  sort: string
  object: ObjectView
}
export interface NodeView {
  iri: string
  key: string
  body: number
  kind: 'named' | 'root' | 'head' | 'cont' | 'bracket'
  subject?: Token
  entries: EntryView[]
}

/** The tuple key of these components. */
export const tuple = (...parts: string[]) => TUPLE + parts.join(TUPLE)
const extend = (key: string, ...parts: string[]) => key + TUPLE + parts.join(TUPLE)

/** A top node's key: its section, then its subject's place (rank, then its IRI; blank nodes after IRIs). */
export function topKey(section: number, subject: Term, rank?: { missing: number; value: number }): string {
  const s = subject.termType === 'BlankNode' ? '~' + termKey(subject) : termKey(subject)
  return tuple('n1', 'n' + section, 'n1', 'n' + (rank?.missing ?? 0), 'n' + (rank?.value ?? 0), 's' + s)
}

export class TurtlePrinter {
  constructor(
    readonly prefixes: Record<string, string>,
    readonly source: TurtleSource,
    readonly base?: string,
  ) {}

  /** An IRI as a prefixed name: the longest namespace that fits, then the least prefix; else <iri>. */
  name(iri: string): Token {
    let best: [string, string] | undefined
    for (const [p, ns] of Object.entries(this.prefixes)) {
      if (!iri.startsWith(ns) || !LOCAL.test(iri.slice(ns.length))) continue
      const d = best ? cpLength(ns) - cpLength(best[1]) : 1
      if (d > 0 || (d === 0 && cpCompare(p, best![0]) < 0)) best = [p, ns]
    }
    if (best) return { kind: 'pname', text: best[0] + ':' + iri.slice(best[1].length) }
    return { kind: 'iri', text: `<${this.base && iri.startsWith(this.base) ? iri.slice(this.base.length) : iri}>` }
  }

  literal(o: Literal): Token[] {
    const dt = o.datatype?.value
    if (!o.language && dt && BARE[dt]?.test(o.value)) return [{ kind: dt === XSD + 'boolean' ? 'keyword' : 'number', text: o.value }]
    const main: Token = { kind: 'literal', text: o.value.includes('\n') ? `"""${o.value.replace(/"""/g, '\\"\\"\\"')}"""` : JSON.stringify(o.value) }
    if (o.language) return [main, { kind: 'lang', text: '@' + o.language }]
    if (dt && dt !== XSD + 'string') return [main, { kind: 'punct', text: '^^' }, this.name(dt)]
    return [main]
  }

  /** An object that prints in place: a name or a literal. */
  objectTokens(o: Term): Token[] {
    return o.termType === 'Literal' ? this.literal(o) : [this.name(o.value)]
  }

  inline(p: string, o: Term): boolean {
    return o.termType === 'BlankNode' || !!this.source.inline?.(p, o)
  }

  /** Statements of a node, each (predicate, object) once. */
  statements(node: TNode): { p: NamedNode; o: Term }[] {
    const seen = new Set<string>()
    return (node.own ?? this.source.statements(node.term)).filter((s) => {
      const k = s.p.value + ' ' + termKey(s.o)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }

  /** What an inline object says at its first level, for its place among its siblings. */
  signature(o: Term): string {
    const items = new Set<string>()
    const all: string[] = []
    for (const s of this.source.statements(o)) {
      const k = s.p.value + ' ' + termKey(s.o)
      if (items.has(k)) continue
      items.add(k)
      all.push(s.p.value + ' ' + rawKey(s.o, this.inline(s.p.value, s.o)))
    }
    return all.sort(cpCompare).join('\n')
  }

  /** An object's place among its predicate's objects: its printed text (naturals padded to 20 digits). */
  sortText(p: string, o: Term): string {
    if (this.inline(p, o)) return this.source.order?.(p, o) ?? '[' + this.signature(o) + ' ' + termKey(o)
    const text = this.objectTokens(o).map((t) => t.text).join('')
    if (o.termType === 'Literal' && !o.language && o.datatype.value === XSD + 'integer' && NATURAL.test(o.value)) return '0'.repeat(Math.max(0, 20 - o.value.length)) + o.value + ' ' + text
    return text
  }

  /** A node's entries, in no particular order, with a node for each inline object (none for a cycle). */
  entries(node: TNode): TEntry[] {
    const statements = this.statements(node)
    const ancestors = new Set<string>()
    for (let n: TNode | undefined = node; n; n = n.up) ancestors.add(termKey(n.term))
    const cycle = (o: Term) => ancestors.has(termKey(o))
    // A list cell: one rdf:first, one rdf:rest, and the rest rdf:nil or an inline node of its own.
    const rest = statements.filter((s) => s.p.value === RDF_REST)
    node.cell =
      !node.top &&
      statements.length === 2 &&
      statements.some((s) => s.p.value === RDF_FIRST) &&
      rest.length === 1 &&
      (rest[0]!.o.value === RDF_NIL && rest[0]!.o.termType === 'NamedNode' ? true : this.inline(RDF_REST, rest[0]!.o) && !cycle(rest[0]!.o))
    return statements.map((s) => {
      const p = s.p.value
      const predText = p === RDF_TYPE ? 'a' : this.name(p).text
      const predSort = p === RDF_TYPE ? '' : sortKey(predText, 'en')
      const predName = p === RDF_TYPE ? '' : predText
      const sort = this.sortText(p, s.o)
      const iri = node.iri + '-e' + hash12(p + ' ' + termKey(s.o))
      const key = extend(node.key, 'n1', 's' + predSort, 's' + predName, 's' + sort)
      const inline = this.inline(p, s.o)
      const entry: TEntry = { iri, node, p: s.p, o: s.o, predText, predSort, predName, sort, key, inline }
      if (inline && !cycle(s.o)) {
        const continues = node.cell && p === RDF_REST
        entry.child = { iri: iri + '-n', key: extend(key, 'n1'), body: 0, term: s.o, up: node, restOf: continues ? node : undefined }
      }
      return entry
    })
  }
}

/** A term's identity: its IRI, its literal's text with language and datatype, or _: and its blank node's label. */
export function termKey(t: Term): string {
  if (t.termType === 'Literal') return t.value + '@' + t.language + '^^' + t.datatype.value
  return t.termType === 'BlankNode' ? '_:' + t.value : t.value
}

/** How a statement's object counts in its subject's signature: inline objects as []. */
function rawKey(o: Term, inline: boolean): string {
  if (inline) return '[]'
  return o.termType === 'Literal' ? o.value + '@' + o.language + '^^' + o.datatype.value : o.value
}

/**
 * How deep an inline object's node indents its predicates: one step below its parent's, and one more
 * for [ … ] on a line of its own (its predicate's objects wrap); a list's next cell, as its list.
 */
export function childBody(body: number, kind: NodeView['kind'], continues: boolean, object: ObjectView, m: number, wide: number): number {
  if (continues) return body
  const listy = kind === 'head' || kind === 'cont'
  return body + 1 + (!listy && object === 'bracket' && m > 1 && (m > 2 || wide > 0) ? 1 : 0)
}

const cmpEntry = (a: EntryView, b: EntryView) => cpCompare(a.predSort, b.predSort) || cpCompare(a.predName, b.predName) || cpCompare(a.sort, b.sort)

/** The tokens a node prints: its opening and closing, and each entry's. */
export function nodeTokens(node: NodeView): KeyedToken[] {
  const out: KeyedToken[] = []
  const at = (iri: string, key: string, kind: TokenKind, text: string) => out.push({ iri, key, kind, text })
  const K = node.key
  const listy = node.kind === 'head' || node.kind === 'cont'
  if (node.kind === 'named') at(node.iri + '-a0', extend(K, 'n0', 'n0'), node.subject!.kind, node.subject!.text)
  else if (node.kind === 'root' || node.kind === 'bracket') at(node.iri + '-a0', extend(K, 'n0', 'n0'), 'punct', '[')
  else if (node.kind === 'head') at(node.iri + '-a0', extend(K, 'n0', 'n0'), 'punct', '(')
  for (const e of node.entries) {
    const E = e.key
    const object = () => {
      if (Array.isArray(e.object)) e.object.forEach((t, i) => at(`${e.iri}-o${i}`, extend(E, 'n1', 'n0', 'n' + i), t.kind, t.text))
      else if (e.object === 'empty') at(`${e.iri}-o0`, extend(E, 'n1', 'n0', 'n0'), 'punct', '[]')
    }
    if (listy) {
      if (e.p !== RDF_FIRST) continue
      at(`${e.iri}-k4`, extend(E, 'n0', 'n4'), 'space', ' ')
      object()
      continue
    }
    const group = node.entries.filter((x) => x.p === e.p)
    const firstPred = !node.entries.some((x) => x.p !== e.p && (cpCompare(x.predSort, e.predSort) || cpCompare(x.predName, e.predName)) < 0)
    const firstInGroup = !group.some((x) => x !== e && cpCompare(x.sort, e.sort) < 0)
    const wrap = group.length > 2 || group.some((x) => x.object === 'bracket' || x.object === 'empty')
    if (firstInGroup) {
      if (!firstPred) at(`${e.iri}-k0`, extend(E, 'n0', 'n0'), 'punct', ' ;')
      at(`${e.iri}-k1`, extend(E, 'n0', 'n1'), 'space', node.kind === 'named' && firstPred ? ' ' : newline(node.body))
      at(`${e.iri}-k2`, extend(E, 'n0', 'n2'), e.p === RDF_TYPE ? 'keyword' : e.predText.startsWith('<') ? 'iri' : 'pname', e.predText)
    } else at(`${e.iri}-k3`, extend(E, 'n0', 'n3'), 'punct', ',')
    at(`${e.iri}-k4`, extend(E, 'n0', 'n4'), 'space', wrap && group.length > 1 ? newline(node.body + 1) : ' ')
    object()
  }
  if (node.kind === 'named') {
    at(node.iri + '-z0', extend(K, 'n2', 'n0'), 'punct', ' .')
    at(node.iri + '-z1', extend(K, 'n2', 'n1'), 'space', '\n')
  } else if (node.kind === 'root') {
    at(node.iri + '-z0', extend(K, 'n2', 'n0'), 'space', '\n')
    at(node.iri + '-z1', extend(K, 'n2', 'n1'), 'punct', ']')
    at(node.iri + '-z2', extend(K, 'n2', 'n2'), 'punct', ' .')
    at(node.iri + '-z3', extend(K, 'n2', 'n3'), 'space', '\n')
  } else if (node.kind === 'bracket') {
    if (node.entries.length) at(node.iri + '-z0', extend(K, 'n2', 'n0'), 'space', newline(node.body - 1))
    at(node.iri + '-z1', extend(K, 'n2', 'n1'), 'punct', ']')
  } else if (node.kind === 'head') at(node.iri + '-z0', extend(K, 'n2', 'n0'), 'punct', ' )')
  return out
}

/** The header: @base, then the @prefix of each prefix used, by prefix. */
export function headerTokens(view: string, base: string | undefined, used: [string, string][]): KeyedToken[] {
  const out: KeyedToken[] = []
  const at = (iri: string, key: string, kind: TokenKind, text: string) => out.push({ iri, key, kind, text })
  if (base) {
    const parts: [TokenKind, string][] = [['keyword', '@base'], ['space', ' '], ['iri', `<${base}>`], ['punct', ' .'], ['space', '\n']]
    parts.forEach(([kind, text], i) => at(`${view}/~th-b${i}`, tuple('n0', 'n0', 'n' + i), kind, text))
  }
  for (const [p, ns] of [...used].sort((a, b) => cpCompare(a[0], b[0]))) {
    const parts: [TokenKind, string][] = [['keyword', '@prefix'], ['space', ' '], ['pname', p + ':'], ['space', ' '], ['iri', `<${ns}>`], ['punct', ' .'], ['space', '\n']]
    const id = hash12(p)
    parts.forEach(([kind, text], i) => at(`${view}/~th-p${id}-${i}`, tuple('n0', 'n1', 's' + p, 'n' + i), kind, text))
  }
  return out
}

/** A section's lead: a blank line unless it comes first, then its # title. */
export function sectionTokens(view: string, index: number, title: string | undefined, first: boolean): KeyedToken[] {
  const out: KeyedToken[] = []
  const iri = `${view}/~ts-${index}`
  if (!first) out.push({ iri: iri + '-k0', key: tuple('n1', 'n' + index, 'n0', 'n0'), kind: 'space', text: '\n' })
  if (title) {
    out.push({ iri: iri + '-k1', key: tuple('n1', 'n' + index, 'n0', 'n1'), kind: 'comment', text: '# ' + title })
    out.push({ iri: iri + '-k2', key: tuple('n1', 'n' + index, 'n0', 'n2'), kind: 'space', text: '\n' })
  }
  return out
}

/** Statements from quads: a term's triples in all of them. */
export function quadSource(quads: readonly Quad[], extra?: (t: Term) => { p: NamedNode; o: Term }[]): TurtleSource {
  const by = new Map<string, { p: NamedNode; o: Term }[]>()
  for (const q of quads) {
    const k = termKey(q.subject)
    if (!by.has(k)) by.set(k, [])
    by.get(k)!.push({ p: q.predicate as NamedNode, o: q.object })
  }
  return { statements: (t) => [...(by.get(termKey(t)) ?? []), ...(extra?.(t) ?? [])] }
}

/** A whole printed document's tokens in order: the header, then each section's subjects. */
export function printTurtle(
  view: string,
  sections: { title?: string; subjects: { term: Term; own?: { p: NamedNode; o: Term }[]; rank?: { missing: number; value: number } }[] }[],
  printer: TurtlePrinter,
  header: boolean,
): KeyedToken[] {
  const out: KeyedToken[] = []
  const views = new Map<string, NodeView>()
  const nodes: { node: TNode; entries: TEntry[] }[] = []
  const expand = (node: TNode) => {
    const entries = printer.entries(node)
    nodes.push({ node, entries })
    for (const e of entries) if (e.child) expand(e.child)
  }
  sections.forEach((section, i) => {
    for (const s of section.subjects) {
      const root = s.term.termType !== 'NamedNode'
      const key = topKey(i, s.term, s.rank)
      const node: TNode = { iri: `${view}/~tt-${hash12(i + ' ' + termKey(s.term))}`, key, body: 1, term: s.term, top: root ? 'root' : 'named', own: s.own }
      expand(node)
    }
  })
  // Lists: a cell whose rest chain is all cells.
  const byIri = new Map(nodes.map((n) => [n.node.iri, n]))
  const listy = (n: TNode): boolean => {
    for (let m: TNode | undefined = n; m; ) {
      if (!m.cell) return false
      const restEntry: TEntry = byIri.get(m.iri)!.entries.find((e) => e.p.value === RDF_REST)!
      m = restEntry.child
    }
    return true
  }
  // Parents come before their children: each node's depth is known before its children's.
  for (const { node, entries } of nodes) {
    const kind: NodeView['kind'] = node.top ?? (node.restOf && listy(node.restOf) ? 'cont' : listy(node) ? 'head' : 'bracket')
    const subject = node.top === 'named' ? printer.name(node.term.value) : undefined
    const ev = entries.map((e): EntryView => {
      const object: ObjectView = !e.inline ? printer.objectTokens(e.o) : !e.child ? 'empty' : listy(e.child) ? 'list' : 'bracket'
      return { iri: e.iri, key: e.key, p: e.p.value, predText: e.predText, predSort: e.predSort, predName: e.predName, sort: e.sort, object }
    })
    entries.forEach((e, i) => {
      if (!e.child) return
      const group = ev.filter((x) => x.p === e.p.value)
      const wide = group.filter((x) => x.object === 'bracket' || x.object === 'empty').length
      e.child.body = childBody(node.body, kind, !!e.child.restOf, ev[i]!.object, group.length, wide)
    })
    const v: NodeView = { iri: node.iri, key: node.key, body: node.body, kind, subject, entries: ev }
    views.set(node.iri, v)
    out.push(...nodeTokens(v))
  }
  // The prefixes of the names printed.
  const used = new Map<string, string>()
  for (const t of out) {
    const p = t.kind === 'pname' ? t.text.slice(0, t.text.indexOf(':')) : undefined
    if (p !== undefined && printer.prefixes[p] !== undefined) used.set(p, printer.prefixes[p]!)
  }
  const head = header ? headerTokens(view, printer.base, [...used]) : []
  out.push(...head)
  let first = !head.length
  sections.forEach((section, i) => {
    if (!section.subjects.length) return
    out.push(...sectionTokens(view, i, section.title, first))
    first = false
  })
  return out.sort((a, b) => compareKeys(a.key, b.key) || (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0))
}

/** The subjects of a section, each once, as the printer takes them: IRIs, and blank nodes no triple of the document points to. */
export function sectionSubjects(section: TurtleSection, all: readonly Quad[]): { term: Term; own: { p: NamedNode; o: Term }[] }[] {
  const pointed = new Set(all.filter((q) => q.object.termType === 'BlankNode').map((q) => termKey(q.object)))
  const by = new Map<string, { term: Term; own: { p: NamedNode; o: Term }[] }>()
  for (const q of section.quads) {
    const k = termKey(q.subject)
    if (q.subject.termType === 'BlankNode' && pointed.has(k)) continue
    if (!by.has(k)) by.set(k, { term: q.subject, own: [] })
    by.get(k)!.own.push({ p: q.predicate as NamedNode, o: q.object })
  }
  return [...by.values()]
}

/**
 * Pretty-print quads as Turtle tokens grouped by subject, in sections. Blank nodes are inlined as
 * `[ … ]` (lists as `( … )`) wherever they are objects, their triples read from all sections (and
 * `extra`, when given).
 */
export function turtleTokens(sections: TurtleSection[], prefixes: Record<string, string>, base?: string, header = true, extra?: (t: Term) => { p: NamedNode; o: Term }[]): Token[] {
  const all = sections.flatMap((s) => s.quads)
  const printer = new TurtlePrinter(prefixes, quadSource(all, extra), base)
  const shaped = sections.map((s) => ({ title: s.title, subjects: sectionSubjects(s, all) }))
  return printTurtle('urn:x', shaped, printer, header).map(({ kind, text }) => ({ kind, text }))
}

export function toTurtle(sections: TurtleSection[], prefixes: Record<string, string>, base?: string): string {
  return turtleTokens(sections, prefixes, base)
    .map((t) => t.text)
    .join('')
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** HTML with `<span class="ttl-KIND">` around each non-space token. */
export function highlightTurtle(tokens: Token[]): string {
  return tokens.map((t) => (t.kind === 'space' ? t.text : `<span class="ttl-${t.kind}">${escape(t.text)}</span>`)).join('')
}
