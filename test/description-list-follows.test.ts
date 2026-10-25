import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { A11Y, MOD, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'

const EX = 'https://example.org/dl#'
const graph = (of: string) => `
@prefix c: <https://semblance.dev/ns/component#> .
@prefix beh: <https://semblance.dev/ns/behaviour#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix sem: <https://semblance.dev/ns/core#> .
@prefix ex: <${EX}> .
ex:rating rdfs:label "rating" . ex:notes rdfs:label "notes" .
ex:eth ex:rating 1 ; ex:notes "Jasmine" .
ex:col ex:rating 3 ; ex:notes "Caramel" .
ex:tasting ex:chosen ex:eth .
ex:page a c:Stack ; c:children ( ex:dl ex:triples ex:rate ex:choose ) .
${of}
ex:triples a c:TriplesView ; c:of ex:eth .
ex:rate a c:Button ; c:label "Rate" .
ex:choose a c:Button ; c:label "Choose" .
ex:Rate a beh:Reaction ; beh:when beh:Click ; beh:source ex:rate ;
  beh:deletes """PREFIX ex: <${EX}> CONSTRUCT { ?x ex:rating ?n } WHERE { ex:dl c:of ?x . ?x ex:rating ?n }""" ;
  beh:inserts """PREFIX ex: <${EX}> CONSTRUCT { ?x ex:rating ?next } WHERE { ex:dl c:of ?x . ?x ex:rating ?n BIND(?n + 1 AS ?next) }""" .
ex:Choose a beh:Reaction ; beh:when beh:Click ; beh:source ex:choose ;
  beh:deletes """PREFIX ex: <${EX}> CONSTRUCT { ex:tasting ex:chosen ?x } WHERE { ex:tasting ex:chosen ?x }""" ;
  beh:inserts """PREFIX ex: <${EX}> CONSTRUCT { ex:tasting ex:chosen ex:col } WHERE {}""" .
`

function mount(of: string, kind: StoreKind, prefer: 'sparql' | 'function') {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const store = loadStore(kind, graph(of))
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer], prefer, name: 'screen', roots: [EX + 'page'] }, (e) => {
    throw e
  })
  const dom = new DomRenderer(screen.index, document.getElementById('app')!, EX + 'page')
  dom.flush()
  const bus = new EventBus(runtime, screen, { prefer })
  bus.attach(dom, () => dom.flush())
  const f = store.factory
  const byId = (id: string) => [...document.querySelectorAll('*')].find((e) => dom.keyOf(e) === `${EX}${id}/~root`) as HTMLElement
  const click = (id: string) => byId(id).dispatchEvent(new window.Event('click', { bubbles: true }))
  const pairs = () => Object.fromEntries([...byId('dl').querySelectorAll('.sem-pair')].map((p) => [p.querySelector('dt')!.textContent, p.querySelector('dd')!.textContent]))
  const rating = (s: string) => store.match(f.namedNode(EX + s), f.namedNode(EX + 'rating'), null).map((q) => q.object.value)
  return { click, pairs, rating }
}

describe('c:DescriptionList follows the node it describes', () => {
  for (const kind of ['wat', 'oxigraph'] as StoreKind[])
    for (const prefer of ['sparql', 'function'] as const) {
      it(`shows every change to a listed field of c:of, not only the first (${kind}, ${prefer})`, () => {
        const m = mount('ex:dl a c:DescriptionList ; c:of ex:eth ; c:fields ( ex:notes ex:rating ) .', kind, prefer)
        expect(m.pairs()).toEqual({ notes: 'Jasmine', rating: '1' })
        for (const n of ['2', '3', '4']) {
          m.click('rate')
          expect(m.rating('eth')).toEqual([n])
          expect(m.pairs()).toEqual({ notes: 'Jasmine', rating: n })
        }
      })

      it(`follows a derived c:of to a new node, and that node's changes (${kind}, ${prefer})`, () => {
        // c:of is the tasting's chosen coffee, derived by an input-only rule (as the coffee example does).
        const m = mount(
          `ex:dl a c:DescriptionList , ex:OnChosen ; ex:tasting ex:tasting ; c:fields ( ex:notes ex:rating ) .
           ex:PointAtChosen a sem:Rendering ; sem:targets ex:OnChosen ; sem:stratum -15 ; sem:follows ex:tasting ;
             sem:inputOnly true ; sem:watches rdf:type , ex:tasting , ex:chosen .
           ex:PointAtChosen-sparql a sem:Rule ; sem:implements ex:PointAtChosen ;
             sem:construct """PREFIX ex: <${EX}> CONSTRUCT { $this c:of ?x } WHERE { $this a ex:OnChosen ; ex:tasting ?t . ?t ex:chosen ?x }""" .`,
          kind,
          prefer,
        )
        expect(m.pairs()).toEqual({ notes: 'Jasmine', rating: '1' })
        m.click('rate')
        m.click('rate')
        expect(m.pairs()).toEqual({ notes: 'Jasmine', rating: '3' })
        m.click('choose')
        expect(m.pairs()).toEqual({ notes: 'Caramel', rating: '3' })
        m.click('rate')
        expect(m.rating('col')).toEqual(['4'])
        m.click('rate')
        expect(m.rating('col')).toEqual(['5'])
        expect(m.pairs()).toEqual({ notes: 'Caramel', rating: '5' })
      })
    }
})
