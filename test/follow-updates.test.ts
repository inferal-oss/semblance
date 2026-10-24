import { describe, expect, it } from 'vitest'
import { EX } from '../src/examples/todo.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS, SEM, SPARQL_PREFIXES } from '../src/ns.ts'
import { type Backend, memoryBackend } from '../src/persistence.ts'
import { Runtime } from '../src/runtime.ts'
import { queryReads } from '../src/sparql-reads.ts'
import type { FnRule } from '../src/engine/context.ts'
import { mountRemembering, mountShell } from './harness.ts'

// "Follow updates" in the SPARQL workbench: with c:followUpdates true on the workbench, its result
// views depend on the triples their query reads, and re-run at the next frame when one changes.

const UI = 'https://semblance.dev/demo#'
const C = NS.c
type Shell = ReturnType<typeof mountShell>

/** The shell (Semblance's own WASM store, SPARQL rules) with the Playground's Query tab shown. */
function workbench(): Shell {
  const h = mountShell(5, 'wat', 'sparql')
  // No spacing between refreshes here: each test says when a frame passes.
  h.runtime.refreshShare = 1
  h.fire([...h.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Query')!, 'click')
  return h
}

const q = (h: Shell, sel: string) => h.document.querySelector(`[data-sem-c=query-workbench] ${sel}`)
const followSwitch = (h: Shell) => q(h, '[data-sem-c=toggle-switch] [role=switch]')!
const live = (h: Shell) => q(h, '.sem-toolbar [data-sem-c=live-indicator]')
const rows = (h: Shell) => [...h.document.querySelectorAll('[data-sem-c=query-workbench] [data-sem-c=result-table] tbody tr')].map((tr) => tr.textContent)
const sample = (h: Shell, label: string) =>
  h.fire([...h.document.querySelectorAll('.sem-sample')].find((b) => b.querySelector('.sem-sample-label')!.textContent === label)!, 'click')
const runs = (h: Shell, rule = 'ResultTableRendering-fn') => h.screen.engine.stats.byRule.get(C + rule)?.runs ?? 0
const following = (h: Shell) => h.store.match(h.store.factory.namedNode(UI + 'workbench'), h.store.factory.namedNode(C + 'followUpdates'), null)[0]?.object.value
/** A frame passes (here: the microtask the runtime schedules its refresh in). */
const frame = () => new Promise<void>((r) => setTimeout(r, 0))

function setDone(h: Shell, item: string, done: boolean) {
  const f = h.store.factory
  const s = f.namedNode(EX + item)
  const p = f.namedNode(EX + 'done')
  h.runtime.apply({ remove: h.store.match(s, p, null), add: [f.quad(s, p, f.literal(String(done), f.namedNode(NS.xsd + 'boolean')))] })
}

function type(h: Shell, text: string) {
  const ta = q(h, '[data-sem-c=query-editor] textarea') as HTMLTextAreaElement
  ta.value = text
  Object.assign(ta, { selectionStart: text.length, selectionEnd: text.length })
  h.fire(ta, 'input')
}

describe('following updates in the SPARQL workbench (c:followUpdates)', () => {
  it('is a switch in the toolbar, off by default; on, a live indicator shows', () => {
    const h = workbench()
    expect(followSwitch(h).getAttribute('aria-checked')).toBe('false')
    expect(followSwitch(h).textContent).toBe('Follow updates')
    expect(live(h)).toBeNull()
    h.fire(followSwitch(h), 'click')
    expect(following(h)).toBe('true')
    expect(followSwitch(h).getAttribute('aria-checked')).toBe('true')
    expect(live(h)!.getAttribute('data-live')).toBe('true')
    expect(live(h)!.textContent).toBe('Live')
    // Pressing the indicator stops following, like the switch.
    h.fire(live(h)!, 'click')
    expect(following(h)).toBe('false')
    expect(live(h)).toBeNull()
    expect(followSwitch(h).getAttribute('aria-checked')).toBe('false')
  })

  it('on: a change to what the query reads updates the results, at the next frame, once for many changes', async () => {
    const h = workbench()
    sample(h, 'The todo items')
    h.fire(followSwitch(h), 'click')
    const before = rows(h)
    const t1 = before.find((r) => r.includes('Write the core ontology'))!
    expect(t1).toMatch(/true$/)
    const ran = runs(h)
    setDone(h, 't1', false)
    setDone(h, 't2', true)
    // The change itself does not wait for the query.
    expect(runs(h)).toBe(ran)
    expect(rows(h)).toEqual(before)
    await frame()
    expect(runs(h)).toBe(ran + 1)
    expect(rows(h).find((r) => r.includes('Write the core ontology'))).toMatch(/false$/)
    expect(rows(h)).not.toEqual(before)
    // A new item is read too (ex:todos c:item).
    const f = h.store.factory
    const item = f.namedNode(EX + 'followed')
    h.runtime.apply({
      remove: [],
      add: [
        f.quad(f.namedNode(EX + 'todos'), f.namedNode(C + 'item'), item),
        f.quad(item, f.namedNode(NS.rdfs + 'label'), f.literal('A followed item')),
        f.quad(item, f.namedNode(EX + 'priority'), f.literal('99', f.namedNode(NS.xsd + 'integer'))),
        f.quad(item, f.namedNode(EX + 'done'), f.literal('false', f.namedNode(NS.xsd + 'boolean'))),
      ],
    })
    await frame()
    expect(rows(h).some((r) => r.includes('A followed item'))).toBe(true)
    expect(runs(h)).toBe(ran + 2)
  })

  it('on: changes to anything the query does not read re-run nothing', async () => {
    const h = workbench()
    sample(h, 'The todo items')
    h.fire(followSwitch(h), 'click')
    const ran = { table: runs(h), graph: runs(h, 'ResultGraphRendering-fn'), turtle: runs(h, 'ResultTurtleRendering-fn') }
    // Typing (the editor's c:value, c:caret: re-rendered, logged), the theme, a todo's position.
    type(h, 'SELECT ?x WHERE { ?x a c:Tab }')
    type(h, 'SELECT ?x WHERE { ?x a c:Tabs }')
    h.runtime.apply({ remove: [], add: [h.store.factory.quad(h.store.factory.namedNode(EX + 't1'), h.store.factory.namedNode(NS.c + 'note'), h.store.factory.literal('unread'))] })
    expect(h.screen.engine.hasStale).toBe(false)
    await frame()
    expect({ table: runs(h), graph: runs(h, 'ResultGraphRendering-fn'), turtle: runs(h, 'ResultTurtleRendering-fn') }).toEqual(ran)
  })

  it('a busy graph costs one run a frame: the change log, followed while typing', async () => {
    const h = workbench()
    sample(h, 'The change log, newest first')
    h.fire(followSwitch(h), 'click')
    await frame()
    const ran = runs(h)
    const newest = () => rows(h)[0]
    const first = newest()
    for (let i = 0; i < 6; i++) type(h, `SELECT ?x WHERE { ?x a c:Tab } LIMIT ${i}`)
    expect(runs(h)).toBe(ran)
    await frame()
    expect(runs(h)).toBe(ran + 1)
    expect(newest()).not.toBe(first)
    expect(newest()).toMatch(/Input/)
  })

  it('a slow refresh spaces the next one out, so following never takes over', () => {
    const h = workbench()
    h.runtime.refreshShare = 0.25
    const frames: (() => void)[] = []
    h.runtime.frame = (run) => void frames.push(run)
    sample(h, 'The todo items')
    h.fire(followSwitch(h), 'click')
    setDone(h, 't1', false)
    expect(frames.length).toBe(1)
    setDone(h, 't2', true)
    expect(frames.length).toBe(1)
    const ran = runs(h)
    frames.shift()!()
    expect(runs(h)).toBe(ran + 1)
    // As if that refresh took long: the next waits (a timer), then for a frame.
    ;(h.runtime as unknown as { refreshAfter: number }).refreshAfter = performance.now() + 60_000
    setDone(h, 't1', true)
    expect(frames.length).toBe(1)
    frames.shift()!()
    expect(runs(h)).toBe(ran + 1)
    expect(frames.length).toBe(0)
    // Refreshing now is always possible.
    expect(h.runtime.refresh()).toBe(true)
    expect(runs(h)).toBe(ran + 2)
  })

  it('off: the results stay as of the last run', async () => {
    const h = workbench()
    sample(h, 'The todo items')
    const before = rows(h)
    const ran = runs(h)
    setDone(h, 't1', false)
    await frame()
    expect(h.screen.engine.hasStale).toBe(false)
    expect(runs(h)).toBe(ran)
    expect(rows(h)).toEqual(before)
    // Switched off after following: no longer re-run.
    h.fire(followSwitch(h), 'click')
    h.fire(followSwitch(h), 'click')
    expect(following(h)).toBe('false')
    const pinned = rows(h)
    const now = runs(h)
    setDone(h, 't1', true)
    await frame()
    expect(runs(h)).toBe(now)
    expect(rows(h)).toEqual(pinned)
    expect(h.screen.engine.footprint().following).toBe(0)
    // Running again shows what the graph says now.
    h.fire(q(h, '.sem-toolbar button')!, 'click')
    expect(rows(h)).not.toEqual(pinned)
  })

  it('hidden results wait, without frames, until they are shown', async () => {
    const h = workbench()
    sample(h, 'The todo items')
    h.fire(followSwitch(h), 'click')
    h.fire([...h.document.querySelectorAll('[data-sem-c=query-workbench] [role=tab]')].find((t) => t.textContent === 'Graph')!, 'click')
    const frames: (() => void)[] = []
    h.runtime.frame = (run) => void frames.push(run)
    const ran = runs(h)
    setDone(h, 't1', false)
    // The table is hidden: nothing scheduled, nothing run.
    expect(runs(h)).toBe(ran)
    h.fire([...h.document.querySelectorAll('[data-sem-c=query-workbench] [role=tab]')].find((t) => t.textContent === 'Table')!, 'click')
    expect(runs(h)).toBe(ran + 1)
    expect(rows(h).find((r) => r.includes('Write the core ontology'))).toMatch(/false$/)
    // The graph (shown before) refreshes at the frame.
    for (const run of frames.splice(0)) run()
  })

  it('is remembered with the rest of the workbench', async () => {
    const PER = NS.per
    const storage: Record<string, Backend> = { [PER + 'Session']: memoryBackend(), [PER + 'Device']: memoryBackend(), [PER + 'Database']: memoryBackend() }
    const a = (await mountRemembering(storage)) as unknown as Shell & { persistence: { flush(): Promise<void> } }
    a.fire([...a.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Query')!, 'click')
    a.fire(followSwitch(a), 'click')
    await a.persistence.flush()

    const b = (await mountRemembering(storage)) as unknown as Shell
    b.fire([...b.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Query')!, 'click')
    expect(following(b)).toBe('true')
    expect(followSwitch(b).getAttribute('aria-checked')).toBe('true')
    expect(live(b)).not.toBeNull()
    // And it follows: the first sample counts renderings, and a new one is counted.
    const before = rows(b).find((r) => r.startsWith('c:Badge'))!
    const f = b.store.factory
    b.runtime.apply({
      remove: [],
      add: [f.quad(f.namedNode(UI + 'extraRendering'), f.namedNode(SEM.targets), f.namedNode(C + 'Badge')), f.quad(f.namedNode(UI + 'extraRule'), f.namedNode(SEM.implements), f.namedNode(UI + 'extraRendering'))],
    })
    await frame()
    expect(rows(b).find((r) => r.startsWith('c:Badge'))).not.toBe(before)
  })
})

describe('what a query reads (src/sparql-reads.ts)', () => {
  const reads = (query: string) => queryReads(SPARQL_PREFIXES + '\nPREFIX ex: <http://example.org/>\n' + query)
  const R = NS.rdfs
  it('names the IRIs of each triple pattern, everywhere the query matches', () => {
    expect(reads('SELECT ?l WHERE { ex:a ex:p ?o ; ex:q ex:b . ?o rdfs:label ?l FILTER NOT EXISTS { ?o ex:hidden true } OPTIONAL { GRAPH ?g { ?o a ex:C } } }')).toEqual([
      { s: 'http://example.org/a', p: 'http://example.org/p', o: undefined },
      { s: 'http://example.org/a', p: 'http://example.org/q', o: 'http://example.org/b' },
      { s: undefined, p: R + 'label', o: undefined },
      { s: undefined, p: 'http://example.org/hidden', o: undefined },
      { s: undefined, p: NS.rdf + 'type', o: 'http://example.org/C' },
    ])
  })
  it('reads the predicates of paths, subqueries and collections, not CONSTRUCT templates', () => {
    expect(reads('CONSTRUCT { ?x ex:out ?y } WHERE { ?x ex:p/^ex:q+ ?y { SELECT ?x WHERE { ?x ex:r ( 1 2 ) } GROUP BY ?x HAVING (COUNT(*) > 1) } }')?.map((r) => r.p)).toEqual([
      'http://example.org/p',
      'http://example.org/q',
      NS.rdf + 'first',
      NS.rdf + 'rest',
      'http://example.org/r',
    ])
  })
  it('reads everything when it cannot tell', () => {
    expect(reads('SELECT * WHERE { ?s ?p ?o }')).toEqual([{}])
    expect(reads('SELECT * WHERE { ?s !ex:p ?o }')).toEqual([{}])
    expect(reads('SELECT * WHERE { ?s ex:p* ?o }')).toEqual([{}])
    expect(reads('SELECT * WHERE { ex:a ex:p* ?o }')).toEqual([{ p: 'http://example.org/p' }])
    expect(reads('DESCRIBE ex:a')).toBeUndefined()
    expect(reads('SELECT * WHERE { << ex:a ex:p ex:b >> ex:q ?o }')).toBeUndefined()
    expect(reads('SELECT * WHERE { ?s nope:p ?o }')).toBeUndefined()
    expect(reads('SELECT * WHERE { ?s ex:p "unterminated }')).toBeUndefined()
  })
})

describe('sem:refresh', () => {
  it('sem:AtOnce (the default) re-runs a following rule in the same run as the change', () => {
    const store = loadStore('wat')
    const f = store.factory
    const nn = f.namedNode
    const T = 'https://example.org/follow#'
    store.add(f.quad(nn(T + 'Counter'), nn(NS.rdf + 'type'), nn(NS.owl + 'Class')))
    store.add(f.quad(nn(T + 'Rendering'), nn(NS.rdf + 'type'), nn(SEM.Rule)))
    store.add(f.quad(nn(T + 'Rendering'), nn(SEM.targets), nn(T + 'Counter')))
    store.add(f.quad(nn(T + 'Rendering'), nn(SEM.function), f.literal('test:count')))
    store.add(f.quad(nn(T + 'counter'), nn(NS.rdf + 'type'), nn(T + 'Counter')))
    const count: FnRule = (ctx, focus) => {
      const n = ctx.select(`SELECT (COUNT(*) AS ?n) WHERE { ?x <${T}item> ?y }`, { follow: true })[0]?.get('n')?.value ?? '0'
      return [f.quad(focus, nn(T + 'count'), f.literal(n), nn('urn:x'))]
    }
    const runtime = new Runtime(store)
    const p = runtime.project({ modality: MOD.Screen, functions: { 'test:count': count }, name: 'follow' })
    const shown = () => store.match(nn(T + 'counter'), nn(T + 'count'), null, p.engine.graph)[0]?.object.value
    expect(shown()).toBe('0')
    runtime.apply({ remove: [], add: [f.quad(nn(T + 'a'), nn(T + 'item'), nn(T + 'b'))] })
    expect(shown()).toBe('1')
    expect(p.engine.hasStale).toBe(false)
    const before = p.engine.stats.ruleRuns
    runtime.apply({ remove: [], add: [f.quad(nn(T + 'a'), nn(T + 'other'), nn(T + 'b'))] })
    expect(p.engine.stats.ruleRuns).toBe(before)
  })
})
