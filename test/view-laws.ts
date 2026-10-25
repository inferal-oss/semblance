// The operator-law generator (docs/IVM.md §12.2): seeded random changes to a small graph - a
// stream whose members point outside themselves (targets, their labels, groups, a class
// hierarchy), a collection of items, a settings node - and a view per operator shape (joins
// outside the member, DISTINCT, UNION, VALUES, OPTIONAL, EXISTS, NOT EXISTS, MINUS, top-k,
// parameters, views per instance). With the runtime strict, every view is compared with a
// from-scratch run of its own query after every tick; any difference throws.
import type { Quad } from '@rdfjs/types'
import { loadStore } from '../src/node/load.ts'
import { LDES, NS } from '../src/ns.ts'
import { Runtime } from '../src/runtime.ts'
import { ManualClock } from '../src/view/runtime.ts'

export const V = 'https://example.org/law#'
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#'

/** One view per operator shape (name -> query); `materialized` ones write rs: rows. */
export const LAW_VIEWS: Record<string, string> = {
  join: `SELECT ?m ?label WHERE { v:s tree:member ?m . ?m v:target ?t . ?t rdfs:label ?label }`,
  chain: `SELECT ?glabel (COUNT(?m) AS ?n) WHERE { v:s tree:member ?m . ?m v:target ?t . ?t v:group ?g . ?g rdfs:label ?glabel } GROUP BY ?glabel`,
  distinct: `SELECT DISTINCT ?t WHERE { v:s tree:member ?m . ?m v:target ?t }`,
  distinctPath: `SELECT DISTINCT ?label WHERE { v:s tree:member ?m . ?m v:target/rdfs:label ?label }`,
  union: `SELECT ?m ?v WHERE { v:s tree:member ?m . { ?m v:x ?v } UNION { ?m v:target ?t . ?t rdfs:label ?v } }`,
  values: `SELECT ?m ?w WHERE { VALUES (?k ?w) { (v:K1 "one") (v:K2 "two") } v:s tree:member ?m . ?m v:kind ?k }`,
  optional: `SELECT ?m ?label WHERE { v:s tree:member ?m . OPTIONAL { ?m v:target ?t . ?t rdfs:label ?label } }`,
  exists: `SELECT ?m WHERE { v:s tree:member ?m . ?m v:target ?t FILTER EXISTS { ?t v:hidden true } }`,
  notExists: `SELECT (COUNT(*) AS ?n) WHERE { v:s tree:member ?m . ?m v:target ?t FILTER NOT EXISTS { ?t v:hidden true } }`,
  minus: `SELECT ?m WHERE { v:s tree:member ?m . ?m v:target ?t MINUS { ?t v:group v:G1 } }`,
  settings: `SELECT ?m WHERE { v:s tree:member ?m . ?m v:kind ?k . FILTER(NOT EXISTS { v:cfg v:showKind ?any } || EXISTS { v:cfg v:showKind ?k }) }`,
  classes: `SELECT ?c (COUNT(?m) AS ?n) WHERE { v:s tree:member ?m . ?m v:kind/rdfs:subClassOf* ?c } GROUP BY ?c`,
  topk: `SELECT ?m ?x WHERE { v:s tree:member ?m . ?m v:x ?x } ORDER BY DESC(?x) ?m LIMIT 3`,
  topkJoin: `SELECT ?m ?label WHERE { v:s tree:member ?m . ?m v:x ?x ; v:target/rdfs:label ?label } ORDER BY ?label ?m OFFSET 1 LIMIT 4`,
  items: `SELECT ?i ?label ?s WHERE { ?i a v:Item ; v:owner ?t . ?t rdfs:label ?label OPTIONAL { ?i v:score ?s } }`,
  having: `SELECT ?t (SUM(?s) AS ?total) (SUM(?s) / COUNT(?i) AS ?mean) WHERE { ?i a v:Item ; v:owner ?t ; v:score ?s } GROUP BY ?t HAVING (COUNT(?i) > 1)`,
  minMax: `SELECT ?t (MIN(?s) AS ?lo) (MAX(?s) AS ?hi) (MAX(?label) AS ?last) WHERE { ?i a v:Item ; v:owner ?t ; v:score ?s . ?t rdfs:label ?label } GROUP BY ?t`,
  topGroups: `SELECT ?t (COUNT(?i) AS ?n) WHERE { ?i a v:Item ; v:owner ?t } GROUP BY ?t ORDER BY DESC(?n) ?t LIMIT 2`,
  orderedExpr: `SELECT ?i ?s WHERE { ?i a v:Item ; v:score ?s } ORDER BY DESC(?s * 2 - 1) ?i LIMIT 3`,
  // Aggregate subqueries as derived inputs (a view inside the view): an aggregate of aggregates,
  // a join with a group's best row, an ungrouped one, one with HAVING under OPTIONAL.
  aggOfAgg: `SELECT (MAX(?n) AS ?max) (COUNT(?t) AS ?targets) WHERE { { SELECT ?t (COUNT(?m) AS ?n) WHERE { v:s tree:member ?m . ?m v:target ?t } GROUP BY ?t } }`,
  bestOfGroup: `SELECT ?m ?t ?best WHERE { { SELECT ?t (MAX(?x) AS ?best) WHERE { v:s tree:member ?m . ?m v:target ?t ; v:x ?x } GROUP BY ?t } v:s tree:member ?m . ?m v:target ?t ; v:x ?best }`,
  topScore: `SELECT ?i WHERE { { SELECT (MAX(?s) AS ?top) WHERE { ?j a v:Item ; v:score ?s } } ?i a v:Item ; v:score ?top }`,
  busyTargets: `SELECT ?t ?n WHERE { ?t a v:Target OPTIONAL { { SELECT ?t (COUNT(?i) AS ?n) WHERE { ?i v:owner ?t } GROUP BY ?t HAVING (COUNT(?i) > 1) } } }`,
  // A cross product: partitions by (item, kind); a new kind reaches every item's slice.
  cross: `SELECT ?i ?k ?s WHERE { ?i a v:Item . v:cfg v:showKind ?k OPTIONAL { ?i v:score ?s } }`,
}

