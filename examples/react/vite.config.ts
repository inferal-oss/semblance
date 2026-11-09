import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { semblance } from '../../src/node/vite.ts'

// In this repository the packages are their own source; an app that installed them needs only the
// optimizeDeps lines (see docs/GETTING-STARTED.md).
const repo = resolve(import.meta.dirname, '../..')

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: [
      { find: /^@inferal-oss\/semblance-react$/, replacement: repo + '/packages/react/src/index.ts' },
      { find: /^@inferal-oss\/semblance-react\/server$/, replacement: repo + '/packages/react/src/server.ts' },
      { find: /^@inferal-oss\/semblance(\/web|\/node|\/server)?$/, replacement: repo + '/src$1/index.ts' },
    ],
  },
  server: { fs: { allow: [repo] } },
  optimizeDeps: { exclude: ['@inferal-oss/semblance', 'oxigraph'], include: ['n3', 'react', 'react-dom', 'react-dom/client'] },
  plugins: [semblance({ config: resolve(import.meta.dirname, 'semblance.config.ts') })],
  build: { outDir: resolve(import.meta.dirname, 'dist'), emptyOutDir: true },
})
