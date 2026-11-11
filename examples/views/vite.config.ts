import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { todoStore } from '../remote/store.ts'

// In this repository the packages are their own source; an app that installed them imports
// '@inferal-oss/semblance/views' and '@inferal-oss/semblance-react/views' as they are.
const repo = resolve(import.meta.dirname, '../..')

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: [
      { find: /^@inferal-oss\/semblance\/views$/, replacement: repo + '/src/views/web.ts' },
      { find: /^@inferal-oss\/semblance-react\/views$/, replacement: repo + '/packages/react/src/views.ts' },
    ],
  },
  server: { fs: { allow: [repo] } },
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
