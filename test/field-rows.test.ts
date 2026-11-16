// Fields side by side (pos:FieldRow, issue #57), and fields in a row of a list (pos:Subgrid, #518). A row that aligned its children's ends put a choice
// beside its neighbour's help line: the end of a field with help is the help. In a field row each
// field takes the row's tracks - label, control, help, error - so the controls share a line whatever
// is under them; anything else (a button) sits in the control line. A c:Choice is a field like the
// others (its caption over the select), and inline only where it is a setting in a bar. A row of a
// list that shares its container's columns (pos:Subgrid) does the same for a field in it: a tag beside
// an amount is centred on the input, not on the label and input together (#518). A field's parts go
// in their tracks by role (data-sem-part), so a field without a label keeps its control in the
// control track.
//
// Layout itself needs a browser; this checks what decides it: the derivations (both
// implementations, also as the graph changes), the anatomy every field shares (label first, control
// second, so part N lands in track N), and the compiled rules.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { A11Y, LC, MOD, NS, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'

const UI = 'https://semblance.dev/demo#'

const page = `
@prefix c: <https://semblance.dev/ns/component#> .
@prefix pos: <https://semblance.dev/ns/position#> .
@prefix tok: <https://semblance.dev/ns/token#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix ui: <https://semblance.dev/demo#> .
ui:Code a owl:Class . ui:c1 a ui:Code ; rdfs:label "+1" . ui:c44 a ui:Code ; rdfs:label "+44" .
ui:code a rdf:Property ; rdfs:range ui:Code .
ui:draft ui:code ui:c44 .
ui:root a c:Stack ; pos:direction pos:Column ; c:children ( ui:row ui:bar ui:form ui:sheet ui:bare ) .
ui:row a c:Stack ; pos:layout pos:FieldRow ; pos:gap tok:space-3 ; c:children ( ui:dial ui:phone ui:city ui:go ui:nested ) .
ui:dial a c:Choice ; c:label "Code" ; c:controls ui:draft ; c:property ui:code .
ui:phone a c:TextField ; c:label "Phone" ; c:help "For the courier." .
ui:city a c:TextField ; c:label "City" .
ui:go a c:Button ; c:label "Save" .
ui:nested a c:Stack ; pos:direction pos:Row ; c:children ( ui:n1 ) .
ui:n1 a c:Button ; c:label "More" .
ui:bar a c:Toolbar ; c:label "Filters" ; c:children ( ui:barChoice ) .
ui:barChoice a c:Choice ; c:label "Kind" ; c:controls ui:draft ; c:property ui:code .
ui:form a c:Stack ; pos:direction pos:Column ; c:children ( ui:formChoice ) .
ui:formChoice a c:Choice ; c:label "Code" ; c:controls ui:draft ; c:property ui:code .
ui:sheet a c:Stack ; c:children ( ui:sheetRow ui:plainRow ) .
ui:sheetRow a c:Stack ; pos:layout pos:Subgrid ; c:children ( ui:rent ui:housing ) .
ui:rent a c:TextField ; c:label "Rent" ; c:inputType "number" .
ui:housing a c:Tag ; c:label "Housing" .
ui:plainRow a c:Stack ; pos:layout pos:Subgrid ; c:children ( ui:what ui:price ) .
ui:what a c:Text ; c:label "Kettle" .
ui:price a c:Text ; c:label "34" .
ui:bare a c:Stack ; pos:layout pos:FieldRow ; c:children ( ui:unlabelled ui:notes ui:wrapped ui:bareGo ) .
ui:unlabelled a c:TextField ; c:placeholder "Search" .
ui:notes a c:TextArea ; c:label "Notes" .
ui:wrapped a c:Field ; c:label "Plan" ; c:content ui:wrappedInput .
ui:wrappedInput a c:TextField .
ui:bareGo a c:Button ; c:label "Go" .
`

function project(prefer: 'sparql' | 'function') {
  const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const store = loadStore('wat', page)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer, LC.Layer], name: 'screen', prefer, roots: [UI + 'root'] }, (e) => {
    throw e
  })
  const app = document.getElementById('app')!
  const dom = new DomRenderer(screen.index, app, UI + 'root')
  dom.flush()
  const el = (id: string) => [...document.querySelectorAll('*')].find((e) => dom.keyOf(e) === `${UI}${id}/~root`) as HTMLElement
  const hooks = (id: string) => [el(id).getAttribute('data-sem-rows'), el(id).getAttribute('data-sem-row-span')]
  return { store, runtime, dom, app, el, hooks }
}

