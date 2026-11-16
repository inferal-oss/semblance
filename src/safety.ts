// Safe authoring (ontology/layers/safety.ttl): what a rendering from an untrusted author may
// contain. A projection is authored when its host gives it a policy; the HTML index applies it to
// every element and attribute it hands out (src/render/html-index.ts), and the style compiler to
// every string it writes from the graph (src/style/compile.ts). What is refused is reported, never
// dropped silently.
import { EXT, H, NS, RDF_TYPE } from './ns.ts'
import { parseDuration } from './rdf.ts'
import type { GraphStore } from './store/types.ts'

const SAFE = NS.safe
export const SAFETY = {
  Policy: SAFE + 'Policy',
  Authored: SAFE + 'Authored',
  element: SAFE + 'element',
  attribute: SAFE + 'attribute',
  attributePrefix: SAFE + 'attributePrefix',
  refusedAttributePrefix: SAFE + 'refusedAttributePrefix',
  refusedLinkType: SAFE + 'refusedLinkType',
  idReferenceAttribute: SAFE + 'idReferenceAttribute',
  idReferenceListAttribute: SAFE + 'idReferenceListAttribute',
  fragmentAttribute: SAFE + 'fragmentAttribute',
  urlAttribute: SAFE + 'urlAttribute',
  urlListAttribute: SAFE + 'urlListAttribute',
  resourceAttribute: SAFE + 'resourceAttribute',
  scheme: SAFE + 'scheme',
  resourceScheme: SAFE + 'resourceScheme',
  styleAttribute: SAFE + 'styleAttribute',
  cssValueAttribute: SAFE + 'cssValueAttribute',
  fetchingFunction: SAFE + 'fetchingFunction',
  refusedProperty: SAFE + 'refusedProperty',
  hostComponent: SAFE + 'hostComponent',
  customElement: SAFE + 'customElement',
  widget: SAFE + 'widget',
  module: SAFE + 'module',
  adapter: SAFE + 'adapter',
  property: SAFE + 'property',
  budget: SAFE + 'budget',
  maxEvaluations: SAFE + 'maxEvaluations',
  maxDerived: SAFE + 'maxDerived',
  maxLength: SAFE + 'maxLength',
} as const

/** A safe:Policy, read for use: element classes as the HTML index names them ("Div", "svg:Rect"). */
export interface SafetyPolicy {
  iri: string
  elements: ReadonlySet<string>
  attributes: ReadonlySet<string>
  prefixes: readonly string[]
  /** Prefixes refused even under an allowed one (the framework's own hooks); a name listed outright is still allowed. */
  refusedPrefixes: readonly string[]
  /** Link types (rel tokens) refused. */
  refusedLinkTypes: ReadonlySet<string>
  /** Attributes whose value is one id, a list of ids, or a URL whose fragment is one: each must be minted in the same projection. */
  idReferenceAttributes: ReadonlySet<string>
  idReferenceListAttributes: ReadonlySet<string>
  fragmentAttributes: ReadonlySet<string>
  urlAttributes: ReadonlySet<string>
  urlListAttributes: ReadonlySet<string>
  resourceAttributes: ReadonlySet<string>
  schemes: ReadonlySet<string>
  resourceSchemes: readonly string[]
  styleAttributes: ReadonlySet<string>
  cssValueAttributes: ReadonlySet<string>
  fetchingFunctions: ReadonlySet<string>
  refusedProperties: ReadonlySet<string>
  /** Host components (ext:component) and custom elements (ext:tag) an authored graph may name (docs/HOSTED.md). */
  hostComponents: ReadonlySet<string>
  customElements: ReadonlySet<string>
  /** What an authored island may mount (docs/FOREIGN.md): widgets (ext:widget), modules (ext:module) and adapters (ext:adapter) by name. */
  widgets: ReadonlySet<string>
  modules: ReadonlySet<string>
  adapters: ReadonlySet<string>
  /** Properties an authored input (ext:Property) may set on an island or a custom element. */
  properties: ReadonlySet<string>
  /** Work budgets (unbounded when absent): a turn's time in ms, its rule evaluations, the derived triples a projection holds. */
  budgetMs?: number
  maxEvaluations?: number
  maxDerived?: number
  /** The longest string the policy checks; a longer one is refused unread. */
  maxLength?: number
}

