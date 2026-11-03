// The Turtle printer in SPARQL (#284, ontology/components/turtle.ttl): what a view prints is data
// first - a node per subject and per place a blank node prints, an entry per (predicate, object), its
// names and order key, lists, tokens - and the SPARQL rules render the same as their function twins,
// byte for byte, after each step.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import { sameHtml } from './same-html.ts'

const EX = 'https://example.org/#'

const DATA = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <https://example.org/#> .

ex:prefixes sh:declare [ sh:prefix "ex" ; sh:namespace "https://example.org/#"^^xsd:anyURI ] .

ex:page a ex:Stack ; ex:children ( ex:a ex:b ) ; ex:gap 3 ; ex:on [ ex:event "click" ; ex:does ex:x ] ;
  rdfs:label "Page"@en , "Seite"@de , "Page" ; ex:at "2026-10-24"^^xsd:date ; ex:n 10 , 2 , 33 ;
  ex:follows ( ex:run ex:sol [ ex:inverse ex:to ] ) , ( ex:alpha ex:col ) ; ex:text "two\\nlines \\"\\"\\" here" ;
  ex:odd "tab\\tand \\u0001" ; ex:other <http://other.example/thing> ; ex:empty [] .
ex:shape ex:property [ ex:path ex:x ; ex:in ( "a" "b" ) ; ex:node [ ex:deep [ ex:deeper 1 ] ] ] , [ ex:path ex:y ] .
ex:cyc ex:p _:c1 . _:c1 ex:q _:c2 . _:c2 ex:q _:c1 .
ex:bad ex:list [ <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> 1 ; <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> ex:notNil ] .

