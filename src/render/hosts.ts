// Host components (docs/HOSTED.md): a component library draws the components a projection names.
//
// A hosted component's root carries ext:component, the name of the host component that draws it
// (ontology/layers/foreign.ttl). A renderer given a host adapter hands the first such node on a path
// from its root to the adapter, in a <sem-host> element of its own (display: contents, no role), and
// the adapter draws that node and everything under it: nested hosted nodes are children in the
// library's own tree, plain RDF/HTML nodes its elements. The DOM patcher (DomRenderer), the HTML
// serializer (toHTML) and server rendering go through the same adapter, so a page rendered on the
// server is taken over by the library's hydration.
import type { EventBus, Handled } from '../behaviour/events.ts'
import type { Projection, Runtime } from '../runtime.ts'
import type { HtmlIndex } from './html-index.ts'

/** The element a host library draws in: placed, moved and removed by the renderer, its content the adapter's. */
export const HOST_ELEMENT = 'sem-host'

/** What a host adapter drew in one <sem-host> element. */
export interface HostMount {
  /** Stop drawing (the node left the page or is drawn otherwise now). */
  destroy(): void
}

export interface HostAdapter {
  /** Whether the adapter draws the host component of this name. */
  has(name: string): boolean
  /**
   * Draw node `key` and everything under it in `container`; with `hydrate`, the container holds
   * what `html(key)` wrote on the server, which is taken over rather than drawn again.
   */
  mount(container: Element, key: string, hydrate: boolean): HostMount
  /** Node `key` and everything under it as HTML (server rendering). */
  html(key: string): string
  /** After each patch of the renderer: draw again exactly the nodes that changed in the index. */
  patch(): void
  /** The index node a DOM node the adapter drew stands for (events, focus). */
  keyOf(node: Node): string | undefined
  /** The DOM node the adapter drew for an index node, if any. */
  nodeOf(key: string): Node | undefined
  /** Stop drawing everywhere (the app is unmounted). */
  dispose(): void
}

/** What a host adapter is made with. */
export interface HostContext {
  /** The runtime and projection the index is of: where a component's declared outputs (ext:output) are read. */
  runtime?: Runtime
  projection?: Projection
  /** The event bus, in the browser: outputs become events through it. Set once it exists (outputs before then are dropped). */
  bus?: EventBus
  /** After an output's event was handled (to patch the page). */
  onHandled?: (h: Handled) => void
}

/** Makes a host adapter for a projection's index: what `mount({ hosts })` and `defineSite({ hosts })` take. */
export type HostRenderer = (index: HtmlIndex, ctx: HostContext) => HostAdapter

/** The host component a node is drawn by, if the adapter has it. */
export function hostedBy(index: HtmlIndex, hosts: HostAdapter | undefined, key: string): string | undefined {
  if (!hosts) return undefined
  const name = index.hostComponent(key)
  return name !== undefined && hosts.has(name) ? name : undefined
}
