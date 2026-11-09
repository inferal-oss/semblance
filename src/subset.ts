// The part of the framework's ontology an app uses (#383): from the app's graphs, the closure of
// the component classes it reaches, and of everything about them (their renderings and rules,
// reactions, shapes, styles in every theme, key bindings, labels). What is about no component
// class (the core, the layers, tokens, themes, phrases) is always kept. docs/SUBSET.md has the
// design; test/subset.test.ts checks that every example renders the same from its subset.
import type { Quad, Term } from '@rdfjs/types'
import { Parser, Writer } from 'n3'
import { NS, RDF_TYPE, RDFS_SUBCLASS } from './ns.ts'

const SEM = NS.sem
const COMPONENT = SEM + 'Component'
/** What makes a description about a class: kept only when the class is reached. */
const GUARDS = [SEM + 'targets', NS.sty + 'appliesTo', 'http://www.w3.org/ns/shacl#targetClass', NS.beh + 'sourceClass']
/** A rule that implements a rendering, or takes its query from another rule, is about what that one is about. */
const VIA = [SEM + 'implements', SEM + 'constructFrom']
/** Text a description holds that may mint instances: a rule's query, a reaction's changes. */
const MINTING = [SEM + 'construct', NS.beh + 'inserts', NS.beh + 'update']
/** A class whose instances read the whole ontology (the Reference, a live example's sandbox): nothing is left out. */
const WHOLE = SEM + 'readsWholeOntology'
const THEME = NS.sty + 'Theme'
const THEME_PROPERTY = NS.sty + 'theme'
const THEME_PROPERTY_NAMES = ['sty:theme', '<' + THEME_PROPERTY + '>']
/**
 * Classes the framework's host code types nodes with (src/engine, src/behaviour, src/rendered.ts,
 * src/sources.ts, src/sandbox.ts, src/persistence.ts, src/view): reached in every app.
 */
const HOST_CLASSES = [
  NS.l10n + 'Viewer',
  NS.l10n + 'Preference',
  NS.prov + 'Activity',
  NS.prov + 'SoftwareAgent',
  NS.prov + 'Association',
  NS.rnd + 'Viewport',
  NS.rnd + 'State',
  NS.c + 'SourceText',
  NS.c + 'SourceSpan',
  NS.rdf + 'Statement',
]

export interface SubsetOptions {
  /** Classes to keep besides those the app's graphs reach (a host that creates instances itself). */
  classes?: Iterable<string>
}

export interface Subset {
  /** The kept statements as Turtle with the framework's prefixes: what an app ships and loads in place of the whole ontology. */
  turtle: string
  /** The kept statements. */
  quads: Quad[]
  /** The classes and themes reached (and kept). */
  classes: Set<string>
  /** Statements in the whole ontology, and kept. */
  total: number
  kept: number
  /** True when a reached class reads the whole ontology (sem:readsWholeOntology): nothing was left out. */
  whole: boolean
  /** Statements in each ontology text, and kept. */
  sources: { total: number; kept: number }[]
}

interface Description {
  quads: Quad[]
  /** What it is about: kept when, in each group, one is reached (none: always kept). */
  guards: string[][]
  /** Its classes. */
  types: string[]
  /** IRIs it states as objects (a rule it takes its query from, a rendering it implements). */
  refs: string[]
  /** Text that may mint instances (queries, reactions' changes). */
  texts: string[]
}

const parse = (text: string): Quad[] => new Parser().parse(text) as Quad[]

/**
 * The subset of `ontology` (Turtle texts, in load order) that `app` (Turtle texts) uses: every
 * statement about no component class, and every statement about a component class the app reaches.
 * A class is reached when an instance of it is in the app's graphs, when it is a superclass of a
 * reached class, or when a kept rule or reaction may mint an instance of it (its text names it).
 */
