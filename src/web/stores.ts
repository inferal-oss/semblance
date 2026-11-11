// Stores of every built-in kind in the browser, and what each needs loaded first, apart from the
// ontology's loader (load.ts): views on their own (src/views/) make their store here without
// pulling the framework's ontology into the bundle.
import type * as Ox from 'oxigraph'
import { hasEngine, startEngine } from './engine.ts'
import { engineStore } from '../../rdf-engine/host/store.ts'
import { hybridStore } from '../store/hybrid.ts'
import { n3Store } from '../store/n3.ts'
import { oxigraphStore } from '../store/oxigraph.ts'
import { configureFetching, type FetchPolicy, type GraphStore } from '../store/types.ts'

/** `wat` and `rust` are Semblance's own engines (rdf-engine/): "Semblance WASM" and "Semblance Rust". */
export type StoreKind = 'wat' | 'rust' | 'oxigraph' | 'n3' | 'hybrid'

let ox: typeof Ox | undefined
const engines: Partial<Record<'rust' | 'wat', WebAssembly.Module>> = {}

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
  } else if (kind === 'rust' || kind === 'wat') {
    if (engines[kind]) return
    // The engine builds are fetched only for the store in use (a host may have started it already).
    engines[kind] = await startEngine(kind)
  }
}

/** Store options (benchmark configurations choose them; the defaults are the site's). */
export interface StoreOptions {
  /**
   * Semblance's engines: run prepared SPARQL queries compiled to WebAssembly (rdf-engine/ABI.md):
   * true compiles a query on its second run, 'idle' the most-run ones in idle time.
   */
  compiled?: boolean | 'idle'
  /** Semblance's engines: the time zone sx:formatDateTime uses when its options name none (default: the host's). */
  timeZone?: string
  /**
   * Semblance's engines: what `store.query` and `store.update` may fetch for SERVICE and LOAD
   * (docs/FETCHING.md; default: nothing). The other stores do not fetch, and refuse one.
   */
  fetchPolicy?: FetchPolicy
}

/** Compiled queries: a prepared query is compiled on its second run with the same variables bound. */
export const COMPILE_ON_RUN = 2

export function createStore(kind: StoreKind, options: StoreOptions = {}): GraphStore {
  if (kind === 'rust' || kind === 'wat') {
    const module = engines[kind]
    if (!module) throw new Error(`initWeb('${kind}') must be awaited first`)
    return engineStore(module, kind, { compile: options.compiled === 'idle' ? 'idle' : options.compiled ? COMPILE_ON_RUN : 0, timeZone: options.timeZone, fetchPolicy: options.fetchPolicy })
  }
  if (kind === 'n3') return configureFetching(n3Store(), options.fetchPolicy)
  if (!ox) throw new Error(`initWeb('${kind}') must be awaited first`)
  return configureFetching(kind === 'oxigraph' ? oxigraphStore(ox) : hybridStore(ox), options.fetchPolicy)
}
