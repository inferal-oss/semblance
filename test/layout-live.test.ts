// The layout checker over the live graph (#192): a component that observes its layout
// (rnd:observes rnd:Layout) gets boxes in hundredths of a pixel, the nearest observed component
// above each (rnd:parent), the line each child of a row is on, and the boxes of the parts its
// components name (lc:role). The SPARQL checker (lc:Checker) reads that rendered graph with the
// app's own; the function checker reads it as a box tree (fromRendered); both find the same.
import { parseHTML } from 'linkedom'
import { beforeAll, describe, expect, it } from 'vitest'
import { Rel } from '../src/layout/check.ts'
import { checkMeasured, checkSparql, fromRendered, readDeclarations, type Declarations } from '../src/layout/invariants.ts'
import { loadStore } from '../src/node/load.ts'
import { DEFAULT_LAYERS, LC, MOD, NS, RENDERED_GRAPH, RND } from '../src/ns.ts'
import { RenderedState, stateOf } from '../src/rendered.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import { FakeLayout } from './rendered-layout.ts'

const EX = 'https://example.org/live#'
const APP = `@prefix c: <${NS.c}> . @prefix rnd: <${NS.rnd}> . @prefix pos: <${NS.pos}> . @prefix ex: <${EX}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix sh: <http://www.w3.org/ns/shacl#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:root a c:Stack ; c:children ( ex:row ex:nav ex:form ) ; rnd:observes rnd:Layout .
ex:row a c:Stack ; pos:direction pos:Row ; c:children ( ex:code ex:phone ) .
ex:code a c:TextField ; c:label "Code" .
ex:phone a c:TextField ; c:label "Phone" .
ex:state ex:page ex:Home .
ex:page rdfs:range ex:Page .
ex:Home a ex:Page ; rdfs:label "Home" . ex:About a ex:Page ; rdfs:label "About" .
ex:nav a c:NavList ; c:controls ex:state ; c:property ex:page .
# a form whose fields a rule mints: typed in the projection, not in the app's graph
ex:person ex:email "a@b.c" ; ex:age 30 .
ex:PersonShape a sh:NodeShape ; sh:property ex:emailShape , ex:ageShape .
ex:emailShape sh:path ex:email ; sh:name "Email" ; sh:datatype xsd:string ; sh:order 1 .
ex:ageShape sh:path ex:age ; sh:name "Age" ; sh:datatype xsd:integer ; sh:order 2 .
ex:form a c:ShapeForm ; c:nodeShape ex:PersonShape ; c:of ex:person .
`

let decl: Declarations
beforeAll(() => {
  const store = loadStore('wat')
  decl = readDeclarations(store)
  store.dispose?.()
})

function mount() {
  const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const store = loadStore('wat', APP)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, name: 'screen', roots: [EX + 'root'] }, (e) => {
    throw e
  })
  const shell = new DomRenderer(screen.index, document.getElementById('app')!, EX + 'root')
  shell.flush()
  // components by their IRI, parts by their node's
  const layout = new FakeLayout((el) => {
    const key = shell.keyOf(el)
    return key === undefined ? undefined : (screen.index.focusOf(key) ?? key)
  })
  const rendered = new RenderedState(runtime, shell, { layout, frame: () => {}, onWrite: () => shell.flush() })
  rendered.attach()
  const f = store.factory
  const g = f.namedNode(RENDERED_GRAPH)
  const one = (iri: string, p: string) => store.match(f.namedNode(stateOf(iri)), f.namedNode(p), null, g)[0]?.object
  const nav = (page: string) => `${EX}nav/~opt-${encodeURIComponent(EX + page)}`
  const place = (top = 100) => {
    layout.view.width = 800
    layout.place(EX + 'root', 0, 0, 800, 600).place(EX + 'row', 0, 0, 800, 80)
    layout.place(EX + 'code', 0, 0, 200, 70).place(EX + 'code/~label', 0, 0, 200, 20).place(EX + 'code/~input', 0, 24.25, 200, 38)
    layout.place(EX + 'phone', 216, 0, 300, 70).place(EX + 'phone/~label', 216, 0, 300, 20).place(EX + 'phone/~input', 216, 24.25, 300, 38)
    layout.place(EX + 'nav', 0, top, 200, 80).place(nav('About'), 0, top, 200, 40).place(nav('Home'), 0, top + 40, 200, 40)
    layout.place(EX + 'form', 0, 300, 400, 200)
    for (const [i, p] of ['email', 'age'].entries()) {
      const field = `${EX}form/~f-${p}`
      layout.place(field, 0, 320 + i * 80, 400, 70).place(field + '/~label', 0, 320 + i * 80, 400, 20).place(field + '/~control', 0, 344 + i * 80, 400, 38)
    }
  }
  const relayout = () => (rendered.invalidate(), rendered.flush())
  /** Both checkers over the live graph: the findings each reports, the same way. */
  const check = () => {
    const { page, components, states } = fromRendered(store, decl)
    const nodeOf = (iri: string | undefined) => (iri === undefined ? -1 : Math.max(components.indexOf(iri), states.indexOf(iri)))
    const fits = (r: unknown) => r === Rel.FitsInline || r === Rel.FitsWithin
    const local = (iri: string) => iri.slice(iri.lastIndexOf('#') + 1)
    const key = (inv: string, scope: number, member: number, by: number) => `${local(inv)} ${components[scope] ?? 'page'} ${member < 0 ? '' : components[member]} ${by.toFixed(2)}`
    const fn = checkMeasured(page, decl).map((x) => key(x.instance.declaration.iri, x.instance.scope, fits(x.instance.declaration.relation) ? x.member : -1, x.by))
    const sparql = checkSparql(store, nodeOf, ['urn:semblance:derived:screen']).map((x) => key(x.invariant, x.scope, x.member, x.by))
    return { fn: fn.sort(), sparql: sparql.sort() }
  }
  return { store, runtime, layout, rendered, one, nav, place, relayout, check, f, g }
}

