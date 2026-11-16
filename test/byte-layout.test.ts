// c:ByteLayout (ontology/components/byte-layout.ttl): its SPARQL rules and their function twins draw
// the same diagram and write the same text on Oxigraph and on Semblance's own engine, after every step
// of an interaction (the style switch clicked, fields edited, added and taken away); a change to one
// field re-renders that field alone; its shapes accept the example and reject what it cannot draw.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { A11Y, MOD, NS, STY, VAL } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { implementationGaps } from './implementations.ts'

const EX = 'https://example.org/bytes#'
const SH = 'http://www.w3.org/ns/shacl#'

const graph = (layouts = '') => `
@prefix c: <${NS.c}> .
@prefix ex: <${EX}> .
ex:page a c:Stack ; c:children ( ex:style ex:record ex:chunk ) .
ex:style a c:Segmented ; c:controls ex:record ; c:property c:byteLayoutStyle ; c:label "Layout style" .
ex:record a c:ByteLayout ; c:label "Record header" ; c:byteExtent 9 ; c:byteAxisLabel "Relative offset" ;
  c:byteField ex:payload , ex:tag , ex:length ; c:byteSpan ex:header , ex:body .
ex:tag c:byteIndex 0 ; c:label "Tag" ; c:byteOffset 0 ; c:byteLength 2 ; c:byteEncoding "ASCII" ; c:byteEmphasis true ;
  c:byteMark [ c:byteOffset 1 ; c:byteLength 1 ] , [ c:byteOffset 1 ; c:byteLength 1 ] .
ex:length c:byteIndex 1 ; c:label "Length" ; c:byteOffset 2 ; c:byteLength 3 .
ex:payload c:byteIndex 2 ; c:label "Payload" ; c:byteOffset 5 ; c:byteLength 4 .
ex:header c:firstByteIndex 0 ; c:lastByteIndex 1 ; c:label "Header" .
ex:body c:firstByteIndex 2 ; c:lastByteIndex 2 ; c:label "Body" .
ex:chunk a c:ByteLayout ; c:label "Chunk" ; c:byteField ex:ck-id , ex:ck-size , ex:ck-data .
ex:ck-id c:byteIndex 0 ; c:label "ckID" ; c:byteLength 4 ; c:byteEncoding "FourCC" .
ex:ck-size c:byteIndex 1 ; c:label "ckSize" ; c:byteLength 4 .
ex:ck-data c:byteIndex 2 ; c:label "ckData" ; c:byteSizeLabel "ckSize bytes" .
${layouts}`

function mount(kind: StoreKind, prefer: 'sparql' | 'function', languages: string[] = [], source = graph()) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const store = loadStore(kind, source)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer], prefer, languages, name: 'screen', roots: [EX + 'page'] }, (e) => {
    throw e
  })
  const text = runtime.project({ modality: MOD.Text, layers: [], prefer, languages, name: 'text', roots: [EX + 'record', EX + 'chunk'] }, (e) => {
    throw e
  })
  const dom = new DomRenderer(screen.index, document.getElementById('app')!, EX + 'page')
  dom.flush()
  const bus = new EventBus(runtime, screen, { prefer })
  bus.attach(dom, () => dom.flush())
  const root = (id: string) => [...document.querySelectorAll('*')].find((e) => dom.keyOf(e) === `${EX}${id}/~root`) as HTMLElement
  const click = (el: Element) => (el.dispatchEvent(new window.Event('click', { bubbles: true })), dom.flush())
  const option = (name: string) => [...root('style').querySelectorAll('button')].find((b) => b.textContent?.includes(name))!
  const seen = () => ({
    record: root('record').outerHTML,
    chunk: root('chunk').outerHTML,
    recordText: toText(text.index, EX + 'record'),
    chunkText: toText(text.index, EX + 'chunk'),
  })
  const f = store.factory
  const n = (local: string) => f.namedNode(EX + local)
  const c = (local: string) => f.namedNode(NS.c + local)
  const int = (v: number) => f.literal(String(v), f.namedNode(NS.xsd + 'integer'))
  const set = (s: string, p: string, o: ReturnType<typeof int> | ReturnType<typeof n> | undefined) => {
    runtime.apply({ remove: store.match(n(s), c(p), null), add: o ? [f.quad(n(s), c(p), o)] : [] })
    dom.flush()
  }
  const add = (triples: [string, string, ReturnType<typeof int> | ReturnType<typeof n> | ReturnType<typeof f.literal>][]) => {
    runtime.apply({ remove: [], add: triples.map(([s, p, o]) => f.quad(n(s), c(p), o)) })
    dom.flush()
  }
  return { store, runtime, screen, root, click, option, seen, set, add, f, n, c, int, dispose: () => (runtime.dispose(), store.dispose?.()) }
}

