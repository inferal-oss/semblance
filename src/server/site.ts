// A site: what a server or a static build needs to render an app's pages as its client renders
// them first (docs/SSR.md). An app describes itself once (semblance.config.ts) and the build
// (`semblance build`, the Vite plugin), the request handler (`semblance serve`) and renderSite
// all use it.
import type { FnRule } from '../engine/context.ts'
import type { GraphStore } from '../store/types.ts'

export interface Site {
  /** The component the client mounts: the root of the projection. */
  root: string
  /** The app's Turtle (the framework's ontology comes with every store). */
  graphs(): string[] | Promise<string[]>
  /** After the store is loaded, before the address is read (data the host records; `single`: one self-contained file). */
  setup?(store: GraphStore, ctx: { single: boolean }): void
  /** After the address is read, before the first projection: what the client writes there too. */
  prepare?(store: GraphStore): void
  /** The layers the client enables (DEFAULT_LAYERS otherwise). */
  layers?(store: GraphStore): Iterable<string>
  prefer?: 'sparql' | 'function'
  functions?: Record<string, FnRule>
  /** What the client sets on <html> from the graph, besides lang and dir. */
  documentAttributes?(store: GraphStore): Record<string, string>
  /** The addresses to render beforehand: the navigation model's (routesOf) by default; this may change them. */
  routes?(found: string[]): string[]
  /** The store kind (Semblance's WASM engine by default). */
  store?: 'wat' | 'rust' | 'oxigraph' | 'hybrid'
  /** The mount element's id in the page (default "app"). */
  mount?: string
}

/** Type a site description (semblance.config.ts: export default defineSite({...})). */
export function defineSite(site: Site): Site {
  return site
}
