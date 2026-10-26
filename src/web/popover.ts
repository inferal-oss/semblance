// A Popover's graph decides whether its panel is open. The browser knows its
// measured position, so this effect keeps an open panel inside the viewport.

export interface PopoverHost {
  /** Fit the currently open panels after layout changes. */
  update(): void
  dispose(): void
}

const EDGE_GAP = 12

export function attachPopovers(host: HTMLElement): PopoverHost {
  const win = host.ownerDocument.defaultView!
  let frame = 0

  function update() {
    for (const panel of host.querySelectorAll<HTMLElement>('[data-sem-c="popover"] > .sem-panel:not([hidden])')) {
      // Remove the previous correction before measuring. This allows a panel to
      // return to its theme's anchored position when the viewport grows.
      panel.style.translate = ''
      const bounds = panel.getBoundingClientRect()
      const width = win.innerWidth
      if (!width || !bounds.width) continue
      const available = Math.max(0, width - EDGE_GAP * 2)
      const left = Math.max(EDGE_GAP, Math.min(bounds.left, width - EDGE_GAP - Math.min(bounds.width, available)))
      const shift = left - bounds.left
      if (Math.abs(shift) >= 0.5) panel.style.translate = `${shift}px 0`
    }
  }

  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(() => {
      frame = 0
      update()
    })
  }
  const observer = new win.MutationObserver((records) => {
    // Ignore our own inline placement correction.
    if (records.some((record) => record.type === 'childList' || record.attributeName !== 'style')) schedule()
  })
  observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'style', 'data-sem-c'] })
  win.addEventListener('resize', schedule)
  win.addEventListener('scroll', schedule, true)
  schedule()

  return {
    update,
    dispose() {
      observer.disconnect()
      win.removeEventListener('resize', schedule)
      win.removeEventListener('scroll', schedule, true)
      if (frame) win.cancelAnimationFrame(frame)
    },
  }
}
