// A number's text on every store (#346). Oxigraph keeps a literal's value, so "1.50"^^xsd:decimal comes
// back as "1.5" there, while the other stores keep the lexical form; what a page shows or writes in an
// attribute takes neither: it is the canonical text, cast by IF(isNumeric(?v), xsd:string(?v), STR(?v))
// in the SPARQL rules and numberText in their twins. So the same graph renders the same HTML everywhere.
import { describe, expect, it } from 'vitest'
import type { StoreKind } from '../src/node/load.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS } from '../src/ns.ts'
import { canonicalDecimal, numberText, sameDecimal } from '../src/rdf.ts'
import { toHTML } from '../src/render/serialize.ts'
import { mountSite } from './harness.ts'
import { setup, SCREEN_LAYERS } from './helpers.ts'

const XSD = 'http://www.w3.org/2001/XMLSchema#'
const SPARQL_STORES: StoreKind[] = ['wat', 'rust', 'oxigraph', 'hybrid']
const STORES: StoreKind[] = [...SPARQL_STORES, 'n3']

const LITERALS: [string, string, string][] = [
  ['1249.00', 'decimal', '1249'],
  ['+1.50', 'decimal', '1.5'],
  ['-0.0', 'decimal', '0'],
  ['.5', 'decimal', '0.5'],
  ['5.', 'decimal', '5'],
  ['-007.10', 'decimal', '-7.1'],
  ['abc', 'decimal', 'abc'],
  ['007', 'integer', '7'],
  ['+3', 'integer', '3'],
  ['-0', 'integer', '0'],
  ['07', 'int', '7'],
  ['1.50E0', 'double', '1.5'],
  ['1E21', 'double', '1000000000000000000000'],
  ['1E-7', 'double', '0.0000001'],
  ['-1.5E-7', 'double', '-0.00000015'],
  ['-0', 'double', '-0'],
  ['INF', 'double', 'INF'],
  ['NaN', 'double', 'NaN'],
  ['1,5', 'double', '1,5'],
  ['0.1', 'float', '0.1'],
  ['1.50', 'float', '1.5'],
  ['16777217', 'float', '16777216'],
]

describe('numberText, as the cast to xsd:string in SPARQL writes it', () => {
  const graph = `@prefix e: <http://e/> .\n` + LITERALS.map(([text, type], i) => `e:s${i} e:v "${text}"^^<${XSD}${type}> .`).join('\n')

  it.each(STORES)('on %s, numberText reads the terms the store hands out', (kind) => {
    const store = loadStore(kind, graph)
    const quads = store.match(null, store.factory.namedNode('http://e/v'), null, null)
    expect(quads.length).toBe(LITERALS.length)
    for (const q of quads) expect(numberText(q.object)).toBe(LITERALS[Number(q.subject.value.slice(10))]![2])
  })

  it.each(SPARQL_STORES)('on %s, the idiom the rules use gives the same text', (kind) => {
    const store = loadStore(kind, graph)
    const g = store.match(null, store.factory.namedNode('http://e/v'), null, null)[0]!.graph
    const rows = store.select(`SELECT ?s ?t WHERE { ?s <http://e/v> ?v BIND(IF(isNumeric(?v), <${XSD}string>(?v), STR(?v)) AS ?t) }`, [g])
    expect(rows.length).toBe(LITERALS.length)
    for (const r of rows) expect(r.get('t')?.value).toBe(LITERALS[Number(r.get('s')!.value.slice(10))]![2])
  })

  it('tells two texts of one number from other texts', () => {
    expect(canonicalDecimal('0012.3400')).toBe('12.34')
    expect(sameDecimal('1.0', '1')).toBe(true)
    expect(sameDecimal('1.', '1')).toBe(true)
    expect(sameDecimal('1.05', '1')).toBe(false)
    expect(sameDecimal('', '0')).toBe(false)
    expect(sameDecimal('1e0', '1')).toBe(false)
  })
})

