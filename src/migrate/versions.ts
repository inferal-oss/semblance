// Per-component versions and the term list (#473): what is recorded in ontology/versions.ttl and
// ontology/terms.ttl, checked against the ontology as it is now. A component's closure is what the
// ontology says about it (its description, and the rules, reactions, styles and shapes about it,
// grouped as src/subset.ts groups them); a closure that changed needs a version step, and a step
// records whether a chg:Change explains it or why nothing a consumer would notice changed.
import type { Quad, Term } from '@rdfjs/types'
import { createHash } from 'node:crypto'
import { Parser } from 'n3'
import { NS, RDF_TYPE, RDFS_SUBCLASS } from '../ns.ts'

const SEM = NS.sem
const CHG = 'https://semblance.dev/ns/change#'
const MIG = 'https://semblance.dev/ns/migration#'
const SH = NS.sh
const RDF_FIRST = NS.rdf + 'first'
const RDF_REST = NS.rdf + 'rest'
const RDF_NIL = NS.rdf + 'nil'
const FRAMEWORK = 'https://semblance.dev/ns/'
/** Changes are named here: `change:<slug>`. */
export const CHANGE_BASE = 'https://semblance.dev/change/'

/** What makes a description about a class (as in src/subset.ts). */
const GUARDS = [SEM + 'targets', NS.sty + 'appliesTo', SH + 'targetClass', NS.beh + 'sourceClass']
/** A rule that implements a rendering, or takes its query from another rule, is about what that one is about. */
const VIA = [SEM + 'implements', SEM + 'constructFrom']
/** What is implementation, not a term an app states or reads: it may come and go without a change. */
const IMPLEMENTATION = new Set([
  SEM + 'Rule',
  SEM + 'Rendering',
  SEM + 'BuildingBlock',
  NS.beh + 'Reaction',
  SH + 'NodeShape',
  SH + 'PropertyShape',
  NS.owl + 'Ontology',
  NS.c + 'Phrase',
  NS.c + 'SparqlFunction',
  NS.c + 'SparqlKeyword',
  NS.blk + 'Conversion',
  SEM + 'RetiredTerm',
])

const parse = (text: string): Quad[] => new Parser().parse(text) as Quad[]
const key = (t: Term) => (t.termType === 'BlankNode' ? '_:' + t.value : t.value)

/** What the ontology says now: each versioned class's closure hash, and the terms it defines. */
export interface Definitions {
  closures: Map<string, string>
  terms: Set<string>
}

/** The closures and terms of the ontology's Turtle texts. File order and blank node labels do not matter. */
export function definitions(texts: string[]): Definitions {
  const quads = texts.flatMap(parse)
  const bySubject = new Map<string, Quad[]>()
  const objectBlanks = new Set<string>()
  const supers = new Map<string, string[]>()
  const types = new Map<string, string[]>()
  for (const q of quads) {
    push(bySubject, key(q.subject), q)
    if (q.object.termType === 'BlankNode') objectBlanks.add(key(q.object))
    if (q.predicate.value === RDFS_SUBCLASS && q.object.termType === 'NamedNode') push(supers, q.subject.value, q.object.value)
    if (q.predicate.value === RDF_TYPE && q.subject.termType === 'NamedNode') push(types, q.subject.value, q.object.value)
  }
  const isComponent = (c: string, seen = new Set<string>()): boolean => {
    if (c === SEM + 'Component') return true
    if (seen.has(c)) return false
    seen.add(c)
    return (supers.get(c) ?? []).some((s) => isComponent(s, seen))
  }

  // A blank node is its statements: labels and order leave no mark.
  const canon = (s: string, path: Set<string>): string => {
    if (path.has(s)) return '[cycle]'
    path.add(s)
    const lines = (bySubject.get(s) ?? []).map((q) => `${q.predicate.value} ${object(q.object, path)}`).sort()
    path.delete(s)
    return lines.join('\n')
  }
  const object = (o: Term, path: Set<string>): string => {
    if (o.termType === 'BlankNode') return `[${canon(key(o), path)}]`
    if (o.termType === 'Literal') return `${JSON.stringify(o.value)}^^${o.datatype.value}@${o.language}`
    return `<${o.value}>`
  }

  // Which classes each description is about.
  const about = new Map<string, Set<string>>()
  const named = new Set<string>()
  for (const [s, own] of bySubject) {
    for (const q of own) {
      if (GUARDS.includes(q.predicate.value) && q.object.termType === 'NamedNode' && q.object.value.startsWith(FRAMEWORK)) {
        let a = about.get(s)
        if (!a) about.set(s, (a = new Set()))
        a.add(q.object.value)
      }
    }
    if (!s.startsWith('_:')) named.add(s)
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const [s, own] of bySubject) {
      for (const q of own) {
        if (!VIA.includes(q.predicate.value)) continue
        for (const c of about.get(q.object.value) ?? []) {
          let a = about.get(s)
          if (!a) about.set(s, (a = new Set()))
          if (!a.has(c)) a.add(c), (changed = true)
        }
      }
    }
  }

  const versioned = new Set<string>()
  for (const s of named) if (s.startsWith(FRAMEWORK) && isComponent(s)) versioned.add(s)
  for (const a of about.values()) for (const c of a) versioned.add(c)

  const parts = new Map<string, string[]>()
  for (const c of versioned) parts.set(c, bySubject.has(c) ? [`<${c}>\n${canon(c, new Set())}`] : [])
  for (const [s, a] of about) {
    if (s.startsWith('_:') && objectBlanks.has(s)) continue
    const text = `${s.startsWith('_:') ? '[]' : `<${s}>`}\n${canon(s, new Set())}`
    for (const c of a) if (c !== s) parts.get(c)!.push(text)
  }
  const closures = new Map<string, string>()
  for (const [c, lines] of parts) closures.set(c, createHash('sha256').update(lines.sort().join('\n\n')).digest('hex').slice(0, 16))

  const terms = new Set<string>()
  for (const [s, ts] of types) if (s.startsWith(FRAMEWORK) && !ts.some((t) => IMPLEMENTATION.has(t))) terms.add(s)
  return { closures, terms }
}

