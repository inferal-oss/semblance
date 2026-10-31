import { describe, expect, it } from 'vitest'
import { todoOps } from '../src/examples/todo.ts'
import { NS, SEM } from '../src/ns.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

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

describe('fields over one node', () => {
  // The Inputs page's fields edit properties of one node (ui:inputsDemo, through c:controls and
  // c:property). Flipping one switch changes one of its properties: only the controls that name that
  // property re-render (the switch and the c:Toggle over the same triple), not every field that
  // follows the node - their queries read the node's predicate as a variable, which the focus names
  // (#153: it was 37 rule runs and ~10 ms on WAT, the validation layer's check alone 9 of them).
  it('re-renders only the controls that name the changed property (wat, SPARQL)', () => {
    const h = mountShell(5, 'wat', 'sparql')
    h.showPage('Components')
    const f = h.store.factory
    const app = f.namedNode(UI + 'app')
    const group = f.namedNode(UI + 'galleryGroup')
    h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupInputs'))] })
    h.shell.flush()
    const flip = () => h.fire((h.shell.nodeOf(`${UI}inp-sw-notify/~root`) as HTMLElement).querySelector('.sem-thumb')!, 'click')
    flip()
    flip()
    const stats = h.screen.engine.stats
    const before = new Map([...stats.byRule].map(([k, v]) => [k, v.runs]))
    flip()
    const ran = [...stats.byRule].filter(([k, v]) => v.runs > (before.get(k) ?? 0)).map(([k]) => k.replace(/^.*[#/]/, ''))
    expect(ran.filter((r) => /Rendering|Check|Shapes/.test(r)).sort()).toEqual(['ToggleRendering-sparql', 'ToggleSwitchRendering-sparql'])
    expect(h.document.querySelectorAll('[data-sem-c=radio-group]').length).toBeGreaterThan(0)
  }, 120_000)
})

describe('a large result table', () => {
  // Its Markdown (c:ResultTableMarkdown-sparql) reads each cell once and names each IRI it shows
  // against the declared prefixes once: it costs the order of the table rendering it reads (which
  // runs the query and renders the rows), and grows with the rows, not with their square or with
  // the square of the declarations. (Times, not counters: the work is inside one query. Each is the
  // least of three runs, the two tables taking turns, so load slows both alike.)
  it('costs its Markdown what its cells are (wat, SPARQL)', () => {
    const h = mountShell(5, 'wat', 'sparql')
    h.fire([...h.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Query')!, 'click')
    const ms = (rule: string) => h.screen.engine.stats.byRule.get(NS.c + rule)?.ms ?? 0
    const run = (limit: number) => {
      const ta = h.document.querySelector('[data-sem-c=query-editor] textarea') as HTMLTextAreaElement
      ta.value = `SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT ${limit}`
      h.fire(ta, 'input')
      const [md, table] = [ms('ResultTableMarkdown-sparql'), ms('ResultTableRendering-sparql')]
      h.fire(h.document.querySelector('[data-sem-c=query-workbench] .sem-toolbar button')!, 'click')
      expect(h.document.querySelectorAll('[data-sem-c=result-table] tbody tr').length).toBe(limit)
      return { md: ms('ResultTableMarkdown-sparql') - md, table: ms('ResultTableRendering-sparql') - table }
    }
    const small = { md: Infinity, table: Infinity }
    const large = { md: Infinity, table: Infinity }
    for (let i = 0; i < 3; i++)
      for (const [limit, least] of [[20, small], [200, large]] as const) {
        const t = run(limit)
        least.md = Math.min(least.md, t.md)
        least.table = Math.min(least.table, t.table)
      }
    // (Measured on WAT: about 5 ms for 200 rows, against 17 ms for the table; it was 7 s.)
    expect(large.md).toBeLessThan(2 * Math.max(large.table, 20))
    expect(large.md).toBeLessThan(20 * Math.max(small.md, 2))
  }, 120_000)
})

describe('idle time', () => {
  it('asks once per focus with parked work, and reads nothing again until something changes', () => {
    const h = mountShell(5, 'wat')
    const engine = h.screen.engine
    const asked = new Map<string, number>()
    const warmable = engine.warmable!
    engine.warmable = (focus) => (asked.set(focus, (asked.get(focus) ?? 0) + 1), warmable(focus))
    h.runtime.warm(8)
    // The hidden pages park many pairs per focus; each focus is asked about once.
    expect(asked.size).toBeGreaterThan(100)
    expect(engine.footprint().deferred).toBeGreaterThan(asked.size * 2)
    expect(Math.max(...asked.values())).toBe(1)
    // A slice with nothing new reads no warmth again, however much is parked.
    let reads = 0
    const { match } = h.store
    h.store.match = (...args) => (args[1]?.value === SEM.warm && reads++, match.apply(h.store, args))
    h.runtime.warm(8)
    expect(reads).toBe(0)
    // A part declared eager is seen at once.
    h.runtime.apply({ add: [h.store.factory.quad(h.store.factory.namedNode('https://semblance.dev/demo#views'), h.store.factory.namedNode(SEM.warm), h.store.factory.namedNode(SEM.Eager))], remove: [] })
    h.runtime.warm(8)
    expect(reads).toBeGreaterThan(0)
  })
})
