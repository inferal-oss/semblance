import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { semblance } from '../../src/node/vite.ts'

// In this repository the package is its own source; an app that installed it needs only
// the optimizeDeps lines (see docs/GETTING-STARTED.md).
const repo = resolve(import.meta.dirname, '../..')

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^@inferal-oss\/semblance(.*)$/, replacement: repo + '/src$1/index.ts' }] },
  server: { fs: { allow: [repo] } },
  optimizeDeps: { exclude: ['@inferal-oss/semblance', 'oxigraph'], include: ['n3'] },
  // The page rendered at build time (semblance.config.ts), taken over by the client in mount().
  plugins: [semblance({ config: resolve(import.meta.dirname, 'semblance.config.ts') })],
  build: { outDir: resolve(import.meta.dirname, 'dist'), emptyOutDir: true },
})
