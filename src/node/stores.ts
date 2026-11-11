// Stores of every built-in kind in Node, apart from the ontology's loader (load.ts): views on
// their own (src/views/) make their store here without reading the framework's ontology.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as ox from 'oxigraph'
import { engineStore } from '../../rdf-engine/host/store.ts'
import { hybridStore } from '../store/hybrid.ts'
import { n3Store } from '../store/n3.ts'
import { oxigraphStore } from '../store/oxigraph.ts'
import { configureFetching, type FetchPolicy, type GraphStore } from '../store/types.ts'

/** `rust` and `wat` are the rdf-engine builds (`npm run engine:build`), Node only for now. */
export type StoreKind = 'oxigraph' | 'n3' | 'hybrid' | 'rust' | 'wat'

const engines = new Map<string, WebAssembly.Module>()

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

function engine(kind: 'rust' | 'wat', options: StoreOptions): GraphStore {
  let module = engines.get(kind)
  if (!module) {
    const path = fileURLToPath(new URL(`../../rdf-engine/build/${kind}.wasm`, import.meta.url))
    if (!existsSync(path)) throw new Error(`No ${kind} engine build at ${path}; run \`npm run engine:build\``)
    engines.set(kind, (module = new WebAssembly.Module(readFileSync(path))))
  }
  // SEMBLANCE_ENGINE_COMPILE=n: compile each prepared query on its n-th run; =idle: in idle time
  // (rdf-engine/results/compiled.md).
  const env = process.env.SEMBLANCE_ENGINE_COMPILE === 'idle' ? 'idle' : Number(process.env.SEMBLANCE_ENGINE_COMPILE ?? 0) || 0
  return engineStore(module, kind, { compile: options.compiled === 'idle' ? 'idle' : options.compiled ? COMPILE_ON_RUN : env, timeZone: options.timeZone, fetchPolicy: options.fetchPolicy })
}

let created: ((store: GraphStore) => void) | undefined

/**
 * Hear about every store created from now on (undefined: stop). The test setup uses it to dispose
 * each test's stores after it: Oxigraph's share one capped WebAssembly memory that garbage
 * collection does not see.
 */
export function watchStores(listener: ((store: GraphStore) => void) | undefined): void {
  created = listener
}

export function createStore(kind: StoreKind, options: StoreOptions = {}): GraphStore {
  const store = kind === 'rust' || kind === 'wat' ? engine(kind, options) : configureFetching(kind === 'oxigraph' ? oxigraphStore(ox) : kind === 'hybrid' ? hybridStore(ox) : n3Store(), options.fetchPolicy)
  created?.(store)
  return store
}
