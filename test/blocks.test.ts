import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { DEFAULT_LAYERS, MOD, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { implementationGaps } from './implementations.ts'
import { sameHtml } from './same-html.ts'

// Block documents (ontology/components/blocks.ttl, docs/BLOCKS.md): a document of every primitive
// block, read only, in the Screen and Text modalities, by the SPARQL rules and their function twins.

const EX = 'https://example.org/doc#'
export const DOCUMENT = `
@prefix c: <${NS.c}> .
@prefix blk: <${NS.blk}> .
@prefix po: <${NS.po}> .
@prefix oa: <${NS.oa}> .
@prefix ord: <${NS.ord}> .
@prefix sty: <${NS.sty}> .
@prefix schema: <https://schema.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix ex: <${EX}> .
ex:editor a c:BlockEditor ; c:label "Notes" ; c:of ex:doc .
ex:doc a blk:Document ; schema:name "Plans" ;
    po:contains ex:toc , ex:h1 , ex:p , ex:bullets , ex:numbers , ex:todos , ex:toggle , ex:quote , ex:callout , ex:hr ,
                ex:code , ex:math , ex:table , ex:image , ex:file , ex:bookmark , ex:embed , ex:columns , ex:other , ex:h2 , ex:empty .
ex:toc a blk:Contents ; ord:immediatelyPrecedes ex:h1 .
ex:h1 a blk:Heading1 ; rdf:value "Plans" ; ord:immediatelyPrecedes ex:p .
ex:p a blk:Paragraph ; rdf:value "Ship the *editor* first, see docs." ; ord:immediatelyPrecedes ex:bullets ;
    blk:mark ex:p-bold , ex:p-em , ex:p-link , ex:p-code .
ex:p-bold a blk:Strong ; oa:start 0 ; oa:end 13 .
ex:p-em a blk:Emphasis ; oa:start 5 ; oa:end 20 .
ex:p-link a blk:Link ; oa:start 29 ; oa:end 33 ; schema:url "https://semblance.dev/docs" .
ex:p-code a blk:InlineCode ; oa:start 9 ; oa:end 17 .
ex:bullets a blk:BulletedList ; po:contains ex:b1 , ex:b2 ; ord:immediatelyPrecedes ex:numbers .
ex:b1 a blk:ListItem ; rdf:value "Model" ; ord:immediatelyPrecedes ex:b2 ; po:contains ex:nested .
ex:nested a blk:BulletedList ; po:contains ex:b1a .
ex:b1a a blk:ListItem ; rdf:value "Shapes" .
ex:b2 a blk:ListItem ; rdf:value "Rendering" ; blk:mark ex:b2-strike .
ex:b2-strike a blk:Strike ; oa:start 0 ; oa:end 9 .
ex:numbers a blk:NumberedList ; po:contains ex:n1 , ex:n2 ; ord:immediatelyPrecedes ex:todos .
ex:n1 a blk:ListItem ; rdf:value "First" ; ord:immediatelyPrecedes ex:n2 .
ex:n2 a blk:ListItem ; rdf:value "Second" .
ex:todos a blk:TodoList ; po:contains ex:t1 , ex:t2 ; ord:immediatelyPrecedes ex:toggle .
ex:t1 a blk:TodoItem ; rdf:value "Write the note" ; blk:checked true ; ord:immediatelyPrecedes ex:t2 .
ex:t2 a blk:TodoItem ; rdf:value "Mention @Ada" ; blk:checked false ; blk:mark ex:t2-ada .
ex:t2-ada a blk:Mention ; oa:start 8 ; oa:end 12 ; oa:hasBody <https://example.org/people/ada> .
ex:toggle a blk:Toggle ; rdf:value "Details" ; po:contains ex:inside ; ord:immediatelyPrecedes ex:quote .
ex:inside a blk:Paragraph ; rdf:value "Hidden until opened." .
ex:quote a blk:Quote ; rdf:value "Simple things should be simple." ; ord:immediatelyPrecedes ex:callout .
ex:callout a blk:Callout ; rdf:value "Mind the gap." ; c:icon "⚠️" ; sty:tone sty:Warning ; ord:immediatelyPrecedes ex:hr .
ex:hr a blk:Divider ; ord:immediatelyPrecedes ex:code .
ex:code a blk:Code ; schema:programmingLanguage "turtle" ; rdf:value "ex:a a ex:B ." ; ord:immediatelyPrecedes ex:math .
ex:math a blk:Math ; rdf:value "e^{i\\\\pi} + 1 = 0" ; ord:immediatelyPrecedes ex:table .
ex:table a blk:Table ; po:contains ex:r1 , ex:r2 ; ord:immediatelyPrecedes ex:image .
ex:r1 a blk:Row ; blk:header true ; po:contains ex:c11 , ex:c12 ; ord:immediatelyPrecedes ex:r2 .
ex:c11 a blk:Cell ; rdf:value "Block" ; ord:immediatelyPrecedes ex:c12 .
ex:c12 a blk:Cell ; rdf:value "DoCo" .
ex:r2 a blk:Row ; po:contains ex:c21 , ex:c22 .
ex:c21 a blk:Cell ; rdf:value "Paragraph" ; ord:immediatelyPrecedes ex:c22 .
ex:c22 a blk:Cell ; rdf:value "doco:Paragraph" .
ex:image a blk:Image ; schema:contentUrl "/favicon.svg" ; schema:caption "The mark" ; ord:immediatelyPrecedes ex:file .
ex:file a blk:File ; schema:contentUrl "/files/plan.pdf" ; schema:name "plan.pdf" ; schema:contentSize "12 KB" ; ord:immediatelyPrecedes ex:bookmark .
ex:bookmark a blk:Bookmark ; schema:url "https://www.w3.org/ns/oa/" ; schema:name "Web Annotation" ; ord:immediatelyPrecedes ex:embed .
ex:embed a blk:Embed ; schema:embedUrl "https://example.org/map" ; schema:name "Map" ; ord:immediatelyPrecedes ex:columns .
ex:columns a blk:Columns ; po:contains ex:left , ex:right ; ord:immediatelyPrecedes ex:other .
ex:left a blk:Column ; po:contains ex:lp ; ord:immediatelyPrecedes ex:right .
ex:lp a blk:Paragraph ; rdf:value "Left" .
ex:right a blk:Column ; po:contains ex:rp .
ex:rp a blk:Paragraph ; rdf:value "Right" .
ex:other a blk:DocumentLink ; blk:target ex:otherDoc ; ord:immediatelyPrecedes ex:h2 .
ex:otherDoc a blk:Document ; schema:name "Retrospective" ; schema:url "/docs/retro" .
ex:h2 a blk:Heading2 ; rdf:value "Later" ; ord:immediatelyPrecedes ex:empty .
ex:empty a blk:Paragraph ; rdf:value "" .
`

function mount(kind: 'wat' | 'oxigraph', prefer: 'sparql' | 'function') {
  const store = loadStore(kind, DOCUMENT)
  const runtime = new Runtime(store)
  const fail = (e: Error) => {
    throw e
  }
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, prefer, name: 'screen', roots: [EX + 'editor'] }, fail)
  const text = runtime.project({ modality: MOD.Text, layers: [], prefer, name: 'text', roots: [EX + 'editor'] }, fail)
  const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const app = document.getElementById('app')!
  const renderer = new DomRenderer(screen.index, app, EX + 'editor')
  renderer.flush()
  return { store, runtime, screen, document, app, html: () => app.innerHTML, text: () => toText(text.index, EX + 'editor') }
}

