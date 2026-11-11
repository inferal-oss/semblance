// A rename, token by token (#473): every occurrence of a term in Turtle, in the SPARQL and the Turtle
// held in literals, in slugs and in CSS held in the graph; everything else byte for byte. Pure: it
// also runs in the page, over an authored graph that names a retired term.
import { NS } from '../ns.ts'
import { compactIri, lex, type Tok } from './turtle.ts'

export const looksLikeQuery = (s: string) => s.includes('{') && /^\s*(PREFIX|BASE|SELECT|CONSTRUCT|ASK|DESCRIBE|INSERT|DELETE|WITH)\b/i.test(s.replace(/#[^\n]*\n/g, ''))
export const looksLikeTurtle = (s: string) => /(^|\n)\s*@prefix\s/.test(s)
export const frameworkPrefixes = new Map<string, string>(Object.entries(NS))

export interface Names {
  terms: Map<string, string>
  slugs: Map<string, string>
}

export interface Occurrence {
  term: string
  line: number
  place: 'code' | 'comment' | 'prose'
}

/** Prefixes a text declares, and the tokens that declare them (which name no terms). */
function declared(toks: Tok[], inherited: Map<string, string>): { prefixes: Map<string, string>; skip: Set<Tok> } {
  const prefixes = new Map(inherited)
  const skip = new Set<Tok>()
  const sig = toks.filter((t) => t.k !== 'ws' && t.k !== 'comment')
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i]!
    if (t.k === 'dir' ? t.text === '@prefix' : t.k === 'word' && /^PREFIX$/i.test(t.text)) {
      const [name, iri] = [sig[i + 1], sig[i + 2]]
      if (name?.k === 'pname' && iri?.k === 'iri') {
        prefixes.set(name.text.slice(0, -1), iri.text.slice(1, -1))
        skip.add(name), skip.add(iri)
      }
    }
  }
  return { prefixes, skip }
}

const expandName = (t: Tok, prefixes: Map<string, string>): string | undefined => {
  const c = t.text.indexOf(':')
  const ns = prefixes.get(t.text.slice(0, c))
  return ns === undefined ? undefined : ns + t.text.slice(c + 1)
}

/** The text with every occurrence renamed; what it finds is passed to `seen`. */
export function renameText(text: string, names: Names, inherited: Map<string, string>, seen: (o: Occurrence) => void, baseLine = 1): string {
  const toks = lex(text)
  const { prefixes, skip } = declared(toks, inherited)
  const shortNames = new Map<string, string>()
  for (const iri of names.terms.keys()) {
    const short = compactIri(iri, prefixes)
    if (!short.startsWith('<')) shortNames.set(short, iri)
  }
  const prose = shortNames.size ? new RegExp(`(?<![\\w:])(${[...shortNames.keys()].map((s) => s.replace(/[-]/g, '\\-')).join('|')})(?![\\w-])`, 'g') : undefined
  const line = (t: Tok) => baseLine + text.slice(0, t.at).split('\n').length - 1
  const SLUG_ATTR = /\[\s*data-sem-c\s*=\s*(\\?["']?)([\w-]+)\1\s*\]/g
  let previous: Tok | undefined
  let out = ''
  let at = 0
  for (const t of toks) {
    let replacement: string | undefined
    if (t.k === 'iri' && !skip.has(t)) {
      const iri = t.text.slice(1, -1)
      const to = names.terms.get(iri)
      if (to) (replacement = `<${to}>`), seen({ term: iri, line: line(t), place: 'code' })
    } else if (t.k === 'pname' && !skip.has(t)) {
      const iri = expandName(t, prefixes)
      const to = iri && names.terms.get(iri)
      if (iri && to) (replacement = compactIri(to, prefixes, t.text.slice(0, t.text.indexOf(':')))), seen({ term: iri, line: line(t), place: 'code' })
    } else if (t.k === 'comment') {
      if (prose) for (const m of t.text.matchAll(prose)) seen({ term: shortNames.get(m[1]!)!, line: line(t), place: 'comment' })
    } else if (t.k === 'str') {
      const long = t.text.startsWith('"""') || t.text.startsWith("'''")
      const quote = long ? 3 : 1
      const body = t.text.slice(quote, -quote)
      let next = body
      if (long && looksLikeQuery(body)) next = renameText(body, names, prefixes, seen, line(t))
      else if (long && looksLikeTurtle(body)) next = renameText(body, names, new Map(), seen, line(t))
      else if (prose) for (const m of body.matchAll(prose)) seen({ term: shortNames.get(m[1]!)!, line: line(t), place: 'prose' })
      if (names.slugs.size) {
        const previousIri = previous?.k === 'pname' ? expandName(previous, prefixes) : previous?.k === 'iri' ? previous.text.slice(1, -1) : undefined
        if (previousIri === NS.sem + 'slug' && names.slugs.has(body)) (next = names.slugs.get(body)!), seen({ term: body, line: line(t), place: 'code' })
        else {
          next = next.replace(SLUG_ATTR, (whole, q: string, slug: string) => {
            const to = names.slugs.get(slug)
            if (!to) return whole
            seen({ term: slug, line: line(t), place: 'code' })
            return whole.replace(`=${q}${slug}${q}`, `=${q}${to}${q}`)
          })
        }
      }
      if (next !== body) replacement = t.text.slice(0, quote) + next + t.text.slice(-quote)
    }
    if (t.k !== 'ws' && t.k !== 'comment') previous = t
    if (replacement !== undefined) {
      out += text.slice(at, t.at) + replacement
      at = t.end
    }
  }
  return out + text.slice(at)
}

