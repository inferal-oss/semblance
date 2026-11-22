// The workbench's Plan tab for any query (#588): a query run on request that asks for its plan
// (iv:explain) carries the plan it would be maintained by - iv:planned and its operators, or why it
// would be recomputed - compiled only. Nothing is maintained or evaluated for it: compiling runs no
// query, a change to the data runs nothing, and no partition is built. With Follow updates on, the
// tab says how it is maintained and the work of each change, in the viewer's language.
import { describe, expect, it } from 'vitest'
import { EX } from '../src/examples/todo.ts'
import { loadStoreOf } from '../src/node/load.ts'
import { NS } from '../src/ns.ts'
import { compiler } from '../src/view/compile.ts'
import type { SparqlRunner, ViewCompiler } from '../src/view/plan.ts'
import { VIEW_GRAPH, ViewRuntime } from '../src/view/runtime.ts'
import { mountShell } from './harness.ts'

const IV = NS.iv
const V = 'https://example.org/v#'
const UI = 'https://semblance.dev/demo#'

const DATA = `
@prefix v: <${V}> .
@prefix sem: <https://semblance.dev/ns/core#> .
@prefix iv: <https://semblance.dev/ns/view#> .
v:a v:kind v:x ; v:n 1 .
v:b v:kind v:y ; v:n 2 .
v:explained a iv:View ; iv:strategy iv:OnRequest ; iv:materialize iv:ResultSet ; iv:explain true ;
  sem:select """SELECT ?kind (COUNT(?s) AS ?count) WHERE { ?s <${V}kind> ?kind } GROUP BY ?kind""" .
v:recomputed a iv:View ; iv:strategy iv:OnRequest ; iv:materialize iv:ResultSet ; iv:explain true ;
  sem:select """SELECT ?s WHERE { ?s <${V}n> ?n FILTER(?n < STRLEN(STR(NOW()))) }""" .
v:plain a iv:View ; iv:strategy iv:OnRequest ; iv:materialize iv:ResultSet ;
  sem:select """SELECT ?s WHERE { ?s <${V}n> ?n }""" .
`

describe('the plan of a query run on request (iv:explain)', () => {
  /** A view runtime whose compiler counts the queries it runs (it runs none) and whose store counts SPARQL runs. */
  function setup() {
    const store = loadStoreOf('wat', [], DATA)
    const compiled = { queries: 0, plans: 0 }
    const counting: ViewCompiler = {
      compile(source, run) {
        compiled.plans++
        const spy: SparqlRunner = {
          factory: run.factory,
          timestampPath: (s) => run.timestampPath(s),
          select: (q) => (compiled.queries++, run.select(q)),
          construct: (q) => (compiled.queries++, run.construct(q)),
        }
        return compiler.compile(source, spy)
      },
    }
    const runs = { n: 0 }
    const { select, construct } = store
    store.select = (...args) => (runs.n++, select.apply(store, args))
    store.construct = (...args) => (runs.n++, construct.apply(store, args))
    const rt = new ViewRuntime(store, { graphs: [], compiler: counting })
    rt.start()
    const f = store.factory
    const g = f.namedNode(VIEW_GRAPH)
    const objects = (s: string, p: string) => store.match(f.namedNode(V + s), f.namedNode(IV + p), null, g).map((q) => q.object.value)
    return { store, rt, compiled, runs, objects, f }
  }

  it('writes the plan it would be maintained by - its operators - compiled only', () => {
    const { rt, compiled, objects } = setup()
    expect(rt.view(V + 'explained')!.strategy).toBe('on request')
    expect(objects('explained', 'strategy')).toEqual([IV + 'OnRequest'])
    expect(objects('explained', 'planned')).toEqual([IV + 'Incremental'])
    expect(objects('explained', 'operator').length).toBeGreaterThan(1)
    // A query the compiler cannot maintain: why it would be recomputed, and no operators.
    expect(objects('recomputed', 'planned')).toEqual([IV + 'Recompute'])
    expect(objects('recomputed', 'fallback')[0]).toMatch(/NOW/)
    expect(objects('recomputed', 'operator')).toEqual([])
    // A query that does not ask: no plan, as before.
    expect(objects('plain', 'planned')).toEqual([])
    expect(objects('plain', 'operator')).toEqual([])
    // Compiling ran no query against the store.
    expect(compiled.plans).toBeGreaterThanOrEqual(2)
    expect(compiled.queries).toBe(0)
  })

  it('maintains and evaluates nothing for it: a change to the data runs no query and builds no partition', () => {
    const { store, rt, compiled, runs, f } = setup()
    const partitions = rt.totals.partitions
    const before = runs.n
    const add = [f.quad(f.namedNode(V + 'c'), f.namedNode(V + 'kind'), f.namedNode(V + 'x'))]
    for (const q of add) store.add(q)
    rt.tick({ add, remove: [] })
    expect(runs.n - before).toBe(0)
    expect(rt.totals.partitions).toBe(partitions)
    expect(compiled.queries).toBe(0)
  })
})

