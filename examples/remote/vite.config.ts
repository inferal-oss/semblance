import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { todoStore } from './store.ts'

// In this repository the package is its own source; an app that installed it needs only
// the optimizeDeps lines (see docs/GETTING-STARTED.md).
const repo = resolve(import.meta.dirname, '../..')

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [{ find: /^@inferal-oss\/semblance(.*)$/, replacement: repo + '/src$1/index.ts' }] },
  server: { fs: { allow: [repo] } },
  optimizeDeps: { exclude: ['@inferal-oss/semblance', 'oxigraph'], include: ['n3'] },
  plugins: [
    {
      // The store, served beside the page under /store/ (server.ts serves it alone).
      name: 'todo-store',
      configureServer(server) {
        const handle = todoStore().handler('/store/')
        server.middlewares.use((req, res, next) => void (handle(req, res) || next()))
      },
    },
  ],
})
