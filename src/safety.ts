// Safe authoring (ontology/layers/safety.ttl): what a rendering from an untrusted author may
// contain. A projection is authored when its host gives it a policy; the HTML index applies it to
// every element and attribute it hands out (src/render/html-index.ts), and the style compiler to
// every string it writes from the graph (src/style/compile.ts). What is refused is reported, never
// dropped silently.
import { H, NS, RDF_TYPE } from './ns.ts'
import type { GraphStore } from './store/types.ts'

const SAFE = NS.safe
export const SAFETY = {
  Policy: SAFE + 'Policy',
  Authored: SAFE + 'Authored',
  element: SAFE + 'element',
  attribute: SAFE + 'attribute',
  attributePrefix: SAFE + 'attributePrefix',
  urlAttribute: SAFE + 'urlAttribute',
  urlListAttribute: SAFE + 'urlListAttribute',
  resourceAttribute: SAFE + 'resourceAttribute',
  scheme: SAFE + 'scheme',
  resourceScheme: SAFE + 'resourceScheme',
  styleAttribute: SAFE + 'styleAttribute',
  cssValueAttribute: SAFE + 'cssValueAttribute',
  fetchingFunction: SAFE + 'fetchingFunction',
  refusedProperty: SAFE + 'refusedProperty',
} as const

/** A safe:Policy, read for use: element classes as the HTML index names them ("Div", "svg:Rect"). */
export interface SafetyPolicy {
  iri: string
  elements: ReadonlySet<string>
  attributes: ReadonlySet<string>
  prefixes: readonly string[]
  urlAttributes: ReadonlySet<string>
  urlListAttributes: ReadonlySet<string>
  resourceAttributes: ReadonlySet<string>
  schemes: ReadonlySet<string>
  resourceSchemes: readonly string[]
  styleAttributes: ReadonlySet<string>
  cssValueAttributes: ReadonlySet<string>
  fetchingFunctions: ReadonlySet<string>
  refusedProperties: ReadonlySet<string>
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
  return {
    iri,
    elements,
    attributes: new Set(values(SAFETY.attribute)),
    prefixes: lower(SAFETY.attributePrefix),
    urlAttributes: new Set(lower(SAFETY.urlAttribute)),
    urlListAttributes: new Set(lower(SAFETY.urlListAttribute)),
    resourceAttributes: new Set(lower(SAFETY.resourceAttribute)),
    schemes: new Set(lower(SAFETY.scheme)),
    resourceSchemes: lower(SAFETY.resourceScheme),
    styleAttributes: new Set(lower(SAFETY.styleAttribute)),
    cssValueAttributes: new Set(lower(SAFETY.cssValueAttribute)),
    fetchingFunctions: new Set(lower(SAFETY.fetchingFunction)),
    refusedProperties: new Set(lower(SAFETY.refusedProperty)),
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
    /** What it was: an element, an attribute, a URL, a style. */
    readonly kind: 'element' | 'attribute' | 'url' | 'style',
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

/**
 * Why an attribute is refused, or undefined when it is allowed: its name is listed or has a listed
 * prefix, and a URL, a srcset or a style in it passes its check.
 */
export function attributeProblem(policy: SafetyPolicy, name: string, value: string): { kind: Refused['kind']; reason: string } | undefined {
  const lower = name.toLowerCase()
  const named = policy.attributes.has(name) || policy.attributes.has(lower) || policy.prefixes.some((p) => lower.startsWith(p) && /^[a-z0-9][a-z0-9-]*$/.test(lower.slice(p.length)))
  if (!named) return { kind: 'attribute', reason: `authored content may not have the attribute ${name}` }
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
 * Why a URL is refused, or undefined: relative, a fragment, or of a listed scheme (`resource`: also
 * of a listed resource scheme). Read as a browser reads it: tabs and newlines anywhere, and spaces
 * and controls around it, do not count.
 */
export function urlProblem(policy: SafetyPolicy, url: string, resource = false): string | undefined {
  const v = url.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '')
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(v)?.[1]
  if (scheme === undefined) return undefined
  const lower = v.toLowerCase()
  if (policy.schemes.has(scheme.toLowerCase() + ':')) return undefined
  if (resource && policy.resourceSchemes.some((p) => lower.startsWith(p))) return undefined
  return `authored content may not have a ${scheme.toLowerCase()}: URL here`
}

/** Why a list of CSS declarations ("a: b; c: d", a style attribute) is refused, or undefined. */
export function declarationsProblem(policy: SafetyPolicy, text: string): string | undefined {
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
  if (as === 'name') return /^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(text) ? undefined : `"${text}" is not a CSS name`
  if (as === 'step') return /^\s*(?:from|to|\d+(?:\.\d+)?%)(?:\s*,\s*(?:from|to|\d+(?:\.\d+)?%))*\s*$/.test(text) ? undefined : `"${text}" is not a keyframe step`
  const scanned = scan(policy, text, as)
  return typeof scanned === 'string' ? scanned : undefined
}

/**
 * Read CSS text as a tokenizer would, far enough to know it stays what it is: no block, rule or
 * at-rule can start in it (no {, }, @, <, nor ; outside a declaration list), no escape outside a
 * string (an escape can spell url), quotes and brackets balance, and no function that fetches a
 * resource, except url() of a fragment or of a resource scheme. A declaration list comes back
 * split at its top-level semicolons; anything else as one piece. A string is a reason it is refused.
 */
function scan(policy: SafetyPolicy, text: string, as: 'value' | 'selector' | 'media' | 'declarations'): string[] | string {
  const parts: string[] = []
  let start = 0
  const closers: string[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '"' || ch === "'") {
      const end = stringEnd(text, i)
      if (end < 0) return 'a CSS string is not closed'
      i = end
      continue
    }
    if (ch === '\\') return 'authored styles may not escape characters outside a string'
    if (ch === '{' || ch === '}' || ch === '@' || ch === '<') return `authored styles may not hold "${ch}" here`
    if (ch === ';') {
      if (as !== 'declarations' || closers.length) return 'authored styles may not hold ";" here'
      parts.push(text.slice(start, i))
      start = i + 1
      continue
    }
    if (ch === '(' || ch === '[') {
      closers.push(ch === '(' ? ')' : ']')
      if (ch === '(') {
        const name = /([A-Za-z_-][A-Za-z0-9_-]*)$/.exec(text.slice(0, i))?.[1]?.toLowerCase()
        if (name && policy.fetchingFunctions.has(name)) {
          const why = fetchProblem(policy, name, text, i)
          if (why) return why
        }
      }
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

/** Why a fetching function at `open` (its parenthesis) is refused: only url() of a fragment or a resource scheme loads nothing. */
function fetchProblem(policy: SafetyPolicy, name: string, text: string, open: number): string | undefined {
  if (name === 'url') {
    let j = open + 1
    while (text[j] === ' ' || text[j] === '\t') j++
    let arg: string
    if (text[j] === '"' || text[j] === "'") {
      const end = stringEnd(text, j)
      arg = end < 0 ? '' : text.slice(j + 1, end)
    } else {
      const close = text.indexOf(')', j)
      arg = close < 0 ? '' : text.slice(j, close)
    }
    const v = arg.trim().toLowerCase()
    if (v.startsWith('#') || policy.resourceSchemes.some((p) => v.startsWith(p))) return undefined
  }
  return `authored styles may not load a resource (${name}())`
}
