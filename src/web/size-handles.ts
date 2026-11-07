// What a size handle says (role=separator, data-sem-gesture="size"; ontology/layers/behaviour.ttl).
// A rendering can only say what the graph asks for: c:width 360, c:maxSize 720. What the box comes to
// is the page's: on a phone the theme caps a docked frame at 80vw, a table lays a column out from the
// room it has, a split's height may leave its ratio nothing to take a share of. This effect keeps the
// handle's aria-valuenow, and for a handle with bounds its aria-valuemax and aria-valuemin, true to
// the box, in the same terms the gesture and the reaction use: at most data-sem-max, the box's CSS
// maximum and the room there is. It never writes the graph, so the size asked for comes back when
// there is room for it; a drag or a key still starts from the box and commits one beh:Size event.
//
// A box is read when it changes (a ResizeObserver) and a handle when it comes or the rendering
// rewrites what it says (a MutationObserver), all reads in a frame before any write, so an
// interaction costs the handles it touched. Without a ResizeObserver the rendering's words stand.

import { cssMax, measure, sizedBy } from '../behaviour/events.ts'
import type { DomRenderer } from '../render/dom.ts'

const HANDLE = '[role="separator"][data-sem-gesture="size"]'
/** What the rendering rewrites when its words or its box's bounds change (a frame moved to another edge turns its sign or axis). */
const SAID = ['aria-valuenow', 'aria-valuemax', 'aria-valuemin', 'data-sem-min', 'data-sem-max', 'data-sem-sign', 'data-sem-axis']

/** A divider sizes the sibling before it, and says that sibling's share of what they divide, in percent. */
const shares = (handle: HTMLElement) => handle.dataset.semSizes === 'previous' || handle.dataset.semSizes === 'next'

/** What the handle should say of a box that is shown; nothing of one that is not. */
function report(handle: HTMLElement, target: HTMLElement, window: Window) {
  const axis = handle.dataset.semAxis === 'y' ? 'y' : 'x'
  const size = Math.round(measure(target, axis))
  if (!size) return undefined
  const parent = target.parentElement
  if (shares(handle)) {
    const whole = parent ? measure(parent, axis) : 0
    return whole ? { 'aria-valuenow': String(Math.round((size * 100) / whole)) } : undefined
  }
  const said: Record<string, string> = { 'aria-valuenow': String(size) }
  if (handle.dataset.semMax === undefined) return said
  const min = Number(handle.dataset.semMin ?? 0)
  const view = target.ownerDocument.documentElement
  const room = window.getComputedStyle(target).position === 'fixed' ? (axis === 'x' ? view.clientWidth : view.clientHeight) : parent ? measure(parent, axis) : 0
  // Room no more than the least it may be sizes nothing (the reaction ignores it too).
  const max = Math.floor(Math.min(Number(handle.dataset.semMax), cssMax(target, axis), room > min ? room : Infinity))
  said['aria-valuemax'] = String(max)
  said['aria-valuemin'] = String(Math.min(min, max))
  return said
}

/** Keep the size handles in `renderer`'s host saying what is drawn; returns how to stop. */
export function attachSizeHandles(renderer: DomRenderer): () => void {
  const host = renderer.host
  const window = host.ownerDocument.defaultView as (Window & typeof globalThis) | null
  if (!window?.ResizeObserver || !window.MutationObserver) return () => {}
  /** The boxes a handle's words depend on, and back. */
  const watched = new Map<HTMLElement, HTMLElement[]>()
  const handlesOf = new Map<Element, Set<HTMLElement>>()
  const due = new Set<HTMLElement>()
  let frame: number | undefined

  const schedule = () => {
    frame ??= window.requestAnimationFrame(run)
  }
  const run = () => {
    frame = undefined
    const reads: [HTMLElement, Record<string, string>][] = []
    for (const handle of due) {
      const target = watched.get(handle)?.[0]
      const said = target?.isConnected && report(handle, target, window)
      if (said) reads.push([handle, said])
    }
    due.clear()
    for (const [handle, said] of reads) for (const [name, value] of Object.entries(said)) if (handle.getAttribute(name) !== value) handle.setAttribute(name, value)
    mutations.takeRecords()
  }
  const forget = (handle: HTMLElement) => {
    for (const box of watched.get(handle) ?? []) {
      const handles = handlesOf.get(box)
      handles?.delete(handle)
      if (!handles?.size) handlesOf.delete(box), boxes.unobserve(box)
    }
    watched.delete(handle)
    due.delete(handle)
  }
  const watch = (handle: HTMLElement) => {
    forget(handle)
    if (renderer.inSlot(handle)) return
    const target = sizedBy(handle, renderer)
    if (!target) return
    // How much room there is matters to a handle with bounds and to a share of its parent.
    const parent = target.parentElement
    const list = parent && (handle.dataset.semMax !== undefined || shares(handle)) ? [target, parent] : [target]
    watched.set(handle, list)
    for (const box of list) {
      let handles = handlesOf.get(box)
      if (!handles) handlesOf.set(box, (handles = new Set())), boxes.observe(box)
      handles.add(handle)
    }
    due.add(handle)
    schedule()
  }
  const within = (node: Node, act: (handle: HTMLElement) => void) => {
    if (node.nodeType !== 1) return
    const el = node as HTMLElement
    if (el.matches(HANDLE)) act(el)
    el.querySelectorAll<HTMLElement>(HANDLE).forEach(act)
  }

  const boxes = new window.ResizeObserver((entries) => {
    for (const entry of entries) for (const handle of handlesOf.get(entry.target) ?? []) due.add(handle)
    schedule()
  })
  const mutations = new window.MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        const handle = r.target as HTMLElement
        if (handle.matches(HANDLE) && watched.has(handle)) due.add(handle), schedule()
        continue
      }
      r.removedNodes.forEach((n) => within(n, forget))
      r.addedNodes.forEach((n) => within(n, watch))
    }
  })
  mutations.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: SAID })
  host.querySelectorAll<HTMLElement>(HANDLE).forEach(watch)
  // A cap in vw or dvh moves with the viewport, whether or not the box does.
  const resized = () => {
    for (const handle of watched.keys()) if (handle.dataset.semMax !== undefined) due.add(handle)
    if (due.size) schedule()
  }
  window.addEventListener('resize', resized)
  return () => {
    window.removeEventListener('resize', resized)
    mutations.disconnect()
    boxes.disconnect()
    if (frame !== undefined) window.cancelAnimationFrame(frame)
  }
}