describe('block documents (blk:)', () => {
  it('has a SPARQL rule and a function twin for every rendering', () => {
    expect(implementationGaps(['components/blocks.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })

  for (const kind of ['wat', 'oxigraph'] as const) {
    it(`renders every primitive the same with SPARQL rules and their function twins (${kind})`, () => {
      const sparql = mount(kind, 'sparql')
      const fn = mount(kind, 'function')
      sameHtml(fn.html(), sparql.html(), 'screen')
      expect(fn.text()).toBe(sparql.text())
    })
  }

  it('renders blocks as semantic HTML: headings, paragraphs with marks, lists, a table, a figure', () => {
    const { document: d } = mount('wat', 'sparql')
    const root = (name: string) => d.querySelector(`[id="${EX}${name}/~root"]`)!
    expect(root('h1').localName).toBe('h2')
    expect(root('h2').localName).toBe('h3')
    expect(root('p').localName).toBe('p')
    expect(root('p').querySelector('.sem-text')!.innerHTML).toBe(
      '<strong>Ship </strong><strong><em>the </em></strong><strong><em><code>*edi</code></em></strong><em><code>tor*</code></em><em> fi</em>rst, see <a href="https://semblance.dev/docs" data-sem-mark="link">docs</a>.',
    )
    expect(root('bullets').localName).toBe('ul')
    expect([...root('bullets').children].map((li) => li.localName)).toEqual(['li', 'li'])
    expect(root('b1').querySelector('.sem-children > ul > li')!.textContent).toBe('Shapes')
    expect(root('numbers').localName).toBe('ol')
    expect(root('t1').querySelector('input')!.hasAttribute('checked')).toBe(true)
    expect(root('t1').querySelector('input')!.getAttribute('aria-labelledby')).toBe(`${EX}t1/~text`)
    expect(root('t2').querySelector('a[data-sem-mark=mention]')!.getAttribute('href')).toBe('https://example.org/people/ada')
    const twisty = root('toggle').querySelector('button')!
    expect(twisty.getAttribute('aria-expanded')).toBe('false')
    expect(d.querySelector(`[id="${twisty.getAttribute('aria-controls')}"]`)!.hasAttribute('hidden')).toBe(true)
    expect(root('quote').localName).toBe('blockquote')
    expect(root('callout').getAttribute('role')).toBe('note')
    expect(root('callout').getAttribute('data-sem-tone')).toBe('warning')
    expect(root('hr').localName).toBe('hr')
    expect(root('code').querySelector('pre code')!.textContent).toBe('ex:a a ex:B .')
    expect(root('math').getAttribute('role')).toBe('math')
    expect(root('table').querySelector('tbody > tr > th')!.getAttribute('scope')).toBe('col')
    expect([...root('table').querySelectorAll('td')].map((td) => td.textContent)).toEqual(['Paragraph', 'doco:Paragraph'])
    expect(root('image').querySelector('figcaption')!.textContent).toBe('The mark')
    expect(root('file').querySelector('a')!.getAttribute('href')).toBe('/files/plan.pdf')
    expect(root('bookmark').querySelector('.sem-address')!.textContent).toBe('www.w3.org/ns/oa')
    expect(root('embed').querySelector('iframe')!.getAttribute('title')).toBe('Map')
    expect([...root('columns').children].map((c) => c.textContent)).toEqual(['Left', 'Right'])
    expect(root('other').querySelector('a')!.getAttribute('href')).toBe('/docs/retro')
    expect(root('empty').querySelector('.sem-text')!.innerHTML).toBe('<br>')
    expect([...root('toc').querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Plans', 'Later'])
    // Blocks come in the order of their chain.
    const order = [...d.querySelector('[data-sem-c=blk-document]')!.children].map((el) => el.id.replace(EX, '').replace('/~root', ''))
    expect(order).toEqual(['toc', 'h1', 'p', 'bullets', 'numbers', 'todos', 'toggle', 'quote', 'callout', 'hr', 'code', 'math', 'table', 'image', 'file', 'bookmark', 'embed', 'columns', 'other', 'h2', 'empty'])
  })

  it('reads as Markdown in the Text modality', () => {
    const text = mount('wat', 'sparql').text()
    expect(text.split('\n')).toEqual([
      '- Plans',
      '  - Later',
      '# Plans',
      '**Ship _the `*edi**tor*` fi_rst, see [docs](https://semblance.dev/docs).',
      '- Model',
      '  - Shapes',
      '- ~~Rendering~~',
      '1. First',
      '1. Second',
      '- [x] Write the note',
      '- [ ] Mention [@Ada](https://example.org/people/ada)',
      '▸ Details',
      '> Simple things should be simple.',
      '> ⚠️ Mind the gap.',
      '---',
      '```turtle',
      'ex:a a ex:B .',
      '```',
      '$$ e^{i\\pi} + 1 = 0 $$',
      '| Block | DoCo |',
      '|---|---|',
      '| Paragraph | doco:Paragraph |',
      '![The mark](/favicon.svg)',
      '[plan.pdf](/files/plan.pdf)',
      '[Web Annotation](https://www.w3.org/ns/oa/)',
      '[Map](https://example.org/map)',
      'Left',
      'Right',
      '→ [Retrospective](/docs/retro)',
      '## Later',
    ])
  })
})
