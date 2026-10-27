// The Vite plugin that renders a site's pages at build time (docs/SSR.md): after the client is
// built, every address of the site (its location's paths, src/node/site.ts) becomes a page of its
// own, already rendered, which the client takes over without rendering it again. The pages'
// <head> preloads what the client needs at once (its modules and the engine's WASM), so nothing
// waits for the module that asks for it. In a single-file build (vite-plugin-singlefile) the one
// file is rendered, with the stylesheet inline.
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ResolvedConfig } from 'vite'
import { buildSite } from './site.ts'
import { minifyTurtle } from './turtle-min.ts'

export interface SemblancePluginOptions {
  /** The site description's module (default semblance.config.ts in the working directory). */
  config?: string
  /** One self-contained file (default: when the build's mode is "single"). */
  single?: boolean
  /** Assets to preload in every page besides the modules (default: Semblance's WASM engine). */
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
        workers: opts.workers,
        log: (line) => config.logger.info(line),
      })
    },
  }
  return plugin
}
