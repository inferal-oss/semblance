// Components name their parts (#193): a rendering puts lc:role on the nodes it mints for its
// control and its label, and the layout constraints layer marks those elements data-sem-part (and
// data-sem-part-at, where a part has its role at one width only). The layout checker measures
// exactly these elements. The SPARQL renderings and their function twins name the same parts.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { DEFAULT_LAYERS, MOD } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'

const EX = 'https://example.org/parts#'

const APP = `
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <${EX}> .

ex:page a c:Stack ; c:children ( ex:name ex:bare ex:size ex:bar ex:nav ex:when ex:at ex:form ) .
ex:order ex:size ex:Small ; ex:page ex:Home ; ex:day "2026-10-24"^^xsd:date ; ex:time "09:30:00"^^xsd:time .
ex:size rdfs:label "Size" ; rdfs:range ex:Size .
ex:Small a ex:Size ; rdfs:label "Small" . ex:Large a ex:Size ; rdfs:label "Large" .
ex:page rdfs:label "Page" ; rdfs:range ex:Page .
ex:Home a ex:Page ; rdfs:label "Home" . ex:About a ex:Page ; rdfs:label "About" .
ex:day rdfs:label "Day" ; rdfs:range xsd:date .
ex:time rdfs:label "Time" ; rdfs:range xsd:time .

ex:name a c:TextField ; c:label "Name" .
ex:bare a c:TextField .
ex:size a c:Choice ; c:controls ex:order ; c:property ex:size .
ex:bar a c:Toolbar ; c:children ( ex:sizeInBar ) .
ex:sizeInBar a c:Choice ; c:controls ex:order ; c:property ex:size .
ex:nav a c:NavList ; c:controls ex:order ; c:property ex:page .
ex:when a c:DateField ; c:label "Day" ; c:controls ex:order ; c:property ex:day ; c:today "2026-10-21"^^xsd:date .
ex:at a c:TimeField ; c:label "Time" ; c:controls ex:order ; c:property ex:time .

ex:person ex:email "a@b.c" ; ex:age 30 ; ex:notes "" ; ex:subscribed true .
ex:PersonShape a sh:NodeShape ; sh:property ex:emailShape , ex:ageShape , ex:notesShape , ex:subscribedShape .
ex:emailShape sh:path ex:email ; sh:name "Email" ; sh:datatype xsd:string ; sh:order 1 .
ex:ageShape sh:path ex:age ; sh:name "Age" ; sh:datatype xsd:integer ; sh:order 2 .
ex:notesShape sh:path ex:notes ; sh:name "Notes" ; sh:datatype xsd:string ; sh:maxLength 500 ; sh:order 3 .
ex:subscribedShape sh:path ex:subscribed ; sh:name "Subscribed" ; sh:datatype xsd:boolean ; sh:order 4 .
ex:form a c:ShapeForm ; c:nodeShape ex:PersonShape ; c:of ex:person .
`

/** Every marked part: its node, role and width class, sorted. */
function parts(prefer: 'sparql' | 'function') {
  const store = loadStore('wat', APP)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, prefer, name: 'screen', roots: [EX + 'page'] }, (e) => {
    throw e
  })
  const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const renderer = new DomRenderer(screen.index, document.getElementById('app')!, EX + 'page')
  renderer.flush()
  const out = [...document.querySelectorAll('[data-sem-part]')].map((el) => {
    const key = renderer.keyOf(el)!.slice(EX.length)
    const at = el.getAttribute('data-sem-part-at')
    return `${key} ${el.localName} ${el.getAttribute('data-sem-part')}${at ? ' @' + at : ''}`
  })
  store.dispose?.()
  return { out: out.sort() }
}

describe('components name their parts (lc:role)', () => {
  const sparql = parts('sparql')

  it('marks each field\'s control and label, a nav list\'s items, and an inline choice\'s pill where it is wide', () => {
    expect(sparql.out).toEqual(
      [
        'name/~input input single-line-control',
        'name/~label label field-label',
        // without a label, the input alone
        'bare/~input input single-line-control',
        'size/~select select single-line-control',
        'size/~caption span field-label',
        // in a toolbar a choice is inline: its pill is the control where wide, its select on a phone
        'sizeInBar/~root label single-line-control @regular-width',
        'sizeInBar/~select select single-line-control @compact-width',
        'sizeInBar/~caption span field-label @compact-width',
        `nav/~opt-${encodeURIComponent(EX + 'About')} button nav-item`,
        `nav/~opt-${encodeURIComponent(EX + 'Home')} button nav-item`,
        // a date or time field's control is its row: the outlined box with the input and its button
        'when/~row div single-line-control',
        'when/~label label field-label',
        'at/~row div single-line-control',
        'at/~label label field-label',
      ]
        .concat(['email', 'age', 'notes', 'subscribed'].map((p) => `form/~f-${p}/~label label field-label`))
        // a checkbox and a text area are not single-line controls
        .concat(['email', 'age'].map((p) => `form/~f-${p}/~control input single-line-control`))
        .sort(),
    )
  })

  it('the function twins name the same parts', () => {
    expect(parts('function').out).toEqual(sparql.out)
  })
})
