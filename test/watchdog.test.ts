import { describe, expect, it } from 'vitest'
import { EX, todoApp } from '../src/examples/todo.ts'
import { functions } from '../src/components/functions.ts'
import type { FnRule } from '../src/engine/context.ts'
import { type Stall, Watchdog } from '../src/engine/watchdog.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS } from '../src/ns.ts'
import { toHTML } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { QueryInterrupted } from '../src/store/types.ts'
import { SCREEN_LAYERS, todo } from './helpers.ts'

const page = EX + 'page'
const N = 40

/** A clock tests move: every list item evaluation "takes" `cost` ms. */
function slowTodo(cost = 100, kind: 'wat' | 'oxigraph' = 'wat', prefer: 'function' | 'sparql' = 'function') {
  let t = 0
  const slow: FnRule = (ctx, focus, member) => {
    t += cost
    return functions['listitem:screen']!(ctx, focus, member)
  }
  const store = loadStore(kind, todoApp(N))
  const runtime = new Runtime(store)
  runtime.watchdog.clock = () => t
  runtime.watchdog.budgetMs = 1500
  const stalls: Stall[] = []
  runtime.watchdog.onStall((s) => stalls.push({ ...s }))
  const screen = runtime.project({ modality: MOD.Screen, layers: SCREEN_LAYERS, prefer, functions: { 'listitem:screen': slow } }, (e) => {
    throw e
  })
  return { store, runtime, screen, stalls, clock: { get t() { return t }, set t(v) { t = v } } }
}

function reference(kind: 'wat' | 'oxigraph' = 'wat', prefer: 'function' | 'sparql' = 'function', edit?: (r: Runtime) => void) {
  const store = loadStore(kind, todoApp(N))
  const runtime = new Runtime(store)
  runtime.watchdog.budgetMs = Infinity
  const screen = runtime.project({ modality: MOD.Screen, layers: SCREEN_LAYERS, prefer }, (e) => {
    throw e
  })
  edit?.(runtime)
  return toHTML(screen.index, page)
}

/** Relabel every item in one transaction: N slow evaluations. */
function relabelAll(runtime: Runtime) {
  const ops = todo(runtime.store)
  runtime.transaction(() => {
    for (let i = 1; i <= N; i++) runtime.apply(ops.set(`t${i}`, NS.rdfs + 'label', `Renamed ${i}`))
  })
}

