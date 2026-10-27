// Rendering a site (src/server/site.ts) in Node: one address at a time from a fresh store, a
// static build of every address with worker processes, and a request handler for a server
// (docs/SSR.md).
import { fork } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readLocations, routesOf, setBase } from '../navigation.ts'
import { renderDocument, type DocumentOptions } from '../server/document.ts'
import { type Rendered, renderToString } from '../server/render.ts'
import type { Site } from '../server/site.ts'
import type { GraphStore } from '../store/types.ts'
import { loadStore } from './load.ts'

export interface RenderSiteOptions {
  /** One self-contained file (where we are goes in the fragment; Site.setup decides how). */
  single?: boolean
  /** Where the site is served from (nav:base): "/" by default. */
  base?: string
  /** Compile the stylesheet too (default true). */
  styles?: boolean
}

const graphsOf = new WeakMap<Site, Promise<string[]>>()

/** A fresh store with the site's graphs, set up as its client sets it up. */
export async function siteStore(site: Site, opts: RenderSiteOptions = {}): Promise<GraphStore> {
  let graphs = graphsOf.get(site)
  if (!graphs) graphsOf.set(site, (graphs = Promise.resolve(site.graphs())))
  const store = loadStore(site.store ?? 'wat', ...(await graphs))
  site.setup?.(store, { single: !!opts.single })
  if (opts.base) setBase(store, opts.base)
  return store
}

/** Render one address of a site, as its client's first render of it. */
export async function renderSite(site: Site, url: string, opts: RenderSiteOptions = {}): Promise<Rendered & { attributes: Record<string, string> }> {
  const store = await siteStore(site, opts)
  const rendered = await renderToString({ store, root: site.root, url, prepare: site.prepare, layers: site.layers?.(store), prefer: site.prefer, functions: site.functions, styles: opts.styles })
  const attributes = site.documentAttributes?.(store) ?? {}
  return { ...rendered, attributes }
}

/** The addresses of a site to render beforehand: its location's paths (routesOf), as Site.routes changes them. */
export async function siteRoutes(site: Site, opts: RenderSiteOptions = {}): Promise<string[]> {
  if (opts.single) return [opts.base ?? '/']
  const store = await siteStore(site, opts)
  const f = store.factory
  const r = { f, match: (s: Parameters<GraphStore['match']>[0], p: string | null, o: Parameters<GraphStore['match']>[2]) => store.match(s, p ? f.namedNode(p) : null, o, f.defaultGraph()) }
  const loc = readLocations(r).find((l) => l.root === site.root)
  const found = loc?.paths ? routesOf(r, loc) : [opts.base ?? '/']
  store.dispose?.()
  return site.routes ? site.routes(found) : found
}

/** Load a site description: a module whose default export is a Site (semblance.config.ts). */
let tsx: Promise<unknown> | undefined

export async function loadSite(config: string): Promise<Site> {
  // The description and what it imports may be TypeScript Node cannot strip alone (Vite loads its
  // own config its own way): tsx loads them.
  await (tsx ??= import('tsx/esm/api').then((m) => m.register()))
  const mod = (await import(pathToFileURL(resolve(config)).href)) as { default?: Site; site?: Site }
  const site = mod.default ?? mod.site
  if (!site?.root) throw new Error(`${config} exports no site (export default defineSite({ root, graphs }))`)
  return site
}

export interface BuildOptions extends RenderSiteOptions {
  /** The site description's module (semblance.config.ts). */
  config: string
  /** The built client (Vite's outDir): its index.html is the template, and the pages are written there. */
  outDir: string
  /** The template, if not outDir/index.html. */
  template?: string
  /** More for each page's <head> (preloads). */
  head?: string
  /** Worker processes (default: up to 4, leaving a core free; SEMBLANCE_BUILD_WORKERS). */
  workers?: number
  /** Say what is happening. */
  log?: (line: string) => void
}

