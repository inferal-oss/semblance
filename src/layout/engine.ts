// Which twin solves and checks: a WASM build by default, TypeScript as the backup. The platform
// loaders (src/node/load.ts, src/web/load.ts: initLayout) compile the builds that are present and
// hand them here; a missing build, or one that fails to instantiate, falls back to the next kind.
import { checkPacked, type Finding } from './check.ts'
import { Solver, type SolverLike } from './solver.ts'
import { WasmLayout } from './wasm.ts'

/** `wat` and `rust` are the WASM twins (layout-solver/build/), `ts` is src/layout/solver.ts. */
export type LayoutKind = 'wat' | 'rust' | 'ts'

/**
 * The kinds tried, in order, when none is asked for: WAT is as fast as Rust (layout-solver/bench.ts)
 * at a sixth of its size (3.7 KiB gzipped against 24.5), TypeScript the backup.
 */
export const LAYOUT_PREFERENCE: readonly LayoutKind[] = ['wat', 'rust', 'ts']

const modules: Partial<Record<Exclude<LayoutKind, 'ts'>, WebAssembly.Module>> = {}
let checker: { kind: LayoutKind; check(boxes: Float64Array, program: Int32Array): Finding[] } = { kind: 'ts', check: checkPacked }

/** Offer a compiled WASM twin (the platform loaders call it); the checker moves to the preferred one. */
export async function provideLayoutModule(kind: Exclude<LayoutKind, 'ts'>, module: WebAssembly.Module): Promise<void> {
  modules[kind] = module
  const preferred = LAYOUT_PREFERENCE.find((k) => k === 'ts' || modules[k])!
  if (preferred === checker.kind || preferred === 'ts') return
  try {
    const instance = await WasmLayout.instantiate(modules[preferred]!)
    checker = { kind: preferred, check: (b, p) => instance.check(b, p) }
  } catch {
    // keep the checker there is
  }
}

/** The kinds this build can solve with, in order of preference. */
export function layoutKinds(): LayoutKind[] {
  return LAYOUT_PREFERENCE.filter((k) => k === 'ts' || modules[k])
}

/**
 * A new solver: of `kind` if it is offered, else the first offered kind in LAYOUT_PREFERENCE that
 * instantiates, else TypeScript.
 */
export async function createLayoutSolver(kind?: LayoutKind): Promise<{ kind: LayoutKind; solver: SolverLike }> {
  const order = kind ? [kind, ...LAYOUT_PREFERENCE.filter((k) => k !== kind)] : LAYOUT_PREFERENCE
  for (const k of order) {
    if (k === 'ts') return { kind: 'ts', solver: new Solver() }
    const module = modules[k]
    if (!module) continue
    try {
      return { kind: k, solver: await WasmLayout.instantiate(module) }
    } catch {
      // the next kind
    }
  }
  return { kind: 'ts', solver: new Solver() }
}

/** Check packed boxes against a packed program (src/layout/check.ts) with the preferred twin. */
export function checkLayout(boxes: Float64Array, program: Int32Array): Finding[] {
  return checker.check(boxes, program)
}

/** The twin checkLayout runs. */
export function checkerKind(): LayoutKind {
  return checker.kind
}
