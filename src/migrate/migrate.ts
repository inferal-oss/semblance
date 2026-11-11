// Moving what was written against one version of the framework to another (#473): renames reach
// every occurrence token by token, including the SPARQL and the Turtle held in literals; a change of
// shape runs as SPARQL over the files' triples, and only those triples are edited. Forward and back
// are the same machinery. What cannot be done mechanically is reported, with the change that explains it.
import { createStore } from '../node/load.ts'
import { NS, SPARQL_PREFIXES } from '../ns.ts'
import { parseQuery, SparqlSyntaxError } from '../view/sparql.ts'
import type { LoadedChange, MigrationStep, Rename } from './changes.ts'
import { applyEdit, compactIri, type Doc, lex, parseTurtle, type Term, type Tok, type Triple, tripleKey, TurtleSyntaxError, UnsupportedTurtle } from './turtle.ts'

export interface SourceFile {
  path: string
  text: string
}

/**
 * migrated: done. review: needs a person's or agent's judgement. manual: names a retired term where
 * the tool cannot reach. meaning: a change of meaning or behaviour to read. prose: named in text, left alone.
 */
export type FindingKind = 'migrated' | 'review' | 'manual' | 'meaning' | 'prose'

export interface Finding {
  kind: FindingKind
  message: string
  file?: string
  line?: number
  term?: string
  /** The change to read: its guides say how to settle this. */
  change?: string
  migration?: string
}

export interface MigrateOptions {
  files: SourceFile[]
  changes: LoadedChange[]
  direction?: 'forward' | 'backward'
  /** Forward: the release the files were written against. Absent: changes are found by the retired terms that occur. */
  from?: string
  /** Backward: the release to go back to. */
  to?: string
  /** Changes already applied: never applied again; going back, the ones undone. */
  applied?: Iterable<string>
}

export interface MigrateResult {
  files: SourceFile[]
  findings: Finding[]
  /** Changes applied (going back: undone), in order. */
  changes: string[]
}

