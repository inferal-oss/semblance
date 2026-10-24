// Conformance target for any engine build in rdf-engine/build/<name>.wasm.
import { existsSync, readFileSync } from 'node:fs'
import { DEFAULT_GRAPH, Engine, Form, Format, Kind } from '../../host/engine.ts'
import * as ox from 'oxigraph'
import type { Dataset, RdfFile, Target } from '../target.ts'
import { iri, lit, type Row, type T } from '../terms.ts'
import { MIME } from './oxigraph.ts'

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
  return {
    name,
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
      const r = e.prepare(text, base).run()
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
    },
    update(ds, text, base) {
      const e = loaded(ds)
      e.update(text, base)
      return rows(e, e.match(), 4)
    },
  }
}
