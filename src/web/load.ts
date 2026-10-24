import type * as Ox from 'oxigraph'
import init, * as oxWeb from 'oxigraph/web.js'
import { engineStore } from '../../rdf-engine/host/store.ts'
// The engine builds (npm run engine:build); Vite serves them, and the
// single-file build inlines them.
import rustWasm from '../../rdf-engine/build/rust.wasm?url'
import watWasm from '../../rdf-engine/build/wat.wasm?url'
import { ONTOLOGY_FILES } from '../ontology.ts'
import { hybridStore } from '../store/hybrid.ts'
import { n3Store } from '../store/n3.ts'
import { oxigraphStore } from '../store/oxigraph.ts'
import type { GraphStore } from '../store/types.ts'

/** `wat` and `rust` are Semblance's own engines (rdf-engine/): "Semblance WASM" and "Semblance Rust". */
export type StoreKind = 'wat' | 'rust' | 'oxigraph' | 'n3' | 'hybrid'

// The vendored RDF/HTML vocabulary is only read at build time (scripts/gen-rdfhtml-vocab.ts).
const sources = import.meta.glob(['../../ontology/**/*.ttl', '!../../ontology/vendor/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const ox = oxWeb as unknown as typeof Ox

const engines: Partial<Record<'rust' | 'wat', WebAssembly.Module>> = {}

/** Must be awaited once before creating stores. */
export async function initWeb(): Promise<void> {
  // wasm-bindgen locates web_bg.wasm via new URL(..., import.meta.url), which Vite
  // serves in dev and inlines in the single-file build.
  await init()
  const compile = async (url: string) => WebAssembly.compile(await (await fetch(url)).arrayBuffer())
  ;[engines.rust, engines.wat] = await Promise.all([compile(rustWasm), compile(watWasm)])
}

export function createStore(kind: StoreKind): GraphStore {
  if (kind === 'rust' || kind === 'wat') return engineStore(engines[kind]!, kind)
  return kind === 'oxigraph' ? oxigraphStore(ox) : kind === 'hybrid' ? hybridStore(ox) : n3Store()
}

export function ontologySources(): string[] {
  const missing = ONTOLOGY_FILES.filter((f) => sources['../../ontology/' + f] === undefined)
  // Vite's eager glob is fixed when the dev server starts: a file added since is not in it.
  if (missing.length) throw new Error(`Ontology files missing from the bundle: ${missing.join(', ')} (restart the dev server after adding files)`)
  return ONTOLOGY_FILES.map((f) => sources['../../ontology/' + f]!)
}

export function loadStore(kind: StoreKind, ...data: string[]): GraphStore {
  const store = createStore(kind)
  for (const ttl of [...ontologySources(), ...data]) store.loadTurtle(ttl)
  return store
}
