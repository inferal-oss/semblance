// The rendered-state effect (ontology/layers/rendered.ttl): what the page knows about the shown
// components that ask for it (rnd:observes) - where each is and how big, whether it is on screen,
// whether it has the focus, is hovered or pressed, how far it is scrolled, whether it is open or
// animating - written to the rendered graph as rnd:State nodes, one per component.
//
// Once per frame in which something may have moved (a patch of the DOM, a resize, a scroll, an
// animation that started or ended, the focus or the pointer), it reads every observed component
// (all the reads before any write: one layout at most), rounds to whole CSS pixels, and writes
// only the triples that changed, in one tick. It never writes the DOM, and nothing it writes is
// recorded in the change log. Without a scope nothing is measured: no observers, no frames.
//
// The layout is the browser's (domLayout); tests give their own (linkedom has none).
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import { NS, RDF_TYPE, RENDERED_GRAPH, RND, XSD_BOOLEAN, XSD_INTEGER } from './ns.ts'
import type { Delta } from './rdf.ts'
import type { DomRenderer } from './render/dom.ts'
import type { Runtime } from './runtime.ts'

const XSD_DECIMAL = NS.xsd + 'decimal'
/** The side of the grid cells overlap is joined on (rnd:cell), in CSS pixels. */
export const CELL = 256
/** Scroll offsets of components are written in steps of this many pixels. */
const SCROLL_STEP = 8
/** Mutation records kept for the next frame; beyond this many, it scans in full instead. */
const MAX_RECORDS = 1000
/** The node of the viewport. */
export const VIEWPORT = 'urn:semblance:rendered:viewport'

/** The rendered-state node of a component. */
export const stateOf = (component: string) => 'urn:semblance:rendered:' + encodeURIComponent(component)

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** What the effect measures with: the browser (domLayout), or a stand-in. */
export interface RenderedLayout {
  /** The element's border box relative to the viewport (getBoundingClientRect). */
  rect(el: Element): Box
  /** The viewport's size and how far the page is scrolled. */
  viewport(): { width: number; height: number; scrollTop: number; scrollLeft: number }
  /** Whether the element itself is position: fixed (the effect asks up its ancestors, each once a frame). */
  fixed(el: Element): boolean
  /** Whether it generates a box: not display:none, not hidden, not inside a skipped subtree. */
  rendered(el: Element): boolean
  /** How far its content is scrolled, and how big that content is. */
  scroll(el: Element): { top: number; left: number; height: number; width: number; clientHeight: number; clientWidth: number }
  /** Whether the focused element shows its focus ring. */
  focusVisible(el: Element): boolean
  /** Whether a native details or dialog is open, or a popover showing (undefined: it is none of these). */
  open(el: Element): boolean | undefined
  /** Whether it is drawn in the top layer (a modal dialog, a showing popover, fullscreen). */
  topLayer(el: Element): boolean
}

const matches = (el: Element, selector: string) => {
  try {
    return el.matches(selector)
  } catch {
    return false
  }
}

/** The browser's layout. */
export function domLayout(win: Window & typeof globalThis = globalThis as Window & typeof globalThis): RenderedLayout {
  return {
    rect: (el) => el.getBoundingClientRect(),
    viewport: () => ({ width: win.innerWidth, height: win.innerHeight, scrollTop: win.scrollY, scrollLeft: win.scrollX }),
    fixed: (el) => win.getComputedStyle(el).position === 'fixed',
    rendered: (el) => {
      const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility
      if (check) return check.call(el, { contentVisibilityAuto: true })
      return el.getClientRects().length > 0
    },
    scroll: (el) => ({ top: el.scrollTop, left: el.scrollLeft, height: el.scrollHeight, width: el.scrollWidth, clientHeight: el.clientHeight, clientWidth: el.clientWidth }),
    focusVisible: (el) => matches(el, ':focus-visible'),
    open: (el) => {
      if (el.localName === 'details' || el.localName === 'dialog') return el.hasAttribute('open')
      if (el.hasAttribute('popover')) return matches(el, ':popover-open')
      return undefined
    },
    topLayer: (el) => matches(el, ':modal') || matches(el, ':popover-open') || el.ownerDocument.fullscreenElement === el,
  }
}

