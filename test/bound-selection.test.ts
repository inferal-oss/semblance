import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { A11Y, MOD, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'

// Whatever reads a selection through c:bindFrom / c:bindProperty: while the selection holds nothing,
// no pattern of its rule may run free over the graph and show every node that happens to match (#322).

const EX = 'https://example.org/bound#'
const bound = 'c:bindFrom ex:holder ; c:bindProperty ex:selected'
const readers: Record<string, string> = {
  fields: `a c:DescriptionList ; ${bound} ; c:fields ( ex:name ex:note ) ; c:emptyText "Nothing." `,
  fieldsVia: `a c:DescriptionList ; ${bound} ; c:via ex:hop ; c:fields ( ex:name ) ; c:emptyText "Nothing." `,
  entries: `a c:DescriptionList ; ${bound} ; c:entryProperty ex:entry ; c:keyProperty ex:key ; c:valueProperty ex:value ; c:emptyText "Nothing." `,
  entriesVia: `a c:DescriptionList ; ${bound} ; c:via ex:hop ; c:entryProperty ex:entry ; c:keyProperty ex:key ; c:valueProperty ex:value ; c:emptyText "Nothing." `,
  body: `a c:BodyViewer ; ${bound} ; c:payloadProperty ex:payload ; c:emptyText "Nothing." `,
  bodyVia: `a c:BodyViewer ; ${bound} ; c:via ex:hop ; c:payloadProperty ex:payload ; c:emptyText "Nothing." `,
  json: `a c:JsonTree ; ${bound} ; c:payloadProperty ex:payload ; c:emptyText "Nothing." `,
  hex: `a c:HexView ; ${bound} ; c:payloadProperty ex:payload ; c:emptyText "Nothing." `,
  image: `a c:ImageView ; ${bound} ; c:payloadProperty ex:payload ; c:emptyText "Nothing." `,
  overview: `a c:TermOverview ; ${bound} ; c:emptyText "Nothing." `,
  alignment: `a c:TermAlignment ; ${bound} ; c:emptyText "Nothing." `,
  query: `a c:QueryView ; c:bindVariable "x" ; ${bound} ; c:emptyText "Nothing." ; c:queries ( ex:query ) `,
}
const graph = `
@prefix c: <https://semblance.dev/ns/component#> .
@prefix beh: <https://semblance.dev/ns/behaviour#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix sem: <https://semblance.dev/ns/core#> .
@prefix ex: <${EX}> .
ex:name rdfs:label "name" . ex:note rdfs:label "note" .
ex:query rdfs:label "query" ; sem:construct "CONSTRUCT { ?s a c:Stack } WHERE { ?s a c:Stack } LIMIT 3" .
ex:other ex:name "Leaked" ; ex:note "Leaked" ; ex:hop ex:otherHop ; ex:entry ex:otherEntry ; ex:payload "Leaked" .
ex:otherHop ex:name "Leaked" ; ex:entry ex:otherEntry ; ex:payload "Leaked" .
ex:otherEntry ex:key "Leaked" ; ex:value "Leaked" .
ex:picked ex:name "Picked" ; ex:note "Noted" ; ex:hop ex:pickedHop ; ex:entry ex:pickedEntry .
ex:pickedHop ex:name "Hopped" .
ex:pickedEntry ex:key "Key" ; ex:value "Held" .
ex:page a c:Stack ; c:children ( ex:pick ex:clear ${Object.keys(readers).map((k) => 'ex:' + k).join(' ')} ) .
ex:pick a c:Button ; c:label "Pick" .
ex:clear a c:Button , c:Unsetter ; c:label "Clear" ; c:controls ex:holder ; c:property ex:selected .
ex:Pick a beh:Reaction ; beh:when beh:Click ; beh:source ex:pick ;
  beh:inserts """PREFIX ex: <${EX}> CONSTRUCT { ex:holder ex:selected ex:picked } WHERE { ex:picked ex:name ?any }""" .
${Object.entries(readers).map(([k, v]) => `ex:${k} ${v}.`).join('\n')}
`

function mount(kind: StoreKind, prefer: 'sparql' | 'function') {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const runtime = new Runtime(loadStore(kind, graph))
  const screen = runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer], prefer, name: 'screen', roots: [EX + 'page'] }, (e) => {
    throw e
  })
  const dom = new DomRenderer(screen.index, document.getElementById('app')!, EX + 'page')
  dom.flush()
  const bus = new EventBus(runtime, screen, { prefer })
  bus.attach(dom, () => dom.flush())
  const root = (id: string) => [...document.querySelectorAll('*')].find((e) => dom.keyOf(e) === `${EX}${id}/~root`) as HTMLElement
  const click = (id: string) => (root(id).dispatchEvent(new window.Event('click', { bubbles: true })), dom.flush())
  const html = () => Object.fromEntries(Object.keys(readers).map((k) => [k, root(k).outerHTML]))
  return { root, click, html }
}

describe('a view bound to a selection', () => {
  for (const kind of ['wat', 'oxigraph'] as StoreKind[]) {
    it(`shows nothing of other nodes while the selection holds nothing, by SPARQL as by function (${kind})`, () => {
      const [sparql, fn] = (['sparql', 'function'] as const).map((prefer) => mount(kind, prefer))
      const empty = sparql!.html()
      expect(empty).toEqual(fn!.html())
      for (const [reader, html] of Object.entries(empty)) expect(html, reader).not.toContain('Leaked')
      for (const reader of ['fields', 'fieldsVia', 'entries', 'entriesVia', 'overview']) expect(sparql!.root(reader).textContent, reader).toBe('Nothing.')
    }, 120_000)

    for (const prefer of ['sparql', 'function'] as const) {
      it(`follows a pick and a clear (${kind}, ${prefer})`, () => {
        const m = mount(kind, prefer)
        const empty = m.html()
        m.click('pick')
        expect(m.root('fields').textContent).toBe('namePickednoteNoted')
        expect(m.root('fieldsVia').textContent).toBe('nameHopped')
        expect(m.root('entries').textContent).toBe('KeyHeld')
        expect(m.root('entriesVia').textContent).toBe('Nothing.')
        m.click('clear')
        expect(m.html()).toEqual(empty)
      }, 120_000)
    }
  }
})
