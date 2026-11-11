// Semblance's own engines as stores in the browser: the engine build fetched and compiled once
// (engine.ts), then a store over it. Apart from the other kinds (stores.ts), so a page that only
// needs the engine - views on their own (src/views/web.ts) - carries no other store's code.
import { engineStore } from '../../rdf-engine/host/store.ts'
import type { FetchPolicy, GraphStore } from '../store/types.ts'
import { hasEngine, startEngine } from './engine.ts'

export { hasEngine }

const engines: Partial<Record<'rust' | 'wat', WebAssembly.Module>> = {}

/** Fetch and compile an engine build, once (a host may have started it already: startEngine). */
export async function initEngine(kind: 'wat' | 'rust'): Promise<void> {
  engines[kind] ??= await startEngine(kind)
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

/** A store over an engine build initEngine (or initWeb) has loaded. */
export function createEngineStore(kind: 'wat' | 'rust', options: StoreOptions = {}): GraphStore {
  const module = engines[kind]
  if (!module) throw new Error(`initWeb('${kind}') must be awaited first`)
  return engineStore(module, kind, { compile: options.compiled === 'idle' ? 'idle' : options.compiled ? COMPILE_ON_RUN : 0, timeZone: options.timeZone, fetchPolicy: options.fetchPolicy })
}
