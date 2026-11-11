import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { layoutKinds, provideLayoutModule, type LayoutKind } from '../layout/engine.ts'
import { ONTOLOGY_FILES } from '../ontology.ts'
import { ontologySubset, type Subset, type SubsetOptions } from '../subset.ts'
import type { GraphStore } from '../store/types.ts'
import { createStore, type StoreKind, type StoreOptions } from './stores.ts'

export { COMPILE_ON_RUN, createStore, watchStores, type StoreKind, type StoreOptions } from './stores.ts'

const ontologyDir = fileURLToPath(new URL('../../ontology/', import.meta.url))

/**
 * Compile the layout solver's WASM twins that are built (`npx tsx layout-solver/build.ts`) and offer
 * them to src/layout/engine.ts; the kinds it can now use, TypeScript always last.
 */
export async function initLayout(): Promise<LayoutKind[]> {
  for (const kind of ['wat', 'rust'] as const) {
    const path = fileURLToPath(new URL(`../../layout-solver/build/${kind}.wasm`, import.meta.url))
    if (!existsSync(path)) continue
    try {
      await provideLayoutModule(kind, await WebAssembly.compile(readFileSync(path)))
    } catch {
      // not offered: the engine falls back
    }
  }
  return layoutKinds()
}

export function ontologySources(): string[] {
  return ONTOLOGY_FILES.map((f) => readFileSync(ontologyDir + f, 'utf8'))
}

/** The framework's ontology files by name (`ontology/<file>`), in load order: a page may load some of them first. */
export function ontologyFiles(): Record<string, string> {
  return Object.fromEntries(ONTOLOGY_FILES.map((f) => ['ontology/' + f, readFileSync(ontologyDir + f, 'utf8')]))
}

/** A store with only some of the framework's ontology files (by name, as ontologyFiles has them) and the given app data. */
export function loadStoreOf(kind: StoreKind, ontology: Iterable<string>, ...data: string[]): GraphStore {
  const store = createStore(kind)
  const wanted = new Set(ontology)
  for (const f of ONTOLOGY_FILES) if (wanted.has('ontology/' + f)) store.loadTurtle(readFileSync(ontologyDir + f, 'utf8'))
  for (const ttl of data) store.loadTurtle(ttl)
  return store
}

/** A store with the framework ontologies and the given app data loaded. */
export function loadStore(kind: StoreKind, ...data: string[]): GraphStore {
  return loadStoreWith(kind, {}, ...data)
}

/** loadStore, with store options. */
export function loadStoreWith(kind: StoreKind, options: StoreOptions, ...data: string[]): GraphStore {
  const store = createStore(kind, options)
  for (const ttl of [...ontologySources(), ...data]) store.loadTurtle(ttl)
  return store
}

/** The part of the framework's ontology an app's graphs (Turtle) use (src/subset.ts): its `turtle` loads in place of the whole. */
export function appOntology(app: string[], opts: SubsetOptions = {}): Subset {
  return ontologySubset(ontologySources(), app, opts)
}

/** A store with `ontology` (an app's subset: appOntology) in place of the framework's whole ontology, and the given app data. */
export function loadStoreWithOntology(kind: StoreKind, ontology: string, ...data: string[]): GraphStore {
  const store = createStore(kind)
  for (const ttl of [ontology, ...data]) store.loadTurtle(ttl)
  return store
}
