# @semblance-dev/rdf-engine-rust

Semblance's SPARQL engine, the build from Rust (`rdf-engine/rust/`), with the same results as `@semblance-dev/rdf-engine-wat`. It is an optional peer of `@semblance-dev/semblance`: install it to use the `rust` store (`npm install @semblance-dev/rdf-engine-rust`). In Node the framework uses it once it is installed; a page adds it with `addEngine('rust', () => import('@semblance-dev/rdf-engine-rust'))` from `@semblance-dev/semblance/web`.

- `.`: `kind` (`'rust'`), `abi` (the engine ABI it implements, which `@semblance-dev/semblance`
  checks before loading it) and `wasm` (the URL of its WebAssembly: a `file:` URL in Node, the
  asset's URL in a bundle).
- `./wasm`: the WebAssembly itself, for a platform that imports `.wasm` files (a Cloudflare Worker
  gets a compiled `WebAssembly.Module`, which `engineStore` from `@semblance-dev/semblance/server`
  takes).

Its version is always `@semblance-dev/semblance`'s, which pins it exactly. See
<https://semblance.dev> and the repository's `docs/RELEASING.md`
(<https://github.com/inferal-oss/semblance>). Licence: MIT OR Apache-2.0.
