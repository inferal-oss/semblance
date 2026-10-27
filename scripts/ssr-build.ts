// Prototype for #201: the landing page rendered at build time into a copy of dist/ (dist-ssr/),
// for measuring first content against today's client-only load. Not the implementation.
//   npm run build && npx tsx scripts/ssr-build.ts
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { todoApp } from '../src/examples/todo.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD, SEM } from '../src/ns.ts'
import { toHTML } from '../src/render/serialize.ts'
import { isExampleSource, recordSources } from '../src/sources.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'

const UI = 'https://semblance.dev/demo#'
const t0 = performance.now()
const dir = new URL('../demo/gallery/', import.meta.url)
const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.ttl')).sort().map((f) => ['demo/gallery/' + f, readFileSync(new URL(f, dir), 'utf8')]))
const store = loadStore('wat', todoApp(5), readFileSync(new URL('../demo/app.ttl', import.meta.url), 'utf8'), ...Object.values(files))
recordSources(store, { 'src/examples/todo.ts': todoApp(5), ...Object.fromEntries(Object.entries(files).filter(([p]) => isExampleSource(p))) })
const f = store.factory
// As the host does before projecting (demo/main.ts): the settings that arrive through the URL.
for (const [p, o] of [['store', 'SemblanceWasm'], ['rules', 'PreferSparql'], ['compile', 'CompileOff']]) {
  for (const q of store.match(f.namedNode(UI + 'app'), f.namedNode(UI + p), null)) store.delete(q)
  store.add(f.quad(f.namedNode(UI + 'app'), f.namedNode(UI + p), f.namedNode(UI + o)))
}
const layers = new Set(store.match(f.namedNode(UI + 'app'), f.namedNode(SEM.enables), null).map((q) => q.object.value))
const screen = new Runtime(store).project({ modality: MOD.Screen, layers, prefer: 'sparql', provenance: true, name: 'screen', roots: [UI + 'shell'] })
const html = toHTML(screen.index, UI + 'shell')
const css = compileStyles(store)
cpSync('dist', 'dist-ssr', { recursive: true })
writeFileSync('dist-ssr/semblance.css', css)
const page = readFileSync('dist/index.html', 'utf8')
  .replace('</head>', '  <link rel="stylesheet" href="./semblance.css" />\n  </head>')
  .replace('<div id="app"></div>', `<div id="app" data-sem-ssr>${html}</div>`)
writeFileSync('dist-ssr/index.html', page)
// Without scripts: what a visitor with JavaScript off (or a crawler) gets.
writeFileSync('dist-ssr/static.html', page.replace(/<script type="module"[^>]*><\/script>/, ''))
console.log(`rendered in ${Math.round(performance.now() - t0)} ms: html ${(html.length / 1024).toFixed(1)} KiB, css ${(css.length / 1024).toFixed(1)} KiB`)