const CONSTRUCTS: Record<string, string> = {
  labelled: `CONSTRUCT { ?m v:labelled ?label } WHERE { v:s tree:member ?m . ?m v:target ?t . ?t rdfs:label ?label }`,
  unionParts: `CONSTRUCT { ?row v:n ?n } WHERE { { SELECT ?row (COUNT(?m) AS ?n) WHERE { v:s tree:member ?m . ?m v:kind ?row } GROUP BY ?row } UNION { SELECT ?row (COUNT(?i) AS ?n) WHERE { ?i a v:Item ; v:owner ?row } GROUP BY ?row } }`,
  busiest: `CONSTRUCT { ?t v:busiest ?label } WHERE { { SELECT (MAX(?n) AS ?max) WHERE { { SELECT ?t (COUNT(?i) AS ?n) WHERE { ?i v:owner ?t } GROUP BY ?t } } } { SELECT ?t (COUNT(?i) AS ?n) WHERE { ?i v:owner ?t } GROUP BY ?t } FILTER(?n = ?max) ?t rdfs:label ?label }`,
  topRows: `CONSTRUCT { ?node v:top ?m ; v:x ?x } WHERE { { SELECT ?m ?x WHERE { v:s tree:member ?m . ?m v:x ?x } ORDER BY ?x ?m LIMIT 2 } BIND(IRI(CONCAT(STR(?m), "/~top")) AS ?node) }`,
}

