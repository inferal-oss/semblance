// What views on their own pull in (docs/VIEWS.md): the example's page (examples/views: views over the
// todo store, drawn by React) against mount's (examples/hello: the Getting started app, with the part
// of the ontology it uses). Both are built with Vite; the script reports each one's files by kind,
// raw and gzipped, and the time from navigation to a live page in headless Chromium (scripts/cdp.ts),
// the median of several loads with the cache off.
//   npx tsx scripts/views-measure.ts [--runs=7]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { build, preview, type Plugin } from 'vite'
import { launch } from './cdp.ts'

const repo = resolve(import.meta.dirname, '..')
const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.slice(7) ?? 7)
const out = mkdtempSync(join(tmpdir(), 'semblance-views-measure-'))

/** Marks when the page's module has run to its end (after its top-level awaits: the app is live). */
const ready = (entry: string): Plugin => ({
  name: 'measure-ready',
  transform(code, id) {
    if (id.endsWith(entry)) return code + `\nperformance.mark('measure:ready')\n`
  },
})

const pages = [
  { name: 'views (examples/views)', dir: 'examples/views', entry: '/examples/views/main.tsx', live: `document.querySelectorAll('#app li').length > 0` },
  { name: 'mount (examples/hello)', dir: 'examples/hello', entry: '/examples/hello/main.ts', live: `true` },
]

const kib = (n: number) => (n / 1024).toFixed(1) + ' KiB'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]))
}

const results: Record<string, unknown>[] = []
for (const page of pages) {
  const outDir = join(out, page.dir.replace('/', '-'))
  await build({ configFile: join(repo, page.dir, 'vite.config.ts'), logLevel: 'warn', plugins: [ready(page.entry)], build: { outDir, emptyOutDir: true } })
  const byKind: Record<string, { files: number; raw: number; gzip: number }> = {}
  for (const f of files(outDir)) {
    const kind = f.endsWith('.js') ? 'js' : f.endsWith('.wasm') ? 'wasm' : f.endsWith('.css') ? 'css' : f.endsWith('.html') ? 'html' : 'other'
    const bytes = readFileSync(f)
    const k = (byKind[kind] ??= { files: 0, raw: 0, gzip: 0 })
    k.files++
    k.raw += bytes.length
    k.gzip += gzipSync(bytes).length
  }
  const server = await preview({ configFile: join(repo, page.dir, 'vite.config.ts'), logLevel: 'warn', preview: { port: 0 }, build: { outDir } })
  const url = server.resolvedUrls!.local[0]!
  const { cdp, stop } = await launch()
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  const times: number[] = []
  const loaded: Record<string, number>[] = []
  for (let i = 0; i < runs; i++) {
    await cdp.send('Page.navigate', { url })
    const t = await cdp.evaluate<{ ready: number; start: Record<string, number> }>(`new Promise((ok) => {
      const check = () => {
        const mark = performance.getEntriesByName('measure:ready')[0]
        if (!mark || !(${page.live})) return void setTimeout(check, 2)
        // What the page fetched before it was live, by kind, as it is once decoded (uncompressed).
        const start = {}
        for (const r of performance.getEntriesByType('resource')) {
          if (r.responseEnd > performance.now() || !r.decodedBodySize) continue
          const ext = new URL(r.name).pathname.split('.').pop()
          const kind = ext === 'js' || ext === 'wasm' || ext === 'css' ? ext : 'other'
          start[kind] = (start[kind] || 0) + r.decodedBodySize
        }
        ok({ ready: performance.now(), start })
      }
      check()
    })`)
    times.push(t.ready)
    loaded.push(t.start)
  }
  stop()
  await new Promise<void>((r) => server.httpServer.close(() => r()))
  times.sort((a, b) => a - b)
  const result = {
    page: page.name,
    ...Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, `${v.files} file(s), ${kib(v.raw)} (${kib(v.gzip)} gzipped)`])),
    'fetched before live (uncompressed)': Object.entries(loaded[loaded.length - 1]!).map(([k, n]) => `${k} ${kib(n)}`).join(', '),
    'live after (median ms)': Math.round(times[Math.floor(times.length / 2)]!),
    'live after (min–max ms)': `${Math.round(times[0]!)}–${Math.round(times[times.length - 1]!)}`,
  }
  results.push(result)
  console.log(result)
}
process.exit(0)
