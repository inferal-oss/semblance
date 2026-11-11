// @inferal-oss/semblance-react: React as the library that draws Semblance's hosted components
// (docs/HOSTED.md). Semblance keeps the data, the state and the behaviour: the graph, the rules that
// project it, the reactions to events. React draws: a class bound to a host component
// (`c:Button rdfs:subClassOf ext:Hosted ; ext:component "Button"`) is drawn by the React component
// registered under that name, with its props, its root's attributes and its projected children.
//
// One React element per index node (`Node` below), memoized and subscribed to its own key: a change
// re-renders the nodes it changed in the index, not the tree. Plain RDF/HTML nodes under a hosted
// one are React's elements too, so hosted components nested in the graph are nested in React's tree
// (context and composition work). Every element React draws is registered with its key, so the
// event bus, focus handling and every reaction see a hosted component as they see any other.
import type { HostAdapter, HostContext, HostMount, HostRenderer, HtmlIndex, OutputBinding } from '@inferal-oss/semblance'
import { emitOutput, hostedBy, inputValue, outputsOf } from '@inferal-oss/semblance'
import {
  type ComponentType,
  createContext,
  createElement,
  memo,
  type ReactNode,
  type Ref,
  useContext,
  useLayoutEffect,
  useSyncExternalStore,
} from 'react'
import { flushSync } from 'react-dom'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { reactAttributes } from './attributes.ts'

export { reactAttributes, styleObject, propName } from './attributes.ts'
export { useRows, useView, values, type Values, type ViewState } from './views.ts'

/** Props React reads itself: never taken from an authored graph. */
const REACT_RESERVED = new Set(['dangerouslySetInnerHTML', 'ref', 'key', 'children', 'suppressHydrationWarning', 'suppressContentEditableWarning'])

/** The root element's attributes in React's naming, with the ref that registers it: spread them on the component's root element. */
export type RootProps = Record<string, unknown> & { ref: Ref<Element> }

/** What a host component receives, besides its declared props (ext:input) and output callbacks (ext:output). */
export interface HostProps {
  /** The component instance's IRI. */
  focus: string
  /** Spread on the root element: ARIA, data-sem-* hooks, class, style, and the ref that tells Semblance which element this is. */
  root: RootProps
  /** The projected children, in order: React elements, hosted components among them. */
  children?: ReactNode
}

export interface ReactHostsOptions {
  /** Host components by the name ext:component gives. */
  components: Record<string, ComponentType<any>>
  /** Wraps every React root the adapter makes (providers: a theme, a router): one per <sem-host>. */
  wrap?: (children: ReactNode) => ReactNode
  /** For server rendering: react-dom/server's renderToString (@inferal-oss/semblance-react/server passes it). */
  renderToString?: (node: ReactNode) => string
  /** A hydration that did not match (a recoverable error React reports). */
  onRecoverableError?: (e: unknown) => void
}

/** React draws the hosted components of a projection: pass it to `mount({ hosts })`. */
export function reactHosts(opts: ReactHostsOptions): HostRenderer & { last?: ReactHosts } {
  const make = ((index: HtmlIndex, ctx: HostContext) => (make.last = new ReactHosts(index, ctx, opts))) as HostRenderer & { last?: ReactHosts }
  return make
}

const Hosts = createContext<ReactHosts | null>(null)

/** One index node, drawn: re-rendered when that node changes, and only then. */
const Node = memo(function Node({ k }: { k: string }): ReactNode {
  const hosts = useContext(Hosts)!
  useSyncExternalStore(hosts.subscriber(k), () => hosts.version(k), () => hosts.version(k))
  useLayoutEffect(() => hosts.reflect(k))
  return hosts.draw(k)
})

/** The adapter (src/render/hosts.ts): what DomRenderer, toHTML and server rendering call. */
export class ReactHosts implements HostAdapter {
  /** Renders of index nodes, mounts and roots, for tests and cost checks. */
  readonly counts = { renders: 0, mounts: 0, hydrations: 0, destroys: 0, outputs: 0 }
  private readonly take: () => { attrs: Set<string>; data: Set<string>; children: Set<string>; recreate: Set<string>; islands: Set<string> }
  private readonly versions = new Map<string, number>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly subscribers = new Map<string, (l: () => void) => () => void>()
  private readonly refs = new Map<string, (el: Element | null) => void>()
  private readonly els = new Map<string, Element>()
  private readonly keys = new WeakMap<Node, string>()
  private readonly roots = new Set<Root>()
  private readonly callbacks = new Map<string, Record<string, (payload: unknown) => void>>()

