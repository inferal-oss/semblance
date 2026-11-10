// Server-side rendering, platform-neutral (Node, Deno, workers): render a site's address to HTML or
// a stream, and assemble the document the client takes over (docs/SSR.md). Node's own helpers (a
// static build, a request handler, the Vite plugin) are in '@inferal-oss/semblance/node'.
export { renderToString, readUrl, readyToRender, project, type RenderOptions, type Rendered } from './render.ts'
export { renderToStream, type StreamOptions } from './stream.ts'
export { documentParts, renderDocument, type DocumentOptions } from './document.ts'
export { contentSecurityPolicy, inlineScriptHashes, inlineStyleHashes, scriptHash, TRUSTED_TYPES_POLICY, type CspOptions } from './csp.ts'
export { defineSite, type Site } from './site.ts'
export { warmRenderer, type WarmOptions, type WarmRenderer, type WarmRendered } from './warm.ts'
// The engine's store, over a WebAssembly module the platform hands over (a Worker's .wasm import, Deno's own compile).
export { engineStore, type EngineStoreOptions } from '../../rdf-engine/host/store.ts'
