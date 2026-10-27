// Helpers shared by component rules. Labels go through text() so the
// localization layer (ctx.languages) applies to every component alike.
import type { NamedNode, Term } from '@rdfjs/types'
import type { RuleContext } from '../engine/context.ts'
import { C, NS, RDF_FIRST, RDF_NIL, RDF_REST, RDF_TYPE, RDFS_SUBCLASS } from '../ns.ts'

export const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label'
export const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment'
const SH = 'http://www.w3.org/ns/shacl#'

export const str = (t: Term | undefined) => t?.value
export const isTrue = (t: Term | undefined) => t?.termType === 'Literal' && t.value === 'true'
export const named = (t: Term | undefined): t is NamedNode => t?.termType === 'NamedNode'

/** A number-valued property, or `fallback`. */
export function num(ctx: RuleContext, s: Term, p: string, fallback: number): number {
  const v = Number(str(ctx.object(s, p)))
  return Number.isFinite(v) ? v : fallback
}

/** The members of an RDF list (bounded, so a cyclic list cannot hang a rule or a reaction). */
export function rdfList(ctx: { object(s: Term, p: string): Term | undefined }, head: Term | undefined): Term[] {
  const out: Term[] = []
  for (let n = head; n && n.value !== RDF_NIL && out.length < 10_000; n = ctx.object(n, RDF_REST)) {
    const first = ctx.object(n, RDF_FIRST)
    if (first) out.push(first)
  }
  return out
}

/** The named nodes of an RDF list. */
export const nodes = (ctx: RuleContext, head: Term | undefined): NamedNode[] => rdfList(ctx, head).filter(named)

/**
 * A text-valued property in the viewer's language: the first of ctx.languages
 * that has a value, then the untagged source text, then English, then anything.
 */
export function text(ctx: RuleContext, s: Term, p: string): string | undefined {
  const values = ctx.objects(s, p).filter((t) => t.termType === 'Literal')
  if (values.length <= 1) return values[0]?.value
  // Which value wins depends on the viewer's languages: a language change re-runs this.
  ctx.readsLanguage()
  const lang = (t: Term) => (t.termType === 'Literal' ? t.language.toLowerCase() : '')
  const tagged = (want: string) => values.find((t) => lang(t) === want) ?? values.find((t) => lang(t).startsWith(want + '-'))
  for (const want of ctx.languages) {
    const hit = tagged(want)
    if (hit) return hit.value
  }
  return (values.find((t) => lang(t) === '') ?? tagged('en') ?? values[0])!.value
}

/**
 * A translated text in the viewer's language: when the node has two values or more (as l10n:Terms
 * derives its twin for the SPARQL rules), the one text() picks; else undefined, so a caller that
 * reads one particular value (the untagged one) falls back to it as the SPARQL rules do.
 */
export function picked(ctx: RuleContext, s: Term, p: string): string | undefined {
  const values = ctx.objects(s, p).filter((t) => t.termType === 'Literal')
  return new Set(values.map((t) => t.value + '@' + (t as { language?: string }).language)).size > 1 ? text(ctx, s, p) : undefined
}

/** What to call a node: its c:label, its rdfs:label, or its IRI's local name. */
export const labelOf = (ctx: RuleContext, t: Term): string =>
  text(ctx, t, C.label) ?? text(ctx, t, RDFS_LABEL) ?? t.value.replace(/^.*[#/]/, '')

/** SPARQL's ENCODE_FOR_URI (encodeURIComponent keeps !'()*), so minted keys match the SPARQL rules'. */
export const encodeForUri = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/** As the SPARQL rules read a label: a literal is itself, a node its label in the viewer's language when translated, else its untagged rdfs:label, else its local name. */
export function plainLabel(ctx: RuleContext, t: Term): string {
  if (t.termType === 'Literal') return t.value
  return picked(ctx, t, RDFS_LABEL) ?? ctx.objects(t, RDFS_LABEL).find((l) => l.termType === 'Literal' && l.language === '')?.value ?? t.value.replace(/^.*[#/]/, '')
}

/** Whether a node is an instance of a class or of one of its subclasses (`?x a/rdfs:subClassOf* ?cls`). */
export function isA(ctx: { objects(s: Term, p: string): Term[] }, node: Term, cls: Term | string): boolean {
  const want = typeof cls === 'string' ? cls : cls.value
  const seen = new Set<string>()
  const todo = ctx.objects(node, RDF_TYPE)
  while (todo.length) {
    const t = todo.pop()!
    if (t.value === want) return true
    if (seen.has(t.value) || seen.size > 64) continue
    seen.add(t.value)
    todo.push(...ctx.objects(t, RDFS_SUBCLASS))
  }
  return false
}

/** FNV-1a, base 36: short, stable keys for content-addressed nodes. */
export function fnv(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

/**
 * The prefixes the store knows: those declared in the graph (sh:declare style: sh:prefix +
 * sh:namespace), then the framework's (NS). Read once per engine.
 */
export const declaredPrefixes = (ctx: RuleContext): Record<string, string> =>
  ctx.memo('prefixes', () =>
    ctx.untraced(() => {
      const out: Record<string, string> = {}
      for (const q of ctx.match(null, SH + 'prefix', null)) {
        const ns = str(ctx.object(q.subject, SH + 'namespace'))
        if (ns) out[q.object.value] = ns
      }
      return { ...out, ...NS }
    }),
  )
