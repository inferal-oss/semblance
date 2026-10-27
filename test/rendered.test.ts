// The rendered state (ontology/layers/rendered.ttl, src/rendered.ts): what the page knows about
// the components that ask for it, in the rendered graph, measured from a stand-in layout (linkedom
// has none) and driven by events as the page would drive it.
import type { Quad } from '@rdfjs/types'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { EVENTS_GRAPH, MOD, NS, RDF_TYPE, RENDERED_GRAPH, RND } from '../src/ns.ts'
import { RenderedState, stateOf, VIEWPORT } from '../src/rendered.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import { SCREEN_LAYERS } from './helpers.ts'
import { FakeLayout } from './rendered-layout.ts'

const EX = 'https://example.org/rendered#'
const PREFIXES = `@prefix c: <${NS.c}> . @prefix rnd: <${NS.rnd}> . @prefix ex: <${EX}> .`

/** Three buttons and a panel with one more inside, all observed (or as `scope` says). */
function app(scope = 'rnd:observes rnd:Overlap , rnd:Visibility , rnd:Focus , rnd:Hover , rnd:Press , rnd:Scroll , rnd:Open', extra = '') {
  return `${PREFIXES}
ex:root a c:Stack ; c:children ( ex:a ex:b ex:panel ) ; ${scope} .
ex:a a c:Button ; c:label "A" .
ex:b a c:Button ; c:label "B" .
ex:panel a c:Stack ; c:children ( ex:c ) .
ex:c a c:Button ; c:label "C" .
${extra}`
}

function mount(graph: string, kind: StoreKind = 'oxigraph') {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const store = loadStore(kind, graph)
  const runtime = new Runtime(store)
  // Every tick, each maintained view is compared with a from-scratch run of its query.
  runtime.views.strict = true
  const screen = runtime.project({ modality: MOD.Screen, layers: SCREEN_LAYERS, name: 'screen', roots: [EX + 'root'] }, (e) => {
    throw e
  })
  const shell = new DomRenderer(screen.index, document.getElementById('app')!, EX + 'root')
  shell.flush()
  const bus = new EventBus(runtime, screen, {})
  bus.attach(shell, () => shell.flush())
  const layout = new FakeLayout((el) => {
    const key = shell.keyOf(el)
    return key === undefined ? undefined : screen.index.focusOf(key)
  })
  const writes: { add: Quad[]; remove: Quad[] }[] = []
  const rendered = new RenderedState(runtime, shell, { layout, frame: () => {}, onWrite: (d) => (writes.push(d), shell.flush()) })
  const stop = rendered.attach()
  const f = store.factory
  const g = f.namedNode(RENDERED_GRAPH)
  const of = (component: string, p: string) => store.match(f.namedNode(stateOf(EX + component)), f.namedNode(p), null, g).map((q) => q.object.value)
  const one = (component: string, p: string) => of(component, p)[0]
  const el = (component: string) => shell.nodeOf(screen.index.rootOf(EX + component)!) as Element
  const fire = (target: Element, type: string, init: object = {}) => target.dispatchEvent(new window.Event(type, { bubbles: true, ...init }))
  const overlaps = () =>
    store
      .match(null, f.namedNode(RND.overlaps), null)
      .map((q) => [q.subject.value, q.object.value].map((s) => decodeURIComponent(s.slice('urn:semblance:rendered:'.length)).slice(EX.length)).join('~'))
      .sort()
  /** The layout changed (in a browser an observer would say so): measure. */
  const relayout = () => (rendered.invalidate(), rendered.flush())
  return { document, window, store, runtime, screen, shell, layout, rendered, stop, writes, of, one, el, fire, overlaps, relayout, f, g }
}

/** The usual layout: A and B side by side and overlapping a little, the panel below with C in it. */
function placed(kind?: StoreKind, graph = app()) {
  const h = mount(graph, kind)
  h.layout.place(EX + 'root', 0, 0, 1000, 2000).place(EX + 'a', 10, 10, 100, 40).place(EX + 'b', 100, 10, 100, 40).place(EX + 'panel', 0, 1200, 1000, 400).place(EX + 'c', 20, 1220, 80, 30)
  h.rendered.flush()
  return h
}

