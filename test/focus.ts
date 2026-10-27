import { onTestFinished } from 'vitest'

/**
 * A focus the DOM can say it has (linkedom keeps none): focus() moves it, activeElement reads it,
 * and a removed element loses it, as a browser's does. Undone when the test finishes.
 */
export function trackFocus(window: { HTMLElement: typeof HTMLElement }, document: Document) {
  let active: Element | null = null
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => (active?.isConnected ? active : document.body) })
  const proto = window.HTMLElement.prototype
  const own = Object.getOwnPropertyDescriptor(proto, 'focus')
  Object.defineProperty(proto, 'focus', { configurable: true, writable: true, value(this: Element) { active = this } })
  onTestFinished(() => {
    if (own) Object.defineProperty(proto, 'focus', own)
    else delete (proto as { focus?: unknown }).focus
    delete (document as { activeElement?: unknown }).activeElement
  })
}
