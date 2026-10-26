import { describe, expect, it } from 'vitest'
import { todoOps } from '../src/examples/todo.ts'
import { mountShell } from './harness.ts'

/**
 * The cost of an interaction must not depend on how big the app is or how long
 * the session has been. Every interaction is measured in work counters (not
 * time), once with a full change log, and again after the list grew by 300
 * items and the history by 250 more events. The counters must be identical.
 */
function costHarness() {
  const shell = mountShell()
  const { document, window, store, screen, fire } = shell
  const counters = { read: 0, sparqlRows: 0 }
  const { match, select, construct } = store
  store.match = (...args) => {
    const quads = match.apply(store, args)
    counters.read += quads.length
    return quads
  }
  store.select = (...args) => {
    const rows = select.apply(store, args)
    counters.sparqlRows += rows.length
    return rows
  }
  store.construct = (...args) => {
    const quads = construct.apply(store, args)
    counters.sparqlRows += quads.length
    return quads
  }

  const snapshot = () => ({
    ruleRuns: screen.engine.stats.ruleRuns,
    written: screen.engine.stats.derivedAdded + screen.engine.stats.derivedRemoved,
    read: counters.read,
    sparqlRows: counters.sparqlRows,
    domOps: shell.shell.ops,
    // Maintained views (docs/IVM.md): rows their operators processed, and the state they hold.
    viewRows: shell.runtime.views.totals.rowsIn,
    viewState: shell.runtime.views.totals.state,
  })
  const measure = (action: () => void) => {
    const a = snapshot()
    action()
    const b = snapshot()
    return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v - a[k as keyof typeof a]]))
  }

  const $ = (selector: string) => document.querySelector(selector) as HTMLElement
  const button = (text: string) => {
    const all = [...document.querySelectorAll('button, [role=tab]')]
    return (all.find((b) => b.textContent!.trim() === text) ?? all.find((b) => b.textContent!.trim().endsWith(text))) as HTMLElement
  }
  let hovered = 0
  let moved = 0
  const field = () => $('[data-sem-c=text-field] input') as HTMLInputElement
  const key = (k: string, mods: object, target: EventTarget) => {
    const e = new window.Event('keydown', { bubbles: true, cancelable: true })
    Object.assign(e, { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
    target.dispatchEvent(e)
    shell.shell.flush()
  }
  const type = (value: string) => {
    field().value = value
    fire(field(), 'input')
  }

  const interactions: Record<string, () => void> = {
    toggle: () => {
      const box = $('[data-sem-c=list-item] input') as HTMLInputElement
      box.checked = !box.checked
      fire(box, 'change')
    },
    type: () => type(field().value === 'a' ? 'b' : 'a'),
    hover: () => fire(document.querySelectorAll('[data-sem-c=list-item] label')[hovered++ % 2]!, 'mouseover'),
    density: () => fire(button('Toggle density'), 'click'),
    theme: () => {
      fire(button('Night'), 'click')
      fire(button('Match'), 'click')
    },
    tabs: () => {
      fire(button('Change log'), 'click')
      fire(button('Inspector'), 'click')
    },
    page: () => {
      fire(button('Docs'), 'click')
      fire(button('Examples'), 'click')
    },
    flip: () => {
      fire($('[data-sem-c=flippable] .sem-flip'), 'click')
      fire($('[data-sem-c=flippable] .sem-flip'), 'click')
    },
    move: () => {
      // The Activity window (the tools are a window too, docked).
      const activity = [...document.querySelectorAll('[data-sem-c=window]')].find((w) => w.querySelector('.sem-window-bar strong')!.textContent === 'Activity')!
      activity.querySelector('.sem-window-bar')!.dispatchEvent(new window.CustomEvent('sem-move', { bubbles: true, detail: { x: 100 + (moved++ % 2) * 50, y: 120 } }))
    },
    add: () => {
      type('another')
      fire(button('Add'), 'click')
    },
    // The command palette: opened with its key, searched (it lists every command, shortcut and
    // place, none of which grow with the list or the log), closed with Escape.
    palette: () => {
      key('k', { ctrlKey: true }, document.body)
      const search = $('[data-sem-c=command-palette] input') as HTMLInputElement
      search.value = 'in'
      fire(search, 'input')
      shell.shell.flush()
      key('ArrowDown', {}, search)
      key('Escape', {}, search)
    },
  }

  const events = (n: number) => {
    for (let i = 0; i < n; i++) type('x'.repeat((i % 7) + 1))
  }
  const grow = (items: number) => {
    const ops = todoOps(store)
    const base = 10_000 + store.match(null, null, null).length
    const more = Array.from({ length: items }, (_, i) => ops.addItem(`more-${base}-${i}`, `More ${i}`, base + i))
    shell.runtime.apply({ remove: [], add: more.flatMap((d) => d.add) })
    shell.shell.flush()
  }
  return { ...shell, interactions, measure, events, grow, button, $ }
}

describe('interaction cost', () => {
  it('is the same for every interaction as the app and its history grow', () => {
    const h = costHarness()
    h.events(250) // beyond the change log's bound, so retirement is part of every measurement
    h.fire(h.$('[aria-label="Open Activity in a window"]'), 'click') // a window to move
    const run = () =>
      Object.fromEntries(
        Object.entries(h.interactions).map(([name, act]) => {
          act() // warm: lazily built parts (back sides, catch-up of parked views) are built once
          act()
          return [name, h.measure(act)]
        }),
      )
    const before = run()
    h.grow(300)
    h.events(250)
    const after = run()
    // Content differs slightly between runs (other values, other text lengths); growth in
    // proportion to 300 items or 250 events would be far outside this margin.
    const grew = Object.entries(after).flatMap(([name, cost]) =>
      Object.entries(cost)
        .filter(([k, v]) => v > before[name]![k]! * 1.1 + 8)
        .map(([k, v]) => `${name}.${k}: ${before[name]![k]} -> ${v}`),
    )
    expect(grew).toEqual([])
  }, 120_000)
})
