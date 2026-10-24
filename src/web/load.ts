import type * as Ox from 'oxigraph'
import init, * as oxWeb from 'oxigraph/web.js'
import { ONTOLOGY_FILES } from '../ontology.ts'
import { hybridStore } from '../store/hybrid.ts'
import { n3Store } from '../store/n3.ts'
import { oxigraphStore } from '../store/oxigraph.ts'
import type { GraphStore } from '../store/types.ts'

export type StoreKind = 'oxigraph' | 'n3' | 'hybrid'

// The vendored RDF/HTML vocabulary is only read at build time (scripts/gen-rdfhtml-vocab.ts).
const sources = import.meta.glob(['../../ontology/**/*.ttl', '!../../ontology/vendor/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const ox = oxWeb as unknown as typeof Ox

/** Must be awaited once before creating Oxigraph-backed stores. */
export async function initWeb(): Promise<void> {
  // wasm-bindgen locates web_bg.wasm via new URL(..., import.meta.url), which Vite
  // serves in dev and inlines in the single-file build.
  await init()
}

export function createStore(kind: StoreKind): GraphStore {
  return kind === 'oxigraph' ? oxigraphStore(ox) : kind === 'hybrid' ? hybridStore(ox) : n3Store()
}

export function ontologySources(): string[] {
  return ONTOLOGY_FILES.map((f) => sources['../../ontology/' + f]!)
}

export function loadStore(kind: StoreKind, ...data: string[]): GraphStore {
  const store = createStore(kind)
  for (const ttl of [...ontologySources(), ...data]) store.loadTurtle(ttl)
  return store
}
