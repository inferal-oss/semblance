// The result graph in SPARQL (#7): its layout is data first (ontology/components/result-graph.ttl):
// parts of the run, names, the nodes kept, the links among them, a layer per node (each node reads
// its parents'), the shape, the ring and the rows (each layer reads its parents' places). The
// drawing (c:ResultGraphRendering-sparql) reads it, and is the same as the function twin's, byte for
// byte, after each step: a run, a new triple followed, a binding, a selection, another language.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { mountShell } from './harness.ts'
import { Runtime } from '../src/runtime.ts'

const EX = 'https://example.org/#'

// A tree (layers), a hub with near and far nodes (a ring), a cycle (a ring with no hub), a crowded
// hub (alternating radii), rows of a SELECT (a hub per row, literals, a blank node), a cap (c:limit).
const DATA = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <https://example.org/#> .

ex:prefixes sh:declare [ sh:prefix "ex" ; sh:namespace "https://example.org/#"^^xsd:anyURI ] .
ex:A rdfs:subClassOf ex:Root . ex:B rdfs:subClassOf ex:Root . ex:C rdfs:subClassOf ex:A . ex:D rdfs:subClassOf ex:A , ex:B .
ex:E rdfs:subClassOf ex:D . ex:F rdfs:subClassOf ex:B . ex:G rdfs:subClassOf ex:C , ex:F .

ex:hub ex:knows ex:n1 , ex:n2 , ex:n3 , ex:n4 , ex:n5 . ex:n1 ex:knows ex:f1 . ex:n2 ex:knows ex:f1 , ex:f2 . ex:n3 ex:likes ex:f3 .
ex:f4 ex:knows ex:f5 . ex:n5 ex:knows ex:hub .

ex:c1 ex:next ex:c2 . ex:c2 ex:next ex:c3 . ex:c3 ex:next ex:c4 . ex:c4 ex:next ex:c1 .

ex:big ex:has ex:b01 , ex:b02 , ex:b03 , ex:b04 , ex:b05 , ex:b06 , ex:b07 , ex:b08 , ex:b09 , ex:b10 , ex:b11 , ex:b12 , ex:b13 , ex:b14 , ex:b15 , ex:b16 .
ex:b01 ex:has ex:x1 . ex:b07 ex:has ex:x2 . ex:b07 ex:has ex:x1 . ex:b16 ex:has ex:x3 . ex:x4 ex:has ex:x5 .

ex:alice ex:name "Alice" ; ex:age 31 ; ex:note "Hi"@en ; ex:knows ex:bob , _:someone .
ex:bob ex:name "Bob" ; ex:age 4 ; ex:knows ex:alice .
ex:carol ex:name "Carol" ; ex:age 31 .

ex:qTree a sem:Query ; sem:construct """CONSTRUCT { ?s rdfs:subClassOf ?o } WHERE { ?s rdfs:subClassOf ?o FILTER(STRSTARTS(STR(?s), STR(ex:))) }""" .
ex:qHub a sem:Query ; sem:select """SELECT ?s ?p ?o WHERE { ?s ?p ?o FILTER(?p IN (ex:knows, ex:likes)) FILTER(?s IN (ex:hub, ex:n1, ex:n2, ex:n3, ex:n4, ex:n5, ex:f4)) }""" .
ex:qCycle a sem:Query ; sem:construct """CONSTRUCT { ?s ex:next ?o } WHERE { ?s ex:next ?o }""" .
ex:qBig a sem:Query ; sem:construct """CONSTRUCT { ?s ex:has ?o } WHERE { ?s ex:has ?o }""" .
ex:qRows a sem:Query ; sem:select """SELECT ?person ?name ?age ?friend WHERE { ?person ex:name ?name OPTIONAL { ?person ex:age ?age } OPTIONAL { ?person ex:knows ?friend } } ORDER BY ?name""" .

ex:tree a c:ResultGraph ; c:of ex:qTree .
ex:hubGraph a c:ResultGraph ; c:of ex:qHub .
ex:cycle a c:ResultGraph ; c:of ex:qCycle .
ex:big a c:ResultGraph ; c:of ex:qBig .
ex:rows a c:ResultGraph ; c:of ex:qRows .
ex:capped a c:ResultGraph ; c:of ex:qBig ; c:limit 6 .

