// c:GanttChart over a maintained view (charts.ttl, "Gantt"; src/components/gantt.ts): its SPARQL rules
// (the plan, the frame, each task; Screen and Text) render the same HTML and text as their function
// twins on Oxigraph and on Semblance's own engine, after each change the data goes through; a task that
// changes re-renders itself alone, whatever the number of tasks.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { civilDay } from '../src/components/gantt.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD, SEM, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'

const EX = 'https://example.org/#'
const PREFIXES = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sty: <https://semblance.dev/ns/style#> .
@prefix iv: <https://semblance.dev/ns/view#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <https://example.org/#> .
`
const SELECT = `SELECT ?task ?label ?start ?end ?baselineStart ?baselineEnd ?uncertainty ?dependsOn ?milestone ?tone ?href WHERE {
  ?task <https://example.org/#start> ?start ; <https://example.org/#name> ?label .
  OPTIONAL { ?task <https://example.org/#end> ?end } OPTIONAL { ?task <https://example.org/#bs> ?baselineStart } OPTIONAL { ?task <https://example.org/#be> ?baselineEnd }
  OPTIONAL { ?task <https://example.org/#may> ?uncertainty } OPTIONAL { ?task <https://example.org/#after> ?dependsOn }
  OPTIONAL { ?task <https://example.org/#ms> ?milestone } OPTIONAL { ?task <https://example.org/#tone> ?tone } OPTIONAL { ?task <https://example.org/#href> ?href }
} ORDER BY ?start ?task`

const PLAN = `${PREFIXES}
ex:a ex:name "Design" ; ex:start "2026-01-26"^^xsd:date ; ex:end "2026-02-06"^^xsd:date ; ex:bs "2026-01-26"^^xsd:date ; ex:be "2026-02-02"^^xsd:date ; ex:tone sty:Success ; ex:href "/docs" .
ex:b ex:name "Build" ; ex:start "2026-02-09"^^xsd:date ; ex:end "2026-03-20"^^xsd:date ; ex:may "2026-03-31"^^xsd:date ; ex:after ex:a ; ex:href "javascript:alert(1)" .
ex:c ex:name "Docs" ; ex:start "2026-02-16"^^xsd:date ; ex:end "2026-02-27"^^xsd:date ; ex:after ex:a , ex:nobody ; ex:tone ex:NotATone ; ex:href "//elsewhere.example" .
ex:d ex:name "Launch" ; ex:start "2026-04-06T10:00:00Z"^^xsd:dateTime ; ex:after ex:b , ex:c ; ex:ms true ; ex:tone sty:Warning .
ex:e ex:name "Someday" ; ex:start "2026-13-01" .
ex:Plan a sem:View , iv:View ; iv:materialize iv:Graph ; sem:select """${SELECT}""" .
ex:Unordered a sem:View , iv:View ; iv:materialize iv:Graph ;
  sem:select """SELECT ?id ?name ?from ?to WHERE { ?id <https://example.org/#name> ?name ; <https://example.org/#start> ?from . OPTIONAL { ?id <https://example.org/#end> ?to } }""" .
ex:None a sem:View , iv:View ; iv:materialize iv:Graph ; sem:select """SELECT ?task ?start WHERE { ?task <https://example.org/#nothing> ?start }""" .
ex:Plain a sem:View ; rdfs:label "plain view" ; sem:select """${SELECT}""" .

ex:p a c:GanttChart ; c:label "Release" ; c:view ex:Plan ; c:today "2026-02-10"^^xsd:date .
ex:q a c:GanttChart ; c:label "Renamed" ; c:view ex:Unordered ; c:taskVariable "id" ; c:labelVariable "name" ; c:startVariable "from" ; c:endVariable "to" ; c:today "2030-01-01"^^xsd:date .
ex:r a c:GanttChart ; c:view ex:None ; c:emptyText "Nothing planned." .
ex:s a c:GanttChart ; c:view ex:None .
ex:t a c:GanttChart ; c:view ex:Plain .
ex:u a c:GanttChart .
`
const ROOTS = ['p', 'q', 'r', 's', 't', 'u']

type Kind = 'oxigraph' | 'wat'

/** Each chart projected on its own, on screen and as text, with SPARQL or with function rules. */
function mount(turtle: string, kind: Kind, prefer: 'sparql' | 'function', roots: string[], languages: string[] = []) {
  const store = loadStore(kind, turtle)
  const runtime = new Runtime(store)
  const shown = roots.map((root) => {
    const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    const screen = runtime.project({ modality: MOD.Screen, layers: [STY.Layer, SEM.TooltipLayer], prefer, languages, name: root, roots: [EX + root] }, (e) => {
      throw e
    })
    const text = runtime.project({ modality: MOD.Text, layers: [], prefer, languages, name: root + '-text', roots: [EX + root] }, (e) => {
      throw e
    })
    const renderer = new DomRenderer(screen.index, document.getElementById('app')!, EX + root)
    return { renderer, app: document.getElementById('app')!, screen, text, root }
  })
  const f = store.factory
  const date = (v: string) => f.literal(v, f.namedNode('http://www.w3.org/2001/XMLSchema#date'))
  return {
    store,
    runtime,
    shown,
    html: () => shown.map(({ renderer, app }) => (renderer.flush(), app.innerHTML)),
    text: () => shown.map(({ text, root }) => toText(text.index, EX + root)),
    set: (s: string, p: string, o: string | undefined) =>
      runtime.apply({ remove: store.match(f.namedNode(EX + s), f.namedNode(EX + p), null), add: o === undefined ? [] : [f.quad(f.namedNode(EX + s), f.namedNode(EX + p), /^\d/.test(o) ? date(o) : f.literal(o))] }),
    link: (s: string, p: string, o: string) => runtime.apply({ add: [f.quad(f.namedNode(EX + s), f.namedNode(EX + p), f.namedNode(EX + o))], remove: [] }),
  }
}

describe('c:GanttChart', () => {
  it('counts days by the civil calendar', () => {
    expect(civilDay('1970-01-01')).toBe(0)
    expect(civilDay('2000-02-29')).toBe(11016)
    expect(civilDay('2026-10-19T12:00:00Z')).toBe(20745)
    expect(civilDay('1969-12-31')).toBe(-1)
    expect(civilDay('2026-13-01')).toBeUndefined()
    expect(civilDay('26-10-19')).toBeUndefined()
  })

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders in SPARQL as its function twins do, on screen and as text, as the rows change (${kind})`, () => {
      const [s, fn] = [mount(PLAN, kind, 'sparql', ROOTS), mount(PLAN, kind, 'function', ROOTS)]
      const both = (step: (h: typeof s) => void) => {
        step(s)
        step(fn)
        expect(s.html()).toEqual(fn.html())
        expect(s.text()).toEqual(fn.text())
      }
      both(() => {})
      const [p, q, r, sEmpty, t, u] = s.html()
      // Bars, a baseline, a whisker, lead lines, a milestone; tones; safe links only.
      expect(p).toContain('<span style="--first: 20478; --days: 74" class="sem-gantt-plot">')
      expect(p).toContain('data-sem-tone="success"')
      expect(p).toContain('<a href="/docs">Design</a>')
      expect(p).not.toContain('javascript:')
      expect(p).not.toContain('//elsewhere')
      expect(p).toContain('class="sem-gantt-milestone"')
      expect(p).toContain('class="sem-gantt-uncertainty"')
      expect(p.match(/sem-gantt-lead/g)).toHaveLength(3)
      expect(p).toContain('>Today</span>')
      expect(p.match(/sem-gantt-tick/g)).toHaveLength(4)
      expect(q).not.toContain('>Today</span>')
      expect(r).toBe('<p data-sem-c="gantt-chart" class="sem-empty">Nothing planned.</p>')
      expect(sEmpty).toBe('<p data-sem-c="gantt-chart" class="sem-empty">No tasks.</p>')
      expect(t).toContain('plain view is not a maintained view')
      expect(u).toBe('<p data-sem-c="gantt-chart" class="sem-empty">No view.</p>')
      expect(s.text()[0]!.split('\n')).toEqual([
        'Release',
        'Design: 2026-01-26 – 2026-02-06 · Baseline: 2026-01-26 – 2026-02-02',
        'Build: 2026-02-09 – 2026-03-20 · May end by: 2026-03-31 · After Design',
        'Docs: 2026-02-16 – 2026-02-27 · After Design',
        'Launch: 2026-04-06 · Milestone · After Build · After Docs',
        'Someday: Unscheduled',
      ])
      // A task moves (the scale with it), one is added, one loses its end, a dependency goes.
      both((h) => h.set('b', 'end', '2026-05-29'))
      expect(s.text()[0]).toContain('Build: 2026-02-09 – 2026-05-29')
      both((h) => (h.set('f', 'name', 'Retro'), h.set('f', 'start', '2026-01-05'), h.link('f', 'tone', 'NotATone')))
      both((h) => h.set('c', 'end', undefined))
      both((h) => h.set('d', 'after', undefined))
      both((h) => h.set('a', 'name', 'Design and plan'))
      expect(s.text()[0]).toContain('Build: 2026-02-09 – 2026-05-29 · May end by: 2026-03-31 · After Design and plan')
      // Every row goes: the message; one comes back.
      both((h) => ['a', 'b', 'c', 'd', 'e', 'f'].forEach((x) => h.set(x, 'start', undefined)))
      expect(s.html()[0]).toBe('<p data-sem-c="gantt-chart" class="sem-empty">No tasks.</p>')
      both((h) => h.set('a', 'start', '2026-03-02'))
      expect(s.html()[0]).toContain('Design and plan')
    }, 60_000)
  }

  it('speaks the viewer\'s language, and runs right to left in Arabic', () => {
    for (const languages of [['uk'], ['ar']]) {
      const [s, fn] = [mount(PLAN, 'wat', 'sparql', ['p'], languages), mount(PLAN, 'wat', 'function', ['p'], languages)]
      expect(s.html()).toEqual(fn.html())
      expect(s.text()).toEqual(fn.text())
      if (languages[0] === 'uk') expect(s.text()[0]).toContain('Після Design')
      else expect(s.html()[0]).toContain('>اليوم</span>')
    }
  })

  it('re-renders only the task that changed, whatever the number of tasks (wat, SPARQL)', () => {
    const cost = (n: number) => {
      const tasks = Array.from({ length: n }, (_, i) => `ex:t${i} ex:name "Task ${i}" ; ex:start "2026-03-${String((i % 20) + 1).padStart(2, '0')}"^^xsd:date ; ex:end "2026-03-${String((i % 20) + 5).padStart(2, '0')}"^^xsd:date .`).join('\n')
      const h = mount(`${PREFIXES}\n${tasks}\nex:Plan a sem:View , iv:View ; iv:materialize iv:Graph ; sem:select """${SELECT}""" .\nex:p a c:GanttChart ; c:view ex:Plan ; c:today "2026-03-10"^^xsd:date .`, 'wat', 'sparql', ['p'])
      h.html()
      const { engine } = h.shown[0]!.screen
      const runs = () => [...engine.stats.byRule.entries()].filter(([rule]) => /GanttTaskRendering/.test(rule)).reduce((a, [, s]) => a + s.runs, 0)
      const before = { written: engine.stats.derivedAdded + engine.stats.derivedRemoved, tasks: runs() }
      // Within the scale: the frame and the other tasks stay as they are.
      h.set('t3', 'end', '2026-03-13')
      h.html()
      return { written: engine.stats.derivedAdded + engine.stats.derivedRemoved - before.written, tasks: runs() - before.tasks }
    }
    const small = cost(10)
    const large = cost(80)
    expect(small.tasks).toBe(1)
    expect(large).toEqual(small)
  }, 60_000)
})