export function ontologySubset(ontology: string[], app: string[], opts: SubsetOptions = {}): Subset {
  const parsed = ontology.map(parse)
  const quads = parsed.flat()
  const appQuads = app.flatMap(parse)
  const all = [...quads, ...appQuads]

  // Classes, and which are components (subclasses of sem:Component, transitively).
  const supers = new Map<string, Set<string>>()
  for (const q of all) if (q.predicate.value === RDFS_SUBCLASS && q.object.termType === 'NamedNode') add(supers, q.subject.value, q.object.value)
  const ancestors = (c: string, out = new Set<string>()): Set<string> => {
    if (out.has(c)) return out
    out.add(c)
    for (const s of supers.get(c) ?? []) ancestors(s, out)
    return out
  }
  const components = new Set<string>()
  for (const c of supers.keys()) if (ancestors(c).has(COMPONENT)) components.add(c)
  components.add(COMPONENT)
  // Classes something is about (a rule targets, a style applies to, a shape or a reaction is for).
  const guarded = new Set(components)
  for (const q of all) if (GUARDS.includes(q.predicate.value) && q.object.termType === 'NamedNode') guarded.add(q.object.value)
  // Themes: values of sty:theme, each with its tokens and the rules narrowed to it.
  const themes = new Set(all.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === THEME).map((q) => q.subject.value))
  // Component classes by slug (a structural theme's rule names what it styles in its selector).
  const bySlug = new Map<string, string[]>()
  for (const q of all) if (q.predicate.value === SEM + 'slug' && components.has(q.subject.value)) add2(bySlug, q.object.value, q.subject.value)

  // Descriptions: a named subject with the blank nodes it reaches; a blank node no one states is one of its own.
  const bySubject = new Map<string, Quad[]>()
  const objectBlanks = new Set<string>()
  for (const q of quads) {
    let s = bySubject.get(key(q.subject))
    if (!s) bySubject.set(key(q.subject), (s = []))
    s.push(q)
    if (q.object.termType === 'BlankNode') objectBlanks.add(key(q.object))
  }
  const descriptions = new Map<string, Description>()
  for (const [subject, own] of bySubject) {
    if (subject.startsWith('_:') && objectBlanks.has(subject)) continue
    const d: Description = { quads: [], guards: [], refs: [], texts: [], types: [] }
    const seen = new Set<string>()
    const walk = (s: string) => {
      if (seen.has(s)) return
      seen.add(s)
      for (const q of bySubject.get(s) ?? []) {
        d.quads.push(q)
        if (q.object.termType === 'BlankNode') walk(key(q.object))
      }
    }
    walk(subject)
    const about: string[] = []
    for (const q of own) {
      const p = q.predicate.value
      if (GUARDS.includes(p) && guarded.has(q.object.value)) about.push(q.object.value)
      if (p === RDF_TYPE) d.types.push(q.object.value)
      if (q.object.termType === 'NamedNode') d.refs.push(q.object.value)
      // A style rule narrowed to a theme is kept with the theme.
      if (p === NS.sty + 'when' && themes.has(q.object.value)) d.guards.push([q.object.value])
      // A style rule for no class names what it styles in its selector: kept when one of those is.
      if (p === NS.sty + 'part' && !own.some((x) => x.predicate.value === NS.sty + 'appliesTo')) {
        const named = selectorClasses(q.object.value, bySlug)
        if (named) d.guards.push(named)
      }
    }
    if (about.length) d.guards.push(about)
    for (const q of d.quads) if (MINTING.includes(q.predicate.value) && q.object.termType === 'Literal') d.texts.push(q.object.value)
    // A class is about itself, a theme too; an instance of components only, about its classes.
    if (guarded.has(subject) || themes.has(subject)) d.guards.push([subject])
    else if (!subject.startsWith('_:') && d.types.length && d.types.every((t) => components.has(t))) d.guards.push(d.types)
    descriptions.set(subject, d)
  }
  // A rule about a rendering is about what the rendering is about.
  for (const d of descriptions.values()) {
    if (d.guards.length) continue
    for (const q of d.quads) if (VIA.includes(q.predicate.value)) for (const g of descriptions.get(q.object.value)?.guards ?? []) d.guards.push(g)
  }

  // What is reached: the app's classes, those of what is kept, those a kept text may mint (a
  // component class) or names (any other class: it may be read, so it is kept), the themes named,
  // every superclass of each; to a fixpoint.
  const reached = new Set<string>()
  const pending: string[] = []
  const reach = (c: string) => {
    if (themes.has(c)) {
      if (!reached.has(c)) reached.add(c), pending.push(c)
      return
    }
    for (const a of ancestors(c)) if (!reached.has(a)) reached.add(a), pending.push(a)
  }
  const reachAllThemes = () => themes.forEach(reach)
  const minted = classNames(components, NS)
  const named = classNames(new Set([...guarded, ...themes].filter((c) => !components.has(c))), NS)
  const read = (text: string) => {
    const template = templates(text)
    // A template that types a node with a variable may type it with any component class the text names.
    for (const c of mentioned(/(?:\ba|rdf:type)\s+[?$]\w/.test(template) ? text : template, minted)) reach(c)
    for (const c of mentioned(text, named)) reach(c)
    if (THEME_PROPERTY_NAMES.some((n) => text.includes(n))) reachAllThemes()
  }
  for (const c of [COMPONENT, ...HOST_CLASSES, ...(opts.classes ?? [])]) reach(c)
  for (const q of appQuads) {
    // The app's classes, and the component classes its data names (a list's item class, a view to show).
    if (q.predicate.value === RDF_TYPE || components.has(q.object.value)) reach(q.object.value)
    if (q.object.termType === 'NamedNode' && themes.has(q.object.value)) reach(q.object.value)
    if (q.predicate.value === THEME_PROPERTY || q.object.value === THEME_PROPERTY || q.subject.value === THEME_PROPERTY) reachAllThemes()
    if (q.object.termType === 'Literal' && q.object.value.length > 20) read(q.object.value)
  }
  const kept = new Set<string>()
  const satisfied = (d: Description) => d.guards.every((g) => g.some((c) => reached.has(c)))
  const keep = (k: string) => {
    if (kept.has(k)) return
    const d = descriptions.get(k)
    if (!d || !satisfied(d)) return
    kept.add(k)
    for (const t of d.types) reach(t)
    for (const t of d.texts) read(t)
    for (const r of d.refs) {
      if (themes.has(r) && r !== k) reach(r)
      // What it names that is about a class (a rule it takes its query from) is kept with it.
      else if (!guarded.has(r) && descriptions.get(r)?.guards.length) keep(r)
    }
  }
  const byGuard = new Map<string, string[]>()
  for (const [k, d] of descriptions) {
    if (!d.guards.length) keep(k)
    else for (const g of d.guards) for (const c of g) add2(byGuard, c, k)
  }
  while (pending.length) {
    const c = pending.pop()!
    for (const k of byGuard.get(c) ?? []) keep(k)
  }

  const whole = [...reached].some((c) => descriptions.get(c)?.quads.some((q) => q.predicate.value === WHOLE && q.object.value === 'true'))
  const out = whole ? quads : quads.filter((q) => kept.has(ownerOf(q, bySubject, objectBlanks)))
  const keptSet = new Set(out)
  const sources = parsed.map((qs) => ({ total: qs.length, kept: qs.filter((q) => keptSet.has(q)).length }))
  return { turtle: toTurtle(out), quads: out, classes: reached, total: quads.length, kept: out.length, whole, sources }
}

