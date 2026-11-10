// SERVICE and LOAD with the host fetching (../ABI.md, "Optional: fetching"): a run that needs
// something from elsewhere returns -3 and names its requests; this answers them under the host's
// policy and runs it again. Everyone involved may be hostile (the graph's author, the data a query
// joins, the endpoint, the document server), so nothing is fetched that the policy does not list,
// every response is bounded and checked, and a failure is a failed request, never a trap.

import type { Term } from '@rdfjs/types'
import { DataFactory } from 'n3'
import { readJelly } from '../../src/jelly/decode.ts'
import { Engine, EngineError, FetchKind, FetchState, Format, Kind, type FetchRequest } from './engine.ts'

/** Where and how to reach one endpoint or document, as the host lists it. */
export interface Remote {
  /** The address to fetch, when the IRI the query names is not it (a name such as `urn:ex:catalog`). */
  url?: string
  /** Sent with every request to this remote, and only to it (redirects are refused). */
  headers?: Record<string, string>
  /** Default 'omit': no cookies or HTTP authentication unless asked for. */
  credentials?: RequestCredentials
  /** SERVICE: send the left side's bindings as VALUES (default true). False: the endpoint sees the bare pattern. */
  bindings?: boolean
  timeoutMs?: number
  maxBytes?: number
}

/** What a fetching operation may reach and how much it may take. Nothing is listed by default. */
export interface FetchPolicy {
  /** SERVICE endpoints, by the IRI the query names, exactly. */
  endpoints?: Record<string, Remote>
  /** LOAD documents, by IRI exactly, or by prefix: `https://data.example/dumps/*` (an http(s) URL whose path ends in `/`). */
  documents?: Record<string, Remote>
  /** Default: globalThis.fetch. */
  fetch?: typeof fetch
  /** Date.now() milliseconds by which the whole operation ends: rounds, waits and fetches. */
  deadline?: number
  /** Per request (default 10 s). */
  timeoutMs?: number
  /** Per response (default 16 MiB). */
  maxBytes?: number
  /** Solutions or triples per response (default 100 000). */
  maxRows?: number
  /** Requests per operation (default 32). */
  maxRequests?: number
  /** Binding rows sent with one request (default 1000); more go without VALUES. */
  maxBindings?: number
  /** Rounds per operation (default 8). */
  maxRounds?: number
  /** Requests in flight at once (default 4). */
  concurrency?: number
}

export const FETCH_LIMITS = { timeoutMs: 10_000, maxBytes: 16 << 20, maxRows: 100_000, maxRequests: 32, maxBindings: 1000, maxRounds: 8, concurrency: 4 }

type Limits = typeof FETCH_LIMITS

/** A request that is not made: not listed, over a limit, or not a URL that may be fetched. */
export class FetchRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchRefused'
  }
}

const own = (o: Record<string, Remote> | undefined, k: string): Remote | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined)

/** An address that may be fetched: http(s), with a host and no user name or password. */
function fetchable(address: string): URL {
  let u: URL
  try {
    u = new URL(address)
  } catch {
    throw new FetchRefused('not a URL that may be fetched')
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) throw new FetchRefused('not a URL that may be fetched')
  return u
}

/** The listed endpoint `iri` names, and where to fetch it. */
export function endpointFor(policy: FetchPolicy, iri: string): { remote: Remote; url: URL } {
  const remote = own(policy.endpoints, iri)
  if (!remote) throw new FetchRefused('not an endpoint this page may query')
  return { remote, url: fetchable(remote.url ?? iri) }
}

/** The listed document `iri` names (exactly, or under a prefix entry), and where to fetch it. */
export function documentFor(policy: FetchPolicy, iri: string): { remote: Remote; url: URL } {
  const exact = own(policy.documents, iri)
  if (exact) return { remote: exact, url: fetchable(exact.url ?? iri) }
  let url: URL | undefined
  for (const [key, remote] of Object.entries(policy.documents ?? {})) {
    if (!key.endsWith('*')) continue
    const prefix = fetchable(key.slice(0, -1))
    if (!prefix.pathname.endsWith('/') || prefix.search || prefix.hash || key.slice(0, -1) !== prefix.href) continue
    url ??= fetchable(iri)
    // Compared after the URL parser has normalized both (case, dot segments, %2e, default ports).
    if (url.origin === prefix.origin && url.pathname.startsWith(prefix.pathname)) return { remote, url }
  }
  throw new FetchRefused('not a document this page may load')
}

// --- writing bindings ---------------------------------------------------------------

