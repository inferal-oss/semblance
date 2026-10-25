// Compiled queries (rdf-engine/ABI.md, "Optional: compiled queries") give what the
// interpreter gives: small queries on a small graph, run both ways on each build.
// They reach what the W3C suites seldom combine: typed string and number
// expressions (with errors and fallbacks), EXISTS, grouped subqueries, paths.
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Engine, Form, Format, type Solutions } from '../rdf-engine/host/engine.ts'

const built = (['rust', 'wat'] as const).filter((k) => existsSync(new URL(`../rdf-engine/build/${k}.wasm`, import.meta.url)))

const DATA = `@prefix : <http://ex/> .
:a a :R ; :order 2 ; :slug "s-10" ; :next :b .
:b a :R ; :order "1" ; :slug "s-2" ; :next :c .
:c a :R ; :slug "t-1" ; :next :d .
:d a :R ; :order 1.5 ; :slug "s-x" .
:e a :R ; :order "x" ; :slug "é-3"@en .
:list :items (:a :b :c) .
:a :sub :R2 . :R2 :sub :R3 .
`

const QUERIES = [
  'SELECT ?a ?o WHERE { ?a a :R OPTIONAL { ?a :order ?o0 } BIND(COALESCE(xsd:double(?o0), 0) AS ?o) }',
  'SELECT ?a ?x WHERE { ?a a :R OPTIONAL { ?a :order ?x0 } BIND(IF(BOUND(?x0), xsd:double(?x0), 7) AS ?x) }',
  'SELECT ?a ?x WHERE { ?a a :R OPTIONAL { ?a :order ?x0 } BIND(COALESCE(xsd:integer(?x0), STRLEN(STR(?a)) + 1, -3) AS ?x) }',
  'SELECT ?a ?x WHERE { ?a a :R OPTIONAL { ?a :order ?x0 } BIND(IF(?x0 > 1, CONCAT("big-", STR(?x0)), SUBSTR(STR(?a), 10, 2)) AS ?x) }',
  'SELECT ?a WHERE { ?a a :R OPTIONAL { ?a :order ?x0 } FILTER(?x0 >= 1.5 || ?x0 = "x" || !BOUND(?x0)) }',
  'SELECT ?a ?x WHERE { ?a a :R OPTIONAL { ?a :order ?x0 } BIND(?x0 + 1 AS ?x) BIND(xsd:double(?x0) - 0.5 AS ?y) }',
  'SELECT ?a ?s ?n WHERE { ?a :slug ?s FILTER(STRSTARTS(?s, "s-")) BIND(COALESCE(xsd:double(SUBSTR(?s, 3)), 0) AS ?n) }',
  'SELECT ?a ?s WHERE { ?a :slug ?s FILTER(CONTAINS(STR(?a), "/") && !STRENDS(?s, "x")) BIND(IRI(CONCAT(STR(?a), "/~", ?s)) AS ?i) }',
  'SELECT ?a ?b WHERE { ?a a :R . ?b a :R OPTIONAL { ?a :order ?x0 } OPTIONAL { ?b :order ?y0 } BIND(COALESCE(xsd:double(?x0), 0) AS ?x) BIND(COALESCE(xsd:double(?y0), 0) AS ?y) FILTER(?y < ?x || (?y = ?x && STR(?b) <= STR(?a))) }',
  'SELECT ?a ?n WHERE { { SELECT ?a (COUNT(?b) AS ?n) WHERE { ?a a :R . ?b a :R OPTIONAL { ?a :order ?x0 } OPTIONAL { ?b :order ?y0 } BIND(COALESCE(xsd:double(?x0), 0) AS ?x) BIND(COALESCE(xsd:double(?y0), 0) AS ?y) FILTER(?y < ?x || (?y = ?x && STR(?b) <= STR(?a))) } GROUP BY ?a } }',
  'SELECT ?cell ?i WHERE { { SELECT ?cell (COUNT(?mid) - 1 AS ?i) WHERE { :list :items/rdf:rest* ?mid . ?mid rdf:rest* ?cell } GROUP BY ?cell } }',
  'SELECT ?a ?e WHERE { ?a a :R BIND(EXISTS { ?a :next ?n FILTER(STRSTARTS(STR(?n), "http")) } AS ?e) FILTER NOT EXISTS { ?a :order "x" } }',
  'SELECT ?a ?c WHERE { ?a :sub* ?c . ?c :sub+ :R3 }',
  'SELECT ?a ?x WHERE { ?a a :R OPTIONAL { ?a :order ?x0 } BIND(?a IN (:a, :b) AS ?x) FILTER(?a NOT IN (:e)) }',
  'SELECT ?a WHERE { ?a a :R { BIND(?a AS ?self) } UNION { ?a :next ?n BIND(?n AS ?self) } }',
  'SELECT ?a ?l WHERE { ?a a :R LATERAL { SELECT ?a (MAX(?s) AS ?l) WHERE { ?a :slug ?s } GROUP BY ?a } }',
  'SELECT ?a ?first WHERE { ?a a :R OPTIONAL { ?first :next ?n OPTIONAL { ?first :order ?o0 } BIND(COALESCE(xsd:double(?o0), 0) AS ?o) FILTER NOT EXISTS { ?e :next ?m OPTIONAL { ?e :order ?p0 } BIND(COALESCE(xsd:double(?p0), 0) AS ?p) FILTER(?p < ?o) } } }',
  'SELECT ?a ?d ?e WHERE { ?a :order ?o BIND(xsd:date("2020-01-01") AS ?x) BIND(?x + xsd:dayTimeDuration("P1D") AS ?d) BIND(?d - ?x AS ?e) FILTER(?d > ?x) }',
  // comparisons across kinds (numbers, strings, IRIs, language-tagged strings), overflow, slices
  'SELECT ?a ?b ?x ?y ?z WHERE { ?a ?p ?s . ?b ?q ?t BIND(?s = ?t AS ?x) BIND(?s != ?t AS ?y) BIND(?s <= ?t AS ?z) }',
  'SELECT ?a ?x ?y ?z WHERE { ?a :order ?o BIND(?o + 9223372036854775807 AS ?x) BIND(?o - 1.5e0 AS ?y) BIND(?o - 2 AS ?z) }',
  'SELECT ?a ?x ?n ?y WHERE { ?a :slug ?s BIND(CONCAT(?s, ?s, "-", STR(?a)) AS ?x) BIND(STRLEN(?s) AS ?n) BIND(SUBSTR(?s, 2.5, 1.4) AS ?y) }',
  'SELECT ?a ?x ?y ?z ?w WHERE { ?a :slug ?s BIND(xsd:integer(?s) AS ?x) BIND(xsd:double(STRLEN(?s)) AS ?y) BIND(xsd:integer(2.7e0) AS ?z) BIND(xsd:integer("12") + 1 AS ?w) }',
  'SELECT ?a ?x ?y ?z WHERE { ?a ?p ?o BIND(IRI(?o) AS ?x) BIND(IRI(CONCAT("rel/", STR(?a))) AS ?y) BIND(COALESCE(STRLEN(?o), xsd:double(?o), -1) AS ?z) }',
  // right sides run per left row with the bindings the interpreter passes in (the rest hidden)
  'SELECT ?a ?n ?m WHERE { ?a a :R . { ?a :next ?n FILTER(STR(?a) < STR(?n)) } UNION { { SELECT (MIN(?s) AS ?m) WHERE { ?x :slug ?s } } ?a :slug ?m } }',
  'SELECT ?a ?o ?n WHERE { ?a :slug ?s OPTIONAL { { ?a :order ?o FILTER(STRSTARTS(?s, "s-1")) } UNION { { SELECT ?n WHERE { ?n a :R } } FILTER(?n = ?a) } } }',
  // a BIND onto a variable the joined row binds keeps the row only when they agree
  'SELECT ?a ?b ?c WHERE { ?a :next ?b BIND(STR(?b) AS ?c) { BIND(:c AS ?b) } }',
]

describe.skipIf(!built.length).each(built)('%s compiled queries', (kind) => {
  const e = new Engine(new WebAssembly.Module(readFileSync(new URL(`../rdf-engine/build/${kind}.wasm`, import.meta.url))))
  e.load(Format.Turtle, DATA)
  const show = (r: Solutions) =>
    r.form === Form.Select
      ? `${r.count}: ` + [...Array(r.count).keys()].map((i) => Array.from(r.rows.subarray(i * r.vars.length, (i + 1) * r.vars.length)).join(',')).sort().join(' ')
      : JSON.stringify(r)
  it.each(QUERIES)('%s', (text) => {
    const q = e.prepare('PREFIX : <http://ex/> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> ' + text)
    const interpreted = show(q.run())
    if (q.compile() === null) expect(show(q.run())).toBe(interpreted)
    q.release()
  })
})