function add(m: Map<string, Set<string>>, k: string, v: string) {
  let s = m.get(k)
  if (!s) m.set(k, (s = new Set()))
  s.add(v)
}
function add2(m: Map<string, string[]>, k: string, v: string) {
  let s = m.get(k)
  if (!s) m.set(k, (s = []))
  s.push(v)
}

const key = (t: Term) => (t.termType === 'BlankNode' ? '_:' + t.value : t.value)

// The description a statement belongs to: its subject's, or that of the named node its blank node hangs from.
const owners = new WeakMap<Map<string, Quad[]>, Map<string, string>>()
function ownerOf(q: Quad, bySubject: Map<string, Quad[]>, objectBlanks: Set<string>): string {
  let parent = owners.get(bySubject)
  if (!parent) {
    owners.set(bySubject, (parent = new Map()))
    for (const [s, qs] of bySubject) for (const x of qs) if (x.object.termType === 'BlankNode') parent.set(key(x.object), s)
  }
  let s = key(q.subject)
  const seen = new Set<string>()
  while (s.startsWith('_:') && objectBlanks.has(s) && !seen.has(s)) seen.add(s), (s = parent.get(s) ?? s)
  return s
}

/** How a class may be named in a text: its IRI, and prefix:local with the framework's prefixes. */
function classNames(classes: Set<string>, prefixes: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of classes) {
    out.set('<' + c + '>', c)
    for (const [p, ns] of Object.entries(prefixes)) if (c.startsWith(ns)) out.set(p + ':' + c.slice(ns.length), c)
  }
  return out
}

