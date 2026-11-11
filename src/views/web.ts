// @inferal-oss/semblance/views in the browser (Vite): the views (./index.ts) and the built-in stores,
// without the framework's ontology. openStore fetches only what its kind needs: an engine build, or
// Oxigraph's WASM.
import type { GraphStore } from '../store/types.ts'
import { createStore, initStore, type StoreKind, type StoreOptions } from '../web/stores.ts'
import { createViews, type Views, type ViewsOptions } from './views.ts'

export * from './index.ts'
export type { StoreKind, StoreOptions }

/** A store of a built-in kind (default `wat`, Semblance's own engine), empty: no ontology loaded. */
export async function openStore(kind: StoreKind = 'wat', options: StoreOptions = {}): Promise<GraphStore> {
  await initStore(kind)
  return createStore(kind, options)
}

/** Views over a new store of a built-in kind (openStore), or over the store given. */
export async function openViews(opts: ViewsOptions & { kind?: StoreKind; store?: GraphStore; storeOptions?: StoreOptions } = {}): Promise<Views> {
  return createViews(opts.store ?? (await openStore(opts.kind, opts.storeOptions)), opts)
}
