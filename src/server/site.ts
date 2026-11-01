// A site: what a server or a static build needs to render an app's pages as its client renders
// them first (docs/SSR.md). An app describes itself once (semblance.config.ts) and the build
// (`semblance build`, the Vite plugin), the request handler (`semblance serve`) and renderSite
// all use it.
import type { FnRule } from '../engine/context.ts'
import type { GraphStore } from '../store/types.ts'

export interface Site {
  /** The component the client mounts: the root of the projection. */
  root: string
  /**
   * The app's Turtle (the framework's ontology comes with every store): a list, or graphs by name
   * (in load order), of which each page names those its client loads first (pageGraphs).
   */
  graphs(): string[] | Record<string, string> | Promise<string[] | Record<string, string>>
  /**
   * After the store is loaded, before the address is read (data the host records; `single`: one
   * self-contained file; `graphs`: the named graphs loaded, when not all of them are).
   */
  setup?(store: GraphStore, ctx: { single: boolean; graphs?: ReadonlySet<string> }): void
  /**
   * Record in each page the graphs its client needs to render it first (`ontology/<file>` and the
   * names `graphs` gives), checked against the page rendered with all of them (src/server/page-graphs.ts):
   * its client loads those, takes the page over, and loads the rest in idle time.
   */
  pageGraphs?: {
    /** The graphs every page's client loads first anyway (bundled with it). */
    always?: string[]
  }
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
