import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as ox from 'oxigraph'
import { ONTOLOGY_FILES } from '../ontology.ts'
import { hybridStore } from '../store/hybrid.ts'
import { n3Store } from '../store/n3.ts'
import { oxigraphStore } from '../store/oxigraph.ts'
import type { GraphStore } from '../store/types.ts'

export type StoreKind = 'oxigraph' | 'n3' | 'hybrid'

const ontologyDir = fileURLToPath(new URL('../../ontology/', import.meta.url))

export function createStore(kind: StoreKind): GraphStore {
  return kind === 'oxigraph' ? oxigraphStore(ox) : kind === 'hybrid' ? hybridStore(ox) : n3Store()
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