ex:vPage a c:TriplesView ; c:of ex:page .
ex:vShape a c:TriplesView ; c:of ex:shape .
ex:vCyc a c:TriplesView ; c:of ex:cyc .
ex:vBad a c:TriplesView ; c:of ex:bad .
ex:vNone a c:TriplesView ; c:of ex:nothing .
ex:docBadge a c:ClassDoc ; c:of c:CountBadge .
ex:docGraph a c:ClassDoc ; c:of c:ResultGraph .
ex:docShaped a c:ClassDoc ; c:of c:Button .
ex:docPicked a c:ClassDoc ; c:bindFrom ex:picker ; c:bindProperty ex:picked .
ex:picker ex:picked c:Toggle .
`

const ROOTS = ['vPage', 'vShape', 'vCyc', 'vBad', 'vNone', 'docBadge', 'docGraph', 'docShaped', 'docPicked']

function mount(prefer: 'sparql' | 'function') {
  const store = loadStore((process.env.ENGINE as 'wat') ?? 'wat', DATA)
  const runtime = new Runtime(store)
  const shown = ROOTS.map((root) => {
    const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    const screen = runtime.project({ modality: MOD.Screen, layers: [STY.Layer], prefer, name: root, roots: [EX + root] }, (e) => {
      throw e
    })
    const renderer = new DomRenderer(screen.index, document.getElementById('app')!, EX + root)
    return { renderer, app: document.getElementById('app')! }
  })
  const f = store.factory
  const n = (x: string) => f.namedNode(x.startsWith('http') ? x : EX + x)
  return {
    store,
    runtime,
    html: (root: string) => {
      const { renderer, app } = shown[ROOTS.indexOf(root)]!
      renderer.flush()
      return app.innerHTML
    },
    text: (root: string) => {
      const { renderer, app } = shown[ROOTS.indexOf(root)]!
      renderer.flush()
      return app.textContent ?? ''
    },
    add: (s: string, p: string, o: string | number) => runtime.apply({ add: [f.quad(n(s), n(p), typeof o === 'number' ? f.literal(String(o), f.namedNode('http://www.w3.org/2001/XMLSchema#integer')) : n(o))], remove: [] }),
    remove: (s: string, p: string) => runtime.apply({ remove: store.match(n(s), n(p), null), add: [] }),
  }
}

describe('the Turtle printer in SPARQL', () => {
  const sparql = mount('sparql')
  const fn = mount('function')
  const same = (step: string) => {
    for (const root of ROOTS) sameHtml(sparql.html(root), fn.html(root), `${root} after ${step}`)
  }

  it('prints a node with its blank nodes inlined, lists, literals and names', () => {
    same('loading')
    expect(sparql.text('vPage')).toBe(
      [
        'ex:page a ex:Stack ;',
        '    ex:at "2026-10-24"^^xsd:date ;',
        '    ex:children ( ex:a ex:b ) ;',
        '    ex:empty [] ;',
        '    ex:follows ( ex:alpha ex:col ), ( ex:run ex:sol [',
        '            ex:inverse ex:to',
        '        ] ) ;',
        '    ex:gap 3 ;',
        '    ex:n',
        '        2,',
        '        10,',
        '        33 ;',
        '    ex:odd "tab\\tand \\u0001" ;',
        '    ex:on [',
        '        ex:does ex:x ;',
        '        ex:event "click"',
        '    ] ;',
        '    ex:other <http://other.example/thing> ;',
        '    ex:text """two',
        'lines \\"\\"\\" here""" ;',
        '    rdfs:label',
        '        "Page",',
        '        "Page"@en,',
        '        "Seite"@de .',
        '',
      ].join('\n'),
    )
  })

  it('puts [ … ] on a line of its own a step deeper, and prints an ill-formed list as cells', () => {
    expect(sparql.text('vShape')).toBe(
      [
        'ex:shape ex:property',
        '        [',
        '            ex:in ( "a" "b" ) ;',
        '            ex:node [',
        '                ex:deep [',
        '                    ex:deeper 1',
        '                ]',
        '            ] ;',
        '            ex:path ex:x',
        '        ],',
        '        [',
        '            ex:path ex:y',
        '        ] .',
        '',
      ].join('\n'),
    )
    expect(sparql.text('vBad')).toBe(['ex:bad ex:list [', '        rdf:first 1 ;', '        rdf:rest ex:notNil', '    ] .', ''].join('\n'))
  })

  it('prints a cycle of blank nodes once, then []', () => {
    expect(sparql.text('vCyc')).toBe(['ex:cyc ex:p [', '        ex:q [', '            ex:q []', '        ]', '    ] .', ''].join('\n'))
    expect(sparql.text('vNone')).toBe('')
  })

  it('stays the same as the function after each change', () => {
    sparql.add('page', 'n', 7)
    fn.add('page', 'n', 7)
    same('adding an object')
    sparql.add('page', 'aaa', 'x')
    fn.add('page', 'aaa', 'x')
    same('adding a first predicate')
    sparql.remove('page', 'on')
    fn.remove('page', 'on')
    same('removing a blank node')
    sparql.remove('page', 'children')
    fn.remove('page', 'children')
    same('removing a list')
    sparql.add('nothing', 'p', 'q')
    fn.add('nothing', 'p', 'q')
    same('a node gaining its first triple')
    expect(sparql.text('vNone')).toBe('ex:nothing ex:p ex:q .\n')
    sparql.add('picker', 'picked', 'https://semblance.dev/ns/component#Heading')
    fn.add('picker', 'picked', 'https://semblance.dev/ns/component#Heading')
    sparql.remove('picker', 'picked')
    fn.remove('picker', 'picked')
    sparql.add('picker', 'picked', 'https://semblance.dev/ns/component#Heading')
    fn.add('picker', 'picked', 'https://semblance.dev/ns/component#Heading')
    same('another class picked')
    expect(sparql.text('docPicked')).toContain('c:Heading a owl:Class')
  })

  it('prints a class: its properties, renderings, reactions and shapes, queries elided', () => {
    const doc = sparql.text('docGraph')
    expect(doc).toMatch(/^# the class\nc:ResultGraph a owl:Class ;/)
    expect(doc).toContain('\n\n# how it renders\n')
    expect(doc).toContain('sem:construct "…"')
    expect(doc).toContain('( iv:run rs:solution rs:binding )')
    expect(sparql.text('docShaped')).toContain('# what a valid one looks like')
  })
})

// --- the result Turtle (c:ResultTurtle): a run of its query, printed ------------------------------------

const RESULTS = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <https://example.org/#> .

ex:prefixes sh:declare [ sh:prefix "ex" ; sh:namespace "https://example.org/#"^^xsd:anyURI ] .
ex:alice ex:name "Alice" ; ex:age 31 ; ex:note "Hi"@en ; ex:knows ex:bob , [ ex:name "Someone" ] .
ex:bob ex:name "Bob" ; ex:age 4 ; ex:knows ex:alice .
ex:carol ex:name "Carol" ; ex:age 31 .

ex:qPeople a sem:Query ; sem:construct """CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o FILTER(STRSTARTS(STR(?s), STR(ex:))) FILTER(?p IN (ex:name, ex:age, ex:knows, ex:note)) }""" .
ex:qShaped a sem:Query ; sem:construct """CONSTRUCT { ?s ex:friend [ ex:who ?o ; ex:since 2020 ] } WHERE { ?s ex:knows ?o FILTER(isIRI(?o)) }""" .
ex:qRows a sem:Query ; sem:select """SELECT ?person ?name ?friend WHERE { ?person ex:name ?name OPTIONAL { ?person ex:knows ?friend } } ORDER BY ?name""" .
ex:qAsk a sem:Query ; sem:select """ASK { ex:alice ex:knows ex:bob }""" .
ex:qBroken a sem:Query ; sem:select """SELECT ?x WHERE { ?x ex:name """ .
ex:qNone a sem:Query ; sem:construct """CONSTRUCT { ?x ex:p ?y } WHERE { ?x ex:nothing ?y }""" .
ex:qBound a sem:Query ; sem:select """SELECT ?p ?o WHERE { $who ?p ?o } ORDER BY ?p""" .
ex:pick ex:unused ex:nothing .

ex:people a c:ResultTurtle ; c:of ex:qPeople .
ex:shaped a c:ResultTurtle ; c:of ex:qShaped .
ex:rows a c:ResultTurtle ; c:of ex:qRows .
ex:capped a c:ResultTurtle ; c:of ex:qPeople ; c:limit 4 .
ex:cappedRows a c:ResultTurtle ; c:of ex:qRows ; c:limit 2 .
ex:ask a c:ResultTurtle ; c:of ex:qAsk .
ex:broken a c:ResultTurtle ; c:of ex:qBroken .
ex:none a c:ResultTurtle ; c:of ex:qNone .
ex:bound a c:ResultTurtle ; c:of ex:qBound ; c:bindVariable "who" ; c:bindFrom ex:pick ; c:bindProperty ex:who ; c:emptyText "Pick someone." .
ex:notRun a c:ResultTurtle .
`
const RESULT_ROOTS = ['people', 'shaped', 'rows', 'capped', 'cappedRows', 'ask', 'broken', 'none', 'bound', 'notRun']

