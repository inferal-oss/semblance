// The Jelly-RDF conformance suite (jelly/, jelly-protobuf v1.2.0): parse tests compare a stream's
// statements in order, up to blank node renaming, per RDF Message (1.2) or per frame (1.1);
// serialize tests write their input with the given stream options and read it back. A negative
// test must fail. Tests needing generalized RDF are skipped (unsupported; the suite allows it).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Quad, Term } from '@rdfjs/types'
import { Parser } from 'n3'
import { frames, type JellyFactory, JellyReader, type StreamOptions } from '../../src/jelly/decode.ts'
import { JellyWriter, delimit } from '../../src/jelly/encode.ts'
import { isomorphic, lit, type Row, type T } from './terms.ts'

const DIR = fileURLToPath(new URL('./jelly/', import.meta.url))
const BASE = 'https://w3id.org/jelly/dev/tests/rdf/'
const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#'
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const RDFT = 'http://www.w3.org/ns/rdftest#'
const JT = 'https://w3id.org/jelly/dev/tests/vocab#'

export const JELLY_MANIFESTS = ['v1_2/from_jelly/manifest.ttl', 'v1_2/to_jelly/manifest.ttl', 'v1_1/from_jelly/manifest.ttl']

/** A stream read: its statements in order, and where frames and RDF Messages end (statement counts). */
export interface JellyRead {
  statements: Row[]
  frameEnds: number[]
  messageEnds: number[]
}

/** What a target does with Jelly. Both throw on an error. */
export interface JellyTarget {
  read(bytes: Uint8Array): JellyRead
  /** Write `messages` (one list of statements each; one list for a FLAT stream) as a delimited stream. */
  write(options: StreamOptions, messages: Row[][]): Uint8Array
}

export interface JellyTest {
  id: string
  name: string
  positive: boolean
  direction: 'from' | 'to'
  version: '1.1' | '1.2'
  action: string[]
  result: string[]
  /** Whether `result` is a list (one file per message or frame). */
  resultList: boolean
  requires: string[]
  should: boolean
  approval?: string
}

const local = (iri: string) => DIR + iri.slice(BASE.length)

export function loadJellyManifest(path: string): JellyTest[] {
  const quads = new Parser({ baseIRI: BASE + path }).parse(readFileSync(DIR + path, 'utf8'))
  const by = new Map<string, Quad[]>()
  for (const q of quads) {
    const k = q.subject.value
    let l = by.get(k)
    if (!l) by.set(k, (l = []))
    l.push(q)
  }
  const one = (s: string, p: string) => by.get(s)?.find((q) => q.predicate.value === p)?.object
  const all = (s: string, p: string) => (by.get(s) ?? []).filter((q) => q.predicate.value === p).map((q) => q.object)
  const list = (t: Term | undefined): string[] => {
    if (!t) return []
    if (t.termType === 'NamedNode' && t.value !== RDF + 'nil') return [t.value]
    const out: string[] = []
    let n: Term | undefined = t
    while (n && n.value !== RDF + 'nil') {
      out.push(one(n.value, RDF + 'first')!.value)
      n = one(n.value, RDF + 'rest')
    }
    return out
  }
  const manifest = BASE + path.replace(/manifest\.ttl$/, 'manifest')
  const entries = list(one(manifest, MF + 'entries'))
  return entries.map((id) => {
    const types = all(id, RDF + 'type').map((t) => t.value)
    const result = one(id, MF + 'result')
    return {
      id: id.slice(BASE.length),
      name: one(id, MF + 'name')?.value ?? '',
      positive: types.includes(JT + 'TestPositive'),
      direction: types.some((t) => /ToJelly$/.test(t)) ? 'to' : 'from',
      version: path.startsWith('v1_1') ? '1.1' : '1.2',
      action: list(one(id, MF + 'action')).map(local),
      result: list(result).map(local),
      resultList: !!result && result.termType === 'BlankNode',
      requires: all(id, MF + 'requires').map((t) => t.value.slice(JT.length)),
      should: all(id, MF + 'notable').some((t) => t.value === JT + 'featureShouldLevel'),
      approval: one(id, RDFT + 'approval')?.value.slice(RDFT.length),
    }
  })
}

