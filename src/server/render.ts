// Server-side rendering (docs/SSR.md): a component graph projected and serialized as HTML before
// any script runs, at build time (src/build/) or per request (src/server/handler.ts). The client
// takes the HTML over without rendering it again (DomRenderer.adopt, mount): its first projection,
// from the same graph and address, has the same nodes, so it pairs them with the parsed DOM.
// Platform-neutral: the caller loads the store (src/node/load.ts, src/web/load.ts or its own
// engine module), so this runs in Node, Deno and workers alike.
import type { FnRule } from '../engine/context.ts'
import { Navigation, readLocations, spellAddress, currentValues } from '../navigation.ts'
import { DEFAULT_LAYERS, MOD, NS } from '../ns.ts'
import { toHTML } from '../render/serialize.ts'
import { type Projection, Runtime } from '../runtime.ts'
import type { GraphStore } from '../store/types.ts'
import { compileStyles } from '../style/compile.ts'

export interface RenderOptions {
  /** The loaded store: the framework's ontology and the app's graphs (it is projected, and changed). */
  store: GraphStore
  /** The IRI of the component to render: the root of the projection (as mount's `root`). */
  root: string
  /** The address to render (path, query and fragment, e.g. "/docs/rules/"): read into the graph as the client reads its URL. */
  url?: string
  /** Changes the client makes before its first projection too (after the address is read): the same, so both render alike. */
  prepare?: (store: GraphStore) => void
  layers?: Iterable<string>
  prefer?: 'sparql' | 'function'
  functions?: Record<string, FnRule>
  /** The viewer's languages, most preferred first (otherwise the graph's l10n:language, then English). */
  languages?: string[]
  /** Record provenance (as the client's projection does, if it does: it changes nothing rendered). */
  provenance?: boolean
  /** Compile the stylesheet too (default true). */
  styles?: boolean
}

export interface Rendered {
  /** The root's HTML, to go inside the mount element. */
  html: string
  /** The compiled stylesheet (unless styles: false). */
  css?: string
  /** 200, or 404 when the address names a place no location knows. */
  status: number
  /** The document's language and direction, for <html lang dir>. */
  lang: string
  dir: 'ltr' | 'rtl'
  /** The address as the graph spells it (the canonical URL of what was rendered). */
  address?: string
  runtime: Runtime
  projection: Projection
}

/** A UrlLike for an address (path, query and fragment). */
export function urlOf(address: string): { pathname: string; search: string; hash: string } {
  const u = new URL(address, 'https://semblance.invalid/')
  return { pathname: u.pathname, search: u.search, hash: u.hash }
}

const noHistory = { pushState() {}, replaceState() {} }

/**
 * Read an address into the store as the navigation effect does on the client (before its first
 * projection), and say whether it names a place: a path whose every segment was read.
 */
export async function readUrl(store: GraphStore, root: string, url: string): Promise<{ found: boolean; address?: string }> {
  const location = urlOf(url)
  const navigation = new Navigation(store, { root, location, history: noHistory, events: new EventTarget(), links: new EventTarget() })
  await navigation.restore()
  const loc = navigation.location()
  if (!loc) return { found: location.pathname === '/' || location.pathname.endsWith('/index.html'), address: undefined }
  const r = { f: store.factory, match: (s: Parameters<GraphStore['match']>[0], p: string | null, o: Parameters<GraphStore['match']>[2]) => store.match(s, p ? store.factory.namedNode(p) : null, o, store.factory.defaultGraph()) }
  const spelled = spellAddress(r, loc, currentValues(r, loc))
  const path = location.pathname.replace(/\/index\.html?$/, '/')
  const want = path.endsWith('/') ? path : path + '/'
  // The base alone is the location's default place; anything else must spell itself back.
  const found = !loc.paths || want === loc.base || spelled.path === want
  return { found, address: navigation.href() }
}

/** The document's language and direction: the projection's first language, and its l10n:direction. */
export function documentLanguage(store: GraphStore, code: string): { lang: string; dir: 'ltr' | 'rtl' } {
  const f = store.factory
  const language = store.match(null, f.namedNode(NS.l10n + 'code'), f.literal(code))[0]?.subject
  const rtl = !!language && store.match(language, f.namedNode(NS.l10n + 'direction'), f.namedNode(NS.l10n + 'RTL')).length > 0
  return { lang: code, dir: rtl ? 'rtl' : 'ltr' }
}

/** The languages a store's graph states for an app: the l10n:language of the location's subjects, else none. */
export function graphLanguages(store: GraphStore, root: string): string[] {
  const f = store.factory
  const r = { f, match: (s: Parameters<GraphStore['match']>[0], p: string | null, o: Parameters<GraphStore['match']>[2]) => store.match(s, p ? f.namedNode(p) : null, o, f.defaultGraph()) }
  const loc = readLocations(r).find((l) => l.root === root)
  const subjects = [f.namedNode(root), ...(loc?.dimensions.map((d) => d.subject) ?? [])]
  for (const s of subjects) {
    const language = store.match(s, f.namedNode(NS.l10n + 'language'), null, f.defaultGraph())[0]?.object
    const code = language && store.match(language as never, f.namedNode(NS.l10n + 'code'), null)[0]?.object.value
    if (code) return [code]
  }
  return []
}

/** Read the address and prepare the store: what decides the document's language, before projecting. */
export async function readyToRender(opts: RenderOptions): Promise<{ status: number; address?: string; languages: string[]; lang: string; dir: 'ltr' | 'rtl' }> {
  const { store, root } = opts
  const { found, address } = opts.url !== undefined ? await readUrl(store, root, opts.url) : { found: true, address: undefined }
  opts.prepare?.(store)
  const languages = opts.languages ?? graphLanguages(store, root)
  return { status: found ? 200 : 404, address, languages, ...documentLanguage(store, languages[0] ?? 'en') }
}

/** Project the prepared store and serialize the root (after readyToRender). */
export function project(opts: RenderOptions, languages: string[]): Pick<Rendered, 'html' | 'css' | 'runtime' | 'projection'> {
  const { store, root } = opts
  const runtime = new Runtime(store)
  const projection = runtime.project({ modality: MOD.Screen, layers: opts.layers ?? DEFAULT_LAYERS, prefer: opts.prefer ?? 'sparql', functions: opts.functions, languages, provenance: opts.provenance, name: 'screen', roots: [root] })
  const html = toHTML(projection.index, root)
  const css = opts.styles === false ? undefined : compileStyles(store)
  return { html, css, runtime, projection }
}

/** Project `root` at `url` and serialize it: what the client's first render of that address shows. */
export async function renderToString(opts: RenderOptions): Promise<Rendered> {
  const ready = await readyToRender(opts)
  return { ...ready, ...project(opts, ready.languages) }
}