describe('ByteLayout', () => {
  it('has SPARQL and function renderers', () => {
    expect(implementationGaps(['components/byte-layout.ttl'])).toEqual({ noFunction: [], noSparql: [] })
  })

  for (const kind of ['wat', 'oxigraph'] as const) {
    it(`draws and writes the same by SPARQL as by function, step by step (${kind})`, () => {
      const [sparql, fn] = (['sparql', 'function'] as const).map((prefer) => mount(kind, prefer))
      const both = (step: (m: ReturnType<typeof mount>) => void) => {
        step(sparql!)
        step(fn!)
        const seen = sparql!.seen()
        expect(seen).toEqual(fn!.seen())
        return seen
      }
      const first = both(() => {})
      expect(first.record).toContain('data-layout-appearance="ruler"')
      expect(first.record).toContain('role="figure"')
      expect(first.record).toContain('aria-label="Record header"')
      expect(first.record).toContain('role="list"')
      expect(first.record).toContain('aria-label="@0 · Tag · ASCII · 2 B"')
      expect(first.record).toContain('width="156"')
      expect(first.record).toContain('class="used"')
      expect(first.record.match(/class="used"/g)).toHaveLength(1)
      expect(first.record.match(/class="bracket"/g)).toHaveLength(2)
      expect(first.record).toContain('viewBox="0 0 740 122"')
      // Fields in their index's order, though stated in another.
      expect([...first.record.matchAll(/class="label"[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(['Tag', 'Length', 'Payload'])
      expect(first.recordText).toBe('Record header\n@0 · Tag · ASCII · 2 B\n@2 · Length · 3 B\n@5 · Payload · 4 B')
      expect(first.chunkText).toBe('Chunk\nckID · FourCC · 4 B\nckSize · 4 B\nckData · ckSize bytes')
      expect(first.chunk).toContain('class="continuation"')
      expect(first.chunk).toContain('viewBox="0 0 740 90"')
      expect(first.chunk).not.toContain('class="bracket"')

      // The switch, clicked: the style is graph state on the diagram.
      for (const [name, appearance] of [['Record', 'record'], ['Outline', 'outline'], ['Ruler', 'ruler']] as const) {
        const seen = both((m) => m.click(m.option(name)))
        expect(seen.record).toContain(`data-layout-appearance="${appearance}"`)
        expect(sparql!.option(name).getAttribute('aria-pressed')).toBe('true')
      }
      // A field's label, its place, a mark, a bracket, a field added, the scale taken away.
      expect(both((m) => m.set('length', 'label', m.f.literal('Size'))).recordText).toContain('@2 · Size · 3 B')
      expect(both((m) => (m.set('length', 'byteLength', m.int(2)), m.set('payload', 'byteOffset', m.int(4)), m.set('payload', 'byteLength', m.int(5)))).recordText).toContain('@4 · Payload · 5 B')
      expect(both((m) => m.add([['payload', 'byteMark', m.n('payload-crc')], ['payload-crc', 'byteOffset', m.int(7)], ['payload-crc', 'byteLength', m.int(2)]])).record.match(/class="used"/g)).toHaveLength(2)
      expect(both((m) => m.set('header', 'lastByteIndex', m.int(2))).record.match(/class="bracket"/g)).toHaveLength(2)
      expect(both((m) => m.add([['chunk', 'byteField', m.n('ck-pad')], ['ck-pad', 'byteIndex', m.int(3)], ['ck-pad', 'label', m.f.literal('pad')], ['ck-pad', 'byteLength', m.int(1)]])).chunkText).toBe(
        'Chunk\nckID · FourCC · 4 B\nckSize · 4 B\nckData · ckSize bytes\npad · 1 B',
      )
      expect(sparql!.seen().chunk).toContain('viewBox="0 0 740 90"')
      const schematic = both((m) => (m.set('record', 'byteExtent', undefined), m.set('payload', 'byteLength', undefined)))
      expect(schematic.record).toContain('class="variable"')
      expect(schematic.recordText).toContain('@4 · Payload · …')
      const unbracketed = both((m) => (m.runtime.apply({ remove: m.store.match(m.n('record'), m.c('byteSpan'), null), add: [] }), m.set('record', 'label', m.f.literal('Header'))))
      expect(unbracketed.record).not.toContain('class="bracket"')
      expect(unbracketed.record).toContain('viewBox="0 0 740 90"')
      sparql!.dispose()
      fn!.dispose()
    }, 120_000)
  }

  it('says its unit in the viewer’s language', () => {
    for (const prefer of ['sparql', 'function'] as const) {
      const m = mount('wat', prefer, ['uk'])
      expect(m.seen().recordText).toContain('@0 · Tag · ASCII · 2 Б')
      expect(m.root('record').outerHTML).toContain('ASCII · 2 Б')
      m.dispose()
    }
  })

  // Twelve fields, as many brackets as there are fields: a change to one field's label re-renders
  // that field, not the frame, its other fields or the brackets; one to its offset adds the brackets
  // (which read the offsets of their ends), not the other fields.
  for (const prefer of ['sparql', 'function'] as const) {
    it(`re-renders a changed field alone (wat, ${prefer})`, () => {
      const wide = Array.from({ length: 12 }, (_, i) => `ex:w${i} c:byteIndex ${i} ; c:label "F${i}" ; c:byteOffset ${i * 2} ; c:byteLength 2 .
ex:ws${i} c:firstByteIndex ${i} ; c:lastByteIndex ${i} ; c:label "S${i}" .`).join('\n')
      const fields = Array.from({ length: 12 }, (_, i) => `ex:w${i}`).join(' , ')
      const spans = Array.from({ length: 12 }, (_, i) => `ex:ws${i}`).join(' , ')
      const m = mount('wat', prefer, [], graph(`ex:wide a c:ByteLayout ; c:label "Wide" ; c:byteExtent 24 ; c:byteField ${fields} ; c:byteSpan ${spans} .\nex:page2 a c:Stack ; c:children ( ex:wide ) .\n${wide}`))
      const page = m.runtime.project({ modality: MOD.Screen, layers: [STY.Layer], prefer, name: 'wide', roots: [EX + 'wide'] }, (e) => {
        throw e
      })
      const ran = (change: () => void) => {
        const before = new Map([...page.engine.stats.byRule].map(([k, v]) => [k, v.runs]))
        change()
        return Object.fromEntries(
          [...page.engine.stats.byRule]
            .filter(([k, v]) => /ByteLayout|ByteCell/.test(k) && v.runs > (before.get(k) ?? 0))
            .map(([k, v]) => [k.replace(/^.*[#/]/, ''), v.runs - (before.get(k) ?? 0)]),
        )
      }
      const cell = prefer === 'sparql' ? 'ByteCellScreen' : 'ByteCellFunction'
      const spansRule = prefer === 'sparql' ? 'ByteLayoutSpans-sparql' : 'ByteLayoutSpans-fn'
      expect(ran(() => m.set('w5', 'label', m.f.literal('Renamed')))).toEqual({ [cell]: 1 })
      const moved = ran(() => m.set('w5', 'byteLength', m.int(1)))
      expect(moved[cell]).toBe(1)
      expect(Object.keys(moved).sort()).toEqual([cell, spansRule].sort())
      expect(moved[spansRule]).toBeLessThanOrEqual(12)
      expect(ran(() => m.set('wide', 'byteLayoutStyle', m.c('ByteOutline')))).toEqual({ [prefer === 'sparql' ? 'ByteLayoutScreen' : 'ByteLayoutFunction']: 1 })
      m.dispose()
    }, 120_000)
  }

  it('accepts the example and rejects what it cannot draw', () => {
    const results = (source: string, root = 'page') => {
      const store = loadStore('wat', source)
      const runtime = new Runtime(store)
      runtime.project({ modality: MOD.Screen, layers: [VAL.ShapesLayer], name: 'screen', roots: [EX + root] }, (e) => {
        throw e
      })
      const f = store.factory
      const found = store
        .match(null, f.namedNode(SH + 'focusNode'), null)
        .map((q) => [q.object.value, ...store.match(q.subject, f.namedNode(SH + 'resultPath'), null).map((r) => r.object.value)].join(' '))
      runtime.dispose()
      return found.filter((r) => r.startsWith(EX)).sort()
    }
    expect(results(graph())).toEqual([])
    // What the shapes layer checks on the component: its caption, its scale, and that its fields and
    // brackets are IRIs (each is drawn member-wise). The nested shapes of a field and a bracket
    // (c:ByteFieldShape, c:ByteSpanShape) are for a SHACL validator: the layer does not read sh:node.
    const bad = results(
      graph(`ex:bad a c:ByteLayout ; c:byteExtent 0 ; c:byteField [ c:byteIndex 0 ; c:label "Blank" ] ; c:byteSpan [ c:firstByteIndex 0 ; c:lastByteIndex 0 ; c:label "Blank" ] .`),
      'bad',
    )
    expect(bad).toEqual([`${EX}bad ${NS.c}byteExtent`, `${EX}bad ${NS.c}byteField`, `${EX}bad ${NS.c}byteSpan`, `${EX}bad ${NS.c}label`])
  })
})
