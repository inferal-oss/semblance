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
`

const ROOTS = ['vPage', 'vShape', 'vCyc', 'vBad', 'vNone']

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
  })
})
