import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// In this repository the package is its own source; an app that installed it needs only
// the optimizeDeps lines (see docs/GETTING-STARTED.md).
const repo = resolve(import.meta.dirname, '../..')

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^@inferal-oss\/semblance(.*)$/, replacement: repo + '/src$1/index.ts' }] },
  server: { fs: { allow: [repo] } },
  optimizeDeps: { exclude: ['@inferal-oss/semblance', 'oxigraph'], include: ['n3'] },
})
