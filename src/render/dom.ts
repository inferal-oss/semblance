import { applyInputs, inputValue } from '../foreign.ts'
import { SVG_NS } from '../ns.ts'
import { sameDecimal } from '../rdf.ts'
import type { HtmlIndex } from './html-index.ts'
import { HOST_ELEMENT, hostedBy, type HostAdapter, type HostMount } from './hosts.ts'

/**
 * Give an element the focus on the framework's own account, nobody having pressed on it. The browser
 * leaves a text field it has not edited with its caret before the text, where typing would prepend: it
 * goes after the text, or, in a field marked data-sem-select-on-focus, around it as Tab does. A caret
 * the field already has elsewhere stays (a number field has none to read, and keeps what it does).
 */
export function takeFocus(el: HTMLElement, options?: FocusOptions) {
  el.focus?.(options)
  const field = el as HTMLInputElement
  if (field.ownerDocument.activeElement !== field || !field.value || field.selectionStart !== 0 || field.selectionEnd !== 0) return
  if (field.hasAttribute('data-sem-select-on-focus')) field.select()
  else field.setSelectionRange(field.value.length, field.value.length)
}

/**
 * Patches a live DOM subtree from an HtmlIndex. Each RDF/HTML node maps to one
 * DOM node for its whole life (stable IRIs give stable identity), so updates
 * are attribute/text writes and keyed child moves, never re-creation.
 */
/** Where an element is: each ancestor, nearest first, with what stood next to the way down to it. */
export type ElementPlace = { at: Element; next: Element | null; previous: Element | null }[]

export class DomRenderer {
  private readonly doc: Document
  private els = new Map<string, Node>()
  private keys = new WeakMap<Node, string>()
  private applied = new Map<string, Map<string, string>>()
  /** What a host library draws, by the node whose <sem-host> element it draws in (src/render/hosts.ts). */
  private hosted = new Map<string, HostMount>()
  /** The DOM node rendered for an RDF/HTML node, if it is mounted (a host library's own, where it drew one). */
  nodeOf(key: string): Node | undefined {
    const drawn = this.hosts?.nodeOf(key)
    return drawn?.isConnected ? drawn : (this.els.get(key) ?? drawn)
  }

  /** Sizes of the renderer's maps, for leak checks. */
  footprint(): Record<string, number> {
    return { elements: this.els.size, applied: this.applied.size }
  }
  private readonly takeDirty: () => ReturnType<ReturnType<HtmlIndex['consumer']>>
  /** DOM operations performed, for benchmarks. */
  ops = 0
  private readonly patched = new Set<() => void>()
  /** New, still detached containers that live nodes move into: reconciled once connected. */
  private deferred: Node[] = []
  /** Parents reconciled in this patch, with the children they keep: the rest leave at its end. */
  private pendingPrune = new Map<Node, Set<Node>>()
  /**
   * The element the last flush gave the focus to because the focused one was removed (refocus):
   * a guess, not a choice, so a modal overlay that closed may still give the focus back.
   */
  refocused: Element | null = null

  constructor(
    readonly index: HtmlIndex,
    readonly host: Element,
    readonly rootFocus: string,
    /** Draws the nodes a host component library draws (ext:component), each subtree in a <sem-host>. */
    readonly hosts?: HostAdapter,
  ) {
    this.doc = host.ownerDocument
    this.takeDirty = index.consumer()
  }

  keyOf(node: Node): string | undefined {
    return this.keys.get(node) ?? this.hosts?.keyOf(node)
  }

  /** The element of a host-owned slot (see sem:slot), once rendered. */
  slot(name: string): Element | undefined {
    for (const k of this.index.slots.get(name) ?? []) {
      const el = this.els.get(k)
      if (el) return el as Element
    }
    return undefined
  }

  /** Whether a DOM node sits inside host-owned slot content. */
  inSlot(node: Node): boolean {
    for (let n: Node | null = node.parentNode; n && n !== this.host; n = n.parentNode) {
      const k = this.keyOf(n)
      if (k && this.index.nodes.get(k)?.slot !== undefined) return true
    }
    return false
  }

