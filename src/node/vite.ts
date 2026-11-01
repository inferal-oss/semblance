// The Vite plugin that renders a site's pages at build time (docs/SSR.md): after the client is
// built, every address of the site (its location's paths, src/node/site.ts) becomes a page of its
// own, already rendered, which the client takes over without rendering it again (with preload,
// the pages' <head> also preloads the client's modules and the engine's WASM). In a single-file
// build (vite-plugin-singlefile) the one file is rendered, with the stylesheet inline.
import { readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ResolvedConfig } from 'vite'
import { buildSite } from './site.ts'
import { minifyTurtle } from './turtle-min.ts'

export interface SemblancePluginOptions {
  /** The site description's module (default semblance.config.ts in the working directory). */
  config?: string
  /** One self-contained file (default: when the build's mode is "single"). */
  single?: boolean
  /**
   * Preload, in every page's head, the modules the first moments need and the engine's WASM
   * (preloadAssets). Off by default: they then share the network with the stylesheet the first
   * paint waits for. On a throttled phone, semblance.dev painted at 1.9 s with them and 0.9 s
   * without, and was interactive 0.6 s sooner with them.
   */
  preload?: boolean
  /** Assets to preload besides the modules, with preload (default: Semblance's WASM engine). */
  preloadAssets?: RegExp
  /** Worker processes for rendering (see BuildOptions.workers). */
  workers?: number
}

const NAME = 'semblance-ssr'

interface Chunk {
  type: 'chunk'
  fileName: string
  isEntry: boolean
  imports: string[]
  dynamicImports: string[]
  facadeModuleId?: string | null
}

const ontologyDir = fileURLToPath(new URL('../../ontology/', import.meta.url))

/**
 * Render every page of the site after the client build (`vite build`); and bundle the framework's
 * ontology without its comments and indentation (the same triples, a fifth fewer bytes).
 */
export function semblance(opts: SemblancePluginOptions = {}): Plugin[] {
  const turtle: Plugin = {
    name: NAME + ':ontology',
    apply: 'build',
    enforce: 'pre',
    load(id) {
      const [path, query] = id.split('?')
      if (query !== 'raw' || !path!.endsWith('.ttl') || !path!.startsWith(ontologyDir) || path!.includes(sep + 'vendor' + sep)) return null
      return `export default ${JSON.stringify(minifyTurtle(readFileSync(path!, 'utf8')))}`
    },
  }
  return [turtle, site(opts)]
}

function site(opts: SemblancePluginOptions): Plugin {
  let config: ResolvedConfig
  let head = ''
  let disabled = false
  /** The chunk of each graph a client imports on its own (`ontology/<file>`, `demo/gallery/<file>`: by path from the project). */
  let graphChunks: Record<string, string> = {}
  const plugin: Plugin = {
    name: NAME,
    apply: 'build',
    enforce: 'post',
    configResolved(c) {
      config = c
      // Added twice (the CLI adds it to a config that has it): the first one does the work.
      disabled = c.plugins.find((p) => p.name === NAME) !== plugin
    },
    generateBundle(_, bundle) {
      if (disabled || config.build.ssr) return
      // A Turtle file imported on its own (?raw, lazily) is a chunk a page can preload by its graph's
      // name: the framework's `ontology/<file>`, the app's by its path from the site description's folder.
      const project = dirname(resolve(opts.config ?? 'semblance.config.ts')) + sep
      graphChunks = {}
      for (const o of Object.values(bundle) as unknown as Chunk[]) {
        const id = o.type === 'chunk' ? o.facadeModuleId?.split('?')[0] : undefined
        if (!id?.endsWith('.ttl')) continue
        const name = id.startsWith(ontologyDir) ? 'ontology/' + id.slice(ontologyDir.length) : id.startsWith(project) ? id.slice(project.length) : undefined
        if (name) graphChunks[name.split(sep).join('/')] = o.fileName
      }
      if (!opts.preload) return
      const base = config.base.startsWith('/') ? config.base : '/'
      const chunks = Object.values(bundle).filter((o) => o.type === 'chunk') as unknown as Chunk[]
      const entry = chunks.find((c) => c.isEntry)
      if (!entry) return
      // The entry's static imports, and those of the modules it imports dynamically at once (a
      // boot module that picks the app), are what the first moments need.
      const byName = new Map(chunks.map((c) => [c.fileName, c]))
      const wanted = new Set<string>()
      const add = (name: string) => {
        const c = byName.get(name)
        if (!c || wanted.has(name)) return
        wanted.add(name)
        c.imports.forEach(add)
      }
      entry.imports.forEach(add)
      for (const d of entry.dynamicImports) add(d)
      const assets = Object.values(bundle).filter((o) => o.type === 'asset' && (opts.preloadAssets ?? /(^|\/)wat-[\w-]+\.wasm$/).test(o.fileName))
      head =
        [...wanted].map((f) => `<link rel="modulepreload" crossorigin href="${base}${f}">`).join('') +
        assets.map((a) => `<link rel="preload" as="fetch" type="application/wasm" crossorigin href="${base}${a.fileName}">`).join('')
    },
    async closeBundle() {
      if (disabled || !config || config.build.ssr) return
      const single = opts.single ?? config.mode === 'single'
      const outDir = resolve(config.root, config.build.outDir)
      const base = config.base.startsWith('/') ? config.base : '/'
      await buildSite({
        config: resolve(opts.config ?? 'semblance.config.ts'),
        outDir,
        single,
        base,
        // A single file has everything inline already: nothing to preload.
        head: single ? '' : head,
        // With preloads, each page preloads the graphs it names too (they share the network with
        // the stylesheet: on a throttled phone the first paint waited 4.5 s for them, not 1.8 s).
        graphChunks: opts.preload ? graphChunks : undefined,
        workers: opts.workers,
        log: (line) => config.logger.info(line),
      })
    },
  }
  return plugin
}