/** A recorded version: the closure it was taken at, and what accounts for its last step. */
export interface Recorded {
  version: number
  closure: string
  /** The chg:Change that explains the last step. */
  changedBy?: string
  /** Why the last step needs no change. */
  internal?: string
}

export function readVersions(text: string): Map<string, Recorded> {
  const out = new Map<string, Recorded>()
  for (const q of parse(text)) {
    let r = out.get(q.subject.value)
    if (!r) out.set(q.subject.value, (r = { version: 0, closure: '' }))
    if (q.predicate.value === SEM + 'version') r.version = Number(q.object.value)
    else if (q.predicate.value === SEM + 'closure') r.closure = q.object.value
    else if (q.predicate.value === SEM + 'changedBy') r.changedBy = q.object.value
    else if (q.predicate.value === SEM + 'internal') r.internal = q.object.value
  }
  return out
}

export interface TermList {
  current: Set<string>
  retired: Set<string>
}

export function readTerms(text: string): TermList {
  const out: TermList = { current: new Set(), retired: new Set() }
  for (const q of parse(text)) {
    if (q.predicate.value !== RDF_TYPE) continue
    if (q.object.value === SEM + 'Term') out.current.add(q.subject.value)
    else if (q.object.value === SEM + 'RetiredTerm') out.retired.add(q.subject.value)
  }
  return out
}

/** A chg:Change as the checks need it. */
export interface Change {
  iri: string
  affects: Set<string>
  /** The terms it retires: those it states, and every mig:renames' old term. */
  retires: Set<string>
  /** Each mig:renames' new term, and whether its migration says what is lost. */
  renamesTo: { term: string; old: string; loses: boolean }[]
  problems: string[]
}

