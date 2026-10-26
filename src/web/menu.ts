import type { DomRenderer } from '../render/dom.ts'

/** Fit open menus into the viewport using measured room above and below their triggers. */
export function fitMenus(host: Element): void {
  const view = host.ownerDocument.defaultView
  const height = view?.innerHeight ?? 0
  if (!height) return
  for (const menu of host.querySelectorAll<HTMLElement>('[data-sem-c="menu"][data-open]')) {
    const trigger = menu.querySelector<HTMLElement>(':scope > button')
    const popup = menu.querySelector<HTMLElement>(':scope > .sem-menu-popup')
    if (!trigger || !popup) continue
    const rect = trigger.getBoundingClientRect()
    const below = Math.max(0, height - rect.bottom - 14)
    const above = Math.max(0, rect.top - 14)
    // Prefer the expected downward placement while at least several choices
    // fit there. This also keeps menus clear of common sticky page headers.
    const flip = below < Math.min(popup.scrollHeight, 200) && above > below
    menu.toggleAttribute('data-sem-menu-above', flip)
    menu.style.setProperty('--sem-menu-max-height', `${Math.max(48, Math.min(420, Math.floor(flip ? above : below)))}px`)
  }
}

/** Refit after projection patches and viewport movement; one listener serves a whole host. */
export function attachMenus(host: Element, renderer?: DomRenderer): () => void {
  const view = host.ownerDocument.defaultView
  let frame = 0
  const schedule = () => {
    if (frame) return
    frame = view?.requestAnimationFrame?.(() => {
      frame = 0
      fitMenus(host)
    }) ?? 0
    if (!frame) fitMenus(host)
  }
  const stopPatch = renderer?.onPatched(() => fitMenus(host))
  view?.addEventListener('resize', schedule)
  view?.addEventListener('scroll', schedule, true)
  view?.visualViewport?.addEventListener('resize', schedule)
  fitMenus(host)
  return () => {
    stopPatch?.()
    view?.removeEventListener('resize', schedule)
    view?.removeEventListener('scroll', schedule, true)
    view?.visualViewport?.removeEventListener('resize', schedule)
    if (frame) view?.cancelAnimationFrame?.(frame)
  }
}
