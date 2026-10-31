// Result tables in SPARQL (#148): a query a result view shows is run as a view (c:QueryRuns:
// iv:perQuery, iv:OnRequest, iv:ResultSet) whose result - rows, a CONSTRUCT's triples, an ASK's
// answer, an error - is in the views graph, and c:ResultTableRendering-sparql (screen) and
// c:ResultTableAsText-sparql render it as their function twins do, byte for byte, on Oxigraph and
// on Semblance's own engine, after each step: a change to the data (not run again, unless the
// table follows updates), a run (c:runCount), new text, a binding's value.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, SEM, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'

const EX = 'https://example.org/#'

const DATA = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <https://example.org/#> .

ex:prefixes sh:declare [ sh:prefix "ex" ; sh:namespace "https://example.org/#"^^xsd:anyURI ] .
ex:alice ex:name "Alice" ; ex:age 31 ; ex:note "Hello"@en ; ex:knows ex:bob .
ex:bob ex:name "Bob | B" ; ex:age 4 ; ex:knows <https://example.org/a/very/long/path/that/goes/on/and/on/and/on/until/it/is/longer/than/sixty> .
ex:carol ex:name "Carol" .

ex:qPeople a sem:Query ; sem:select """SELECT ?person ?name ?age WHERE { ?person ex:name ?name OPTIONAL { ?person ex:age ?age } } ORDER BY DESC(?name)""" .
ex:qAll a sem:Query ; sem:select """SELECT * WHERE { ?s ex:knows ?o }""" .
ex:qLive a sem:Query ; sem:select """SELECT * WHERE { ?s ex:knows ?o }""" .
ex:qGraph a sem:Query ; sem:construct """CONSTRUCT { ?s ex:knows ?o ; ex:note ?n } WHERE { ?s ex:knows ?o OPTIONAL { ?s ex:note ?n } }""" .
ex:qAsk a sem:Query ; sem:select """ASK { ex:alice ex:knows ex:bob }""" .
ex:qBroken a sem:Query ; sem:select """SELECT ?x WHERE { ?x ex:name """ .
ex:qNone a sem:Query ; sem:select """SELECT ?x WHERE { ?x ex:nothing ?y }""" .
ex:qBound a sem:Query ; sem:select """SELECT ?p ?o WHERE { $who ?p ?o FILTER(?p != ex:knows) } ORDER BY ?p""" .
ex:qEmpty a sem:Query .

