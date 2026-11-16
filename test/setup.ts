import { afterAll, afterEach, beforeEach } from 'vitest'
import { watchStores } from '../src/node/load.ts'
import type { GraphStore } from '../src/store/types.ts'
import { type Persistence, watchPersistence } from '../src/persistence.ts'
import { type Sandboxes, watchSandboxes } from '../src/sandbox.ts'

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
// Live examples' sandboxes stop first (their timers, buses and stores), so no rebuild waiting for
// typing to pause runs against a store released here.
const sandboxesOfTest: WeakRef<Sandboxes>[] = []
const sandboxesOfFile: WeakRef<Sandboxes>[] = []
watchSandboxes((s) => (inTest ? sandboxesOfTest : sandboxesOfFile).push(new WeakRef(s)))
const stop = (all: WeakRef<Sandboxes>[]) => {
  for (const s of all.splice(0)) s.deref()?.dispose()
}
// So does persistence: a write waiting for its delay (60 s in the harness) would otherwise run
// against a store released here, in a later test.
const persistenceOfTest: WeakRef<Persistence>[] = []
const persistenceOfFile: WeakRef<Persistence>[] = []
watchPersistence((p) => (inTest ? persistenceOfTest : persistenceOfFile).push(new WeakRef(p)))
const halt = (all: WeakRef<Persistence>[]) => {
  for (const p of all.splice(0)) p.deref()?.stop()
}

beforeEach(() => {
  inTest = true
})
// Then the turn ends. V8 keeps what a WeakRef was made for or deref'd to alive until the microtask
// queue drains (N3's stores make them, and so does this file), and vitest goes from one synchronous
// test to the next in microtasks: without a macrotask between them, every site a file mounts stays
// alive until the file ends (the reference tests reached 4 GB at about 300 MB a test).
afterEach(() => {
  inTest = false
  stop(sandboxesOfTest)
  halt(persistenceOfTest)
  dispose(ofTest)
  return new Promise<void>((resolve) => setImmediate(resolve))
})
afterAll(() => {
  stop(sandboxesOfFile)
  halt(persistenceOfFile)
  dispose(ofFile)
})