  /**
   * Take over the host's server-rendered children (toHTML of an index in the same state; see
   * src/web/takeover.ts and docs/SSR.md) instead of rendering them again: each index node is paired with the DOM node the HTML
   * parser made for it, in document order. Adjacent text nodes, which the parser joins, are split
   * again; an empty one is created. What does not match (another tag, other attributes) is patched
   * as usual, and counted. Host-owned slots keep their content.
   */
  adopt(): { nodes: number; mismatches: number } {
    this.takeDirty()
    let nodes = 0
    let mismatches = 0
    const take = (k: string, dom: Node | null, parent: Node): Node => {
      const n = this.index.nodes.get(k)!
      nodes++
      if (n.cls === 'Text') {
        const data = n.data ?? ''
        if (dom?.nodeType === 3 && data && (dom as Text).data.startsWith(data)) {
          const t = dom as Text
          // The rest is the next text node's (as splitText does; not every DOM has it).
          if (t.data.length > data.length) parent.insertBefore(this.doc.createTextNode(t.data.slice(data.length)), t.nextSibling), (t.data = t.data.slice(0, data.length))
          this.els.set(k, dom)
          this.keys.set(dom, k)
          return dom
        }
        if (data) {
          mismatches++
          const text = this.element(k)
          parent.insertBefore(text, dom)
          return text
        }
        // An empty text node: HTML has no way to write one, so it is the parser's shape, not a change.
        const empty = this.doc.createTextNode('')
        this.els.set(k, empty)
        this.keys.set(empty, k)
        parent.insertBefore(empty, dom)
        return empty
      }
      if (hostedBy(this.index, this.hosts, k) !== undefined) {
        // What a host library drew on the server: it takes its own markup over (hydration).
        if (dom?.nodeType !== 1 || (dom as Element).localName !== HOST_ELEMENT) {
          mismatches++
          const el = this.element(k)
          parent.insertBefore(el, dom)
          return el
        }
        this.els.set(k, dom)
        this.keys.set(dom, k)
        this.hosted.set(k, this.hosts!.mount(dom as Element, k, true))
        return dom
      }
      const tag = this.index.tagName(k) ?? 'sem-unknown'
      // Case-blind: an HTML parser may lower an SVG element's name (linearGradient) that a browser keeps.
      if (dom?.nodeType !== 1 || (dom as Element).localName.toLowerCase() !== tag.toLowerCase()) {
        mismatches++
        const el = this.element(k)
        parent.insertBefore(el, dom)
        return el
      }
      const el = dom as Element
      this.els.set(k, el)
      this.keys.set(el, k)
      const desired = new Map(this.index.attributes(k))
      const actual = new Map(Array.from(el.attributes, (a) => [a.name, a.value]))
      this.applied.set(k, actual)
      if (desired.size !== actual.size || [...desired].some(([name, v]) => actual.get(name) !== v)) mismatches++, this.syncAttrs(k)
      this.syncProps(k)
      if (this.index.isVoid(k) || n.slot !== undefined) return el
      let cursor = el.firstChild
      for (const slot of this.index.childrenOf(k)) {
        const r = this.index.resolve(slot)
        if (!r) continue
        while (cursor?.nodeType === 8) cursor = cursor.nextSibling
        cursor = take(r, cursor, el).nextSibling
      }
      for (let rest = cursor; rest; ) {
        const next = rest.nextSibling
        if (rest.nodeType !== 8) el.removeChild(rest), mismatches++, this.ops++
        rest = next
      }
      return el
    }
    // Adjacent text nodes are joined first (a parser may split text at a character reference, which
    // browsers do not): adopting splits them again where the index has two.
    this.host.normalize?.()
    const root = this.index.resolve(this.rootFocus)
    if (root) take(root, this.host.firstElementChild, this.host)
    return { nodes, mismatches }
  }