export interface RenderedOptions {
  /** How to measure (the browser's by default). */
  layout?: RenderedLayout
  /** Run a callback at the next frame (requestAnimationFrame by default). */
  frame?: (cb: () => void) => void
  /** After each write (e.g. to patch the DOM, should a rule read the state). */
  onWrite?: (delta: Delta) => void
}

interface Entry {
  component: string
  el: Element
  state: NamedNode
  aspects: Set<string>
  /** What is written for it now, by predicate and object. */
  written: Map<string, Quad>
  /** The observed components (with geometry) it is inside. */
  within?: Entry[]
  /** Its box as last read (in the document, or in the viewport when fixed), whether fixed, whether shown. */
  box?: Box
  /** Its part in the viewport as last written (see visibility()). */
  seen?: string
  fixed?: boolean
  shown?: boolean
}

type Signal = 'focused' | 'hovered' | 'pressed' | 'animating'
const SIGNALS: Signal[] = ['focused', 'hovered', 'pressed', 'animating']
/** The aspects read from the layout every frame; the others follow events (open: toggle, or its attribute). */
const MEASURED = [RND.Geometry, RND.Overlap, RND.Visibility, RND.Scroll]

/** Counts of what the effect did, for cost tests and benchmarks. */
export interface RenderedFigures {
  frames: number
  measured: number
  added: number
  removed: number
}

export class RenderedState {
  private readonly f
  private readonly layout: RenderedLayout
  private readonly frame: (cb: () => void) => void
  /** Scopes: component -> the aspects it asks for, for itself and inside it (rnd:observes). */
  private scopes = new Map<string, Set<string>>()
  /** Component -> the aspects it asks for itself only (rnd:observesSelf). */
  private own = new Map<string, Set<string>>()
  private entries = new Map<Element, Entry>()
  private byComponent = new Map<string, Entry>()
  private scheduled = false
  private rescan = true
  private structure = true
  /**
   * Whether anything may have moved besides the page's scroll (the DOM changed, a size, an inner
   * scroller, an animation): the boxes are read again at the next frame. Scrolling the page moves
   * no box (document coordinates, or the viewport's for fixed ones), so it reads none.
   */
  private moved = true
  private viewportWritten = new Map<string, Quad>()
  /** What components no longer observed had written: removed with the frame's write. */
  private dropped: Quad[] = []
  private focusTarget: Element | null = null
  private hoverTarget: Element | null = null
  private pressTarget: Element | null = null
  private running = new Map<Element, Set<string>>()
  /** The components with an aspect read from the layout (geometry, visibility, scroll). */
  private measured = new Set<Entry>()
  /** Observed since the last frame, or with other aspects. */
  private fresh = new Set<Entry>()
  /** Elements that toggled (a details, a dialog, a popover) since the last frame. */
  private toggled = new Set<Element>()
  /** Who had the focus, the pointer, an animation at the last frame. */
  private last: Record<Signal, Set<Entry>> = { focused: new Set(), hovered: new Set(), pressed: new Set(), animating: new Set() }
  private ratios = new WeakMap<Element, number>()
  private mutations?: MutationObserver
  private records: MutationRecord[] = []
  private resizes?: ResizeObserver
  private intersections?: IntersectionObserver
  private detach?: () => void
  readonly figures: RenderedFigures = { frames: 0, measured: 0, added: 0, removed: 0 }

  constructor(
    private readonly runtime: Runtime,
    private readonly renderer: DomRenderer,
    private readonly opts: RenderedOptions = {},
  ) {
    this.f = runtime.store.factory
    this.layout = opts.layout ?? domLayout()
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame
    this.frame = opts.frame ?? (raf ? (cb) => void raf(cb) : (cb) => void setTimeout(cb, 16))
  }