/** The changes in ontology/changes/ (their Turtle texts), `shape` being chg:ChangeShape's own file. */
export function readChanges(texts: string[], shape: string): Change[] {
  const shapeQuads = parse(shape)
  const shapeNode = shapeQuads.find((q) => q.predicate.value === SH + 'targetClass' && q.object.value === CHG + 'Change')?.subject
  const required: string[] = []
  for (const q of shapeQuads) {
    if (!shapeNode || !q.subject.equals(shapeNode) || q.predicate.value !== SH + 'property') continue
    const here = shapeQuads.filter((x) => x.subject.equals(q.object))
    const path = here.find((x) => x.predicate.value === SH + 'path')
    if (path && here.some((x) => x.predicate.value === SH + 'minCount' && Number(x.object.value) >= 1)) required.push(path.object.value)
  }
  const out: Change[] = []
  for (const text of texts) {
    const quads = parse(text)
    const of = (s: Term, p: string) => quads.filter((q) => q.subject.equals(s) && q.predicate.value === p).map((q) => q.object)
    const list = (head: Term | undefined): Term[] => {
      const items: Term[] = []
      for (let at = head; at && at.value !== RDF_NIL; at = of(at, RDF_REST)[0]) items.push(...of(at, RDF_FIRST))
      return items
    }
    for (const q of quads) {
      if (q.predicate.value !== RDF_TYPE || q.object.value !== CHG + 'Change') continue
      const c: Change = { iri: q.subject.value, affects: new Set(of(q.subject, CHG + 'affects').map((t) => t.value)), retires: new Set(of(q.subject, CHG + 'retires').map((t) => t.value)), renamesTo: [], problems: [] }
      for (const p of required) if (!of(q.subject, p).length) c.problems.push(`says nothing for ${shortName(p)}`)
      if (quads.some((x) => x.object.termType === 'Literal' && x.object.value.includes('TODO'))) c.problems.push('still has TODO in its text')
      const migrations = list(of(q.subject, CHG + 'migrations')[0])
      for (const m of migrations) {
        const renames = of(m, MIG + 'renames')
        const name = shortName(m.value)
        for (const r of renames) {
          const old = of(r, MIG + 'old')[0]
          if (!old || !of(r, MIG + 'new')[0]) c.problems.push(`${name}: a mig:renames needs mig:old and mig:new`)
          else if (old.termType === 'NamedNode') {
            c.retires.add(old.value)
            c.renamesTo.push({ term: of(r, MIG + 'new')[0]!.value, old: old.value, loses: of(m, MIG + 'loses').length > 0 })
          }
        }
        const forward = of(m, MIG + 'forward').length > 0
        if (!forward && !renames.length) c.problems.push(`${name}: neither mig:renames nor mig:forward`)
        if (forward && !of(m, MIG + 'backward').length && !of(m, MIG + 'loses').length) c.problems.push(`${name}: mig:forward with neither mig:backward nor mig:loses`)
        if (forward && !of(m, MIG + 'example').length) c.problems.push(`${name}: mig:forward with no mig:example`)
        for (const p of ['of', 'from', 'to']) if (!of(m, MIG + p).length) c.problems.push(`${name}: no mig:${p}`)
      }
      out.push(c)
    }
  }
  return out
}

export type Problem =
  | { kind: 'changed'; iri: string; recorded: string; now: string }
  | { kind: 'new'; iri: string }
  | { kind: 'gone'; iri: string }
  | { kind: 'unaccounted'; iri: string; changedBy?: string }
  | { kind: 'term-new'; iri: string }
  | { kind: 'term-gone'; iri: string }
  | { kind: 'term-unexplained'; iri: string }
  | { kind: 'term-reused'; iri: string }
  | { kind: 'change-invalid'; iri: string; problem: string }
  | { kind: 'converges'; iri: string; term: string }
  | { kind: 'no-step'; iri: string; version: number }
  | { kind: 'version-down'; iri: string; was: number; now: number }
  | { kind: 'term-dropped'; iri: string }
  | { kind: 'retired-stale'; iri: string }

export interface State {
  definitions: Definitions
  versions: Map<string, Recorded>
  terms: TermList
  changes: Change[]
  /** ontology/layers/retired.ttl as it is. */
  retiredFile?: string
}

/** What base (the same two files on the branch this one merges into) holds, for the checks a single checkout cannot make. */
/** A retired term, and its new name when it was renamed: what a page reads (ontology/layers/retired.ttl). */
export function writeRetired(terms: TermList, changes: Change[]): string {
  const direct = new Map<string, string>()
  for (const c of changes) for (const r of c.renamesTo) direct.set(r.old, r.term)
  const final = (t: string): string | undefined => {
    let at = direct.get(t)
    for (let n = 0; at && direct.has(at) && n < 64; n++) at = direct.get(at)
    return at
  }
  const lines = [...terms.retired].sort().map((t) => {
    const to = final(t)
    return `${shortName(t)} a sem:RetiredTerm${to ? ` ; mig:renamedTo ${shortName(to)}` : ''} .`
  })
  return `${header([...lines, 'mig:x'])}\n\n# Generated by \`npm run versions\`: the names that went, for a page to read. Loaded with the ontology.\n\n${lines.join('\n')}${lines.length ? '\n' : ''}`
}

