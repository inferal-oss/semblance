import type { Quad, Term } from '@rdfjs/types'
import { EXT, H, NS, ORD, RDF_TYPE, SEM } from '../ns.ts'
import type { Delta } from '../rdf.ts'
import { ATTRIBUTE_NAMES, TAG_NAMES, VOID_ELEMENTS } from '../vocab/rdfhtml.generated.ts'
import { linearize, OrderingError } from './ordering.ts'
import { compareKeys } from './order-key.ts'
import { SVG_TAG_NAMES } from '../vocab/svg.ts'
import { allowsCustomElement, allowsElement, allowsHostComponent, ATTRIBUTE_NAME, attributeProblem, idReferences, inputProblem, Refused, type SafetyPolicy } from '../safety.ts'

/** The tag a refused element renders as (empty, with data-sem-refused naming what it was). */
export const REFUSED_TAG = 'sem-refused'
export const REFUSED_ATTRIBUTE = 'data-sem-refused'

export interface HNode {
  /** RDF/HTML class local name ("Button", "Text"...). */
  cls?: string
  data?: string
  /** content attribute name -> asserted values (more than one is a conflict) */
  props: Map<string, Set<string>>
  attrNodes: Set<string>
  children: Set<string>
  parents: Set<string>
  /** Host-owned slot name: renderers never manage this element's children. */
  slot?: string
  /** sem:orderKey: position among siblings that have no ord: precedence. */
  orderKey?: string
  /** Further values of data and orderKey, while it has several (single). */
  others?: Record<string, string[]>
  /** ext:island: the foreign component mounted in this (slot) element. */
  island?: string
  /** ext:tag: on an island's slot, the custom element mounted in it; on any other node, the custom element it is. */
  tag?: string
  /** ext:component: the host component that draws this node and everything under it (src/render/hosts.ts). */
  component?: string
  /** ext:input: the input nodes stating the island's current inputs. */
  inputs?: Set<string>
}

/** The current value of one input of an island (ext:input on its slot). */
export interface IslandInput {
  name: string
  value: Term
  /** ext:Property or ext:Attribute. */
  as: string
}

interface InputNode {
  name?: string
  value?: Term
  as?: string
  owners: Set<string>
}

interface AttrNode {
  name?: string
  value?: string
  /** Further values of name and value, while it has several (single). */
  others?: Record<string, string[]>
  owners: Set<string>
}

export interface Dirty {
  attrs: Set<string>
  data: Set<string>
  children: Set<string>
  recreate: Set<string>
  roots: Set<string>
  /** Slots whose island, tag or inputs changed (for the islands effect). */
  islands: Set<string>
}

/** A valid custom element name (with a hyphen, not one HTML reserves), so a graph cannot name `script` as a tag. */
const CUSTOM_ELEMENT = /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/
const RESERVED_TAGS = new Set(['annotation-xml', 'color-profile', 'font-face', 'font-face-src', 'font-face-uri', 'font-face-format', 'font-face-name', 'missing-glyph'])
export const isCustomElementName = (tag: string) => CUSTOM_ELEMENT.test(tag) && !RESERVED_TAGS.has(tag)

