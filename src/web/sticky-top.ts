// How much a sticky app bar covers at the top of the page (--sem-sticky-top on <html>): what stays
// in view (a side column that says pos:sticky pos:StickToTop, a walkthrough's diagram) sticks below
// it. Only the page knows the bar's height (it wraps into more rows as the window narrows), so the
// host measures it. Measured late, a side column first lays out at the stylesheet's fallback (116px,
// a bar of two rows) and jumps when the measure arrives: a one-row bar leaves the column 35px lower
// on every load (#428). So it is measured before the first paint: a server-rendered page carries
// STICKY_TOP_SCRIPT in its head (src/server/document.ts), which follows the bar from the moment
// the parser adds it; a page the client renders itself, and every change after, is followed by
// attachStickyTop (src/web/mount.ts). Both measure alike: the bar's height and 12px when it sticks
// (or is fixed), else 16px.

/** The custom property on <html> that says how much the app bar covers. */
export const STICKY_TOP_PROPERTY = '--sem-sticky-top'

const BAR = '[data-sem-c=app-bar]'

/** How much `bar` covers at the top of the page (px): its height and a gap when it stays in view, else a gap. */
export function stickyTopOf(bar: Element | null | undefined, win: Window): number {
  const position = bar?.isConnected ? win.getComputedStyle(bar).position : ''
  return position === 'sticky' || position === 'fixed' ? Math.ceil(bar!.getBoundingClientRect().height) + 12 : 16
}

/**
 * The inline script a server-rendered page's head carries: it finds the app bar as soon as the parser
 * adds it and follows its size (a ResizeObserver reports before the frame is painted), so the first
 * paint already has the bar's measure. It stops looking once the document is parsed; the client's
 * attachStickyTop takes over from there. Dependency-free, like the other first-paint scripts.
 */
export const STICKY_TOP_SCRIPT = `(()=>{if(typeof ResizeObserver!=="function")return;const d=document,h=d.documentElement;let b=null,t=-1;const m=()=>{const p=b&&b.isConnected?getComputedStyle(b).position:"",v=p==="sticky"||p==="fixed"?Math.ceil(b.getBoundingClientRect().height)+12:16;if(v!==t)h.style.setProperty("${STICKY_TOP_PROPERTY}",(t=v)+"px")},r=new ResizeObserver(m),f=()=>{const e=d.querySelector("${BAR}");if(!e||e===b)return;b&&r.unobserve(b);r.observe(b=e);m();o.disconnect()},o=new MutationObserver(f);o.observe(h,{childList:true,subtree:true});d.addEventListener("DOMContentLoaded",()=>{o.disconnect();f()},{once:true})})()`

/**
 * Keep --sem-sticky-top on `host`'s document at the measure of the app bar under `host`: when the
 * bar changes size (the window narrows, a font arrives), when the page under `host` changes (a bar
 * appears, a theme makes it stop sticking) and at the next frame, all before that frame is painted.
 */
export function attachStickyTop(host: HTMLElement): { update(): void; dispose(): void } {
  const doc = host.ownerDocument
  const win = doc.defaultView
  if (!win) return { update() {}, dispose() {} }
  let bar: Element | null = null
  let top = -1
  let frame = 0
  const apply = () => {
    const v = stickyTopOf(bar, win)
    if (v !== top) doc.documentElement.style.setProperty(STICKY_TOP_PROPERTY, `${(top = v)}px`)
  }
  const measure = () => {
    frame = 0
    const now = host.querySelector(BAR)
    if (now !== bar) {
      if (bar) resize?.unobserve(bar)
      bar = now
      if (bar) resize?.observe(bar)
    }
    apply()
  }
  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(measure)
  }
  // A ResizeObserver reports after layout and before paint: the new measure is in that same frame.
  const resize = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(apply) : undefined
  const mutations = new win.MutationObserver(schedule)
  mutations.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-sem-theme', 'hidden'] })
  measure()
  return {
    update: schedule,
    dispose() {
      mutations.disconnect()
      resize?.disconnect()
      if (frame) win.cancelAnimationFrame(frame)
    },
  }
}
