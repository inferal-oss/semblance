// A short text about an element, shown on a surface of its own: an anchored panel (anchored-popups.ts)
// that the tooltip effect and the drop reason effect each show one of. It prefers the side above its
// source and centres on it. It lives in the host, so it copies from its source what the source
// inherits (the theme's tokens, the colour scheme, the direction, the language), and it describes
// its source while it is shown.

let surfaces = 0

export interface AnchoredSurface {
  element: HTMLElement
  /** Take it away, and what it told the source. */
  close: () => void
}

/** `inherited` is what the surface's style reads from where its source is (a theme may be set on any subtree). */
export function openSurface(host: Element, source: HTMLElement, className: string, inherited: readonly string[], text: string | null): AnchoredSurface {
  const document = host.ownerDocument
  const element = document.createElement('div')
  const id = `${className}-${++surfaces}`
  const style = document.defaultView!.getComputedStyle(source)
  element.id = id
  element.className = className
  element.setAttribute('role', 'tooltip')
  element.setAttribute('data-sem-anchor', '')
  element.setAttribute('data-sem-anchor-side', 'above')
  element.setAttribute('data-sem-anchor-align', 'center')
  element.setAttribute('dir', style.direction)
  const lang = source.closest('[lang]')?.getAttribute('lang')
  if (lang) element.setAttribute('lang', lang)
  for (const property of inherited) element.style.setProperty(property, style.getPropertyValue(property))
  element.textContent = text
  host.append(element)
  source.setAttribute('aria-describedby', [source.getAttribute('aria-describedby'), id].filter(Boolean).join(' '))
  return {
    element,
    close: () => {
      const tokens = (source.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((t) => t && t !== id)
      if (tokens.length) source.setAttribute('aria-describedby', tokens.join(' '))
      else source.removeAttribute('aria-describedby')
      element.remove()
    },
  }
}
