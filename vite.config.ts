import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { defineConfig } from 'vitest/config'

const here = import.meta.dirname

// /llms.txt, /llms-full.txt and the Markdown pages under /llms/ (scripts/gen-llms.ts), generated
// from the graph: emitted into the build, and served by the dev server (again after a .ttl changes).
function llms(): Plugin {
  const generate = async () => (await import('./scripts/gen-llms.ts')).generateLlms()
  let files: Promise<Map<string, string>> | undefined
  return {
    name: 'semblance-llms',
    configureServer(server) {
      server.watcher.on('change', (path) => {
        if (path.endsWith('.ttl')) files = undefined
      })
      server.middlewares.use(async (req, res, next) => {
        const path = decodeURIComponent((req.url ?? '').split(/[?#]/)[0]!).slice(1)
        if (path !== 'llms.txt' && path !== 'llms-full.txt' && !path.startsWith('llms/')) return next()
        const content = (await (files ??= generate())).get(path)
        if (content === undefined) return next()
        res.setHeader('Content-Type', `${path.endsWith('.md') ? 'text/markdown' : 'text/plain'}; charset=utf-8`)
        res.end(content)
      })
    },
    async generateBundle() {
      for (const [fileName, source] of await generate()) this.emitFile({ type: 'asset', fileName, source })
    },
  }
}

// `vite build --mode single` produces one self-contained HTML file (JS, CSS,
// ontologies and the Oxigraph WASM inlined) in dist-single/.
export default defineConfig(({ command, mode }) => ({
  root: 'demo',
  // Relative asset URLs, so a build works from any path (GitHub Pages serves it under
  // /semblance/ until a domain is set). The app routes by fragment only, so this is safe.
  base: command === 'build' ? './' : '/',
  // Cross-origin isolation gives performance.now() microsecond resolution
  // (otherwise browsers coarsen it to ~100µs), which the benchmarks need.
  server: {
    fs: { allow: [resolve(here)] },
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  // Pre-bundling would break Oxigraph's wasm-bindgen glue.
  optimizeDeps: { exclude: ['oxigraph'] },
  plugins: [llms(), ...(mode === 'single' ? [viteSingleFile({ removeViteModuleLoader: true })] : [])],
  build: {
    outDir: resolve(here, mode === 'single' ? 'dist-single' : 'dist'),
    emptyOutDir: true,
    target: 'es2023',
    assetsInlineLimit: mode === 'single' ? Number.MAX_SAFE_INTEGER : undefined,
  },
  // Integration tests mount the whole demo; with two runs sharing the machine (scripts/test-queue.sh)
  // the largest (the chat and network examples, from-scratch engine checks) take over a minute.
  // Speed is guarded by the cost tests' work counters, not by this limit.
  test: { root: here, include: ['test/**/*.test.ts'], setupFiles: ['test/setup.ts'], testTimeout: 180_000 },
}))
