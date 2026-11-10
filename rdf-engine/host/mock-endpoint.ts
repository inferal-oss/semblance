// An in-process stand-in for SPARQL endpoints and document servers, as a `fetch`: the federated
// query conformance tests and the fetching tests go through the whole request path (the query and
// its VALUES as text, SPARQL results JSON back) without a network.

import { Engine, Form, Kind } from './engine.ts'
import { withFetching, type FetchPolicy } from './fetching.ts'

export interface MockEndpoint {
  /** Fills the endpoint's own store. */
  load(e: Engine): void
}

export interface MockDocument {
  type: string
  text: string
}

export interface Mock {
  fetch: typeof fetch
  /** Every request made, in order: method, URL and body. */
  log: { method: string; url: string; body: string; headers: Record<string, string> }[]
}

function jsonTerm(e: Engine, id: number): unknown {
  switch (e.kind(id)) {
    case Kind.Iri:
      return { type: 'uri', value: e.value(id) }
    case Kind.BlankNode:
      return { type: 'bnode', value: e.value(id) }
    case Kind.Literal: {
      const lang = e.lang(id)
      const dir = e.direction(id)
      if (lang) return { type: 'literal', value: e.value(id), 'xml:lang': lang, ...(dir ? { 'its:dir': dir === 1 ? 'ltr' : 'rtl' } : {}) }
      return { type: 'literal', value: e.value(id), datatype: e.value(e.datatype(id)) }
    }
    case Kind.Triple: {
      const [s, p, o] = e.tripleParts(id)
      return { type: 'triple', value: { subject: jsonTerm(e, s), predicate: jsonTerm(e, p), object: jsonTerm(e, o) } }
    }
    default:
      throw new Error(`no JSON for term ${id}`)
  }
}

/**
 * A `fetch` that answers SPARQL Protocol POSTs to `endpoints` (each a fresh engine of `module`,
 * querying the others in turn under `policy`) and GETs of `documents`; anything else is a network
 * error, as an unreachable host is.
 */
export function mockFetch(module: WebAssembly.Module, endpoints: Record<string, MockEndpoint>, documents: Record<string, MockDocument> = {}, policy: () => FetchPolicy = () => ({})): Mock {
  const engines = new Map<string, Engine>()
  const log: Mock['log'] = []
  const fetchFn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? init.body : ''
    log.push({ method, url, body, headers: { ...(init.headers as Record<string, string>) } })
    if (method === 'GET' && Object.hasOwn(documents, url)) {
      const d = documents[url]!
      return new Response(d.text, { headers: { 'content-type': d.type } })
    }
    if (method === 'POST' && Object.hasOwn(endpoints, url)) {
      let e = engines.get(url)
      if (!e) {
        e = new Engine(module)
        endpoints[url]!.load(e)
        engines.set(url, e)
      }
      const engine = e
      try {
        const q = engine.prepare(body)
        const r = await withFetching(engine, policy(), () => q.run())
        q.release()
        if (r.form !== Form.Select) return new Response('only SELECT', { status: 400 })
        const w = r.vars.length
        const bindings = Array.from({ length: r.count }, (_, i) => Object.fromEntries(r.vars.flatMap((v, j) => (r.rows[i * w + j] ? [[v, jsonTerm(engine, r.rows[i * w + j]!)]] : []))))
        return new Response(JSON.stringify({ head: { vars: r.vars }, results: { bindings } }), { headers: { 'content-type': 'application/sparql-results+json' } })
      } catch (err) {
        return new Response(String((err as Error).message), { status: 400 })
      }
    }
    throw new TypeError('fetch failed')
  }
  return { fetch: fetchFn as typeof fetch, log }
}
