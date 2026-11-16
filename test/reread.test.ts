// What was evaluated before a graph arrived may have read what the graph adds without declaring it
// (a class's slug, a phrase's translations). Once the late graphs have all arrived it is evaluated
// again (Runtime.reread): what is shown in idle time, what is hidden when it is shown (#350).
import { describe, expect, it } from 'vitest'
import { Parser } from 'n3'
import type { FnRule } from '../src/engine/context.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS } from '../src/ns.ts'
import { HtmlIndex } from '../src/render/html-index.ts'
import { toHTML } from '../src/render/serialize.ts'
import { parseTurtle, Runtime } from '../src/runtime.ts'

const EX = 'https://example.test/#'
const prefixes = `
@prefix ex: <${EX}> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sem: <https://semblance.dev/ns/core#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix prv: <https://semblance.dev/ns/privacy#> .
`
const box = `
ex:Box a owl:Class ; rdfs:subClassOf sem:Component ; sem:slug "ex-box" .
# Reads ex:source's title, which it does not declare.
ex:BoxRendering a sem:Rendering ; sem:targets ex:Box ; sem:stratum 0 ; sem:watches rdf:type .
ex:BoxRendering-fn a sem:Rule ; sem:implements ex:BoxRendering ; sem:function "ex-box" .
`

function site(graph: string) {
  const runs: string[] = []
  const rule: FnRule = (ctx, focus) => {
    runs.push(focus.value)
    const o = ctx.out(focus)
    // (Untraced: as a SPARQL rule reads, what it reads re-runs it only if it declares it.)
    const title = store.match(store.factory.namedNode(EX + 'source'), store.factory.namedNode(EX + 'title'), null)[0]?.object.value ?? 'none'
    o.renders(o.el('root', 'Div', {}, [o.text('text', title)]))
    return o.quads
  }
  const store = loadStore('wat', `${prefixes}@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n${graph}`)
  const runtime = new Runtime(store)
  const errors: Error[] = []
  const screen = runtime.project({ modality: MOD.Screen, prefer: 'sparql', name: 'screen', roots: [EX + 'page'], functions: { 'ex-box': rule } }, (e) => errors.push(e))
  const html = (node: string) => toHTML(screen.index, EX + node)
  const add = (text: string) => runtime.apply({ add: parseTurtle(prefixes + text, store.factory), remove: [] })
  const idle = () => {
    while (runtime.warm(20));
  }
  return { store, runtime, screen, errors, runs, html, add, idle }
}

describe('reading again what was evaluated before the late graphs', () => {
  it('what is shown takes in what it did not declare, in idle time, and only once', () => {
    const s = site(`${box}
ex:shown a ex:Box .
ex:page a c:Stack ; c:children ( ex:shown ) .`)
    expect(s.html('shown')).toContain('none')
    s.add('ex:source ex:title "arrived" .')
    expect(s.html('shown')).toContain('none')
    s.runs.length = 0
    s.runtime.reread()
    // Nothing yet: it is idle time's.
    expect(s.runs).toEqual([])
    s.idle()
    expect(s.runs).toEqual([EX + 'shown'])
    expect(s.html('shown')).toContain('arrived')
    s.idle()
    expect(s.runs).toEqual([EX + 'shown'])
    s.runtime.dispose()
  })

  it('what is hidden waits until it is shown', () => {
    const s = site(`${box}
ex:shown a ex:Box .
ex:hidden a ex:Box .
ex:page a c:Stack ; c:children ( ex:shown ) .`)
    s.add('ex:source ex:title "arrived" .')
    s.runs.length = 0
    s.runtime.reread()
    s.idle()
    expect(s.runs).toEqual([EX + 'shown'])
    s.add('ex:page c:children ( ex:shown ex:hidden ) .')
    expect(s.runs).toContain(EX + 'hidden')
    expect(s.html('hidden')).toContain('arrived')
    s.runtime.dispose()
  })

  it('takes a long list a few foci at a time', () => {
    const n = 200
    const boxes = Array.from({ length: n }, (_, i) => `ex:b${i} a ex:Box .`).join('\n')
    const list = Array.from({ length: n }, (_, i) => `ex:b${i}`).join(' ')
    const s = site(`${box}\n${boxes}\nex:page a c:Stack ; c:children ( ${list} ) .`)
    s.runs.length = 0
    s.runtime.reread()
    s.screen.engine.warm(0)
    expect(s.runs).toEqual([])
    s.screen.engine.warm(0.001)
    expect(s.runs.length).toBeLessThan(n)
    s.idle()
    expect(new Set(s.runs).size).toBe(n)
    s.runtime.dispose()
  })

  it('an arrival in slices ends with it, and an arrival of nothing does not', () => {
    const s = site(`${box}
ex:shown a ex:Box .
ex:page a c:Stack ; c:children ( ex:shown ) .`)
    s.runs.length = 0
    s.runtime.arriving(true)
    s.runtime.arriving(false)
    s.idle()
    expect(s.runs).toEqual([])
    s.runtime.arriving(true)
    s.add('ex:source ex:title "arrived" .')
    s.runtime.arriving(false)
    s.idle()
    expect(s.html('shown')).toContain('arrived')
    s.runtime.dispose()
  })

  for (const prefer of ['sparql', 'function'] as const) {
    it(`a rule that goes by what it writes itself says the same again (prv:Mask, ${prefer})`, () => {
      const store = loadStore('wat', `${prefixes}
ex:key a c:TextField ; c:label "Key" ; prv:concealed true .
ex:page a c:Stack ; c:children ( ex:key ) .`)
      const runtime = new Runtime(store)
      const screen = runtime.project({ modality: MOD.Screen, layers: [NS.prv + 'Layer'], prefer, name: 'screen', roots: [EX + 'page'] })
      const type = () => store.match(store.factory.namedNode(EX + 'key'), store.factory.namedNode(NS.c + 'inputType'), null).map((q) => q.object.value)
      expect(type()).toEqual(['password'])
      runtime.reread()
      while (runtime.warm(20));
      expect(type()).toEqual(['password'])
      expect(toHTML(screen.index, EX + 'key')).toContain('type="password"')
      runtime.dispose()
    })
  }
})

