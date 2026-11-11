// Stores of every built-in kind in the browser, and what each needs loaded first, apart from the
// ontology's loader (load.ts): views on their own (src/views/) make their store here without
// pulling the framework's ontology into the bundle.
import type * as Ox from 'oxigraph'
import { createEngineStore, hasEngine, initEngine } from './engine-store.ts'
import { hybridStore } from '../store/hybrid.ts'
import { n3Store } from '../store/n3.ts'
import { oxigraphStore } from '../store/oxigraph.ts'
import { configureFetching, type GraphStore } from '../store/types.ts'
import type { StoreOptions } from './engine-store.ts'

/** `wat` and `rust` are Semblance's own engines (rdf-engine/): "Semblance WASM" and "Semblance Rust". */
export type StoreKind = 'wat' | 'rust' | 'oxigraph' | 'n3' | 'hybrid'

let ox: typeof Ox | undefined

/** Whether this build includes the engine behind a store kind. */
export function hasStore(kind: StoreKind): boolean {
  return kind === 'rust' || kind === 'wat' ? hasEngine(kind) : true
}

/**
 * Load what a store kind needs, and nothing else: Oxigraph's WASM (about 4 MB) only for the
 * Oxigraph and Hybrid stores, an engine build only for its own store. Awaited before createStore
 * of that kind (initWeb does it, with the ontology).
 */
export async function initStore(kind: StoreKind): Promise<void> {
  if (kind === 'oxigraph' || kind === 'hybrid') {
    if (ox) return
    // wasm-bindgen locates web_bg.wasm via new URL(..., import.meta.url), which Vite
    // serves as its own file and inlines in the single-file build.
    const web = await import('oxigraph/web.js')
    await web.default()
    ox = web as unknown as typeof Ox
  } else if (kind === 'rust' || kind === 'wat') await initEngine(kind)
}

export { COMPILE_ON_RUN, type StoreOptions } from './engine-store.ts'

export function createStore(kind: StoreKind, options: StoreOptions = {}): GraphStore {
  if (kind === 'rust' || kind === 'wat') return createEngineStore(kind, options)
  if (kind === 'n3') return configureFetching(n3Store(), options.fetchPolicy)
  if (!ox) throw new Error(`initWeb('${kind}') must be awaited first`)
  return configureFetching(kind === 'oxigraph' ? oxigraphStore(ox) : hybridStore(ox), options.fetchPolicy)
}
