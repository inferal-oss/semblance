// A rule that leaves the running engine (its SPARQL twin arrived with a late graph, a layer was
// turned off) never runs again: nothing it left behind - work parked, held or stopped for it, what
// it read - evaluates it next to the rule that took its slot (#332).
import { describe, expect, it } from 'vitest'
import type { FnRule } from '../src/engine/context.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD } from '../src/ns.ts'
import { toHTML } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'

const EX = 'https://example.test/#'
const prefixes = `
@prefix ex: <${EX}> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sem: <https://semblance.dev/ns/core#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
`
const rendering = `
ex:Box a owl:Class ; rdfs:subClassOf sem:Component ; sem:slug "ex-box" .
ex:BoxRendering a sem:Rendering ; sem:targets ex:Box ; sem:stratum 0 .
ex:BoxRendering-fn a sem:Rule ; sem:implements ex:BoxRendering ; sem:function "ex-box" .
`
// The twin, in a graph that comes later. Its text has a local name the function rule's has not.
const twin = `${prefixes}
ex:BoxRendering-sparql a sem:Rule ;
    sem:implements ex:BoxRendering ;
    sem:construct """
PREFIX rdfhtml: <https://ia2.dev/spec/rdf-html#>
PREFIX sem: <https://semblance.dev/ns/core#>
CONSTRUCT {
  ?root sem:renders $this ; a rdfhtml:Div ; rdfhtml:hasChild ?text .
  ?text a rdfhtml:Text ; rdfhtml:data "twin" .
}
WHERE {
  BIND(IRI(CONCAT(STR($this), "/~root")) AS ?root)
  BIND(IRI(CONCAT(STR($this), "/~twin-text")) AS ?text)
}""" .
`

function site(boxes: string, shown: string) {
  let calls = 0
  let cost = 0
  let t = 0
  const box: FnRule = (ctx, focus) => {
    calls++
    t += cost
    const o = ctx.out(focus)
    ctx.object(ctx.nn(EX + 'source'), ctx.nn(EX + 'title'))
    o.renders(o.el('root', 'Div', {}, [o.text('fn-text', 'function')]))
    return o.quads
  }
  const store = loadStore('wat', `${prefixes}${rendering}
ex:source ex:title "first" .
${boxes}
ex:page a c:Stack ; c:children ( ${shown} ) .`)
  const runtime = new Runtime(store)
  runtime.watchdog.clock = () => t
  const errors: Error[] = []
  const screen = runtime.project({ modality: MOD.Screen, prefer: 'sparql', name: 'screen', roots: [EX + 'page'], functions: { 'ex-box': box } }, (e) => errors.push(e))
  const f = store.factory
  return {
    store,
    runtime,
    screen,
    errors,
    html: () => toHTML(screen.index, EX + 'page'),
    /** The function rule's evaluations so far. */
    get calls() {
      return calls
    },
    set cost(v: number) {
      cost = v
    },
    retitle(title: string) {
      const source = f.namedNode(EX + 'source')
      const p = f.namedNode(EX + 'title')
      runtime.apply({ remove: store.match(source, p, null), add: [f.quad(source, p, f.literal(title))] })
    },
    /** The page shows `iri` where it showed ex:shown. */
    show(iri: string) {
      const first = f.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#first')
      const cells = store.match(null, first, f.namedNode(EX + 'shown'))
      runtime.apply({ remove: cells, add: cells.map((q) => f.quad(q.subject, first, f.namedNode(EX + iri))) })
    },
  }
}

const many = (n: number) => Array.from({ length: n }, (_, i) => `ex:b${i} a ex:Box .`).join('\n')
const names = (n: number) => Array.from({ length: n }, (_, i) => `ex:b${i}`).join(' ')

describe('a rule that left the engine', () => {
  it('parked for what was not shown: the twin renders it when it is', () => {
    const s = site('ex:shown a ex:Box . ex:later a ex:Box .', 'ex:shown')
    expect(s.html()).toContain('function')
    s.runtime.load(twin)
    expect(s.html()).toContain('twin')
    const calls = s.calls
    s.show('later')
    const html = s.html()
    expect(s.calls).toBe(calls)
    expect(html).not.toContain('function')
    expect(html).toContain('twin')
    expect(s.errors).toEqual([])
    s.runtime.dispose()
  })

  it('warmed in idle time: not evaluated for what it parked', () => {
    const s = site('ex:shown a ex:Box . ex:later a ex:Box .', 'ex:shown')
    s.screen.engine.warmable = () => true
    s.runtime.load(twin)
    const calls = s.calls
    s.screen.engine.warm(50)
    expect(s.calls).toBe(calls)
    s.runtime.dispose()
  })

  it('what it read changes: it does not run again', () => {
    const s = site('ex:shown a ex:Box .', 'ex:shown')
    s.runtime.load(twin)
    const calls = s.calls
    s.retitle('second')
    expect(s.calls).toBe(calls)
    expect(s.html()).not.toContain('function')
    expect(s.errors).toEqual([])
    s.runtime.dispose()
  })

  it.each(['held', 'stopped'] as const)('with %s work: that work is gone with it', (kind) => {
    const n = 10
    const s = site(many(n), names(n))
    s.cost = 100
    s.runtime.watchdog.budgetMs = 250
    s.retitle('second')
    expect(s.screen.engine.heldCount).toBeGreaterThan(0)
    if (kind === 'stopped') {
      s.screen.engine.stopHeld()
      expect(s.screen.engine.stoppedCount).toBeGreaterThan(0)
    }
    s.runtime.watchdog.budgetMs = Infinity
    s.runtime.load(twin)
    expect(s.screen.engine.heldCount).toBe(0)
    expect(s.screen.engine.stoppedCount).toBe(0)
    const calls = s.calls
    s.screen.engine.continueHeld()
    s.screen.engine.retryStopped()
    expect(s.calls).toBe(calls)
    expect(s.html()).not.toContain('function')
    expect(s.html().match(/twin/g)).toHaveLength(n)
    s.runtime.dispose()
  })
})