const IRI_UNSAFE = /[\u0000- <>"{}|^`\\]/
const LANG = /^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/
const VARNAME = /^[A-Za-z0-9_·À-￿]+$/
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string'
const RDF_LANG = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString'
const RDF_DIR_LANG = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#dirLangString'

const escapeChar = (c: string) => {
  switch (c) {
    case '"':
      return '\\"'
    case '\\':
      return '\\\\'
    case '\n':
      return '\\n'
    case '\r':
      return '\\r'
    case '\t':
      return '\\t'
    default:
      return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()
  }
}

/** A term as SPARQL writes it in VALUES, or undefined when it cannot be written exactly. */
export function sparqlTerm(e: Engine, id: number): string | undefined {
  const kind = e.kind(id)
  if (kind === Kind.Iri) {
    const v = e.value(id)
    return IRI_UNSAFE.test(v) ? undefined : `<${v}>`
  }
  if (kind !== Kind.Literal) return undefined
  const lex = '"' + e.value(id).replace(/["\\\u0000-\u001f\u007f\u2028\u2029]/g, escapeChar) + '"'
  const lang = e.lang(id)
  if (lang) {
    if (!LANG.test(lang)) return undefined
    const dir = e.direction(id)
    return `${lex}@${lang}${dir === 1 ? '--ltr' : dir === 2 ? '--rtl' : ''}`
  }
  const dt = e.value(e.datatype(id))
  if (dt === XSD_STRING) return lex
  if (dt === RDF_LANG || dt === RDF_DIR_LANG || IRI_UNSAFE.test(dt)) return undefined
  return `${lex}^^<${dt}>`
}

/**
 * The query to send for a SERVICE request: its text, then its binding rows as VALUES, unless
 * it binds nothing, the remote takes no bindings, there are too many, or one cannot be written
 * exactly. Without VALUES the answer is still right: the engine keeps the answer rows
 * compatible with each binding row.
 */
export function serviceQuery(e: Engine, r: FetchRequest, remote: Remote, limits: Pick<Limits, 'maxBindings'>): string {
  const w = r.vars.length
  if (remote.bindings === false || !r.count || !w || r.count > limits.maxBindings) return r.text
  const domain = [...r.rows.subarray(0, w)].flatMap((x, j) => (x ? [j] : []))
  if (!domain.length || domain.some((j) => !VARNAME.test(r.vars[j]!))) return r.text
  const lines: string[] = []
  for (let i = 0; i < r.count; i++) {
    const terms = domain.map((j) => sparqlTerm(e, r.rows[i * w + j]!))
    if (terms.some((t) => t === undefined)) return r.text
    lines.push(`  (${terms.join(' ')})`)
  }
  return `${r.text}\nVALUES (${domain.map((j) => '?' + r.vars[j]).join(' ')}) {\n${lines.join('\n')}\n}`
}

// --- reading responses ---------------------------------------------------------------

/** The body, read no further than `max` bytes. */
async function body(res: Response, max: number): Promise<Uint8Array> {
  const length = Number(res.headers.get('content-length'))
  if (length > max) throw new FetchRefused(`response larger than ${max} bytes`)
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new FetchRefused(`response larger than ${max} bytes`)
    }
    parts.push(value)
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    all.set(p, at)
    at += p.byteLength
  }
  return all
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

const mediaType = (res: Response) => (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()

interface JsonTerm {
  type?: unknown
  value?: unknown
  datatype?: unknown
  'xml:lang'?: unknown
  'its:dir'?: unknown
}

const bad = (why: string): never => {
  throw new FetchRefused(`bad response: ${why}`)
}

/** A SPARQL results JSON term, interned; blank nodes are fresh per response. */
function jsonTerm(e: Engine, j: JsonTerm, bnodes: Map<string, number>, depth = 0): number {
  if (typeof j !== 'object' || j === null || depth > 8) return bad('a term')
  if (j.type === 'triple') {
    const v = j.value as { subject?: JsonTerm; predicate?: JsonTerm; object?: JsonTerm }
    if (typeof v !== 'object' || v === null) return bad('a triple term')
    const s = jsonTerm(e, v.subject!, bnodes, depth + 1)
    const p = jsonTerm(e, v.predicate!, bnodes, depth + 1)
    const o = jsonTerm(e, v.object!, bnodes, depth + 1)
    if (e.kind(p) !== Kind.Iri || e.kind(s) === Kind.Literal) return bad('a triple term')
    return e.triple(s, p, o)
  }
  if (typeof j.value !== 'string') return bad('a term value')
  if (j.type === 'uri') return e.iri(j.value)
  if (j.type === 'bnode') {
    let id = bnodes.get(j.value)
    if (id === undefined) bnodes.set(j.value, (id = e.bnode()))
    return id
  }
  if (j.type === 'literal' || j.type === 'typed-literal') {
    const lang = j['xml:lang']
    if (lang !== undefined) {
      if (typeof lang !== 'string' || !LANG.test(lang)) return bad('a language tag')
      const dir = j['its:dir']
      if (dir !== undefined && dir !== 'ltr' && dir !== 'rtl') return bad('a direction')
      return e.langLiteral(j.value, lang.toLowerCase(), dir === 'ltr' ? 1 : dir === 'rtl' ? 2 : 0)
    }
    if (j.datatype === undefined || j.datatype === XSD_STRING) return e.literal(j.value)
    if (typeof j.datatype !== 'string' || j.datatype === RDF_LANG || j.datatype === RDF_DIR_LANG) return bad('a datatype')
    return e.literal(j.value, e.iri(j.datatype))
  }
  return bad('a term type')
}

/** SPARQL results JSON as rows of the request's variables (columns it did not ask for are dropped). */
export function answerRows(e: Engine, vars: string[], text: string, maxRows: number): { ids: number[]; count: number } {
  let doc: { results?: { bindings?: unknown } }
  try {
    doc = JSON.parse(text)
  } catch {
    return bad('not JSON')
  }
  const bindings = doc?.results?.bindings
  if (!Array.isArray(bindings)) return bad('no results')
  if (bindings.length > maxRows) throw new FetchRefused(`more than ${maxRows} solutions`)
  const bnodes = new Map<string, number>()
  const ids: number[] = []
  for (const b of bindings as Record<string, JsonTerm>[]) {
    if (typeof b !== 'object' || b === null) bad('a solution')
    for (const v of vars) ids.push(Object.hasOwn(b, v) ? jsonTerm(e, b[v]!, bnodes) : 0)
  }
  return { ids, count: bindings.length }
}

const RDF_FORMATS: Record<string, Format> = {
  'text/turtle': Format.Turtle,
  'application/x-turtle': Format.Turtle,
  'application/n-triples': Format.NTriples,
}

/** An RDF/JS term as an engine id; blank nodes fresh per document. */
function engineTerm(e: Engine, t: Term, bnodes: Map<string, number>): number {
  switch (t.termType) {
    case 'NamedNode':
      return e.iri(t.value)
    case 'BlankNode': {
      let id = bnodes.get(t.value)
      if (id === undefined) bnodes.set(t.value, (id = e.bnode()))
      return id
    }
    case 'Literal': {
      const dir = (t as { direction?: string }).direction
      if (t.language) return e.langLiteral(t.value, t.language.toLowerCase(), dir === 'ltr' ? 1 : dir === 'rtl' ? 2 : 0)
      return t.datatype.value === XSD_STRING ? e.literal(t.value) : e.literal(t.value, e.iri(t.datatype.value))
    }
    case 'Quad':
      return e.triple(engineTerm(e, t.subject, bnodes), engineTerm(e, t.predicate, bnodes), engineTerm(e, t.object, bnodes))
    default:
      return bad('a term')
  }
}

/** A Jelly stream's triples (#433): the statements of its default graph, read without touching the store. */
export function jellyTriples(e: Engine, bytes: Uint8Array, maxRows: number): { ids: number[]; count: number } {
  let quads
  try {
    quads = readJelly(bytes, DataFactory)
  } catch (err) {
    throw new FetchRefused(`bad document: ${(err as Error).message.slice(0, 120)}`)
  }
  const triples = quads.filter((q) => q.graph.termType === 'DefaultGraph')
  if (triples.length > maxRows) throw new FetchRefused(`more than ${maxRows} triples`)
  const bnodes = new Map<string, number>()
  const ids: number[] = []
  for (const q of triples) ids.push(engineTerm(e, q.subject, bnodes), engineTerm(e, q.predicate, bnodes), engineTerm(e, q.object, bnodes))
  return { ids, count: triples.length }
}

/** A document's triples, parsed by the engine itself into a graph of its own, then taken out. */
export function documentTriples(e: Engine, format: Format, text: string, base: string, maxRows: number): { ids: number[]; count: number } {
  const g = e.iri(`urn:semblance:fetching:load:${Math.random().toString(36).slice(2)}`)
  try {
    e.load(format, text, base, g)
  } catch (err) {
    throw new FetchRefused(`bad document: ${(err as Error).message.slice(0, 120)}`)
  }
  const quads = e.match(0, 0, 0, g)
  const ids: number[] = []
  for (let i = 0; i < quads.length; i += 4) {
    ids.push(quads[i]!, quads[i + 1]!, quads[i + 2]!)
    e.remove(quads[i]!, quads[i + 1]!, quads[i + 2]!, g)
  }
  if (ids.length / 3 > maxRows) throw new FetchRefused(`more than ${maxRows} triples`)
  return { ids, count: ids.length / 3 }
}

// --- the operation -------------------------------------------------------------------------

/** One request to a remote, bounded by its timeout, the operation's deadline and its size. */
async function get(policy: FetchPolicy, limits: Limits, remote: Remote, url: URL, init: RequestInit): Promise<{ res: Response; bytes: Uint8Array }> {
  const fetchFn = policy.fetch ?? globalThis.fetch
  const left = policy.deadline === undefined ? Infinity : policy.deadline - Date.now()
  const ms = Math.min(remote.timeoutMs ?? limits.timeoutMs, left)
  if (ms <= 0) throw new FetchRefused('past the deadline')
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), ms)
  try {
    const res = await fetchFn(url.href, { ...init, headers: { ...init.headers, ...remote.headers }, credentials: remote.credentials ?? 'omit', redirect: 'error', signal: abort.signal })
    if (!res.ok) throw new FetchRefused(`HTTP ${res.status}`)
    return { res, bytes: await body(res, remote.maxBytes ?? limits.maxBytes) }
  } catch (err) {
    if (abort.signal.aborted) throw new FetchRefused('timed out')
    if (err instanceof FetchRefused) throw err
    throw new FetchRefused('could not be reached')
  } finally {
    clearTimeout(timer)
  }
}

async function service(e: Engine, r: FetchRequest, policy: FetchPolicy, limits: Limits): Promise<{ ids: number[]; count: number }> {
  const { remote, url } = endpointFor(policy, e.value(r.target))
  const query = serviceQuery(e, r, remote, limits)
  const { res, bytes } = await get(policy, limits, remote, url, {
    method: 'POST',
    headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' },
    body: query,
  })
  const type = mediaType(res)
  if (type !== 'application/sparql-results+json' && type !== 'application/json') throw new FetchRefused(`unexpected content type ${type.slice(0, 60) || 'none'}`)
  return answerRows(e, r.vars, text(bytes), limits.maxRows)
}

async function load(e: Engine, r: FetchRequest, policy: FetchPolicy, limits: Limits): Promise<{ ids: number[]; count: number }> {
  const iri = e.value(r.target)
  const { remote, url } = documentFor(policy, iri)
  const { res, bytes } = await get(policy, limits, remote, url, { method: 'GET', headers: { accept: 'text/turtle, application/n-triples;q=0.9, application/x-jelly-rdf;q=0.9' } })
  if (mediaType(res) === 'application/x-jelly-rdf') return jellyTriples(e, bytes, limits.maxRows)
  const format = RDF_FORMATS[mediaType(res)]
  if (!format) throw new FetchRefused(`unexpected content type ${mediaType(res).slice(0, 60) || 'none'}`)
  return documentTriples(e, format, text(bytes), iri, limits.maxRows)
}

/** At most `n` at once. */
async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await f(items[next++]!)
  }))
}