describe('rendered state: geometry and visibility', () => {
  it('writes each observed component\'s box in document pixels, the viewport once, and nothing to the input or the change log', () => {
    const h = placed()
    expect([h.one('a', RND.x), h.one('a', RND.y), h.one('a', RND.width), h.one('a', RND.height)]).toEqual(['10', '10', '100', '40'])
    expect(h.one('c', RND.of)).toBe(EX + 'c')
    expect(h.of('c', RDF_TYPE)).toEqual([RND.State])
    // C is inside the panel and the root (both observed with geometry).
    expect(h.of('c', RND.within).sort()).toEqual([stateOf(EX + 'panel'), stateOf(EX + 'root')].sort())
    const vp = (p: string) => h.store.match(h.f.namedNode(VIEWPORT), h.f.namedNode(p), null, h.g)[0]?.object.value
    expect([vp(RND.width), vp(RND.height), vp(RND.scrollTop)]).toEqual(['1280', '800', '0'])
    // Off screen below the fold, on screen above it.
    expect([h.one('a', RND.inViewport), h.one('a', RND.ratio)]).toEqual(['true', '1'])
    expect([h.one('panel', RND.inViewport), h.one('panel', RND.ratio)]).toEqual(['false', '0'])
    expect(h.one('a', RND.rendered)).toBe('true')
    // Nothing reached the default graph or the change log.
    expect(h.store.match(null, h.f.namedNode(RND.x), null, h.f.defaultGraph())).toHaveLength(0)
    expect(h.store.match(null, null, null, h.f.namedNode(EVENTS_GRAPH)).filter((q) => q.subject.value.startsWith('urn:semblance:rendered'))).toHaveLength(0)
  })

  it('rounds to whole pixels and writes only what changed', () => {
    const h = placed()
    const before = h.writes.length
    h.layout.place(EX + 'a', 10.4, 10.2, 100.3, 39.8)
    h.relayout()
    expect(h.writes.length).toBe(before)
    h.layout.place(EX + 'a', 30, 10, 100, 40)
    h.relayout()
    const last = h.writes.at(-1)!
    expect(last.add.map((q) => q.predicate.value.slice(NS.rnd.length))).toEqual(['x'])
    expect(last.remove.map((q) => q.predicate.value.slice(NS.rnd.length))).toEqual(['x'])
  })

  it('scrolling the page moves no box: the viewport says where it is, and what it brings into view', () => {
    const h = placed()
    const reads = h.layout.reads
    h.layout.view.scrollTop = 900
    h.rendered.flush()
    // No box is read: the page's scroll moves none.
    expect(h.layout.reads).toBe(reads)
    const last = h.writes.at(-1)!
    // The viewport's offset; A leaves the viewport, the panel enters it (all of it: 1200-1600 against 900-1700).
    expect(last.add.filter((q) => q.predicate.value === RND.x || q.predicate.value === RND.y)).toHaveLength(0)
    expect(h.store.match(h.f.namedNode(VIEWPORT), h.f.namedNode(RND.scrollTop), null, h.g)[0]?.object.value).toBe('900')
    expect([h.one('a', RND.inViewport), h.one('panel', RND.inViewport), h.one('panel', RND.ratio)]).toEqual(['false', 'true', '1'])
    expect(h.one('a', RND.y)).toBe('10')
  })

  it('what moves with the viewport is placed in it: scrolling moves it no more than the rest, and it overlaps only its kind', () => {
    const h = mount(app())
    // The panel is fixed to the bottom of the viewport, over A and B as the page lies.
    h.layout.fixedOnes.add(EX + 'panel')
    h.layout.place(EX + 'root', 0, 0, 1000, 2000).place(EX + 'a', 10, 10, 100, 40).place(EX + 'b', 300, 10, 100, 40).place(EX + 'panel', 0, 0, 1000, 100).place(EX + 'c', 20, 20, 80, 30)
    h.relayout()
    expect([h.one('panel', RND.fixed), h.one('panel', RND.y), h.one('c', RND.fixed), h.one('a', RND.fixed)]).toEqual(['true', '0', 'true', undefined])
    expect(h.of('panel', RND.cell).sort()).toEqual(['v0,0', 'v1,0', 'v2,0', 'v3,0'])
    // Boxes of the page and of the viewport are not compared.
    expect(h.overlaps()).toEqual([])
    const before = h.writes.length
    h.layout.view.scrollTop = 300
    h.rendered.flush()
    const last = h.writes.at(-1)!
    expect(h.writes.length).toBe(before + 1)
    expect(last.add.map((q) => q.predicate.value.slice(NS.rnd.length)).sort()).toEqual(['inViewport', 'inViewport', 'ratio', 'ratio', 'scrollTop'].sort())
  })

  it('a hidden component is not rendered and has no box', () => {
    const h = placed()
    h.layout.hidden.add(EX + 'panel')
    h.relayout()
    expect([h.one('panel', RND.rendered), h.one('panel', RND.x)]).toEqual(['false', undefined])
    // Its contents are hidden with it.
    expect([h.one('c', RND.rendered), h.one('c', RND.inViewport)]).toEqual(['false', 'false'])
  })
})