describe('watchdog', () => {
  it('suspends a turn at its budget, holding the rest of the pairs', () => {
    const { runtime, screen, stalls } = slowTodo()
    expect(stalls).toHaveLength(1)
    const s = stalls[0]!
    expect(s.culprit?.iri).toBe(NS.c + 'ListItemOnScreen-fn')
    expect(s.culprit?.kind).toBe('rule')
    expect(s.pending).toBeGreaterThan(0)
    expect(runtime.held).toBe(s.pending)
    expect(screen.engine.heldCount).toBe(s.pending)
    // Some items rendered, not all.
    const html = toHTML(screen.index, page)
    const shown = [...html.matchAll(/~check/g)].length
    expect(shown).toBeGreaterThan(0)
    expect(shown).toBeLessThan(N * 2)
  })

  it('continued in slices, ends with the same HTML as a turn never suspended', () => {
    const { runtime, screen, stalls } = slowTodo()
    let slices = 0
    while (runtime.continueStall(50)) slices++
    expect(slices).toBeGreaterThan(2)
    expect(runtime.held).toBe(0)
    expect(runtime.watchdog.stall).toBeUndefined()
    expect(stalls).toHaveLength(1)
    expect(toHTML(screen.index, page)).toBe(reference())
  })

  it('a stall in an interaction continues to the same result', () => {
    const { runtime, screen, stalls, clock } = slowTodo()
    while (runtime.continueStall(50));
    clock.t += 10_000
    relabelAll(runtime)
    expect(stalls).toHaveLength(2)
    expect(runtime.held).toBeGreaterThan(0)
    while (runtime.continueStall(50));
    expect(toHTML(screen.index, page)).toBe(reference('wat', 'function', relabelAll))
  })

  it('stopped, every pair is evaluated or counted out of date; a retry catches up', () => {
    const { runtime, screen, clock } = slowTodo()
    while (runtime.continueStall(50));
    const before = toHTML(screen.index, page)
    relabelAll(runtime)
    const held = runtime.held
    expect(held).toBeGreaterThan(0)
    const stopped = runtime.stopStall()
    expect(stopped).toBe(held)
    expect(runtime.held).toBe(0)
    expect(runtime.watchdog.stall).toBeUndefined()
    const html = toHTML(screen.index, page)
    // Items evaluated before the budget ran out show the new label; the rest still show the old one.
    const renamed = [...html.matchAll(/Renamed \d+/g)].length
    expect(renamed).toBeGreaterThan(0)
    expect(renamed).toBeLessThan(N)
    expect(renamed + stopped).toBe(N)
    expect(html).not.toBe(before)
    // A change to a stopped item evaluates it as usual.
    clock.t += 10_000
    const ops = todo(runtime.store)
    const stale = screen.engine.heldFoci(100, 'stopped')
    expect(stale.length).toBe(stopped)
    runtime.watchdog.budgetMs = Infinity
    runtime.retryStopped()
    expect(runtime.stopped).toBe(0)
    expect(toHTML(screen.index, page)).toBe(reference('wat', 'function', relabelAll))
    void ops
  })

  it('removing a held item while stopped retracts it: nothing shows what no longer exists', () => {
    const { runtime, screen, clock } = slowTodo()
    while (runtime.continueStall(50));
    clock.t += 10_000
    relabelAll(runtime)
    const ops = todo(runtime.store)
    // Remove the last item while its re-evaluation is held.
    runtime.watchdog.budgetMs = Infinity
    runtime.apply({ remove: runtime.store.match(ops.nn('todos'), ops.nn(NS.c + 'item'), ops.nn('t40')), add: [] })
    runtime.stopStall()
    expect(toHTML(screen.index, page)).not.toContain('t40/~check')
  })

  it('new turns run while work is held, without touching it', () => {
    const { runtime, screen } = slowTodo()
    const held = runtime.held
    const ops = todo(runtime.store)
    runtime.apply(ops.set('title', NS.c + 'label', 'Still responsive'))
    expect(toHTML(screen.index, page)).toContain('Still responsive')
    // Held pairs the new turn dirtied again are evaluated by it; the rest stay held.
    expect(runtime.held).toBeGreaterThan(0)
    expect(runtime.held).toBeLessThanOrEqual(held)
  })

  it('a store deadline that interrupts a query is a stall, and the query runs to the end when continued', () => {
    const store = loadStore('wat', todoApp(5))
    let interrupt = 1
    let deadline: number | undefined
    const construct = store.construct.bind(store)
    const constructFor = store.constructFor?.bind(store)
    const cut = <T>(run: () => T): T => {
      if (deadline !== undefined && interrupt > 0) {
        interrupt--
        throw new QueryInterrupted()
      }
      return run()
    }
    Object.assign(store, {
      setDeadline: (at: number | undefined) => void (deadline = at),
      construct: (q: string, g: never) => cut(() => construct(q, g)),
      constructFor: constructFor && ((q: string, v: string, vs: never, g: never) => cut(() => constructFor(q, v, vs, g))),
    })
    const runtime = new Runtime(store)
    runtime.watchdog.budgetMs = 1500
    const stalls: Stall[] = []
    runtime.watchdog.onStall((s) => stalls.push({ ...s }))
    const screen = runtime.project({ modality: MOD.Screen, layers: SCREEN_LAYERS, prefer: 'sparql' })
    expect(stalls).toHaveLength(1)
    expect(stalls[0]!.interrupted).toBe(true)
    expect(runtime.held).toBeGreaterThan(0)
    // Continuing sets no deadline: the person chose to wait.
    interrupt = 1
    while (runtime.continueStall(50));
    expect(interrupt).toBe(1)
    const fresh = new Runtime(loadStore('wat', todoApp(5))).project({ modality: MOD.Screen, layers: SCREEN_LAYERS, prefer: 'sparql' })
    expect(toHTML(screen.index, page)).toBe(toHTML(fresh.index, page))
  })

  it('reads the clock only every few evaluations', () => {
    const wd = new Watchdog()
    let reads = 0
    wd.clock = () => (reads++, 0)
    wd.turn(() => {
      for (let i = 0; i < 80; i++) wd.check()
    })
    // The turn's start and end, plus one read every 8 checks.
    expect(reads).toBe(2 + 10)
  })
})