  /** Follow the scopes and measure from now on. Returns a function that stops it (and removes what it wrote). */
  attach(): () => void {
    const host = this.renderer.host
    const doc = host.ownerDocument
    const win = doc.defaultView
    const offInput = this.runtime.onInput((graph, delta) => {
      if (graph !== undefined) return
      if ([...delta.add, ...delta.remove].some((q) => q.predicate.value === RND.observes || q.predicate.value === RND.observesSelf)) this.readScopes(), (this.rescan = true), this.changed()
    })
    const on = (target: EventTarget | null | undefined, type: string, fn: (e: Event) => void, capture = true) => {
      target?.addEventListener(type, fn, { capture, passive: true })
      return () => target?.removeEventListener(type, fn, { capture })
    }
    const inHost = (n: EventTarget | null) => n instanceof Object && 'nodeType' in n && host.contains(n as Node)
    const target = (e: Event) => (inHost(e.target) ? (e.target as Element) : null)
    const offs = [
      offInput,
      on(host, 'focusin', (e) => this.event(() => (this.focusTarget = target(e)), RND.Focus)),
      on(host, 'focusout', (e) => this.event(() => (this.focusTarget = inHost((e as FocusEvent).relatedTarget) ? ((e as FocusEvent).relatedTarget as Element) : null), RND.Focus)),
      on(host, 'pointerover', (e) => this.event(() => (this.hoverTarget = target(e)), RND.Hover)),
      on(host, 'pointerout', (e) => this.event(() => (this.hoverTarget = inHost((e as PointerEvent).relatedTarget) ? ((e as PointerEvent).relatedTarget as Element) : null), RND.Hover)),
      on(host, 'pointerdown', (e) => this.event(() => (this.pressTarget = target(e)), RND.Press)),
      on(win, 'pointerup', () => this.event(() => (this.pressTarget = null), RND.Press)),
      on(win, 'pointercancel', () => this.event(() => (this.pressTarget = null), RND.Press)),
      on(win, 'resize', () => this.invalidate()),
      on(doc, 'scroll', (e) => (e.target === doc ? this.changed() : this.invalidate())),
      on(host, 'toggle', (e) => this.toggle(e.target as Element | null)),
      ...['animationstart', 'transitionrun'].map((t) => on(host, t, (e) => this.animation(e, true))),
      ...['animationend', 'animationcancel', 'transitionend', 'transitioncancel'].map((t) => on(host, t, (e) => this.animation(e, false))),
    ]
    this.readScopes()
    this.rescan = true
    this.moved = true
    this.changed()
    this.detach = () => {
      for (const off of offs) off()
      this.disconnect()
      const remove: Quad[] = [...this.viewportWritten.values(), ...this.dropped]
      this.dropped = []
      for (const e of this.entries.values()) remove.push(...e.written.values())
      this.entries.clear(), this.byComponent.clear(), this.viewportWritten.clear(), this.measured.clear(), this.fresh.clear()
      this.last = { focused: new Set(), hovered: new Set(), pressed: new Set(), animating: new Set() }
      this.write({ add: [], remove })
      this.detach = undefined
    }
    return this.detach
  }

  /** Something may have moved: measure at the next frame. */
  changed(): void {
    if (this.scheduled || !this.detach || (!this.observing && !this.entries.size)) return
    this.scheduled = true
    this.frame(() => {
      this.scheduled = false
      this.flush()
    })
  }

  /** The rendered state of a component, as written now (for tests). */
  written(component: string): Quad[] {
    return [...(this.byComponent.get(component)?.written.values() ?? [])]
  }

  footprint(): Record<string, number> {
    return { entries: this.entries.size, triples: [...this.entries.values()].reduce((n, e) => n + e.written.size, this.viewportWritten.size) }
  }

