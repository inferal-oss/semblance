// Turtle as written (#473): tokens with their places, the statements they make, and edits that
// touch only what changes, so comments, order and layout survive a migration. A lexer shared with
// the SPARQL in literals: its pattern reads both.
import { unquote } from '../view/sparql.ts'
import { NS, RDF_TYPE } from '../ns.ts'

const RDF_FIRST = NS.rdf + 'first'
const RDF_REST = NS.rdf + 'rest'
const RDF_NIL = NS.rdf + 'nil'
const XSD = NS.xsd

export interface Tok {
  k: 'ws' | 'comment' | 'iri' | 'pname' | 'str' | 'bnode' | 'var' | 'lang' | 'dir' | 'num' | 'word' | 'punct'
  text: string
  at: number
  end: number
}

const PN = 'A-Za-z0-9_\\u00B7\\u00C0-\\uFFFF'
const PLX = '%[0-9A-Fa-f]{2}|\\\\[^\\s]'
const LEX = new RegExp(
  [
    '(\\s+)',
    '(#[^\\n]*)',
    '(<[^<>"{}|^`\\\\\\u0000-\\u0020]*>)',
    '("""(?:[^"\\\\]|\\\\[\\s\\S]|"(?!""))*"""|\'\'\'(?:[^\'\\\\]|\\\\[\\s\\S]|\'(?!\'\'))*\'\'\'|"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\')',
    '(_:[' + PN + '.-]*[' + PN + '-])',
    '([?$][' + PN + ']+)',
    '(@(?:prefix|base)\\b)',
    '(@[A-Za-z]+(?:-[A-Za-z0-9]+)*)',
    `((?:[A-Za-z\\u00C0-\\uFFFF](?:[${PN}.-]*[${PN}-])?)?:(?:(?:[${PN}:]|${PLX})(?:(?:[${PN}.:-]|${PLX})*(?:[${PN}:-]|${PLX}))?)?)`,
    '([+-]?(?:\\d+\\.\\d*(?:[eE][+-]?\\d+)?|\\.\\d+(?:[eE][+-]?\\d+)?|\\d+[eE][+-]?\\d+|\\d+))',
    '([A-Za-z_][A-Za-z0-9_]*)',
    '([\\s\\S])',
  ].join('|'),
  'y',
)
const KINDS: Tok['k'][] = ['ws', 'comment', 'iri', 'str', 'bnode', 'var', 'dir', 'lang', 'pname', 'num', 'word', 'punct']

/** Every character is in a token: joining the tokens gives the text back. */
export function lex(text: string): Tok[] {
  const out: Tok[] = []
  LEX.lastIndex = 0
  while (LEX.lastIndex < text.length) {
    const at = LEX.lastIndex
    const m = LEX.exec(text)!
    const k = KINDS[m.slice(1).findIndex((g) => g !== undefined)]!
    let tok: Tok = { k, text: m[0], at, end: LEX.lastIndex }
    // `^^` and the like arrive as single punctuation; `.` ending a number is a statement's end.
    if (k === 'num' && m[0].endsWith('.')) {
      tok = { k, text: m[0].slice(0, -1), at, end: LEX.lastIndex - 1 }
      LEX.lastIndex--
    }
    out.push(tok)
  }
  return out
}

export type Term =
  | { k: 'iri'; v: string }
  | { k: 'bnode'; v: string }
  | { k: 'lit'; value: string; lang?: string; dt?: string; raw: string }

export interface ObjectEntry {
  term: Term
  at: number
  end: number
  /** A [ … ] object's statements. */
  nested?: Entries
  /** Inside a ( … ) collection, which is edited as a whole. */
  list?: boolean
}

export interface PredicateEntry {
  /** The predicate's IRI. */
  p: string
  at: number
  end: number
  objects: ObjectEntry[]
}

export interface Entries {
  subject: Term
  entries: PredicateEntry[]
}

export interface Statement extends Entries {
  at: number
  /** Just after the closing `.`. */
  end: number
}

export interface Triple {
  s: Term
  p: string
  o: Term
  /** Where it was said; undefined for what a collection expands to. */
  statement?: Statement
  entry?: PredicateEntry
  object?: ObjectEntry
}

export interface Doc {
  text: string
  prefixes: Map<string, string>
  statements: Statement[]
  triples: Triple[]
}

export class TurtleSyntaxError extends Error {}
/** RDF 1.2's triple terms, reifiers and annotations: such a file can be renamed in, not edited statement by statement. */
export class UnsupportedTurtle extends TurtleSyntaxError {}