ex:pick ex:who ex:alice .
ex:people a c:ResultTable ; c:of ex:qPeople ; c:limit 2 .
ex:all a c:ResultTable ; c:of ex:qAll .
ex:graph a c:ResultTable ; c:of ex:qGraph .
ex:ask a c:ResultTable ; c:of ex:qAsk .
ex:broken a c:ResultTable ; c:of ex:qBroken .
ex:none a c:ResultTable ; c:of ex:qNone .
ex:bound a c:ResultTable ; c:of ex:qBound ; c:bindVariable "who" ; c:bindFrom ex:pick ; c:bindProperty ex:who ; c:emptyText "Pick someone." .
ex:empty a c:ResultTable ; c:of ex:qEmpty .
ex:nothing a c:ResultTable .
ex:live a c:ResultTable ; c:of ex:qLive ; c:followUpdates true .
`

const ROOTS = ['people', 'all', 'graph', 'ask', 'broken', 'none', 'bound', 'empty', 'nothing', 'live']

type Kind = 'oxigraph' | 'wat'

/** The tables rendered on their own, with SPARQL or with function rules, on screen and as text. */
function mount(kind: Kind, prefer: 'sparql' | 'function') {
  const store = loadStore(kind, DATA)
  const runtime = new Runtime(store)
  const shown = ROOTS.flatMap((root) =>
    [MOD.Screen, MOD.Text].map((modality) => {
      const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
      const screen = runtime.project({ modality, layers: [STY.Layer], prefer, name: `${root}-${modality.slice(-4)}`, roots: [EX + root] }, (e) => {
        throw e
      })
      const renderer = new DomRenderer(screen.index, document.getElementById('app')!, EX + root)
      return { renderer, app: document.getElementById('app')! }
    }),
  )
  const f = store.factory
  const n = (x: string) => f.namedNode(x.startsWith('http') ? x : EX + x)
  return {
    runtime,
    html: () => shown.map(({ renderer, app }) => (renderer.flush(), app.innerHTML)),
    at: (root: string, modality: 'screen' | 'text' = 'screen') => {
      const { renderer, app } = shown[ROOTS.indexOf(root) * 2 + (modality === 'screen' ? 0 : 1)]!
      renderer.flush()
      return app.innerHTML
    },
    set: (s: string, p: string, o: string | number) =>
      runtime.apply({ remove: store.match(n(s), n(p), null), add: [f.quad(n(s), n(p), typeof o === 'number' ? f.literal(String(o), f.namedNode('http://www.w3.org/2001/XMLSchema#integer')) : n(o))] }),
    text: (s: string, p: string, o: string) => runtime.apply({ remove: store.match(n(s), n(p), null), add: [f.quad(n(s), n(p), f.literal(o))] }),
  }
}

describe('result tables over runs of their queries, in SPARQL', () => {
  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders runs as the function twins do, after every step (${kind})`, () => {
      const [s, fn] = [mount(kind, 'sparql'), mount(kind, 'function')]
      const both = (step: (h: typeof s) => void) => {
        step(s)
        step(fn)
        expect(s.html()).toEqual(fn.html())
      }
      both(() => {})
      // Rows in ORDER BY's order, c:limit of them, the rest counted; IRIs by prefixed name.
      expect(s.at('people')).toContain('Rows: 3')
      expect(s.at('people')).toContain('+1 more')
      expect(s.at('people')).toContain('<code>ex:bob</code>')
      expect(s.at('people')).toContain('class="sem-end">4</td>')
      expect(s.at('people')).toContain('class="sem-unbound"')
      // SELECT *: the variables it binds; a long IRI by its end.
      expect(s.at('all')).toContain('<th scope="col">?s</th>')
      expect(s.at('all')).toContain('&lt;…')
      // A CONSTRUCT's triples, a language tag, an answer, an error, no rows, not run.
      expect(s.at('graph')).toContain('Triples: 3')
      expect(s.at('graph')).toContain('<span class="sem-lang">@en</span>')
      expect(s.at('ask')).toContain('Answer: true')
      expect(s.at('broken')).toContain('data-sem-c="alert"')
      expect(s.at('none')).toContain('No results.')
      expect(s.at('empty')).toContain('Run a query')
      expect(s.at('nothing')).toContain('Run a query')
      expect(s.at('bound')).toContain('Rows: 3')
      expect(s.at('people', 'text')).toContain('Rows: 3\n?person  ·  ?name  ·  ?age\nex:carol  ·  Carol  ·  \nex:bob  ·  Bob | B  ·  4\n+1 more')
      // A change to the data: an on-request run stays as it was; a table that follows updates follows.
      both((h) => h.set('dave', 'knows', 'alice'))
      expect(s.at('all')).not.toContain('ex:dave')
      expect(s.at('live')).toContain('ex:dave')
      // Run again (c:runCount): now it has it.
      both((h) => h.set('qAll', 'https://semblance.dev/ns/component#runCount', 2))
      expect(s.at('all')).toContain('ex:dave')
      // New text runs it; a binding's value runs the bound one; none shows its empty text.
      both((h) => h.text('qPeople', 'https://semblance.dev/ns/core#select', 'SELECT ?name WHERE { ?p ex:name ?name } ORDER BY DESC(?name)'))
      expect(s.at('people')).toContain('<th scope="col">?name</th>')
      both((h) => h.set('pick', 'who', 'bob'))
      expect(s.at('bound')).toContain('Bob')
      both((h) => h.runtime.apply({ remove: h.runtime.store.match(h.runtime.store.factory.namedNode(EX + 'pick'), null, null), add: [] }))
      expect(s.at('bound')).toContain('Pick someone.')
      // A query that fails, then works.
      both((h) => h.text('qBroken', 'https://semblance.dev/ns/core#select', 'SELECT ?x WHERE { ?x ex:age 4 }'))
      expect(s.at('broken')).toContain('ex:bob')
    }, 120_000)
  }
})
