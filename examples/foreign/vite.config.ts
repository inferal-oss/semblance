import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { linkedModules } from '../../src/node/vite.ts'

// In this repository the package is its own source; an app that installed it needs only
// the optimizeDeps lines (see docs/GETTING-STARTED.md).
const repo = resolve(import.meta.dirname, '../..')

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^@semblance-dev\/semblance(.*)$/, replacement: repo + '/src$1/index.ts' }] },
  // A linked node_modules (a worktree's) is served from where it really is.
  server: { fs: { allow: [repo, ...linkedModules(repo)] } },
  optimizeDeps: { exclude: ['@semblance-dev/semblance', 'oxigraph'], include: ['n3'] },
})
