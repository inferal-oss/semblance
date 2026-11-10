// The browser entry: load a store (only the chosen store's WASM is fetched), render into the DOM,
// or mount a component graph in one call.

export { createStore, hasStore, initWeb, loadStore, loadStoreWithOntology, ontologySources, type StoreKind } from './load.ts'
export { DomRenderer } from '../render/dom.ts'
export { isApple, markPlatform, PLATFORM_ATTRIBUTE } from './platform.ts'
export { scriptURL, TRUSTED_TYPES_POLICY } from './trusted-types.ts'
export { DEFAULT_LAYERS, mount, type MountedApp, type MountOptions } from './mount.ts'
export { attachConnectors, type ConnectorHost } from './connectors.ts'
export { attachSnaps, type SnapHost } from './snap.ts'
export { attachLightboxes, type LightboxHost } from './lightbox.ts'