  /**
   * Make a subtree the browser changed itself (composition in an editable region: src/behaviour/text.ts)
   * what the index says again: every text node's data, every element's children, nodes the browser
   * added removed and nodes it removed put back.
   */
  resync(el: Node): void {
    const top = this.keys.get(el)
    if (top === undefined) return
    this.pendingPrune.clear()
    const walk = (k: string) => {
      const dom = this.els.get(k)
      const n = this.index.nodes.get(k)
      if (!dom || !n) return
      if (n.cls === 'Text') {
        const data = n.data ?? ''
        if ((dom as Text).data !== data) ((dom as Text).data = data), this.ops++
        return
      }
      if (dom.nodeType !== 1 || this.index.isVoid(k) || n.slot !== undefined || this.hosted.has(k)) return
      this.reconcile(dom, this.desired(k), true)
      for (const slot of this.index.childrenOf(k)) {
        const r = this.index.resolve(slot)
        if (r) walk(r)
      }
    }
    walk(top)
    this.prune([])
  }

  /** Call `listener` after every patch (host effects that act on what was rendered: islands). */
  onPatched(listener: () => void): () => void {
    this.patched.add(listener)
    return () => this.patched.delete(listener)
  }

  flush(): void {
    this.refocused = null
    // A focused node that moves to another parent (a card to another lane) is detached on the
    // way, which blurs it: it gets its focus back once it is in place.
    const focused = this.doc.activeElement as HTMLElement | null
    // Where it was, in case the patch removes it (a list item's remove button).
    const ancestors = focused ? this.placeOf(focused) : []
    this.patch()
    if (focused && focused !== this.doc.activeElement && focused.isConnected && this.host.contains(focused)) focused.focus?.({ preventScroll: true })
    else if (focused && !focused.isConnected && ancestors.length) this.refocus(ancestors)
    for (const l of this.patched) l()
  }

  /** Where an element is, for `focusNear` once it has gone. */
  placeOf(el: Element): ElementPlace {
    const ancestors: ElementPlace = []
    if (!this.host.contains(el)) return ancestors
    for (let child: Element = el, a = el.parentElement; a && a !== this.host.parentElement; child = a, a = a.parentElement) {
      ancestors.push({ at: a, next: child.nextElementSibling, previous: child.previousElementSibling })
    }
    return ancestors
  }

  /** The focused element was removed (with what it belonged to), and nothing else has the focus: see `focusNear`. */
  private refocus(ancestors: ElementPlace) {
    const active = this.doc.activeElement
    if (active && active !== this.doc.body && active !== this.doc.documentElement) return
    this.focusNear(ancestors)
  }

