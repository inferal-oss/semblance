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
    trigger: HTMLElement; stretch: boolean; anchoredWidth: number; style: string | null; popover: string | null
    sizing: { width: string; minWidth: string; maxWidth: string; maxHeight: string }
  }
  const lifted = new Map<HTMLElement, Popup>()
  let frame: number | undefined
  const restore = (popup: HTMLElement, entry: { style: string | null; popover: string | null }) => {
    if (typeof popup.hidePopover === 'function' && popup.matches(':popover-open')) popup.hidePopover()
    if (entry.style === null) popup.removeAttribute('style')
    else popup.setAttribute('style', entry.style)
    if (entry.popover === null) popup.removeAttribute('popover')
    else popup.setAttribute('popover', entry.popover)
  }

  const position = (popup: HTMLElement, entry: Popup) => {
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight
    const trigger = entry.trigger.getBoundingClientRect()
    // Content can arrive after the panel opens (a lazy calendar or host-owned body).
    // Measure again so an empty panel can grow. Keep its original anchored width as
    // a minimum: percentage minimums would otherwise resolve against the viewport
    // after the panel moves to the fixed top layer.
    Object.assign(popup.style, { position: 'fixed', inset: 'auto', margin: '0', left: '0', top: '0', ...entry.sizing, minWidth: `${entry.anchoredWidth}px` })
    if (typeof popup.showPopover === 'function' && !popup.matches(':popover-open')) popup.showPopover()
    const naturalWidth = popup.getBoundingClientRect().width
    const heightLimit = window.getComputedStyle(popup).maxHeight
    const ownMaxHeight = heightLimit?.endsWith('px') ? Number.parseFloat(heightLimit) : Number.NaN
    const width = Math.min(entry.stretch ? trigger.width : naturalWidth, Math.max(0, viewportWidth - 16))
    Object.assign(popup.style, { width: `${width}px`, minWidth: '0', maxWidth: `${Math.max(0, viewportWidth - 16)}px`, overflowY: 'auto' })
    const bounds = popup.getBoundingClientRect()
    const height = bounds.height
    const below = Math.max(0, viewportHeight - trigger.bottom - 14)
    const above = Math.max(0, trigger.top - 14)
    const placeAbove = height > below && above > below
    const room = placeAbove ? above : below
    const rtl = window.getComputedStyle(entry.trigger).direction === 'rtl'
    const left = Math.min(Math.max(8, rtl ? trigger.right - width : trigger.left), Math.max(8, viewportWidth - width - 8))
    const top = placeAbove ? Math.max(8, trigger.top - Math.min(height, room) - 6) : trigger.bottom + 6
    Object.assign(popup.style, { left: `${left}px`, top: `${top}px`, maxHeight: `${Number.isFinite(ownMaxHeight) ? Math.min(room, ownMaxHeight) : room}px` })
  }

  const candidates = [
    ['[data-sem-c="menu"] > .sem-menu-popup', ':scope > [aria-haspopup="menu"]'],
    ['[data-sem-c="popover"] > .sem-panel', ':scope > .sem-trigger'],
    ['[data-sem-c="date-field"] > .sem-date-popup, [data-sem-c="date-range-field"] > .sem-date-popup', ':scope > .sem-date-row'],
    ['[data-sem-c="typeahead"] > .sem-ta-field > .sem-ta-popup, [data-sem-c="combobox"] > .sem-ta-field > .sem-ta-popup, [data-sem-c="tag-input"] > .sem-ta-field > .sem-ta-popup', null],
  ] as const
  const selector = candidates.map(([selector]) => selector).join(', ')
  const discover = (popup: HTMLElement) => {
    if (!ownsNode(popup) || lifted.has(popup) || popup.hidden || popup.closest('[hidden], [inert]')) return
    const config = candidates.find(([selector]) => popup.matches(selector))
    if (!config) return
    const trigger = config[1] ? popup.parentElement?.querySelector<HTMLElement>(config[1]) : popup.parentElement
    if (!trigger || !popup.isConnected) return
    lifted.set(popup, { trigger, stretch: config[1] === null, anchoredWidth: popup.getBoundingClientRect().width, style: popup.getAttribute('style'), popover: popup.getAttribute('popover'), sizing: { width: popup.style.width, minWidth: popup.style.minWidth, maxWidth: popup.style.maxWidth, maxHeight: popup.style.maxHeight } })
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
      if (!host.contains(popup) || !ownsNode(popup) || popup.hidden || popup.closest('[hidden], [inert]')) {
        restore(popup, entry)
        lifted.delete(popup)
      } else position(popup, entry)
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
      } else if (record.attributeName === 'hidden' || record.attributeName === 'inert') {
        scan(record.target as Element)
      }
    }
    update()
  })
  observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert', 'data-sem-theme', 'data-sem-color-scheme', 'dir'] })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sem-theme', 'data-sem-color-scheme', 'dir'] })
  window.addEventListener('resize', schedule)
  document.addEventListener('scroll', schedule, true)
  scan(host)
  update()
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', schedule)
    document.removeEventListener('scroll', schedule, true)
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    for (const [popup, entry] of lifted) {
      restore(popup, entry)
    }
  }
}