export const lawTurtle = `
@prefix v: <${V}> .
@prefix sem: <https://semblance.dev/ns/core#> .
@prefix iv: <https://semblance.dev/ns/view#> .
@prefix ldes: <https://w3id.org/ldes#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfs: <${RDFS}> .

v:prefixes sh:declare [ sh:prefix "v" ; sh:namespace "${V}"^^xsd:anyURI ] .
v:s a ldes:EventStream .
v:K3 rdfs:subClassOf v:K1 .
v:K4 rdfs:subClassOf v:K3 .
${Object.entries(LAW_VIEWS).map(([k, q]) => `v:${k} a iv:View ; sem:select """${q}""" .`).join('\n')}
${Object.entries(CONSTRUCTS).map(([k, q]) => `v:${k} a iv:View ; sem:construct """${q}""" .`).join('\n')}
v:rows a iv:View ; iv:materialize iv:Graph ; sem:select """${LAW_VIEWS.topk}""" .
v:paged a iv:View ; iv:parameter [ iv:variable "k" ; iv:from v:cfg ; iv:property v:limit ; iv:default 2 ] ;
    sem:select """SELECT ?m ?x WHERE { v:s tree:member ?m . ?m v:x ?x } ORDER BY ?x ?m LIMIT $k""" .
v:kinded a iv:View ; iv:parameter [ iv:variable "kind" ; iv:from v:cfg ; iv:property v:kind ; iv:default v:K1 ] ;
    sem:select """SELECT ?m ?t WHERE { v:s tree:member ?m . ?m v:kind $kind OPTIONAL { ?m v:target ?t } }""" .
v:atLeast a iv:View ; iv:parameter [ iv:variable "min" ; iv:from v:cfg ; iv:property v:min ; iv:default 3 ] , [ iv:variable "k" ; iv:from v:cfg ; iv:property v:limit ; iv:default 2 ] ;
    sem:select """SELECT ?m ?x WHERE { v:s tree:member ?m . ?m v:x ?x FILTER(?x >= $min) } ORDER BY ?x ?m LIMIT $k""" .
v:upTo a iv:View ; iv:parameter [ iv:variable "min" ; iv:from v:cfg ; iv:property v:min ; iv:default 3 ] ;
    sem:select """SELECT (SUM(IF(?x <= $min, 1, 0)) AS ?below) (COUNT(*) AS ?all) WHERE { v:s tree:member ?m . ?m v:x ?x }""" .
v:perTarget a iv:View ; iv:targets v:Target ; iv:materialize iv:Graph ;
    sem:select """SELECT (COUNT(?m) AS ?n) WHERE { v:s tree:member ?m . ?m v:target $this }""" .
`

/** A seeded PRNG (mulberry32), so a failure replays. */
export function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function lawRuntime(kind: 'oxigraph' | 'wat' = 'oxigraph') {
  const store = loadStore(kind, lawTurtle)
  const runtime = new Runtime(store)
  runtime.views.clock = new ManualClock()
  runtime.views.strict = true
  // No projection shows anything here: every view (a view per instance too) is maintained.
  runtime.views.shown = () => true
  runtime.views.start('sparql')
  return { store, runtime }
}