describe('rendered state: overlap', () => {
  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`pairs whose boxes share area, neither inside the other, maintained as boxes move (${kind})`, () => {
      const h = placed(kind)
      // A and B overlap (100-110); the root holds everything, and the panel holds C: not overlaps.
      expect(h.overlaps()).toEqual(['a~b', 'b~a'])
      // C moves up onto A and B, still inside the panel's subtree (not its box): it overlaps both.
      h.layout.place(EX + 'c', 50, 20, 80, 30)
      h.relayout()
      expect(h.overlaps()).toEqual(['a~b', 'a~c', 'b~a', 'b~c', 'c~a', 'c~b'])
      // B moves away: only A and C.
      h.layout.place(EX + 'b', 600, 600, 100, 40)
      h.relayout()
      expect(h.overlaps()).toEqual(['a~c', 'c~a'])
      // Touching edges is not overlapping.
      h.layout.place(EX + 'c', 110, 10, 80, 30)
      h.relayout()
      expect(h.overlaps()).toEqual([])
    })
  }

  it('only components that ask for overlap are joined, and in the cells their boxes cover', () => {
    const h = placed(undefined, app('rnd:observes rnd:Geometry', 'ex:a rnd:observesSelf rnd:Overlap . ex:b rnd:observesSelf rnd:Overlap .'))
    expect(h.of('a', RND.cell)).toEqual(['0,0'])
    expect(h.of('panel', RND.cell)).toEqual([])
    expect(h.overlaps()).toEqual(['a~b', 'b~a'])
    // A box across a cell edge covers both cells.
    h.layout.place(EX + 'a', 200, 10, 100, 40)
    h.relayout()
    expect(h.of('a', RND.cell).sort()).toEqual(['0,0', '1,0'])
  })
})

