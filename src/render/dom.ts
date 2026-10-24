import { SVG_NS } from '../ns.ts'
import type { HtmlIndex } from './html-index.ts'

/**
 * Patches a live DOM subtree from an HtmlIndex. Each RDF/HTML node maps to one
 * DOM node for its whole life (stable IRIs give stable identity), so updates
 * are attribute/text writes and keyed child moves, never re-creation.
 */
export class DomRenderer {
  private readonly doc: Document
  private els = new Map<string, Node>()
  private keys = new WeakMap<Node, string>()
  private applied = new Map<string, Map<string, string>>()
  /** Sizes of the renderer's maps, for leak checks. */
  footprint(): Record<string, number> {
    return { elements: this.els.size, applied: this.applied.size }
  }
  private readonly takeDirty: () => ReturnType<ReturnType<HtmlIndex['consumer']>>
  /** DOM operations performed, for benchmarks. */
  ops = 0

  constructor(
    readonly index: HtmlIndex,
    readonly host: Element,
    readonly rootFocus: string,
  ) {
    this.doc = host.ownerDocument
    this.takeDirty = index.consumer()
  }

  keyOf(node: Node): string | undefined {
    return this.keys.get(node)
  }

  /** The element of a host-owned slot (see sem:slot), once rendered. */
  slot(name: string): Element | undefined {
    for (const [k, el] of this.els) if (this.index.nodes.get(k)?.slot === name) return el as Element
    return undefined
  }

  /** Whether a DOM node sits inside host-owned slot content. */
  inSlot(node: Node): boolean {
    for (let n: Node | null = node.parentNode; n && n !== this.host; n = n.parentNode) {
      const k = this.keys.get(n)
      if (k && this.index.nodes.get(k)?.slot !== undefined) return true
    }
    return false
  }

  flush(): void {
    const d = this.takeDirty()
    for (const k of d.recreate) {
      const el = this.els.get(k)
      if (!el) continue
      el.parentNode?.removeChild(el)
      this.els.delete(k)
      this.applied.delete(k)
    }
    for (const k of d.data) {
      const el = this.els.get(k)
      if (el && el.nodeType === 3) {
        const data = this.index.nodes.get(k)?.data ?? ''
        if ((el as Text).data !== data) ((el as Text).data = data), this.ops++
      }
    }
    for (const k of d.attrs) if (this.els.has(k)) this.syncAttrs(k)
    for (const k of d.children) if (this.els.has(k)) this.syncChildren(k)
    const root = this.index.resolve(this.rootFocus)
    this.reconcile(this.host, root ? [this.element(root)] : [])
  }

  private element(k: string): Node {
    let el = this.els.get(k)
    if (el) return el
    const n = this.index.nodes.get(k)!
    if (n.cls === 'Text') el = this.doc.createTextNode(n.data ?? '')
    else if (this.index.isSvg(k)) el = this.doc.createElementNS(SVG_NS, this.index.tagName(k) ?? 'g')
    else el = this.doc.createElement(this.index.tagName(k) ?? 'sem-unknown')
    this.ops++
    this.els.set(k, el)
    this.keys.set(el, k)
    if (n.cls !== 'Text') {
      this.syncAttrs(k)
      this.syncChildren(k)
    }
    return el
  }

  private syncAttrs(k: string) {
    const el = this.els.get(k) as Element
    if (el.nodeType !== 1) return
    const desired = new Map(this.index.attributes(k))
    const prev = this.applied.get(k) ?? new Map<string, string>()
    for (const name of prev.keys()) if (!desired.has(name)) el.removeAttribute(name), this.reflect(el, name, undefined), this.ops++
    for (const [name, value] of desired) {
      if (prev.get(name) === value) continue
      el.setAttribute(name, value)
      this.reflect(el, name, value)
      this.ops++
    }
    this.applied.set(k, desired)
  }

  /** Keep live form state in line with the graph (attributes only set defaults). */
  private reflect(el: Element, name: string, value: string | undefined) {
    if (el.localName !== 'input') return
    const input = el as HTMLInputElement
    if (name === 'checked') input.checked = value !== undefined
    else if (name === 'value' && input.value !== (value ?? '')) input.value = value ?? ''
  }

  private syncChildren(k: string) {
    const el = this.els.get(k)!
    if (el.nodeType !== 1 || this.index.isVoid(k) || this.index.nodes.get(k)?.slot !== undefined) return
    const desired: Node[] = []
    for (const slot of this.index.childrenOf(k)) {
      const r = this.index.resolve(slot)
      if (r) desired.push(this.element(r))
    }
    this.reconcile(el, desired)
  }

  /** Keyed reconciliation: nodes on a longest increasing subsequence stay put. */
  private reconcile(parent: Node, desired: Node[]) {
    const current = parent.childNodes
    if (current.length === desired.length && desired.every((n, i) => current[i] === n)) return
    const wanted = new Set(desired)
    for (const c of Array.from(current)) if (!wanted.has(c)) parent.removeChild(c), this.ops++
    const index = new Map(desired.map((n, i) => [n, i]))
    const stay = new Set<Node>(longestIncreasing<Node>(Array.from(current), (n) => index.get(n)!))
    let anchor: Node | null = null
    for (let i = desired.length - 1; i >= 0; i--) {
      const n = desired[i]!
      if (!stay.has(n)) parent.insertBefore(n, anchor), this.ops++
      anchor = n
    }
  }
}

/** Items forming a longest increasing subsequence of `rank(item)`. */
function longestIncreasing<T>(items: T[], rank: (t: T) => number): T[] {
  const tails: number[] = []
  const prev = new Array<number>(items.length)
  for (let i = 0; i < items.length; i++) {
    const r = rank(items[i]!)
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (rank(items[tails[mid]!]!) < r) lo = mid + 1
      else hi = mid
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1
    tails[lo] = i
  }
  const out: T[] = []
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) out.push(items[i]!)
  return out.reverse()
}