/** Reads what a Turtle document states, with the place of every part. */
export function parseTurtle(text: string, blankPrefix = 'b', inherited?: ReadonlyMap<string, string>): Doc {
  const toks = lex(text).filter((t) => t.k !== 'ws' && t.k !== 'comment')
  for (let n = 0; n < toks.length - 1; n++) {
    const pair = toks[n]!.text + toks[n + 1]!.text
    if (toks[n]!.text === '~' || pair === '{|' || pair === '<<') throw new UnsupportedTurtle(`line ${text.slice(0, toks[n]!.at).split('\n').length}: RDF 1.2 syntax`)
  }
  const prefixes = new Map<string, string>(inherited)
  const statements: Statement[] = []
  const triples: Triple[] = []
  let i = 0
  let blanks = 0
  const fresh = (): Term => ({ k: 'bnode', v: `${blankPrefix}${blanks++}` })
  const fail = (m: string): never => {
    const at = toks[i]?.at ?? text.length
    const line = text.slice(0, at).split('\n').length
    throw new TurtleSyntaxError(`line ${line}: ${m} at "${text.slice(at, at + 20)}"`)
  }
  const peek = (t: string) => toks[i]?.text === t
  const eat = (t: string) => (peek(t) ? (i++, true) : false)
  const iriOf = (t: Tok): string => {
    if (t.k === 'iri') return t.text.slice(1, -1)
    const c = t.text.indexOf(':')
    const ns = prefixes.get(t.text.slice(0, c))
    if (ns === undefined) fail(`unknown prefix ${t.text.slice(0, c)}:`)
    return ns + t.text.slice(c + 1).replace(/\\(.)/g, '$1')
  }
  const named = (labels: Map<string, Term>, t: Tok): Term => {
    let b = labels.get(t.text)
    if (!b) labels.set(t.text, (b = fresh()))
    return b
  }
  const labels = new Map<string, Term>()

  function literal(): Term | undefined {
    const t = toks[i]
    if (!t) return undefined
    if (t.k === 'str') {
      i++
      const lit: Term = { k: 'lit', value: unquote(t.text), raw: t.text }
      if (toks[i]?.k === 'lang') (lit.lang = toks[i]!.text.slice(1)), (lit.raw += toks[i]!.text), i++
      else if (peek('^') && toks[i + 1]?.text === '^') {
        i += 2
        const d = toks[i++]!
        lit.dt = iriOf(d)
        lit.raw += '^^' + d.text
      }
      return lit
    }
    if (t.k === 'num') {
      i++
      return { k: 'lit', value: t.text, dt: XSD + (/[eE]/.test(t.text) ? 'double' : t.text.includes('.') ? 'decimal' : 'integer'), raw: t.text }
    }
    if (t.k === 'word' && (t.text === 'true' || t.text === 'false')) {
      i++
      return { k: 'lit', value: t.text, dt: XSD + 'boolean', raw: t.text }
    }
    return undefined
  }

  function collection(statement: Statement | undefined): Term {
    // at "("
    i++
    const members: Term[] = []
    while (!peek(')')) {
      if (i >= toks.length) fail('unclosed (')
      members.push(object(statement).term)
    }
    i++
    let head: Term = { k: 'iri', v: RDF_NIL }
    for (const m of members.reverse()) {
      const cell = fresh()
      triples.push({ s: cell, p: RDF_FIRST, o: m }, { s: cell, p: RDF_REST, o: head })
      head = cell
    }
    return head
  }

  function object(statement: Statement | undefined): ObjectEntry {
    const t = toks[i]
    if (!t) return fail('expected an object')
    const at = t.at
    if (t.text === '[') {
      i++
      const node = fresh()
      const nested: Entries = { subject: node, entries: [] }
      if (!peek(']')) predicates(nested, statement)
      if (!eat(']')) fail('expected ]')
      return { term: node, at, end: toks[i - 1]!.end, nested }
    }
    if (t.text === '(') {
      const term = collection(statement)
      return { term, at, end: toks[i - 1]!.end, list: true }
    }
    if (t.k === 'iri' || t.k === 'pname') {
      i++
      return { term: { k: 'iri', v: iriOf(t) }, at, end: t.end }
    }
    if (t.k === 'bnode') {
      i++
      return { term: named(labels, t), at, end: t.end }
    }
    const lit = literal()
    if (lit) return { term: lit, at, end: toks[i - 1]!.end }
    return fail('expected an object')
  }

  function predicates(node: Entries, statement: Statement | undefined) {
    for (;;) {
      const t = toks[i]
      if (!t) fail('expected a predicate')
      if (t!.text === '.' || t!.text === ']') return
      if (t!.text === ';') {
        i++
        continue
      }
      let p: string
      if (t!.k === 'word' && t!.text === 'a') p = RDF_TYPE
      else if (t!.k === 'iri' || t!.k === 'pname') p = iriOf(t!)
      else return fail('expected a predicate')
      i++
      const entry: PredicateEntry = { p, at: t!.at, end: t!.end, objects: [] }
      node.entries.push(entry)
      for (;;) {
        const o = object(statement)
        entry.objects.push(o)
        entry.end = o.end
        triples.push({ s: node.subject, p, o: o.term, statement, entry, object: o })
        if (!eat(',')) break
      }
      if (!peek(';')) return
    }
  }

  while (i < toks.length) {
    const t = toks[i]!
    if (t.k === 'dir' || (t.k === 'word' && /^(PREFIX|BASE)$/i.test(t.text))) {
      i++
      if (/prefix/i.test(t.text)) {
        const name = toks[i++]!
        const iri = toks[i++]!
        prefixes.set(name.text.slice(0, name.text.indexOf(':')), iri.text.slice(1, -1))
      } else i++
      if (t.k === 'dir' && !eat('.')) fail('expected .')
      continue
    }
    const statement: Statement = { subject: { k: 'bnode', v: '' }, entries: [], at: t.at, end: t.end }
    if (t.text === '[') {
      const o = object(statement)
      statement.subject = o.term
      statement.entries = o.nested!.entries
      if (!peek('.')) predicates(statement, statement)
    } else if (t.text === '(') {
      statement.subject = collection(statement)
      predicates(statement, statement)
    } else {
      if (t.k === 'iri' || t.k === 'pname') statement.subject = { k: 'iri', v: iriOf(t) }
      else if (t.k === 'bnode') statement.subject = named(labels, t)
      else fail('expected a subject')
      i++
      predicates(statement, statement)
    }
    if (!eat('.')) fail('expected .')
    statement.end = toks[i - 1]!.end
    statements.push(statement)
  }
  return { text, prefixes, statements, triples }
}

