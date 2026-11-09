// Server-side rendering (docs/SSR.md): a component graph projected and serialized as HTML before
// any script runs, at build time (src/build/) or per request (src/server/handler.ts). The client
// takes the HTML over without rendering it again (DomRenderer.adopt, mount): its first projection,
// from the same graph and address, has the same nodes, so it pairs them with the parsed DOM.
// Platform-neutral: the caller loads the store (src/node/load.ts, src/web/load.ts or its own
// engine module), so this runs in Node, Deno and workers alike.
import type { FnRule } from '../engine/context.ts'
import { addressDelta, currentValues, type Location, Navigation, readAddress, readLocations, type Reader, spellAddress } from '../navigation.ts'
import { DEFAULT_LAYERS, MOD, NS } from '../ns.ts'
import type { HostRenderer } from '../render/hosts.ts'
import { toHTML } from '../render/serialize.ts'
import { type Projection, Runtime } from '../runtime.ts'
import { prerenderSandboxes, type PrerenderOptions, type SandboxOptions } from '../sandbox.ts'
import type { Delta } from '../rdf.ts'
import type { GraphStore } from '../store/types.ts'
import { compileStyles } from '../style/compile.ts'
import { boxSelector, scopedCss } from '../style/scope.ts'
import type { SafetyPolicy } from '../safety.ts'
import { rememberedPolicies, type RememberedPolicy } from './remembered.ts'

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
  /**
   * Render the live examples shown (c:LiveExample) too, each in a sandbox of its own as the
   * browser builds it: how to load a sandbox's store (the client's store kind), and its turn limit.
   * Without it their slots are empty until the client builds them.
   */
  sandboxes?: Pick<SandboxOptions, 'load' | 'budgetMs'> & Pick<PrerenderOptions, 'cache'>
  /**
   * Render the store as authored content (src/safety.ts): elements, attributes and styles the policy
   * refuses are left out, and reported. Read it from a trusted store (authoredPolicy), not this one.
   */
  policy?: SafetyPolicy
  /**
   * With a policy: the store it was read from (the ontology and the app's own graphs). Its stylesheet
   * is the page's, and only what the rendered store adds is scoped to the authored box (the mount
   * element, `Rendered.box`); without it the whole stylesheet is scoped to the box.
   */
  trusted?: GraphStore
  /** A component library that draws hosted components (as mount's `hosts`): their server markup, which the client hydrates. */
  hosts?: HostRenderer
}

export interface Rendered {
  /** The root's HTML, to go inside the mount element. */
  html: string
  /** The compiled stylesheet (unless styles: false). */
  css?: string
  /** With a policy: the authored box the mount element is (its BOX_ATTRIBUTE, src/style/scope.ts), which the stylesheet is scoped to. */
  box?: string
  /** 200, or 404 when the address names a place no location knows. */
  status: number
  /** The document's language and direction, for <html lang dir>. */
  lang: string
  dir: 'ltr' | 'rtl'
  /** The address as the graph spells it (the canonical URL of what was rendered). */
  address?: string
  /** What the page can put back before its first paint (src/web/remembered.ts). */
  remembered: RememberedPolicy[]
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
  const navigation = new Navigation(store, { root, location: urlOf(url), history: noHistory, events: new EventTarget(), links: new EventTarget() })
  await navigation.restore()
  return addressStatus(storeReader(store), navigation.location(), url)
}

/** A reader of a store's default graph (what the navigation model reads). */
export function storeReader(store: GraphStore): Reader {
  return { f: store.factory, match: (s, p, o) => store.match(s, p ? store.factory.namedNode(p) : null, o, store.factory.defaultGraph()) }
}

/**
 * Whether `url`, once read into the graph `r` reads, names a place (a path whose every segment
 * was read), and the address as the graph spells it (Navigation.href).
 */
export function addressStatus(r: Reader, loc: Location | undefined, url: string): { found: boolean; address?: string } {
  const location = urlOf(url)
  if (!loc) return { found: location.pathname === '/' || location.pathname.endsWith('/index.html'), address: undefined }
  const path = location.pathname.replace(/\/index\.html?$/, '/')
  const want = path.endsWith('/') ? path : path + '/'
  // A place is found when what the address says spells it back: every segment was read.
  const found = !loc.paths || want === loc.base || spellAddress(r, loc, readAddress(r, loc, want)).path === want
  const spelled = spellAddress(r, loc, currentValues(r, loc))
  const params = new URLSearchParams(location.search)
  for (const [k, v] of spelled.query) v === undefined ? params.delete(k) : params.set(k, v)
  const search = params.toString()
  return { found, address: (loc.paths ? spelled.path : location.pathname) + (search ? '?' + search : '') + spelled.fragment }
}