/**
 * Read a policy from a store. The store must be a trusted one (the framework's ontology and the
 * app's own Turtle): one that holds an authored graph could have added to its lists.
 */
export function readPolicy(store: GraphStore, iri: string = SAFETY.Authored): SafetyPolicy {
  const f = store.factory
  const s = f.namedNode(iri)
  const values = (p: string) => store.match(s, f.namedNode(p), null, f.defaultGraph()).map((q) => q.object.value)
  const lower = (p: string) => values(p).map((v) => v.toLowerCase())
  if (!store.match(s, f.namedNode(RDF_TYPE), f.namedNode(SAFETY.Policy)).length) throw new Error(`<${iri}> is not a safe:Policy (is ontology/layers/safety.ttl loaded?)`)
  const elements = new Set<string>()
  for (const e of values(SAFETY.element)) {
    if (e.startsWith(H.ns)) elements.add(e.slice(H.ns.length))
    else if (e.startsWith(NS.svg)) elements.add('svg:' + e.slice(NS.svg.length))
  }
  const number = (p: string) => {
    const v = values(p)[0]
    const n = v === undefined ? NaN : Number(v)
    return Number.isFinite(n) && n >= 0 ? n : undefined
  }
  const budget = values(SAFETY.budget)[0]
  return {
    iri,
    budgetMs: budget === undefined ? undefined : parseDuration(budget),
    maxEvaluations: number(SAFETY.maxEvaluations),
    maxDerived: number(SAFETY.maxDerived),
    maxLength: number(SAFETY.maxLength),
    elements,
    attributes: new Set(values(SAFETY.attribute)),
    prefixes: lower(SAFETY.attributePrefix),
    refusedPrefixes: lower(SAFETY.refusedAttributePrefix),
    refusedLinkTypes: new Set(lower(SAFETY.refusedLinkType)),
    idReferenceAttributes: new Set(lower(SAFETY.idReferenceAttribute)),
    idReferenceListAttributes: new Set(lower(SAFETY.idReferenceListAttribute)),
    fragmentAttributes: new Set(lower(SAFETY.fragmentAttribute)),
    urlAttributes: new Set(lower(SAFETY.urlAttribute)),
    urlListAttributes: new Set(lower(SAFETY.urlListAttribute)),
    resourceAttributes: new Set(lower(SAFETY.resourceAttribute)),
    schemes: new Set(lower(SAFETY.scheme)),
    resourceSchemes: lower(SAFETY.resourceScheme),
    styleAttributes: new Set(lower(SAFETY.styleAttribute)),
    cssValueAttributes: new Set(lower(SAFETY.cssValueAttribute)),
    fetchingFunctions: new Set(lower(SAFETY.fetchingFunction)),
    refusedProperties: new Set(lower(SAFETY.refusedProperty)),
    hostComponents: new Set(values(SAFETY.hostComponent)),
    customElements: new Set(lower(SAFETY.customElement)),
    widgets: new Set(values(SAFETY.widget)),
    modules: new Set(values(SAFETY.module)),
    adapters: new Set(values(SAFETY.adapter)),
    properties: new Set(values(SAFETY.property)),
  }
}

const policies = new WeakMap<GraphStore, SafetyPolicy>()
/** The policy of authored content (safe:Authored), read once per trusted store. */
export function authoredPolicy(trusted: GraphStore): SafetyPolicy {
  let p = policies.get(trusted)
  if (!p) policies.set(trusted, (p = readPolicy(trusted)))
  return p
}

/** Something a policy kept out of a rendering or a stylesheet. */
export class Refused extends Error {
  constructor(
    /** The node it was refused on (an element's key), or the style rule. */
    readonly at: string,
    /** What it was: an element, an attribute, a URL, a style, or work over a budget (the root it was rendering). */
    readonly kind: 'element' | 'attribute' | 'url' | 'style' | 'budget',
    message: string,
  ) {
    super(message)
    this.name = 'Refused'
  }
}

