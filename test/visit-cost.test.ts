import { describe, expect, it } from 'vitest'
import { mountSite } from './harness.ts'
import { type Page, sitePages } from './site-clicks.ts'

const UI = 'https://semblance.dev/demo#'

/**
 * A click costs what it changes, not how long the visit has been (#465). The site's page switches
 * (c:Switch) keep a hidden case's rendering in the graph and its elements aside, but not in the
 * document (c:caseRetention), and the host's work on an event or a patch asks the renderer for the
 * elements that bear what it looks for (DomRenderer.marked) instead of searching the document. So
 * after every page of the site has been shown, the document holds the page shown and a click on it
 * costs what it cost on a fresh visit: the same work counters, a document of the same size, and no
 * search of the whole document.
 */
describe('a click after visiting every page', () => {
  it('costs what it costs fresh', () => {
    const site = mountSite('wat')
    const { document, store, screen, shell, runtime } = site
    const f = store.factory
    const app = f.namedNode(UI + 'app')
    const set = (p: string, o: string) => runtime.apply({ remove: store.match(app, f.namedNode(UI + p), null), add: [f.quad(app, f.namedNode(UI + p), f.namedNode(o))] })
    const show = ({ page, dimension, value }: Page) => {
      if (dimension && value) set(dimension, value)
      set('page', UI + page)
      shell.flush()
    }

    // Work counters, as test/cost.test.ts counts them, and searches of the whole document: a query
    // from the renderer's host or above it.
    const counters = { read: 0, sparqlRows: 0, searches: 0 }
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
    const host = shell.host
    for (const target of [host, document]) {
      for (let proto = Object.getPrototypeOf(target); proto; proto = Object.getPrototypeOf(proto)) {
        for (const name of ['querySelectorAll', 'querySelector'] as const) {
          const own = Object.getOwnPropertyDescriptor(proto, name)
          if (!own || typeof own.value !== 'function' || own.value.counted) continue
          const original = own.value
          const counted = function (this: Node, ...args: unknown[]) {
            if (this === host || (this as Node).contains?.(host)) counters.searches++
            return original.apply(this, args)
          }
          counted.counted = true
          Object.defineProperty(proto, name, { ...own, value: counted })
        }
      }
    }
    const snapshot = () => ({
      ruleRuns: screen.engine.stats.ruleRuns,
      written: screen.engine.stats.derivedAdded + screen.engine.stats.derivedRemoved,
      read: counters.read,
      sparqlRows: counters.sparqlRows,
      domOps: shell.ops,
      searches: counters.searches,
    })
    const measure = (action: () => void) => {
      const a = snapshot()
      const t = performance.now()
      action()
      const ms = performance.now() - t
      const b = snapshot()
      return { cost: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v - a[k as keyof typeof a]])), ms }
    }
    // (Counted by walking the document, once a measurement is done.)
    const elements = () => host.getElementsByTagName('*').length

    const actions: Page = { page: 'Components', dimension: 'galleryGroup', value: UI + 'GroupActions' }
    // (The test's own lookup is not a search the host makes.)
    const page = () => {
      const searches = counters.searches
      const shown = host.querySelector('[data-sem-c=stack] > [data-sem-c=switch] > :not([hidden])')!
      counters.searches = searches
      return shown
    }
    const click = (el: Element) => {
      el.dispatchEvent(new site.window.Event('click', { bubbles: true }))
      shell.flush()
    }
    // A specimen's flip (it shows how the view is made, and back), a size chosen in a specimen, and
    // the page left and shown again.
    const interactions: Record<string, () => void> = {
      flip: () => {
        for (let i = 0; i < 2; i++) click([...page().querySelectorAll('[data-sem-c=flippable] .sem-flip')][0]!)
      },
      choose: () => {
        const size = (label: string) => [...page().querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!
        click(size('Large'))
        click(size('Small'))
      },
      revisit: () => {
        show({ page: 'Home' })
        show(actions)
      },
    }
    const run = () => {
      show(actions)
      return Object.fromEntries(
        Object.entries(interactions).map(([name, act]) => {
          act() // warm: what is shown the first time is rendered once
          act()
          return [name, measure(act)]
        }),
      )
    }

    const fresh = run()
    const freshElements = elements()
    const pages = Object.values(sitePages()).flat()
    for (const p of pages) show(p)
    expect(pages.length).toBeGreaterThan(40)
    const visited = run()
    const visitedElements = elements()

    // Content differs slightly (another time, other members in the change log); growth in proportion
    // to fifty pages would be far outside this margin.
    const grew = Object.entries(visited).flatMap(([name, { cost }]) =>
      Object.entries(cost)
        .filter(([k, v]) => v > fresh[name]!.cost[k]! * 1.1 + 8)
        .map(([k, v]) => `${name}.${k}: ${fresh[name]!.cost[k]} -> ${v}`),
    )
    expect(grew).toEqual([])
    expect(Object.values(visited).map(({ cost }) => cost.searches)).toEqual([0, 0, 0])
    // The document holds what is shown (the visited pages wait aside, out of it).
    expect(visitedElements).toBeLessThan(freshElements * 1.2 + 100)
    console.log(
      `a click after ${pages.length} pages:`,
      Object.entries(visited)
        .map(([name, { ms }]) => `${name} ${fresh[name]!.ms.toFixed(1)} -> ${ms.toFixed(1)} ms`)
        .join(', '),
      `; elements ${freshElements} -> ${visitedElements}`,
    )
    runtime.dispose()
  }, 300_000)
})
