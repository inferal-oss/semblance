import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML, toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'

const root = 'https://example.org/sample'
const prefixes = '@prefix c: <https://semblance.dev/ns/component#> . @prefix ex: <https://example.org/> . @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .'
const source = '\nconst x = "<img src=x onerror=alert(1)>";\n  '
const graph = `${prefixes}
ex:sample a c:Code ; c:block true ; c:language "JavaScript" ; c:label ${JSON.stringify(source)} ; c:codeTokens ex:cell1 .
ex:cell1 rdf:first ex:keyword ; rdf:rest ex:cell2 .
ex:cell2 rdf:first ex:plain ; rdf:rest ex:cell3 .
ex:cell3 rdf:first ex:string ; rdf:rest rdf:nil .
ex:keyword a c:CodeToken ; c:tokenKind "keyword" ; c:label "\\nconst" .
ex:plain a c:CodeToken ; c:tokenKind "text" ; c:label " x = " .
ex:string a c:CodeToken ; c:tokenKind "string" ; c:label ${JSON.stringify('"<img src=x onerror=alert(1)>";\n  ')} .`

function show(prefer: 'sparql' | 'function', data = graph) {
  const store = loadStore('wat', data)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, roots: [root], layers: [STY.Layer], prefer }, e => { throw e })
  const { document } = parseHTML('<html><body><main></main></body></html>')
  const host = document.querySelector('main')!
  const dom = new DomRenderer(screen.index, host, root)
  dom.flush()
  const set = (s: string, p: string, value: string, iri = false) => {
    const f = store.factory
    const subject = f.namedNode('https://example.org/' + s)
    const predicate = f.namedNode(p)
    runtime.apply({ remove: store.match(subject, predicate, null, f.defaultGraph()), add: [f.quad(subject, predicate, iri ? f.namedNode(value) : f.literal(value))] })
    dom.flush()
  }
  return { store, runtime, screen, host, dom, set, html: () => toHTML(screen.index, root) }
}

for (const prefer of ['sparql', 'function'] as const) describe(`${prefer} external Code tokens`, () => {
  it('preserves whitespace, escapes markup, and retains the Code label and keyboard scrolling', () => {
    const app = show(prefer)
    const pre = app.host.querySelector('pre')!
    expect(pre.getAttribute('tabindex')).toBe('0')
    expect(pre.querySelector('.sem-language')?.textContent).toBe('javascript')
    expect(pre.querySelector('code')?.textContent).toBe(source)
    expect(pre.querySelector('.tok-keyword')?.textContent).toBe('\nconst')
    expect(pre.querySelector('img')).toBeNull()
    expect(app.html()).toContain('&lt;img')
  })

  it('updates one token in place, preserves sibling nodes, and rejects CSS input', () => {
    const app = show(prefer)
    const unchanged = app.host.querySelector('.tok-string')
    app.set('keyword', NS.c + 'label', '\nlet')
    expect(app.host.querySelector('.tok-keyword')?.textContent).toBe('\nlet')
    expect(app.host.querySelector('.tok-string')).toBe(unchanged)
    app.set('keyword', NS.c + 'tokenKind', 'keyword\" onclick=\"alert(1)')
    expect(app.host.querySelector('.tok-keyword')).toBeNull()
    expect(app.host.querySelector('code')?.textContent).toContain('\nlet')
    expect(app.host.querySelector('[onclick]')).toBeNull()
  })

  it('supports empty sequences and inline samples without imposing block trimming', () => {
    const app = show(prefer, `${prefixes} ex:sample a c:Code ; c:label "fallback" ; c:codeTokens () .`)
    expect(app.host.querySelector('code')?.textContent).toBe('')
    expect(app.host.querySelector('pre')).toBeNull()
    app.set('sample', NS.c + 'codeTokens', 'https://example.org/cell', true)
    // With no token cells yet the sequence is still empty; raw text does not leak through.
    expect(app.host.querySelector('code')?.textContent).toBe('')
  })

  it('retains raw source for text output and built-in coloring when tokens are omitted', () => {
    const app = show(prefer)
    const text = app.runtime.project({ modality: MOD.Text, roots: [root], layers: [], prefer })
    expect(toText(text.index, root)).toBe(source.replace(/\s+$/, '').split('\n').map(line => '    ' + line).join('\n'))
    const builtIn = show(prefer, `${prefixes} ex:sample a c:Code ; c:block true ; c:language "turtle" ; c:label "@prefix ex: <https://example.org/> ." .`)
    expect(builtIn.host.querySelector('.tok-keyword')?.textContent).toBe('@prefix')
  })
})

