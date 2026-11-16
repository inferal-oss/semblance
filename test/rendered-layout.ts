// A stand-in for the browser's layout (linkedom has none), for the rendered-state effect
// (src/rendered.ts): a test says where each component is, by its IRI, in document coordinates,
// how far the page and each scroller are scrolled, and what is hidden, open or in the top layer.
import type { Box, RenderedLayout } from '../src/rendered.ts'

export class FakeLayout implements RenderedLayout {
  /** Border boxes by component, in document coordinates. */
  readonly boxes = new Map<string, Box>()
  /** Scroll state by component (default: nothing to scroll). */
  readonly scrolls = new Map<string, { top: number; left: number; height: number; width: number; clientHeight: number; clientWidth: number }>()
  /** Components that generate no box (display:none). */
  readonly hidden = new Set<string>()
  /** Native details / dialog / popover state by component. */
  readonly opened = new Map<string, boolean>()
  readonly topLayers = new Set<string>()
  /** Components that move with the viewport (position: fixed), placed in viewport coordinates. */
  readonly fixedOnes = new Set<string>()
  /** Whether a focused element shows its ring (the focus came from the keyboard). */
  focusRing = false
  readonly view = { width: 1280, height: 800, scrollTop: 0, scrollLeft: 0 }
  /** How many boxes were read (each a layout read in a browser). */
  reads = 0
  /** The document's width, when wider than the viewport (rnd:Layout). */
  documentWide?: number
  /** Components that clip their inline overflow (rnd:Layout). */
  readonly clipping = new Set<string>()

  constructor(private readonly componentOf: (el: Element) => string | undefined) {}

  place(component: string, x: number, y: number, width: number, height: number): this {
    this.boxes.set(component, { x, y, width, height })
    return this
  }

  rect(el: Element): Box {
    this.reads++
    const c = this.componentOf(el)
    const b = (c !== undefined && !this.hidden.has(c) && this.boxes.get(c)) || { x: 0, y: 0, width: 0, height: 0 }
    if (this.movesWithViewport(el)) return { ...b }
    return { x: b.x - this.view.scrollLeft, y: b.y - this.view.scrollTop, width: b.width, height: b.height }
  }

  fixed(el: Element): boolean {
    const c = this.componentOf(el)
    return c !== undefined && this.fixedOnes.has(c)
  }

  /** Whether it or what it is in is fixed. */
  private movesWithViewport(el: Element): boolean {
    for (let n: Element | null = el; n; n = n.parentElement) if (this.fixed(n)) return true
    return false
  }

  viewport() {
    return { ...this.view }
  }

  rendered(el: Element): boolean {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = this.componentOf(n)
      if (c !== undefined && this.hidden.has(c)) return false
    }
    return true
  }

  scroll(el: Element) {
    const c = this.componentOf(el)
    const b = (c !== undefined && this.boxes.get(c)) || { width: 0, height: 0 }
    return (c !== undefined && this.scrolls.get(c)) || { top: 0, left: 0, height: b.height, width: b.width, clientHeight: b.height, clientWidth: b.width }
  }

  focusVisible(): boolean {
    return this.focusRing
  }

  open(el: Element): boolean | undefined {
    const c = this.componentOf(el)
    return c === undefined ? undefined : this.opened.get(c)
  }

  documentWidth(): number {
    return this.documentWide ?? this.view.width
  }

  clips(el: Element): boolean {
    const c = this.componentOf(el)
    return c !== undefined && this.clipping.has(c)
  }

  /** A width media condition, at the viewport's width. */
  matches(media: string): boolean {
    return [...media.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, k, v]) => (k === 'min' ? this.view.width >= +v! : this.view.width <= +v!))
  }

  topLayer(el: Element): boolean {
    const c = this.componentOf(el)
    return c !== undefined && this.topLayers.has(c)
  }
}
