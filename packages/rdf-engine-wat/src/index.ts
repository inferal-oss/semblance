// @semblance-dev/rdf-engine-wat in this repository: the build `npm run engine:build` writes to
// rdf-engine/build/. The package's own module (lib/index.js, written by scripts/build-package.ts)
// exports the same names, its ABI a literal and its WebAssembly beside it (docs/RELEASING.md).
export { ABI_VERSION as abi } from '../../../rdf-engine/host/engine.ts'

/** Which build this is: the store kind that runs it. */
export const kind = 'wat'

/** The build's WebAssembly: a file: URL in Node, the asset's URL in a bundle. */
export const wasm: URL = new URL('../../../rdf-engine/build/wat.wasm', import.meta.url)