/** A page's file under outDir: /docs/rules/ → docs/rules/index.html. */
export function pageFile(outDir: string, base: string, route: string): string {
  const path = route.startsWith(base) ? route.slice(base.length) : route.replace(/^\//, '')
  return join(outDir, ...path.split('/').filter(Boolean), 'index.html')
}

/**
 * Render every address of a site into the built client: one page per address (its HTML in the
 * mount element, taken over by the client), the stylesheet the pages link (semblance.css), and
 * 404.html: the client alone, which renders whatever address it finds. With `single`, the one
 * file is rendered at its own address, with the stylesheet inline.
 */
export async function buildSite(opts: BuildOptions): Promise<{ pages: number; ms: number; bytes: number }> {
  const t0 = performance.now()
  const log = opts.log ?? (() => {})
  const base = opts.base ?? '/'
  const templatePath = opts.template ?? join(opts.outDir, 'index.html')
  const template = readFileSync(templatePath, 'utf8')
  const site = await loadSite(opts.config)
  const routes = await siteRoutes(site, opts)
  if (!opts.single) writeFileSync(join(opts.outDir, '404.html'), template.replace(/<\/head>/i, `${opts.head ?? ''}</head>`))
  const want = opts.workers ?? (Number(process.env.SEMBLANCE_BUILD_WORKERS) || Math.max(1, Math.min(4, availableParallelism() - 1)))
  const workers = Math.max(1, Math.min(want, Math.ceil(routes.length / 8)))
  log(`semblance: rendering ${routes.length} page${routes.length === 1 ? '' : 's'} with ${workers} worker${workers === 1 ? '' : 's'}`)
  const job = { config: resolve(opts.config), outDir: resolve(opts.outDir), template, head: opts.head ?? '', single: !!opts.single, base }
  const chunks = Array.from({ length: workers }, (_, i) => routes.filter((_, j) => j % workers === i))
  let bytes = 0
  const results = await Promise.all(chunks.map((chunk, i) => (workers === 1 ? renderPages({ ...job, routes: chunk, styles: i === 0 }) : inWorker({ ...job, routes: chunk, styles: i === 0 }))))
  for (const r of results) bytes += r.bytes
  const css = results.find((r) => r.css !== undefined)?.css
  if (css !== undefined && !opts.single) writeFileSync(join(opts.outDir, 'semblance.css'), css)
  const ms = performance.now() - t0
  log(`semblance: ${routes.length} page${routes.length === 1 ? "" : "s"}, ${(bytes / 1024).toFixed(0)} KiB of HTML, in ${(ms / 1000).toFixed(1)} s`)
  return { pages: routes.length, ms, bytes }
}

export interface PagesJob {
  config: string
  outDir: string
  template: string
  head: string
  single: boolean
  base: string
  routes: string[]
  /** This worker compiles the stylesheet (one does). */
  styles: boolean
}

/** Render pages of a job here (a worker process does the same). */
export async function renderPages(job: PagesJob): Promise<{ bytes: number; css?: string }> {
  const site = await loadSite(job.config)
  let bytes = 0
  let css: string | undefined
  for (const route of job.routes) {
    const rendered = await renderSite(site, route, { single: job.single, base: job.base, styles: job.single || (job.styles && css === undefined) })
    css ??= rendered.css
    const stylesheet: DocumentOptions['stylesheet'] = job.single ? 'inline' : { href: job.base + 'semblance.css' }
    const page = renderDocument(job.template, { ...rendered, css: job.single ? rendered.css : undefined }, { mount: site.mount, stylesheet, attributes: rendered.attributes, head: job.head })
    const file = job.single ? join(job.outDir, 'index.html') : pageFile(job.outDir, job.base, route)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, page)
    bytes += page.length
    rendered.runtime.dispose()
  }
  return { bytes, css }
}

const workerPath = fileURLToPath(new URL('./site-worker.ts', import.meta.url))

function inWorker(job: PagesJob): Promise<{ bytes: number; css?: string }> {
  return new Promise((resolveJob, reject) => {
    // tsx loads the TypeScript sources in the worker as in this process.
    const child = fork(workerPath, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    child.once('message', (m: { ok: true; bytes: number; css?: string } | { ok: false; error: string }) => {
      if (m.ok) resolveJob({ bytes: m.bytes, css: m.css })
      else reject(new Error(m.error))
      child.disconnect()
    })
    child.once('exit', (code) => code && reject(new Error(`a render worker exited with ${code}`)))
    child.send(job)
  })
}

// --- serving ----------------------------------------------------------------------------------

export interface HandlerOptions extends RenderSiteOptions {
  site: Site
  /** The built client: its files are served as they are, and its 404.html (else index.html) is the template. */
  assets: string
  /** The template, if not from assets. */
  template?: string
  /** Inline the stylesheet (with a single-file client build as the template: one self-contained response). */
  embed?: boolean
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }

/**
 * A request handler (the Fetch API's Request and Response: Node's own server through `listen`,
 * Deno, Bun, workers with a file binding): the built client's files as they are, and every other
 * address rendered for the request, from a fresh store, as the client's first render of it.
 */
export function createHandler(opts: HandlerOptions): (request: Request) => Promise<Response> {
  const assets = resolve(opts.assets)
  const templateFile = opts.template ?? [join(assets, '404.html'), join(assets, 'index.html')].find((f) => existsSync(f))
  if (!templateFile) throw new Error(`No template in ${assets} (build the client first)`)
  const template = readFileSync(templateFile, 'utf8')
  const base = opts.base ?? '/'
  let css: string | undefined
  return async (request) => {
    const url = new URL(request.url)
    const path = decodeURIComponent(url.pathname)
    const file = resolve(assets, '.' + (path.startsWith(base) ? '/' + path.slice(base.length) : path))
    if (file.startsWith(assets + sep) && extname(file) && extname(file) !== '.html' && existsSync(file)) {
      return new Response(readFileSync(file), { headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': /-[\w-]{8,}\.\w+$/.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=600' } })
    }
    if (path === base + 'semblance.css' && !opts.embed) {
      css ??= (await renderSite(opts.site, base, { ...opts, styles: true })).css
      return new Response(css, { headers: { 'content-type': 'text/css', 'cache-control': 'public, max-age=600' } })
    }
    const rendered = await renderSite(opts.site, url.pathname + url.search, { ...opts, styles: !!opts.embed })
    const page = renderDocument(template, rendered, { mount: opts.site.mount, stylesheet: opts.embed ? 'inline' : { href: base + 'semblance.css' }, attributes: rendered.attributes })
    rendered.runtime.dispose()
    return new Response(page, { status: rendered.status, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
}

/** Serve a Fetch-style handler with Node's own HTTP server. */
export async function listen(handler: (request: Request) => Promise<Response>, port = 3000, host = 'localhost'): Promise<import('node:http').Server> {
  const { createServer } = await import('node:http')
  const server = createServer(async (req, res) => {
    try {
      const request = new Request(`http://${req.headers.host ?? host}${req.url ?? '/'}`, { method: req.method, headers: req.headers as Record<string, string> })
      const response = await handler(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String((e as Error)?.stack ?? e))
    }
  })
  await new Promise<void>((ok) => server.listen(port, host, ok))
  return server
}