describe('rendered state for the layout checker (rnd:Layout)', () => {
  it('writes boxes in hundredths of a pixel, each with its nearest observed component, and the parts components name', () => {
    const h = mount()
    h.place()
    h.relayout()
    expect(h.one(EX + 'code/~input', RND.y)?.value).toBe('24.25')
    expect((h.one(EX + 'code/~input', RND.y) as { datatype?: { value: string } }).datatype?.value).toBe(NS.xsd + 'decimal')
    expect(h.one(EX + 'code', RND.parent)?.value).toBe(stateOf(EX + 'row'))
    expect(h.one(EX + 'row', RND.parent)?.value).toBe(stateOf(EX + 'root'))
    expect(h.one(EX + 'root', RND.parent)).toBeUndefined()
    // a part: its own state, of its node, with its role and order, inside its component
    expect(h.one(EX + 'code/~input', RND.of)?.value).toBe(EX + 'code/~input')
    expect(h.one(EX + 'code/~input', LC.role)?.value).toBe(LC.SingleLineControl)
    expect(h.one(EX + 'code/~input', LC.index)?.value).toBe('0')
    expect(h.one(EX + 'code/~input', RND.parent)?.value).toBe(stateOf(EX + 'code'))
    expect(h.one(EX + 'code/~label', LC.role)?.value).toBe(LC.FieldLabel)
    expect([h.one(h.nav('About'), LC.role)?.value, h.one(h.nav('Home'), LC.role)?.value]).toEqual([LC.NavItem, LC.NavItem])
    // the children of a row, by line; nothing else has one
    expect([h.one(EX + 'code', RND.line)?.value, h.one(EX + 'phone', RND.line)?.value]).toEqual(['0', '0'])
    expect(h.one(EX + 'row', RND.line)).toBeUndefined()
  })

  it('a row that wraps puts its children on lines; a clipping box and content wider than its box say so', () => {
    const h = mount()
    h.place()
    h.layout.place(EX + 'phone', 0, 80, 300, 70).place(EX + 'phone/~input', 0, 104.25, 300, 38)
    h.layout.clipping.add(EX + 'nav')
    h.layout.scrolls.set(h.nav('Home'), { top: 0, left: 0, height: 40, width: 260, clientHeight: 40, clientWidth: 200 })
    h.relayout()
    expect([h.one(EX + 'code', RND.line)?.value, h.one(EX + 'phone', RND.line)?.value]).toEqual(['0', '1'])
    expect(h.one(EX + 'nav', RND.scrolls)?.value).toBe('true')
    expect([h.one(h.nav('Home'), RND.scrollWidth)?.value, h.one(h.nav('Home'), RND.clientWidth)?.value]).toEqual(['260', '200'])
    expect(h.one(h.nav('About'), RND.scrollWidth)).toBeUndefined()
  })

  it('both checkers find nothing in an aligned page, and the same broken invariants in a misaligned one', () => {
    const h = mount()
    h.place()
    h.relayout()
    expect(h.check()).toEqual({ fn: [], sparql: [] })
    // the phone's input 3.5 px lower and taller than the code's (#34, #57)
    h.layout.place(EX + 'phone/~input', 216, 27.75, 300, 41.5)
    // a nav item that runs out of its list (#53), and the page wider than its viewport
    h.layout.place(h.nav('Home'), 0, 140, 260, 40)
    h.layout.documentWide = 900
    // and a form's age taller than its email
    h.layout.place(`${EX}form/~f-age/~control`, 0, 424, 400, 41)
    h.relayout()
    const { fn, sparql } = h.check()
    expect(sparql).toEqual(fn)
    expect(fn.map((k) => k.split(' ')[0])).toEqual(['fieldRowControlsShareHeight', 'fieldRowControlsShareTops', 'formControlsShareHeight', 'navItemsFit', 'pageFits'])
    expect(fn).toContain(`formControlsShareHeight ${EX}form  3.00`)
    expect(fn).toContain(`fieldRowControlsShareTops ${EX}row  3.50`)
    expect(fn).toContain(`navItemsFit ${EX}nav ${h.nav('Home')} 60.00`)
    // lines apart, the row's fields are not compared
    h.layout.place(EX + 'phone', 0, 80, 300, 70).place(EX + 'phone/~input', 0, 107.75, 300, 41.5)
    h.relayout()
    expect(h.check().fn.filter((k) => k.startsWith('fieldRow'))).toEqual([])
  })

  it('leaves the live store as it was, and a scope that stops observing its layout takes the parts with it', () => {
    const h = mount()
    h.place()
    h.relayout()
    const before = h.store.match().length
    h.check()
    expect(h.store.match().length).toBe(before)
    const root = h.f.namedNode(EX + 'root')
    h.runtime.apply({ add: [], remove: [h.f.quad(root, h.f.namedNode(RND.observes), h.f.namedNode(RND.Layout))] })
    h.relayout()
    expect(h.store.match(null, null, null, h.g).filter((q) => q.predicate.value === LC.role)).toEqual([])
  })
})
