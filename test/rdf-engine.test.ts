// The rdf-engine builds (rdf-engine/, `npm run engine:build`) as Semblance stores.
// A build is held to the stores Semblance already has: the same quads loaded as
// N3.js, and the same HTML rendered as Oxigraph (with SPARQL rules, once the
// build runs SPARQL) or as N3.js (function rules, until then).
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Engine, Form, Format } from '../rdf-engine/host/engine.ts'
import { EX } from '../src/examples/todo.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { quadKey } from '../src/rdf.ts'
import { toHTML } from '../src/render/serialize.ts'
import { mountShell } from './harness.ts'
import { setup } from './helpers.ts'

const built = (['rust', 'wat'] as const).filter((k) => existsSync(new URL(`../rdf-engine/build/${k}.wasm`, import.meta.url)))
const page = EX + 'page'

/** The first difference between two strings, with some context. */
function expectSame(a: string, b: string, label: string) {
  if (a === b) return
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  expect(a.slice(Math.max(0, i - 300), i + 300), label).toBe(b.slice(Math.max(0, i - 300), i + 300))
}

describe.skipIf(!built.length).each(built)('%s engine store', (kind) => {
  const sparql = built.length ? loadStore(kind).sparql : false
  // A store with the same abilities to compare against.
  const reference: StoreKind = sparql ? 'oxigraph' : 'n3'

  it('loads the ontology to the same quads as N3.js', () => {
    const keys = (k: StoreKind) => {
      const quads = loadStore(k).match(null, null, null, null)
      const ground = quads.filter((q) => q.subject.termType !== 'BlankNode' && q.object.termType !== 'BlankNode')
      return { count: quads.length, ground: ground.map(quadKey).sort() }
    }
    const [engine, n3] = [keys(kind), keys('n3')]
    expect(engine.count).toBe(n3.count)
    expect(engine.ground).toEqual(n3.ground)
  })

  // A nested group that binds a variable the row joined with binds already, with BIND:
  // the row's value stays when BIND computes the same, else the row is dropped (as Oxigraph).
  it.skipIf(!sparql)('joins a BIND with the bindings of the row it meets', () => {
    const e = new Engine(new WebAssembly.Module(readFileSync(new URL(`../rdf-engine/build/${kind}.wasm`, import.meta.url))))
    e.load(Format.Turtle, '<http://x/a> <http://x/p> 5, 1 ; <http://x/q> 1 .')
    const rows = (where: string) => {
      const r = e.prepare(`SELECT * WHERE { ?s <http://x/p> ?v . ${where} }`).run()
      if (r.form !== Form.Select) throw new Error('not a SELECT')
      const out: string[] = []
      for (let i = 0; i < r.rows.length; i += r.vars.length)
        out.push(r.vars.map((v, k) => `${v}=${r.rows[i + k] ? e.value(r.rows[i + k]!) : ''}`).join(' '))
      return out.sort()
    }
    expect(rows('{ BIND(1 AS ?v) ?s <http://x/p> ?v }')).toEqual(['s=http://x/a v=1'])
    expect(rows('OPTIONAL { BIND(1 AS ?v) ?s <http://x/q> ?v }')).toEqual(['s=http://x/a v=1', 's=http://x/a v=5'])
    expect(rows('{ BIND(1 AS ?v) }')).toEqual(['s=http://x/a v=1'])
  })

  for (const prefer of sparql ? (['function', 'sparql'] as const) : (['function'] as const)) {
    it(`renders the todo page like ${reference} (${prefer} rules)`, () => {
      const html = (k: StoreKind) => toHTML(setup(k, { prefer }).screen.index, page)
      expectSame(html(kind), html(reference), 'todo page')
    })

    it(`renders every page of the shell like ${reference} (${prefer} rules)`, () => {
      const shells = [mountShell(5, kind, prefer), mountShell(5, reference, prefer)]
      const html = () => shells.map((h) => h.document.getElementById('app')!.innerHTML)
      for (const p of ['Home', 'Docs', 'Components', 'Examples', 'Playground'] as const) {
        for (const h of shells) h.showPage(p)
        const [a, b] = html()
        expectSame(a!, b!, p)
      }
    })
  }
})