function mountResults(prefer: 'sparql' | 'function') {
  const store = loadStore((process.env.ENGINE as 'wat') ?? 'wat', RESULTS)
  const runtime = new Runtime(store)
  const shown = RESULT_ROOTS.flatMap((root) =>
    [MOD.Screen, MOD.Text].map((modality) => {
      const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
      const screen = runtime.project({ modality, layers: [STY.Layer], prefer, name: `${root}-${modality.slice(-4)}`, roots: [EX + root] }, (e) => {
        throw e
      })
      return { renderer: new DomRenderer(screen.index, document.getElementById('app')!, EX + root), app: document.getElementById('app')! }
    }),
  )
  const at = (root: string, m: 'screen' | 'text') => shown[RESULT_ROOTS.indexOf(root) * 2 + (m === 'screen' ? 0 : 1)]!
  const f = store.factory
  const n = (x: string) => f.namedNode(x.startsWith('http') ? x : EX + x)
  return {
    runtime,
    html: (root: string, m: 'screen' | 'text' = 'screen') => (at(root, m).renderer.flush(), at(root, m).app.innerHTML),
    text: (root: string, m: 'screen' | 'text' = 'screen') => (at(root, m).renderer.flush(), at(root, m).app.querySelector('pre')?.textContent ?? ''),
    set: (s: string, p: string, o: string | number) =>
      runtime.apply({ remove: store.match(n(s), n(p), null), add: [f.quad(n(s), n(p), typeof o === 'number' ? f.literal(String(o), f.namedNode('http://www.w3.org/2001/XMLSchema#integer')) : n(o))] }),
  }
}