  /** Measure now and write what changed. */
  flush(): void {
    if (!this.detach) return
    this.scheduled = false
    if (!this.observing && !this.entries.size && !this.viewportWritten.size) return
    this.figures.frames++
    this.scan()
    if (this.structure) this.nest()
    const delta: Delta = { add: [], remove: this.dropped }
    this.dropped = []
    // Every read first, then the one write.
    const v = this.layout.viewport()
    const vp = this.f.namedNode(VIEWPORT)
    const viewport = new Map<string, Quad>()
    if (this.measured.size) {
      this.put(viewport, vp, RDF_TYPE, this.f.namedNode(RND.Viewport))
      this.put(viewport, vp, RND.width, this.int(v.width))
      this.put(viewport, vp, RND.height, this.int(v.height))
      this.put(viewport, vp, RND.scrollTop, this.int(v.scrollTop))
      this.put(viewport, vp, RND.scrollLeft, this.int(v.scrollLeft))
    }
    this.diff(this.viewportWritten, viewport, delta)
    this.viewportWritten = viewport
    // What left the page takes its focus, pointer and animations with it.
    for (const t of ['focusTarget', 'hoverTarget', 'pressTarget'] as const) if (this[t] && !this[t]!.isConnected) this[t] = null
    for (const el of this.running.keys()) if (!el.isConnected) this.running.delete(el)
    const now: Record<Signal, Set<Entry>> = {
      focused: new Set(this.innermost(this.focusTarget, RND.Focus)),
      hovered: new Set(this.innermost(this.hoverTarget, RND.Hover).slice(0, 1)),
      pressed: new Set(this.innermost(this.pressTarget, RND.Press).slice(0, 1)),
      animating: new Set(),
    }
    for (const el of this.running.keys()) for (const e of this.around(el, RND.Animation)) now.animating.add(e)
    const moved = this.moved
    this.moved = false
    // What is visited: the measured components when something may have moved (else, the page only
    // scrolled, those whose part in the viewport changed), those just observed, and those the
    // focus, the pointer or an animation reached or left. The others keep what they wrote.
    const visit = new Set<Entry>(this.fresh)
    for (const e of this.measured) if (moved || !e.box || (e.aspects.has(RND.Visibility) && this.visibility(e, v) !== e.seen)) visit.add(e)
    for (const el of this.toggled) for (const e of this.around(el, RND.Open).slice(0, 1)) visit.add(e)
    this.toggled.clear()
    for (const k of SIGNALS) for (const set of [now[k], this.last[k]]) for (const e of set) visit.add(e)
    this.fresh.clear()
    this.last = now
    const focusRoot = [...now.focused][0]
    const next = new Map<Entry, Map<string, Quad>>()
    const fixedMemo = new Map<Element, boolean>()
    for (const e of visit) {
      if (this.entries.get(e.el) !== e) continue
      this.figures.measured++
      const out = new Map<string, Quad>()
      const s = e.state
      const has = (a: string) => e.aspects.has(a)
      const geometry = has(RND.Geometry)
      if (geometry || has(RND.Visibility)) {
        if (moved || !e.box) {
          // What moves with the viewport is placed in it, so scrolling the page moves no box at all.
          const rendered = this.layout.rendered(e.el)
          const r = this.layout.rect(e.el)
          e.fixed = this.movesWithViewport(e.el, fixedMemo)
          const dx = e.fixed ? 0 : v.scrollLeft
          const dy = e.fixed ? 0 : v.scrollTop
          e.box = { x: Math.round(r.x + dx), y: Math.round(r.y + dy), width: Math.round(r.width), height: Math.round(r.height) }
          e.shown = rendered && (e.box.width > 0 || e.box.height > 0)
        }
        const box = e.box
        const fixed = e.fixed === true
        const shown = e.shown === true
        if (geometry && shown) {
          this.put(out, s, RND.x, this.int(box.x))
          this.put(out, s, RND.y, this.int(box.y))
          this.put(out, s, RND.width, this.int(box.width))
          this.put(out, s, RND.height, this.int(box.height))
          if (fixed) this.put(out, s, RND.fixed, this.bool(true))
          for (const w of e.within ?? []) this.put(out, s, RND.within, w.state)
          if (has(RND.Overlap) && box.width > 0 && box.height > 0) {
            for (let cx = Math.floor(box.x / CELL); cx <= Math.floor((box.x + box.width - 1) / CELL); cx++)
              for (let cy = Math.floor(box.y / CELL); cy <= Math.floor((box.y + box.height - 1) / CELL); cy++) this.put(out, s, RND.cell, this.f.literal(`${fixed ? 'v' : ''}${cx},${cy}`))
          }
        }
        if (has(RND.Visibility)) {
          const ratio = this.ratio(e, v)
          const quarters = Math.round(ratio * 4) / 4
          e.seen = this.visibility(e, v)
          this.put(out, s, RND.rendered, this.bool(shown))
          this.put(out, s, RND.inViewport, this.bool(ratio > 0))
          this.put(out, s, RND.ratio, this.f.literal(String(ratio > 0 && quarters === 0 ? 0.25 : quarters), this.f.namedNode(XSD_DECIMAL)))
        }
      }
      if (has(RND.Focus) && now.focused.has(e)) {
        this.put(out, s, RND.focusWithin, this.bool(true))
        if (focusRoot === e) {
          this.put(out, s, RND.focused, this.bool(true))
          if (this.focusTarget && this.layout.focusVisible(this.focusTarget)) this.put(out, s, RND.focusVisible, this.bool(true))
        }
      }
      if (has(RND.Hover) && now.hovered.has(e)) this.put(out, s, RND.hovered, this.bool(true))
      if (has(RND.Press) && now.pressed.has(e)) this.put(out, s, RND.pressed, this.bool(true))
      if (has(RND.Scroll)) {
        const sc = this.layout.scroll(e.el)
        const step = (n: number) => Math.round(n / SCROLL_STEP) * SCROLL_STEP
        this.put(out, s, RND.scrollTop, this.int(step(sc.top)))
        this.put(out, s, RND.scrollLeft, this.int(step(sc.left)))
        this.put(out, s, RND.scrollHeight, this.int(Math.round(sc.height)))
        this.put(out, s, RND.scrollWidth, this.int(Math.round(sc.width)))
        this.put(out, s, RND.overflows, this.bool(sc.height > sc.clientHeight + 1 || sc.width > sc.clientWidth + 1))
        this.put(out, s, RND.atStart, this.bool(sc.top <= 1))
        this.put(out, s, RND.atEnd, this.bool(sc.top + sc.clientHeight >= sc.height - 1))
      }
      if (has(RND.Open)) {
        const open = this.layout.open(e.el)
        if (open !== undefined) this.put(out, s, RND.open, this.bool(open))
        if (open && this.layout.topLayer(e.el)) this.put(out, s, RND.topLayer, this.bool(true))
      }
      if (has(RND.Animation) && now.animating.has(e)) this.put(out, s, RND.animating, this.bool(true))
      // A component with nothing to say (no focus, no pointer, nothing measured) has no node.
      if (out.size) this.put(out, s, RDF_TYPE, this.f.namedNode(RND.State)), this.put(out, s, RND.of, this.f.namedNode(e.component))
      next.set(e, out)
    }
    for (const [e, out] of next) this.diff(e.written, out, delta), (e.written = out)
    this.write(delta)
  }

