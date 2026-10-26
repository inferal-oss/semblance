/** Keep anchored panels visible outside scrolling containers without moving their DOM. */
export function attachAnchoredPopups(host: Element) {
  const document = host.ownerDocument
  const window = document.defaultView!
  const lifted = new Map<HTMLElement, { trigger: HTMLElement; width: number; stretch: boolean; style: string | null; popover: string | null }>()
  let frame: number | undefined
  const restore = (popup: HTMLElement, entry: { style: string | null; popover: string | null }) => {
    if (typeof popup.hidePopover === 'function' && popup.matches(':popover-open')) popup.hidePopover()
    if (entry.style === null) popup.removeAttribute('style')
    else popup.setAttribute('style', entry.style)
    if (entry.popover === null) popup.removeAttribute('popover')
    else popup.setAttribute('popover', entry.popover)
  }

  const position = (popup: HTMLElement, entry: { trigger: HTMLElement; width: number; stretch: boolean }) => {
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight
    const trigger = entry.trigger.getBoundingClientRect()
    const width = Math.min(entry.stretch ? trigger.width : entry.width, Math.max(0, viewportWidth - 16))
    Object.assign(popup.style, { position: 'fixed', inset: 'auto', margin: '0', width: `${width}px`, minWidth: '0', maxWidth: `${Math.max(0, viewportWidth - 16)}px`, maxHeight: `${Math.max(0, viewportHeight - 16)}px`, overflowY: 'auto' })
    if (typeof popup.showPopover === 'function' && !popup.matches(':popover-open')) popup.showPopover()
    const bounds = popup.getBoundingClientRect()
    const height = bounds.height
    const below = Math.max(0, viewportHeight - trigger.bottom - 14)
    const above = Math.max(0, trigger.top - 14)
    const placeAbove = height > below && above > below
    const room = placeAbove ? above : below
    const rtl = window.getComputedStyle(entry.trigger).direction === 'rtl'
    const left = Math.min(Math.max(8, rtl ? trigger.right - width : trigger.left), Math.max(8, viewportWidth - width - 8))
    const top = placeAbove ? Math.max(8, trigger.top - Math.min(height, room) - 6) : trigger.bottom + 6
    Object.assign(popup.style, { left: `${left}px`, top: `${top}px`, maxHeight: `${room}px` })
  }

  const candidates = [
    ['[data-sem-c="menu"] > .sem-menu-popup', ':scope > [aria-haspopup="menu"]'],
    ['[data-sem-c="popover"] > .sem-panel', ':scope > .sem-trigger'],
    ['[data-sem-c="date-field"] > .sem-date-popup, [data-sem-c="date-range-field"] > .sem-date-popup', ':scope > .sem-date-row'],
    ['[data-sem-c="typeahead"] > .sem-ta-field > .sem-ta-popup, [data-sem-c="combobox"] > .sem-ta-field > .sem-ta-popup, [data-sem-c="tag-input"] > .sem-ta-field > .sem-ta-popup', null],
  ] as const
  const selector = candidates.map(([selector]) => selector).join(', ')
  const discover = (popup: HTMLElement) => {
    if (lifted.has(popup) || popup.hidden || popup.closest('[hidden], [inert]')) return
    const config = candidates.find(([selector]) => popup.matches(selector))
    if (!config) return
    const trigger = config[1] ? popup.parentElement?.querySelector<HTMLElement>(config[1]) : popup.parentElement
    if (!trigger || !popup.isConnected) return
    lifted.set(popup, { trigger, width: popup.getBoundingClientRect().width, stretch: config[1] === null, style: popup.getAttribute('style'), popover: popup.getAttribute('popover') })
    if (typeof popup.showPopover === 'function') popup.setAttribute('popover', 'manual')
  }
  // Scan only inserted or revealed subtrees. A keystroke elsewhere must not search the whole app.
  const scan = (node: Element) => {
    if (node.matches(selector)) discover(node as HTMLElement)
    for (const popup of node.querySelectorAll<HTMLElement>(selector)) discover(popup)
  }
  const update = () => {
    for (const [popup, entry] of lifted) {
      if (!host.contains(popup) || popup.hidden || popup.closest('[hidden], [inert]')) {
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
