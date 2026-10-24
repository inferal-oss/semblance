import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { observationsTurtle } from '../bench/observations.ts'
import type { Row } from '../bench/scenarios.ts'
import { EventBus } from '../src/behaviour/events.ts'
import { EX, todoApp, todoOps, todoReactions } from '../src/examples/todo.ts'
import { loadStore } from '../src/node/load.ts'
import { A11Y, MOD, NS, PERF_GRAPH, SEM, STY } from '../src/ns.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

describe('the demo shell is a component graph', () => {
  it('renders every part of the interface from the graph', () => {
    const shell = mountShell()
    const { document, showPage } = shell
    const kinds = () => new Set([...document.querySelectorAll('[data-sem-c]')].map((e) => (e as HTMLElement).getAttribute('data-sem-c')))
    for (const k of ['app-bar', 'graph-mark', 'theme-switcher', 'segmented', 'toggle', 'switch', 'metrics', 'card', 'tabs', 'flippable', 'query-view', 'window']) {
      expect(kinds(), k).toContain(k)
    }
    const { fire } = shell
    fire([...document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Engine')!, 'click')
    for (const k of ['choice', 'chips']) expect(kinds(), k).toContain(k)
    showPage('Performance')
    for (const k of ['bar-chart', 'heatmap', 'line-chart', 'finding-list', 'progress', 'text-field']) expect(kinds(), k).toContain(k)
    // the logo is SVG built from the svg: vocabulary
    expect(document.querySelector('[data-sem-c=graph-mark]')!.localName).toBe('svg')
    // tooltip annotations are projected by the tooltip layer
    expect(document.querySelector('.sem-detach')!.getAttribute('data-sem-tooltip')).toBe('Open Inspector in a window')
  })

  it('inspects whatever is hovered (unrecorded event → graph → query view + highlight)', () => {
    const { document, fire, value, bus } = mountShell()
    const label = document.querySelector('[data-sem-c=list-item] label')!
    fire(label, 'mouseover')
    expect(value(UI + 'inspecting')).toBe(`${EX}todos/~i-${encodeURIComponent(EX + 't1')}/~label`)
    expect(label.getAttribute('data-sem-highlighted')).toBe('true')
    expect(document.querySelector('[data-sem-c=query-view]')!.textContent).toContain('# rendered element (RDF/HTML)')
    expect(bus.recent(5)).toHaveLength(0) // hovers stay out of the change log
  })

  it('detaches a tab into a window, moves it, and docks it back by provenance', () => {
    const { document, fire, window, store } = mountShell()
    const stats = () => document.querySelector('[data-sem-c=stream-stats]')
    fire([...document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Activity')!, 'click')
    const before = stats()
    expect(before).not.toBeNull()
    // The tools are a window too; this is the one minted for the tab.
    const activity = () => [...document.querySelectorAll('[data-sem-c=window]')].find((w) => w.querySelector('.sem-window-bar strong')!.textContent === 'Activity')
    fire(document.querySelector('[aria-label="Open Activity in a window"]')!, 'click')
    const win = activity()!
    expect(win.querySelector('.sem-window-bar strong')!.textContent).toBe('Activity')
    expect(win.contains(stats())).toBe(true)
    expect(stats()).toBe(before) // the same DOM moved into the window
    win.querySelector('.sem-window-bar')!.dispatchEvent(new window.CustomEvent('sem-move', { bubbles: true, detail: { x: 300, y: 200 } }))
    expect(activity()!.getAttribute('style')).toContain('left: 300px; top: 200px')
    fire(activity()!.querySelector('.sem-window-control')!, 'click')
    expect(activity()).toBeUndefined()
    expect(document.querySelector('[role=tab][aria-selected=true]')!.textContent).toBe('Activity')
    expect(stats()).toBe(before)
    // geometry outlives the window: re-detaching reopens where it was
    fire(document.querySelector('[aria-label="Open Activity in a window"]')!, 'click')
    expect(activity()!.getAttribute('style')).toContain('left: 300px')
    expect(store.match(null, store.factory.namedNode(NS.c + 'detached'), null).length).toBe(1)
  })

  it('evaluates only what is shown, and catches up when it is shown', () => {
    const { document, screen, showPage, fire } = mountShell()
    // Runs of every implementation of a rendering (SPARQL or function, whichever is preferred).
    const runs = (rendering: string) => [...screen.engine.stats.byRule].filter(([iri]) => iri.startsWith(NS.c + rendering.replace(/-(fn|sparql)$/, '') + '-')).reduce((n, [, s]) => n + s.runs, 0)
    // The Performance page and the hidden Activity / Change log tabs were never evaluated.
    expect(runs('BarChartRendering-fn')).toBe(0)
    expect(runs('StreamStatsOnScreen-sparql')).toBe(0)
    expect(document.querySelector('[data-sem-c=bar-chart]')).toBeNull()
    // Interactions while hidden do not evaluate them either...
    fire(document.querySelector('[data-sem-c=list-item] input')!, 'change')
    expect(runs('StreamStatsOnScreen-sparql')).toBe(0)
    // ...until they are shown.
    fire([...document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Activity')!, 'click')
    expect(runs('StreamStatsOnScreen-sparql')).toBeGreaterThan(0)
    expect(document.querySelector('[data-sem-c=stream-stats]')!.textContent).toMatch(/events/)
    showPage('Performance')
    expect(document.querySelector('[data-sem-c=bar-chart]')).not.toBeNull()
  })

  it('keeps the cost of a toggle constant as the app and its history grow', () => {
    const { document, fire, screen, runtime, store, shell } = mountShell()
    // Every triple a pattern match hands back is work: a scan over a growing set shows up here.
    let triplesRead = 0
    const match = store.match.bind(store)
    store.match = (...args: Parameters<typeof match>) => {
      const quads = match(...args)
      triplesRead += quads.length
      return quads
    }
    const toggle = () => {
      const box = document.querySelector('[data-sem-c=list-item] input') as HTMLInputElement
      const stats = { ...screen.engine.stats }
      const ops = shell.ops
      const read = triplesRead
      box.checked = !box.checked
      fire(box, 'change')
      return {
        ruleRuns: screen.engine.stats.ruleRuns - stats.ruleRuns,
        triplesWritten: screen.engine.stats.derivedAdded - stats.derivedAdded + screen.engine.stats.derivedRemoved - stats.derivedRemoved,
        triplesRead: triplesRead - read,
        domOps: shell.ops - ops,
      }
    }
    // Past every window that looks back over the log (announcements read the 50 newest).
    const field = document.querySelector('[data-sem-c=text-field] input') as HTMLInputElement
    for (let i = 0; i < 60; i++) {
      field.value = 'w'.repeat((i % 5) + 1)
      fire(field, 'input')
    }
    toggle()
    const before = toggle()
    // Grow everything a toggle should not depend on: the list, and the event history.
    const ops = todoOps(store)
    const more = Array.from({ length: 300 }, (_, i) => ops.addItem(`more-${i}`, `More ${i}`, 1000 + i))
    runtime.apply({ remove: [], add: more.flatMap((d) => d.add) })
    const input = document.querySelector('[data-sem-c=text-field] input') as HTMLInputElement
    for (let i = 0; i < 100; i++) {
      input.value = 'x'.repeat(i)
      fire(input, 'input')
    }
    shell.flush()
    toggle()
    expect(toggle()).toEqual(before)
    expect(before.ruleRuns).toBeLessThanOrEqual(4)
    expect(before.domOps).toBeLessThanOrEqual(2)
  })

  it('warms only what declares sem:warm sem:Eager in idle time', () => {
    const { document, runtime, screen, store } = mountShell()
    // The tools' tabs are lazy in the demo; declare them eager here.
    const f = store.factory
    runtime.apply({ remove: store.match(f.namedNode(UI + 'views'), f.namedNode(NS.sem + 'warm'), null), add: [f.quad(f.namedNode(UI + 'views'), f.namedNode(NS.sem + 'warm'), f.namedNode(NS.sem + 'Eager'))] })
    // Runs of every implementation of a rendering (SPARQL or function, whichever is preferred).
    const runs = (rendering: string) => [...screen.engine.stats.byRule].filter(([iri]) => iri.startsWith(NS.c + rendering.replace(/-(fn|sparql)$/, '') + '-')).reduce((n, [, s]) => n + s.runs, 0)
    while (runtime.warm(50)) {}
    // The tools' hidden tabs (eager) are ready before they are shown...
    expect(runs('StreamStatsOnScreen-fn')).toBeGreaterThan(0)
    // ...the gallery (lazy, the default) is not evaluated until a group is shown.
    expect(runs('SwatchesRendering-fn')).toBe(0)
    expect(document.querySelector('[data-sem-c=swatches]')).toBeNull()
  })

  it('switches pages and theme through the same kind of control', () => {
    const { document, fire, value } = mountShell()
    const button = (text: string) => [...document.querySelectorAll('[data-sem-c=segmented] button, [data-sem-c=theme-switcher] button')].find((b) => b.textContent!.includes(text))!
    fire(button('Docs'), 'click')
    expect(value(UI + 'page')).toBe(UI + 'Docs')
    expect((document.querySelector('[data-sem-c=switch] > div:nth-child(1)') as HTMLElement).hasAttribute('hidden')).toBe(true)
    fire(button('Night'), 'click')
    expect(value(NS.sty + 'colorScheme')).toBe(NS.sty + 'Dark')
  })

  it('projects observations written to the perf graph into charts and findings', () => {
    const { document, runtime, shell, showPage } = mountShell()
    showPage('Performance')
    const rows: Row[] = ['hybrid · function', 'n3 · function', 'oxigraph · sparql · bulk'].flatMap((config, i) => [
      { env: 'test', config, size: 100, scenario: 'initial render', engineMs: 10 * (i + 1), domMs: 1, ruleRuns: 1, derived: 1 },
      { env: 'test', config, size: 100, scenario: 'reorder item', engineMs: 6 * (i + 1) ** 2, domMs: 0.5, ruleRuns: 1, derived: 1 },
    ])
    runtime.write(PERF_GRAPH, { remove: [], add: new Parser().parse(observationsTurtle(rows, undefined, [100])) as never })
    shell.flush()
    const bars = document.querySelectorAll('[data-sem-c=bar-chart]')[0]!
    expect(bars.querySelectorAll('.sem-seg').length).toBe(6) // 3 measured configurations × (engine, DOM)
    expect(bars.querySelectorAll('.sem-pending').length).toBe(3) // planned but not measured
    expect(document.querySelectorAll('[data-sem-c=heatmap] td.sem-flagged').length).toBe(2) // 24.5 and 54.5 ms reorders
    expect(document.querySelector('[data-sem-c=finding-list]')!.textContent).toContain('At 100 items, hybrid · function renders from scratch in 11 ms, 2.8× faster than oxigraph · sparql · bulk (31 ms).')
  })

  it('draws the scaling chart once there are two sizes, tooltips included (and settles)', () => {
    const { document, runtime, shell, showPage } = mountShell()
    showPage('Performance')
    const rows: Row[] = [100, 300].flatMap((size) =>
      ['hybrid · function', 'n3 · function'].map((config, i) => ({ env: 'test', config, size, scenario: 'initial render', engineMs: (size / 10) * (i + 1), domMs: 1, ruleRuns: 1, derived: 1 })),
    )
    runtime.write(PERF_GRAPH, { remove: [], add: new Parser().parse(observationsTurtle(rows, undefined, [100, 300])) as never })
    shell.flush()
    const chart = document.querySelector('[data-sem-c=line-chart]')!
    expect(chart.querySelectorAll('path.sem-line')).toHaveLength(2)
    expect(chart.querySelectorAll('circle.sem-dot title')).toHaveLength(4)
    expect(chart.querySelector('circle.sem-dot title')!.textContent).toBe('hybrid · function · 100: 11.0 ms')
  })
})

describe('intent preloading (sem:OnIntent)', () => {
  it('evaluates a gallery group when its navigation item is pointed at, before the click', async () => {
    const { attachIntent } = await import('../src/intent.ts')
    const { document, fire, runtime, screen, shell, showPage } = mountShell()
    attachIntent(runtime, shell, { idle: (run) => run(1_000), flush: () => shell.flush() })
    showPage('Components')
    // Runs of every implementation of a rendering (SPARQL or function, whichever is preferred).
    const runs = (rendering: string) => [...screen.engine.stats.byRule].filter(([iri]) => iri.startsWith(NS.c + rendering.replace(/-(fn|sparql)$/, '') + '-')).reduce((n, [, s]) => n + s.runs, 0)
    const nav = (name: string) => [...document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === name)!
    expect(runs('TableRendering')).toBe(0)
    fire(nav('Data'), 'pointerover')
    // Evaluated and built (hidden) ahead of the click; nothing else was.
    expect(runs('TableRendering')).toBeGreaterThan(0)
    expect(document.querySelector('[data-sem-c=table]')!.closest('[hidden]')).not.toBeNull()
    expect(runs('TreeRendering-fn') + runs('TreeRendering-sparql')).toBeGreaterThan(0)
    expect(runs('AccordionRendering-fn') + runs('AccordionRendering-sparql')).toBe(0)
    const before = screen.engine.stats.ruleRuns
    fire(nav('Data'), 'click')
    expect(document.querySelector('[data-sem-c=table]')!.closest('[hidden]')).toBeNull()
    // The click only switches the case: the page is already there.
    expect(screen.engine.stats.ruleRuns - before).toBeLessThan(40)
  })
})
