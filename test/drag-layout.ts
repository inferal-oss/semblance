// A fake layout for drag and drop tests (the test DOM has none): the shown drop zones side by side,
// `width` apart, their draggables in rows `row` high from y = 100; and pointer events to drive them.

interface Layout {
  width: number
  row: number
}
/** Per document: linkedom's element classes are shared between documents. */
const layouts = new WeakMap<Document, Layout>()

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect
const zonesOf = (doc: Document) => ([...doc.querySelectorAll('[data-sem-drop-zone]')] as HTMLElement[]).filter((z) => !z.closest('[hidden]'))
const itemsIn = (zone: Element) => ([...zone.querySelectorAll('[data-sem-drag]')] as HTMLElement[]).filter((d) => d.parentElement!.closest('[data-sem-drop-zone]') === zone)

function rectOf(el: Element): DOMRect {
  const layout = layouts.get(el.ownerDocument)
  if (!layout) return rect(0, 0, 0, 0)
  const zones = zonesOf(el.ownerDocument)
  const z = zones.indexOf(el as HTMLElement)
  if (z >= 0) return rect(z * layout.width, 100, layout.width - 20, Math.max(1, itemsIn(el).length) * layout.row + layout.row)
  const zone = el.parentElement?.closest('[data-sem-drop-zone]') as HTMLElement | null
  if (el.hasAttribute('data-sem-drag') && zone && zones.includes(zone)) return rect(zones.indexOf(zone) * layout.width, 100 + itemsIn(zone).indexOf(el as HTMLElement) * layout.row, layout.width - 20, layout.row)
  return rect(0, 0, 0, 0)
}

export function fakeLayout(h: { document: Document; window: { HTMLElement: { prototype: object }; Event: typeof Event } }, layout: Layout) {
  layouts.set(h.document, layout)
  ;(h.window.HTMLElement.prototype as { getBoundingClientRect: unknown }).getBoundingClientRect = function (this: Element) {
    return rectOf(this)
  }
  ;(h.document as unknown as { elementFromPoint: unknown }).elementFromPoint = (x: number, y: number) => {
    for (const zone of zonesOf(h.document)) {
      const r = rectOf(zone)
      if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue
      return itemsIn(zone).find((d) => !d.style.getPropertyValue('pointer-events') && y >= rectOf(d).top && y < rectOf(d).bottom) ?? zone
    }
    return h.document.body
  }
  const pointer = (el: Element | Document, type: string, x: number, y: number, init: object = {}) => {
    const e = new h.window.Event(type, { bubbles: true, cancelable: true })
    Object.assign(e, { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...init })
    el.dispatchEvent(e)
  }
  return { rectOf, pointer }
}