export interface Base {
  definitions?: Definitions
  versions: Map<string, Recorded>
  terms: TermList
}

/** Everything that keeps the recorded versions and terms from matching the ontology. */
export function check(s: State, base?: Base): Problem[] {
  const out: Problem[] = []
  const changes = new Map(s.changes.map((c) => [c.iri, c]))
  const retiredBy = new Set(s.changes.flatMap((c) => [...c.retires]))
  for (const c of s.changes) for (const problem of c.problems) out.push({ kind: 'change-invalid', iri: c.iri, problem })
  // Several renames onto one term lose which it was: a discriminator (mig:forward) or mig:loses.
  const landing = new Map<string, { old: string; loses: boolean }[]>()
  for (const c of s.changes) for (const r of c.renamesTo) push(landing, r.term, r)
  for (const [term, rs] of landing) if (rs.length > 1) for (const r of rs) if (!r.loses) out.push({ kind: 'converges', iri: r.old, term })
  for (const [iri, closure] of s.definitions.closures) {
    const r = s.versions.get(iri)
    if (!r) out.push({ kind: 'new', iri })
    else if (r.closure !== closure) out.push({ kind: 'changed', iri, recorded: r.closure, now: closure })
    else if (r.changedBy ? !changes.has(r.changedBy) || !changes.get(r.changedBy)!.affects.has(iri) : !r.internal) out.push({ kind: 'unaccounted', iri, changedBy: r.changedBy })
  }
  for (const iri of s.versions.keys()) if (!s.definitions.closures.has(iri)) out.push({ kind: 'gone', iri })
  for (const iri of s.definitions.terms) {
    if (s.terms.retired.has(iri)) out.push({ kind: 'term-reused', iri })
    else if (!s.terms.current.has(iri)) out.push({ kind: 'term-new', iri })
  }
  for (const iri of s.terms.current) if (!s.definitions.terms.has(iri)) out.push(retiredBy.has(iri) ? { kind: 'term-gone', iri } : { kind: 'term-unexplained', iri })
  if (s.retiredFile !== undefined && s.retiredFile !== writeRetired(s.terms, s.changes)) out.push({ kind: 'retired-stale', iri: 'ontology/layers/retired.ttl' })
  if (base) {
    for (const [iri, r] of s.versions) {
      const was = base.versions.get(iri)
      if (!was) continue
      if (r.version < was.version) out.push({ kind: 'version-down', iri, was: was.version, now: r.version })
      else if (r.closure !== was.closure && r.version === was.version) out.push({ kind: 'no-step', iri, version: r.version })
    }
    for (const iri of base.terms.current) if (!s.terms.current.has(iri) && !s.terms.retired.has(iri)) out.push({ kind: 'term-dropped', iri })
    for (const iri of base.terms.retired) if (!s.terms.retired.has(iri)) out.push({ kind: 'term-dropped', iri })
  }
  return out
}

export interface BumpOptions {
  /** The change that explains the components it affects. */
  change?: string
  /** Why the components left over need no change. */
  internal?: string
}

export interface Bumped {
  versions: Map<string, Recorded>
  terms: TermList
  /** Components that changed and that neither option accounts for: nothing was written. */
  undecided: string[]
  /** Terms gone with no change retiring them: nothing was written. */
  unexplained: string[]
  stepped: string[]
}

/** The records after a version step for every changed component, and terms brought up to date. */
export function bump(s: State, options: BumpOptions): Bumped {
  const change = options.change ? s.changes.find((c) => c.iri === options.change) : undefined
  const versions = new Map<string, Recorded>()
  const undecided: string[] = []
  const stepped: string[] = []
  for (const [iri, closure] of s.definitions.closures) {
    const r = s.versions.get(iri)
    if (!r) versions.set(iri, { version: 1, closure, internal: 'new' })
    else if (r.closure === closure) versions.set(iri, r)
    else if (change?.affects.has(iri)) versions.set(iri, { version: r.version + 1, closure, changedBy: change.iri }), stepped.push(iri)
    else if (options.internal) versions.set(iri, { version: r.version + 1, closure, internal: options.internal }), stepped.push(iri)
    else undecided.push(iri), versions.set(iri, r)
  }
  const retiredBy = new Set(s.changes.flatMap((c) => [...c.retires]))
  const terms: TermList = { current: new Set(s.definitions.terms), retired: new Set(s.terms.retired) }
  const unexplained: string[] = []
  for (const iri of s.terms.current) {
    if (s.definitions.terms.has(iri)) continue
    if (retiredBy.has(iri)) terms.retired.add(iri)
    else unexplained.push(iri), terms.current.add(iri)
  }
  return { versions, terms, undecided, unexplained, stepped }
}

