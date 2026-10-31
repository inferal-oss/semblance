// The rdf-engine builds (rdf-engine/, `npm run engine:build`) as Semblance stores.
// A build is held to the stores Semblance already has: the same quads loaded as
// N3.js, and the same HTML rendered as Oxigraph (with SPARQL rules, once the
// build runs SPARQL) or as N3.js (function rules, until then).
import { existsSync, readFileSync } from 'node:fs'
import * as ox from 'oxigraph'
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
    // Counted without listing them (the site's status bar counts them every few seconds).
    expect(loadStore(kind).size?.()).toBe(engine.count)
    expect(loadStore('oxigraph').size?.()).toBe(engine.count)
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

  // LATERAL's right side may not define (by BIND, VALUES or a subquery's SELECT expression or
  // aggregate) a variable in scope on its left; it may still join on it by triples or a plain
  // GROUP BY key. Each build accepts and rejects the same queries as Oxigraph (#69).
  it.skipIf(!sparql)('rejects a LATERAL that binds a variable in scope, as Oxigraph', () => {
    const e = new Engine(new WebAssembly.Module(readFileSync(new URL(`../rdf-engine/build/${kind}.wasm`, import.meta.url))))
    const reference = new ox.Store()
    const rights = [
      '{ SELECT (COUNT(*) AS ?n) WHERE { VALUES ?c { 5 6 } } }',
      '{ SELECT (2 AS ?n) WHERE { } }',
      '{ SELECT * WHERE { BIND(2 AS ?n) } }',
      '{ SELECT ?n WHERE { VALUES ?n { 1 } } }',
      '{ SELECT ?n WHERE { } GROUP BY (?m AS ?n) }',
      'BIND(2 AS ?n)',
      'VALUES ?n { 1 }',
      'OPTIONAL { BIND(2 AS ?n) }',
      '{ BIND(2 AS ?n) } UNION { }',
      'MINUS { BIND(2 AS ?n) }',
      'GRAPH ?g { BIND(2 AS ?n) }',
      // accepted
      '?s ?p ?n',
      '{ SELECT ?n WHERE { ?s ?p ?n } }',
      '{ SELECT ?n (COUNT(*) AS ?c) WHERE { ?s ?p ?n } GROUP BY ?n }',
      '{ SELECT ?m WHERE { BIND(2 AS ?n) BIND(?n AS ?m) } }',
      'FILTER NOT EXISTS { BIND(2 AS ?n) }',
      'GRAPH ?n { }',
      'BIND(2 AS ?m)',
    ]
    const accepts = (q: string, prepare: (q: string) => unknown) => {
      try {
        prepare(q)
        return true
      } catch {
        return false
      }
    }
    for (const left of ['BIND(1 AS ?n)', '?s ?p ?n', '{ SELECT ?n WHERE { ?s ?p ?n } }'])
      for (const right of rights) {
        const q = `SELECT * WHERE { ${left} LATERAL { ${right} } }`
        expect(accepts(q, (q) => e.prepare(q)), q).toBe(accepts(q, (q) => reference.query(q)))
      }
    expect(accepts('SELECT * WHERE { BIND(1 AS ?n) LATERAL { { SELECT (COUNT(*) AS ?n) WHERE { VALUES ?c { 5 6 } } } } }', (q) => e.prepare(q))).toBe(false)
  })

  // The bar chart's fmtIn (charts.ttl): a computed double is read back from its shortest digits.
  // "999.4999999999999" (9.995 × 100) once read as 999.5 (16 digits above 2^53 rounded before the
  // division), and ROUND was floor(x + 0.5); a 9.99 € segment showed as "10.00 €" (#225).
  it.skipIf(!sparql)('reads and rounds doubles as Oxigraph does', () => {
    const e = new Engine(new WebAssembly.Module(readFileSync(new URL(`../rdf-engine/build/${kind}.wasm`, import.meta.url))))
    const reference = new ox.Store()
    const exprs = [
      'xsd:double(9.995) * 100',
      'ROUND(xsd:double(9.995) * 100)',
      'xsd:double(9.995) * 100 + 0',
      'STR(xsd:integer(ROUND(xsd:double(9.995) * IF(true, 100, 1)) + 0.5))',
      ...['999.4999999999999', '9007199254740993', '9007199254740993.0000000000000001', '1.7976931348623157e308', '1.7976931348623159e308', '4.9e-324', '2.4703282292062327e-324', '2.4703282292062328e-324', '2.2250738585072011e-308', '123456789012345678901234567890', '1e23', '1e400', '0.1'].map((d) => `"${d}"^^xsd:double + 0`),
      ...['0.49999999999999994e0', '-0.49999999999999994e0', '-0.5e0', '-2.5e0', '2.5e0', '4503599627370497e0', '"INF"^^xsd:double', '"NaN"^^xsd:double'].map((d) => `ROUND(${d})`),
    ]
    const value = (x: string) => {
      const r = e.prepare(`PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> SELECT (${x} AS ?v) {}`).run()
      if (r.form !== Form.Select) throw new Error('not a SELECT')
      return r.rows[0] ? e.value(r.rows[0]) : undefined
    }
    const want = (x: string) => (reference.query(`PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> SELECT (${x} AS ?v) {}`) as Map<string, ox.Term>[])[0]!.get('v')?.value
    expect(exprs.map((x) => `${x} = ${value(x)}`)).toEqual(exprs.map((x) => `${x} = ${want(x)}`))
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
