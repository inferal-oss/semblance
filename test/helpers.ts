import type { Quad } from '@rdfjs/types'
import { todoApp } from '../src/examples/todo.ts'
export { todoOps as todo } from '../src/examples/todo.ts'
import type { EngineOptions } from '../src/engine/engine.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { A11Y, MOD, SEM, STY } from '../src/ns.ts'
import { Runtime } from '../src/runtime.ts'
import type { GraphStore } from '../src/store/types.ts'

export const SCREEN_LAYERS = [A11Y.Layer, STY.Layer]
export const ALL_LAYERS = [...SCREEN_LAYERS, SEM.DebugLayer]

const fail = (e: Error) => {
  throw e
}

export function setup(kind: StoreKind, opts: Partial<EngineOptions> = {}, n = 5, extra: string[] = []) {
  const store = loadStore(kind, todoApp(n), ...extra)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: SCREEN_LAYERS, ...opts }, fail)
  return { store, runtime, screen }
}

/** Input (default graph) quads of a store, to rebuild the same state elsewhere. */
export function inputQuads(store: GraphStore): Quad[] {
  return store.match(null, null, null, store.factory.defaultGraph())
}
