/** A lexical token of SPARQL, for syntax coloring. */
export interface SparqlToken {
  kind: 'keyword' | 'var' | 'string' | 'pname' | 'iri' | 'number' | 'comment' | 'text'
  text: string
}

/** A token as the pattern matches it: where it starts (1-based, in code points, as sx:matches counts). */
export interface MatchedToken extends SparqlToken {
  start: number
  /** The pattern's group that matched it (a text tail has none). */
  group?: (typeof GROUPS)[number]
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
    out.push({ kind, text: m[0].slice(0, head), start: at, group: GROUPS[g] })
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
 * A language's lexicon, other than SPARQL's and Turtle's (c:LanguageLexicon): a pattern whose matches
 * are the tokens (an XPath regular expression as much as a JavaScript one, as TOKEN_PATTERN), the kind
 * of each of its groups in order ("word" is a keyword when it is one of `keywords`, as written, and
 * text otherwise), and the names of the language it colors (c:language). What no group holds is text.
 */
export interface Lexicon {
  /** Its node in the graph, under c: (c:TypeScriptLexicon). */
  name: string
  languages: readonly string[]
  pattern: string
  groups: readonly (Exclude<SparqlToken['kind'], 'text'> | 'word')[]
  keywords: readonly string[]
}

/** A double-quoted string on one line, with escapes. */
const STRING2 = '"(?:[^"\\\\\\n]|\\\\.)*"'

/** The languages colored beside SPARQL and Turtle; ontology/components/editor.ttl states the same (a test checks it). */
export const LEXICONS: readonly Lexicon[] = [
  {
    name: 'TypeScriptLexicon',
    languages: ['typescript', 'ts', 'javascript', 'js'],
    // Comments, strings (template literals over lines), numbers, words; a member name after a dot
    // is text (never a keyword), and so is any other run.
    pattern:
      '(//[^\\n]*|/\\*[\\s\\S]*?\\*/)' +
      `|(${STRING2}|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\[\\s\\S])*\`)` +
      '|(0[xXbBoO][0-9A-Fa-f_]+n?|[0-9][0-9_]*(?:\\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9]+)?n?)' +
      '|([A-Za-z_$][A-Za-z0-9_$]*)' +
      '|\\.[A-Za-z_$][A-Za-z0-9_$]*|[^/"\'\`0-9A-Za-z_$.\\n]+|[\\s\\S]',
    groups: ['comment', 'string', 'number', 'word'],
    keywords: [
      'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'declare', 'default', 'delete',
      'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'implements', 'import', 'in',
      'instanceof', 'interface', 'keyof', 'let', 'namespace', 'new', 'null', 'of', 'private', 'protected', 'public', 'readonly',
      'return', 'satisfies', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var',
      'void', 'while', 'yield',
    ],
  },
  {
    name: 'ShellLexicon',
    languages: ['shell', 'sh', 'bash'],
    // Comments, strings, variables, the command a line starts with (a keyword), options, words.
    pattern:
      '(#[^\\n]*)|("(?:[^"\\\\]|\\\\[\\s\\S])*"|\'[^\']*\')|(\\$(?:\\{[^}\\n]*\\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?$!*-]))' +
      '|((?:^|\\n)[ \\t]*[A-Za-z_][A-Za-z0-9_.-]*)|(--?[A-Za-z0-9][A-Za-z0-9_-]*)' +
      '|([A-Za-z0-9_./~:@%+=,][A-Za-z0-9_./~:@%+=,#-]*)|[^#"\'$A-Za-z0-9_./~:@%+=,\\n-]+|[\\s\\S]',
    groups: ['comment', 'string', 'var', 'keyword', 'pname', 'word'],
    keywords: ['case', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for', 'function', 'if', 'in', 'local', 'return', 'then', 'until', 'while'],
  },
  {
    name: 'JsonLexicon',
    languages: ['json'],
    // A member's name (with its colon), strings, numbers, words (true, false, null).
    pattern:
      `(${STRING2}[ \\t]*:)|(${STRING2})|(-?[0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)|([A-Za-z_][A-Za-z0-9_]*)` +
      '|[^"0-9A-Za-z_\\n-]+|[\\s\\S]',
    groups: ['pname', 'string', 'number', 'word'],
    keywords: ['false', 'null', 'true'],
  },
  {
    name: 'HtmlLexicon',
    languages: ['html', 'xml'],
    // Comments, tags (a keyword: from < to the name, and the closing > or />), attribute names (with
    // their =), double-quoted values, character references; other words and runs are text.
    pattern:
      '(<!--[\\s\\S]*?-->)|(</?[A-Za-z][A-Za-z0-9:-]*|<![A-Za-z]+|/?>)|([A-Za-z_:@][A-Za-z0-9_:.-]*=)|("[^"]*")|(&[#A-Za-z0-9]+;)' +
      '|[A-Za-z_:@][A-Za-z0-9_:.-]*|[^<>"&A-Za-z_:@/\\n]+|[\\s\\S]',
    groups: ['comment', 'keyword', 'pname', 'string', 'var'],
    keywords: [],
  },
  {
    name: 'HttpLexicon',
    languages: ['http'],
    // A header's name (with its colon) where a line starts, quoted values, URLs; the rest is text.
    pattern:
      '((?:^|\\n)[A-Za-z][A-Za-z0-9-]*:)|(\'[^\'\\n]*\'|"[^"\\n]*")|([a-z][a-z0-9+.-]*://[^\\s;,\'"]+)' +
      '|[A-Za-z][A-Za-z0-9_-]*|[^\'"A-Za-z\\n]+|[\\s\\S]',
    groups: ['pname', 'string', 'iri'],
    keywords: [],
  },
]

/** The lexicon of a language (by any of its names, in lower case), if it is one of LEXICONS. */
export function lexiconOf(language: string | undefined): Lexicon | undefined {
  return language === undefined ? undefined : LEXICONS.find((l) => l.languages.includes(language))
}

const LEXICON_RE = new Map<Lexicon, { re: RegExp; keywords: Set<string> }>()

/** Every match of a lexicon's pattern, in order, classified: what a SPARQL rule gets from sx:matches. */
export function matchLexicon(source: string, lexicon: Lexicon): MatchedToken[] {
  let compiled = LEXICON_RE.get(lexicon)
  if (!compiled) LEXICON_RE.set(lexicon, (compiled = { re: new RegExp(lexicon.pattern, 'g'), keywords: new Set(lexicon.keywords) }))
  const out: MatchedToken[] = []
  let at = 1
  let last = 0
  for (const m of source.matchAll(compiled.re)) {
    for (const _ of source.slice(last, m.index)) at++
    last = m.index!
    const group = lexicon.groups[m.slice(1).findIndex((x) => x !== undefined)]
    const kind = group === undefined ? 'text' : group === 'word' ? (compiled.keywords.has(m[0]) ? 'keyword' : 'text') : group
    out.push({ kind, text: m[0], start: at })
  }
  return out
}

/** Whether a language is colored: SPARQL, Turtle, or one of LEXICONS. */
export function isColored(language: string | undefined): boolean {
  return language === 'sparql' || language === 'turtle' || lexiconOf(language) !== undefined
}

/**
 * Every match of the colored language's pattern, in order and classified, keyed by where it starts
 * (as the SPARQL rule keys them); undefined for a language that is not colored.
 */
export function matchCode(source: string, language: string | undefined): MatchedToken[] | undefined {
  if (language === 'sparql' || language === 'turtle') return matchTokens(source, language === 'turtle')
  const lexicon = lexiconOf(language)
  return lexicon && matchLexicon(source, lexicon)
}

/**
 * Tokens of a code sample in a language that is colored (SPARQL; Turtle, which is lexically close to
 * it: its directives are keywords too; or one of LEXICONS); undefined for any other language.
 */
export function tokenizeCode(source: string, language: string | undefined): SparqlToken[] | undefined {
  const tokens = matchCode(source, language)
  return tokens && merged(tokens)
}