  /**
   * An element that had, or is to have, the focus is gone: it goes to a control near where it was - in
   * what followed it (the next item of a list), else what preceded it, in its nearest remaining
   * ancestor, else in that ancestor (what the list belongs to) - rather than to the page, so a
   * keyboard user carries on where they were.
   */
  focusNear(ancestors: ElementPlace) {
    const focusable = 'button:not([disabled]), a[href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const first = (within: Element | null, last = false) => {
      if (!within?.isConnected) return undefined
      const all = [within, ...within.querySelectorAll(focusable)].filter((el) => el.matches(focusable) && !el.closest('[hidden], [inert]') && !this.inSlot(el)) as HTMLElement[]
      return last ? all.at(-1) : all[0]
    }
    for (const { at, next, previous } of ancestors) {
      if (!at.isConnected) continue
      const target = first(next) ?? first(previous, true) ?? first(at)
      if (target) return (this.refocused = target), takeFocus(target, { preventScroll: true })
    }
  }

  private patch(): void {
    const d = this.takeDirty()
    this.deferred = []
    this.pendingPrune.clear()
    const retired: Node[] = []
    for (const k of d.recreate) {
      const el = this.els.get(k)
      if (!el) continue
      // A removed or replaced ancestor can still contain a retained host slot. Keep it
      // connected until that slot has moved to its new parent.
      retired.push(el)
      this.els.delete(k)
      this.applied.delete(k)
      this.hosted.get(k)?.destroy()
      this.hosted.delete(k)
    }
    for (const k of d.data) {
      const el = this.els.get(k)
      if (el && el.nodeType === 3) {
        const data = this.index.nodes.get(k)?.data ?? ''
        if ((el as Text).data !== data) ((el as Text).data = data), this.ops++
        // A text area's content is only its default value: once typed in, what it shows is its
        // live value, which follows the graph like an input's (a reaction emptying a composer).
        for (const p of this.index.nodes.get(k)?.parents ?? []) {
          const area = this.els.get(p) as HTMLTextAreaElement | undefined
          if (area?.localName === 'textarea' && area.value !== data) area.value = data
        }
      }
    }
    for (const k of d.attrs) if (this.els.has(k)) this.syncAttrs(k)
    for (const k of d.islands) if (this.els.has(k)) this.syncProps(k)
    for (const k of d.children) if (this.els.has(k)) this.syncChildren(k)
    const root = this.index.resolve(this.rootFocus)
    this.reconcile(this.host, root ? [this.element(root)] : [])
    // New subtrees are built detached and attached whole; a live node (an iframe in a host slot)
    // moving into one waits until it is connected, since a detour through a detached parent resets
    // its document. Children were deferred before their parents: the parents go first.
    for (let i = this.deferred.length - 1; i >= 0; i--) this.reconcile(this.deferred[i]!, this.desired(this.keys.get(this.deferred[i]!)!), true)
    // A retained child can move out of a parent reconciled before its new one: what a parent no
    // longer has leaves only once every move is done.
    const removed: Node[] = []
    this.prune(removed)
    for (const old of retired) if (old.parentNode) old.parentNode.removeChild(old), removed.push(old)
    this.reattach(removed)
    this.pendingPrune.clear()
    this.deferred = []
    // What a host library draws follows the same change: it draws again exactly what changed.
    this.hosts?.patch()
  }

  /** What a reconciled parent no longer has leaves it (collected in `removed`). */
  private prune(removed: Node[]) {
    for (const [parent, wanted] of this.pendingPrune) {
      for (const child of Array.from(parent.childNodes)) if (!wanted.has(child)) parent.removeChild(child), removed.push(child), this.ops++
    }
    this.pendingPrune.clear()
  }

  /**
   * A node that moved to another parent within one change may still sit in its old parent's
   * element when that leaves the page (both parents listed it while the rules that place it
   * settled, and the old one was reconciled last): every keyed element inside what was removed,
   * and still placed by the index under a connected parent, goes back there. It costs what was
   * removed.
   */
  private reattach(removed: Node[]) {
    for (let round = 0; round < 4 && removed.length; round++) {
      const parents = new Set<string>()
      for (const top of removed) {
        if (top.isConnected || top.nodeType !== 1) continue
        for (const el of [top as Element, ...(top as Element).querySelectorAll('*')]) {
          const k = this.keys.get(el)
          if (k === undefined || !this.index.nodes.get(k)?.cls) continue
          for (const p of this.index.placedUnder(k)) if (this.els.get(p)?.isConnected) parents.add(p)
        }
      }
      removed = []
      for (const p of parents) this.reconcile(this.els.get(p)!, this.desired(p), true)
      this.prune(removed)
    }
  }

  private element(k: string): Node {
    let el = this.els.get(k)
    if (el) return el
    const n = this.index.nodes.get(k)!
    if (n.cls !== 'Text' && hostedBy(this.index, this.hosts, k) !== undefined) {
      const container = this.doc.createElement(HOST_ELEMENT)
      this.ops++
      this.els.set(k, container)
      this.keys.set(container, k)
      this.hosted.set(k, this.hosts!.mount(container, k, false))
      return container
    }
    if (n.cls === 'Text') el = this.doc.createTextNode(n.data ?? '')
    else if (this.index.isSvg(k)) el = this.doc.createElementNS(SVG_NS, this.index.tagName(k) ?? 'g')
    else el = this.doc.createElement(this.index.tagName(k) ?? 'sem-unknown')
    this.ops++
    this.els.set(k, el)
    this.keys.set(el, k)
    if (n.cls !== 'Text') {
      this.syncAttrs(k)
      this.syncProps(k)
      this.syncChildren(k)
    }
    return el
  }

  /** A custom element's props (ext:input on a node that is not an island's slot), set as properties or attributes (as the index's policy allows them). */
  private syncProps(k: string) {
    const n = this.index.nodes.get(k)
    if (!n?.inputs?.size || n.tag === undefined || this.index.tagName(k) !== n.tag || this.hosted.has(k)) return
    const el = this.els.get(k) as Element
    if (el?.nodeType !== 1) return
    applyInputs(el, [...this.index.islandInputs(k).values()].map((i) => ({ name: i.name, value: inputValue(i.value), as: i.as })))
  }

  private syncAttrs(k: string) {
    const el = this.els.get(k) as Element
    if (el.nodeType !== 1 || this.hosted.has(k)) return
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
    if (el.localName !== 'input' && el.localName !== 'textarea') return
    const input = el as HTMLInputElement
    if (name === 'checked') input.checked = value !== undefined
    else if (name === 'value' && input.value !== (value ?? '')) {
      // The field being typed in keeps "1.0" while the graph's text is "1" (the next key makes it 1.05);
      // it shows the graph's text when it is left.
      if (value !== undefined && input.ownerDocument.activeElement === input && sameDecimal(input.value, value)) {
        input.addEventListener('blur', () => { input.value = input.getAttribute('value') ?? '' }, { once: true })
        return
      }
      input.value = value ?? ''
    }
  }

  private syncChildren(k: string) {
    const el = this.els.get(k)!
    if (el.nodeType !== 1 || this.index.isVoid(k) || this.index.nodes.get(k)?.slot !== undefined || this.hosted.has(k)) return
    this.reconcile(el, this.desired(k))
  }

  /** The DOM nodes of an element's children, in order (created as needed). */
  private desired(k: string): Node[] {
    const desired: Node[] = []
    for (const slot of this.index.childrenOf(k)) {
      const r = this.index.resolve(slot)
      if (r) desired.push(this.element(r))
    }
    return desired
  }

  /**
   * Keyed reconciliation: nodes on a longest increasing subsequence stay put. A detached parent
   * that a connected node moves into is deferred (see patch), unless `connected` says it is its turn.
   */
  private reconcile(parent: Node, desired: Node[], connected = false) {
    const current = parent.childNodes
    if (current.length === desired.length && desired.every((n, i) => current[i] === n)) return
    if (!connected && !parent.isConnected && desired.some((n) => n.isConnected)) return void this.deferred.push(parent)
    const wanted = new Set(desired)
    this.pendingPrune.set(parent, wanted)
    const index = new Map(desired.map((n, i) => [n, i]))
    const stay = new Set<Node>(longestIncreasing<Node>(Array.from(current).filter((n) => wanted.has(n)), (n) => index.get(n)!))
    let anchor: Node | null = null
    for (let i = desired.length - 1; i >= 0; i--) {
      const n = desired[i]!
      if (!stay.has(n)) {
        // A graph that nests a node in itself (a rule's error) cannot be drawn: what it leaves out
        // is reported, the rest of the patch still happens.
        if (n === parent || n.contains(parent)) {
          this.index.onError(new Error(`<${this.keys.get(n)}> cannot be placed inside itself, under <${this.keys.get(parent)}>`))
          continue
        }
        move(parent, n, anchor), this.ops++
      }
      anchor = n
    }
  }
}

/**
 * Insert `n` before `anchor`: with moveBefore where both are connected, which keeps an iframe's
 * document, the focus and running animations; else (older browsers, detached trees) insertBefore.
 * An ordered list's item is inserted, not moved: Chrome counts an item moveBefore moves again
 * without uncounting it, so two items swapped twice read "5. 6.", until the list is laid out anew
 * (the patch gives a moved node its focus back).
 */
function move(parent: Node, n: Node, anchor: Node | null) {
  const p = parent as Node & { moveBefore?: (node: Node, child: Node | null) => void }
  const numbered = n.nodeName === 'LI' && (parent.nodeName === 'OL' || n.parentNode?.nodeName === 'OL')
  if (p.moveBefore && parent.isConnected && n.isConnected && !numbered) {
    try {
      return p.moveBefore(n, anchor)
    } catch {
      // Across shadow roots or documents moveBefore refuses: an ordinary insertion still moves it.
    }
  }
  parent.insertBefore(n, anchor)
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
