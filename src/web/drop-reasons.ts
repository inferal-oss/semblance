// The host side of a refused drop's reason (ontology/layers/dragdrop.ttl). The graph says which zone
// the drag is over, that it refuses, and why (dnd:Receive and dnd:Hover, projected as
// data-sem-drop-over, data-sem-drop and data-sem-drop-reason); the theme's ::after can only show that
// inside the zone's overflow, so while this effect runs the reason is on a surface of its own, an
// anchored panel (anchored-popups.ts), so no scrolling list clips it. This covers every drag whose
// zones the graph marks: a pointer's, the keyboard's, and files from the computer.
//
// Nothing here writes the graph, and the surface is not what announces the reason: during a pointer
// or keyboard drag the live region says it, from the lifted draggable's status (behaviour/drag.ts).

import { openSurface, type AnchoredSurface } from './anchored-surface.ts'

/** Marks the host while the effect runs, so the theme's ::after stands down. */
const ACTIVE = 'data-sem-drop-reasons'
const REASON = 'data-sem-drop-reason'
const REFUSING = `[data-sem-drop-zone][data-sem-drop=refuses][data-sem-drop-over][${REASON}]`
/** What the surface's style reads from where its zone is. */
const INHERITED = ['--sem-danger-9', '--sem-text-xs', '--sem-font', '--sem-radius-md', '--sem-shadow-3', 'color-scheme']

/** `lift` puts a panel in the top layer next to an element, until the panel leaves the DOM. */
export function attachDropReasons(host: Element, owns: (element: Element) => boolean, lift: (panel: HTMLElement, anchor: HTMLElement) => void) {
  const window = host.ownerDocument.defaultView!
  let shown: { zone: HTMLElement; surface: AnchoredSurface } | null = null

  const refusing = (element: Element) => element.isConnected && element.matches(REFUSING) && owns(element) && !element.closest('[hidden], [inert]')
  const hide = () => {
    shown?.surface.close()
    shown = null
  }
  const settle = (zone: HTMLElement | null) => {
    if (zone !== shown?.zone) {
      hide()
      if (!zone) return
      shown = { zone, surface: openSurface(host, zone, 'sem-drop-reason', INHERITED, zone.getAttribute(REASON)) }
      lift(shown.surface.element, zone)
    } else if (zone) {
      // The same zone, another reason (a language, a count that changed).
      const text = zone.getAttribute(REASON)
      if (shown!.surface.element.textContent !== text) shown!.surface.element.textContent = text
    }
  }
  // Only what changed is looked at: a drag crossing a page does not search it.
  const observer = new window.MutationObserver((records) => {
    let zone: HTMLElement | null = null
    for (const record of records) {
      if (record.type === 'attributes') {
        if (refusing(record.target as Element)) zone = record.target as HTMLElement
        continue
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue
        const element = node as Element
        const found = element.matches(REFUSING) ? element : element.querySelector(REFUSING)
        if (found && refusing(found)) zone = found as HTMLElement
      }
    }
    zone ??= shown && refusing(shown.zone) ? shown.zone : null
    // A patch of the host's children takes the surface with it: it is back before the next paint.
    if (shown && !shown.surface.element.isConnected) hide()
    settle(zone)
  })
  host.setAttribute(ACTIVE, '')
  observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-sem-drop', 'data-sem-drop-over', REASON, 'hidden', 'inert'] })

  return () => {
    observer.disconnect()
    hide()
    host.removeAttribute(ACTIVE)
  }
}
