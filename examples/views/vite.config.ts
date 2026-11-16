import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { linkedModules } from '../../src/node/vite.ts'
import { todoStore } from '../remote/store.ts'

// In this repository the packages are their own source; an app that installed them imports
// '@semblance-dev/semblance/views' and '@semblance-dev/semblance-react/views' as they are.
const repo = resolve(import.meta.dirname, '../..')

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: [
      { find: /^@semblance-dev\/semblance\/views$/, replacement: repo + '/src/views/web.ts' },
      { find: /^@semblance-dev\/semblance-react\/views$/, replacement: repo + '/packages/react/src/views.ts' },
    ],
  },
  // A linked node_modules (a worktree's) is served from where it really is.
  server: { fs: { allow: [repo, ...linkedModules(repo)] } },
  optimizeDeps: { exclude: ['oxigraph'], include: ['n3', 'react', 'react-dom/client'] },
  plugins: [
    {
      // The store, served beside the page under /store/ (examples/remote/server.ts serves it alone).
      name: 'todo-store',
      configureServer(server) {
        const handle = todoStore().handler('/store/')
        server.middlewares.use((req, res, next) => void (handle(req, res) || next()))
      },
      configurePreviewServer(server) {
        const handle = todoStore().handler('/store/')
        server.middlewares.use((req, res, next) => void (handle(req, res) || next()))
      },
    },
  ],
  build: { outDir: resolve(import.meta.dirname, 'dist'), emptyOutDir: true, target: 'es2022' },
})
