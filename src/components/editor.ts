// The code editor's highlighted lines (ontology/components/editor.ttl, #285): its text as a line node
// per line, keyed by the line's content, and each line's tokens, as the SPARQL building blocks state
// them. A keystroke re-tokenizes the line it changes; lines inside a long string are pieces of it.
import type { NamedNode, Term } from '@rdfjs/types'
import { md5 } from './data.ts'
import type { FnRule, RuleContext } from '../engine/context.ts'
import { H, NS, RDF_TYPE, SEM, XSD_INTEGER } from '../ns.ts'
import { TUPLE } from '../render/order-key.ts'
import { matchTokens, QUOTED_PATTERN } from '../sparql-tokens.ts'
import { str } from './util.ts'

const C = NS.c
export const L = {
  Line: C + 'EditorLine',
  of: C + 'lineOf',
  text: C + 'lineText',
  number: C + 'lineNumber',
  stringTo: C + 'lineStringTo',
  stringFrom: C + 'lineStringFrom',
  last: C + 'lineLast',
} as const

const cps = (s: string) => [...s]

/** A line of an editor's text: its content (without the break), place and long-string state. */
export interface EditorLine {
  /** Its local key: the content's MD5 (12 hex digits), then how many lines before it have that content. */
  key: string
  number: number
  text: string
  /** A long string open where the line starts ends this many code points into it (it may run past the line). */
  stringTo?: number
  /** A long string opens at this column (1-based) and runs past the line's end. */
  stringFrom?: number
  last: boolean
}

/** The text's lines (as many as its line breaks, plus one), and where long strings cross them. */
export function editorLines(value: string): EditorLine[] {
  const lines: { text: string; start: number }[] = []
  let at = 1
  for (const m of value.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const text = m[0].endsWith('\n') ? m[0].slice(0, -1) : m[0]
    lines.push({ text, start: at })
    at += cps(m[0]).length
  }
  if (value === '' || value.endsWith('\n')) lines.push({ text: '', start: at })
  // Long strings over lines, as the tokenizer finds them past comments, short strings and IRIs.
  const strings: [number, number][] = []
  let pos = 1
  let last = 0
  for (const m of value.matchAll(new RegExp(QUOTED_PATTERN, 'g'))) {
    pos += cps(value.slice(last, m.index)).length
    last = m.index!
    if (m[2] !== undefined && m[0].includes('\n')) strings.push([pos, pos + cps(m[0]).length])
  }
  const seen = new Map<string, number>()
  return lines.map((l, i) => {
    const ls = l.start
    const le = ls + cps(l.text).length
    const open = strings.find(([s, e]) => s < ls && e > ls)
    const left = strings.find(([s, e]) => s >= ls && s < le && e > le)
    const hash = md5(l.text).slice(0, 12)
    const n = seen.get(hash) ?? 0
    seen.set(hash, n + 1)
    return { key: `${hash}-${n}`, number: i + 1, text: l.text, stringTo: open ? open[1] - ls : undefined, stringFrom: left ? left[0] - ls + 1 : undefined, last: i === lines.length - 1 }
  })
}

/** A piece of a line: where it starts (1-based, code points), its text and kind (text is plain). */
export interface LinePiece {
  pos: number
  text: string
  kind: string
}

const BEFORE_WORD = /[A-Za-z0-9_:?$-]/
const AFTER_WORD = /[A-Za-z0-9_:-]/

/**
 * A line's pieces in its language: SPARQL's and Turtle's tokens (a long string's part as a string),
 * with SPARQL's own words (`words`, lower case) as keywords in any case; any other language's line plain.
 */
export function linePieces(line: Pick<EditorLine, 'text' | 'stringTo' | 'stringFrom'>, language: string, words: ReadonlySet<string>): LinePiece[] {
  const chars = cps(line.text)
  const len = chars.length
  const slice = (from: number, to: number) => chars.slice(from, to).join('')
  if (language !== 'sparql' && language !== 'turtle') return len ? [{ pos: 1, text: line.text, kind: 'text' }] : []
  const out: LinePiece[] = []
  if (line.stringTo !== undefined) {
    const piece = slice(0, Math.min(line.stringTo, len))
    if (piece) out.push({ pos: 1, text: piece, kind: 'string' })
  }
  if (line.stringFrom !== undefined) out.push({ pos: line.stringFrom, text: slice(line.stringFrom - 1, len), kind: 'string' })
  const fs = line.stringTo ?? 0
  const fe = line.stringFrom !== undefined ? line.stringFrom - 1 : len
  if (fe > fs) {
    for (const t of matchTokens(slice(fs, fe), language === 'turtle')) {
      const pos = fs + t.start
      let kind = t.kind
      if (language === 'sparql' && kind === 'text' && (t.group === 'word' || t.group === 'phrase') && words.has(t.text.replace(/[ \t]+/g, ' ').toLowerCase())) {
        const before = chars[pos - 2]
        const after = chars[pos - 1 + cps(t.text).length]
        if (!(before && BEFORE_WORD.test(before)) && !(after && AFTER_WORD.test(after))) kind = 'keyword'
      }
      out.push({ pos, text: t.text, kind })
    }
  }
  return out.sort((a, b) => a.pos - b.pos)
}