/** The classes a text names (with the framework's prefixes, or as IRIs). */
function mentioned(text: string, names: Map<string, string>): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/<[^\s<>"]+>|[A-Za-z][\w-]*:[A-Za-z_][\w-]*/g)) {
    const c = names.get(m[0])
    if (c) out.push(c)
  }
  return out
}

/**
 * The component classes a selector needs one of (by the slugs it names), or undefined when it may
 * match without any: a slug inside :not() is not needed, and neither is any when one alternative
 * of a list names none (every comma splits, at any depth, which only finds more alternatives).
 */
function selectorClasses(selector: string, bySlug: Map<string, string[]>): string[] | undefined {
  let positive = ''
  for (let i = 0; i < selector.length; i++) {
    if (selector.startsWith(':not(', i)) {
      let depth = 0
      for (i += 4; i < selector.length; i++) {
        if (selector[i] === '(') depth++
        else if (selector[i] === ')' && --depth === 0) break
      }
      continue
    }
    positive += selector[i]
  }
  const out: string[] = []
  for (const alternative of positive.split(',')) {
    const slugs = [...alternative.matchAll(/data-sem-c="?([\w-]+)/g)].map((m) => m[1]!)
    const classes = slugs.flatMap((s) => bySlug.get(s) ?? [])
    if (!classes.length) return undefined
    out.push(...classes)
  }
  return out
}

/** The template blocks of a query or update: what follows CONSTRUCT or INSERT (DATA), to its closing brace. */
function templates(text: string): string {
  let out = ''
  for (const m of text.matchAll(/\b(?:CONSTRUCT|INSERT)(?:\s+DATA)?\s*\{/gi)) {
    let depth = 1
    let i = m.index! + m[0].length
    const start = i
    while (i < text.length && depth) {
      const c = text[i]!
      if (c === '"' || c === "'") {
        const q = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c
        i += q.length
        while (i < text.length && !text.startsWith(q, i)) i += text[i] === '\\' ? 2 : 1
        i += q.length
        continue
      }
      if (c === '<') {
        const j = text.indexOf('>', i)
        if (j > 0 && !/\s/.test(text.slice(i, j))) {
          i = j + 1
          continue
        }
      }
      if (c === '{') depth++
      else if (c === '}') depth--
      i++
    }
    out += text.slice(start, i - 1) + '\n'
  }
  return out
}

function toTurtle(quads: Quad[]): string {
  const writer = new Writer({ prefixes: NS })
  writer.addQuads(quads)
  let out = ''
  writer.end((error, text) => {
    if (error) throw error
    out = text ?? ''
  })
  return out
}