/** Content attributes whose value is one URL. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'poster', 'action', 'formaction', 'cite'])
/** A URL that does not depend on the document's own address: with a scheme, from the root, or in the document (#, ?). */
const ANCHORED = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|[/#?])/

/**
 * A URL as it resolves against a base (an absolute path ending in '/'): a relative one ("photos/a.jpg",
 * "./a.jpg") is written after the base; any other, and an empty one, as given.
 */
export function resolveUrl(value: string, base: string): string {
  const v = value.trim()
  return v === '' || ANCHORED.test(v) ? value : base + v.replace(/^(?:\.\/)+/, '')
}

const newDirty = (): Dirty => ({ attrs: new Set(), data: new Set(), children: new Set(), recreate: new Set(), roots: new Set(), islands: new Set() })

const inc = <K, V>(m: Map<K, Set<V>>, k: K, v: V, sign: number) => {
  let s = m.get(k)
  if (sign > 0) {
    if (!s) m.set(k, (s = new Set()))
    s.add(v)
  } else if (s) {
    s.delete(v)
    if (!s.size) m.delete(k)
  }
}

/**
 * An incrementally maintained view of an RDF/HTML graph, fed with deltas.
 * It normalizes ordering (hasChild, childOf, the ord: precedence family and the
 * hasChild∘precedes chain) and records what changed, for renderers to patch.
 */
/**
 * A property a node shows one value of, the last stated of those it has. A rule can state several for
 * a moment (a text in every language, before the graph that picks one arrived, #350): taking the
 * shown one away shows the one left.
 */
function single<F extends string>(n: { [K in F]?: string } & { others?: Record<string, string[]> }, field: F, o: string, sign: 1 | -1) {
  const holder = n as { [K in F]?: string }
  const had = holder[field] as string | undefined
  const others = n.others?.[field]
  if (sign > 0) {
    if (had === o) return
    if (had !== undefined) ((n.others ??= {})[field] ??= []).push(had)
    ;(holder as Record<F, string | undefined>)[field] = o
  } else if (had === o) {
    ;(holder as Record<F, string | undefined>)[field] = others?.pop()
  } else {
    const i = others?.indexOf(o) ?? -1
    if (i >= 0) others!.splice(i, 1)
  }
}

export class HtmlIndex {
  readonly nodes = new Map<string, HNode>()
  private attrs = new Map<string, AttrNode>()
  private inputNodes = new Map<string, InputNode>()
  /** Slots that have an island mounted in them. */
  readonly islandSlots = new Set<string>()
  /** The nodes of each host-owned slot name (sem:slot), so a host finds its slot without a scan. */
  readonly slots = new Map<string, Set<string>>()
  private immediate = new Map<string, Set<string>>()
  private strict = new Map<string, Set<string>>()
  private rootByFocus = new Map<string, string>()
  private focusByRoot = new Map<string, string>()
  /** Parents of nodes that are children only through the precedence chain. */
  private chainParent = new Map<string, string>()
  /**
   * Elements that hold a component aside (sem:setsAside: a hidden switch case's content), by the
   * component: not where it is placed, but where what it inherits (warmth) and what a choice that
   * would show it prepares (shownUnder) reach it from.
   */
  private asideIn = new Map<string, Set<string>>()
  /** Bumped whenever something that decides visibility changes (placement, roots, hidden). */
  visibility = 0
  /** One dirty set per consumer (each renderer patches independently). */
  private consumers = new Set<Dirty>()
  /** Sizes of the index, for leak checks. */
  footprint(): Record<string, number> {
    return { nodes: this.nodes.size, attrs: this.attrs.size, immediate: this.immediate.size, strict: this.strict.size, roots: this.rootByFocus.size, chainParents: this.chainParent.size, aside: this.asideIn.size }
  }
  /**
   * @param urlBase Where relative URLs in what is rendered resolve (nav:base: the site's root, an
   * absolute path ending in '/'): a relative src or href is written against it, so an asset in the
   * data ("photos/harbour.jpg") is the same file on every page. Absent: URLs are written as given.
   */
  /**
   * What the policy (`policy`) kept out, by node: each reason once, reported through onError when
   * first met. Forgotten with the node.
   */
  readonly refusals = new Map<string, Set<string>>()

  constructor(
    readonly onError: (e: Error) => void = (e) => console.error(e),
    readonly urlBase?: string,
    /**
     * Authored content (src/safety.ts): an element of a class the policy does not list renders as an
     * empty sem-refused element, and an attribute it refuses is left out. Absent: trusted, as given.
     */
    readonly policy?: SafetyPolicy,
  ) {}

  /**
   * Authored content: the ids its elements have (how many have each), so an id reference can be held
   * to the projection; and, both ways, which ids each element's references name, so an element is
   * checked again when an id it names comes or goes.
   */
  private ids = new Map<string, number>()
  private idOf = new Map<string, string>()
  private referrers = new Map<string, Set<string>>()
  private referenced = new Map<string, readonly string[]>()

  /** The id an element of authored content has as rendered (none when it is refused). */
  private mintedId(key: string): string | undefined {
    const n = this.nodes.get(key)
    if (!n?.cls || n.cls === 'Text' || this.isRefused(key)) return undefined
    const own = n.props.get('id')
    if (own?.size) return [...own].sort()[0]
    for (const a of n.attrNodes) {
      const rec = this.attrs.get(a)
      if (rec?.name === 'id' && rec.value !== undefined) return rec.value
    }
    return undefined
  }

  /** Record an element's id; the ids that came or went are added to `changed`. */
  private trackId(key: string, changed: Set<string>) {
    const had = this.idOf.get(key)
    const id = this.mintedId(key)
    if (had === id) return
    if (had !== undefined) {
      const left = (this.ids.get(had) ?? 1) - 1
      if (left) this.ids.set(had, left)
      else this.ids.delete(had), changed.add(had)
      this.idOf.delete(key)
    }
    if (id !== undefined) {
      const count = this.ids.get(id) ?? 0
      this.ids.set(id, count + 1)
      if (!count) changed.add(id)
      this.idOf.set(key, id)
    }
  }

  /** Record which ids an element names (for checking it again when one of them comes or goes). */
  private trackReferences(key: string, names: readonly string[]) {
    const had = this.referenced.get(key)
    if (had) for (const id of had) {
      const r = this.referrers.get(id)
      if (r && (r.delete(key), !r.size)) this.referrers.delete(id)
    }
    if (!names.length) {
      this.referenced.delete(key)
      return
    }
    this.referenced.set(key, names)
    for (const id of names) {
      let r = this.referrers.get(id)
      if (!r) this.referrers.set(id, (r = new Set()))
      r.add(key)
    }
  }

  /** Report what the policy kept out of a node, once per reason (the islands effect reports an island it does not mount). */
  refuse(key: string, kind: Refused['kind'], message: string) {
    let reasons = this.refusals.get(key)
    if (reasons?.has(message)) return
    if (!reasons) this.refusals.set(key, (reasons = new Set()))
    reasons.add(message)
    this.onError(new Refused(key, kind, `Refused on <${key}>: ${message}.`))
  }

  /** Whether a node is an element the policy refuses (rendered empty, as sem-refused). */
  isRefused(key: string): boolean {
    const cls = this.nodes.get(key)?.cls
    if (!this.policy || !cls || cls === 'Text' || allowsElement(this.policy, cls)) return false
    this.refuse(key, 'element', `authored content may not have a ${this.tagOf(cls) ?? cls} element`)
    return true
  }

  private tagOf(cls: string): string | undefined {
    return cls.startsWith('svg:') ? SVG_TAG_NAMES[cls.slice(4)] : TAG_NAMES[cls]
  }

  apply(delta: Delta): void {
    for (const q of delta.remove) this.quad(q, -1)
    for (const q of delta.add) this.quad(q, 1)
    // Authored content: what the policy refuses is reported as it arrives, not when it is first shown.
    if (this.checking.size) {
      // Ids first, so a reference is checked against every id of this delta; an element naming an id
      // that came or went is checked (and shown) again.
      const changed = new Set<string>()
      for (const k of this.checking) this.trackId(k, changed)
      const again: string[] = []
      for (const id of changed) for (const k of this.referrers.get(id) ?? []) if (!this.checking.has(k)) again.push(k)
      for (const k of again) this.mark('attrs', k)
      for (const k of this.checking) {
        if (this.nodes.get(k)?.cls) this.isRefused(k) || this.attributes(k)
        else if (this.referenced.has(k)) this.trackReferences(k, [])
      }
      this.checking.clear()
    }
    // Forget nodes and attribute occurrences nothing describes any more, so the
    // index stays the size of what is derived, however much came and went.
    if (delta.remove.length) {
      for (const q of delta.remove) {
        this.collect(q.subject.value)
        if (q.object.termType === 'NamedNode') this.collect(q.object.value)
      }
    }
  }

  private collect(key: string) {
    const n = this.nodes.get(key)
    if (n && this.refusals.size && !n.cls) this.refusals.delete(key)
    if (n && !n.cls && this.referenced.has(key)) this.trackReferences(key, [])
    if (n && !n.cls && n.data === undefined && !n.props.size && !n.attrNodes.size && !n.children.size && !n.parents.size && n.slot === undefined && n.orderKey === undefined && n.island === undefined && n.tag === undefined && n.component === undefined && !n.inputs?.size) {
      this.nodes.delete(key)
      this.chainParent.delete(key)
    }
    const a = this.attrs.get(key)
    if (a && !a.owners.size && a.name === undefined && a.value === undefined) this.attrs.delete(key)
    const i = this.inputNodes.get(key)
    if (i && !i.owners.size && i.name === undefined && i.value === undefined && i.as === undefined) this.inputNodes.delete(key)
  }

  /** Register a consumer of changes; call the result to take what changed since the last call. */
  consumer(): () => Dirty {
    let mine = newDirty()
    this.consumers.add(mine)
    return () => {
      const d = mine
      this.consumers.delete(d)
      this.consumers.add((mine = newDirty()))
      return d
    }
  }

  rootOf(focus: string): string | undefined {
    return this.rootByFocus.get(focus)
  }

  focusOf(root: string): string | undefined {
    return this.focusByRoot.get(root)
  }

  /**
   * Whether a component instance is shown: its placement can be followed up
   * to one of `roots` without passing an element marked hidden.
   */
  /**
   * Walk up from a focus through what places it (its parent elements, the component
   * that rendered them, ordering chains) and return the first answer `ask` gives.
   */
  nearest<T>(focus: string, ask: (key: string) => T | undefined): T | undefined {
    const seen = new Set<string>()
    const todo = [focus]
    while (todo.length) {
      const key = todo.shift()!
      if (seen.has(key)) continue
      seen.add(key)
      const answer = ask(key)
      if (answer !== undefined) return answer
      const placedAs = this.focusByRoot.get(key)
      if (placedAs !== undefined) todo.push(placedAs)
      const n = this.nodes.get(key)
      if (n) todo.push(...n.parents)
      const chained = this.chainParent.get(key)
      if (chained !== undefined) todo.push(chained)
      const aside = this.asideIn.get(key)
      if (aside) todo.push(...aside)
    }
    return undefined
  }

  isShown(focus: string, roots: ReadonlySet<string>): boolean {
    this.seen.clear()
    return this.shownFrom(focus, roots)
  }

  /** The keys an isShown walk has visited (one walk at a time; reused). */
  private seen = new Set<string>()

  /**
   * Whether a focus would be shown were these components shown (what a choice would show:
   * sem:OnIntent, sem:anticipates): under one of them, and nothing hidden between, as an inner
   * switch's other cases are.
   */
  shownUnder(focus: string, contents: ReadonlySet<string>): boolean {
    this.seen.clear()
    return this.underFrom(focus, contents)
  }

  private underFrom(key: string, contents: ReadonlySet<string>): boolean {
    if (contents.has(key)) return true
    if (this.seen.has(key)) return false
    this.seen.add(key)
    // A content's own root is hidden while its case is not chosen: reaching it is enough.
    const placedAs = this.focusByRoot.get(key)
    if (placedAs !== undefined && contents.has(placedAs)) return true
    const n = this.nodes.get(key)
    if (n?.props.has('hidden')) return false
    if (placedAs !== undefined && this.underFrom(placedAs, contents)) return true
    if (n) for (const p of n.parents) if (this.underFrom(p, contents)) return true
    for (const p of this.asideIn.get(key) ?? []) if (this.underFrom(p, contents)) return true
    const chained = this.chainParent.get(key)
    return chained !== undefined && this.underFrom(chained, contents)
  }

  private shownFrom(key: string, roots: ReadonlySet<string>): boolean {
    if (roots.has(key)) return true
    if (this.seen.has(key)) return false
    this.seen.add(key)
    const n = this.nodes.get(key)
    if (n?.props.has('hidden')) return false
    const placedAs = this.focusByRoot.get(key)
    if (placedAs !== undefined && this.shownFrom(placedAs, roots)) return true
    if (n) for (const p of n.parents) if (this.shownFrom(p, roots)) return true
    const chained = this.chainParent.get(key)
    return chained !== undefined && this.shownFrom(chained, roots)
  }

  /** The renderable node for a child slot: component instances resolve to their root. */
  /**
   * The nodes that list this one as a child: its own parents and, for a component's root, the
   * parents of the component it renders (and of what renders that, up a chain of roots).
   */
  placedUnder(key: string): string[] {
    const out: string[] = []
    for (let k: string | undefined = key, hops = 0; k !== undefined && hops < 64; hops++, k = this.focusByRoot.get(k)) {
      const n = this.nodes.get(k)
      if (n) out.push(...n.parents)
    }
    return out
  }

  resolve(key: string): string | undefined {
    for (let k: string | undefined = key, hops = 0; k !== undefined && hops < 64; hops++) {
      if (this.nodes.get(k)?.cls) return k
      k = this.rootByFocus.get(k)
    }
    return undefined
  }

  tagName(key: string): string | undefined {
    const n = this.nodes.get(key)
    const cls = n?.cls
    if (!cls || cls === 'Text') return undefined
    if (this.policy && this.isRefused(key)) return REFUSED_TAG
    // A hosted component created as a custom element (ext:tag on a node that is not an island's slot).
    if (n.tag !== undefined && n.island === undefined && isCustomElementName(n.tag)) {
      if (!this.policy || allowsCustomElement(this.policy, n.tag)) return n.tag
      this.refuse(key, 'element', `custom element ${n.tag} is not allowed in authored content; rendered as its element`)
    }
    return this.tagOf(cls)
  }

  /**
   * The host component that draws a node and everything under it (ext:component), if it is one a
   * host may draw. Whether the host has it is the renderer's question (src/render/hosts.ts).
   */
  hostComponent(key: string): string | undefined {
    const name = this.nodes.get(key)?.component
    if (name === undefined || !this.policy || allowsHostComponent(this.policy, name)) return name
    // Authored content (src/safety.ts): only a host component the policy lists.
    this.refuse(key, 'element', `host component ${name} is not allowed in authored content; rendered as its element`)
    return undefined
  }

  /** Whether a node is an element of the SVG extension (created in the SVG namespace). */
  isSvg(key: string): boolean {
    return (this.nodes.get(key)?.cls?.startsWith('svg:') ?? false) && !(this.policy && this.isRefused(key))
  }

  isVoid(key: string): boolean {
    const cls = this.nodes.get(key)?.cls
    return cls !== undefined && VOID_ELEMENTS.has(cls) && !(this.policy && this.isRefused(key))
  }

  /** Ordered child slots (unresolved), including chain-derived children. */
  childrenOf(parent: string): string[] {
    const n = this.nodes.get(parent)
    if (!n || !n.children.size) return []
    // A refused element is rendered empty: what it holds is not shown.
    if (this.policy && this.isRefused(parent)) return []
    const all = new Set(n.children)
    const todo = [...all]
    while (todo.length) {
      const a = todo.pop()!
      for (const edges of [this.immediate, this.strict]) {
        for (const b of edges.get(a) ?? []) {
          if (all.has(b)) continue
          // A child ordered next to the node it is in: the node stays out of its own children.
          if (b === parent) {
            this.onError(new OrderingError(parent, `<${a}> is ordered next to its own parent`))
            continue
          }
          all.add(b)
          todo.push(b)
          this.chainParent.set(b, parent)
        }
      }
    }
    // Siblings placed by order key (member-wise rules) are sorted, not linearized.
    if ([...all].every((c) => this.nodes.get(c)?.orderKey !== undefined)) {
      return [...all].sort((a, b) => compareKeys(this.nodes.get(a)!.orderKey!, this.nodes.get(b)!.orderKey!) || (a < b ? -1 : a > b ? 1 : 0))
    }
    try {
      return linearize(parent, all, this.immediate, this.strict)
    } catch (e) {
      this.onError(e as Error)
      return [...all].sort()
    }
  }

  /** Resolved content attributes, sorted by name. Conflicting values are reported. */
  attributes(key: string): [string, string][] {
    const n = this.nodes.get(key)
    if (!n) return []
    if (this.policy && n.cls && this.isRefused(key)) return [[REFUSED_ATTRIBUTE, this.tagOf(n.cls) ?? n.cls]]
    const out = new Map<string, string>()
    const set = (name: string, value: string) => {
      const had = out.get(name)
      if (had !== undefined && had !== value) this.onError(new Error(`<${key}>: conflicting values for ${name}: "${had}" vs "${value}"`))
      else out.set(name, value)
    }
    for (const [name, values] of n.props) for (const v of [...values].sort()) set(name, v)
    for (const a of n.attrNodes) {
      const rec = this.attrs.get(a)
      if (rec?.name === undefined || rec.value === undefined) continue
      // A name that is no attribute name (only an attribute node can have one) would break the markup
      // it is written in, trusted or not.
      if (ATTRIBUTE_NAME.test(rec.name)) set(rec.name, rec.value)
      else this.refuse(key, 'attribute', `"${rec.name}" is not an attribute name`)
    }
    if (this.policy) {
      let names: string[] | undefined
      for (const [name, value] of out) {
        const why = attributeProblem(this.policy, name, value)
        if (why) {
          out.delete(name), this.refuse(key, why.kind, `${name}: ${why.reason}`)
          continue
        }
        // An id reference names only ids of this projection: authored content renders in the host's
        // document, where any other id is the host's.
        const ids = idReferences(this.policy, name, value)
        if (!ids?.length) continue
        ;(names ??= []).push(...ids)
        if (ids.some((id) => !this.ids.has(id))) out.delete(name), this.refuse(key, 'attribute', `${name}: authored content may refer only to its own ids`)
      }
      this.trackReferences(key, names ?? [])
    }
    if (this.urlBase !== undefined) for (const [name, value] of out) if (URL_ATTRIBUTES.has(name)) out.set(name, resolveUrl(value, this.urlBase))
    return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  }

  /**
   * The custom element mounted in an island's slot (ext:tag): a valid custom element name, and under
   * a policy one it lists; anything else is refused (the slot stays its projected element).
   */
  islandTag(key: string): string | undefined {
    const n = this.nodes.get(key)
    const tag = n?.island !== undefined ? n.tag : undefined
    if (tag === undefined) return undefined
    if (!isCustomElementName(tag)) return void this.refuse(key, 'element', `"${tag}" is not a custom element name`)
    if (!this.policy || allowsCustomElement(this.policy, tag)) return tag
    this.refuse(key, 'element', `custom element ${tag} is not allowed in authored content; rendered as its element`)
    return undefined
  }

  /**
   * An island slot's (or a custom element's) current inputs, by name (an input stated twice: the
   * least value by code point). A name that is no attribute name is never handed out; under a policy
   * an attribute input passes the attribute check and a property input must be listed (src/safety.ts).
   */
  islandInputs(key: string): Map<string, IslandInput> {
    const out = new Map<string, IslandInput>()
    for (const i of this.nodes.get(key)?.inputs ?? []) {
      const rec = this.inputNodes.get(i)
      if (rec?.name === undefined || rec.value === undefined) continue
      const had = out.get(rec.name)
      if (had && had.value.value <= rec.value.value) continue
      out.set(rec.name, { name: rec.name, value: rec.value, as: rec.as ?? EXT.Property })
    }
    for (const [name, i] of out) {
      if (!ATTRIBUTE_NAME.test(name)) {
        out.delete(name)
        this.refuse(key, 'attribute', `"${name}" is not an input name`)
        continue
      }
      const why = this.policy && inputProblem(this.policy, name, i.value.value, i.as === EXT.Attribute)
      if (why) out.delete(name), this.refuse(key, why.kind, `${name}: ${why.reason}`)
    }
    return out
  }

  private inputNode(key: string): InputNode {
    let i = this.inputNodes.get(key)
    if (!i) this.inputNodes.set(key, (i = { owners: new Set() }))
    return i
  }

  /** Elements whose class or attributes changed in this delta, to check against the policy. */
  private checking = new Set<string>()

  private mark(field: keyof Dirty, key: string) {
    if (this.policy && (field === 'attrs' || field === 'recreate')) this.checking.add(key)
    for (const c of this.consumers) c[field].add(key)
  }

  // --- delta ingestion ----------------------------------------------------------

  private node(key: string): HNode {
    let n = this.nodes.get(key)
    if (!n) this.nodes.set(key, (n = { props: new Map(), attrNodes: new Set(), children: new Set(), parents: new Set() }))
    return n
  }

  private attr(key: string): AttrNode {
    let a = this.attrs.get(key)
    if (!a) this.attrs.set(key, (a = { owners: new Set() }))
    return a
  }

  private structureChanged(key: string) {
    const n = this.nodes.get(key)
    if (n) for (const p of n.parents) this.mark('children', p)
    const cp = this.chainParent.get(key)
    if (cp) this.mark('children', cp)
  }

  private quad(q: Quad, sign: 1 | -1) {
    const s = q.subject.value
    const p = q.predicate.value
    const o = q.object.value
    switch (p) {
      case RDF_TYPE: {
        const svg = o.startsWith(NS.svg)
        if ((!svg && !o.startsWith(H.ns)) || o === H.Attribute) return
        const n = this.node(s)
        const cls = svg ? 'svg:' + o.slice(NS.svg.length) : o.slice(H.ns.length)
        if (sign > 0) n.cls = cls
        else if (n.cls === cls) n.cls = undefined
        this.mark('recreate', s)
        this.structureChanged(s)
        const focus = this.focusByRoot.get(s)
        if (focus) this.rootChanged(focus)
        return
      }
      case SEM.orderKey:
        single(this.node(s), 'orderKey', o, sign)
        this.structureChanged(s)
        return
      case H.data:
        single(this.node(s), 'data', o, sign)
        this.mark('data', s)
        return
      case H.hasChild:
      case H.childOf: {
        const [parent, child] = p === H.hasChild ? [s, o] : [o, s]
        if (sign > 0) this.node(parent).children.add(child)
        else this.node(parent).children.delete(child)
        if (sign > 0) this.node(child).parents.add(parent)
        else this.node(child).parents.delete(parent)
        this.mark('children', parent)
        this.visibility++
        return
      }
      case ORD.immediatelyPrecedes:
      case ORD.immediatelyFollows:
      case ORD.precedes:
      case ORD.follows: {
        const [a, b] = p === ORD.immediatelyPrecedes || p === ORD.precedes ? [s, o] : [o, s]
        inc(p === ORD.immediatelyPrecedes || p === ORD.immediatelyFollows ? this.immediate : this.strict, a, b, sign)
        this.structureChanged(a)
        this.structureChanged(b)
        return
      }
      case H.attribute: {
        const a = this.attr(o)
        if (sign > 0) a.owners.add(s), this.node(s).attrNodes.add(o)
        else a.owners.delete(s), this.node(s).attrNodes.delete(o)
        this.mark('attrs', s)
        return
      }
      case H.attributeName:
      case H.attributeValue: {
        const a = this.attr(s)
        single(a, p === H.attributeName ? 'name' : 'value', o, sign)
        for (const owner of a.owners) this.mark('attrs', owner)
        return
      }
      case SEM.slot: {
        const n = this.node(s)
        if (n.slot !== undefined) {
          const named = this.slots.get(n.slot)
          named?.delete(s)
          if (named && !named.size) this.slots.delete(n.slot)
        }
        n.slot = sign > 0 ? o : undefined
        if (n.slot !== undefined) (this.slots.get(n.slot) ?? this.slots.set(n.slot, new Set()).get(n.slot)!).add(s)
        this.mark('children', s)
        return
      }
      case EXT.island: {
        const n = this.node(s)
        n.island = sign > 0 ? o : n.island === o ? undefined : n.island
        if (n.island !== undefined) this.islandSlots.add(s)
        else this.islandSlots.delete(s)
        this.mark('islands', s)
        return
      }
      case EXT.tag: {
        const n = this.node(s)
        n.tag = sign > 0 ? o : n.tag === o ? undefined : n.tag
        this.mark('islands', s)
        // Not an island's slot: the tag is the element's own, which is created anew.
        if (n.island === undefined) this.mark('recreate', s), this.structureChanged(s)
        return
      }
      case EXT.component: {
        const n = this.node(s)
        n.component = sign > 0 ? o : n.component === o ? undefined : n.component
        // Drawn by a host library, or no longer: the node's element is made anew.
        this.mark('recreate', s)
        this.structureChanged(s)
        return
      }
      case EXT.input: {
        const n = this.node(s)
        const i = this.inputNode(o)
        if (sign > 0) (n.inputs ??= new Set()).add(o), i.owners.add(s)
        else n.inputs?.delete(o), i.owners.delete(s)
        this.mark('islands', s)
        return
      }
      case EXT.name:
      case EXT.value:
      case EXT.as: {
        const i = this.inputNode(s)
        if (p === EXT.value) i.value = sign > 0 ? q.object : i.value?.equals(q.object) ? undefined : i.value
        else if (p === EXT.name) i.name = sign > 0 ? o : i.name === o ? undefined : i.name
        else i.as = sign > 0 ? o : i.as === o ? undefined : i.as
        for (const owner of i.owners) this.mark('islands', owner)
        return
      }
      case SEM.setsAside: {
        let holders = this.asideIn.get(o)
        if (sign > 0) {
          if (!holders) this.asideIn.set(o, (holders = new Set()))
          holders.add(s)
        } else if (holders) {
          holders.delete(s)
          if (!holders.size) this.asideIn.delete(o)
        }
        this.visibility++
        return
      }
      case SEM.renders:
        this.visibility++
        if (sign > 0) this.rootByFocus.set(o, s), this.focusByRoot.set(s, o)
        else if (this.rootByFocus.get(o) === s) this.rootByFocus.delete(o), this.focusByRoot.delete(s)
        this.rootChanged(o)
        return
      default: {
        if (!p.startsWith(H.ns)) return
        const name = ATTRIBUTE_NAMES[p.slice(H.ns.length)]
        if (!name) return
        if (name === 'hidden') this.visibility++
        inc(this.node(s).props, name, o, sign)
        this.mark('attrs', s)
      }
    }
  }

  private rootChanged(focus: string) {
    this.mark('roots', focus)
    this.structureChanged(focus)
  }
}