describe('rendered state: focus, pointer, scroll, open', () => {
  it('the focus: the innermost observed component holding it, and every one around it', () => {
    const h = placed()
    const button = h.el('c')
    h.layout.focusRing = true
    h.fire(button, 'focusin')
    h.rendered.flush()
    expect([h.one('c', RND.focused), h.one('c', RND.focusWithin), h.one('c', RND.focusVisible)]).toEqual(['true', 'true', 'true'])
    expect([h.one('panel', RND.focused), h.one('panel', RND.focusWithin), h.one('root', RND.focusWithin)]).toEqual([undefined, 'true', 'true'])
    // Moving to A: C and the panel let go.
    h.fire(button, 'focusout', { relatedTarget: h.el('a') })
    h.fire(h.el('a'), 'focusin')
    h.rendered.flush()
    expect([h.one('c', RND.focusWithin), h.one('panel', RND.focusWithin), h.one('a', RND.focused)]).toEqual([undefined, undefined, 'true'])
    // Leaving the page: nobody has it.
    h.fire(h.el('a'), 'focusout')
    h.rendered.flush()
    expect(h.store.match(null, h.f.namedNode(RND.focusWithin), null, h.g)).toHaveLength(0)
  })

  it('hover and press: the innermost observed component, while it lasts', () => {
    const h = placed()
    h.fire(h.el('c'), 'pointerover')
    h.rendered.flush()
    expect([h.one('c', RND.hovered), h.one('panel', RND.hovered)]).toEqual(['true', undefined])
    h.fire(h.el('c'), 'pointerdown')
    h.rendered.flush()
    expect(h.one('c', RND.pressed)).toBe('true')
    h.window.dispatchEvent(new h.window.Event('pointerup'))
    h.fire(h.el('c'), 'pointerout')
    h.rendered.flush()
    expect([h.one('c', RND.pressed), h.one('c', RND.hovered)]).toEqual([undefined, undefined])
  })

  it('a component observed only for the focus has a node only while it has it', () => {
    const h = placed(undefined, app('rnd:observes rnd:Focus'))
    expect(h.store.match(null, null, null, h.g)).toHaveLength(0)
    h.fire(h.el('b'), 'focusin')
    h.rendered.flush()
    expect(h.of('b', RDF_TYPE)).toEqual([RND.State])
    h.fire(h.el('b'), 'focusout')
    h.rendered.flush()
    expect(h.store.match(null, null, null, h.g)).toHaveLength(0)
  })

  it('scroll: how far, in steps of 8, and whether at the start or the end', () => {
    const h = placed()
    h.layout.scrolls.set(EX + 'panel', { top: 0, left: 0, height: 1000, width: 1000, clientHeight: 400, clientWidth: 1000 })
    h.relayout()
    expect([h.one('panel', RND.overflows), h.one('panel', RND.atStart), h.one('panel', RND.atEnd)]).toEqual(['true', 'true', 'false'])
    h.layout.scrolls.set(EX + 'panel', { top: 299, left: 0, height: 1000, width: 1000, clientHeight: 400, clientWidth: 1000 })
    h.relayout()
    expect([h.one('panel', RND.scrollTop), h.one('panel', RND.atStart)]).toEqual(['296', 'false'])
    // Two pixels less is the same step: nothing is written.
    const before = h.writes.length
    h.layout.scrolls.set(EX + 'panel', { top: 297, left: 0, height: 1000, width: 1000, clientHeight: 400, clientWidth: 1000 })
    h.relayout()
    expect(h.writes.length).toBe(before)
    h.layout.scrolls.set(EX + 'panel', { top: 600, left: 0, height: 1000, width: 1000, clientHeight: 400, clientWidth: 1000 })
    h.relayout()
    expect(h.one('panel', RND.atEnd)).toBe('true')
    // Buttons that do not scroll say so.
    expect(h.one('a', RND.overflows)).toBe('false')
  })

  it('open: a native details, dialog or popover, read when it toggles, and whether it is in the top layer', () => {
    const h = placed(undefined, app('rnd:observes rnd:Open'))
    h.layout.opened.set(EX + 'panel', false)
    // Read when first observed only: nothing says it changed yet.
    h.relayout()
    expect(h.one('panel', RND.open)).toBeUndefined()
    h.layout.opened.set(EX + 'panel', true)
    h.layout.topLayers.add(EX + 'panel')
    h.relayout()
    expect(h.one('panel', RND.open)).toBeUndefined()
    // The toggle event says so. It does not bubble: a browser runs the effect's capture listener
    // anyway; linkedom reaches an ancestor's listener only when the event bubbles.
    h.el('panel').dispatchEvent(new h.window.Event('toggle', { bubbles: true }))
    h.rendered.flush()
    expect([h.one('panel', RND.open), h.one('panel', RND.topLayer)]).toEqual(['true', 'true'])
    // Other components are not read for it.
    expect(h.one('a', RND.open)).toBeUndefined()
  })

  it('animating: while an animation or transition runs on it or inside it', () => {
    const h = placed(undefined, app('rnd:observes rnd:Animation'))
    const fire = (type: string, name: string) => {
      const e = new h.window.Event(type, { bubbles: true }) as Event & { animationName?: string }
      e.animationName = name
      h.el('c').dispatchEvent(e)
    }
    fire('animationstart', 'fade')
    h.rendered.flush()
    expect([h.one('c', RND.animating), h.one('panel', RND.animating), h.one('a', RND.animating)]).toEqual(['true', 'true', undefined])
    fire('animationend', 'fade')
    h.rendered.flush()
    expect(h.store.match(null, h.f.namedNode(RND.animating), null, h.g)).toHaveLength(0)
  })
})