describe('the result Turtle in SPARQL', () => {
  it('prints what the function prints, on screen and as text, after each step', () => {
    const [sp, fn] = [mountResults('sparql'), mountResults('function')]
    const same = (what: string) => {
      for (const h of [sp, fn]) h.runtime.refresh()
      for (const root of RESULT_ROOTS) for (const m of ['screen', 'text'] as const) sameHtml(sp.html(root, m), fn.html(root, m), `${root} ${m} after ${what}`)
    }
    same('loading')
    expect(sp.text('people')).toContain('ex:alice ex:age 31 ;')
    // A blank node the run says nothing about (the query keeps IRI subjects only) prints as [].
    expect(sp.text('people')).toMatch(/ex:knows\n {8}\[\],\n {8}ex:bob ;/)
    expect(sp.text('shaped')).toContain('ex:friend [\n        ex:since 2020 ;\n        ex:who ex:bob\n    ] .')
    expect(sp.text('rows')).toContain('# The bindings, as a SPARQL result set\n[\n    a rs:ResultSet ;')
    expect(sp.text('rows')).toMatch(/rs:resultVariable\n {8}"friend",\n {8}"name",\n {8}"person" ;/)
    expect(sp.text('capped')).toContain('# +')
    expect(sp.text('cappedRows')).toMatch(/rs:index 2\n {8}\]\n\] \.\n\n# \+3 more$/)
    expect(sp.text('ask')).toContain('rs:boolean true')
    expect(sp.html('broken')).toContain('The query failed')
    expect(sp.html('none')).toContain('No results.')
    expect(sp.html('bound')).toContain('Pick someone.')
    expect(sp.text('people', 'text')).toBe(sp.text('people'))
    sp.set('pick', 'who', 'alice')
    fn.set('pick', 'who', 'alice')
    same('a binding')
    expect(sp.text('bound')).toContain('rs:value ex:bob')
    sp.set('capped', 'https://semblance.dev/ns/component#limit', 9)
    fn.set('capped', 'https://semblance.dev/ns/component#limit', 9)
    same('a larger limit')
    sp.set('pick', 'who', 'carol')
    fn.set('pick', 'who', 'carol')
    same('another binding')
  })
})

// --- the query view (c:QueryView): its queries' runs, a section each -----------------------------------

const QUERIES = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <https://example.org/#> .

ex:prefixes sh:declare [ sh:prefix "ex" ; sh:namespace "https://example.org/#"^^xsd:anyURI ] .
ex:alice ex:name "Alice" ; ex:age 31 ; ex:knows ex:bob .
ex:bob ex:name "Bob" ; ex:age 4 .
ex:carol ex:name "Carol" ; ex:age 52 .

ex:qNames a sem:Query ; rdfs:label "names"@en , "імена"@uk ; sem:construct """CONSTRUCT { ?s ex:name ?n } WHERE { ?s ex:name ?n }""" .
ex:qByAge a sem:Query ; rdfs:label "by age" ; sem:orderBy ex:age ; sem:descending true ;
  sem:construct """CONSTRUCT { ?s ex:age ?a ; ex:card [ ex:shows ?a ] } WHERE { ?s ex:age ?a }""" .
ex:qYoung a sem:Query ; rdfs:label "young first" ; sem:orderBy ex:age ; sem:construct """CONSTRUCT { ?s ex:age ?a } WHERE { ?s ex:age ?a FILTER(?a < 40) }""" .
ex:qOf a sem:Query ; rdfs:label "about the pick" ; sem:construct """CONSTRUCT { $who ?p ?o } WHERE { $who ?p ?o }""" .
ex:qNone a sem:Query ; rdfs:label "nothing" ; sem:construct """CONSTRUCT { ?s ex:p ?o } WHERE { ?s ex:nothing ?o }""" .
ex:qBroken a sem:Query ; rdfs:label "broken" ; sem:construct """CONSTRUCT { ?s ?p }""" .
ex:pick ex:unused ex:nothing .

