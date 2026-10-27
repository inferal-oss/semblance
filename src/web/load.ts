import type * as Ox from 'oxigraph'
import { engineStore } from '../../rdf-engine/host/store.ts'
import { layoutKinds, provideLayoutModule, type LayoutKind } from '../layout/engine.ts'
import { ONTOLOGY_FILES } from '../ontology.ts'
import { hybridStore } from '../store/hybrid.ts'
import { n3Store } from '../store/n3.ts'
import { oxigraphStore } from '../store/oxigraph.ts'
import type { GraphStore } from '../store/types.ts'

/** `wat` and `rust` are Semblance's own engines (rdf-engine/): "Semblance WASM" and "Semblance Rust". */
export type StoreKind = 'wat' | 'rust' | 'oxigraph' | 'n3' | 'hybrid'

// The vendored RDF/HTML vocabulary is only read at build time (scripts/gen-rdfhtml-vocab.ts).
const sources = import.meta.glob(['../../ontology/**/*.ttl', '!../../ontology/vendor/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

// The engine builds (npm run engine:build), as URLs fetched only for the store in use;
// a build that is missing is simply not offered.
const engineUrls = import.meta.glob('../../rdf-engine/build/*.wasm', { query: '?url', import: 'default' }) as Record<string, () => Promise<string>>

let ox: typeof Ox | undefined
const engines: Partial<Record<'rust' | 'wat', WebAssembly.Module>> = {}

/** Whether this build includes the engine behind a store kind. */
export function hasStore(kind: StoreKind): boolean {
  return kind === 'rust' || kind === 'wat' ? `../../rdf-engine/build/${kind}.wasm` in engineUrls : true
}

/**
 * Load what a store kind needs, and nothing else: Oxigraph's WASM (about 4 MB) only
 * for the Oxigraph and Hybrid stores, an engine build only for its own store.
 * Must be awaited before creating that kind of store.
 */
export async function initWeb(kind: StoreKind): Promise<void> {
  if (kind === 'oxigraph' || kind === 'hybrid') {
    if (ox) return
    // wasm-bindgen locates web_bg.wasm via new URL(..., import.meta.url), which Vite
    // serves as its own file and inlines in the single-file build.
    const web = await import('oxigraph/web.js')
    await web.default()
    ox = web as unknown as typeof Ox
  } else if (kind === 'rust' || kind === 'wat') {
    if (engines[kind]) return
    const url = engineUrls[`../../rdf-engine/build/${kind}.wasm`]
    if (!url) throw new Error(`The ${kind} engine is not in this build (npm run engine:build)`)
    const response = fetch(await url())
    // Compiled while it streams where the server sends application/wasm.
    engines[kind] = await WebAssembly.compileStreaming(response).catch(async () => WebAssembly.compile(await (await response).arrayBuffer()))
  }
}

// The layout solver's WASM twins (layout-solver/build.ts), fetched only when initLayout is called.
const layoutUrls = import.meta.glob('../../layout-solver/build/*.wasm', { query: '?url', import: 'default' }) as Record<string, () => Promise<string>>

/**
 * Compile the layout solver's WASM twins in this build and offer them to src/layout/engine.ts; the
 * kinds it can now use, TypeScript always last (a build that fails to load is skipped).
 */
export async function initLayout(): Promise<LayoutKind[]> {
  for (const kind of ['wat', 'rust'] as const) {
    const url = layoutUrls[`../../layout-solver/build/${kind}.wasm`]
    if (!url) continue
    try {
      const response = fetch(await url())
      await provideLayoutModule(kind, await WebAssembly.compileStreaming(response).catch(async () => WebAssembly.compile(await (await response).arrayBuffer())))
    } catch {
      // not offered: the engine falls back
    }
  }
  return layoutKinds()
}

/** Store options (benchmark configurations choose them; the defaults are the site's). */
export interface StoreOptions {
  /**
   * Semblance's engines: run prepared SPARQL queries compiled to WebAssembly (rdf-engine/ABI.md):
   * true compiles a query on its second run, 'idle' the most-run ones in idle time.
   */
  compiled?: boolean | 'idle'
}

/** Compiled queries: a prepared query is compiled on its second run with the same variables bound. */
export const COMPILE_ON_RUN = 2

export function createStore(kind: StoreKind, options: StoreOptions = {}): GraphStore {
  if (kind === 'rust' || kind === 'wat') {
    const module = engines[kind]
    if (!module) throw new Error(`initWeb('${kind}') must be awaited first`)
    return engineStore(module, kind, { compile: options.compiled === 'idle' ? 'idle' : options.compiled ? COMPILE_ON_RUN : 0 })
  }
  if (kind === 'n3') return n3Store()
  if (!ox) throw new Error(`initWeb('${kind}') must be awaited first`)
  return kind === 'oxigraph' ? oxigraphStore(ox) : hybridStore(ox)
}

export function ontologySources(): string[] {
  const missing = ONTOLOGY_FILES.filter((f) => sources['../../ontology/' + f] === undefined)
  // Vite's eager glob is fixed when the dev server starts: a file added since is not in it.
  if (missing.length) throw new Error(`Ontology files missing from the bundle: ${missing.join(', ')} (restart the dev server after adding files)`)
  return ONTOLOGY_FILES.map((f) => sources['../../ontology/' + f]!)
}

export function loadStore(kind: StoreKind, ...data: string[]): GraphStore {
  return loadStoreWith(kind, {}, ...data)
}

/** loadStore, with store options. */
export function loadStoreWith(kind: StoreKind, options: StoreOptions, ...data: string[]): GraphStore {
  const store = createStore(kind, options)
  for (const ttl of [...ontologySources(), ...data]) store.loadTurtle(ttl)
  return store
}
