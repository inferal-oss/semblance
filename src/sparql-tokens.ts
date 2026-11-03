/** A lexical token of SPARQL, for syntax coloring. */
export interface SparqlToken {
  kind: 'keyword' | 'var' | 'string' | 'pname' | 'iri' | 'number' | 'comment' | 'text'
  text: string
}

/** A token as the pattern matches it: where it starts (1-based, in code points, as sx:matches counts). */
export interface MatchedToken extends SparqlToken {
  start: number
}

/**
 * SPARQL's and Turtle's lexical forms as whole words, one alternative each, then classified by
 * what they hold (`classify`). The pattern is an XPath regular expression as much as a JavaScript
 * one (no \b, no lookaround, no \w), so SPARQL rules split text with it by sx:matches and get the
 * tokens this module gets. Every character is in some match: what starts no token is a run of
 * plain text, or (a lone ?, $, <, " or @, a line break) one character. Only a long string spans
 * lines. Groups: 1 comment, 2 string, 3 variable, 4 IRI, 5 GROUP BY / ORDER BY, 6 prefixed name,
 * 7 Turtle directive, 8 number, 9 word.
 */
export const TOKEN_PATTERN =
  '(#[^\\n]*)|("""[\\s\\S]*?"""|"(?:[^"\\\\\\n]|\\\\.)*")|([?$][A-Za-z_][A-Za-z0-9_]*)|(<[^<>\\s]*>)' +
  '|((?:[Gg][Rr][Oo][Uu][Pp]|[Oo][Rr][Dd][Ee][Rr])[ \\t]+[Bb][Yy][A-Za-z0-9_]*)' +
  '|([A-Za-z][A-Za-z0-9_-]*:(?:[A-Za-z_][A-Za-z0-9_-]*|/)?)|(@(?:prefix|base)[A-Za-z0-9_]*)' +
  '|([0-9]+(?:\\.[0-9]+)?[A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)|[^#"?$<@A-Za-z0-9_\\n]+|[\\s\\S]'

/**
 * The tokens that can hold a quote, as TOKEN_PATTERN finds them (comments, strings, IRIs), with a long
 * string in group 2: where long strings start and end, so a rule that tokenizes line by line knows
 * which lines are inside one.
 */
export const QUOTED_PATTERN = '(#[^\\n]*)|("""[\\s\\S]*?""")|("(?:[^"\\\\\\n]|\\\\.)*")|(<[^<>\\s]*>)'

/** The words colored as keywords in SPARQL (and Turtle), as written: case matters. */
export const KEYWORDS = [
  'CONSTRUCT', 'SELECT', 'WHERE', 'PREFIX', 'LIMIT', 'OPTIONAL', 'FILTER', 'BIND', 'AS', 'UNION', 'VALUES', 'NOT', 'EXISTS',
  'MINUS', 'LATERAL', 'DISTINCT', 'IF', 'COALESCE', 'CONCAT', 'STR', 'STRLEN', 'STRAFTER', 'UCASE', 'IRI', 'ENCODE_FOR_URI',
  'REPLACE', 'BOUND', 'ROUND', 'MIN', 'MAX', 'AVG', 'SUM', 'COUNT', 'true', 'false', 'a',
] as const
const KEYWORD = new Set<string>(KEYWORDS)

const RE = new RegExp(TOKEN_PATTERN, 'g')
const GROUPS = ['comment', 'string', 'var', 'iri', 'phrase', 'pname', 'directive', 'number', 'word'] as const

/**
 * A match's kind, from the group that matched it, and how much of it has that kind (the rest is a
 * text tail). A word is a keyword when it is one; a phrase when it is GROUP BY or ORDER BY; a
 * number when it is digits with an optional fraction (digits, a fraction and then letters, as
 * 120.0e0, color only the digits); a prefixed name unless it is a scheme's "name:/" (text) or its
 * prefix is a keyword (that keyword, then text); a directive (Turtle only) when it is @prefix or
 * @base. Anything else is text.
 */
export function classify(group: (typeof GROUPS)[number] | undefined, text: string, turtle: boolean): { kind: SparqlToken['kind']; head: number } {
  const all = text.length
  switch (group) {
    case 'comment':
    case 'string':
    case 'var':
    case 'iri':
      return { kind: group, head: all }
    case 'phrase':
      return { kind: text === 'GROUP BY' || text === 'ORDER BY' ? 'keyword' : 'text', head: all }
    case 'pname': {
      if (text.endsWith('/')) return { kind: 'text', head: all }
      const prefix = text.slice(0, text.indexOf(':'))
      return KEYWORD.has(prefix) ? { kind: 'keyword', head: prefix.length } : { kind: 'pname', head: all }
    }
    case 'directive':
      return { kind: turtle && (text === '@prefix' || text === '@base') ? 'keyword' : 'text', head: all }
    case 'number': {
      if (/^[0-9]+(\.[0-9]+)?$/.test(text)) return { kind: 'number', head: all }
      const digits = /^[0-9]+\.[0-9]/.exec(text)
      return digits ? { kind: 'number', head: digits[0].length - 2 } : { kind: 'text', head: all }
    }
    case 'word':
      return { kind: KEYWORD.has(text) ? 'keyword' : 'text', head: all }
    default:
      return { kind: 'text', head: all }
  }
}

/**
 * Every match of the pattern, in order, classified (a match with a text tail is two tokens): what a
 * SPARQL rule gets from sx:matches.
 */
export function matchTokens(source: string, turtle = false): MatchedToken[] {
  const out: MatchedToken[] = []
  // Code points, as sx:matches counts them (a surrogate pair is one).
  let at = 1
  let last = 0
  for (const m of source.matchAll(RE)) {
    for (const _ of source.slice(last, m.index)) at++
    last = m.index!
    const g = m.slice(1).findIndex((x) => x !== undefined)
    const { kind, head } = classify(GROUPS[g], m[0], turtle)
    out.push({ kind, text: m[0].slice(0, head), start: at })
    // A tail is ASCII (it follows an ASCII head), so its start is the head's length on.
    if (head < m[0].length) out.push({ kind: 'text', text: m[0].slice(head), start: at + head })
  }
  return out
}

/** Adjacent text tokens as one. */
function merged(tokens: SparqlToken[]): SparqlToken[] {
  const out: SparqlToken[] = []
  for (const t of tokens) {
    const prev = out[out.length - 1]
    if (prev && prev.kind === 'text' && t.kind === 'text') out[out.length - 1] = { kind: 'text', text: prev.text + t.text }
    else out.push({ kind: t.kind, text: t.text })
  }
  return out
}

/** Split a query into colorable tokens; whitespace, punctuation and other words are `text`. */
export function tokenizeSparql(q: string): SparqlToken[] {
  return merged(matchTokens(q))
}

/**
 * Tokens of a code sample in a language that is colored (SPARQL, or Turtle, which is lexically
 * close to it: its directives are keywords too); undefined for any other language.
 */
export function tokenizeCode(source: string, language: string | undefined): SparqlToken[] | undefined {
  if (language !== 'sparql' && language !== 'turtle') return undefined
  return merged(matchTokens(source, language === 'turtle'))
}