/**
 * Run `attempt` (a run or update of `e`) until it no longer waits, answering what each round asks
 * for under `policy`. Only requests the attempt itself waited on are fetched. The engine's table is
 * cleared before and after: callers serialize operations on one engine (see store.ts).
 */
export async function withFetching<T>(e: Engine, policy: FetchPolicy, attempt: () => T): Promise<T> {
  if (!e.fetches) throw new Error('this engine build does not fetch (rdf-engine/ABI.md, "Optional: fetching")')
  const limits: Limits = { ...FETCH_LIMITS }
  for (const k of Object.keys(FETCH_LIMITS) as (keyof Limits)[]) if (typeof policy[k] === 'number') limits[k] = policy[k]
  let requests = 0
  e.fetchClear()
  try {
    for (let round = 0; ; round++) {
      let asked: FetchRequest[]
      try {
        return attempt()
      } catch (err) {
        if (!(err instanceof EngineError && err.waiting)) throw err
        // Read at once, before anything else can run on this engine.
        asked = e.fetchRequests().filter((r) => r.asked && r.state === FetchState.Waiting)
      }
      if (round >= limits.maxRounds) throw new Error(`SERVICE or LOAD still waiting after ${limits.maxRounds} rounds`)
      if (policy.deadline !== undefined && Date.now() >= policy.deadline) throw new EngineError('interrupted: past the deadline', true)
      await pool(asked, limits.concurrency, async (r) => {
        let answer: { ids: number[]; count: number }
        try {
          if (++requests > limits.maxRequests) throw new FetchRefused(`more than ${limits.maxRequests} requests`)
          answer = r.kind === FetchKind.Service ? await service(e, r, policy, limits) : await load(e, r, policy, limits)
        } catch (err) {
          const why = err instanceof FetchRefused ? err.message : 'failed'
          e.fetchFail(r.index, why.slice(0, 200))
          return
        }
        e.fetchAnswer(r.index, answer.ids, answer.count)
      })
    }
  } finally {
    e.fetchClear()
  }
}
