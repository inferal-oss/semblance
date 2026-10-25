import { afterAll, afterEach, beforeEach } from 'vitest'
import { watchStores } from '../src/node/load.ts'
import type { GraphStore } from '../src/store/types.ts'

// Stores are released when they are done with (GraphStore.dispose): Oxigraph's share one capped
// WebAssembly memory that garbage collection does not see, so a file that mounts the whole site a
// dozen times otherwise fills it ("RuntimeError: unreachable") and slows everything around it.
// A store created during a test is disposed after it; one created outside any test (a file's
// shared fixture) after the file.

// Held weakly: a store a test has let go of is the collector's (an engine store's memory is its own
// WebAssembly instance, freed with it); only stores that need it (dispose) are remembered at all.
let inTest = false
const ofTest: WeakRef<GraphStore>[] = []
const ofFile: WeakRef<GraphStore>[] = []
watchStores((store) => store.dispose && (inTest ? ofTest : ofFile).push(new WeakRef(store)))
const dispose = (stores: WeakRef<GraphStore>[]) => {
  for (const s of stores.splice(0)) s.deref()?.dispose?.()
}

beforeEach(() => {
  inTest = true
})
afterEach(() => {
  inTest = false
  dispose(ofTest)
})
afterAll(() => dispose(ofFile))
