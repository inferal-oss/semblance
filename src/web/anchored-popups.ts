// The host side of anchored panels (position layer, ontology/layers/position.ttl). A rendering
// marks a panel that opens from a control with data-sem-anchor (its anchor's id) and, for a list
// as wide as its field, data-sem-anchor-width="match"; the graph decides whether it is shown. This
// effect does what only the page can: while a marked panel is shown, it lifts it into the top layer
// (a manual popover, so a scrolling container or a dialog's overflow cannot clip it), without
// moving its DOM, its focus or its tab order, and places it next to its anchor within the viewport:
// below it, or above it when there is more room there, at its inline start (its end in right to
// left). It follows scrolling, resizing and the on-screen keyboard, and hides a panel whose anchor
// is scrolled out of its container. Browsers without popovers get the same fixed placement.
// It never writes the graph, and it gives every panel back as it was when it hides or detaches.

const MARGIN = 8
const GAP = 6

/** Keep anchored panels visible outside scrolling containers without moving their DOM. */
export function attachAnchoredPopups(host: Element, owns?: (element: Element) => boolean) {
  const ownsNode = owns ?? ((element: Element) => {
    if (element === host) return true
    for (let parent = element.parentElement; parent && parent !== host; parent = parent.parentElement) {
      if (parent.matches('[data-sem-c="host-slot"], [data-sem-c="sem-island"]')) return false
    }
    return true
  })
  const document = host.ownerDocument
  const window = document.defaultView!
  type Popup = {
    anchor: HTMLElement | null; anchoredWidth: number; style: string | null; popover: string | null
    sizing: { width: string; minWidth: string; maxWidth: string; maxHeight: string }
  }
  const lifted = new Map<HTMLElement, Popup>()
  let frame: number | undefined
  const selector = '[data-sem-anchor]'
  const shown = (popup: HTMLElement) => !popup.hidden && !popup.closest('[hidden], [inert]')
  const restore = (popup: HTMLElement, entry: { style: string | null; popover: string | null }) => {
    if (typeof popup.hidePopover === 'function' && popup.matches(':popover-open')) popup.hidePopover()
    if (entry.style === null) popup.removeAttribute('style')
    else popup.setAttribute('style', entry.style)
    if (entry.popover === null) popup.removeAttribute('popover')
    else popup.setAttribute('popover', entry.popover)
  }
  /** The anchor is minted with the panel: look in the panel's component first (sandboxes repeat ids). */
  const anchorOf = (popup: HTMLElement, entry?: Popup) => {
    if (entry?.anchor?.isConnected) return entry.anchor
    const id = popup.getAttribute('data-sem-anchor')
    if (!id) return null
    const query = `[id="${id.replace(/["\\]/g, '\\$&')}"]`
    const scope = popup.parentElement?.closest('[data-sem-c]')
    const found = (scope?.id === id ? scope : scope?.querySelector<HTMLElement>(query)) ?? host.querySelector<HTMLElement>(query)
    if (entry) entry.anchor = found as HTMLElement | null
    return found as HTMLElement | null
  }
  /** Whether a container the anchor scrolls in has scrolled it out of sight. */
  const clipped = (anchor: HTMLElement, rect: DOMRect) => {
    for (let parent = anchor.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent)
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
      const box = parent.getBoundingClientRect()
      if (rect.bottom <= box.top || rect.top >= box.bottom || rect.right <= box.left || rect.left >= box.right) return true
    }
    return false
  }

  const position = (popup: HTMLElement, entry: Popup, anchor: HTMLElement) => {
    const viewportWidth = document.documentElement.clientWidth
    // The on-screen keyboard shortens the visual viewport, not the layout one.
    const visual = window.visualViewport
    const viewportHeight = visual ? Math.min(document.documentElement.clientHeight, visual.offsetTop + visual.height) : document.documentElement.clientHeight
    const trigger = anchor.getBoundingClientRect()
    // Content can arrive after the panel opens (a lazy calendar or host-owned body).
    // Measure again so an empty panel can grow. Keep its original anchored width as
    // a minimum: percentage minimums would otherwise resolve against the viewport
    // after the panel moves to the fixed top layer.
    Object.assign(popup.style, { position: 'fixed', inset: 'auto', margin: '0', left: '0', top: '0', visibility: '', ...entry.sizing, minWidth: `${entry.anchoredWidth}px` })
    if (typeof popup.showPopover === 'function' && !popup.matches(':popover-open')) popup.showPopover()
    if (clipped(anchor, trigger)) {
      popup.style.visibility = 'hidden'
      return
    }
    const naturalWidth = popup.getBoundingClientRect().width
    const heightLimit = window.getComputedStyle(popup).maxHeight
    const ownMaxHeight = heightLimit?.endsWith('px') ? Number.parseFloat(heightLimit) : Number.NaN
    const room = Math.max(0, viewportWidth - 2 * MARGIN)
    const width = Math.min(popup.getAttribute('data-sem-anchor-width') === 'match' ? trigger.width : naturalWidth, room)
    Object.assign(popup.style, { width: `${width}px`, minWidth: '0', maxWidth: `${room}px`, overflowY: 'auto' })
    const height = popup.getBoundingClientRect().height
    const below = Math.max(0, viewportHeight - trigger.bottom - GAP - MARGIN)
    const above = Math.max(0, trigger.top - GAP - MARGIN)
    const placeAbove = height > below && above > below
    const space = placeAbove ? above : below
    const rtl = window.getComputedStyle(anchor).direction === 'rtl'
    const left = Math.min(Math.max(MARGIN, rtl ? trigger.right - width : trigger.left), Math.max(MARGIN, viewportWidth - width - MARGIN))
    const top = placeAbove ? Math.max(MARGIN, trigger.top - Math.min(height, space) - GAP) : trigger.bottom + GAP
    Object.assign(popup.style, { left: `${left}px`, top: `${top}px`, maxHeight: `${Number.isFinite(ownMaxHeight) ? Math.min(space, ownMaxHeight) : space}px` })
  }

  const discover = (popup: HTMLElement) => {
    if (!ownsNode(popup) || lifted.has(popup) || !shown(popup) || !popup.isConnected) return
    const entry: Popup = {
      anchor: null, anchoredWidth: popup.getBoundingClientRect().width, style: popup.getAttribute('style'), popover: popup.getAttribute('popover'),
      sizing: { width: popup.style.width, minWidth: popup.style.minWidth, maxWidth: popup.style.maxWidth, maxHeight: popup.style.maxHeight },
    }
    if (!anchorOf(popup, entry)) return
    lifted.set(popup, entry)
    if (typeof popup.showPopover === 'function') popup.setAttribute('popover', 'manual')
  }
  // Scan only inserted or revealed subtrees. A keystroke elsewhere must not search the whole app.
  const scan = (node: Element) => {
    if (!ownsNode(node)) return
    if (node.matches(selector)) discover(node as HTMLElement)
    for (const popup of node.querySelectorAll<HTMLElement>(selector)) discover(popup)
  }
  const update = () => {
    for (const [popup, entry] of lifted) {
      const anchor = host.contains(popup) && ownsNode(popup) && shown(popup) ? anchorOf(popup, entry) : null
      if (!anchor) {
        restore(popup, entry)
        lifted.delete(popup)
      } else position(popup, entry, anchor)
    }
  }
  const schedule = () => {
    if (frame !== undefined) return
    frame = window.requestAnimationFrame(() => { frame = undefined; update() })
  }
  const observer = new window.MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) if (node.nodeType === 1) scan(node as Element)
      } else if (record.attributeName === 'hidden' || record.attributeName === 'inert' || record.attributeName === 'data-sem-anchor') {
        scan(record.target as Element)
      }
    }
    if (lifted.size) update()
  })
  observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert', 'data-sem-anchor', 'data-sem-theme', 'data-sem-color-scheme', 'dir'] })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sem-theme', 'data-sem-color-scheme', 'dir'] })
  window.addEventListener('resize', schedule)
  window.visualViewport?.addEventListener('resize', schedule)
  document.addEventListener('scroll', schedule, true)
  scan(host)
  update()
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', schedule)
    window.visualViewport?.removeEventListener('resize', schedule)
    document.removeEventListener('scroll', schedule, true)
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    for (const [popup, entry] of lifted) restore(popup, entry)
    lifted.clear()
  }
}
