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
ex:choose a c:Button ; c:label "Choose the other" .
ex:Rate a beh:Reaction ; beh:when beh:Click ; beh:source ex:rate ;
  beh:deletes """PREFIX ex: <${EX}> CONSTRUCT { ?x ex:rating ?n } WHERE { ex:dl c:of ?x . ?x ex:rating ?n }""" ;
  beh:inserts """PREFIX ex: <${EX}> CONSTRUCT { ?x ex:rating ?next } WHERE { ex:dl c:of ?x . ?x ex:rating ?n BIND(?n + 1 AS ?next) }""" .
ex:Choose a beh:Reaction ; beh:when beh:Click ; beh:source ex:choose ;
  beh:deletes """PREFIX ex: <${EX}> CONSTRUCT { ex:tasting ex:chosen ?x } WHERE { ex:tasting ex:chosen ?x }""" ;
  beh:inserts """PREFIX ex: <${EX}> CONSTRUCT { ex:tasting ex:chosen ?y } WHERE { ex:tasting ex:chosen ?x BIND(IF(?x = ex:eth, ex:col, ex:eth) AS ?y) }""" .
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
  const pairs = (id = 'dl') => Object.fromEntries([...byId(id).querySelectorAll('.sem-pair')].map((p) => [p.querySelector('dt')!.textContent, p.querySelector('dd')!.textContent]))
  const rating = (s: string) => store.match(f.namedNode(EX + s), f.namedNode(EX + 'rating'), null).map((q) => q.object.value)
  const triples = () => byId('triples').textContent
  return { click, pairs, rating, triples }
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

      it(`follows every change inside a c:Switch case, as the triples view does (${kind}, ${prefer})`, () => {
        // The shape #51 was seen in: a switch over the chosen coffee, each case a card holding the
        // coffee's description list (c:of fixed in the input). Only the shown case is demanded.
        const m = mount(
          `ex:dl a c:Switch ; c:controls ex:tasting ; c:property ex:chosen ; c:of ex:eth ; c:cases ( ex:case-eth ex:case-col ) .
           ex:case-eth c:when ex:eth ; c:content ex:card-eth .
           ex:case-col c:when ex:col ; c:content ex:card-col .
           ex:card-eth a c:Card ; c:label "Yirgacheffe" ; c:content ex:stack-eth .
           ex:card-col a c:Card ; c:label "Huila" ; c:content ex:stack-col .
           ex:stack-eth a c:Stack ; c:children ( ex:dl-eth ) .
           ex:stack-col a c:Stack ; c:children ( ex:dl-col ) .
           ex:dl-eth a c:DescriptionList ; c:of ex:eth ; c:fields ( ex:notes ex:rating ) .
           ex:dl-col a c:DescriptionList ; c:of ex:col ; c:fields ( ex:notes ex:rating ) .`,
          kind,
          prefer,
        )
        expect(m.pairs('dl-eth')).toEqual({ notes: 'Jasmine', rating: '1' })
        for (const n of ['2', '3', '4', '5']) {
          m.click('rate')
          expect(m.rating('eth')).toEqual([n])
          expect(m.triples()).toContain(n)
          expect(m.pairs('dl-eth')).toEqual({ notes: 'Jasmine', rating: n })
        }
        // Shown, hidden (its case parked), shown again: it still follows.
        m.click('choose')
        m.click('rate')
        m.click('choose')
        expect(m.rating('eth')).toEqual(['6'])
        expect(m.pairs('dl-eth')).toEqual({ notes: 'Jasmine', rating: '6' })
        m.click('rate')
        m.click('rate')
        expect(m.pairs('dl-eth')).toEqual({ notes: 'Jasmine', rating: '8' })
      })
    }
})
