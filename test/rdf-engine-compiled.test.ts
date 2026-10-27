// Compiled queries (rdf-engine/ABI.md, "Optional: compiled queries") give what the
// interpreter gives: small queries on a small graph, run both ways on each build.
// They reach what the W3C suites seldom combine: typed string and number
// expressions (with errors and fallbacks), EXISTS, grouped subqueries, paths.
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Engine, Form, Format, IDLE_COMPILE, type Solutions } from '../rdf-engine/host/engine.ts'
import { engineStore } from '../rdf-engine/host/store.ts'

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
  // a UNION joined branch by branch: ?d passed into the branch that can take it, though the other's
  // subquery projects it; a filter after the UNION waits for it; no left row, no right side (#190)
  'SELECT ?a ?d ?k WHERE { ?a a :R ; :next ?d . { ?d :slug ?k } UNION { SELECT ?d (COUNT(?z) AS ?k) WHERE { ?d a :R . ?z a :R } GROUP BY ?d } }',
  'SELECT ?a ?h ?c WHERE { ?a a :R . { VALUES ?h { 1 2 3 } ?a :next ?n } UNION { SELECT ?a (COUNT(?s) AS ?c) WHERE { ?a :slug ?s } GROUP BY ?a } FILTER(!BOUND(?h) || ?h < 3) }',
  'SELECT ?x ?y WHERE { ?x a :Missing . { ?x :next ?y } UNION { SELECT ?y WHERE { ?y a :R } } }',
  // a group of a subquery and a filter, joined: the filter waits for the subquery's rows
  'SELECT ?a ?k WHERE { ?a a :R . { { SELECT (COUNT(?b) AS ?k) WHERE { ?b a :R } } FILTER(?k > 1) } }',
  // a BIND onto a variable the joined row binds keeps the row only when they agree
  'SELECT ?a ?b ?c WHERE { ?a :next ?b BIND(STR(?b) AS ?c) { BIND(:c AS ?b) } }',
  // a typed expression in the rest after an OPTIONAL (a function of its own, the stack top its
  // parameter) keeps that parameter: the walk after it puts its nodes above the first walk's (#101)
  'SELECT ?l ?m WHERE { OPTIONAL { :list :items/rdf:rest* ?l } BIND(?u = 1 AS ?d) { :a :next* ?m } }',
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

// Idle-time compilation (Engine.compileIdle): runs are timed; in idle time the queries whose
// runs say compiling pays are compiled, for the variables they were bound with, and later runs
// with those bound use the module; one that runs slower than the interpreter is dropped.
describe.skipIf(!built.length).each(built)('%s idle-time compilation', (kind) => {
  const module = new WebAssembly.Module(readFileSync(new URL(`../rdf-engine/build/${kind}.wasm`, import.meta.url)))
  const PREFIX = 'PREFIX : <http://ex/> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> '
  const withCost = <T>(cost: number, f: () => T): T => {
    const was = IDLE_COMPILE.cost
    IDLE_COMPILE.cost = cost
    try {
      return f()
    } finally {
      IDLE_COMPILE.cost = was
    }
  }

  it('compiles, in idle time, the queries that ran, for the variables they were bound with', () => {
    const e = new Engine(module)
    e.idleCompile = true
    e.load(Format.Turtle, DATA)
    const q = e.prepare(PREFIX + 'CONSTRUCT { ?this :pos ?o } WHERE { ?this :next ?n OPTIONAL { ?n :order ?o0 } BIND(COALESCE(xsd:double(?o0), 0) AS ?o) }')
    const a = e.iri('http://ex/a')
    const b = e.iri('http://ex/b')
    const bound = () => {
      q.bindValues('this', [a, b])
      try {
        return JSON.stringify(q.run())
      } finally {
        q.bindValues('this', [])
      }
    }
    const expected = bound()
    bound()
    const unbound = JSON.stringify(q.run())
    q.run()
    // Nothing compiles on the interaction's path, only in idle time.
    expect(e.stats.compiled).toBe(0)
    expect(withCost(0, () => e.compileIdle(50))).toBe(false)
    expect(e.stats.idleCompiled).toBe(2)
    expect(q.isCompiled).toBe(true)
    expect(JSON.stringify(q.run())).toBe(unbound)
    expect(bound()).toBe(expected)
    expect(e.stats.compiledRuns).toBe(2)
    // Compiling one shape restored the other's bindings: unbound runs stay unbound.
    expect(e.candidates.size).toBe(0)
  })

  it('leaves alone the queries whose runs would not repay a module', () => {
    const e = new Engine(module)
    e.idleCompile = true
    e.load(Format.Turtle, DATA)
    const q = e.prepare(PREFIX + 'SELECT ?a WHERE { ?a a :R }')
    q.run()
    q.run()
    expect(withCost(1e9, () => e.compileIdle(50))).toBe(false)
    expect(e.stats.compiled).toBe(0)
    expect(e.candidates.size).toBe(1)
    // One run is not yet a candidate, however costly.
    const once = e.prepare(PREFIX + 'SELECT ?a ?b WHERE { ?a a :R . ?b a :R }')
    once.run()
    expect(withCost(0, () => e.compileIdle(50))).toBe(false)
    expect(once.isCompiled).toBe(false)
    expect(q.isCompiled).toBe(true)
  })

  it('stays within the slice: a module per slice at most when the budget allows one', () => {
    const e = new Engine(module)
    e.idleCompile = true
    e.load(Format.Turtle, DATA)
    const qs = QUERIES.slice(0, 6).map((t) => e.prepare(PREFIX + t))
    for (const q of qs) q.run(), q.run()
    const was = IDLE_COMPILE.perSlice
    const saving = IDLE_COMPILE.saving
    IDLE_COMPILE.perSlice = 1
    try {
      expect(withCost(0, () => e.compileIdle(50))).toBe(true)
      expect(e.stats.idleCompiled).toBe(1)
      // A budget below a module's cost compiles nothing (however much compiling would save).
      IDLE_COMPILE.saving = 1e9
      expect(withCost(1, () => e.compileIdle(0.5))).toBe(true)
      expect(e.stats.idleCompiled).toBe(1)
    } finally {
      IDLE_COMPILE.perSlice = was
      IDLE_COMPILE.saving = saving
    }
  })

  it('is what an engine store does in maintain, with compile: idle', () => {
    const store = engineStore(module, kind, { compile: 'idle' })
    store.loadTurtle(DATA)
    const text = PREFIX + 'SELECT ?a ?s WHERE { ?a :slug ?s FILTER(STRSTARTS(?s, "s-")) }'
    const show = () => store.select(text, []).map((m) => m.get('a')!.value + m.get('s')!.value).sort().join(' ')
    const expected = show()
    show()
    withCost(0, () => store.maintain!(50))
    expect(store.engine.stats.idleCompiled).toBe(1)
    expect(show()).toBe(expected)
    expect(store.engine.stats.compiledRuns).toBe(1)
  })
})