/** A field's parts as they are placed in the row's tracks: popups (out of the flow) take none. */
const parts = (field: Element) => [...field.children].filter((p) => !p.matches('[role=dialog], [role=listbox]'))

describe('fields side by side', () => {
  it('the fields of a field row take its rows, a button and a stack do not; alike under SPARQL and functions', () => {
    const html: string[] = []
    for (const prefer of ['sparql', 'function'] as const) {
      const { hooks, el, app } = project(prefer)
      expect(hooks('dial'), prefer).toEqual(['subgrid', '2']) // caption, select
      expect(hooks('phone'), prefer).toEqual(['subgrid', '4']) // label, input, help, error
      expect(hooks('city'), prefer).toEqual(['subgrid', '4'])
      expect(hooks('go'), prefer).toEqual([null, null]) // not a field: the control line, by the theme
      expect(hooks('nested'), prefer).toEqual([null, null]) // a stack's children are not a field's parts
      expect(el('row').getAttribute('data-sem-layout')).toBe('field-row')
      html.push(app.innerHTML)
    }
    expect(html[1]).toBe(html[0])
  })

  it('a field in a row of a list takes the row\'s tracks, the cells beside it do not; alike under SPARQL and functions', () => {
    const html: string[] = []
    for (const prefer of ['sparql', 'function'] as const) {
      const { hooks, el, app } = project(prefer)
      expect(hooks('rent'), prefer).toEqual(['subgrid', '4']) // label, input, help, error
      expect(hooks('housing'), prefer).toEqual([null, null]) // the control track, by the theme
      // a row without a field is as it was: its cells take no rows
      expect(hooks('what'), prefer).toEqual([null, null])
      expect(hooks('price'), prefer).toEqual([null, null])
      expect(el('sheetRow').getAttribute('data-sem-layout')).toBe('subgrid')
      html.push(app.innerHTML)
    }
    expect(html[1]).toBe(html[0])
  })

  it('every field with parts names its label, so a part goes in its track by role; alike under SPARQL and functions', () => {
    const html: string[] = []
    for (const prefer of ['sparql', 'function'] as const) {
      const { el, app, hooks } = project(prefer)
      const label = (id: string) => [...el(id).children].filter((p) => p.getAttribute('data-sem-part') === 'field-label').map((p) => p.textContent)
      expect(label('rent'), prefer).toEqual(['Rent'])
      expect(label('notes'), prefer).toEqual(['Notes'])
      expect(label('wrapped'), prefer).toEqual(['Plan'])
      expect(label('dial'), prefer).toEqual(['Code'])
      // without a label the control comes first in the DOM; the theme leaves the label track empty
      expect(label('unlabelled'), prefer).toEqual([])
      expect(el('unlabelled').firstElementChild?.getAttribute('data-sem-part'), prefer).toBe('single-line-control')
      expect([hooks('unlabelled'), hooks('notes'), hooks('wrapped'), hooks('bareGo')], prefer).toEqual([['subgrid', '4'], ['subgrid', '4'], ['subgrid', '4'], [null, null]])
      html.push(app.innerHTML)
    }
    expect(html[1]).toBe(html[0])
  })

  it('a choice is a field, inline only in a bar; alike under SPARQL and functions', () => {
    const html: string[] = []
    for (const prefer of ['sparql', 'function'] as const) {
      const { el, app } = project(prefer)
      expect(el('barChoice').getAttribute('data-sem-label-placement'), prefer).toBe('inline')
      expect(el('formChoice').hasAttribute('data-sem-label-placement'), prefer).toBe(false)
      expect(el('dial').hasAttribute('data-sem-label-placement'), prefer).toBe(false)
      html.push(app.innerHTML)
    }
    expect(html[1]).toBe(html[0])
  })

  it('every field has one anatomy: its label first, its control second, help and error after', () => {
    const { el } = project('sparql')
    const [dial, phone] = [el('dial'), el('phone')]
    expect(parts(dial).map((p) => p.localName)).toEqual(['span', 'select'])
    expect(parts(phone).map((p) => p.localName)).toEqual(['label', 'input', 'div'])
  })

  it('follows the graph: an error under one field, a row that stops being one; alike under SPARQL and functions', () => {
    const html: string[][] = [[], []]
    for (const [i, prefer] of (['sparql', 'function'] as const).entries()) {
      const { store, runtime, dom, app, el, hooks } = project(prefer)
      const f = store.factory
      const nn = (s: string) => f.namedNode(s)
      runtime.apply({ add: [f.quad(nn(UI + 'city'), nn(NS.c + 'error'), f.literal('Enter a city.'))], remove: [] })
      dom.flush()
      // the error is the city's third part; its control is still second, in the control track
      expect(parts(el('city')).map((p) => p.localName), prefer).toEqual(['label', 'input', 'div'])
      expect(hooks('city'), prefer).toEqual(['subgrid', '4'])
      html[i]!.push(app.innerHTML)
      runtime.apply({ add: [], remove: store.match(nn(UI + 'row'), nn(NS.pos + 'layout'), null, f.defaultGraph()) })
      dom.flush()
      expect(hooks('phone'), prefer).toEqual([null, null])
      expect(hooks('dial'), prefer).toEqual([null, null])
      html[i]!.push(app.innerHTML)
    }
    expect(html[1]).toEqual(html[0])
  })

  it('compiles the row: tracks shared, parts spaced by margins, a button beside the controls, wrapping on a phone', () => {
    const css = compileStyles(loadStore('n3'))
    const block = (sel: string) => {
      const i = css.indexOf(`${sel} {`)
      expect(i, sel).toBeGreaterThan(-1)
      return css.slice(i, css.indexOf('}', i))
    }
    const row = block('[data-sem-layout="field-row"]')
    expect(row).toMatch(/display: grid/)
    expect(row).toMatch(/grid-auto-flow: column/)
    expect(row).toMatch(/row-gap: 0/)
    // a field's own gap would put space under the tracks it leaves empty: in a field row and in a row of a list
    const fields = ':is([data-sem-layout=field-row], [data-sem-layout=subgrid]) > [data-sem-row-span]'
    expect(block(fields)).toMatch(/row-gap: 0/)
    // parts by role: the label is spaced below it, a field without one gets an empty label track
    expect(block(`${fields} > [data-sem-part=field-label]`)).toMatch(/margin-block-end: var\(--sem-space-2\)/)
    expect(block(`${fields}:not(:has(> [data-sem-part=field-label]))::before`)).toMatch(/content: ""/)
    // a single-line control is centred in its track, as what sits beside it is
    expect(block(`${fields} > [data-sem-part=single-line-control]`)).toMatch(/align-self: center/)
    // help and errors are spaced above them and never size a column, so one that appears moves nothing sideways
    const after = block(`${fields} > :not([data-sem-part=field-label]) ~ :not([role=dialog], [role=listbox])`)
    expect(after).toMatch(/margin-block-start: var\(--sem-space-2\)/)
    expect(after).toMatch(/contain: inline-size/)
    expect(block('[data-sem-layout="field-row"] > :not([data-sem-row-span])')).toMatch(/grid-row: 2/)
    // a row of a list with a field in it: the other cells in the control track, each keeping its column
    expect(block('[data-sem-layout="subgrid"]:has(> [data-sem-row-span])')).toMatch(/grid-auto-flow: column/)
    expect(block('[data-sem-layout="subgrid"]:has(> [data-sem-row-span]) > :not([data-sem-row-span])')).toMatch(/grid-row: 2/)
    const compact = css.slice(css.indexOf('@media (max-width: 640px)', css.indexOf('@layer sem.variants')))
    expect(compact).toMatch(/\[data-sem-layout="field-row"\] \{[^}]*grid-auto-flow: row/)
    // a choice is a field: its select is the shared single-line box; the pill is the inline variant's
    expect(css).toMatch(/\[data-sem-c=choice\] select\)[^{]*\{[^}]*block-size: var\(--control-h, var\(--sem-control-height\)\)/)
    expect(css).toMatch(/\[data-sem-c="choice"\]\[data-sem-label-placement="inline"\] \{[^}]*display: inline-flex/)
    expect(css).not.toMatch(/\[data-sem-c="choice"\] \{[^}]*display: inline-flex/)
  })
})
