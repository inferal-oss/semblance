// Semblance's engine builds as packages of their own (docs/RELEASING.md): @semblance-dev/rdf-engine-wat
// (a dependency) and @semblance-dev/rdf-engine-rust (an optional peer). Each is its WebAssembly, its
// kind and the engine ABI it implements; the host that runs either (rdf-engine/host/) is the core's.
// No run-time imports here: the browser's early engine fetch (src/web/engine.ts) carries this.

/** Semblance's own engines: the store kinds that run an engine build. */
export type EngineKind = 'wat' | 'rust'

/** What an engine package exports. */
export interface EngineBuild {
  /** The store kind that runs it. */
  readonly kind: string
  /** The engine ABI it implements (rdf-engine/ABI.md). */
  readonly abi: number
  /** Its WebAssembly: a file: URL in Node, the asset's URL in a bundle. */
  readonly wasm: URL | string
}

/** The package of each engine build. */
export const ENGINE_PACKAGES: Record<EngineKind, string> = {
  wat: '@semblance-dev/rdf-engine-wat',
  rust: '@semblance-dev/rdf-engine-rust',
}

/**
 * The build, when it is the one asked for and implements the host's ABI (`ABI_VERSION`); otherwise an
 * error that names the package to install. The engine's instance checks its ABI again
 * (`abi_version`), so a build served apart from its package is caught too.
 */
export function checkedBuild(kind: EngineKind, build: EngineBuild, hostAbi: number): EngineBuild {
  const name = ENGINE_PACKAGES[kind]
  if (build.kind !== kind) throw new Error(`${name} is the ${build.kind} engine build, not ${kind}`)
  if (build.abi !== hostAbi) throw new Error(`${name} implements engine ABI ${build.abi}; @semblance-dev/semblance runs ABI ${hostAbi}. Install the version of ${name} that is @semblance-dev/semblance's.`)
  return build
}

/** Whether an import failed because the package is not installed (an optional peer left out). */
export function isMissingPackage(error: unknown, name: string): boolean {
  const e = error as { code?: string; message?: string } | undefined
  return !!e && (e.code === 'ERR_MODULE_NOT_FOUND' || /cannot find|failed to (resolve|load)/i.test(String(e.message))) && String(e.message).includes(name)
}