it('keeps SPARQL and function output byte-identical after token, order and fallback changes', () => {
  const a = show('sparql'), b = show('function')
  const parity = () => expect(a.html()).toBe(b.html())
  parity()
  for (const app of [a, b]) app.set('plain', NS.c + 'label', ' renamed = ')
  parity()
  // Exchange members in one change so each intermediate list also has distinct occurrences.
  for (const app of [a, b]) {
    const f = app.store.factory
    const first = f.namedNode(NS.rdf + 'first')
    const one = f.namedNode('https://example.org/cell1'), three = f.namedNode('https://example.org/cell3')
    app.runtime.apply({
      remove: [...app.store.match(one, first, null, f.defaultGraph()), ...app.store.match(three, first, null, f.defaultGraph())],
      add: [f.quad(one, first, f.namedNode('https://example.org/string')), f.quad(three, first, f.namedNode('https://example.org/keyword'))],
    })
    app.dom.flush()
  }
  parity()
  for (const app of [a, b]) {
    const f = app.store.factory
    app.runtime.apply({ remove: app.store.match(f.namedNode(root), f.namedNode(NS.c + 'codeTokens'), null, f.defaultGraph()), add: [] })
    app.dom.flush()
  }
  parity()
  expect(a.host.querySelector('.tok-keyword')).toBeNull()
  expect(a.host.querySelector('code')?.textContent).toBe(source.replace(/^\n+|\s+$/g, ''))
})

it('tracks anonymous list cells as well as named cells when their order changes', () => {
  const app = show('sparql', `${prefixes}
    ex:sample a c:Code ; c:label "firstsecond" ; c:codeTokens ( ex:one ex:two ) .
    ex:one a c:CodeToken ; c:label "first" . ex:two a c:CodeToken ; c:label "second" .`)
  const f = app.store.factory
  const first = f.namedNode(NS.rdf + 'first'), rest = f.namedNode(NS.rdf + 'rest')
  const head = app.store.match(f.namedNode(root), f.namedNode(NS.c + 'codeTokens'), null)[0].object
  const tail = app.store.match(head, rest, null)[0].object
  app.runtime.apply({
    remove: [...app.store.match(head, first, null, f.defaultGraph()), ...app.store.match(tail, first, null, f.defaultGraph())],
    add: [f.quad(head, first, f.namedNode('https://example.org/two')), f.quad(tail, first, f.namedNode('https://example.org/one'))],
  })
  app.dom.flush()
  expect(app.host.querySelector('code')?.textContent).toBe('secondfirst')
})

it('follows only the changed sample list and forgets cells removed from it', () => {
  const second = graph.replaceAll('https://example.org/', 'https://second.example/').replaceAll('ex:', 'other:')
  const first = graph.replace('ex:sample a c:Code', 'ex:code1 a c:Code')
  const app = show('sparql', `${first}\n${second}\n${prefixes}
    ex:sample a c:Stack ; c:children ( ex:code1 <https://second.example/sample> ) .`)
  const rule = NS.c + 'CodeTokensRendering-sparql'
  const runs = () => app.screen.engine.stats.byRule.get(rule)?.runs ?? 0
  const other = app.host.querySelectorAll('pre')[1]
  const previous = runs()
  app.set('cell2', NS.rdf + 'rest', NS.rdf + 'nil', true)
  expect(runs() - previous).toBe(1)
  expect(app.host.querySelectorAll('pre')[1]).toBe(other)
  expect(other.querySelector('code')?.textContent).toBe(source)
  const afterRemoval = runs()
  app.set('cell3', NS.rdf + 'first', 'https://example.org/keyword', true)
  expect(runs()).toBe(afterRemoval)
})