const X = 'https://example.org/n#'
const graph = `@prefix c: <${NS.c}> . @prefix x: <${X}> . @prefix sem: <${NS.sem}> . @prefix xsd: <${XSD}> . @prefix sh: <http://www.w3.org/ns/shacl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix tree: <https://w3id.org/tree#> . @prefix ldes: <https://w3id.org/ldes#> .
  x:money a c:Money ; c:value 1249.00 ; c:currency "EUR" .
  x:moneyPlain a c:Money ; c:value "+7.50"^^xsd:decimal .
  x:moneyUnknown a c:Money ; c:value 1.50 ; c:currency "EURO" .
  x:slider a c:Slider ; c:label "S" ; c:min 0.0 ; c:max 2.00 ; c:step 0.10 ; c:value 1.50 .
  x:progress a c:Progress ; c:label "P" ; c:value 1.50 ; c:max 3.00 .
  x:stat a c:Stat ; c:label "St" ; c:value 12.50 ; c:delta 1.50 .
  x:statInteger a c:Stat ; c:label "Si" ; c:value "012"^^xsd:integer ; c:delta "+3"^^xsd:integer .
  x:statDouble a c:Stat ; c:label "Sd" ; c:value 1.50E0 ; c:unit "x" .
  x:skeleton a c:Skeleton ; c:shape "circle" ; c:width 44.0 ; c:height 44.50 .
  x:split a c:SplitView ; c:label "Sp" ; c:ratio 0.50 .
  x:A1 a c:SheetCell ; c:row 1 ; c:column 1 ; c:value 1.50 .
  x:B1 a c:SheetCell ; c:row 1 ; c:column 2 ; c:value "+2.50"^^xsd:decimal .
  x:C1 a c:SheetCell ; c:row 1 ; c:column 3 ; c:value "note" .
  x:sheet a c:Sheet ; c:label "Sh" ; c:columns 3 ; c:cell x:A1 , x:B1 , x:C1 ; c:selectedCell x:A1 ; c:selectionEnd x:C1 .
  x:thing x:weight 1.50 ; x:count "007"^^xsd:integer ; x:ratio 1.50E0 ; x:size 512.0 ; x:code 2.50 .
  x:list a c:DescriptionList ; c:of x:thing ; c:fields ( x:weight x:count x:ratio ) .
  x:q a sem:View ; sem:select "SELECT ?w ?c ?r WHERE { <${X}thing> <${X}weight> ?w ; <${X}code> ?c ; <${X}ratio> ?r }" .
  x:col1 a c:Column ; c:variable "w" ; c:label "W" .
  x:col2 a c:Column ; c:variable "c" ; c:label "C" ; c:format "code" .
  x:col3 a c:Column ; c:variable "r" ; c:label "R" ; c:format "decimal" .
  x:table a c:Table ; c:label "T" ; c:query x:q ; c:tableColumns ( x:col1 x:col2 x:col3 ) .
  x:log a ldes:EventStream ; ldes:sequencePath x:seq ; tree:member x:m1 .
  x:m1 x:seq 1 ; x:weight 1.50 ; x:size 512.0 ; x:count "007"^^xsd:integer .
  x:g1 a c:GridColumn ; c:label "W" ; c:cellProperty x:weight .
  x:g2 a c:GridColumn ; c:label "B" ; c:cellProperty x:size ; c:cellAs c:BytesCell .
  x:g3 a c:GridColumn ; c:label "C" ; c:cellProperty x:count ; c:cellAs c:CodeCell .
  x:grid a c:DataGrid ; c:label "G" ; c:collection x:log ; c:pageSize 8 ; c:gridColumns ( x:g1 x:g2 x:g3 ) ; c:shows x:g1 , x:g2 , x:g3 .
  x:shape a sh:NodeShape ; sh:property x:ps , x:pc .
  x:ps a sh:PropertyShape ; sh:path x:weight ; sh:name "Weight" ; sh:datatype xsd:decimal ; sh:minInclusive 0.50 ; sh:maxInclusive 1.00 ; sh:group x:pg .
  x:pc a sh:PropertyShape ; sh:path x:code ; sh:name "Code" ; sh:in ( 2.50 3.50 ) ; sh:group x:pg .
  x:pg a sh:PropertyGroup ; rdfs:label "Group" .
  x:form a c:ShapeForm ; c:label "F" ; c:nodeShape x:shape ; c:of x:thing .
`
const PARTS = ['money', 'moneyPlain', 'moneyUnknown', 'slider', 'progress', 'stat', 'statInteger', 'statDouble', 'skeleton', 'split', 'A1', 'B1', 'C1', 'sheet', 'list', 'grid', 'form']

function render(kind: StoreKind, prefer: 'sparql' | 'function') {
  const { runtime, screen } = setup(kind, { modality: MOD.Screen, layers: SCREEN_LAYERS, prefer, languages: ['en'] }, 1, [graph])
  const text = runtime.project({ modality: MOD.Text, prefer, languages: ['en'], name: 'text' })
  return Object.fromEntries(PARTS.flatMap((p) => [[p, toHTML(screen.index, X + p)], [p + ' as text', toHTML(text.index, X + p)]]))
}

