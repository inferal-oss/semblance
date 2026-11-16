// Mounting series charts in both worlds (SPARQL rules preferred, or their function twins), on screen and as text.
import { parseHTML } from 'linkedom'
import { EventBus } from '../src/behaviour/events.ts'
import { expect } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, SEM, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'

export const EX = 'https://example.org/#'
export const PREFIXES = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix iv: <https://semblance.dev/ns/view#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <https://example.org/#> .
`
export const SALES = `
ex:s1 ex:month "Jan" ; ex:channel "Web" ; ex:amount 120.5 ; ex:at 1 .
ex:s2 ex:month "Jan" ; ex:channel "Store" ; ex:amount 80 ; ex:at 1 .
ex:s3 ex:month "Feb" ; ex:channel "Web" ; ex:amount 140 ; ex:at 2 .
ex:s4 ex:month "Feb" ; ex:channel "Store" ; ex:amount 60 ; ex:at 2 .
ex:s5 ex:month "Mar" ; ex:channel "Web" ; ex:amount 90 ; ex:at 3 .
ex:s6 ex:month "Mar" ; ex:channel "Store" ; ex:amount -20 ; ex:at 3 .
ex:s7 ex:month "Mar" ; ex:channel "Web" ; ex:amount 10 ; ex:at 3 .
ex:Sales a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?month ?channel ?amount WHERE { ?s <https://example.org/#month> ?month ; <https://example.org/#channel> ?channel ; <https://example.org/#at> ?at . OPTIONAL { ?s <https://example.org/#amount> ?amount } } ORDER BY ?at ?channel""" .
ex:Totals a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?month (SUM(?a) AS ?value) WHERE { ?s <https://example.org/#month> ?month ; <https://example.org/#amount> ?a } GROUP BY ?month""" .
ex:None a sem:View , iv:View ; iv:materialize iv:Graph ; sem:select """SELECT ?month ?value WHERE { ?s <https://example.org/#nothing> ?month ; <https://example.org/#amount> ?value }""" .
ex:Plain a sem:View ; rdfs:label "plain view" ; sem:select """SELECT ?month WHERE { ?s <https://example.org/#month> ?month }""" .
ex:web a c:series ; rdfs:label "Online"@en , "Онлайн"@uk ; c:key "Web" .
ex:store a c:series ; rdfs:label "Shop" ; c:key "Store" .
`

export function mount(turtle: string, kind: 'oxigraph' | 'wat', prefer: 'sparql' | 'function', roots: string[], languages: string[] = []) {
  const store = loadStore(kind, turtle)
  const runtime = new Runtime(store)
  const shown = roots.map((root) => {
    const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    const screen = runtime.project({ modality: MOD.Screen, layers: [STY.Layer, SEM.TooltipLayer], prefer, languages, name: root, roots: [EX + root] }, (e) => {
      throw e
    })
    const text = runtime.project({ modality: MOD.Text, layers: [], prefer, languages, name: root + '-text', roots: [EX + root] }, (e) => {
      throw e
    })
    const renderer = new DomRenderer(screen.index, document.getElementById('app')!, EX + root)
    renderer.flush()
    const bus = new EventBus(runtime, screen, { prefer })
    bus.attach(renderer, () => renderer.flush())
    const click = (el: Element) => el.dispatchEvent(new window.Event('click', { bubbles: true }))
    return { renderer, app: document.getElementById('app')!, screen, text, root, click }
  })
  const f = store.factory
  const lit = (o: string | number) => (typeof o === 'number' ? f.literal(String(o), f.namedNode('http://www.w3.org/2001/XMLSchema#decimal')) : f.literal(o))
  return {
    store,
    runtime,
    shown,
    html: () => shown.map(({ renderer, app }) => (renderer.flush(), app.innerHTML)),
    text: () => shown.map(({ text, root }) => toText(text.index, EX + root)),
    set: (s: string, p: string, o: string | number | undefined) =>
      runtime.apply({ remove: store.match(f.namedNode(EX + s), f.namedNode(EX + p), null), add: o === undefined ? [] : [f.quad(f.namedNode(EX + s), f.namedNode(EX + p), lit(o))] }),
  }
}

/** Mounts both worlds and checks, after each step, that SPARQL and the functions render the same. */
export function parity(turtle: string, kind: 'oxigraph' | 'wat', roots: string[], languages: string[] = []) {
  const [s, fn] = [mount(turtle, kind, 'sparql', roots, languages), mount(turtle, kind, 'function', roots, languages)]
  const both = (step: (h: typeof s) => void) => {
    step(s)
    step(fn)
    const [a, b] = [s.html(), fn.html()]
    roots.forEach((r, i) => expect(a[i], r).toBe(b[i]))
    expect(s.text()).toEqual(fn.text())
  }
  both(() => {})
  return { s, fn, both }
}