const prefixes = Object.entries({ ...NS, change: CHANGE_BASE }).sort((a, b) => b[1].length - a[1].length)

/** An IRI as it is written in the generated files and in messages. */
export function shortName(iri: string): string {
  for (const [p, ns] of prefixes) if (iri.startsWith(ns) && /^[A-Za-z_][\w-]*$/.test(iri.slice(ns.length))) return `${p}:${iri.slice(ns.length)}`
  return `<${iri}>`
}

function header(lines: string[]): string {
  const used = new Set<string>(['sem'])
  for (const l of lines) for (const m of l.matchAll(/(?:^|\s)([a-z][\w]*):[A-Za-z_]/g)) used.add(m[1]!)
  return [...used]
    .sort()
    .flatMap((p) => {
      const ns = p === 'change' ? CHANGE_BASE : (NS as Record<string, string>)[p]
      return ns ? [`@prefix ${p}: <${ns}> .`] : []
    })
    .join('\n')
}

const NOTE = '# Generated by `npm run versions`: do not edit by hand. AGENTS.md says when and how to step a version.\n# Read by the tooling, not loaded with the framework\'s ontology.'

/** One line per component, sorted: two branches conflict only over a component both changed. */
export function writeVersions(versions: Map<string, Recorded>): string {
  const lines = [...versions]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([iri, r]) => `${shortName(iri)} sem:version ${r.version} ; sem:closure "${r.closure}" ; ${r.changedBy ? `sem:changedBy ${shortName(r.changedBy)}` : `sem:internal ${JSON.stringify(r.internal ?? '')}`} .`)
  return `${header(lines)}\n\n${NOTE}\n\n${lines.join('\n')}\n`
}

/** One line per term, sorted. */
export function writeTerms(terms: TermList): string {
  const lines = [...[...terms.current].map((iri) => [iri, 'sem:Term']), ...[...terms.retired].map((iri) => [iri, 'sem:RetiredTerm'])]
    .sort(([a], [b]) => (a! < b! ? -1 : 1))
    .map(([iri, kind]) => `${shortName(iri!)} a ${kind} .`)
  return `${header(lines)}\n\n${NOTE}\n\n${lines.join('\n')}\n`
}

/** A new change file, for its author to fill in; it fails the check until no TODO is left. */
export function changeTemplate(slug: string, affects: string[]): string {
  return `@prefix chg: <${CHG}> .
@prefix mig: <${MIG}> .
@prefix rdfs: <${NS.rdfs}> .
@prefix change: <${CHANGE_BASE}> .
@prefix c: <${NS.c}> .
@prefix sem: <${SEM}> .

# What changed for whoever has to move with it: AGENTS.md, "When a component changes".

change:${slug} a chg:Change ;
    rdfs:label "TODO: the change in one line"@en ;
    chg:issue <https://github.com/inferal-oss/semblance/issues/TODO> ;
    chg:motivation """TODO: why it changed.""" ;
    chg:substance """TODO: what changed, in full, for a person or an agent who has only this.""" ;
    chg:forwardGuide """TODO: how to move, and how to settle by hand what the tool reports.""" ;
    chg:backwardGuide """TODO: how to move back, and what does not return.""" ;
    chg:affects ${affects.join(' , ') || 'c:TODO'} ;
    # Omit chg:migrations for a change of meaning or behaviour alone.
    chg:migrations ( change:${slug}-1 ) .

change:${slug}-1 a mig:Migration ;
    mig:of ${affects[0] || 'c:TODO'} ; mig:from 0 ; mig:to 0 ;
    # A term or slug that takes another name (its own reverse):
    mig:renames [ mig:old c:TODO ; mig:new c:TODO ] .
    # Or a change of shape, in both directions (or mig:loses, saying what does not come back):
    # mig:forward  """DELETE { } INSERT { } WHERE { }""" ;
    # mig:backward """DELETE { } INSERT { } WHERE { }""" ;
    # mig:example [ mig:before """…""" ; mig:after """…""" ] .
`
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k)
  if (a) a.push(v)
  else m.set(k, [v])
}
