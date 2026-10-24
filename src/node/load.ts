import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as ox from 'oxigraph'
import { engineStore } from '../../rdf-engine/host/store.ts'
import { ONTOLOGY_FILES } from '../ontology.ts'
import { hybridStore } from '../store/hybrid.ts'
import { n3Store } from '../store/n3.ts'
import { oxigraphStore } from '../store/oxigraph.ts'
import type { GraphStore } from '../store/types.ts'

/** `rust` and `wat` are the rdf-engine builds (`npm run engine:build`), Node only for now. */
export type StoreKind = 'oxigraph' | 'n3' | 'hybrid' | 'rust' | 'wat'

const ontologyDir = fileURLToPath(new URL('../../ontology/', import.meta.url))

const engines = new Map<string, WebAssembly.Module>()

function engine(kind: 'rust' | 'wat'): GraphStore {
  let module = engines.get(kind)
  if (!module) {
    const path = fileURLToPath(new URL(`../../rdf-engine/build/${kind}.wasm`, import.meta.url))
    if (!existsSync(path)) throw new Error(`No ${kind} engine build at ${path}; run \`npm run engine:build\``)
    engines.set(kind, (module = new WebAssembly.Module(readFileSync(path))))
  }
  // SEMBLANCE_ENGINE_COMPILE=n: compile each prepared query on its n-th run (rdf-engine/results/compiled.md).
  return engineStore(module, kind, { compile: Number(process.env.SEMBLANCE_ENGINE_COMPILE ?? 0) || 0 })
}

let created: ((store: GraphStore) => void) | undefined

/**
 * Hear about every store created from now on (undefined: stop). The test setup uses it to dispose
 * each test's stores after it: Oxigraph's share one capped WebAssembly memory that garbage
 * collection does not see.
 */
export function watchStores(listener: ((store: GraphStore) => void) | undefined): void {
  created = listener
}

export function createStore(kind: StoreKind): GraphStore {
  const store = kind === 'rust' || kind === 'wat' ? engine(kind) : kind === 'oxigraph' ? oxigraphStore(ox) : kind === 'hybrid' ? hybridStore(ox) : n3Store()
  created?.(store)
  return store
}

export function ontologySources(): string[] {
  return ONTOLOGY_FILES.map((f) => readFileSync(ontologyDir + f, 'utf8'))
}

/** A store with the framework ontologies and the given app data loaded. */
export function loadStore(kind: StoreKind, ...data: string[]): GraphStore {
  const store = createStore(kind)
  for (const ttl of [...ontologySources(), ...data]) store.loadTurtle(ttl)
  return store
}
