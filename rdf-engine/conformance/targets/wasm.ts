// Conformance target for any engine build in rdf-engine/build/<name>.wasm.
import { existsSync, readFileSync } from 'node:fs'
import { DEFAULT_GRAPH, Engine, Form, Format, Kind } from '../../host/engine.ts'
import * as ox from 'oxigraph'
import { frames } from '../../../src/jelly/decode.ts'
import { concat, type JellyRead, type JellyTarget } from '../jelly.ts'
import type { Dataset, QueryResult, RdfFile, Target } from '../target.ts'
import { iri, lit, type Row, type T } from '../terms.ts'
import { MIME } from './oxigraph.ts'
import { withFetching, type FetchPolicy } from '../../host/fetching.ts'
import { mockFetch } from '../../host/mock-endpoint.ts'

const FORMAT: Partial<Record<RdfFile['format'], Format>> = {
  ntriples: Format.NTriples,
  nquads: Format.NQuads,
  turtle: Format.Turtle,
  trig: Format.TriG,
}

function fromId(e: Engine, id: number): T {
  switch (e.kind(id)) {
    case Kind.Iri:
      return iri(e.value(id))
    case Kind.BlankNode:
      return { t: 'bnode', v: e.value(id) }
    case Kind.Literal: {
      const dir = e.direction(id)
      return lit(e.value(id), e.value(e.datatype(id)), e.lang(id) || undefined, dir === 1 ? 'ltr' : dir === 2 ? 'rtl' : undefined)
    }
    case Kind.Triple: {
      const [s, p, o] = e.tripleParts(id)
      return { t: 'triple', s: fromId(e, s), p: fromId(e, p), o: fromId(e, o) }
    }
    case Kind.DefaultGraph:
      return { t: 'default' }
    default:
      throw new Error(`engine returned free term id ${id}`)
  }
}

function rows(e: Engine, ids: Uint32Array, width: number): Row[] {
  const out: Row[] = []
  for (let i = 0; i < ids.length; i += width) {
    const r: Row = []
    for (let k = 0; k < width; k++) r.push(ids[i + k] ? fromId(e, ids[i + k]!) : undefined)
    out.push(r)
  }
  return out
}

function load(e: Engine, file: RdfFile, graph: number) {
  if (file.format === 'rdfxml') {
    // RDF/XML is outside the ABI; a few SPARQL tests keep their data in it.
    const store = new ox.Store()
    store.load(file.text, { format: MIME.rdfxml, base_iri: file.base })
    e.load(Format.NTriples, store.dump({ format: MIME.ntriples, from_graph_name: ox.defaultGraph() }), file.base, graph)
    return
  }
  e.load(FORMAT[file.format]!, file.text, file.base, graph)
}

/**
 * RDF_ENGINE_COMPILE=1: run every query compiled where the engine compiles it
 * (ABI.md, "Optional: compiled queries"), and fail a test whose compiled result
 * differs from the interpreted one. Counts are printed at exit.
 */
const compileMode = !!process.env.RDF_ENGINE_COMPILE
const compileCounts = { queries: 0, compiled: 0, differ: 0, declined: new Map<string, number>() }
if (compileMode) process.on('exit', () => console.error('compiled queries:', compileCounts))

function canonical(e: Engine, r: ReturnType<ReturnType<Engine['prepare']>['run']>): string {
  if (r.form === Form.Ask) return String(r.value)
  const width = r.form === Form.Select ? Math.max(r.vars.length, 1) : 3
  const ids = r.form === Form.Select ? r.rows : r.triples
  const out: string[] = []
  for (let i = 0; i < ids.length; i += width) out.push(Array.from(ids.subarray(i, i + width), (x) => (x && e.kind(x) === Kind.BlankNode ? 'b' : String(x))).join(','))
  out.sort()
  return (r.form === Form.Select ? `${r.count}:` : '') + (r.form === Form.Select ? out : [...new Set(out)]).join(' ')
}

/** A runner term into the engine; blank node labels are prefixed with `scope`. */
function toId(e: Engine, x: T | undefined, scope: string): number {
  switch (x?.t) {
    case 'iri':
      return e.iri(x.v)
    case 'bnode':
      return e.bnode(scope + x.v)
    case 'lit':
      return x.lang ? e.langLiteral(x.v, x.lang, x.dir === 'ltr' ? 1 : x.dir === 'rtl' ? 2 : 0) : e.literal(x.v, e.iri(x.dt))
    case 'triple':
      return e.triple(toId(e, x.s, scope), toId(e, x.p, scope), toId(e, x.o, scope))
    default:
      return DEFAULT_GRAPH
  }
}

