import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { HeartbeatWatch } from '../src/behaviour/heartbeat.ts'
import { StallMonitor } from '../src/behaviour/stall.ts'
import { WD } from '../src/components/stall.ts'
import type { FnRule } from '../src/engine/context.ts'
import { EX, todoApp, todoReactions } from '../src/examples/todo.ts'
import { loadStore } from '../src/node/load.ts'
import { BEH, MOD, NS, PERF_GRAPH } from '../src/ns.ts'
import { toHTML } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { buildSandbox } from '../src/sandbox.ts'
import { mountSite } from './harness.ts'
import { SCREEN_LAYERS } from './helpers.ts'

const UI = 'https://semblance.dev/demo#'

/** The site with the stall effect, on a clock tests move; deferred work runs when drained. */
function site(slowMs = 1000) {
  const h = mountSite('wat', 'sparql')
  let t = 0
  const wd = h.runtime.watchdog
  wd.clock = () => t
  const queue: (() => void)[] = []
  const drain = () => {
    for (let i = 0; i < 1000 && queue.length; i++) queue.shift()!()
  }
  const monitor = new StallMonitor(h.runtime, { watchdog: UI + 'watchdog', bus: h.bus, flush: () => h.shell.flush(), defer: (fn) => queue.push(fn), yieldTo: (fn) => queue.push(fn), now: () => Date.parse('2026-10-24T12:00:00Z') })
  monitor.attach()
  // A temporary slow rule: the status bar's metrics "take" slowMs each.
  const fns = (h.screen.engine as unknown as { functions: Record<string, FnRule> }).functions
  const metrics = fns['metrics']!
  let slow = true
  fns['metrics'] = (ctx, focus, m) => {
    if (slow) t += slowMs
    return metrics(ctx, focus, m)
  }
  const f = h.store.factory
  const stats = (n: number) => {
    const s = f.namedNode(UI + 'stats')
    const p = f.namedNode(UI + 'ms')
    h.runtime.apply({ remove: h.store.match(s, p, null), add: [f.quad(s, p, f.literal(n.toFixed(2), f.namedNode(NS.xsd + 'decimal')))] })
    h.shell.flush()
  }
  const dialog = () => h.document.getElementById(UI + 'stallDialog/~root') as Element | null
  const open = () => !!dialog() && !dialog()!.hasAttribute('hidden')
  const button = (text: string) => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent!.trim() === text)!
  const state = () => h.store.match(null, f.namedNode(WD.stallState), null, f.namedNode(PERF_GRAPH)).map((q) => q.object.value.replace(/^.*#/, ''))
  return { ...h, wd, monitor, drain, stats, open, dialog, button, state, clock: { advance: (ms: number) => (t += ms) }, fast: () => (slow = false) }
}

/** The same site and changes, never suspended. */
function reference(...values: number[]) {
  const h = mountSite('wat', 'sparql')
  const f = h.store.factory
  for (const n of values) {
    const s = f.namedNode(UI + 'stats')
    const p = f.namedNode(UI + 'ms')
    h.runtime.apply({ remove: h.store.match(s, p, null), add: [f.quad(s, p, f.literal(n.toFixed(2), f.namedNode(NS.xsd + 'decimal')))] })
  }
  return toHTML(h.screen.index, UI + 'perfPanel')
}

describe('the stall dialog', () => {
  it('opens when a turn goes over budget, saying what was slow', () => {
    const h = site()
    expect(h.wd.budgetMs).toBe(1500)
    expect(h.open()).toBe(false)
    h.stats(12.5)
    expect(h.runtime.held).toBeGreaterThan(0)
    h.drain()
    h.shell.flush()
    expect(h.open()).toBe(true)
    expect(h.dialog()!.textContent).toContain('The page is busy')
    const report = h.dialog()!.querySelector('[data-sem-c=stall-report]')!
    expect(report.getAttribute('data-sem-state')).toBe('suspended')
    expect(report.querySelector('.sem-summary')!.textContent).toMatch(/^Suspended · \d+ done · \d+ waiting · \d+ ms$/)
    expect(report.querySelector('a')!.textContent).toBe('MetricsRendering-fn')
    expect(report.textContent).toContain('turn budget')
    expect(h.state()).toEqual(['Suspended'])
    // The stall is an event in the change log, addressed to the watchdog.
    expect(h.bus.recent(1)[0]!.some((q) => q.object.value === WD.Stalled)).toBe(true)
  })

  it('Continue finishes in slices, with the same result as a turn never suspended, and closes', () => {
    const h = site()
    h.stats(12.5)
    h.drain()
    h.shell.flush()
    h.fire(h.button('Continue'), 'click')
    h.drain()
    h.shell.flush()
    expect(h.runtime.held).toBe(0)
    expect(h.open()).toBe(false)
    expect(h.state()).toEqual(['Continued'])
    expect(toHTML(h.screen.index, UI + 'perfPanel')).toBe(reference(12.5))
  })

  it('Stop drops the rest, counts what is out of date, and Retry catches up', () => {
    const h = site()
    h.stats(12.5)
    h.drain()
    h.shell.flush()
    h.fire(h.button('Stop'), 'click')
    h.drain()
    h.shell.flush()
    expect(h.runtime.held).toBe(0)
    expect(h.open()).toBe(false)
    expect(h.state()).toEqual(['Stopped'])
    const stopped = h.runtime.stopped
    expect(stopped).toBeGreaterThan(0)
    const f = h.store.factory
    expect(h.store.match(f.namedNode(UI + 'watchdog'), f.namedNode(WD.outOfDate), null)[0]?.object.value).toBe(String(stopped))
    // Retry (Tools › Engine), with the rule fast again.
    h.fast()
    h.runtime.retryStopped()
    h.drain()
    expect(h.runtime.stopped).toBe(0)
    expect(h.store.match(f.namedNode(UI + 'watchdog'), f.namedNode(WD.outOfDate), null)).toEqual([])
    expect(toHTML(h.screen.index, UI + 'perfPanel')).toBe(reference(12.5))
  })

  it('closing the dialog without deciding continues in the background', () => {
    const h = site()
    h.stats(3)
    h.drain()
    h.shell.flush()
    h.fire(h.dialog()!.querySelector('.sem-close')!, 'click')
    h.drain()
    expect(h.runtime.held).toBe(0)
    expect(h.state()).toEqual(['Continued'])
  })

  it('settles by itself when later turns evaluated everything that was held', () => {
    const h = site()
    h.stats(3)
    h.drain()
    h.shell.flush()
    expect(h.open()).toBe(true)
    h.fast()
    // Later turns re-run what was held (as when its input changes again).
    for (const p of h.runtime.projections) p.engine.continueHeld()
    expect(h.runtime.held).toBe(0)
    h.drain()
    h.shell.flush()
    expect(h.open()).toBe(false)
    expect(h.state()).toEqual(['Continued'])
  })

  it('blames a slow reaction, and suspends the tick after it', () => {
    const store = loadStore('wat', todoApp(5))
    const runtime = new Runtime(store)
    let t = 0
    runtime.watchdog.clock = () => t
    runtime.watchdog.budgetMs = 1500
    const screen = runtime.project({ modality: MOD.Screen, layers: SCREEN_LAYERS, prefer: 'function' })
    const slowInput = (ctx: Parameters<(typeof todoReactions)[string]>[0]) => {
      t += 2000
      const f = ctx.runtime.store.factory
      return { remove: ctx.match(ctx.target, NS.c + 'value', null), add: [f.quad(ctx.target, f.namedNode(NS.c + 'value'), ctx.object(ctx.event, BEH.value)!)] }
    }
    const bus = new EventBus(runtime, screen, { functions: { ...todoReactions, 'textfield:input': slowInput }, prefer: 'function' })
    const stalls: unknown[] = []
    runtime.watchdog.onStall((s) => stalls.push(s))
    bus.emit((NS.beh + 'Input'), EX + 'newTodo', { value: 'Slow' })
    expect(stalls).toHaveLength(1)
    const s = runtime.watchdog.stall!
    expect(s.culprit?.kind).toBe('reaction')
    expect(s.eventType).toBe((NS.beh + 'Input'))
    expect(runtime.held).toBeGreaterThan(0)
    while (runtime.continueStall(50));
    expect(toHTML(screen.index, EX + 'page')).toContain('value="Slow"')
  })

  it('blames a slow maintained view', () => {
    const view = `@prefix iv: <${NS.iv}> . @prefix sem: <${NS.sem}> . @prefix ex: <${EX}> .
ex:labels a iv:View ; sem:select """SELECT (COUNT(?t) AS ?n) WHERE { ?t <${NS.rdfs}label> ?l }""" .`
    const store = loadStore('wat', todoApp(5), view)
    const runtime = new Runtime(store)
    let t = 0
    runtime.watchdog.clock = () => t
    runtime.watchdog.budgetMs = 1500
    runtime.project({ modality: MOD.Screen, layers: SCREEN_LAYERS, prefer: 'function' })
    const v = runtime.views.view(EX + 'labels') as unknown as { iri: string; step: (...a: unknown[]) => unknown }
    const step = v.step.bind(v)
    v.step = (...a) => ((t += 2000), step(...a))
    const f = store.factory
    runtime.apply({ remove: [], add: [f.quad(f.namedNode(EX + 't1'), f.namedNode(NS.c + 'label'), f.literal('changed'))] })
    expect(runtime.watchdog.stall?.culprit).toMatchObject({ kind: 'view', iri: EX + 'labels' })
    while (runtime.continueStall(50));
    expect(runtime.held).toBe(0)
  })
})

describe('c:StallReport', () => {
  const W = 'https://example.org/w#'
  const states: Record<string, string> = {
    empty: '',
    suspended: `w:wd sem:stall w:s . w:s a sem:Stall ; sem:stallState sem:Suspended ; sem:done 12 ; sem:pending 30 ; sem:spentMs 1612 ;
      sem:culprit c:ListItemOnScreen-fn ; sem:workKind sem:RuleWork ; sem:culpritMs 1400 ; sem:culpritFocus w:item ;
      sem:eventType beh:Click ; sem:detectedBy sem:BudgetCheck .`,
    continuing: `w:wd sem:stall w:s . w:s a sem:Stall ; sem:stallState sem:Continuing ; sem:done 20 ; sem:pending 22 ; sem:spentMs 1700 .`,
    stale: `w:wd sem:outOfDate 7 .`,
  }
  for (const [name, data] of Object.entries(states)) {
    it(`renders the same with SPARQL and with functions: ${name}`, () => {
      const prefixes = Object.entries(NS).map(([p, ns]) => `@prefix ${p}: <${ns}> .`).join('\n')
      const ttl = `${prefixes}\n@prefix w: <${W}> . w:root a c:StallReport ; c:of w:wd . w:wd a sem:Watchdog . ${data}`
      const html = (prefer: 'sparql' | 'function') =>
        toHTML(new Runtime(loadStore('wat', ttl)).project({ modality: MOD.Screen, layers: SCREEN_LAYERS, prefer, roots: [W + 'root'] }).index, W + 'root')
      const sparql = html('sparql')
      expect(sparql).toBe(html('function'))
      if (name === 'empty') expect(sparql).toContain('Nothing has stalled.')
      if (name === 'suspended') {
        expect(sparql).toContain('Suspended · 12 done · 30 waiting · 1612 ms')
        // The culprit is a c:Link to the rule (c:to): with the navigation layer it goes to the Reference (the site test).
        expect(sparql).toContain('rule · 1400 ms')
      }
      if (name === 'continuing') expect(sparql).toMatch(/data-sem-c="progress"/)
      if (name === 'stale') expect(sparql).toContain('7 out of date')
    })
  }
})

describe('the heartbeat', () => {
  it('notices a gap in the beats and reports it, with what the page last said it did, once beats come back', () => {
    const w = new HeartbeatWatch(2000)
    let now = 1_000
    const beat = (rule?: string) => w.beat({ at: now, rule })
    expect(beat()).toBeUndefined()
    for (let i = 0; i < 8; i++) (now += 250), expect(beat('r:a')).toBeUndefined(), expect(w.check(now + 100)).toBeUndefined()
    // The page goes silent; the worker's own timer notices while it is.
    now += 250
    expect(w.check(now + 1000)).toBeUndefined()
    expect(w.check(now + 2500)).toMatchObject({ start: now - 250, last: { rule: 'r:a' } })
    // It answers again 5 s later.
    now += 5000
    const hang = beat('r:b')
    expect(hang).toMatchObject({ start: now - 5250, end: now, last: { rule: 'r:a' } })
    expect(w.check(now + 100)).toBeUndefined()
  })

  it('a gap between two beats is a hang even when the worker was throttled too', () => {
    const w = new HeartbeatWatch(2000)
    w.beat({ at: 0 })
    expect(w.beat({ at: 3000 })).toEqual({ start: 0, end: 3000, last: { at: 0 } })
    expect(w.beat({ at: 3250 })).toBeUndefined()
  })
})

describe('a sandbox over budget', () => {
  it('stops itself and says why, instead of freezing the site', () => {
    const items = Array.from({ length: 30 }, (_, i) => `ex:t${i} rdfs:label "Item ${i}" .`).join('\n')
    const source = `@prefix ex: <https://example.org/s#> .
ex:list a c:List ; c:label "Slow" ; c:item ${Array.from({ length: 30 }, (_, i) => `ex:t${i}`).join(', ')} ; c:itemLabel rdfs:label .
${items}`
    const burn: FnRule = (ctx, focus, member) => {
      const t = performance.now()
      while (performance.now() - t < 20);
      return functionsOf('listitem:screen')(ctx, focus, member)
    }
    const b = buildSandbox([{ name: 'list.ttl', text: source }], 'https://example.org/s#list', {
      load: (...t) => loadStore('wat', ...t),
      prefer: 'function',
      functions: { 'listitem:screen': burn },
      budgetMs: 100,
    })
    expect(b.sandbox).toBeUndefined()
    expect(b.problems[0]!.severity).toBe('error')
    expect(b.problems[0]!.message).toMatch(/^Stopped: rendering took longer than 100 ms, and \d+ renderings were left undone\. The slowest work was c:ListItemOnScreen-fn/)
  })
})

import { functions as builtins } from '../src/components/functions.ts'
const functionsOf = (name: string) => builtins[name]!
