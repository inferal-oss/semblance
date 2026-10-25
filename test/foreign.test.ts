import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { Islands } from '../src/foreign.ts'
import { loadStore } from '../src/node/load.ts'
import { BEH, C, EVENTS_GRAPH, LDES, MOD, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML, toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { DEFAULT_LAYERS } from '../src/web/mount.ts'
import { foreignExampleFunctions } from '../examples/foreign/functions.ts'
import { spark } from '../examples/foreign/spark.ts'
import { defineStarRating } from '../examples/foreign/star-rating.ts'

// examples/foreign is the spike of docs/FOREIGN.md: a custom element (<star-rating>) and a vanilla
// widget (the spark chart) as islands, their inputs projected from the graph and their outputs turned
// into events. Driven through DOM events on the foreign components themselves, as a person would.

const EX = 'https://example.org/foreign#'
const read = (f: string) => readFileSync(new URL('../examples/foreign/' + f, import.meta.url), 'utf8')
const foreign = read('foreign.ttl')
const app = read('app.ttl')

function mount(kind: 'wat' | 'oxigraph', prefer: 'sparql' | 'function' = 'sparql', extra = 0) {
  const store = loadStore(kind, foreign, withMore(app, extra))
  const runtime = new Runtime(store)
  const projection = (modality: string, name: string) =>
    runtime.project({ modality, layers: DEFAULT_LAYERS, prefer, functions: foreignExampleFunctions, name, roots: [EX + 'page'] }, (e) => {
      throw e
    })
  const screen = projection(MOD.Screen, 'screen')
  const text = projection(MOD.Text, 'text')
  const win = parseHTML('<!doctype html><html><head></head><body><div id="app"></div></body></html>')
  const { document, window } = win
  defineStarRating(win as never)
  const renderer = new DomRenderer(screen.index, document.getElementById('app')!, EX + 'page')
  renderer.flush()
  const bus = new EventBus(runtime, screen)
  bus.attach(renderer, () => renderer.flush())
  const islands = new Islands(bus, renderer, { widgets: { spark }, onHandled: () => renderer.flush(), onError: (e) => { throw e } })
  islands.attach()
  const f = store.factory
  const value = (s: string, p = C.value) => store.match(f.namedNode(EX + s), f.namedNode(p), null, f.defaultGraph()).map((q) => q.object.value)
  const logged = () => store.match(f.namedNode(BEH.ChangeLog), f.namedNode(LDES.member), null, f.namedNode(EVENTS_GRAPH)).length
  const rating = () => document.querySelector('[data-sem-c=ex-rating] star-rating') as HTMLElement & { value: number }
  const bars = () => [...document.querySelectorAll('[data-sem-c=ex-spark] .spark-bar')] as HTMLElement[]
  const fire = (el: Element, type: string, init: object = {}) => el.dispatchEvent(new window.Event(type, { bubbles: true, ...init }))
  // linkedom has no KeyboardEvent: a keydown Event carrying the key.
  const key = (el: Element, k: string) => el.dispatchEvent(Object.assign(new window.Event('keydown', { bubbles: true }), { key: k }))
  return { store, runtime, screen, text, document, window, renderer, bus, islands, value, logged, rating, bars, fire, key }
}

const html = (h: ReturnType<typeof mount>) => toHTML(h.screen.index, EX + 'page')

/** The app with `n` more ratings on the page (islands of their own, with values of their own). */
function withMore(turtle: string, n: number): string {
  if (!n) return turtle
  const ids = Array.from({ length: n }, (_, i) => `ex:more${i}`)
  return (
    turtle.replace('c:children ( ex:title ex:intro ex:rating ex:slider ex:week ex:add ) .', 'c:children ( ex:title ex:intro ex:rating ex:slider ex:week ex:add ex:more ) .') +
    `\nex:more a c:Stack ; c:children ( ${ids.join(' ')} ) .\n` +
    ids.map((id, i) => `${id} a ex:Rating ; c:value ${i % 6} ; ex:max 5 ; c:label "More ${i}" .`).join('\n')
  )
}

describe('foreign components', () => {
  for (const kind of ['wat', 'oxigraph'] as const) {
    it(`mounts a custom element with its inputs from the graph, and a pick round-trips (${kind})`, async () => {
      const h = mount(kind)
      await h.islands.settled()
      const el = h.rating()
      expect(el).toBeTruthy()
      expect(el.value).toBe(3)
      expect(typeof el.value).toBe('number')
      expect(el.getAttribute('max')).toBe('5')
      expect(el.getAttribute('aria-label')).toBe('Coffee')
      expect(el.getAttribute('aria-valuenow')).toBe('3')
      // A click on its fourth star (inside its shadow root): an ex:Rated event, recorded; the graph takes it.
      const before = h.logged()
      fire4(h)
      expect(h.value('rating')).toEqual(['4'])
      expect(h.value('slider')).toEqual(['4'])
      expect(h.logged()).toBe(before + 1)
      expect(el.value).toBe(4)
      // The echo of its own value was not written back to it, and the slider followed.
      expect(h.islands.counts.mounts).toBe(2)
      expect((h.document.querySelector('[data-sem-c=slider] input') as HTMLInputElement).value).toBe('4')
    })
  }

  it('pushes a change made elsewhere (the slider) to the element, and nothing else', async () => {
    const h = mount('wat')
    await h.islands.settled()
    const slider = h.document.querySelector('[data-sem-c=slider] input') as HTMLInputElement
    const updates = h.islands.counts.updates
    slider.value = '1'
    h.fire(slider, 'input')
    expect(h.value('rating')).toEqual(['1'])
    expect(h.rating().value).toBe(1)
    // One push, to the rating only: the chart's inputs did not change.
    expect(h.islands.counts.updates).toBe(updates + 1)
  })

  it('keeps the graph the source of truth: a clamped value goes back to the element', async () => {
    const h = mount('wat')
    await h.islands.settled()
    // A component raising a value its maximum does not allow (as an out-of-date one might): the reaction clamps it.
    h.rating().dispatchEvent(new h.window.CustomEvent('change', { detail: { value: 9 }, bubbles: true }))
    expect(h.value('rating')).toEqual(['5'])
    expect(h.rating().value).toBe(5)
  })

  it('drops what a component says while it is being told something (echo suppression)', async () => {
    const h = mount('wat')
    await h.islands.settled()
    const el = h.rating()
    // A component that announces programmatic changes too, as some do.
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: () => Number(el.getAttribute('aria-valuenow')),
      set(v: number) {
        set.call(el, v)
        el.dispatchEvent(new h.window.CustomEvent('change', { detail: { value: v }, bubbles: true }))
      },
    })
    const before = h.logged()
    const slider = h.document.querySelector('[data-sem-c=slider] input') as HTMLInputElement
    slider.value = '2'
    h.fire(slider, 'input')
    expect(el.value).toBe(2)
    expect(h.islands.counts.echoes).toBe(1)
    // The slider's input is the only event logged; the echo was not an event.
    expect(h.logged()).toBe(before + 1)
  })

  it('follows the arrow keys the way the page reads (RTL swaps them)', async () => {
    const h = mount('wat')
    await h.islands.settled()
    h.key(h.rating(), 'ArrowRight')
    expect(h.value('rating')).toEqual(['4'])
    h.document.documentElement.setAttribute('dir', 'rtl')
    h.key(h.rating(), 'ArrowRight')
    expect(h.value('rating')).toEqual(['3'])
  })

  it('mounts a vanilla widget with typed JSON inputs, and its outputs become events, recorded or not', async () => {
    const h = mount('wat')
    await h.islands.settled()
    expect(h.bars().map((b) => b.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])
    expect(h.bars().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false', 'false'])
    // Choosing a bar: a recorded ex:Picked, with its index as a further statement.
    const before = h.logged()
    h.fire(h.bars()[3]!, 'click')
    expect(h.value('week')).toEqual(['Thu'])
    expect(h.logged()).toBe(before + 1)
    const f = h.store.factory
    const picked = h.store.match(null, f.namedNode(NS.rdf + 'type'), f.namedNode(EX + 'Picked'), f.namedNode(EVENTS_GRAPH))[0]!.subject
    expect(h.store.match(picked, f.namedNode(EX + 'index'), null, f.namedNode(EVENTS_GRAPH))[0]?.object.value).toBe('3')
    expect(h.bars().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'true', 'false'])
    // Pointing at a bar: state, but not a member of the change log.
    h.fire(h.bars()[0]!, 'pointerenter', { bubbles: false })
    expect(h.value('week', EX + 'pointing')).toEqual(['Mon'])
    expect(h.logged()).toBe(before + 1)
  })

  it("pushes the widget's data when the graph it is derived from changes", async () => {
    const h = mount('wat')
    await h.islands.settled()
    const add = [...h.document.querySelectorAll('button')].find((b) => b.textContent === 'Another cup on Friday')!
    const fri = () => h.bars()[4]!.getAttribute('aria-label')
    expect(fri()).toBe('Fri: 2')
    h.fire(add, 'click')
    expect(fri()).toBe('Fri: 3')
  })

  it('renders on the server as a custom element tag with its attribute inputs, and as text', () => {
    const h = mount('wat')
    expect(html(h)).toContain('<star-rating aria-label="Coffee" max="5"></star-rating>')
    const text = toText(h.text.index, EX + 'page')
    expect(text).toContain('Coffee: 3')
    expect(text).toContain('Cups this week: Wed')
  })

  it('renders the same HTML with the SPARQL rules and their function twins, after every step', async () => {
    const sparql = mount('wat', 'sparql')
    const fn = mount('wat', 'function')
    const same = () => {
      expect(html(fn)).toBe(html(sparql))
      expect(toText(fn.text.index, EX + 'page')).toBe(toText(sparql.text.index, EX + 'page'))
    }
    await Promise.all([sparql.islands.settled(), fn.islands.settled()])
    same()
    for (const h of [sparql, fn]) fire4(h)
    same()
    for (const h of [sparql, fn]) h.fire(h.bars()[1]!, 'click')
    same()
    expect(fn.value('week')).toEqual(['Tue'])
  })

  it('costs what it changes: an input change is one push, however many islands there are', async () => {
    const measure = async (extra: number) => {
      const h = mount('wat', 'sparql', extra)
      await h.islands.settled()
      expect(h.islands.size).toBe(2 + extra)
      const slider = h.document.querySelector('[data-sem-c=slider] input') as HTMLInputElement
      const before = { runs: h.screen.engine.stats.ruleRuns, ops: h.renderer.ops, updates: h.islands.counts.updates, mounts: h.islands.counts.mounts }
      slider.value = '1'
      h.fire(slider, 'input')
      expect(h.rating().value).toBe(1)
      return {
        runs: h.screen.engine.stats.ruleRuns - before.runs,
        ops: h.renderer.ops - before.ops,
        updates: h.islands.counts.updates - before.updates,
        mounts: h.islands.counts.mounts - before.mounts,
      }
    }
    const small = await measure(0)
    const large = await measure(60)
    expect(small.updates).toBe(1)
    expect(small.mounts).toBe(0)
    expect(large).toEqual(small)
  })

  it('destroys an island when it leaves the graph', async () => {
    const h = mount('wat')
    await h.islands.settled()
    const f = h.store.factory
    // The chart stops being a chart: its rendering goes, and its widget is destroyed; the rating stays.
    h.runtime.apply({ remove: h.store.match(f.namedNode(EX + 'week'), f.namedNode(NS.rdf + 'type'), null), add: [] })
    h.renderer.flush()
    expect(h.bars()).toHaveLength(0)
    expect(h.islands.counts.destroys).toBe(1)
    expect(h.islands.size).toBe(1)
    expect(h.rating()).toBeTruthy()
  })
})

/**
 * A pick of four stars. linkedom does not carry an event out of a shadow root to its host, so the
 * pick is the arrow key from three (the element's own keyboard pattern), which raises the same change.
 */
function fire4(h: ReturnType<typeof mount>) {
  expect(h.rating().value).toBe(3)
  h.key(h.rating(), 'ArrowRight')
}