  // --- scopes and what they observe ---------------------------------------------------------------

  private readScopes() {
    const read = (p: string) => {
      const scopes = new Map<string, Set<string>>()
      for (const q of this.runtime.store.match(null, this.f.namedNode(p), null, this.f.defaultGraph())) {
        if (q.subject.termType !== 'NamedNode' || q.object.termType !== 'NamedNode') continue
        let set = scopes.get(q.subject.value)
        if (!set) scopes.set(q.subject.value, (set = new Set()))
        set.add(q.object.value)
        // Overlap is computed from the boxes.
        if (q.object.value === RND.Overlap) set.add(RND.Geometry)
      }
      return scopes
    }
    this.scopes = read(RND.observes)
    this.own = read(RND.observesSelf)
    if (this.observing) this.connect()
    else this.disconnect()
  }

  private get observing(): boolean {
    return this.scopes.size > 0 || this.own.size > 0
  }

  /** The component an element is the rendered root of, if any. */
  private componentOf(el: Element): string | undefined {
    const key = this.renderer.keyOf(el)
    return key === undefined ? undefined : this.renderer.index.focusOf(key)
  }

  /** The aspects the scopes around an element (itself included) ask for. */
  private inherited(el: Element | null): Set<string> {
    const out = new Set<string>()
    for (let n = el; n && n !== this.renderer.host.parentElement; n = n.parentElement) {
      const c = this.componentOf(n)
      const own = c !== undefined ? this.scopes.get(c) : undefined
      if (own) for (const a of own) out.add(a)
    }
    return out
  }