function jellyTarget(module: WebAssembly.Module): JellyTarget {
  return {
    read(bytes) {
      const e = new Engine(module)
      const r = e.jellyReader()
      const out: JellyRead = { statements: [], frameEnds: [], messageEnds: [] }
      for (const f of frames(bytes)) {
        const at = out.statements.length
        out.statements.push(...rows(e, r.read(f), 4))
        for (const end of r.ends()) out.messageEnds.push(at + end)
        out.frameEnds.push(out.statements.length)
      }
      if (r.finish()) out.messageEnds.push(out.statements.length)
      return out
    },
    write(options, messages) {
      const e = new Engine(module)
      const w = e.jellyWriter({ physical: options.physical as 1 | 2, streamType: options.streamType as 0 | 1, rdfVersion: options.rdfVersion as 0, maxNames: options.maxNames, maxPrefixes: options.maxPrefixes, maxDatatypes: options.maxDatatypes })
      const parts: Uint8Array[] = []
      messages.forEach((m, i) => {
        parts.push(w.write(m.flatMap((r) => r.map((x) => toId(e, x, `m${i}.`)))))
        if (options.streamType === 1) w.message()
      })
      parts.push(w.flush())
      return concat(parts)
    },
  }
}

export function wasmTarget(name: string): Target {
  const path = new URL(`../../build/${name}.wasm`, import.meta.url)
  if (!existsSync(path)) throw new Error(`no build at ${path.pathname}; run \`npm run engine:build\``)
  const module = new WebAssembly.Module(readFileSync(path))
  const loaded = (ds: Dataset) => {
    const e = new Engine(module)
    for (const f of ds.default) load(e, f, DEFAULT_GRAPH)
    for (const { name, file } of ds.named) load(e, file, e.iri(name))
    return e
  }
  /** The dataset's services as mock endpoints, every one listed; nothing else answers. */
  const policyFor = (ds: Dataset): FetchPolicy => {
    const endpoints = Object.fromEntries((ds.services ?? []).map((s) => [s.endpoint, { load: (e: Engine) => s.data.forEach((f) => load(e, f, DEFAULT_GRAPH)) }]))
    const policy: FetchPolicy = {
      endpoints: Object.fromEntries(Object.keys(endpoints).map((k) => [k, {}])),
      fetch: mockFetch(module, endpoints, {}, () => policy).fetch,
    }
    return policy
  }
  const result = (e: Engine, r: ReturnType<ReturnType<Engine['prepare']>['run']>): QueryResult => {
    if (r.form === Form.Ask) return { kind: 'boolean', value: r.value }
    if (r.form === Form.Select) {
      return {
        kind: 'bindings',
        vars: r.vars,
        rows: r.vars.length
          ? rows(e, r.rows, r.vars.length).map((row) => new Map(row.flatMap((t, i) => (t ? [[r.vars[i]!, t] as [string, T]] : []))))
          : Array.from({ length: r.count }, () => new Map<string, T>()),
      }
    }
    return { kind: 'graph', quads: rows(e, r.triples, 3) }
  }
  return {
    name,
    jelly: jellyTarget(module),
    async queryFetching(ds, text, base) {
      const e = loaded(ds)
      const q = e.prepare(text, base)
      return result(e, await withFetching(e, policyFor(ds), () => q.run()))
    },
    async updateFetching(ds, text, base) {
      const e = loaded(ds)
      await withFetching(e, policyFor(ds), () => e.update(text, base))
      return rows(e, e.match(), 4)
    },
    parse(file) {
      const e = new Engine(module)
      load(e, file, DEFAULT_GRAPH)
      return rows(e, e.match(), 4)
    },
    parseQuery(text, base) {
      new Engine(module).prepare(text, base).release()
    },
    parseUpdate(text, base) {
      new Engine(module).parseUpdate(text, base)
    },
    query(ds, text, base) {
      const e = loaded(ds)
      const q = e.prepare(text, base)
      let r = q.run()
      if (compileMode) {
        compileCounts.queries++
        const why = q.compile()
        if (why) compileCounts.declined.set(why, (compileCounts.declined.get(why) ?? 0) + 1)
        else {
          compileCounts.compiled++
          const c = q.run()
          // Fresh values differ between runs anyway.
          const random = /\b(RAND|UUID|STRUUID|NOW|BNODE)\s*\(/i.test(text)
          if (!random && canonical(e, c) !== canonical(e, r)) {
            compileCounts.differ++
            throw new Error(`compiled result differs: ${canonical(e, c).slice(0, 200)} vs interpreted ${canonical(e, r).slice(0, 200)}`)
          }
          r = c
        }
      }
      return result(e, r)
    },
    update(ds, text, base) {
      const e = loaded(ds)
      e.update(text, base)
      return rows(e, e.match(), 4)
    },
  }
}
