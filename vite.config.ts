import { resolve } from 'node:path'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { defineConfig } from 'vitest/config'

const here = import.meta.dirname

// `vite build --mode single` produces one self-contained HTML file (JS, CSS,
// ontologies and the Oxigraph WASM inlined) in dist-single/.
export default defineConfig(({ mode }) => ({
  root: 'demo',
  // Cross-origin isolation gives performance.now() microsecond resolution
  // (otherwise browsers coarsen it to ~100µs), which the benchmarks need.
  server: {
    fs: { allow: [resolve(here)] },
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  // Pre-bundling would break Oxigraph's wasm-bindgen glue.
  optimizeDeps: { exclude: ['oxigraph'] },
  plugins: mode === 'single' ? [viteSingleFile({ removeViteModuleLoader: true })] : [],
  build: {
    outDir: resolve(here, mode === 'single' ? 'dist-single' : 'dist'),
    emptyOutDir: true,
    target: 'es2023',
    assetsInlineLimit: mode === 'single' ? Number.MAX_SAFE_INTEGER : undefined,
  },
  test: { root: here, include: ['test/**/*.test.ts'] },
}))
