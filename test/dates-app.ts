// A small app of date and time fields for test/dates.test.ts (and a look at their HTML).
import { parseHTML } from 'linkedom'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { A11Y, ANN, KEY, MOD, NS, SEM, ST, STY, VAL } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'

export const EX = 'https://example.org/trip#'
const LAYERS = [A11Y.Layer, STY.Layer, SEM.TooltipLayer, VAL.Layer, VAL.ShapesLayer, KEY.Layer, ST.Layer, ANN.Layer]

export const DATES_APP = `
@prefix c: <https://semblance.dev/ns/component#> .
@prefix val: <https://semblance.dev/ns/validation#> .
@prefix l10n: <https://semblance.dev/ns/l10n#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <${EX}> .

ex:page a c:Stack ; c:children ( ex:departs ex:trip ex:grid ex:start ) .
ex:trip1 ex:departure "2026-10-24"^^xsd:date ; ex:from "2026-10-20"^^xsd:date ; ex:until "2026-10-23"^^xsd:date ;
    ex:pickup "09:30:00"^^xsd:time .
ex:departure rdfs:label "Departure" ; rdfs:range xsd:date .
ex:from rdfs:label "From" ; rdfs:range xsd:date .
ex:until rdfs:label "Until" ; rdfs:range xsd:date .
ex:pickup rdfs:label "Pickup" ; rdfs:range xsd:time .
ex:inOctober a sh:PropertyShape ; sh:path ex:departure ; sh:datatype xsd:date ;
    sh:minInclusive "2026-10-05"^^xsd:date ; sh:maxInclusive "2026-11-20"^^xsd:date ; sh:message "Between 5 October and 20 November." .
ex:inOrder a sh:PropertyShape ; sh:path ex:from ; sh:lessThanOrEquals ex:until ; sh:message "The trip ends before it starts." .
ex:officeHours a sh:PropertyShape ; sh:path ex:pickup ; sh:datatype xsd:time ;
    sh:minInclusive "08:00:00"^^xsd:time ; sh:maxInclusive "18:00:00"^^xsd:time ; sh:message "Between 8:00 and 18:00." .

ex:departs a c:DateField ; c:label "Departure" ; c:controls ex:trip1 ; c:property ex:departure ; val:validates ex:inOctober ;
    c:today "2026-10-21"^^xsd:date ; c:help "The day you leave." .
ex:trip a c:DateRangeField ; c:label "Trip" ; c:controls ex:trip1 ; c:property ex:from ; c:endProperty ex:until ;
    val:validates ex:inOrder ; c:today "2026-10-21"^^xsd:date .
ex:grid a c:MonthGrid ; c:label "Calendar" ; c:controls ex:trip1 ; c:property ex:departure ; c:today "2026-10-21"^^xsd:date .
ex:start a c:TimeField ; c:label "Pickup" ; c:controls ex:trip1 ; c:property ex:pickup ; val:validates ex:officeHours ; c:minuteStep 60 .
`

export function mountDates(kind: StoreKind = 'wat', prefer: 'sparql' | 'function' = 'sparql', languages: string[] = [], app = DATES_APP) {
  const store = loadStore(kind, app)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: LAYERS, prefer, languages, name: 'screen', roots: [EX + 'page'] }, (e) => {
    throw e
  })
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const renderer = new DomRenderer(screen.index, document.getElementById('app')!, EX + 'page')
  renderer.flush()
  const bus = new EventBus(runtime, screen, { prefer })
  bus.attach(renderer, () => renderer.flush())
  const f = store.factory
  const root = (id: string) => renderer.nodeOf(`${EX}${id}/~root`) as HTMLElement
  const fire = (el: Element, type: string) => (el.dispatchEvent(new window.Event(type, { bubbles: true })), renderer.flush())
  const press = (el: Element, key: string, shift = false) => {
    const e = new window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: shift })
    el.dispatchEvent(e)
    renderer.flush()
    return e.defaultPrevented
  }
  const type = (el: HTMLInputElement, text: string) => {
    el.value = text
    fire(el, 'input')
  }
  const commit = (el: HTMLInputElement, text: string) => {
    type(el, text)
    fire(el, 'change')
  }
  const values = (p: string) => store.match(f.namedNode(EX + 'trip1'), f.namedNode(EX + p), null).map((q) => q.object.value)
  const state = (s: string, p: string) => store.match(f.namedNode(s.startsWith('http') ? s : EX + s), f.namedNode(NS.c + p), null).map((q) => q.object.value)
  return { store, runtime, screen, renderer, document, window, root, fire, press, type, commit, values, state }
}
