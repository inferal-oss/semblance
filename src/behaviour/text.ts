// Rich text regions (docs/BLOCKS.md): where the browser's caret and selection are, in the graph's
// terms, and back. A rendering marks the element that holds a node's editable text with
// data-sem-text (its value: the node), and the editable region around such elements with
// data-sem-text-root (its value: the selection the graph holds, "anchor offset focus offset", or
// empty). A position is a node and an offset into its text in characters as SPARQL counts them
// (code points), not the DOM's UTF-16 units. Only text nodes count; a <br> does not.

/** A place in a node's text: the node (data-sem-text) and an offset in code points. */
export interface TextPoint {
  node: string
  offset: number
}

/** A range of text, start before end in document order, and the text holders wholly inside it. */
export interface TextRange {
  start: TextPoint
  end: TextPoint
  covers: string[]
}

const HOLDER = '[data-sem-text]'

/** Code points in a string (a surrogate pair is one). */
export const codePoints = (s: string): number => {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0xd800 || c > 0xdbff || i + 1 >= s.length) n++
    else n++, i++
  }
  return n
}

/** The UTF-16 index of the `n`th code point of a string. */
const unitsFor = (s: string, n: number): number => {
  let i = 0
  for (let k = 0; k < n && i < s.length; k++) {
    const c = s.charCodeAt(i)
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? 2 : 1
  }
  return i
}

/** The text holder an element or text node is in. */
export const holderOf = (node: Node | null): Element | null => {
  const el = node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null)
  return el?.closest?.(HOLDER) ?? null
}

/** The region (data-sem-text-root) a node is in. */
export const regionOf = (node: Node | null): Element | null => {
  const el = node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null)
  return el?.closest?.('[data-sem-text-root]') ?? null
}

/** The text nodes of a holder, in order. */
function textNodes(holder: Element): Text[] {
  const out: Text[] = []
  const walk = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out.push(c as Text)
      else if (c.nodeType === 1) walk(c)
    }
  }
  walk(holder)
  return out
}

const contains = (a: Node, b: Node) => a === b || !!(a.compareDocumentPosition(b) & 16)
/** Whether `a` comes before `b` in document order (and is not inside it). */
const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & 4)

/** The code points of a holder's text before a DOM point inside it. */
function offsetIn(holder: Element, node: Node, offset: number): number {
  let n = 0
  for (const t of textNodes(holder)) {
    if (t === node) return n + codePoints(t.data.slice(0, offset))
    // A point between elements: count the text nodes before the child it is at.
    if (node.nodeType === 1 && contains(node, t)) {
      const child = node.childNodes[offset]
      if (child && (child === t || contains(child, t) || before(child, t))) return n
    }
    n += codePoints(t.data)
  }
  return n
}

/** A DOM point as a text point: in the holder it is in, else the holder it comes before (its start) or after (its end). */
export function pointOf(region: Element, node: Node, offset: number): TextPoint | undefined {
  const holder = holderOf(node)
  if (holder && region.contains(holder)) return { node: holder.getAttribute('data-sem-text')!, offset: offsetIn(holder, node, offset) }
  const holders = [...region.querySelectorAll(HOLDER)]
  if (!holders.length) return undefined
  // A point between elements is before the child at its offset.
  const at = node.nodeType === 1 ? (node.childNodes[offset] ?? null) : null
  const after = holders.find((h) => (at ? at === h || contains(at, h) || before(at, h) : before(node, h)))
  if (after) return { node: after.getAttribute('data-sem-text')!, offset: 0 }
  const last = holders.at(-1)!
  return { node: last.getAttribute('data-sem-text')!, offset: codePoints(last.textContent ?? '') }
}

interface DomRange {
  startContainer: Node
  startOffset: number
  endContainer: Node
  endOffset: number
}

/** A DOM range (a StaticRange from getTargetRanges, or the selection's) as a text range. */
export function rangeOf(region: Element, r: DomRange): TextRange | undefined {
  const start = pointOf(region, r.startContainer, r.startOffset)
  const end = pointOf(region, r.endContainer, r.endOffset)
  if (!start || !end) return undefined
  const covers: string[] = []
  if (start.node !== end.node) {
    const first = region.querySelector(`[data-sem-text="${CSS_ESCAPE(start.node)}"]`)
    const last = region.querySelector(`[data-sem-text="${CSS_ESCAPE(end.node)}"]`)
    for (const h of region.querySelectorAll(HOLDER)) if (first && last && before(first, h) && before(h, last)) covers.push(h.getAttribute('data-sem-text')!)
  }
  return { start, end, covers }
}

/** The holder of a node's text in a region. */
const holderFor = (region: Element, node: string) => region.querySelector(`[data-sem-text="${CSS_ESCAPE(node)}"]`)

/** A text point as a DOM point (the text node and its UTF-16 offset; an empty text: before its <br>). */
export function domPoint(region: Element, p: TextPoint): { node: Node; offset: number } | undefined {
  const holder = holderFor(region, p.node)
  if (!holder) return undefined
  let left = p.offset
  const nodes = textNodes(holder)
  for (const t of nodes) {
    const n = codePoints(t.data)
    if (left <= n) return { node: t, offset: unitsFor(t.data, left) }
    left -= n
  }
  const last = nodes.at(-1)
  return last ? { node: last, offset: last.data.length } : { node: holder, offset: 0 }
}

/** The selection a region's rendering states (data-sem-text-root="anchor offset focus offset"). */
export function statedSelection(region: Element): { anchor: TextPoint; focus: TextPoint } | undefined {
  const parts = (region.getAttribute('data-sem-text-root') ?? '').split(' ')
  if (parts.length !== 4) return undefined
  const [a, ao, f, fo] = parts as [string, string, string, string]
  return { anchor: { node: a, offset: Number(ao) }, focus: { node: f, offset: Number(fo) } }
}

/** Put the browser's selection where the region's rendering says it is. Returns whether it did. */
export function placeSelection(region: Element): boolean {
  const stated = statedSelection(region)
  const doc = region.ownerDocument
  const sel = doc.getSelection?.()
  if (!stated || !sel) return false
  const anchor = domPoint(region, stated.anchor)
  const focus = domPoint(region, stated.focus)
  if (!anchor || !focus) return false
  if (sel.anchorNode === anchor.node && sel.anchorOffset === anchor.offset && sel.focusNode === focus.node && sel.focusOffset === focus.offset) return true
  if (typeof sel.setBaseAndExtent === 'function') sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
  return true
}

/** The browser's selection in a region, as text points. */
export function selectionIn(region: Element): { anchor: TextPoint; focus: TextPoint } | undefined {
  const sel = region.ownerDocument.getSelection?.()
  if (!sel || !sel.anchorNode || !sel.focusNode || !region.contains(sel.anchorNode) || !region.contains(sel.focusNode)) return undefined
  const anchor = pointOf(region, sel.anchorNode, sel.anchorOffset)
  const focus = pointOf(region, sel.focusNode, sel.focusOffset)
  return anchor && focus ? { anchor, focus } : undefined
}

/** The current text of a holder (what the browser shows, which composition may have changed). */
export const holderText = (region: Element, node: string): string | undefined => {
  const h = holderFor(region, node)
  return h ? textNodes(h).map((t) => t.data).join('') : undefined
}

const CSS_ESCAPE = (s: string) => s.replace(/["\\]/g, '\\$&')
