// Semblance's engine builds for the browser, apart from the rest of the loader (load.ts, which
// carries the whole ontology): a host can start fetching and compiling the engine as its first module
// runs (startEngine), in parallel with the bundles, instead of after them; initWeb then takes the same
// compilation. Each build is a package of its own (src/store/engine-build.ts), a chunk of its own here.
import { ENGINE_PACKAGES, type EngineBuild, type EngineKind } from '../store/engine-build.ts'

// The wat build is a dependency of the package, so every bundle can have it. The rust build is an
// optional peer: a bundle has it only when the app adds it (addEngine), so an app that never asks for
// it neither installs nor bundles it.
const builds: Partial<Record<EngineKind, () => Promise<EngineBuild>>> = {
  wat: () => import('../store/engines/wat.ts'),
}
const loading = new Map<EngineKind, Promise<EngineBuild>>()
const compiling = new Map<EngineKind, Promise<WebAssembly.Module>>()

/**
 * Make an engine build available to this page's stores, from its package:
 * `addEngine('rust', () => import('@semblance-dev/rdf-engine-rust'))` once the app has installed it.
 * The import becomes a chunk of its own; the build's WebAssembly is fetched when a store of its kind
 * is made (or startEngine).
 */
export function addEngine(kind: EngineKind, load: () => Promise<EngineBuild>): void {
  builds[kind] = load
  loading.delete(kind)
  compiling.delete(kind)
}

/** Whether this build includes an engine build. */
export function hasEngine(kind: EngineKind): boolean {
  return builds[kind] !== undefined
}

/** The package of an engine build, imported once. */
export function engineBuild(kind: EngineKind): Promise<EngineBuild> {
  let p = loading.get(kind)
  if (!p) {
    const load = builds[kind]
    if (!load) return Promise.reject(new Error(`The ${kind} engine is not in this build: install ${ENGINE_PACKAGES[kind]} and call addEngine('${kind}', () => import('${ENGINE_PACKAGES[kind]}'))`))
    loading.set(kind, (p = load()))
  }
  return p
}

/** Fetch and compile an engine build, once: compiled while it streams where the server sends application/wasm. */
export function startEngine(kind: EngineKind): Promise<WebAssembly.Module> {
  let p = compiling.get(kind)
  if (!p) {
    p = engineBuild(kind).then(({ wasm }) => {
      const response = fetch(wasm)
      return WebAssembly.compileStreaming(response).catch(async () => WebAssembly.compile(await (await response).arrayBuffer()))
    })
    compiling.set(kind, p)
  }
  return p
}
