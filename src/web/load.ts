import { layoutKinds, provideLayoutModule, type LayoutKind } from '../layout/engine.ts'
import { ONTOLOGY_FILES } from '../ontology.ts'
import type { GraphStore } from '../store/types.ts'
import { createStore, initStore, type StoreKind, type StoreOptions } from './stores.ts'

export { COMPILE_ON_RUN, createStore, hasStore, initStore, type StoreKind, type StoreOptions } from './stores.ts'

// The vendored RDF/HTML vocabulary is only read at build time (scripts/gen-rdfhtml-vocab.ts).
// Each file is a chunk of its own, fetched when asked for (loadOntology): a page loads the files it
// needs first, the rest after.
const sourceLoaders = import.meta.glob(['../../ontology/**/*.ttl', '!../../ontology/vendor/**', '!../../ontology/changes/**', '!../../ontology/versions.ttl', '!../../ontology/terms.ttl'], { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>
const sources: Record<string, string> = {}

/** The framework's ontology files by name (`ontology/<file>`), in load order. */
export const ONTOLOGY_NAMES = ONTOLOGY_FILES.map((f) => 'ontology/' + f)

/**
 * Fetch the ontology files named (`ontology/<file>`; every one when none are named), for
 * ontologyText and the stores made after. initWeb fetches all of them unless told not to.
 */
export async function loadOntology(names: Iterable<string> = ONTOLOGY_NAMES): Promise<void> {
  await Promise.all(
    [...names].map(async (name) => {
      const key = '../../' + name
      if (sources[key] !== undefined) return
      const load = sourceLoaders[key]
      // Vite's glob is fixed when the dev server starts: a file added since is not in it.
      if (!load) throw new Error(`Ontology file missing from the bundle: ${name} (restart the dev server after adding files)`)
      sources[key] = await load()
    }),
  )
}

/** An ontology file's text, once fetched (loadOntology). */
export function ontologyText(name: string): string | undefined {
  return sources['../../' + name]
}

/**
 * Load what a store kind needs (initStore) and the framework's ontology. Must be awaited before
 * creating that kind of store.
 */
export async function initWeb(kind: StoreKind, opts: { ontology?: boolean } = {}): Promise<void> {
  // The whole ontology, unless the host loads what a page needs itself (ontology: false).
  const ontology = opts.ontology === false ? undefined : loadOntology()
  await initStore(kind)
  await ontology
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

export function ontologySources(): string[] {
  const missing = ONTOLOGY_FILES.filter((f) => sources['../../ontology/' + f] === undefined)
  if (missing.length) throw new Error(`Ontology files not loaded: ${missing.join(', ')} (await initWeb(kind) or loadOntology() first)`)
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

/** A store with only some of the framework's ontology files (by name, fetched: loadOntology) and the given app data. */
export function loadStoreOf(kind: StoreKind, options: StoreOptions, ontology: Iterable<string>, ...data: string[]): GraphStore {
  const store = createStore(kind, options)
  const wanted = new Set(ontology)
  for (const name of ONTOLOGY_NAMES) {
    if (!wanted.has(name)) continue
    const text = ontologyText(name)
    if (text === undefined) throw new Error(`Ontology file not loaded: ${name} (await loadOntology first)`)
    store.loadTurtle(text)
  }
  for (const ttl of data) store.loadTurtle(ttl)
  return store
}

/** A store with `ontology` (the app's subset of the framework's ontology, built beforehand: src/subset.ts) in place of the whole, and the given app data. */
export function loadStoreWithOntology(kind: StoreKind, options: StoreOptions, ontology: string, ...data: string[]): GraphStore {
  const store = createStore(kind, options)
  for (const ttl of [ontology, ...data]) store.loadTurtle(ttl)
  return store
}
