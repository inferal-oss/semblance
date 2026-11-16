// The DOM as the framework reads it wherever a mount renders: past named elements, and into a
// shadow root (mount's isolate: 'shadow').
//
// Named elements. A document exposes some elements by name (an
// img, a form, an embed, an object, an iframe) as properties ahead of its own, and a window every
// element by id: `<img name="adoptedStyleSheets">` makes document.adoptedStyleSheets that image, and
// `<a id="__semblanceKept">` is globalThis.__semblanceKept where no script set one. Authored content
// can have such names (docs/SAFETY.md), so what the framework reads of the document and the global
// object it reads from their prototypes, or as their own properties, where named elements never are.

/** `name` as the prototype chain of `target` has it (skipping what `target` itself shows under that name). */
function inherited(target: object, name: string): PropertyDescriptor | undefined {
  for (let p = Object.getPrototypeOf(target); p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, name)
    if (d) return d
  }
  return undefined
}

/** Call a method of a document or a shadow root as its prototype has it. */
function method<T>(target: object, name: string, ...args: unknown[]): T {
  const d = inherited(target, name)
  const fn = (d?.value ?? (target as Record<string, unknown>)[name]) as (...a: unknown[]) => T
  return fn.apply(target, args)
}

/** The style sheets a document or shadow root has adopted. */
export function adoptedSheets(target: Document | ShadowRoot): readonly CSSStyleSheet[] {
  const get = inherited(target, 'adoptedStyleSheets')?.get
  return ((get ? get.call(target) : target.adoptedStyleSheets) ?? []) as CSSStyleSheet[]
}

/** Set the style sheets a document or shadow root has adopted. */
export function setAdoptedSheets(target: Document | ShadowRoot, sheets: CSSStyleSheet[]): void {
  const set = inherited(target, 'adoptedStyleSheets')?.set
  if (set) set.call(target, sheets)
  else target.adoptedStyleSheets = sheets
}

/** Adopt a sheet after those adopted already. */
export const adoptSheet = (target: Document | ShadowRoot, sheet: CSSStyleSheet): void => setAdoptedSheets(target, [...adoptedSheets(target), sheet])
/** Let an adopted sheet go. */
export const dropSheet = (target: Document | ShadowRoot, sheet: CSSStyleSheet): void => setAdoptedSheets(target, adoptedSheets(target).filter((s) => s !== sheet))

/** The element of an id in the tree `from` is in: its document, or the shadow root it is rendered in. */
export function elementById(from: Node, id: string): HTMLElement | null {
  const root = typeof from.getRootNode === 'function' ? from.getRootNode() : from.ownerDocument
  if (!root || !('getElementById' in root)) return null
  return method<HTMLElement | null>(root, 'getElementById', id)
}

/** The first element matching `selector` in the tree `from` is in. */
export function querySelectorIn(from: Node, selector: string): Element | null {
  const root = typeof from.getRootNode === 'function' ? from.getRootNode() : from.ownerDocument
  if (!root || !('querySelector' in root)) return null
  return method<Element | null>(root, 'querySelector', selector)
}

/** A property a script set on the global object (never an element its id names there). */
export function globalOwn<T>(name: string): T | undefined {
  return Object.getOwnPropertyDescriptor(globalThis, name)?.value as T | undefined
}

// Shadow roots. A document listener hears an event from inside a shadow root as if its host were the
// target, and the document's active element is the host while the focus is inside: the framework
// asks for the element itself.

/** The element an event started at, inside any shadow root (its target, for an event from the light DOM). */
export function originOf(e: Event): EventTarget | null {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : []
  return path[0] ?? e.target
}

/** The element that has the focus, inside any shadow root (the document's active element otherwise). */
export function deepActive(doc: Document | null | undefined): Element | null {
  let active = doc?.activeElement ?? null
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active
}

/**
 * Mark the page's state where `:root` stands for it from `node`: on the document's root, and, in a
 * shadow root, on its box too (its sheet is scoped to the box, src/style/scope.ts, so `:root[…]`
 * reads the box). `value` null removes the mark.
 */
export function markRoot(node: Node, name: string, value: string | null): void {
  const doc = node.ownerDocument ?? (node as Document)
  const shadow = typeof node.getRootNode === 'function' ? node.getRootNode() : undefined
  const box = shadow && shadow !== doc && 'host' in shadow ? (shadow as ShadowRoot).firstElementChild : null
  for (const el of [doc.documentElement, box]) {
    if (!el) continue
    if (value === null) el.removeAttribute(name)
    else el.setAttribute(name, value)
  }
}