describe('what shows a number renders the same on every store, by either rule', () => {
  const expected = render('wat', 'sparql')

  it('writes the canonical text', () => {
    expect(expected.money).toContain('value="1249"')
    expect(expected.money).toContain('€1,249.00')
    expect(expected.moneyPlain).toContain('value="7.5"')
    expect(expected.moneyUnknown).toContain('value="1.5"')
    expect(expected.moneyUnknown).toContain('EURO 1.5')
    expect(expected.A1).toContain('value="1.5"')
    expect(expected.B1).toContain('value="2.5"')
    expect(expected.sheet).toContain('A1  1.5')
    expect(expected.sheet).toContain('Sum 4')
    expect(expected.grid).toContain('>1.5<')
    expect(expected.grid).toContain('512 B')
    expect(expected.grid).toContain('>7<')
    expect(expected.form).toContain('min="0.5"')
    expect(expected.form).toContain('max="1"')
    expect(expected.form).toContain('value="1.5"')
    expect(expected.form).toContain('At most 1.')
    expect(expected.form).toMatch(/selected[^>]*value="2.5"|value="2.5"[^>]*selected/)
  })

  const cases = STORES.flatMap((kind) => (['sparql', 'function'] as const).filter((prefer) => kind !== 'n3' || prefer === 'function').map((prefer) => [kind, prefer] as const))
  it.each(cases)('%s, %s rules', (kind, prefer) => {
    const got = render(kind, prefer)
    expect(got).toEqual(expected)
  })
})

describe('a table of numbers', () => {
  const cells = (kind: StoreKind, prefer: 'sparql' | 'function') => {
    const { runtime, screen } = setup(kind, { modality: MOD.Screen, layers: SCREEN_LAYERS, prefer, languages: ['en'] }, 1, [graph])
    return toHTML(screen.index, X + 'table')
  }
  it.each(SPARQL_STORES)('%s: a code cell is the canonical text', (kind) => {
    for (const prefer of ['sparql', 'function'] as const) expect(cells(kind, prefer)).toContain('<code>2.5</code>')
  })
})

describe('the site on wat and on hybrid', () => {
  const page = (kind: StoreKind, section: string, name: string) => {
    const h = mountSite(kind, 'sparql')
    const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
    const go = (selector: string, label: string) => {
      h.fire([...h.document.querySelectorAll(selector)].find((b) => b.textContent!.trim() === label && visible(b))!, 'click')
      h.shell.flush()
    }
    go('button', section)
    go('[data-sem-c=nav-list] button', name)
    const app = h.document.querySelector('#app')!.cloneNode(true) as Element
    for (const e of app.querySelectorAll('footer[data-sem-c=status-bar], [data-sem-c=metrics]')) e.remove()
    // (not the change log's clock)
    return { html: app.outerHTML.replace(/<time [^>]*>[^<]*<\/time>/g, ''), money: [...h.document.querySelectorAll('data[data-sem-c=money]')].filter(visible).map((e) => e.outerHTML) }
  }
  it.each([['Examples', 'Localized product page'], ['Components', 'Data']])('%s, %s: the same page', (section, name) => {
    const [a, b] = (['wat', 'hybrid'] as const).map((kind) => page(kind, section, name))
    expect(a!.money.length).toBeGreaterThan(0)
    expect(a!.money.join()).toContain('value="1249"')
    expect(b!.money).toEqual(a!.money)
    expect(b!.html).toBe(a!.html)
  }, 240_000)
})

describe('typing a number', () => {
  // As a browser: the field has the focus, and what is typed is the field's own text, apart from its value attribute (linkedom has neither).
  const focus = (document: Document, el: HTMLInputElement) => {
    Object.defineProperty(document, 'activeElement', { get: () => el, configurable: true })
    let live = el.getAttribute('value') ?? ''
    Object.defineProperty(el, 'value', { get: () => live, set: (v: string) => { live = v }, configurable: true })
  }
  const SS = 'https://semblance.dev/demo/sheet#'
  function sheetCell(kind: StoreKind, prefer: 'sparql' | 'function') {
    const h = mountSite(kind, prefer)
    const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
    const fire = (el: Element, type: string) => {
      h.fire(el, type)
      h.shell.flush()
    }
    fire([...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Examples' && visible(b))!, 'click')
    fire([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === 'Spreadsheet' && visible(b))!, 'click')
    const input = (h.shell.nodeOf(SS + 'B2/~root') as HTMLElement).querySelector('input') as HTMLInputElement
    return { h, input, fire }
  }

  it.each([['wat', 'sparql'], ['wat', 'function'], ['hybrid', 'sparql'], ['hybrid', 'function']] as const)('%s, %s rules: "1.0" stays as typed until the field is left', (kind, prefer) => {
    const { input, fire, h } = sheetCell(kind, prefer)
    focus(h.document, input)
    for (const text of ['1', '1.', '1.0', '1.05', '1.050']) {
      input.value = text
      fire(input, 'input')
      expect(input.value).toBe(text)
    }
    expect(input.getAttribute('value')).toBe('1.05')
    expect(input.value).toBe('1.050')
    h.fire(input, 'blur')
    expect(input.value).toBe('1.05')
  }, 120_000)

  it('another number replaces the text of the field being typed in', () => {
    const { input, fire, h } = sheetCell('wat', 'sparql')
    focus(h.document, input)
    input.value = '12'
    fire(input, 'input')
    expect(input.getAttribute('value')).toBe('12')
    input.value = 'x'
    fire(input, 'input')
    expect(input.value).toBe('x')
  }, 120_000)
})
