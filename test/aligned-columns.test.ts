// Columns whose parts line up (pos:AlignedColumns): the children of an aligned container take
// their rows from it (pos:rows pos:RowSubgrid) and span as many as they have parts (pos:rowSpan,
// from their c:children or their class's pos:rowParts). Both derivations have a SPARQL rule and a
// function twin that render the same HTML, also after the graph changes.
import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { A11Y, MOD, NS, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'

const UI = 'https://semblance.dev/demo#'
const layoutPage = readFileSync(new URL('../demo/gallery/layout.ttl', import.meta.url), 'utf8')

const board = `
@prefix c: <https://semblance.dev/ns/component#> .
@prefix pos: <https://semblance.dev/ns/position#> .
@prefix ui: <https://semblance.dev/demo#> .
ui:root a c:Stack ; pos:direction pos:Column ; c:children ( ui:cols ui:free ) .
ui:cols a c:Stack ; pos:layout pos:AlignedColumns ; c:children ( ui:a ui:b ui:card ui:bare ) .
ui:a a c:Stack ; pos:direction pos:Column ; c:children ( ui:a1 ui:a2 ) .
ui:a1 a c:Heading ; c:level 3 ; c:label "A heading that wraps onto a second line" .
ui:a2 a c:Text ; c:label "Body" .
ui:b a c:Stack ; pos:direction pos:Column ; c:children ( ui:b1 ui:b2 ui:b3 ) .
ui:b1 a c:Heading ; c:level 3 ; c:label "B" .
ui:b2 a c:Text ; c:label "Body" .
ui:b3 a c:Text ; c:label "Footer" .
ui:card a c:Card ; c:label "Card" ; c:content ui:cardText .
ui:cardText a c:Text ; c:label "In a card" .
ui:bare a c:Stack .
# Not in aligned columns, but taking rows by saying so.
ui:free a c:Stack ; pos:rows pos:RowSubgrid ; c:children ( ui:f1 ui:f2 ui:f3 ui:f4 ) .
ui:f1 a c:Text ; c:label "1" . ui:f2 a c:Text ; c:label "2" . ui:f3 a c:Text ; c:label "3" . ui:f4 a c:Text ; c:label "4" .
`

function project(prefer: 'sparql' | 'function', data: string, root: string) {
  const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const store = loadStore('wat', data)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer], name: 'screen', prefer, roots: [root] }, (e) => {
    throw e
  })
  const app = document.getElementById('app')!
  const dom = new DomRenderer(screen.index, app, root)
  dom.flush()
  const el = (id: string) => [...document.querySelectorAll('*')].find((e) => dom.keyOf(e) === `${UI}${id}/~root`) as HTMLElement
  const hooks = (id: string) => [el(id).getAttribute('data-sem-rows'), el(id).getAttribute('data-sem-row-span')]
  return { store, runtime, dom, app, el, hooks }
}