describe('rendered state: scopes and cost', () => {
  it('what no scope asks for is not measured; a scope that goes takes its state with it', () => {
    const h = mount(app('', ''))
    h.layout.place(EX + 'a', 0, 0, 10, 10)
    h.relayout()
    expect(h.store.match(null, null, null, h.g)).toHaveLength(0)
    expect(h.layout.reads).toBe(0)
    const scope = h.f.quad(h.f.namedNode(EX + 'panel'), h.f.namedNode(RND.observes), h.f.namedNode(RND.Geometry))
    h.runtime.apply({ add: [scope], remove: [] })
    h.layout.place(EX + 'panel', 0, 100, 500, 100).place(EX + 'c', 0, 100, 50, 20)
    h.relayout()
    // The panel and what is inside it, nothing else.
    expect([h.one('panel', RND.y), h.one('c', RND.y), h.one('a', RND.y)]).toEqual(['100', '100', undefined])
    h.runtime.apply({ add: [], remove: [scope] })
    h.rendered.flush()
    expect(h.store.match(null, null, null, h.g)).toHaveLength(0)
  })

  it('a scope that adds geometry to components observed for something else nests them: a container overlaps nothing inside it', () => {
    const h = placed(undefined, app('rnd:observes rnd:Focus'))
    h.runtime.apply({ add: [h.f.quad(h.f.namedNode(EX + 'root'), h.f.namedNode(RND.observes), h.f.namedNode(RND.Overlap))], remove: [] })
    h.relayout()
    expect(h.of('c', RND.within).sort()).toEqual([stateOf(EX + 'panel'), stateOf(EX + 'root')].sort())
    expect(h.overlaps()).toEqual(['a~b', 'b~a'])
  })

  it('detached, it takes back what it wrote; attached again, it observes what is shown', () => {
    const h = placed()
    h.stop()
    expect(h.store.match(null, null, null, h.g)).toHaveLength(0)
    h.rendered.attach()
    h.relayout()
    expect([h.one('a', RND.x), h.one('c', RND.y)]).toEqual(['10', '1220'])
  })

  it('a component that is no longer shown takes its state with it', () => {
    const h = placed()
    expect(h.one('c', RND.x)).toBe('20')
    h.runtime.apply({ add: [], remove: [h.f.quad(h.f.namedNode(EX + 'c'), h.f.namedNode(RDF_TYPE), h.f.namedNode(NS.c + 'Button'))] })
    h.shell.flush()
    h.rendered.flush()
    expect(h.of('c', RND.x)).toEqual([])
  })

  it('a component shown later is observed, after the page\'s observer has delivered its records', async () => {
    const h = placed()
    const type = h.f.quad(h.f.namedNode(EX + 'c'), h.f.namedNode(RDF_TYPE), h.f.namedNode(NS.c + 'Button'))
    h.runtime.apply({ add: [], remove: [type] })
    h.shell.flush()
    await new Promise((r) => setTimeout(r, 10))
    h.rendered.flush()
    expect(h.of('c', RND.x)).toEqual([])
    h.runtime.apply({ add: [type], remove: [] })
    h.shell.flush()
    // The mutation observer's callback runs (and takes the records) before the frame does.
    await new Promise((r) => setTimeout(r, 10))
    h.rendered.flush()
    expect(h.one('c', RND.x)).toBe('20')
  })

  it('measuring re-runs no rule and patches nothing', () => {
    const h = placed()
    const runs = h.screen.engine.stats.ruleRuns
    const ops = h.shell.ops
    h.layout.place(EX + 'a', 300, 300, 120, 60)
    h.layout.view.scrollTop = 500
    h.fire(h.el('b'), 'focusin')
    h.fire(h.el('b'), 'pointerover')
    h.relayout()
    expect(h.screen.engine.stats.ruleRuns).toBe(runs)
    expect(h.shell.ops).toBe(ops)
  })

  it('moving one box among many costs its neighbours, not the number of boxes', () => {
    const cost = (n: number) => {
      const buttons = Array.from({ length: n }, (_, i) => `ex:b${i}`)
      const graph = `${PREFIXES}
ex:root a c:Stack ; c:children ( ${buttons.join(' ')} ) ; rnd:observes rnd:Geometry .
${buttons.map((b, i) => `${b} a c:Button ; c:label "${i}" ; rnd:observesSelf rnd:Overlap .`).join('\n')}`
      const h = mount(graph, 'wat')
      h.runtime.views.strict = false
      h.layout.place(EX + 'root', 0, 0, 12_000, 12_000)
      // Buttons 300 px apart, 50 px wide: each in a grid cell of its own, none overlapping another.
      for (let i = 0; i < n; i++) h.layout.place(EX + 'b' + i, (i % 40) * 300, Math.floor(i / 40) * 300, 50, 50)
      h.relayout()
      expect(h.overlaps()).toEqual([])
      const rows = h.runtime.views.totals.rowsIn
      const written = h.rendered.figures.added + h.rendered.figures.removed
      // Button 0 moves onto button 1 (into its cell).
      h.layout.place(EX + 'b0', 280, 0, 50, 50)
      h.relayout()
      expect(h.overlaps()).toEqual(['b0~b1', 'b1~b0'])
      return { viewRows: h.runtime.views.totals.rowsIn - rows, written: h.rendered.figures.added + h.rendered.figures.removed - written }
    }
    const small = cost(40)
    const large = cost(400)
    expect(small.written).toBe(4)
    expect(large).toEqual(small)
  })

})