/** What an HTML attribute name may be at all (anything else would break the markup it is written in). */
export const ATTRIBUTE_NAME = /^[^\s"'<>/=\u0000-\u001f\u007f]+$/

/** Whether an element class (as the HTML index names it) is allowed. */
export const allowsElement = (policy: SafetyPolicy, cls: string): boolean => policy.elements.has(cls)
/** Whether authored content may have a component drawn by this host component (ext:component, docs/HOSTED.md). */
export const allowsHostComponent = (policy: SafetyPolicy, name: string): boolean => policy.hostComponents.has(name)
/** Whether authored content may have a component's root created as this custom element (ext:tag). */
export const allowsCustomElement = (policy: SafetyPolicy, tag: string): boolean => policy.customElements.has(tag)

/**
 * Properties an authored input never sets, listed or not: those that take markup, event handlers,
 * the names React keeps for itself, and the prototype chain.
 */
const NEVER_PROPERTY = new Set(['innerhtml', 'outerhtml', 'srcdoc', 'dangerouslysetinnerhtml', 'sethtmlunsafe', 'insertadjacenthtml', 'ref', 'key', 'children', '__proto__', 'constructor', 'prototype'])

/** Why an authored input (ext:input) is refused, or undefined: an attribute passes attributeProblem; a property must be listed. */
export function inputProblem(policy: SafetyPolicy, name: string, value: string, asAttribute: boolean): { kind: Refused['kind']; reason: string } | undefined {
  const long = lengthProblem(policy, value)
  if (long) return { kind: 'attribute', reason: long }
  if (asAttribute) return attributeProblem(policy, name, value)
  const lower = name.toLowerCase()
  if (NEVER_PROPERTY.has(lower) || lower.startsWith('on') || !policy.properties.has(name)) return { kind: 'attribute', reason: `authored content may not set the property ${name}` }
  return undefined
}

/** What an island names to be mounted with (read from the island and its classes, docs/FOREIGN.md). */
export interface IslandRoute {
  adapter: string
  tag?: string
  widget?: string
  module?: string
}

/**
 * Why an island is refused, or undefined: its custom element, widget and module are listed, and its
 * adapter is either a built-in one (its tag or widget listed) or listed itself.
 */
export function islandProblem(policy: SafetyPolicy, island: IslandRoute): string | undefined {
  if (island.tag !== undefined && !allowsCustomElement(policy, island.tag.toLowerCase())) return `custom element ${island.tag} is not allowed in authored content`
  if (island.widget !== undefined && !policy.widgets.has(island.widget)) return `widget ${island.widget} is not allowed in authored content`
  if (island.module !== undefined && !policy.modules.has(island.module)) return `module ${island.module} is not allowed in authored content`
  if (island.adapter === EXT.CustomElement ? island.tag === undefined : island.adapter === EXT.Widget ? island.widget === undefined : !policy.adapters.has(island.adapter))
    return `adapter <${island.adapter}> is not allowed in authored content`
  return undefined
}

/**
 * Why an attribute is refused, or undefined when it is allowed: its name is listed, or has a listed
 * prefix and no refused one, its link types are not refused, and a URL, a srcset or a style in it
 * passes its check. Where an id reference points is checked by the HTML index (idReferences).
 */
export function attributeProblem(policy: SafetyPolicy, name: string, value: string): { kind: Refused['kind']; reason: string } | undefined {
  const long = lengthProblem(policy, value)
  if (long) return { kind: 'attribute', reason: long }
  const lower = name.toLowerCase()
  const named =
    policy.attributes.has(name) ||
    policy.attributes.has(lower) ||
    (policy.prefixes.some((p) => lower.startsWith(p) && /^[a-z0-9][a-z0-9-]*$/.test(lower.slice(p.length))) && !policy.refusedPrefixes.some((p) => lower.startsWith(p)))
  if (!named) return { kind: 'attribute', reason: `authored content may not have the attribute ${name}` }
  if (lower === 'rel' && policy.refusedLinkTypes.size) {
    for (const token of tokens(value)) if (policy.refusedLinkTypes.has(token.toLowerCase())) return { kind: 'attribute', reason: `authored content may not have the link type ${token.toLowerCase()}` }
  }
  const resource = policy.resourceAttributes.has(lower)
  let url: string | undefined
  if (policy.urlAttributes.has(lower)) url = urlProblem(policy, value, resource)
  else if (policy.urlListAttributes.has(lower)) {
    for (const candidate of value.split(',')) {
      const first = candidate.trim().split(/\s+/)[0] ?? ''
      if ((url = first ? urlProblem(policy, first, resource) : undefined)) break
    }
  }
  if (url) return { kind: 'url', reason: url }
  const style = policy.styleAttributes.has(lower) ? declarationsProblem(policy, value) : policy.cssValueAttributes.has(lower) ? cssProblem(policy, value, 'value') : undefined
  return style ? { kind: 'style', reason: style } : undefined
}

/**
 * The ids an attribute's value names, when it is an id reference (safe:idReferenceAttribute, its
 * list form, or a URL of a safe:fragmentAttribute that is only a fragment), or undefined. A URL of
 * an empty fragment ("#") names none.
 */
export function idReferences(policy: SafetyPolicy, name: string, value: string): string[] | undefined {
  const lower = name.toLowerCase()
  if (policy.idReferenceAttributes.has(lower)) return [value]
  if (policy.idReferenceListAttributes.has(lower)) return tokens(value)
  if (policy.fragmentAttributes.has(lower)) {
    const v = browserTrim(value)
    return v.startsWith('#') ? (v.length > 1 ? [v.slice(1)] : []) : undefined
  }
  return undefined
}

/** The tokens of a space-separated list (HTML's ASCII whitespace). */
function tokens(value: string): string[] {
  return value.split(/[\t\n\f\r ]+/).filter(Boolean)
}

/** A URL as a browser reads it: tabs and newlines anywhere, and spaces and controls around it, removed (in linear time). */
function browserTrim(url: string): string {
  const v = url.replace(/[\t\n\r]/g, '')
  let start = 0
  let end = v.length
  while (start < end && v.charCodeAt(start) <= 0x20) start++
  while (end > start && v.charCodeAt(end - 1) <= 0x20) end--
  return v.slice(start, end)
}

/**
 * Why a URL is refused, or undefined: relative, a fragment, or of a listed scheme (`resource`: also
 * of a listed resource scheme). Read as a browser reads it: tabs and newlines anywhere, and spaces
 * and controls around it, do not count.
 */
export function urlProblem(policy: SafetyPolicy, url: string, resource = false): string | undefined {
  const v = browserTrim(url)
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(v)?.[1]
  if (scheme === undefined) return undefined
  const lower = v.toLowerCase()
  if (policy.schemes.has(scheme.toLowerCase() + ':')) return undefined
  if (resource && policy.resourceSchemes.some((p) => lower.startsWith(p))) return undefined
  return `authored content may not have a ${scheme.toLowerCase()}: URL here`
}

/** Why a string is too long for the policy to check (safe:maxLength), or undefined. */
export function lengthProblem(policy: SafetyPolicy, text: string): string | undefined {
  return policy.maxLength !== undefined && text.length > policy.maxLength ? `authored content may not have a value longer than ${policy.maxLength} characters` : undefined
}

/** Why a list of CSS declarations ("a: b; c: d", a style attribute) is refused, or undefined. */
export function declarationsProblem(policy: SafetyPolicy, text: string): string | undefined {
  const long = lengthProblem(policy, text)
  if (long) return long
  const scanned = scan(policy, text, 'declarations')
  if (typeof scanned === 'string') return scanned
  for (const decl of scanned) {
    if (!decl.trim()) continue
    const colon = decl.indexOf(':')
    if (colon < 0) return `"${decl.trim()}" is not a CSS declaration`
    const why = propertyProblem(policy, decl.slice(0, colon).trim())
    if (why) return why
  }
  return undefined
}

/** Why a CSS property name is refused, or undefined. */
export function propertyProblem(policy: SafetyPolicy, property: string): string | undefined {
  if (!/^(?:--[A-Za-z0-9_-]+|-?[A-Za-z][A-Za-z0-9-]*)$/.test(property)) return `"${property}" is not a CSS property`
  if (policy.refusedProperties.has(property.toLowerCase())) return `authored styles may not set ${property}`
  return undefined
}

/**
 * Why a piece of CSS the style compiler writes is refused, or undefined: a value (sty:raw, a
 * token's), a selector (sty:part, sty:state), a media condition, or a name (keyframes).
 */
export function cssProblem(policy: SafetyPolicy, text: string, as: 'value' | 'selector' | 'media' | 'name' | 'step'): string | undefined {
  const long = lengthProblem(policy, text)
  if (long) return long
  if (as === 'name') return /^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(text) ? undefined : `"${text}" is not a CSS name`
  if (as === 'step') return /^\s*(?:from|to|\d+(?:\.\d+)?%)(?:\s*,\s*(?:from|to|\d+(?:\.\d+)?%))*\s*$/.test(text) ? undefined : `"${text}" is not a keyframe step`
  const scanned = scan(policy, text, as)
  return typeof scanned === 'string' ? scanned : undefined
}

/**
 * Read CSS text as the css-syntax-3 tokenizer reads it, far enough to know it stays what it is, in
 * one pass: strings end where the browser ends them, an unquoted url( is one url token up to its
 * `)`, a number swallows the name after it (`1url(` calls nothing) and so does a hash (`#url(`).
 * Refused: a comment (inside one a quote is no string, so the check and the browser would read on
 * differently), a bad string or bad url, an escape outside a string (an escape can spell url), a
 * `{`, `}`, `@` or `<` (a block, rule or at-rule), a `;` outside a declaration list, brackets that do
 * not balance, and a function that fetches a resource, except url() of a fragment or of a resource
 * scheme. In a selector or a media condition, also `&` and `:scope`, which would name the scope
 * authored rules are kept in (src/style/scope.ts). A declaration list comes back split at its
 * top-level semicolons; anything else as one piece. A string is a reason it is refused.
 */
function scan(policy: SafetyPolicy, text: string, as: 'value' | 'selector' | 'media' | 'declarations'): string[] | string {
  const parts: string[] = []
  let start = 0
  const closers: string[] = []
  const selector = as === 'selector' || as === 'media'
  const n = text.length
  for (let i = 0; i < n; i++) {
    const ch = text[i]!
    if (ch === '"' || ch === "'") {
      const end = stringEnd(text, i)
      if (end < 0) return 'a CSS string is not closed'
      i = end
      continue
    }
    if (ch === '/' && text[i + 1] === '*') return 'authored styles may not hold a comment'
    if (ch === '\\') return 'authored styles may not escape characters outside a string'
    if (ch === '{' || ch === '}' || ch === '@' || ch === '<') return `authored styles may not hold "${ch}" here`
    if (ch === '&' && selector) return 'an authored selector may not name "&"'
    if (ch === ';') {
      if (as !== 'declarations' || closers.length) return 'authored styles may not hold ";" here'
      parts.push(text.slice(start, i))
      start = i + 1
      continue
    }
    if (startsNumber(text, i)) {
      // A number, then a unit (a dimension) or %: a name after a number never calls a function.
      i = numberEnd(text, i)
      if (text[i] === '%') i++
      else if (startsName(text, i)) i = nameEnd(text, i)
      i--
      continue
    }
    if (ch === '#' && i + 1 < n && isNameChar(text.charCodeAt(i + 1))) {
      i = nameEnd(text, i + 1) - 1
      continue
    }
    if (startsName(text, i)) {
      const end = nameEnd(text, i)
      const name = text.slice(i, end).toLowerCase()
      if (selector && name === 'scope' && text[i - 1] === ':') return 'an authored selector may not name ":scope"'
      if (text[end] !== '(') {
        i = end - 1
        continue
      }
      if (name === 'url') {
        let j = end + 1
        while (isSpace(text[j])) j++
        if (text[j] !== '"' && text[j] !== "'") {
          // An unquoted url( is one url token: anything but its `)` in a place the tokenizer would
          // call it bad is refused, so that both read it to the same `)`.
          const close = urlTokenEnd(text, j)
          if (close < 0) return 'a CSS url() is not one the browser reads as written'
          const why = fetchProblem(policy, text.slice(j, close))
          if (why) return why
          i = close
          continue
        }
        // url( followed by a string: a function, whose string the loop reads next.
        const stringClose = stringEnd(text, j)
        const why = fetchProblem(policy, stringClose < 0 ? '' : text.slice(j + 1, stringClose))
        if (why) return why
      } else if (policy.fetchingFunctions.has(name)) return `authored styles may not load a resource (${name}())`
      closers.push(')')
      i = end
      continue
    }
    if (ch === '(' || ch === '[') {
      closers.push(ch === '(' ? ')' : ']')
      continue
    }
    if (ch === ')' || ch === ']') {
      if (closers.pop() !== ch) return 'brackets in a CSS value do not balance'
      continue
    }
  }
  if (closers.length) return 'brackets in a CSS value do not balance'
  parts.push(text.slice(start))
  return parts
}

const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
const isDigit = (c: number) => c >= 48 && c <= 57
/** A code point that may start a name (css-syntax-3 "ident-start code point"): a letter, _, or non-ASCII. */
const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 0x80
/** A code point that may continue a name. */
const isNameChar = (c: number) => isNameStart(c) || isDigit(c) || c === 45
/** Whether a name (an ident sequence) starts at `i`; escapes are refused before they get here. */
function startsName(text: string, i: number): boolean {
  const c = text.charCodeAt(i)
  if (c === 45) {
    const d = text.charCodeAt(i + 1)
    return d === 45 || isNameStart(d)
  }
  return isNameStart(c)
}
const nameEnd = (text: string, i: number) => {
  while (i < text.length && isNameChar(text.charCodeAt(i))) i++
  return i
}
/** Whether a number starts at `i` (css-syntax-3 "start a number"). */
function startsNumber(text: string, i: number): boolean {
  let c = text.charCodeAt(i)
  if (c === 43 || c === 45) c = text.charCodeAt(++i)
  if (isDigit(c)) return true
  return c === 46 && isDigit(text.charCodeAt(i + 1))
}
function numberEnd(text: string, i: number): number {
  if (text[i] === '+' || text[i] === '-') i++
  while (isDigit(text.charCodeAt(i))) i++
  if (text[i] === '.' && isDigit(text.charCodeAt(i + 1))) for (i++; isDigit(text.charCodeAt(i)); ) i++
  if (text[i] === 'e' || text[i] === 'E') {
    let j = i + 1
    if (text[j] === '+' || text[j] === '-') j++
    if (isDigit(text.charCodeAt(j))) for (i = j; isDigit(text.charCodeAt(i)); ) i++
  }
  return i
}

/** The index of the quote that closes the string opened at `i`, or -1 (a newline ends it unclosed). */
function stringEnd(text: string, i: number): number {
  const quote = text[i]
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j]
    if (ch === '\\') j++
    else if (ch === quote) return j
    else if (ch === '\n' || ch === '\r' || ch === '\f') return -1
  }
  return -1
}

/**
 * The index of the `)` that ends the unquoted url token whose body starts at `j`, or -1 when the
 * tokenizer would read a bad url there: a quote, `(`, `\`, a non-printable code point, whitespace
 * before anything but `)`, or no `)` at all.
 */
function urlTokenEnd(text: string, j: number): number {
  for (; j < text.length; j++) {
    const ch = text[j]!
    const c = ch.charCodeAt(0)
    if (ch === ')') return j
    if (isSpace(ch)) {
      while (isSpace(text[j + 1])) j++
      return text[j + 1] === ')' ? j + 1 : -1
    }
    if (ch === '"' || ch === "'" || ch === '(' || ch === '\\' || c <= 8 || c === 11 || (c >= 14 && c <= 31) || c === 127) return -1
  }
  return -1
}

/** Why a url() of this argument is refused: only one of a fragment or a resource scheme loads nothing. */
function fetchProblem(policy: SafetyPolicy, arg: string): string | undefined {
  const v = arg.trim().toLowerCase()
  if (v.startsWith('#') || policy.resourceSchemes.some((p) => v.startsWith(p))) return undefined
  return 'authored styles may not load a resource (url())'
}