/** The text an editor shows: as edited, else as written (c:original). */
export const editorValue = (ctx: RuleContext, editor: Term) => str(ctx.object(editor, C + 'value')) ?? str(ctx.object(editor, C + 'original')) ?? ''

/** An editor's language: its own, else SPARQL for a query editor, else plain text. */
export const editorLanguage = (ctx: RuleContext, editor: Term) =>
  str(ctx.object(editor, C + 'language'))?.toLowerCase() ?? (ctx.match(editor, RDF_TYPE, C + 'QueryEditor').length ? 'sparql' : 'text')

/** SPARQL's own words (c:SparqlWord individuals' labels), lower case. */
export function sparqlWordSet(ctx: RuleContext): Set<string> {
  const out = new Set<string>()
  const classes = new Set<string>()
  const todo = [C + 'SparqlWord']
  while (todo.length) {
    const c = todo.pop()!
    if (classes.has(c)) continue
    classes.add(c)
    for (const q of ctx.match(null, NS.rdfs + 'subClassOf', c)) todo.push(q.subject.value)
  }
  for (const c of classes) for (const q of ctx.match(null, RDF_TYPE, c)) for (const l of ctx.objects(q.subject, NS.rdfs + 'label')) if (l.termType === 'Literal') out.add(l.value.toLowerCase())
  return out
}

const int = (ctx: RuleContext, n: number) => ctx.f.literal(String(n), ctx.nn(XSD_INTEGER))

/** An editor's lines, each a node of its own (a span) in its highlighted text. */
const lines: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const highlight = ctx.nn(`${focus.value}/~highlight`)
  for (const l of editorLines(editorValue(ctx, focus))) {
    const n = ctx.nn(`${focus.value}/~l${l.key}`)
    o.t(highlight, H.hasChild, n)
    o.t(n, RDF_TYPE, ctx.nn(L.Line))
    o.t(n, RDF_TYPE, ctx.nn(H.ns + 'Span'))
    o.t(n, SEM.orderKey, TUPLE + 'n0' + TUPLE + 'n' + l.number)
    o.t(n, L.of, focus)
    o.t(n, L.text, l.text)
    o.t(n, L.number, int(ctx, l.number))
    if (l.stringTo !== undefined) o.t(n, L.stringTo, int(ctx, l.stringTo))
    if (l.stringFrom !== undefined) o.t(n, L.stringFrom, int(ctx, l.stringFrom))
    if (l.last) o.t(n, L.last, ctx.f.literal('true', ctx.nn(NS.xsd + 'boolean')))
  }
  return o.quads
}

/** A line's tokens: text plain, the rest spans of class tok-<kind>; then its line break, unless last. */
const lineTokens: FnRule = (ctx, focus) => {
  const editor = ctx.object(focus, L.of)
  const text = str(ctx.object(focus, L.text))
  if (!editor || text === undefined) return []
  const num = (p: string) => (ctx.object(focus, p) ? Number(ctx.object(focus, p)!.value) : undefined)
  const language = editorLanguage(ctx, editor)
  const o = ctx.out(focus)
  const pieces = linePieces({ text, stringTo: num(L.stringTo), stringFrom: num(L.stringFrom) }, language, language === 'sparql' ? sparqlWordSet(ctx) : new Set())
  for (const p of pieces) {
    const tok = ctx.nn(`${focus.value}-${p.pos}`)
    o.t(focus as NamedNode, H.hasChild, tok)
    o.t(tok, SEM.orderKey, String(p.pos))
    if (p.kind === 'text') {
      o.t(tok, RDF_TYPE, ctx.nn(H.Text))
      o.t(tok, H.data, p.text)
      continue
    }
    const t = ctx.nn(`${focus.value}-${p.pos}-x`)
    o.t(tok, RDF_TYPE, ctx.nn(H.ns + 'Span'))
    o.t(tok, H.ns + 'class', 'tok-' + p.kind)
    o.t(tok, H.hasChild, t)
    o.t(t, RDF_TYPE, ctx.nn(H.Text))
    o.t(t, H.data, p.text)
  }
  if (!ctx.objects(focus, L.last).some((v) => v.value === 'true')) {
    const nl = ctx.nn(`${focus.value}-nl`)
    o.t(focus as NamedNode, H.hasChild, nl)
    o.t(nl, RDF_TYPE, ctx.nn(H.Text))
    o.t(nl, H.data, '\n')
    o.t(nl, SEM.orderKey, String(cps(text).length + 1))
  }
  return o.quads
}

export const editorFunctions: Record<string, FnRule> = {
  'editor:lines': lines,
  'editor:line-tokens': lineTokens,
}
