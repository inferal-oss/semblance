// Prototype for #201: the site's load, phase by phase, in Node, and the landing page rendered
// to static HTML (toHTML) as a build would. Not a test; numbers for the design discussion.
//   npx tsx scripts/ssr-measure.ts [store=wat] [page=Home]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { todoApp } from '../src/examples/todo.ts'
import { createStore, ontologySources, type StoreKind } from '../src/node/load.ts'
import { MOD, SEM } from '../src/ns.ts'
import { isExampleSource, recordSources } from '../src/sources.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'
import { toHTML } from '../src/render/serialize.ts'
import { HtmlIndex } from '../src/render/html-index.ts'
import { Writer } from 'n3'
import { Format } from '../rdf-engine/host/engine.ts'

const UI = 'https://semblance.dev/demo#'
const kind = (process.argv[2] ?? 'wat') as StoreKind
const page = process.argv[3]
const kb = (n: number) => (n / 1024).toFixed(1) + ' KiB'
const t: Record<string, number> = {}
let last = performance.now()
const lap = (name: string) => {
  const now = performance.now()
  t[name] = (t[name] ?? 0) + now - last
  last = now
}

const appGraph = readFileSync(new URL('../demo/app.ttl', import.meta.url), 'utf8')
const dir = new URL('../demo/gallery/', import.meta.url)
const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.ttl')).sort().map((f) => ['demo/gallery/' + f, readFileSync(new URL(f, dir), 'utf8')]))
const ontology = ontologySources()
lap('read sources')
const store = createStore(kind)
lap('engine instantiate')
let bytes = 0
for (const ttl of ontology) store.loadTurtle(ttl), (bytes += ttl.length)
lap('load ontology turtle')
for (const ttl of [todoApp(5), appGraph, ...Object.values(files)]) store.loadTurtle(ttl), (bytes += ttl.length)
recordSources(store, { 'src/examples/todo.ts': todoApp(5), ...Object.fromEntries(Object.entries(files).filter(([p]) => isExampleSource(p))) })
lap('load app turtle')
const f = store.factory
if (page) {
  for (const q of store.match(f.namedNode(UI + 'app'), f.namedNode(UI + 'page'), null)) store.delete(q)
  store.add(f.quad(f.namedNode(UI + 'app'), f.namedNode(UI + 'page'), f.namedNode(UI + page)))
}
const runtime = new Runtime(store)
const layers = new Set(store.match(f.namedNode(UI + 'app'), f.namedNode(SEM.enables), null).map((q) => q.object.value))
const screen = runtime.project({ modality: MOD.Screen, layers, prefer: 'sparql', provenance: true, name: 'screen', roots: [UI + 'shell'] })
lap('first projection (rules)')
const css = compileStyles(store)
lap('compile styles')
const html = toHTML(screen.index, UI + 'shell')
lap('serialize html')
const quads = store.size?.() ?? 0
// A snapshot of the derived graph: the projection's triples as N-Quads, and how fast they come back.
const derived = store.match(null, null, null, screen.engine.graph)
const nq = (qs: typeof derived) => new Writer({ format: 'N-Quads' }).quadsToString(qs)
const derivedNq = nq(derived)
lap('derived graph to N-Quads')
const all = store.match(null, null, null)
const allNq = nq(all)
lap('whole store to N-Quads')
const fresh = createStore(kind) as unknown as { engine: { load(f: number, t: string): number; x: { memory: WebAssembly.Memory } } }
fresh.engine.load(Format.NQuads, allNq)
lap('whole store from N-Quads')
const index = new HtmlIndex()
index.apply({ add: derived, remove: [] })
lap('index from derived quads')
const same = toHTML(index, UI + 'shell') === html
const memory = (store as unknown as { engine: { x: { memory: WebAssembly.Memory } } }).engine.x.memory.buffer
const image = gzipSync(new Uint8Array(memory))
lap('memory image gzip')
const snapshot = { derivedQuads: derived.length, derivedNq: kb(derivedNq.length), derivedNqGzip: kb(gzipSync(derivedNq).length), storeQuads: all.length, storeNq: kb(allNq.length), storeNqGzip: kb(gzipSync(allNq).length), indexFromSnapshotSameHtml: same, wasmMemory: kb(memory.byteLength), wasmMemoryGzip: kb(image.length), engineBookkeeping: screen.engine.footprint(), views: runtime.views.footprint() }
console.log(JSON.stringify({ kind, page: page ?? 'default', ms: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, +v.toFixed(1)])), turtle: kb(bytes), quads, ruleRuns: screen.engine.stats.ruleRuns, html: kb(html.length), htmlGzip: kb(gzipSync(html).length), htmlBrotli: kb(brotliCompressSync(html).length), css: kb(css.length), cssGzip: kb(gzipSync(css).length), nodes: screen.index.nodes.size, snapshot }, null, 1))
writeFileSync(`${process.env.SSR_OUT ?? '/tmp'}/ssr-${page ?? 'default'}.html`, html)
