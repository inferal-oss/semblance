import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS, STY } from '../src/ns.ts'
import { toHTML, toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { implementationGaps } from './implementations.ts'

const root = 'urn:layout:record'
const example = `
<${root}> a c:ByteLayout ; c:label "Record header" ; c:byteExtent 9 ; c:byteAxisLabel "Relative offset" ;
  c:byteField [ c:byteIndex 2 ; c:label "Payload" ; c:byteOffset 5 ; c:byteLength 4 ],
              [ c:byteIndex 0 ; c:label "Tag" ; c:byteOffset 0 ; c:byteLength 2 ; c:byteEncoding "ASCII" ;
                c:byteEmphasis true ; c:byteMark [ c:byteOffset 1 ; c:byteLength 1 ],
                                                  [ c:byteOffset 1 ; c:byteLength 1 ] ],
              [ c:byteIndex 1 ; c:label "Length" ; c:byteOffset 2 ; c:byteLength 3 ] ;
  c:byteSpan [ c:firstByteIndex 0 ; c:lastByteIndex 1 ; c:label "Header" ],
             [ c:firstByteIndex 0 ; c:lastByteIndex 1 ; c:label "Header" ] .
`

describe('ByteLayout', () => {
  it('has SPARQL and function renderers', () => {
    expect(implementationGaps(['components/byte-layout.ttl'])).toEqual({ noFunction: [], noSparql: [] })
  })

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders and updates the same on ${kind} with either implementation`, () => {
      const store = loadStore(kind, `@prefix c: <${NS.c}> .\n` + example)
      const runtime = new Runtime(store)
      const projections = (['sparql', 'function'] as const).map(prefer => ({
        screen: runtime.project({ name: prefer, modality: MOD.Screen, layers: [STY.Layer], roots: [root], prefer }, e => { throw e }),
        text: runtime.project({ name: prefer + '-text', modality: MOD.Text, roots: [root], prefer }, e => { throw e }),
      }))
      const html = () => {
        const [sparql, fn] = projections.map(p => toHTML(p.screen.index, root))
        if (sparql !== fn) {
          let at = 0
          while (at < sparql!.length && sparql![at] === fn![at]) at++
          expect(sparql!.slice(at - 50, at + 200)).toBe(fn!.slice(at - 50, at + 200))
        }
        return sparql!
      }
      const diagram = html()
      expect(diagram).toContain('data-layout-appearance="ruler"')
      expect(diagram).toContain('width="156"')
      expect(diagram).toContain('class="used"')
      expect(diagram).toContain('class="bracket"')
      for (const p of projections) {
        expect(toText(p.text.index, root)).toBe('Record header\n@0 · Tag · ASCII · 2 B\n@2 · Length · 3 B\n@5 · Payload · 4 B')
      }
      const f = store.factory
      const layout = f.namedNode(root)
      const style = f.namedNode(NS.c + 'byteLayoutStyle')
      for (const variant of ['Record', 'Outline']) {
        runtime.apply({ remove: store.match(layout, style, null),
          add: [f.quad(layout, style, f.namedNode(NS.c + 'Byte' + variant))] })
        expect(html()).toContain(`data-layout-appearance="${variant.toLowerCase()}"`)
      }
      const field = store.match(layout, f.namedNode(NS.c + 'byteField'), null).find(q =>
        store.match(q.object, f.namedNode(NS.c + 'byteIndex'), f.literal('2', f.namedNode(NS.xsd + 'integer'))).length)!.object
      runtime.apply({ add: [], remove: [...store.match(layout, f.namedNode(NS.c + 'byteExtent'), null),
        ...store.match(field, f.namedNode(NS.c + 'byteLength'), null)] })
      expect(html()).toContain('class="variable"')
      expect(html()).toContain('class="continuation"')
      for (const p of projections) expect(toText(p.text.index, root)).toContain('@5 · Payload · …')
      runtime.dispose()
      store.dispose?.()
    })
  }
})