ex:qLive a sem:Query ; sem:construct """CONSTRUCT { ?s rdfs:subClassOf ?o } WHERE { ?s rdfs:subClassOf ?o FILTER(STRSTARTS(STR(?s), STR(ex:))) }""" .
ex:qBound a sem:Query ; sem:select """SELECT ?p ?o WHERE { $who ?p ?o } ORDER BY ?p""" .
ex:qAsk a sem:Query ; sem:select """ASK { ex:alice ex:knows ex:bob }""" .
ex:qBroken a sem:Query ; sem:select """SELECT ?x WHERE { ?x ex:name """ .
ex:qNone a sem:Query ; sem:select """SELECT ?x ?y WHERE { ?x ex:nothing ?y }""" .
ex:pick ex:unused ex:nothing .
ex:live a c:ResultGraph ; c:of ex:qLive ; c:followUpdates true .
ex:bound a c:ResultGraph ; c:of ex:qBound ; c:bindVariable "who" ; c:bindFrom ex:pick ; c:bindProperty ex:who ; c:emptyText "Pick someone." .
ex:ask a c:ResultGraph ; c:of ex:qAsk .
ex:broken a c:ResultGraph ; c:of ex:qBroken .
ex:none a c:ResultGraph ; c:of ex:qNone .
ex:notRun a c:ResultGraph .
`

const ROOTS = ['tree', 'hubGraph', 'cycle', 'big', 'rows', 'capped', 'live', 'bound', 'ask', 'broken', 'none', 'notRun']

function mount(prefer: 'sparql' | 'function') {
  const store = loadStore('wat', DATA)
  const runtime = new Runtime(store)
  const shown = ROOTS.flatMap((root) =>
    [MOD.Screen, MOD.Text].map((modality) => {
      const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
      const screen = runtime.project({ modality, layers: [STY.Layer], prefer, name: `${root}-${modality.slice(-4)}`, roots: [EX + root] }, (e) => {
        throw e
      })
      const renderer = new DomRenderer(screen.index, document.getElementById('app')!, EX + root)
      return { renderer, app: document.getElementById('app')!, screen }
    }),
  )
  const at = (root: string, modality: 'screen' | 'text' = 'screen') => shown[ROOTS.indexOf(root) * 2 + (modality === 'screen' ? 0 : 1)]!
  return {
    store,
    runtime,
    screen: (root: string) => at(root).screen,
    screens: () => shown.map((x) => x.screen),
    set: (s: string, p: string, o: string | number) => {
      const f = store.factory
      const n = (x: string) => f.namedNode(x.startsWith('http') ? x : EX + x)
      runtime.apply({ remove: store.match(n(s), n(p), null), add: [f.quad(n(s), n(p), typeof o === 'number' ? f.literal(String(o), f.namedNode('http://www.w3.org/2001/XMLSchema#integer')) : n(o))] })
    },
    add: (s: string, p: string, o: string) => {
      const f = store.factory
      const n = (x: string) => f.namedNode(x.startsWith('http') ? x : EX + x)
      runtime.apply({ add: [f.quad(n(s), n(p), n(o))], remove: [] })
    },
    remove: (s: string, p: string, o: string) => {
      const f = store.factory
      const n = (x: string) => f.namedNode(x.startsWith('http') ? x : EX + x)
      runtime.apply({ remove: store.match(n(s), n(p), n(o)), add: [] })
    },
    html: (root: string, modality: 'screen' | 'text' = 'screen') => {
      const { renderer, app } = at(root, modality)
      renderer.flush()
      return app.innerHTML
    },
  }
}

/** Where the drawing puts each node (its mark's id: n + the key's MD5), from the rendered dots. */
function drawn(html: string): Map<string, string> {
  const { document } = parseHTML(`<div>${html}</div>`)
  const out = new Map<string, string>()
  for (const g of document.querySelectorAll('.sem-node')) {
    const dot = g.querySelector('circle, rect')!
    const at = dot.tagName.toLowerCase() === 'circle' ? `${dot.getAttribute('cx')},${dot.getAttribute('cy')}` : `${Number(dot.getAttribute('x')) + 6},${Number(dot.getAttribute('y')) + 6}`
    out.set(g.querySelector('.sem-node-label')!.textContent!, at)
  }
  return out
}

/** Where the building blocks place each node (c:x, c:y), by label. */
function placed(store: ReturnType<typeof loadStore>, root: string): Map<string, string> {
  const f = store.factory
  const out = new Map<string, string>()
  for (const q of store.match(null, f.namedNode(NS.c + 'graphNodeIn'), f.namedNode(EX + root))) {
    if (!store.match(q.subject, f.namedNode(NS.rdf + 'type'), f.namedNode(NS.c + 'GraphNode')).length) continue
    const v = (p: string) => store.match(q.subject, f.namedNode(NS.c + p), null)[0]?.object.value
    out.set(v('nodeLabel') ?? q.subject.value, `${v('x')},${v('y')}`)
  }
  return out
}

/** The first difference between two texts, with some context. */
function diff(a: string, b: string): string {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return `at ${i}:\n  sparql:   ${a.slice(Math.max(0, i - 120), i + 160)}\n  function: ${b.slice(Math.max(0, i - 120), i + 160)}`
}

describe('the result graph in SPARQL', () => {
  it('draws what the function twin draws, on screen and as text', () => {
    const [sp, fn] = [mount('sparql'), mount('function')]
    for (const root of ROOTS)
      for (const m of ['screen', 'text'] as const) {
        const [a, b] = [sp.html(root, m), fn.html(root, m)]
        expect(a.length, `${root} ${m}`).toBeGreaterThan(40)
        if (a !== b) expect.fail(`${root} ${m} ${diff(a, b)}`)
      }
    // The SPARQL rules drew it.
    expect(sp.html('ask')).toContain('Nothing to draw')
    expect(sp.html('broken')).toContain('The query failed')
    expect(sp.html('bound')).toContain('Pick someone.')
    expect(sp.html('none')).toContain('Nothing to draw')
    expect(sp.html('tree')).toContain('rdfs:subClassOf')
    expect(sp.screen('tree').engine.stats.byRule.get(NS.c + 'ResultGraphRendering-sparql')?.runs ?? 0).toBeGreaterThan(0)
  })
})

const RDFS_SUB = 'http://www.w3.org/2000/01/rdf-schema#subClassOf'

describe('the result graph in SPARQL, step by step', () => {
  it('draws what the function twin draws after every step', () => {
    const [sp, fn] = [mount('sparql'), mount('function')]
    const same = (what: string) => {
      // A followed run is written at the next refresh.
      for (const h of [sp, fn]) h.runtime.refresh()
      for (const root of ROOTS)
        for (const m of ['screen', 'text'] as const) {
          const [a, b] = [sp.html(root, m), fn.html(root, m)]
          if (a !== b) expect.fail(`${what}: ${root} ${m} ${diff(a, b)}`)
        }
    }
    const both = (what: string, step: (h: typeof sp) => void) => {
      step(sp)
      step(fn)
      same(what)
    }
    same('first')
    // The followed tree grows a leaf, then a new source above it all, then a cycle (a ring), and back.
    both('a leaf', (h) => h.add('H', RDFS_SUB, 'G'))
    expect(sp.html('live')).toContain('ex:H')
    both('a new source', (h) => h.add('Root', RDFS_SUB, 'Top'))
    both('a cycle', (h) => h.add('Top', RDFS_SUB, 'G'))
    both('no cycle', (h) => h.remove('Top', RDFS_SUB, 'G'))
    // A binding: someone, then someone else.
    both('alice', (h) => h.set('pick', 'who', 'alice'))
    expect(sp.html('bound')).toContain('?o')
    both('bob', (h) => h.set('pick', 'who', 'bob'))
    // Fewer nodes kept, then more; a run again.
    both('limit 3', (h) => h.set('capped', 'https://semblance.dev/ns/component#limit', 3))
    both('limit 12', (h) => h.set('capped', 'https://semblance.dev/ns/component#limit', 12))
    both('run again', (h) => h.set('tree', 'https://semblance.dev/ns/component#runCount', 2))
    // A selection (the selection rule over the SPARQL drawing), its neighbourhood, none.
    both('select', (h) => h.set('tree', 'https://semblance.dev/ns/component#selectedTerm', 'D'))
    expect(sp.html('tree')).toContain('data-sem-salience="focused"')
    both('neighbourhood 2', (h) => h.set('tree', 'https://semblance.dev/ns/component#neighbourhood', 2))
    both('select a hub', (h) => h.set('hubGraph', 'https://semblance.dev/ns/component#selectedTerm', 'hub'))
    // Every language.
    for (const languages of [['uk'], ['de'], ['ar'], ['en']]) {
      for (const h of [sp, fn]) for (const x of h.screens()) x.engine.reconfigure({ languages })
      same(languages.join())
    }
  })

  it('a new link re-layers only what it changes', () => {
    const sp = mount('sparql')
    sp.html('live')
    const runs = (rule: string) => sp.screen('live').engine.stats.byRule.get(NS.c + rule)?.runs ?? 0
    const step = (what: () => void) => {
      const before = { layers: runs('ResultGraphLayers-sparql'), rows: runs('ResultGraphRows-sparql') }
      what()
      sp.runtime.refresh()
      sp.html('live')
      return { layers: runs('ResultGraphLayers-sparql') - before.layers, rows: runs('ResultGraphRows-sparql') - before.rows }
    }
    // A new node below the root (a superclass of it): it gets a layer and a row; the 9 nodes and 5 rows
    // above it stay (a node or row next to it may be read again, nothing more).
    const below = step(() => sp.add('Root', RDFS_SUB, 'Top'))
    expect(below.layers).toBeLessThanOrEqual(2)
    expect(below.rows).toBeLessThanOrEqual(3)
    expect(sp.html('live')).toContain('ex:Top')
    // A new subclass of G is a new source: G and everything below it (nearly all 11) move down a layer,
    // each read at most twice (when its parent's layer goes, and when the new one comes).
    const moved = step(() => sp.add('H', RDFS_SUB, 'G'))
    expect(moved.layers).toBeLessThanOrEqual(2 * 11)
  })
})

describe('the result graph laid out as data', () => {
  it('places every node where the function twin draws it', () => {
    const fn = mount('function')
    for (const root of ROOTS.slice(0, 7)) {
      const want = drawn(fn.html(root))
      expect(want.size, root).toBeGreaterThan(0)
      expect(Object.fromEntries(placed(fn.store, root)), root).toEqual(Object.fromEntries(want))
    }
  })
})

// The site's result graphs (the workbench's, the gallery's) on Semblance's own engine: every sample's
// graph, and selecting a node in it, drawn the same by the SPARQL rules and the function twins.
describe('the site\'s result graphs, SPARQL and function rules alike (wat)', () => {
  const UI = 'https://semblance.dev/demo#'
  type Shell = ReturnType<typeof mountShell>
  const graphOf = (h: Shell) => h.document.querySelector('[data-sem-c=query-workbench] [data-sem-c=result-graph]')?.outerHTML ?? ''
  const clickTab = (h: Shell, name: string) => h.fire([...h.document.querySelectorAll('[data-sem-c=query-workbench] [role=tab]')].find((t) => t.textContent === name)!, 'click')

  it('draws every sample\'s graph the same, and a selection in it', () => {
    const hs = (['sparql', 'function'] as const).map((prefer) => {
      const h = mountShell(5, 'wat', prefer)
      h.fire([...h.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Query')!, 'click')
      return h
    })
    const labels = [...hs[0]!.document.querySelectorAll('.sem-sample-label')].map((l) => l.textContent!)
    expect(labels.length).toBeGreaterThan(5)
    for (const label of labels) {
      for (const h of hs) {
        h.fire([...h.document.querySelectorAll('.sem-sample')].find((b) => b.querySelector('.sem-sample-label')!.textContent === label)!, 'click')
        clickTab(h, 'Graph')
      }
      const [a, b] = hs.map(graphOf)
      expect(a.length, label).toBeGreaterThan(0)
      if (a !== b) expect.fail(`${label}: ${diff(a, b)}`)
    }
    // A node selected: the selection rule over either drawing.
    for (const h of hs) {
      h.fire([...h.document.querySelectorAll('.sem-sample')].find((b) => b.querySelector('.sem-sample-label')!.textContent === 'How c:Tabs is made')!, 'click')
      clickTab(h, 'Graph')
      h.fire([...h.document.querySelectorAll('[data-sem-c=result-graph] .sem-node')].find((n) => n.querySelector('.sem-node-label')!.textContent === 'c:Tabs')!, 'click')
    }
    const [a, b] = hs.map(graphOf)
    expect(a).toContain('data-sem-salience="focused"')
    if (a !== b) expect.fail(`selected: ${diff(a, b)}`)
    // The SPARQL rules drew them.
    expect(hs[0]!.screen.engine.stats.byRule.get(NS.c + 'ResultGraphRendering-sparql')?.runs ?? 0).toBeGreaterThan(0)
  })

  it('draws the gallery\'s graph the same', () => {
    const hs = (['sparql', 'function'] as const).map((prefer) => {
      const h = mountShell(5, 'wat', prefer)
      const f = h.store.factory
      const set = (s: string, p: string, o: string) => h.runtime.apply({ remove: h.store.match(f.namedNode(s), f.namedNode(p), null), add: [f.quad(f.namedNode(s), f.namedNode(p), f.namedNode(o))] })
      set(UI + 'in-results-tabs', NS.c + 'selected', UI + 'in-results-graph-tab')
      h.showPage('Components')
      set(UI + 'app', UI + 'galleryGroup', UI + 'GroupInspection')
      h.shell.flush()
      return h
    })
    const [a, b] = hs.map((h) => h.document.querySelector('[data-sem-c=result-graph]')?.outerHTML ?? '')
    expect(a).toContain('sem-node')
    if (a !== b) expect.fail(diff(a, b))
  })
})