ex:qvTwo a c:QueryView ; c:queries ( ex:qNames ex:qByAge ex:qYoung ) ; c:baseIri "https://example.org/" .
ex:qvBound a c:QueryView ; c:queries ( ex:qOf ) ; c:bindVariable "who" ; c:bindFrom ex:pick ; c:bindProperty ex:who ; c:emptyText "Pick someone." .
ex:qvNone a c:QueryView ; c:queries ( ex:qNone ) .
ex:qvBroken a c:QueryView ; c:queries ( ex:qNames ex:qBroken ) .
`
const QUERY_ROOTS = ['qvTwo', 'qvBound', 'qvNone', 'qvBroken']

function mountQueries(prefer: 'sparql' | 'function') {
  const store = loadStore((process.env.ENGINE as 'wat') ?? 'wat', QUERIES)
  const runtime = new Runtime(store)
  const shown = QUERY_ROOTS.map((root) => {
    const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    const screen = runtime.project({ modality: MOD.Screen, layers: [STY.Layer], prefer, name: root, roots: [EX + root] }, (e) => {
      throw e
    })
    return { screen, renderer: new DomRenderer(screen.index, document.getElementById('app')!, EX + root), app: document.getElementById('app')! }
  })
  const at = (root: string) => shown[QUERY_ROOTS.indexOf(root)]!
  const f = store.factory
  const n = (x: string) => f.namedNode(x.startsWith('http') ? x : EX + x)
  return {
    runtime,
    screens: () => shown.map((x) => x.screen),
    html: (root: string) => (at(root).renderer.flush(), at(root).app.innerHTML),
    text: (root: string) => (at(root).renderer.flush(), at(root).app.textContent ?? ''),
    set: (s: string, p: string, o: string | number) =>
      runtime.apply({ remove: store.match(n(s), n(p), null), add: [f.quad(n(s), n(p), typeof o === 'number' ? f.literal(String(o), f.namedNode('http://www.w3.org/2001/XMLSchema#integer')) : n(o))] }),
  }
}

describe('the query view in SPARQL', () => {
  it('prints what the function prints after each step', () => {
    const [sp, fn] = [mountQueries('sparql'), mountQueries('function')]
    const same = (what: string) => {
      for (const h of [sp, fn]) h.runtime.refresh()
      for (const root of QUERY_ROOTS) sameHtml(sp.html(root), fn.html(root), `${root} after ${what}`)
    }
    const both = (what: string, step: (h: typeof sp) => void) => {
      step(sp)
      step(fn)
      same(what)
    }
    same('loading')
    const two = sp.text('qvTwo')
    expect(two).toMatch(/^@base <https:\/\/example.org\/> \.\n@prefix ex: <https:\/\/example.org\/#> \.\n\n# names\n/)
    // By age, oldest first; young first, youngest first.
    expect(two.indexOf('ex:carol ex:age 52')).toBeLessThan(two.indexOf('ex:alice ex:age 31'))
    expect(two.slice(two.indexOf('# young first'))).toMatch(/ex:bob ex:age 4 \.\nex:alice ex:age 31 \.\n$/)
    expect(two).toContain('ex:card [\n        ex:shows 52\n    ] .')
    expect(sp.text('qvBound')).toBe('Pick someone.')
    expect(sp.text('qvNone')).toBe('No results.')
    expect(sp.text('qvBroken')).toMatch(/^Query broken failed: /)
    both('a binding', (h) => h.set('pick', 'who', 'alice'))
    expect(sp.text('qvBound')).toContain('ex:alice ex:age 31 ;')
    both('another binding', (h) => h.set('pick', 'who', 'carol'))
    for (const languages of [['uk'], ['en']]) {
      for (const h of [sp, fn]) for (const x of h.screens()) x.engine.reconfigure({ languages })
      same(languages.join())
    }
  })
})

// --- the element markup (c:ElementMarkup): the component as Turtle, the element as HTML ------------------

const MARKUP = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix sty: <https://semblance.dev/ns/style#> .
@prefix pos: <https://semblance.dev/ns/position#> .
@prefix tok: <https://semblance.dev/ns/token#> .
@prefix ex: <https://example.org/#> .

ex:prefixes sh:declare [ sh:prefix "ex" ; sh:namespace "https://example.org/#"^^xsd:anyURI ] .
ex:page a c:Stack ; pos:direction pos:Column ; pos:gap tok:space-3 ; c:children ( ex:title ex:todos ex:add ex:triples ) .
ex:title a c:Heading ; c:label "Todos & <more>" .
ex:todos a c:List ; c:label "Todos" ; c:sortBy ex:created ; c:itemLabel rdfs:label ; c:itemChecked ex:done ; c:item ex:write , ex:render .
ex:write rdfs:label "Write the ontology" ; ex:created 1 ; ex:done true .
ex:render rdfs:label "Render it" ; ex:created 2 ; ex:done false .
ex:add a c:Button ; c:label "Add \\"one\\"" ; sty:intent sty:Primary .
ex:triples a c:TriplesView ; c:of ex:write .

ex:pick ex:el ex:page .
ex:markup a c:ElementMarkup ; c:active true ; c:bindFrom ex:pick ; c:bindProperty ex:el ; c:baseIri "https://example.org/" .
ex:off a c:ElementMarkup ; c:active false ; c:bindFrom ex:pick ; c:bindProperty ex:el .
ex:none a c:ElementMarkup ; c:active true ; c:bindFrom ex:pick ; c:bindProperty ex:nothing ; c:emptyText "Pick an element." .
`
const MARKUP_ROOTS = ['markup', 'off', 'none']