type Outcome = { status: 'pass' } | { status: 'fail'; reason: string } | { status: 'skip'; reason: string }

const short = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 160)

export function runJellyTest(target: JellyTarget, t: JellyTest): Outcome {
  if (t.requires.includes('requirementGeneralizedRdf')) return { status: 'skip', reason: 'generalized RDF' }
  if (t.direction === 'from') {
    const bytes = new Uint8Array(readFileSync(t.action[0]!))
    let read: JellyRead
    try {
      read = target.read(bytes)
    } catch (e) {
      return t.positive ? { status: 'fail', reason: 'error: ' + short(e) } : { status: 'pass' }
    }
    if (!t.positive) return { status: 'fail', reason: 'accepted invalid input' }
    const want = t.result.map((f) => parseNQuads(readFileSync(f, 'utf8')))
    // Units: messages (a 1.2 stream of RDF Messages), frames (1.1), or the whole stream.
    const ends = t.version === '1.1' ? read.frameEnds : t.resultList ? read.messageEnds : [read.statements.length]
    let units = split(read.statements, ends)
    // 1.1: frames without statements have no file.
    if (t.version === '1.1' && units.length !== want.length) units = units.filter((u) => u.length)
    if (units.length !== want.length) return { status: 'fail', reason: `${units.length} units, expected ${want.length}` }
    if (t.version === '1.1') {
      // One pool of blank nodes for the whole stream, frame boundaries checked by size.
      if (units.some((u, i) => u.length !== want[i]!.length)) return { status: 'fail', reason: 'frame sizes differ' }
      return verdict(isomorphic(units.flat(), want.flat(), true))
    }
    for (let i = 0; i < units.length; i++) {
      const o = verdict(isomorphic(units[i]!, want[i]!, true))
      if (o.status !== 'pass') return { status: 'fail', reason: `message ${i}: ${(o as { reason: string }).reason}` }
    }
    return { status: 'pass' }
  }
  // To Jelly: stream options, then one file of statements per message (or one).
  const options = readOptions(new Uint8Array(readFileSync(t.action[0]!)))
  const messages = t.action.slice(1).map((f) => parseNQuads(readFileSync(f, 'utf8')))
  let bytes: Uint8Array
  try {
    bytes = target.write(options, messages)
  } catch (e) {
    return t.positive ? { status: 'fail', reason: 'error: ' + short(e) } : { status: 'pass' }
  }
  if (!t.positive) return { status: 'fail', reason: 'wrote a stream it should refuse' }
  let back: JellyRead
  let written: StreamOptions
  try {
    written = readOptions(bytes)
    back = tsJelly.read(bytes)
  } catch (e) {
    return { status: 'fail', reason: 'unreadable output: ' + short(e) }
  }
  for (const k of ['physical', 'streamType', 'rdfVersion', 'maxNames', 'maxPrefixes', 'maxDatatypes', 'version'] as const)
    if (written[k] !== options[k]) return { status: 'fail', reason: `stream option ${k}: ${written[k]}, expected ${options[k]}` }
  const units = options.streamType === 1 ? split(back.statements, back.messageEnds) : [back.statements]
  const want = options.streamType === 1 ? messages : [messages.flat()]
  if (units.length !== want.length) return { status: 'fail', reason: `${units.length} messages, expected ${want.length}` }
  for (let i = 0; i < units.length; i++) {
    const o = verdict(isomorphic(units[i]!, want[i]!, true))
    if (o.status !== 'pass') return o
  }
  return { status: 'pass' }
}

const verdict = (same: boolean | undefined): Outcome => (same ? { status: 'pass' } : { status: 'fail', reason: same === undefined ? 'comparison too hard (blank nodes)' : 'wrong statements' })