/** What reading `url` into the graph `r` reads changes (readUrl, as a change), for the location of `root`. */
export function urlDelta(r: Reader, root: string, url: string): { loc?: Location; delta: Delta } {
  const loc = readLocations(r).find((l) => l.root === root)
  if (!loc) return { delta: { add: [], remove: [] } }
  const u = urlOf(url)
  // What the client's location reads: the path (without index.html) when the location has paths, the query, the fragment.
  const address = (loc.paths ? u.pathname.replace(/\/index\.html?$/, '/') : '') + u.search + u.hash
  return { loc, delta: addressDelta(r, loc, address).delta }
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
  return readerLanguages(storeReader(store), root)
}

/** graphLanguages, of the graph a reader reads. */
export function readerLanguages(r: Reader, root: string): string[] {
  const loc = readLocations(r).find((l) => l.root === root)
  for (const s of [r.f.namedNode(root), ...(loc?.dimensions.map((d) => d.subject) ?? [])]) {
    const language = r.match(s, NS.l10n + 'language', null)[0]?.object
    const code = language && r.match(language, NS.l10n + 'code', null)[0]?.object.value
    if (code) return [code]
  }
  return []
}

/** Read the address and prepare the store: what decides the document's language, before projecting. */
export async function readyToRender(opts: RenderOptions): Promise<{ status: number; address?: string; languages: string[]; lang: string; dir: 'ltr' | 'rtl'; remembered: RememberedPolicy[] }> {
  const { store, root } = opts
  const { found, address } = opts.url !== undefined ? await readUrl(store, root, opts.url) : { found: true, address: undefined }
  opts.prepare?.(store)
  const languages = opts.languages ?? graphLanguages(store, root)
  return { status: found ? 200 : 404, address, languages, remembered: rememberedPolicies(store, root), ...documentLanguage(store, languages[0] ?? 'en') }
}

/** Project the prepared store and serialize the root (after readyToRender). */
export function project(opts: RenderOptions, languages: string[]): Pick<Rendered, 'html' | 'css' | 'box' | 'runtime' | 'projection'> {
  const { store, root } = opts
  const runtime = new Runtime(store)
  const projection = runtime.project({ modality: MOD.Screen, layers: opts.layers ?? DEFAULT_LAYERS, prefer: opts.prefer ?? 'sparql', functions: opts.functions, languages, provenance: opts.provenance, name: 'screen', roots: [root], policy: opts.policy })
  // Authored: the trusted sheet is the page's, what the store adds stays in the box (src/style/scope.ts).
  const box = authoredBox(opts)
  const trustedCss = box && opts.styles !== false && opts.trusted ? compileStyles(opts.trusted) : ''
  const compiled = opts.styles === false ? undefined : compileStyles(store, { policy: opts.policy })
  const css = box && compiled !== undefined ? [trustedCss, scopedCss(compiled, trustedCss, boxSelector(box))].filter(Boolean).join('\n\n') : compiled
  let siteCss = box ? undefined : css
  const html = serializeRoot(runtime, projection, root, { ...opts, siteCss: () => (siteCss ??= box ? trustedCss : compileStyles(store)) })
  return { html, css, runtime, projection, ...(box && { box }) }
}

/** The authored box of a rendering under a policy (the mount element's BOX_ATTRIBUTE), or none. */
export const authoredBox = (opts: Pick<RenderOptions, 'policy'>): string | undefined => (opts.policy ? 'authored' : undefined)

/**
 * The root's HTML as the projection has it now, with the live examples it shows rendered in
 * their slots (with `sandboxes`): what a page rendered beforehand holds, at each address.
 */
export function serializeRoot(runtime: Runtime, projection: Projection, root: string, opts: Pick<RenderOptions, 'sandboxes' | 'prefer' | 'functions' | 'hosts'> & { siteCss?: () => string; shownOnly?: boolean }): string {
  const slots = opts.sandboxes ? prerenderSandboxes(runtime, projection, { ...opts.sandboxes, prefer: opts.prefer ?? 'sparql', functions: opts.functions, roots: [root], siteCss: opts.siteCss }) : undefined
  const hosts = opts.hosts?.(projection.index, { runtime, projection })
  try {
    return toHTML(projection.index, root, { ...(slots?.size ? { slots: (name: string) => slots.get(name) } : {}), hosts, shownOnly: opts.shownOnly })
  } finally {
    hosts?.dispose()
  }
}

/** Project `root` at `url` and serialize it: what the client's first render of that address shows. */
export async function renderToString(opts: RenderOptions): Promise<Rendered> {
  const ready = await readyToRender(opts)
  return { ...ready, ...project(opts, ready.languages) }
}