describe('a class defined after its instances', () => {
  it('rules of what a late subclass link makes it run for it, and those of what it unmakes leave', () => {
    const graph = `
ex:Hook a sem:Rendering ; sem:targets ex:Wide ; sem:stratum 0 .
ex:Hook-fn a sem:Rule ; sem:implements ex:Hook ; sem:function "ex-hook" .
ex:Box a owl:Class .
ex:b a ex:Box .
ex:page a c:Stack ; c:children ( ex:b ) .`
    const seen: string[] = []
    const hook: FnRule = (ctx, focus) => {
      seen.push(focus.value)
      const o = ctx.out(focus)
      o.t(focus, EX + 'hooked', 'yes')
      return o.quads
    }
    const store = loadStore('wat', prefixes + graph)
    const runtime = new Runtime(store)
    const screen = runtime.project({ modality: MOD.Screen, prefer: 'sparql', name: 'screen', functions: { 'ex-hook': hook } })
    const hooked = () => store.match(store.factory.namedNode(EX + 'b'), store.factory.namedNode(EX + 'hooked'), null, screen.engine.graph).length
    expect(hooked()).toBe(0)
    const link = parseTurtle(`${prefixes}ex:Box rdfs:subClassOf ex:Wide .`, store.factory)
    runtime.apply({ add: link, remove: [] })
    expect(seen).toContain(EX + 'b')
    expect(hooked()).toBe(1)
    runtime.apply({ add: [], remove: link })
    expect(hooked()).toBe(0)
    runtime.dispose()
  })
})

describe('a node shows one text, one attribute value and one order key', () => {
  const prefix = '@prefix h: <https://ia2.dev/spec/rdf-html#> . @prefix sem: <https://semblance.dev/ns/core#> . @prefix ui: <https://example.org/ui#> . '
  const parse = (text: string) => new Parser().parse(prefix + text)
  const node = (index: HtmlIndex, key: string) => (index as unknown as { nodes: Map<string, { data?: string; orderKey?: string }> }).nodes.get('https://example.org/ui#' + key)!

  it('taking away the value shown shows the one left, in any order', () => {
    const index = new HtmlIndex()
    index.apply({ add: parse('ui:t a h:Text ; h:data "Board" .'), remove: [] })
    index.apply({ add: parse('ui:t h:data "Дошка" .'), remove: [] })
    index.apply({ add: parse('ui:t h:data "لوحة" .'), remove: [] })
    expect(node(index, 't').data).toBe('لوحة')
    index.apply({ add: [], remove: parse('ui:t h:data "Дошка" .') })
    expect(node(index, 't').data).toBe('لوحة')
    index.apply({ add: [], remove: parse('ui:t h:data "لوحة" .') })
    expect(node(index, 't').data).toBe('Board')
    index.apply({ add: [], remove: parse('ui:t h:data "Board" .') })
    expect(node(index, 't').data).toBeUndefined()
  })

  it('so does an attribute', () => {
    const index = new HtmlIndex()
    index.apply({ add: parse('ui:d a h:Div ; h:attribute ui:a . ui:a a h:Attribute ; h:attributeName "aria-label" ; h:attributeValue "Forget" .'), remove: [] })
    index.apply({ add: parse('ui:a h:attributeValue "Забути" .'), remove: [] })
    index.apply({ add: [], remove: parse('ui:a h:attributeValue "Забути" .') })
    expect(index.attributes('https://example.org/ui#d')).toEqual([['aria-label', 'Forget']])
  })

  it('so does an order key, and a new one replaces the old in one change', () => {
    const index = new HtmlIndex()
    index.apply({ add: parse('ui:t sem:orderKey "a" .'), remove: [] })
    index.apply({ add: parse('ui:t sem:orderKey "b" .'), remove: [] })
    index.apply({ add: [], remove: parse('ui:t sem:orderKey "b" .') })
    expect(node(index, 't').orderKey).toBe('a')
    index.apply({ add: parse('ui:t sem:orderKey "c" .'), remove: parse('ui:t sem:orderKey "a" .') })
    expect(node(index, 't').orderKey).toBe('c')
  })
})

describe('a query that is a view of its own, named by a node that comes later', () => {
  it('runs for that node too (iv:run), whichever arrives first', () => {
    const store = loadStore('wat', `${prefixes}
@prefix iv: <https://semblance.dev/ns/view#> .
ex:q a sem:View , iv:View ; iv:materialize iv:Graph ; sem:select "SELECT ?s WHERE { ?s a <${EX}Row> }" .
ex:r a ex:Row .
ex:page a c:Stack .`)
    const runtime = new Runtime(store)
    runtime.project({ modality: MOD.Screen, prefer: 'sparql', name: 'screen', roots: [EX + 'page'] })
    const f = store.factory
    const run = () => store.match(f.namedNode(EX + 't'), f.namedNode(NS.iv + 'run'), null).map((q) => q.object.value)
    runtime.apply({ add: parseTurtle(`${prefixes}ex:t a c:Table ; c:query ex:q . ex:page c:children ( ex:t ) .`, f), remove: [] })
    expect(run()).toEqual([EX + 'q'])
    runtime.dispose()
  })
})