  /** Keep the observed set current: in full when the scopes changed, else from the DOM's mutations. */
  private scan() {
    const records = [...this.records, ...(this.mutations?.takeRecords() ?? [])]
    this.records = []
    if (records.length) this.moved = true
    for (const r of records) if (r.type === 'attributes' && (r.attributeName === 'open' || r.attributeName === 'popover')) this.toggled.add(r.target as Element)
    if (this.rescan) {
      this.rescan = false
      const seen = new Set<Element>()
      this.walk(this.renderer.host, new Set(), seen)
      for (const el of [...this.entries.keys()]) if (!seen.has(el)) this.forget(el)
      return
    }
    for (const r of records) {
      for (const n of r.removedNodes) if (n.nodeType === 1) this.forgetUnder(n as Element)
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || !(n as Element).isConnected) continue
        const el = n as Element
        this.walk(el, this.inherited(el.parentElement))
      }
    }
  }

  /** Observe the components in a subtree, with the aspects the scopes above it pass down (`aspects`). */
  private walk(el: Element, aspects: Set<string>, seen?: Set<Element>) {
    const c = this.componentOf(el)
    const deep = c !== undefined ? this.scopes.get(c) : undefined
    const here = deep ? new Set([...aspects, ...deep]) : aspects
    const self = c !== undefined ? this.own.get(c) : undefined
    const mine = self ? new Set([...here, ...self]) : here
    if (c !== undefined && mine.size) seen?.add(el), this.observe(el, c, mine)
    for (const child of el.children) this.walk(child, here, seen)
  }

  private observe(el: Element, component: string, aspects: Set<string>) {
    const known = this.entries.get(el)
    if (known && known.component === component) {
      if (sameSet(known.aspects, aspects)) return
      known.aspects = aspects
      this.classify(known)
      return
    }
    if (known) this.forget(el)
    // A component shown in a new element (moved): the old one goes.
    const before = this.byComponent.get(component)
    if (before) this.forget(before.el)
    const e: Entry = { component, el, state: this.f.namedNode(stateOf(component)), aspects, written: new Map() }
    this.entries.set(el, e)
    this.byComponent.set(component, e)
    this.classify(e)
    this.structure = true
    this.resizes?.observe(el)
    this.intersections?.observe(el)
  }

  /** Whether it or an ancestor is position: fixed; each ancestor is asked once a frame (`memo`). */
  private movesWithViewport(el: Element, memo: Map<Element, boolean>): boolean {
    const path: Element[] = []
    let answer = false
    for (let n: Element | null = el; n && n !== this.renderer.host.ownerDocument.body; n = n.parentElement) {
      const known = memo.get(n)
      if (known !== undefined) {
        answer = known
        break
      }
      path.push(n)
      if (this.layout.fixed(n)) {
        answer = true
        break
      }
    }
    for (const n of path) memo.set(n, answer)
    return answer
  }

  /** How much of it is in the viewport: what the observer said, else from its box. */
  private ratio(e: Entry, v: { width: number; height: number; scrollTop: number; scrollLeft: number }): number {
    if (!e.shown || !e.box) return 0
    const io = this.ratios.get(e.el)
    if (io !== undefined) return io
    return visibleRatio(e.fixed ? e.box : { ...e.box, x: e.box.x - v.scrollLeft, y: e.box.y - v.scrollTop }, v)
  }

  /** What visibility writes for it, as a key: in the viewport or not, and in quarters. */
  private visibility(e: Entry, v: { width: number; height: number; scrollTop: number; scrollLeft: number }): string {
    const r = this.ratio(e, v)
    return `${e.shown === true} ${r > 0} ${Math.round(r * 4)}`
  }

  /** Whether it is measured every frame; either way it is visited at the next one. */
  private classify(e: Entry) {
    if (MEASURED.some((a) => e.aspects.has(a))) this.measured.add(e)
    else this.measured.delete(e)
    this.fresh.add(e)
    // What it is inside (rnd:within) depends on which components have geometry.
    this.structure = true
  }

  private forgetUnder(el: Element) {
    if (el.isConnected && this.renderer.host.contains(el)) return
    if (this.entries.has(el)) this.forget(el)
    for (const x of el.querySelectorAll('*')) if (this.entries.has(x)) this.forget(x)
  }

  private forget(el: Element) {
    const e = this.entries.get(el)
    if (!e) return
    this.entries.delete(el)
    if (this.byComponent.get(e.component) === e) this.byComponent.delete(e.component)
    this.measured.delete(e)
    this.fresh.delete(e)
    this.resizes?.unobserve(el)
    this.intersections?.unobserve(el)
    this.structure = true
    this.dropped.push(...e.written.values())
  }

  /** The observed components with `aspect` an element is in, innermost first. */
  private around(el: Element | null, aspect: string): Entry[] {
    const out: Entry[] = []
    for (let n = el; n && n !== this.renderer.host.parentElement; n = n.parentElement) {
      const e = this.entries.get(n)
      if (e?.aspects.has(aspect)) out.push(e)
    }
    return out
  }

  private innermost(el: Element | null, aspect: string): Entry[] {
    return el ? this.around(el, aspect) : []
  }

  /** Which observed components (with geometry) each one is inside: changes only when what is observed does. */
  private nest() {
    this.structure = false
    for (const e of this.measured) {
      if (!e.aspects.has(RND.Geometry)) continue
      e.within = []
      for (let n = e.el.parentElement; n && n !== this.renderer.host.parentElement; n = n.parentElement) {
        const o = this.entries.get(n)
        if (o?.aspects.has(RND.Geometry)) e.within.push(o)
      }
    }
  }

  // --- host signals -------------------------------------------------------------------------------

  private event(record: () => void, aspect: string) {
    if (!this.observing) return
    record()
    if ([...this.scopes.values(), ...this.own.values()].some((s) => s.has(aspect))) this.changed()
  }

  private toggle(el: Element | null) {
    if (!el || !this.observing) return
    this.toggled.add(el)
    this.invalidate()
  }

  /** Something may have moved besides the page's scroll, which no observer reports (a host that knows, a test's layout): read the boxes at the next frame. */
  invalidate(): void {
    this.moved = true
    this.changed()
  }

  private animation(e: Event, started: boolean) {
    const el = e.target as Element | null
    if (!el || !this.observing) return
    const name = e.type.startsWith('transition') ? 't:' + ((e as TransitionEvent).propertyName ?? '') : 'a:' + ((e as AnimationEvent).animationName ?? '')
    let set = this.running.get(el)
    if (started) {
      if (!set) this.running.set(el, (set = new Set()))
      set.add(name)
    } else if (set) {
      set.delete(name)
      if (!set.size) this.running.delete(el)
    }
    this.invalidate()
  }

  private connect() {
    const win = this.renderer.host.ownerDocument.defaultView as (Window & typeof globalThis) | null
    if (!this.mutations && win?.MutationObserver) {
      // The records it delivers are its own no longer (takeRecords skips them): kept for the frame.
      this.mutations = new win.MutationObserver((records) => {
        // While no frame comes (a hidden tab), what piles up is replaced by one full scan.
        if (this.records.length + records.length > MAX_RECORDS) (this.records = []), (this.rescan = true)
        else for (const r of records) this.records.push(r)
        this.changed()
      })
      this.mutations.observe(this.renderer.host, { childList: true, subtree: true, attributes: true, characterData: true })
    }
    if (!this.resizes && win?.ResizeObserver) this.resizes = new win.ResizeObserver(() => this.invalidate())
    if (!this.intersections && win?.IntersectionObserver) {
      this.intersections = new win.IntersectionObserver(
        (entries) => {
          for (const x of entries) this.ratios.set(x.target, x.isIntersecting ? Math.max(x.intersectionRatio, 0.01) : 0)
          this.changed()
        },
        { threshold: [0, 0.25, 0.5, 0.75, 1] },
      )
    }
    for (const el of this.entries.keys()) this.resizes?.observe(el), this.intersections?.observe(el)
  }

  private disconnect() {
    this.mutations?.disconnect(), (this.mutations = undefined), (this.records = [])
    this.resizes?.disconnect(), (this.resizes = undefined)
    this.intersections?.disconnect(), (this.intersections = undefined)
  }

  // --- writing ------------------------------------------------------------------------------------

  private int(n: number): Term {
    return this.f.literal(String(n), this.f.namedNode(XSD_INTEGER))
  }

  private bool(b: boolean): Term {
    return this.f.literal(String(b), this.f.namedNode(XSD_BOOLEAN))
  }

  private put(out: Map<string, Quad>, s: NamedNode, p: string, o: Term) {
    out.set(p + ' ' + (o.termType === 'Literal' ? `"${o.value}"^^${o.datatype.value}` : o.value), this.f.quad(s, this.f.namedNode(p), o))
  }

  private diff(before: Map<string, Quad>, after: Map<string, Quad>, delta: Delta) {
    for (const [k, q] of before) if (!after.has(k)) delta.remove.push(q)
    for (const [k, q] of after) if (!before.has(k)) delta.add.push(q)
  }

  private write(delta: Delta) {
    if (!delta.add.length && !delta.remove.length) return
    const done = this.runtime.write(RENDERED_GRAPH, delta)
    this.figures.added += done.add.length
    this.figures.removed += done.remove.length
    if (done.add.length || done.remove.length) this.opts.onWrite?.(done)
  }
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x))

/** How much of a box (relative to the viewport) is in the viewport, where no observer says. */
function visibleRatio(r: Box, v: { width: number; height: number }): number {
  const area = r.width * r.height
  if (area <= 0) return 0
  const w = Math.max(0, Math.min(r.x + r.width, v.width) - Math.max(r.x, 0))
  const h = Math.max(0, Math.min(r.y + r.height, v.height) - Math.max(r.y, 0))
  return (w * h) / area
}