/** A term with the prefixes it has at hand, or written in full. */
export function writeIri(iri: string, prefixes: Map<string, string>): string {
  if (iri === RDF_TYPE) return 'a'
  return compactIri(iri, prefixes)
}

export function compactIri(iri: string, prefixes: Map<string, string>, preferred?: string): string {
  const own = preferred === undefined ? undefined : prefixes.get(preferred)
  if (own !== undefined && iri.startsWith(own) && /^[A-Za-z_][\w-]*$/.test(iri.slice(own.length))) return `${preferred}:${iri.slice(own.length)}`
  let best: [string, string] | undefined
  for (const [p, ns] of prefixes) if (iri.startsWith(ns) && (!best || ns.length > best[1].length)) best = [p, ns]
  if (best && /^[A-Za-z_][\w-]*$/.test(iri.slice(best[1].length))) return `${best[0]}:${iri.slice(best[1].length)}`
  return `<${iri}>`
}

export function writeTerm(t: Term, prefixes: Map<string, string>): string {
  if (t.k === 'iri') return compactIri(t.v, prefixes)
  if (t.k === 'bnode') return `_:${t.v}`
  if (t.raw) return t.raw
  const body = /[\n"]/.test(t.value) ? `"""${t.value.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}"""` : JSON.stringify(t.value)
  return body + (t.lang ? `@${t.lang}` : t.dt && t.dt !== XSD + 'string' ? `^^${compactIri(t.dt, prefixes)}` : '')
}

export const tripleKey = (t: { s: Term; p: string; o: Term }) => `${termKey(t.s)} <${t.p}> ${termKey(t.o)}`
export function termKey(t: Term): string {
  if (t.k === 'iri') return `<${t.v}>`
  if (t.k === 'bnode') return `_:${t.v}`
  return `${JSON.stringify(t.value)}@${t.lang ?? ''}^^${t.lang ? '' : (t.dt ?? XSD + 'string')}`
}

/** What to take out of a document and what to add: removed by their places, added beside what they replace. */
export interface Edit {
  remove: Triple[]
  add: { s: Term; p: string; o: Term }[]
}

/**
 * The document after an edit, everything else as written. An added triple goes where the first
 * triple removed from its subject stood, or at the end of a statement about its subject, or as a
 * new statement after the one that points at it.
 */
export function applyEdit(doc: Doc, edit: Edit): string {
  const removed = new Set(edit.remove.map((t) => t.object).filter(Boolean) as ObjectEntry[])
  const pending = new Map<string, { p: string; o: Term }[]>()
  for (const t of edit.add) {
    const k = termKey(t.s)
    const list = pending.get(k)
    if (list) list.push({ p: t.p, o: t.o })
    else pending.set(k, [{ p: t.p, o: t.o }])
  }
  const claimed = new Set<string>()
  const addition = (subject: Term): { p: string; o: Term }[] => {
    const k = termKey(subject)
    if (claimed.has(k)) return []
    claimed.add(k)
    return pending.get(k) ?? []
  }
  const writeAdded = (adds: { p: string; o: Term }[]): string[] => {
    const byP = new Map<string, Term[]>()
    for (const a of adds) byP.set(a.p, [...(byP.get(a.p) ?? []), a.o])
    return [...byP].map(([p, os]) => `${writeIri(p, doc.prefixes)} ${os.map((o) => writeTerm(o, doc.prefixes)).join(' , ')}`)
  }
  const touches = (n: Entries): boolean => n.entries.some((e) => e.objects.some((o) => removed.has(o) || (o.nested && touches(o.nested)))) || pending.has(termKey(n.subject))

  /** The entries of a node as text, each with what stood after it (a separator, and a comment if there was one). */
  const render = (n: Entries): string => {
    const adds = n.entries.some((e) => e.objects.some((o) => removed.has(o))) ? addition(n.subject) : []
    const out: { text: string; gap?: string }[] = []
    let placed = false
    n.entries.forEach((e, i) => {
      const survivors = e.objects.filter((o) => !removed.has(o))
      if (survivors.length < e.objects.length && !placed) {
        placed = true
        out.push(...writeAdded(adds).map((text) => ({ text })))
      }
      if (!survivors.length) return
      const next = n.entries[i + 1]
      const gap = next ? doc.text.slice(e.end, next.at) : undefined
      const changed = survivors.length !== e.objects.length || survivors.some((o) => o.nested && touches(o.nested))
      if (!changed) out.push({ text: doc.text.slice(e.at, e.end), gap })
      else out.push({ text: doc.text.slice(e.at, e.objects[0]!.at) + survivors.map((o) => (o.nested && touches(o.nested) ? `[ ${render(o.nested)} ]` : doc.text.slice(o.at, o.end))).join(' , '), gap })
    })
    const fallback = n.entries.length > 1 && !doc.text.slice(n.entries[0]!.end, n.entries[1]!.at).includes('\n') ? ' ; ' : ' ;\n    '
    return out.map((x, i) => x.text + (i < out.length - 1 ? (x.gap ?? fallback) : '')).join('')
  }

  const replacements: { at: number; end: number; text: string }[] = []
  const after = new Map<number, string[]>()
  for (const s of doc.statements) {
    const whole = s.entries.length > 0 && s.entries.every((e) => e.objects.every((o) => removed.has(o)))
    const hit = touches(s) && (s.entries.some((e) => e.objects.some((o) => removed.has(o) || (o.nested && touches(o.nested)))))
    if (!hit) continue
    if (whole && !pending.has(termKey(s.subject))) {
      let end = s.end
      if (doc.text[end] === '\n') end++
      replacements.push({ at: s.at, end, text: '' })
      continue
    }
    const first = s.entries[0]!
    const last = s.entries[s.entries.length - 1]!
    replacements.push({ at: first.at, end: last.end, text: render(s) })
  }
  // Added triples whose subject has a statement, none of it removed: at that statement's end.
  for (const s of doc.statements) {
    const k = termKey(s.subject)
    if (!pending.has(k) || claimed.has(k)) continue
    const adds = addition(s.subject)
    const last = s.entries[s.entries.length - 1]
    if (!last) continue
    replacements.push({ at: last.end, end: last.end, text: ' ;\n    ' + writeAdded(adds).join(' ;\n    ') })
  }
  // New subjects: a statement after what points at them, or at the end.
  for (const [k, adds] of pending) {
    if (claimed.has(k)) continue
    claimed.add(k)
    const subject = edit.add.find((t) => termKey(t.s) === k)!.s
    const parent = edit.add.find((t) => termKey(t.o) === k)
    const statement = parent && doc.statements.find((s) => termKey(s.subject) === termKey(parent.s))
    const text = `${writeTerm(subject, doc.prefixes)} ${writeAdded(adds).join(' ;\n    ')} .`
    const at = statement?.end ?? doc.text.length
    after.set(at, [...(after.get(at) ?? []), text])
  }
  for (const [at, texts] of after) replacements.push({ at, end: at, text: (doc.text[at - 1] === '\n' ? '' : '\n') + texts.join('\n') + (at === doc.text.length && doc.text.endsWith('\n') ? '\n' : '') })
  replacements.sort((a, b) => a.at - b.at || a.end - b.end)
  let out = ''
  let i = 0
  for (const r of replacements) {
    out += doc.text.slice(i, r.at) + r.text
    i = r.end
  }
  return out + doc.text.slice(i)
}