describe('columns whose parts line up', () => {
  const css = compileStyles(loadStore('n3'))

  it('compiles a span to a subgrid on the container rows, and the container to a grid of columns', () => {
    for (const n of [1, 2, 3, 8]) {
      const rule = css.match(new RegExp(`\\[data-sem-row-span="${n}"\\]\\s*\\{([^}]*)\\}`))
      expect(rule, String(n)).not.toBeNull()
      expect(rule![1]).toMatch(/display:\s*grid/)
      expect(rule![1]).toMatch(/grid-template-rows:\s*subgrid/)
      expect(rule![1]).toMatch(new RegExp(`grid-row:\\s*span ${n}`))
    }
    const layout = css.match(/\[data-sem-layout="aligned-columns"\]\s*\{([^}]*)\}/)![1]!
    expect(layout).toMatch(/display:\s*grid/)
    expect(layout).toMatch(/grid-template-columns:\s*repeat\(auto-fit/)
    // pos:RowSubgrid alone lays nothing out: without a span a column is never crammed into one row.
    expect(css).not.toMatch(/\[data-sem-rows="subgrid"\]\s*\{/)
    // The span comes after a column's own direction in the hooks layer, so its display wins.
    const hooks = css.slice(css.indexOf('@layer sem.hooks {'))
    expect(hooks.indexOf('[data-sem-row-span="2"]')).toBeGreaterThan(hooks.indexOf('[data-sem-direction="column"]'))
  })

  it('components that lay out their own parts defer to the span', () => {
    expect(css).toMatch(/\[data-sem-c="?card"?\]:not\(\[data-sem-row-span\]\)\s*\{[^}]*grid-template-rows:\s*auto 1fr/)
    expect(css).not.toMatch(/\[data-sem-c="?card"?\]\s*\{[^}]*grid-template-rows/)
    expect(css).toMatch(/\[data-sem-c="?surface"?\]:not\(\[data-sem-direction\]\):not\(\[data-sem-layout\]\):not\(\[data-sem-row-span\]\)\s*\{[^}]*display:\s*flex/)
    expect(css).toMatch(/\[data-sem-c="?term-card"?\]:not\(\[data-sem-row-span\]\)\s*\{[^}]*display:\s*flex/)
    // A board's lanes share its rows: header row, cards row.
    const lane = css.match(/\[data-sem-c="?board"?\] > \.sem-lane\s*\{([^}]*)\}/)![1]!
    expect(lane).toMatch(/grid-row:\s*span 2/)
    expect(lane).toMatch(/grid-template-rows:\s*subgrid/)
    // Guides outline the parts of columns.
    expect(css).toMatch(/\[data-sem-guides="cells"\] :is\(\[data-sem-rows=subgrid\], \[data-sem-c=grid\] > \[data-sem-direction=column\]\) > \*[^{]*\{[^}]*outline:\s*1px dashed/)
  })

  it('derives the span from the parts, alike under SPARQL and functions', () => {
    const html: string[] = []
    for (const prefer of ['sparql', 'function'] as const) {
      const { hooks, app } = project(prefer, board, UI + 'root')
      expect(hooks('a'), prefer).toEqual(['subgrid', '2'])
      expect(hooks('b'), prefer).toEqual(['subgrid', '3'])
      expect(hooks('card'), prefer).toEqual(['subgrid', '2']) // c:Card pos:rowParts 2: header, body
      expect(hooks('bare'), prefer).toEqual(['subgrid', null]) // no parts: no span, nothing laid out
      expect(hooks('free'), prefer).toEqual(['subgrid', '4'])
      expect(hooks('cols'), prefer).toEqual([null, null])
      html.push(app.innerHTML)
    }
    expect(html[1]).toBe(html[0])
  })

  it('follows changes to the parts and to the layout, alike under SPARQL and functions', () => {
    const html: string[][] = [[], []]
    for (const [i, prefer] of (['sparql', 'function'] as const).entries()) {
      const { store, runtime, dom, app, hooks } = project(prefer, board, UI + 'root')
      const f = store.factory
      const nn = (s: string) => f.namedNode(s)
      // A third part for column a: its list is replaced, as an app writes a list.
      const old = store.match(nn(UI + 'a'), nn(NS.c + 'children'), null, f.defaultGraph())
      const cells = [UI + 'a-l1', UI + 'a-l2', UI + 'a-l3'].map(nn)
      const items = [UI + 'a1', UI + 'a2', UI + 'b3'].map(nn)
      const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
      const add = [f.quad(nn(UI + 'a'), nn(NS.c + 'children'), cells[0]!)]
      cells.forEach((c, k) => {
        add.push(f.quad(c, nn(RDF + 'first'), items[k]!), f.quad(c, nn(RDF + 'rest'), k + 1 < cells.length ? cells[k + 1]! : nn(RDF + 'nil')))
      })
      runtime.apply({ add, remove: old })
      dom.flush()
      expect(hooks('a'), prefer).toEqual(['subgrid', '3'])
      html[i]!.push(app.innerHTML)
      // The container stops aligning its columns: they stack their own parts again.
      runtime.apply({ add: [], remove: store.match(nn(UI + 'cols'), nn(NS.pos + 'layout'), null, f.defaultGraph()) })
      dom.flush()
      expect(hooks('a'), prefer).toEqual([null, null])
      expect(hooks('card'), prefer).toEqual([null, null])
      expect(hooks('free'), prefer).toEqual(['subgrid', '4'])
      html[i]!.push(app.innerHTML)
    }
    expect(html[1]).toEqual(html[0])
  })

  it('the Layout page shows the same plans with and without aligned columns', () => {
    const html: string[] = []
    for (const prefer of ['sparql', 'function'] as const) {
      const { hooks, el, app } = project(prefer, layoutPage, UI + 'gallery-layout')
      for (const plan of ['starter', 'team', 'studio']) {
        expect(hooks(`lycg-${plan}`), prefer).toEqual(['subgrid', '3'])
        expect(hooks(`lycf-${plan}`), prefer).toEqual([null, null])
      }
      expect(el('lycg-grid').getAttribute('data-sem-layout')).toBe('aligned-columns')
      html.push(app.innerHTML)
    }
    expect(html[1]).toBe(html[0])
  })
})