describe('the workbench Plan tab (ui:queryPlanTab)', () => {
  type Shell = ReturnType<typeof mountShell>
  const frame = () => new Promise<void>((r) => setTimeout(r, 0))
  function workbench(prefer: 'sparql' | 'function' = 'sparql'): Shell {
    const h = mountShell(5, 'wat', prefer)
    h.runtime.refreshShare = 1
    h.fire([...h.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Query')!, 'click')
    return h
  }
  const q = (h: Shell, sel: string) => h.document.querySelector(`[data-sem-c=query-workbench] ${sel}`)
  const tab = (h: Shell, label: string) => h.fire([...h.document.querySelectorAll('[data-sem-c=query-workbench] [role=tab]')].find((t) => t.textContent === label)!, 'click')
  const plan = (h: Shell) => h.shell.nodeOf(UI + 'queryPlan/~root') as Element | null
  const summary = (h: Shell) => plan(h)!.querySelector('[data-sem-c=text]')!.textContent
  const planRows = (h: Shell) => [...(plan(h)?.querySelectorAll('[data-sem-c=result-table] tbody tr') ?? [])].map((tr) => tr.textContent)
  const sample = (h: Shell, label: string) =>
    h.fire([...h.document.querySelectorAll('.sem-sample')].find((b) => b.querySelector('.sem-sample-label')!.textContent === label)!, 'click')
  const type = (h: Shell, text: string) => {
    const ta = q(h, '[data-sem-c=query-editor] textarea') as HTMLTextAreaElement
    ta.value = text
    Object.assign(ta, { selectionStart: text.length, selectionEnd: text.length })
    h.fire(ta, 'input')
  }
  const settle = async (h: Shell) => {
    await frame()
    h.shell.flush()
  }

  it('off: the plan the query would be maintained by, with its operators, and nothing maintained', async () => {
    const h = workbench()
    sample(h, 'The todo items')
    const view = h.runtime.views.view(UI + 'currentQuery')!
    expect(view.strategy).toBe('on request')
    tab(h, 'Plan')
    await settle(h)
    expect(summary(h)).toBe('Runs on request. With Follow updates on, it is maintained incrementally by the operators below: each change costs what it changes.')
    expect(planRows(h).some((r) => r.includes('iv:Partition'))).toBe(true)
    expect(planRows(h).some((r) => r.includes('iv:Sink'))).toBe(true)
    // A change to the data: no partition, no run (the plan was compiled, never built).
    const f = h.store.factory
    const s = f.namedNode(EX + 't1')
    const p = f.namedNode(EX + 'done')
    h.runtime.apply({ remove: h.store.match(s, p, null), add: [f.quad(s, p, f.literal('false', f.namedNode(NS.xsd + 'boolean')))] })
    await settle(h)
    // The same view, never stepped: no partition evaluated, no tick of work, no run again.
    expect(h.runtime.views.view(UI + 'currentQuery')).toBe(view)
    expect(view.figures.partitions).toBe(0)
    expect(view.figures.ticks).toBe(0)
    expect(view.strategy).toBe('on request')
    // Following: maintained, and the summary says so.
    h.fire(q(h, '[data-sem-c=toggle-switch] [role=switch]')!, 'click')
    await settle(h)
    expect(summary(h)).toMatch(/^Maintained incrementally: each change costs what it changes\./)
    expect(planRows(h).some((r) => r.includes('iv:Partition'))).toBe(true)
  })

  it('off, a query the compiler cannot maintain: why it would be recomputed', async () => {
    const h = workbench()
    type(h, 'SELECT ?s ?l WHERE { ?s rdfs:label ?l FILTER(STRLEN(?l) < STRLEN(STR(NOW()))) } LIMIT 3')
    h.fire(q(h, '.sem-toolbar button')!, 'click')
    tab(h, 'Plan')
    await settle(h)
    expect(summary(h)).toMatch(/^Runs on request\. With Follow updates on, it is recomputed from scratch when a triple it reads changes: .*NOW/)
    expect(planRows(h)).toEqual([])
  })

  it('the same with function rules: c:Formula and its twin read the same view', async () => {
    const shown = async (prefer: 'sparql' | 'function') => {
      const h = workbench(prefer)
      sample(h, 'The todo items')
      tab(h, 'Plan')
      await settle(h)
      return [summary(h), planRows(h)]
    }
    expect(await shown('function')).toEqual(await shown('sparql'))
  })

  it("in the viewer's language", async () => {
    const h = workbench()
    sample(h, 'The todo items')
    h.screen.engine.reconfigure({ languages: ['uk'] })
    h.shell.flush()
    tab(h, 'План')
    await settle(h)
    expect(summary(h)).toBe('Виконується на запит. Зі стеженням за змінами його підтримують інкрементно оператори нижче: кожна зміна коштує стільки, скільки змінює.')
  })
})