  constructor(
    readonly index: HtmlIndex,
    private readonly ctx: HostContext,
    private readonly opts: ReactHostsOptions,
  ) {
    this.take = index.consumer()
  }

  has(name: string): boolean {
    return Object.hasOwn(this.opts.components, name)
  }

  private tree(key: string): ReactNode {
    const node = createElement(Node, { k: key })
    return createElement(Hosts.Provider, { value: this }, this.opts.wrap ? this.opts.wrap(node) : node)
  }

  mount(container: Element, key: string, hydrate: boolean): HostMount {
    let root: Root
    if (hydrate) {
      this.counts.hydrations++
      root = hydrateRoot(container, this.tree(key), { onRecoverableError: this.opts.onRecoverableError })
    } else {
      this.counts.mounts++
      root = createRoot(container)
      flushSync(() => root.render(this.tree(key)))
    }
    this.roots.add(root)
    return {
      destroy: () => {
        if (!this.roots.delete(root)) return
        this.counts.destroys++
        // Not while React may be rendering (a patch that runs from a component's own callback).
        queueMicrotask(() => root.unmount())
      },
    }
  }

  html(key: string): string {
    if (!this.opts.renderToString) throw new Error('Server rendering needs renderToString: use reactHosts from @inferal-oss/semblance-react/server')
    return this.opts.renderToString(this.tree(key))
  }

  patch(): void {
    const d = this.take()
    const changed: (() => void)[] = []
    for (const set of [d.attrs, d.data, d.children, d.recreate, d.islands]) {
      for (const k of set) {
        const ls = this.listeners.get(k)
        if (!ls) continue
        this.versions.set(k, (this.versions.get(k) ?? 0) + 1)
        changed.push(...ls)
      }
    }
    if (changed.length) flushSync(() => new Set(changed).forEach((l) => l()))
  }

  keyOf(node: Node): string | undefined {
    return this.keys.get(node)
  }

  nodeOf(key: string): Node | undefined {
    return this.els.get(key)
  }

  dispose(): void {
    for (const root of this.roots) root.unmount()
    this.roots.clear()
  }

  // --- what Node calls ---------------------------------------------------------------------------

  version(k: string): number {
    return this.versions.get(k) ?? 0
  }

  subscriber(k: string): (l: () => void) => () => void {
    let s = this.subscribers.get(k)
    if (!s) {
      s = (l) => {
        const ls = this.listeners.get(k) ?? this.listeners.set(k, new Set()).get(k)!
        ls.add(l)
        return () => {
          ls.delete(l)
          if (!ls.size) this.listeners.delete(k), this.subscribers.delete(k)
        }
      }
      this.subscribers.set(k, s)
    }
    return s
  }

  /** The ref that registers the element drawn for a node (stable, so React does not call it again on each render). */
  private refFor(k: string): (el: Element | null) => void {
    let r = this.refs.get(k)
    if (!r) {
      r = (el) => {
        if (el) {
          this.els.set(k, el)
          this.keys.set(el, k)
        } else {
          this.els.delete(k)
          this.refs.delete(k)
        }
      }
      this.refs.set(k, r)
    }
    return r
  }

  /** A node as a React node: a hosted component, an element, or text. */
  draw(k: string): ReactNode {
    this.counts.renders++
    const index = this.index
    const n = index.nodes.get(k)
    if (!n?.cls) return null
    if (n.cls === 'Text') return n.data ?? ''
    const children = this.children(k)
    const name = hostedBy(index, this, k)
    if (name !== undefined) {
      const tag = index.tagName(k)
      const props: Record<string, unknown> = { ...this.props(k), ...this.outputs(k) }
      props.focus = index.focusOf(k) ?? k
      props.root = { ...reactAttributes(index.attributes(k), tag), ref: this.refFor(k) }
      return createElement(this.opts.components[name]!, props, ...children)
    }
    const tag = index.tagName(k) ?? 'sem-unknown'
    const props: Record<string, unknown> = { ...reactAttributes(index.attributes(k), tag), ref: this.refFor(k) }
    // A custom element's props go with its attributes (React 19 sets a property it has as such).
    if (tag.includes('-') && n.tag === tag) Object.assign(props, this.props(k))
    // A host-owned slot's children are not React's; a void element has none.
    if (n.slot !== undefined || index.isVoid(k)) return createElement(tag, props)
    // React says which option is chosen on the select, not on the option.
    if (tag === 'option') delete props.selected
    if (tag === 'select') props.defaultValue = this.chosen(k)
    // A text area's text is its initial value.
    if (tag === 'textarea') return createElement(tag, { ...props, defaultValue: children.filter((c) => typeof c === 'string').join('') })
    return createElement(tag, props, ...children)
  }