function mountMarkup(prefer: 'sparql' | 'function') {
  const store = loadStore((process.env.ENGINE as 'wat') ?? 'wat', MARKUP)
  const runtime = new Runtime(store)
  const { document } = parseHTML('<!doctype html><html><body><div id="page"></div><div id="m"></div><div id="o"></div><div id="n"></div></body></html>')
  const screen = runtime.project({ modality: MOD.Screen, layers: [STY.Layer], prefer, name: 'm', roots: [EX + 'page', ...MARKUP_ROOTS.map((r) => EX + r)] }, (e) => {
    throw e
  })
  const renderers = [['page', 'page'], ['markup', 'm'], ['off', 'o'], ['none', 'n']].map(([root, id]) => [root, new DomRenderer(screen.index, document.getElementById(id)!, EX + root), document.getElementById(id)!] as const)
  const at = (root: string) => renderers.find(([r]) => r === root)!
  const f = store.factory
  return {
    runtime,
    screen,
    html: (root: string) => (at(root)[1].flush(), at(root)[2].innerHTML),
    text: (root: string) => (at(root)[1].flush(), at(root)[2].textContent ?? ''),
    pick: (node: string) => runtime.apply({ remove: store.match(f.namedNode(EX + 'pick'), f.namedNode(EX + 'el'), null), add: [f.quad(f.namedNode(EX + 'pick'), f.namedNode(EX + 'el'), f.namedNode(node))] }),
    add: (s: string, p: string, o: string) => runtime.apply({ add: [f.quad(f.namedNode(EX + s), f.namedNode(EX + p), f.literal(o))], remove: [] }),
  }
}

describe('the element markup in SPARQL', () => {
  it('prints what the function prints, for each element picked', () => {
    const [sp, fn] = [mountMarkup('sparql'), mountMarkup('function')]
    const same = (what: string) => {
      for (const h of [sp, fn]) h.runtime.refresh()
      for (const root of ['page', ...MARKUP_ROOTS]) sameHtml(sp.html(root), fn.html(root), `${root} after ${what}`)
    }
    same('loading')
    const page = sp.text('markup')
    expect(page).toMatch(/^@base <https:\/\/example.org\/> \.\n/)
    expect(page).toContain('# the component\nex:page a c:Stack ;')
    expect(page).toContain('\n\n# the element as HTML\n<div')
    expect(page).toContain('\n  <h2 data-sem-c="heading">Todos &amp; &lt;more&gt;</h2>\n')
    expect(page).toContain('>Add "one"</button>')
    expect(page.indexOf('Write the ontology')).toBeLessThan(page.indexOf('Render it'))
    expect(page).toMatch(/<input [^>]*type="checkbox"/)
    expect(sp.html('off')).toContain('hidden')
    expect(sp.text('none')).toBe('Pick an element.')
    expect(sp.screen.engine.stats.byRule.get('https://semblance.dev/ns/component#MarkupTokens-sparql')?.runs ?? 0).toBeGreaterThan(0)
    for (const node of ['ex:title', 'ex:todos', 'ex:triples', 'ex:add'].map((x) => x.replace('ex:', EX))) {
      for (const h of [sp, fn]) h.pick(node)
      same(`picking ${node}`)
      if (node.endsWith('triples')) expect(sp.text('markup')).toContain('<pre class="sem-turtle" data-sem-c="triples-view">\n  <span class="ttl-pname">ex:write</span>')
    }
    for (const h of [sp, fn]) h.add('write', 'note', 'a new triple')
    same('a triple the picked view shows')
    for (const h of [sp, fn]) h.pick(EX + 'title/~root')
    same('picking an element')
  })
})
