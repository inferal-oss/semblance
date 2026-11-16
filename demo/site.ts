// What the site's host does to the graph before its first projection, shared by the browser
// (main.ts) and the build that renders every page beforehand (semblance.config.ts): the same
// writes in the same order, so the page a server rendered is the page the client renders first,
// node for node (docs/SSR.md). Platform-neutral: the Turtle comes in as text.
import { todoApp } from '../src/examples/todo.ts'
import { NS, SEM, STY } from '../src/ns.ts'
import { isExampleSource, recordSources } from '../src/sources.ts'
import type { GraphStore } from '../src/store/types.ts'
import type { StoreKind } from '../src/web/load.ts'

export const UI = 'https://semblance.dev/demo#'
/** The component the site projects: its mount root. */
export const ROOT = UI + 'shell'

export type CompileMode = 'off' | 'run' | 'idle'
const COMPILES = { off: 'CompileOff', run: 'CompileOnRun', idle: 'CompileIdle' } as const
const STORES: Record<StoreKind, string> = { wat: 'SemblanceWasm', rust: 'SemblanceRust', hybrid: 'Hybrid', oxigraph: 'Oxigraph', n3: 'N3' }
const RULES = { sparql: 'PreferSparql', function: 'PreferFunction' } as const

/** The site's Turtle besides the framework's: the todo example's graph, app.ttl and the gallery (by path, demo/gallery/*.ttl). */
export function siteGraphs(appGraph: string, gallery: Record<string, string>): string[] {
  return [todoApp(5), appGraph, ...Object.keys(gallery).sort().map((p) => gallery[p]!)]
}

/** The examples show their own source, recorded as data (c:SourceText). `gallery` is keyed by demo/gallery/<file>. */
export function recordSiteSources(store: GraphStore, gallery: Record<string, string>, loaded?: ReadonlySet<string>): void {
  recordSources(store, { 'src/examples/todo.ts': todoApp(5), ...siteSources(gallery, loaded) })
}

/** The gallery's example files whose source the site shows (of those loaded, when not all are). */
export function siteSources(gallery: Record<string, string>, loaded?: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries(Object.entries(gallery).filter(([p]) => isExampleSource(p) && (!loaded || loaded.has(p))))
}

/** The graphs every page loads first, bundled with the client: the todo example's and app.ttl. */
export const FIRST_GRAPHS = ['src/examples/todo.ts', 'demo/app.ttl']

/** siteGraphs by name: the todo example's graph, app.ttl, then the gallery's files by path. */
export function siteNamedGraphs(appGraph: string, gallery: Record<string, string>): Record<string, string> {
  return { 'src/examples/todo.ts': todoApp(5), 'demo/app.ttl': appGraph, ...Object.fromEntries(Object.keys(gallery).sort().map((p) => [p, gallery[p]!])) }
}

/**
 * One file (npm run build:single) is one page, opened from anywhere (a file: URL): where we are is
 * carried in the fragment, as it was before paths, not in a path it does not have.
 */
export function carryInFragment(store: GraphStore): void {
  const f = store.factory
  const carried = f.namedNode(NS.nav + 'carriedBy')
  for (const q of store.match(null, carried, f.namedNode(NS.nav + 'Path'), f.defaultGraph())) {
    store.delete(q)
    store.add(f.quad(q.subject, carried, f.namedNode(NS.nav + 'Fragment'), f.defaultGraph()))
  }
}

/** The settings that arrive through the URL's query, as graph state (after the address is read). */
export function prepareSite(store: GraphStore, settings: { kind: StoreKind; prefer: 'sparql' | 'function'; compile: CompileMode }): void {
  const f = store.factory
  const app = f.namedNode(UI + 'app')
  const set = (p: string, value: string) => {
    for (const q of store.match(app, f.namedNode(p), null, f.defaultGraph())) store.delete(q)
    store.add(f.quad(app, f.namedNode(p), f.namedNode(value), f.defaultGraph()))
  }
  set(UI + 'store', UI + STORES[settings.kind])
  set(UI + 'rules', UI + RULES[settings.prefer])
  set(UI + 'compile', UI + COMPILES[settings.compile])
}

/** The layers the site enables (sem:enables on ui:app). */
export function siteLayers(store: GraphStore): Set<string> {
  const f = store.factory
  return new Set(store.match(f.namedNode(UI + 'app'), f.namedNode(SEM.enables), null, f.defaultGraph()).map((q) => q.object.value))
}

/** What the host sets on <html> from the graph: the color scheme's hook (sty:colorScheme on ui:app). */
export function documentAttributes(store: GraphStore): Record<string, string> {
  const f = store.factory
  const scheme = store.match(f.namedNode(UI + 'app'), f.namedNode(STY.colorScheme), null, f.defaultGraph())[0]?.object
  const slug = scheme && store.match(scheme as never, f.namedNode(SEM.slug), null)[0]?.object.value
  return slug ? { 'data-sem-color-scheme': slug } : {}
}