const TURTLE = /\.ttl$/
const looksLikeQuery = (s: string) => s.includes('{') && /^\s*(PREFIX|BASE|SELECT|CONSTRUCT|ASK|DESCRIBE|INSERT|DELETE|WITH)\b/i.test(s.replace(/#[^\n]*\n/g, ''))
const looksLikeTurtle = (s: string) => /(^|\n)\s*@prefix\s/.test(s)
const frameworkPrefixes = new Map<string, string>(Object.entries(NS))

/** Compares dotted versions numerically. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

const RDF_12 = /\{\||\s~\s|<<\s*[(<?]/
const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length

interface Names {
  terms: Map<string, string>
  slugs: Map<string, string>
}

interface Occurrence {
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
function renameText(text: string, names: Names, inherited: Map<string, string>, seen: (o: Occurrence) => void, baseLine = 1): string {
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

/** A bnode as the store holds it during a run: blank nodes keep their identity across the diff. */
const FROZEN = 'urn:semblance:migrate:bnode:'
const ntTerm = (t: Term): string => {
  if (t.k === 'iri') return `<${t.v}>`
  if (t.k === 'bnode') return `<${FROZEN}${t.v}>`
  return `${JSON.stringify(t.value)}${t.lang ? `@${t.lang}` : t.dt ? `^^<${t.dt}>` : ''}`
}
const XSD_STRING = NS.xsd + 'string'
const LANG_STRING = NS.rdf + 'langString'

interface Rdf {
  termType: string
  value: string
  language?: string
  datatype?: { value: string }
}
const fromStore = (t: Rdf, raws: Map<string, string>): Term => {
  if (t.termType === 'NamedNode') return t.value.startsWith(FROZEN) ? { k: 'bnode', v: t.value.slice(FROZEN.length) } : { k: 'iri', v: t.value }
  const dt = t.datatype?.value
  const lit: Term = { k: 'lit', value: t.value, raw: '', ...(t.language ? { lang: t.language } : dt && dt !== XSD_STRING && dt !== LANG_STRING ? { dt } : {}) }
  lit.raw = raws.get(JSON.stringify([lit.value, lit.lang, lit.dt])) ?? ''
  return lit
}

/** Runs a SPARQL Update over the files' triples and edits only the triples it changed. */
async function applyUpdate(files: SourceFile[], update: string, findings: Finding[], where: { change: string; migration: string }): Promise<SourceFile[]> {
  const docs = files.map((f, i): Doc | undefined => {
    if (!TURTLE.test(f.path)) return undefined
    try {
      return parseTurtle(f.text, `f${i}b`)
    } catch (e) {
      if (!(e instanceof UnsupportedTurtle)) throw e
      findings.push({ kind: 'review', message: `${e.message}: changes of shape do not reach this file`, file: f.path, ...where })
      return undefined
    }
  })
  const store = createStore('wat')
  const raws = new Map<string, string>()
  const sources = new Map<string, { file: number; triple: Triple }[]>()
  const all: Triple[] = []
  docs.forEach((d, file) => {
    for (const t of d?.triples ?? []) {
      all.push(t)
      const k = tripleKey(t)
      sources.set(k, [...(sources.get(k) ?? []), { file, triple: t }])
      if (t.o.k === 'lit' && t.o.raw) raws.set(JSON.stringify([t.o.value, t.o.lang, t.o.dt === XSD_STRING ? undefined : t.o.dt]), t.o.raw)
    }
  })
  store.loadTurtle(all.map((t) => `${ntTerm(t.s)} <${t.p}> ${ntTerm(t.o)} .`).join('\n'))
  await store.update!(SPARQL_PREFIXES + '\n' + update)
  const after = store.construct(SPARQL_PREFIXES + '\nCONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', [store.factory.defaultGraph()]).map((q) => ({ s: fromStore(q.subject as Rdf, raws), p: q.predicate.value, o: fromStore(q.object as Rdf, raws) }))
  const afterKeys = new Set(after.map(tripleKey))
  const removed = [...sources.keys()].filter((k) => !afterKeys.has(k))
  const added = after.filter((t) => !sources.has(tripleKey(t)))
  if (!removed.length && !added.length) return files

  const edits = files.map(() => ({ remove: [] as Triple[], add: [] as { s: Term; p: string; o: Term }[] }))
  for (const k of removed) {
    for (const { file, triple } of sources.get(k)!) {
      if (!triple.object) findings.push({ kind: 'manual', message: 'a change of shape reaches inside a ( … ) collection, which is not edited', file: files[file]!.path, ...where })
      else edits[file]!.remove.push(triple)
    }
  }
  const subjectFile = new Map<string, number>()
  edits.forEach((e, file) => {
    for (const t of e.remove) if (!subjectFile.has(JSON.stringify(t.s))) subjectFile.set(JSON.stringify(t.s), file)
  })
  docs.forEach((d, file) => {
    for (const s of d?.statements ?? []) if (!subjectFile.has(JSON.stringify(s.subject))) subjectFile.set(JSON.stringify(s.subject), file)
  })
  const key = (t: Term) => JSON.stringify(t.k === 'lit' ? { ...t, raw: '' } : t)
  const subjectKey = new Map<string, number>()
  for (const [k, f] of subjectFile) subjectKey.set(key(JSON.parse(k) as Term), f)
  // A new node goes with what points at it.
  const place = (t: { s: Term; o: Term }): number | undefined => subjectKey.get(key(t.s))
  for (const t of added) {
    let file = place(t)
    if (file === undefined) {
      const parent = added.find((p) => key(p.o) === key(t.s) && place(p) !== undefined)
      file = parent ? place(parent) : docs.findIndex(Boolean)
      if (file !== undefined && file >= 0) subjectKey.set(key(t.s), file)
    }
    edits[file ?? 0]!.add.push(t)
  }
  return files.map((f, i) => {
    const e = edits[i]!
    if (!e.remove.length && !e.add.length) return f
    findings.push({ kind: 'migrated', message: `${e.remove.length} statement(s) removed, ${e.add.length} added`, file: f.path, ...where })
    return { path: f.path, text: applyEdit(docs[i]!, e) }
  })
}

/** Which changes a run applies, in the order it applies them. */
function select(opts: MigrateOptions): { active: LoadedChange[]; findings: Finding[] } {
  const applied = new Set(opts.applied ?? [])
  const findings: Finding[] = []
  const pool = opts.direction === 'backward' ? [...opts.changes].reverse() : opts.changes
  if (opts.direction === 'backward') {
    const to = opts.to
    const active = pool.filter((c) => applied.has(c.iri) || (to !== undefined && c.release !== undefined && compareVersions(c.release, to) > 0))
    return { active, findings }
  }
  const occurrence = occurrenceOf(opts.files)
  const active: LoadedChange[] = []
  for (const c of pool) {
    if (applied.has(c.iri)) continue
    if (opts.from !== undefined) {
      if (c.release !== undefined && compareVersions(c.release, opts.from) <= 0) continue
      active.push(c)
      continue
    }
    const terms = c.retires.some(occurrence)
    const slugs = c.migrations.some((m) => m.renames.some((r) => r.kind === 'slug' && occurrence(r.old)))
    if (terms || slugs) active.push(c)
    else if (!c.migrations.length) findings.push({ kind: 'meaning', message: `${c.label}: a change of meaning or behaviour, which leaves no trace in the source. Read it, and say what you were written against (--from).`, change: c.iri })
  }
  return { active, findings }
}

/** Whether a term or slug occurs anywhere in the files, cheaply and conservatively. */
function occurrenceOf(files: SourceFile[]): (term: string) => boolean {
  const seen = new Map<string, boolean>()
  const texts = files.filter((f) => TURTLE.test(f.path)).map((f) => f.text)
  return (term) => {
    let hit = seen.get(term)
    if (hit === undefined) {
      const local = term.includes('#') || term.includes('/') ? term.slice(Math.max(term.lastIndexOf('#'), term.lastIndexOf('/')) + 1) : term
      hit = texts.some((t) => t.includes(local) && occurs(t, term))
      seen.set(term, hit)
    }
    return hit
  }
}

function occurs(text: string, term: string): boolean {
  let found = false
  const names: Names = { terms: new Map([[term, term]]), slugs: new Map([[term, term]]) }
  renameText(text, names, frameworkPrefixes, (o) => (found ||= o.place === 'code'))
  return found
}

function stepNames(renames: Rename[], back: boolean): Names {
  const names: Names = { terms: new Map(), slugs: new Map() }
  for (const r of renames) (r.kind === 'term' ? names.terms : names.slugs).set(back ? r.new : r.old, back ? r.old : r.new)
  return names
}

/** Takes the files across the changes that apply. Nothing is written: the result has the new texts. */
export async function migrate(opts: MigrateOptions): Promise<MigrateResult> {
  const back = opts.direction === 'backward'
  const { active, findings } = select(opts)
  let files = opts.files
  for (const change of active) {
    const steps = back ? [...change.migrations].reverse() : change.migrations
    for (const step of steps) files = await applyStep(files, step, change, back, findings)
    if (!change.migrations.length) findings.push({ kind: 'meaning', message: `${change.label}: no mechanical step. Read it.`, change: change.iri })
  }
  scanRemaining(files, active, back, findings)
  return { files, findings, changes: active.map((c) => c.iri) }
}

async function applyStep(files: SourceFile[], step: MigrationStep, change: LoadedChange, back: boolean, findings: Finding[]): Promise<SourceFile[]> {
  const where = { change: change.iri, migration: step.iri }
  const names = stepNames(step.renames, back)
  let out = files
  if (names.terms.size || names.slugs.size) {
    out = out.map((f) => {
      if (!TURTLE.test(f.path)) return f
      const counts = new Map<string, number>()
      const text = renameText(f.text, names, frameworkPrefixes, (o) => {
        if (o.place === 'code') counts.set(o.term, (counts.get(o.term) ?? 0) + 1)
        else findings.push({ kind: 'prose', message: `${shortOf(o.term)} is named in a ${o.place === 'comment' ? 'comment' : 'text'}, left as written`, file: f.path, line: o.line, term: o.term, ...where })
      })
      for (const [term, n] of counts) findings.push({ kind: 'migrated', message: `${shortOf(term)}: renamed, ${n} occurrence(s)`, file: f.path, term, ...where })
      return text === f.text ? f : { path: f.path, text }
    })
  }
  const update = back ? step.backward : step.forward
  if (update) out = await applyUpdate(out, update, findings, where)
  if (back && step.loses) findings.push({ kind: 'review', message: `does not come back: ${step.loses}`, ...where })
  else if (back && step.forward && !step.backward) findings.push({ kind: 'review', message: 'no way back was stated', ...where })
  return out
}

const shortOf = (iri: string) => compactIri(iri, frameworkPrefixes)

/** After the run: retired terms still named somewhere the tool did not reach. */
function scanRemaining(files: SourceFile[], active: LoadedChange[], back: boolean, findings: Finding[]) {
  if (back) return
  const retired = new Set(active.flatMap((c) => c.retires))
  const change = (term: string) => active.find((c) => c.retires.includes(term))?.iri
  for (const f of files) {
    if (TURTLE.test(f.path)) {
      const names: Names = { terms: new Map([...retired].map((t) => [t, t])), slugs: new Map() }
      renameText(f.text, names, frameworkPrefixes, (o) => {
        if (o.place === 'code') findings.push({ kind: 'manual', message: `${shortOf(o.term)} is still named here`, file: f.path, line: o.line, term: o.term, change: change(o.term) })
      })
    } else {
      for (const term of retired) {
        const short = shortOf(term)
        const hit = [term, short].flatMap((name) => lineMatches(f.text, name))
        for (const line of hit) findings.push({ kind: 'manual', message: `${short} is named in code`, file: f.path, line, term, change: change(term) })
      }
    }
  }
}

function lineMatches(text: string, name: string): number[] {
  const out: number[] = []
  const re = new RegExp(`(?<![\\w:])${name.replace(/[.*+?^$()|[\]\\{}/-]/g, '\\$&')}(?![\\w-])`, 'g')
  for (const m of text.matchAll(re)) out.push(lineOf(text, m.index))
  return out
}

/** A file's triples with blank node labels left out: enough to compare two versions of one graph. */
function canonical(files: SourceFile[]): string[] {
  const out: string[] = []
  for (const f of files) {
    if (!TURTLE.test(f.path) || RDF_12.test(f.text)) continue
    for (const t of parseTurtle(f.text).triples) {
      const show = (x: Term) => (x.k === 'bnode' ? '_:' : x.k === 'lit' ? JSON.stringify([x.value, x.lang, x.dt === XSD_STRING ? undefined : x.dt]) : `<${x.v}>`)
      out.push(`${show(t.s)} <${t.p}> ${show(t.o)}`)
    }
  }
  return out.sort()
}

export interface VerifyOptions {
  files: SourceFile[]
  changes: LoadedChange[]
  /** Every retired term (ontology/terms.ttl). */
  retired: Iterable<string>
  applied?: Iterable<string>
}

/** Whether a move is done: no retired term left, every file and query parses, and what was applied comes back. */
export async function verify(opts: VerifyOptions): Promise<Finding[]> {
  const out: Finding[] = []
  const retired = new Set(opts.retired)
  const change = (t: string) => opts.changes.find((c) => c.retires.includes(t))?.iri
  for (const f of opts.files) {
    if (!TURTLE.test(f.path)) continue
    let doc: Doc
    try {
      doc = parseTurtle(f.text)
    } catch (e) {
      if (e instanceof UnsupportedTurtle) continue
      if (!(e instanceof TurtleSyntaxError)) throw e
      out.push({ kind: 'manual', message: `does not parse: ${e.message}`, file: f.path })
      continue
    }
    const prefixes = doc.prefixes
    renameText(f.text, { terms: new Map([...retired].map((t) => [t, t])), slugs: new Map() }, frameworkPrefixes, (o) => {
      if (o.place === 'code') out.push({ kind: 'manual', message: `${shortOf(o.term)} is retired`, file: f.path, line: o.line, term: o.term, change: change(o.term) })
    })
    const head = [...new Map([...frameworkPrefixes, ...prefixes])].map(([p, ns]) => `PREFIX ${p}: <${ns}>`).join('\n')
    for (const t of doc.triples) {
      if (t.o.k !== 'lit' || !looksLikeQuery(t.o.value) || /^\s*(INSERT|DELETE|WITH)\b/i.test(t.o.value)) continue
      try {
        parseQuery(head + '\n' + t.o.value.replace(/\$(this|member|event)\b/g, '?$1'))
      } catch (e) {
        if (!(e instanceof SparqlSyntaxError)) throw e
        if (!/unknown prefix/i.test(e.message)) out.push({ kind: 'manual', message: `a query does not parse: ${e.message}`, file: f.path, line: t.object ? lineOf(f.text, t.object.at) : undefined })
      }
    }
  }
  // Round trip: what was applied, back and forward again, is the same graph.
  const applied = new Set(opts.applied ?? [])
  const reversible = opts.changes.filter((c) => applied.has(c.iri) && c.migrations.every((m) => !m.loses))
  if (reversible.length && !out.some((f) => f.message.startsWith('does not parse'))) {
    const before = canonical(opts.files)
    const back = await migrate({ files: opts.files, changes: reversible, direction: 'backward', applied: reversible.map((c) => c.iri) })
    const again = await migrate({ files: back.files, changes: reversible, from: '0' })
    const after = canonical(again.files)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      const b = new Set(before)
      const missing = after.filter((x) => !b.has(x)).slice(0, 3)
      out.push({ kind: 'manual', message: `going back and forward again changes the graph (first differences: ${missing.join(' | ') || 'triples went missing'})` })
    }
  }
  return out
}
