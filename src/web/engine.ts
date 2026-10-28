// Semblance's engine builds (npm run engine:build) for the browser, apart from the rest of the
// loader (load.ts, which carries the whole ontology): a host can start fetching and compiling the
// engine as its first module runs (startEngine), in parallel with the bundles, instead of after
// them; initWeb then takes the same compilation.
const engineUrls = import.meta.glob('../../rdf-engine/build/*.wasm', { query: '?url', import: 'default' }) as Record<string, () => Promise<string>>

const compiling = new Map<string, Promise<WebAssembly.Module>>()

/** Whether this build includes an engine build. */
export function hasEngine(kind: 'wat' | 'rust'): boolean {
  return `../../rdf-engine/build/${kind}.wasm` in engineUrls
}

/** Fetch and compile an engine build, once: compiled while it streams where the server sends application/wasm. */
export function startEngine(kind: 'wat' | 'rust'): Promise<WebAssembly.Module> {
  let p = compiling.get(kind)
  if (!p) {
    const url = engineUrls[`../../rdf-engine/build/${kind}.wasm`]
    if (!url) return Promise.reject(new Error(`The ${kind} engine is not in this build (npm run engine:build)`))
    p = url().then((u) => {
      const response = fetch(u)
      return WebAssembly.compileStreaming(response).catch(async () => WebAssembly.compile(await (await response).arrayBuffer()))
    })
    compiling.set(kind, p)
  }
  return p
}
