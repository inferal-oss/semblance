# @semblance-dev/rdf-engine-wat

Semblance's SPARQL engine, the WebAssembly-text build (`rdf-engine/wat/`), the default store of `@semblance-dev/semblance` and a dependency of it: installing the framework installs it.

- `.`: `kind` (`'wat'`), `abi` (the engine ABI it implements, which `@semblance-dev/semblance`
  checks before loading it) and `wasm` (the URL of its WebAssembly: a `file:` URL in Node, the
  asset's URL in a bundle).
- `./wasm`: the WebAssembly itself, for a platform that imports `.wasm` files (a Cloudflare Worker
  gets a compiled `WebAssembly.Module`, which `engineStore` from `@semblance-dev/semblance/server`
  takes).

Its version is always `@semblance-dev/semblance`'s, which pins it exactly. See
<https://semblance.dev> and the repository's `docs/RELEASING.md`
(<https://github.com/inferal-oss/semblance>). Licence: MIT OR Apache-2.0.