function split(rows: Row[], ends: number[]): Row[][] {
  const out: Row[][] = []
  let start = 0
  for (const e of ends) {
    out.push(rows.slice(start, e))
    start = e
  }
  return out
}

/** The stream options of a stream's first non-empty frame. */
export function readOptions(bytes: Uint8Array): StreamOptions {
  const r = new JellyReader(rowFactory)
  for (const f of frames(bytes)) {
    r.frame(f, { quad() {} })
    if (r.options) return r.options
  }
  throw new Error('no stream options')
}

// ---- terms for the TypeScript codec: RDF/JS-shaped, with base directions ----

class Node {
  constructor(
    readonly termType: string,
    readonly value: string,
    readonly language = '',
    readonly direction = '',
    readonly datatype?: Node,
    readonly subject?: Node,
    readonly predicate?: Node,
    readonly object?: Node,
    readonly graph?: Node,
  ) {}
  equals(o: Node | null | undefined): boolean {
    return !!o && keyOf(this) === keyOf(o)
  }
}
const keyOf = (n: Node): string =>
  n.termType === 'Quad' ? `<<${keyOf(n.subject!)} ${keyOf(n.predicate!)} ${keyOf(n.object!)}>>` : `${n.termType}|${n.value}|${n.language}|${n.direction}|${n.datatype?.value ?? ''}`

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string'
const DEFAULT = new Node('DefaultGraph', '')
let blanks = 0
export const rowFactory: JellyFactory = {
  namedNode: (v) => new Node('NamedNode', v) as never,
  blankNode: (v) => new Node('BlankNode', v ?? 'j' + blanks++) as never,
  literal: (v, l) => {
    if (typeof l === 'string') return new Node('Literal', v, l, '', new Node('NamedNode', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString')) as never
    if (l && !('termType' in l)) return new Node('Literal', v, l.language, l.direction ?? '', new Node('NamedNode', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' + (l.direction ? 'dirLangString' : 'langString'))) as never
    return new Node('Literal', v, '', '', (l as Node | undefined) ?? new Node('NamedNode', XSD_STRING)) as never
  },
  defaultGraph: () => DEFAULT as never,
  quad: (s, p, o, g) => new Node('Quad', '', '', '', undefined, s as never, p as never, o as never, (g ?? DEFAULT) as never) as never,
}

function toT(n: Node): T {
  switch (n.termType) {
    case 'NamedNode':
      return { t: 'iri', v: n.value }
    case 'BlankNode':
      return { t: 'bnode', v: n.value }
    case 'Literal':
      return lit(n.value, n.datatype?.value, n.language || undefined, n.direction || undefined)
    case 'Quad':
      return { t: 'triple', s: toT(n.subject!), p: toT(n.predicate!), o: toT(n.object!) }
    default:
      return { t: 'default' }
  }
}

function fromT(x: T | undefined, scope: Map<string, Node>): Node {
  switch (x?.t) {
    case 'iri':
      return new Node('NamedNode', x.v)
    case 'bnode': {
      let b = scope.get(x.v)
      if (!b) scope.set(x.v, (b = new Node('BlankNode', 'b' + scope.size)))
      return b
    }
    case 'lit':
      return rowFactory.literal(x.v, x.lang ? { language: x.lang, direction: x.dir } : x.dt === XSD_STRING ? undefined : (new Node('NamedNode', x.dt) as never)) as never
    case 'triple':
      return rowFactory.quad(fromT(x.s, scope) as never, fromT(x.p, scope) as never, fromT(x.o, scope) as never) as never
    default:
      return DEFAULT
  }
}

/** The TypeScript codec (src/jelly/) as a target. */
export const tsJelly: JellyTarget = {
  read(bytes) {
    const reader = new JellyReader(rowFactory)
    const out: JellyRead = { statements: [], frameEnds: [], messageEnds: [] }
    const sink = {
      quad: (q: Quad) => void out.statements.push([toT(q.subject as never), toT(q.predicate as never), toT(q.object as never), toT(q.graph as never)]),
      message: () => void out.messageEnds.push(out.statements.length),
    }
    for (const f of frames(bytes)) {
      reader.frame(f, sink)
      out.frameEnds.push(out.statements.length)
    }
    reader.end(sink)
    return out
  },
  write(options, messages) {
    const w = new JellyWriter({ physical: options.physical as 1 | 2, streamType: options.streamType as 0 | 1, rdfVersion: options.rdfVersion as 0, maxNames: options.maxNames, maxPrefixes: options.maxPrefixes, maxDatatypes: options.maxDatatypes })
    const parts: Uint8Array[] = []
    for (const m of messages) {
      // Each message (file) is its own blank node scope.
      const scope = new Map<string, Node>()
      for (const r of m) for (const f of w.add(rowFactory.quad(fromT(r[0], scope) as never, fromT(r[1], scope) as never, fromT(r[2], scope) as never, fromT(r[3], scope) as never))) parts.push(delimit(f))
      if (options.streamType === 1) w.endMessage()
    }
    parts.push(delimit(w.flush()!))
    return concat(parts)
  },
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) out.set(p, (at += p.length) - p.length)
  return out
}

// ---- N-Triples / N-Quads, as the suite writes them (RDF 1.2, and 1.1 RDF-star `<< s p o >>`) ----

export function parseNQuads(text: string): Row[] {
  const rows: Row[] = []
  let i = 0
  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  }
  const fail = (m: string): never => {
    throw new Error(`N-Quads: ${m} at ${i}`)
  }
  const unescape = (s: string) =>
    s.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_, e: string) =>
      e[0] === 'u' || e[0] === 'U' ? String.fromCodePoint(parseInt(e.slice(1), 16)) : ({ t: '\t', b: '\b', n: '\n', r: '\r', f: '\f', '"': '"', "'": "'", '\\': '\\' } as Record<string, string>)[e] ?? fail('bad escape'),
    )
  const term = (): T => {
    ws()
    const c = text[i]
    if (c === '<' && text[i + 1] === '<') {
      i += 2
      const paren = text[i] === '('
      if (paren) i++
      const s = term()
      const p = term()
      const o = term()
      ws()
      if (paren) {
        if (text[i] !== ')') fail("expected ')'")
        i++
      }
      if (text[i] !== '>' || text[i + 1] !== '>') fail("expected '>>'")
      i += 2
      return { t: 'triple', s, p, o }
    }
    if (c === '<') {
      const j = text.indexOf('>', i)
      const v = unescape(text.slice(i + 1, j))
      i = j + 1
      return { t: 'iri', v }
    }
    if (c === '_') {
      const m = /^_:([^\s<>"]+?)(?=[\s.)>]|$)/.exec(text.slice(i))!
      i += m[0].length
      return { t: 'bnode', v: m[1]! }
    }
    if (c === '"') {
      let j = i + 1
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      const v = unescape(text.slice(i + 1, j))
      i = j + 1
      if (text[i] === '@') {
        const m = /^@([a-zA-Z]+(?:-[a-zA-Z0-9]+)*?)(?:--(ltr|rtl))?(?=[\s.)>]|$)/.exec(text.slice(i))!
        i += m[0].length
        return lit(v, undefined, m[1], m[2])
      }
      if (text[i] === '^' && text[i + 1] === '^') {
        i += 2
        const dt = term() as { v: string }
        return lit(v, dt.v)
      }
      return lit(v)
    }
    return fail('unexpected character')
  }
  while (i < text.length) {
    ws()
    if (text[i] === '\n' || text[i] === '\r') {
      i++
      continue
    }
    if (text[i] === '#') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (i >= text.length) break
    const s = term()
    const p = term()
    const o = term()
    ws()
    let g: T = { t: 'default' }
    if (text[i] !== '.') g = term()
    ws()
    if (text[i] !== '.') fail("expected '.'")
    i++
    rows.push([s, p, o, g])
  }
  return rows
}
