// Typeaheads (ontology/components/typeahead.ttl): the two function layers under the SPARQL
// renderings. Labels in the viewer's language and search keys, folded as SPARQL cannot: NFD,
// combining marks removed, lower case, one character for each of the label's.
import type { Term } from '@rdfjs/types'
import type { FnRule, RuleContext } from '../engine/context.ts'
import { L10N, NS, RDF_TYPE, RDFS_RANGE, XSD_BOOLEAN } from '../ns.ts'
import { isTrue, labelOf, rdfList, str, text } from './util.ts'

const c = (local: string) => NS.c + local
const encodeForUri = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())

/**
 * Case- and diacritic-insensitive form of a text that keeps its length in code points: each
 * character is replaced by its base letter, lower-cased, when that is one character (é → e,
 * Ł stays ł), so a match found in the folded text is at the same place in the original.
 */
export function fold(s: string): string {
  let out = ''
  for (const ch of s) {
    const base = ch.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
    if ([...base].length === 1) out += base
    else {
      const lower = ch.toLowerCase()
      out += [...lower].length === 1 ? lower : ch
    }
  }
  return out
}

/** The typeahead's options, as the SPARQL rule c:TypeaheadOptions finds them (order aside). */
function options(ctx: RuleContext, focus: Term, property: Term | undefined): Term[] {
  const explicit = ctx.object(focus, c('options'))
  if (explicit) return rdfList(ctx, explicit)
  const out = new Map<string, Term>()
  const cls = ctx.object(focus, c('optionClass')) ?? (property ? ctx.object(property, RDFS_RANGE) : undefined)
  if (cls) for (const q of ctx.match(null, RDF_TYPE, cls)) if (q.subject.termType === 'NamedNode') out.set(key(q.subject), q.subject)
  if (property && isTrue(ctx.object(focus, c('optionsInUse')))) for (const q of ctx.match(null, property, null)) out.set(key(q.object), q.object)
  return [...out.values()]
}

const key = (t: Term) => (t.termType === 'Literal' ? '"' : '<') + t.value

/** What an option or value is called: a literal is its own text. */
const nameOf = (ctx: RuleContext, t: Term) => (t.termType === 'Literal' ? t.value : labelOf(ctx, t))

/**
 * For each option and each current value, <typeahead>/~term-<term>: what it is called in the
 * viewer's language (l10n:label) and its search key (c:searchKey), whether it is offered (an
 * option) and chosen (a current value). Also the caption (<…>/~l10n-caption) and the phrases.
 */
const texts: FnRule = (ctx, focus) => {
  const property = ctx.object(focus, c('property'))
  const target = ctx.object(focus, c('controls'))
  const o = ctx.out(focus)
  const bool = ctx.f.literal('true', ctx.nn(XSD_BOOLEAN))
  const caption = text(ctx, focus, c('label')) ?? (property ? labelOf(ctx, property) : undefined)
  if (caption !== undefined) o.t(o.node('l10n-caption'), L10N.label, caption)
  for (const [local, phrase] of [['no-matches', 'NoMatches'], ['create', 'CreatePhrase'], ['already-added', 'AlreadyAdded']] as const) {
    const words = text(ctx, ctx.nn(c(phrase)), NS.rdfs + 'label')
    if (words !== undefined) o.t(o.node('l10n-' + local), L10N.label, words)
  }
  const nodes = new Map<string, { term: Term; offered?: boolean; chosen?: boolean }>()
  for (const t of options(ctx, focus, property)) nodes.set(key(t), { term: t, offered: true })
  if (target?.termType === 'NamedNode' && property) {
    for (const v of ctx.objects(target, property)) {
      const n = nodes.get(key(v)) ?? { term: v }
      n.chosen = true
      nodes.set(key(v), n)
    }
  }
  for (const { term, offered, chosen } of nodes.values()) {
    const node = o.node('term-' + encodeForUri(term.value))
    const label = nameOf(ctx, term)
    o.t(node, c('textOf'), focus).t(node, c('textFor'), term).t(node, L10N.label, label).t(node, c('searchKey'), fold(label))
    if (offered) o.t(node, c('offered'), bool)
    if (chosen) o.t(node, c('chosen'), bool)
  }
  return o.quads
}
// The values are read through the controlled node (sem:follows c:controls): the property itself
// is what to watch there, besides where the options come from.
texts.watches = (ctx, focus) => {
  const property = ctx.object(focus, c('property'))
  return new Set([RDF_TYPE, c('label'), c('controls'), c('property'), c('options'), c('optionClass'), c('optionsInUse'), ...(property ? [property.value] : [])])
}

/** The typed text, trimmed and folded: what the options' search keys are matched against. */
const query: FnRule = (ctx, focus) => {
  const typed = str(ctx.object(focus, c('value')))?.trim()
  if (!typed) return []
  return ctx.out(focus).t(focus, c('foldedQuery'), fold(typed)).quads
}

export const typeaheadFunctions: Record<string, FnRule> = { 'typeahead:texts': texts, 'typeahead:query': query }
