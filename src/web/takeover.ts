// Taking over server-rendered HTML (docs/SSR.md). A page rendered on a server or at build time
// (src/server/render.ts) marks its mount element data-sem-ssr and carries CAPTURE_SCRIPT right
// before it: what the visitor does before the client is ready (a click on a button, typing in a
// field) is kept, not lost. The client projects the same graph at the same address, adopts the
// DOM (DomRenderer.adopt: no node is created) and replays what was kept, as if it happened now.
// A region inside the page that the client takes over later (a live example's sandbox) carries
// data-sem-ssr too: what is done there is kept until that region's own takeover replays it.
import type { DomRenderer } from '../render/dom.ts'

/** The attribute a server-rendered mount element carries. */
export const SSR_ATTRIBUTE = 'data-sem-ssr'
/** The attribute the server's stylesheet (<link> or <style>) carries: the client need not compile its own. */
export const STYLES_ATTRIBUTE = 'data-sem-styles'

const KEPT = ['click', 'submit', 'input', 'change']

/**
 * The inline script that keeps events until the client takes over: clicks on anything but a link
 * (links work without scripts) and submits are held back and kept; input and change are kept and
 * happen as usual (what was typed stays in the field). A kept event goes no further: no listener
 * sees it before its region is taken over (`replayKept`), so a native control never changes while
 * the graph does not. Small and dependency-free: it runs first.
 */
export const CAPTURE_SCRIPT = `(()=>{const k=[],t=${JSON.stringify(KEPT)},h=e=>{const x=e.target;if(!(x instanceof Element)||!x.closest("[${SSR_ATTRIBUTE}]"))return;if(e.type==="click"&&x.closest("a[href]"))return;k.push(e);e.stopPropagation();if(e.type==="click"||e.type==="submit")e.preventDefault()};for(const n of t)addEventListener(n,h,true);globalThis.__semblanceKept={events:k,stop(){for(const n of t)removeEventListener(n,h,true)}}})()`

interface Kept {
  events: Event[]
  stop(): void
}

/** Whether `host` holds server-rendered HTML to take over. */
export function serverRendered(host: Element): boolean {
  return host.hasAttribute(SSR_ATTRIBUTE)
}

/** The <meta> a page names the graphs its client needs first in (space-separated). */
export const PAGE_GRAPHS_META = 'semblance-graphs'

/**
 * The graphs the page says its client needs first (src/server/page-graphs.ts: `ontology/<file>` and
 * the site's own names), or undefined: then it needs all of them.
 */
export function pageGraphs(doc: Document): string[] | undefined {
  const content = doc.querySelector(`meta[name="${PAGE_GRAPHS_META}"]`)?.getAttribute('content')
  return content ? content.split(/\s+/).filter(Boolean) : undefined
}

/** Whether the document has the server's stylesheet. */
export function serverStyled(doc: Document): boolean {
  return !!doc.querySelector(`[${STYLES_ATTRIBUTE}]`)
}

/**
 * Adopt the server's DOM under the renderer's host: call once the projection is ready, before the
 * first flush. Then, once the client's listeners are attached, `replay()` the events kept before
 * now (each dispatched again on its element, if it is still there).
 */
export function takeOver(renderer: DomRenderer): { nodes: number; mismatches: number; replay(): number } {
  const adopted = renderer.adopt()
  renderer.host.removeAttribute(SSR_ATTRIBUTE)
  return { ...adopted, replay: () => replayKept(renderer.host) }
}

/**
 * Dispatch again, on their elements under `host`, the events the capture script kept there; with
 * `discard`, let them go instead (the region will never be taken over). Events in a region under
 * `host` still marked data-sem-ssr stay kept for its own takeover. Once no region is left to take
 * over, the capture script stops keeping.
 */
export function replayKept(host: Element, opts: { discard?: boolean } = {}): number {
  const g = globalThis as { __semblanceKept?: Kept }
  const kept = g.__semblanceKept
  if (!kept) return 0
  const pending = (target: Element) => {
    const region = target.closest(`[${SSR_ATTRIBUTE}]`)
    return !!region && host.contains(region)
  }
  const mine: Event[] = []
  const rest: Event[] = []
  for (const e of kept.events.splice(0)) {
    const target = e.target as Element | null
    if (!target?.isConnected) continue
    if (host.contains(target) && !pending(target)) mine.push(e)
    else rest.push(e)
  }
  kept.events.push(...rest)
  if (!host.ownerDocument.querySelector(`[${SSR_ATTRIBUTE}]`)) {
    kept.stop()
    g.__semblanceKept = undefined
  }
  if (opts.discard) return 0
  for (const e of mine) {
    const target = e.target as Element
    const View = target.ownerDocument.defaultView as (Window & typeof globalThis) | null
    const Mouse = View?.MouseEvent
    const Plain = View?.Event ?? Event
    const copy = e.type === 'click' && Mouse ? new Mouse('click', e as MouseEvent) : new Plain(e.type, { bubbles: true, cancelable: e.type === 'click' || e.type === 'submit' })
    target.dispatchEvent(copy)
  }
  return mine.length
}