  /** The value of a select's chosen option (its value attribute, else its text). */
  private chosen(k: string): string | undefined {
    for (const slot of this.index.childrenOf(k)) {
      const o = this.index.resolve(slot)
      if (o === undefined) continue
      const attrs = new Map(this.index.attributes(o))
      if (!attrs.has('selected')) continue
      return attrs.get('value') ?? this.index.childrenOf(o).map((c) => this.index.nodes.get(this.index.resolve(c) ?? '')?.data ?? '').join('')
    }
    return undefined
  }

  /** A node's children in order: one keyed Node each (a text node too, so it re-renders on its own). */
  private children(k: string): ReactNode[] {
    const out: ReactNode[] = []
    for (const slot of this.index.childrenOf(k)) {
      const r = this.index.resolve(slot)
      if (r !== undefined) out.push(createElement(Node, { key: r, k: r }))
    }
    return out
  }

  /** The props a hosted node's root states (ext:input), typed, as the index's policy allows them. */
  private props(k: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [name, i] of this.index.islandInputs(k)) if (!this.reserved(name)) out[name] = inputValue(i.value)
    return out
  }

  /** Under a policy (authored content), the names React gives a meaning of its own are never props from the graph. */
  private reserved(name: string): boolean {
    return !!this.index.policy && (REACT_RESERVED.has(name) || /^on/i.test(name))
  }

  /** One callback per output the instance declares (ext:output), stable per instance; it reports through the bus once there is one. */
  private outputs(k: string): Record<string, (payload: unknown) => void> {
    const { runtime, projection } = this.ctx
    const focus = this.index.focusOf(k)
    if (!runtime || !projection || focus === undefined) return {}
    let cbs = this.callbacks.get(focus)
    if (!cbs) {
      const bindings: OutputBinding[] = outputsOf({ runtime, projection }, focus)
      cbs = {}
      for (const on of new Set(bindings.map((b) => b.on))) {
        // A callback the adapter makes is a function of its own, but not one React reads as something else.
        if (this.index.policy && REACT_RESERVED.has(on)) continue
        cbs[on] = (payload: unknown) => {
          const bus = this.ctx.bus
          if (!bus) return
          for (const h of emitOutput(bus, focus, bindings, on, payload)) {
            this.counts.outputs++
            if (h.recorded || h.delta.add.length || h.delta.remove.length) this.ctx.onHandled?.(h)
          }
        }
      }
      this.callbacks.set(focus, cbs)
    }
    return cbs
  }

  /**
   * After a node is drawn: a form control shows the graph's value and checked state (React wrote
   * them as initial ones), as the DOM renderer keeps them in line.
   */
  reflect(k: string): void {
    const el = this.els.get(k) as HTMLInputElement | undefined
    // An option chosen otherwise: its select shows it.
    if (el?.localName === 'option') {
      const select = el.closest('select')
      const key = select && this.keys.get(select)
      return void (key !== undefined && key !== null && this.reflect(key))
    }
    if (el?.localName === 'select') {
      const value = this.chosen(k)
      if (value !== undefined && el.value !== value) el.value = value
      return
    }
    if (!el || (el.localName !== 'input' && el.localName !== 'textarea')) return
    if (el.localName === 'textarea') {
      const text = this.index.childrenOf(k).map((c) => this.index.nodes.get(this.index.resolve(c) ?? '')?.data ?? '').join('')
      if (el.value !== text) el.value = text
      return
    }
    const attrs = new Map(this.index.attributes(k))
    const checked = attrs.has('checked')
    if (el.checked !== checked && (el.type === 'checkbox' || el.type === 'radio')) el.checked = checked
    const value = attrs.get('value') ?? ''
    if (el.value !== value && el.type !== 'checkbox' && el.type !== 'radio') el.value = value
  }
}