/** `steps` random changes (seeded); every tick is checked (strict). Returns what it did. */
export function runLaws(seed: number, steps: number, kind: 'oxigraph' | 'wat' = 'oxigraph') {
  const { store, runtime } = lawRuntime(kind)
  const f = store.factory
  const nn = (s: string) => f.namedNode(V + s)
  const p = (s: string) => f.namedNode(s.startsWith('http') ? s : V + s)
  const int = (n: number) => f.literal(String(n), f.namedNode(NS.xsd + 'integer'))
  const r = rng(seed)
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!
  const T = ['T1', 'T2', 'T3', 'T4', 'T5']
  const K = ['K1', 'K2', 'K3', 'K4']
  const G = ['G1', 'G2', 'G3']
  const members: string[] = []
  const items: string[] = []
  let n = 0
  const counts: Record<string, number> = {}
  const did = (what: string) => (counts[what] = (counts[what] ?? 0) + 1)
  const set = (s: string, pred: string, o: ReturnType<typeof f.literal> | ReturnType<typeof f.namedNode> | undefined): Quad[][] => {
    const old = store.match(nn(s), p(pred), null)
    return [old, o ? [f.quad(nn(s), p(pred), o)] : []]
  }
  const apply = ([remove, add]: Quad[][]) => runtime.apply({ remove: remove!, add: add! })
  // Targets with labels and groups to begin with.
  runtime.transaction(() => {
    for (const t of T) {
      apply([[], [f.quad(nn(t), p(RDFS + 'label'), f.literal('label ' + t)), f.quad(nn(t), p('group'), nn(pick(G)))]])
      if (r() < 0.6) apply([[], [f.quad(nn(t), p(NS.rdf + 'type'), nn('Target'))]])
    }
    for (const g of G) apply([[], [f.quad(nn(g), p(RDFS + 'label'), f.literal('group ' + g))]])
  })
  const append = () => {
    const m = `m${++n}`
    const quads = [f.quad(nn('s'), f.namedNode(LDES.member), nn(m)), f.quad(nn(m), p('kind'), nn(pick(K))), f.quad(nn(m), p('x'), int(Math.floor(r() * 10)))]
    if (r() < 0.85) quads.push(f.quad(nn(m), p('target'), nn(pick(T))))
    members.push(m)
    return [[], quads]
  }
  const retire = (): Quad[][] => {
    const m = members.splice(Math.floor(r() * members.length), 1)[0]
    if (!m) return [[], []]
    return [[...store.match(nn(m), null, null), ...store.match(null, f.namedNode(LDES.member), nn(m))], []]
  }
  const ops: [string, number, () => Quad[][]][] = [
    ['append', 3, append],
    ['retire', 1.5, retire],
    ['member x', 1, () => (members.length ? set(pick(members), 'x', int(Math.floor(r() * 10))) : [[], []])],
    ['member target', 1, () => (members.length ? set(pick(members), 'target', r() < 0.15 ? undefined : nn(pick(T))) : [[], []])],
    ['member kind', 0.5, () => (members.length ? set(pick(members), 'kind', nn(pick(K))) : [[], []])],
    ['label', 1, () => set(pick(T), RDFS + 'label', r() < 0.2 ? undefined : f.literal('label ' + Math.floor(r() * 6)))],
    ['hidden', 1, () => set(pick(T), 'hidden', r() < 0.5 ? f.literal('true', f.namedNode(NS.xsd + 'boolean')) : undefined)],
    ['group', 0.7, () => set(pick(T), 'group', nn(pick(G)))],
    ['group label', 0.5, () => set(pick(G), RDFS + 'label', f.literal('group ' + Math.floor(r() * 4)))],
    ['showKind', 0.4, () => (r() < 0.5 ? [[], [f.quad(nn('cfg'), p('showKind'), nn(pick(K)))]] : [store.match(nn('cfg'), p('showKind'), null).slice(0, 1), []])],
    ['limit', 0.4, () => set('cfg', 'limit', r() < 0.2 ? undefined : int(1 + Math.floor(r() * 4)))],
    ['kind parameter', 0.4, () => set('cfg', 'kind', r() < 0.2 ? undefined : nn(pick(K)))],
    ['min parameter', 0.4, () => set('cfg', 'min', r() < 0.2 ? undefined : int(Math.floor(r() * 10)))],
    ['subclass', 0.3, () => (r() < 0.5 ? [[], [f.quad(nn(pick(K)), p(RDFS + 'subClassOf'), nn(pick(K)))]] : [store.match(null, p(RDFS + 'subClassOf'), null).slice(0, 1), []])],
    ['item', 1.2, () => {
      const i = `i${++n}`
      items.push(i)
      const qs = [f.quad(nn(i), p(NS.rdf + 'type'), nn('Item')), f.quad(nn(i), p('owner'), nn(pick(T)))]
      if (r() < 0.8) qs.push(f.quad(nn(i), p('score'), int(Math.floor(r() * 7))))
      return [[], qs]
    }],
    ['item gone', 0.6, () => {
      const i = items.splice(Math.floor(r() * items.length), 1)[0]
      return i ? [store.match(nn(i), null, null), []] : [[], []]
    }],
    ['item score', 0.8, () => (items.length ? set(pick(items), 'score', r() < 0.2 ? undefined : int(Math.floor(r() * 7))) : [[], []])],
    ['item owner', 0.5, () => (items.length ? set(pick(items), 'owner', nn(pick(T))) : [[], []])],
    ['target type', 0.4, () => set(pick(T), NS.rdf + 'type', r() < 0.5 ? nn('Target') : undefined)],
  ]
  const total = ops.reduce((a, [, w]) => a + w, 0)
  const choose = () => {
    let x = r() * total
    for (const op of ops) if ((x -= op[1]) < 0) return op
    return ops[0]!
  }
  for (let step = 0; step < steps; step++) {
    if (r() < 0.15) {
      // Several changes as one tick, some of them undoing others.
      runtime.transaction(() => {
        for (let i = 0; i < 2 + Math.floor(r() * 4); i++) {
          const [name, , op] = choose()
          did(name)
          apply(op())
        }
      })
      did('transaction')
    } else {
      const [name, , op] = choose()
      did(name)
      apply(op())
    }
  }
  return { store, runtime, counts }
}
