// Where the site's memory goes while a person clicks through pages: a production build in headless
// Chromium, the JS heap and every WebAssembly memory sampled through a walk of a section's pages,
// with a breakdown at each step (store, graphs, engines, index, views, sandboxes) and the settling
// after the walk.
//
//   VITE_SEMBLANCE_HANDLE=1 npx vite build --outDir dist-measure   # a build with window.semblance
//   npx tsx scripts/memory-walk.ts --dist dist-measure --walk /examples/todo/
//   … --passes 2 --gc            # force a full GC before each reading (what is retained, not transient)
//   … --settle 60                # seconds to sample after the walk
//   … --graphs                   # triples by graph at each step (a SPARQL count: costs a little)
//   … --gc-final                 # a full GC before the last reading only
//   … --snapshot out.heapsnapshot   # a heap snapshot at the end, after a GC (--snapshot-base: also after the idle baseline,
//                                   # out.base.heapsnapshot)
//                                   # (scripts/heap-summary.ts summarises them by constructor)
//   … --sampling                 # allocation sampling over the walk: the functions that allocate most
//   … --channel chrome            # the installed Chrome (default: Playwright's Chromium, 143)
//   … --base https://semblance.dev   # the deployed site (no window.semblance: heap and wasm only)
//   … --json out.json
//
// Samples every 200 ms: usedJSHeapSize (precise), each live WebAssembly.Memory's byteLength (found by
// wrapping WebAssembly's constructors in an init script, so no build is changed for it), and
// Runtime.getHeapUsage (V8's used size, and the backing stores: array buffers, wasm memory).
import { createReadStream, existsSync, statSync, writeFileSync, createWriteStream } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { chromium, type CDPSession, type Page } from 'playwright-core'

const args = process.argv.slice(2)
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? (args[i + 1]?.startsWith('--') ? 'true' : (args[i + 1] ?? 'true')) : fallback
}
const here = resolve(import.meta.dirname, '..')
const dist = resolve(here, opt('dist', 'dist')!)
const path = opt('walk', '/examples/todo/')!
const passes = Number(opt('passes', '1'))
const forceGc = opt('gc') === 'true'
const settleS = Number(opt('settle', '30'))
const quietMs = Number(opt('quiet', '400'))
const limit = Number(opt('limit', '1000'))
const MIB = 2 ** 20
const mib = (n: number | undefined) => (n === undefined ? '-' : (n / MIB).toFixed(0))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttl': 'text/turtle', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml', '.jelly': 'application/octet-stream' }
function serve(root: string): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url!, 'http://x').pathname)
    let file = join(root, p)
    if (!file.startsWith(root)) return void res.writeHead(403).end()
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    let status = 200
    if (!existsSync(file)) {
      if (existsSync(file + '.html')) file += '.html'
      else ((file = join(root, '404.html')), (status = 404))
    }
    res.writeHead(status, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  return new Promise((ok) => server.listen(0, () => ok({ server, base: `http://localhost:${(server.address() as { port: number }).port}` })))
}

// In the page, before anything runs: every WebAssembly.Memory the page makes, by who made it.
function wasmProbe() {
  const W = WebAssembly as any
  const live: { ref: WeakRef<WebAssembly.Memory>; at: number; kind: string }[] = []
  ;(globalThis as any).__semMemories = live
  const note = (m: unknown, kind: string) => {
    if (m instanceof WebAssembly.Memory && !live.some((x) => x.ref.deref() === m)) live.push({ ref: new WeakRef(m), at: performance.now(), kind })
  }
  const exportsOf = (inst: WebAssembly.Instance, kind: string) => {
    for (const v of Object.values(inst.exports)) note(v, kind)
  }
  const kindOf = (bytes: unknown) => {
    const n = bytes instanceof ArrayBuffer ? bytes.byteLength : ArrayBuffer.isView(bytes) ? bytes.byteLength : bytes instanceof WebAssembly.Module ? -1 : 0
    return n < 0 ? 'module' : n > 300_000 ? 'large' : n > 0 ? 'small' : '?'
  }
  const moduleKind = new WeakMap<WebAssembly.Module, string>()
  const M = W.Memory
  W.Memory = function (d: WebAssembly.MemoryDescriptor) {
    const m = new M(d)
    note(m, 'js')
    return m
  }
  W.Memory.prototype = M.prototype
  const I = W.Instance
  W.Instance = function (mod: WebAssembly.Module, imports?: WebAssembly.Imports) {
    const i = new I(mod, imports)
    exportsOf(i, moduleKind.get(mod) ?? 'instance')
    return i
  }
  W.Instance.prototype = I.prototype
  const Mod = W.Module
  W.Module = function (bytes: BufferSource) {
    const m = new Mod(bytes)
    moduleKind.set(m, kindOf(bytes))
    return m
  }
  W.Module.prototype = Mod.prototype
  for (const name of ['instantiate', 'instantiateStreaming'] as const) {
    const f = W[name]
    W[name] = async function (src: unknown, imports?: WebAssembly.Imports) {
      const r = await f.call(W, src, imports)
      if (r instanceof WebAssembly.Instance) exportsOf(r, (src instanceof WebAssembly.Module && moduleKind.get(src)) || 'instance')
      else {
        moduleKind.set(r.module, name === 'instantiate' ? kindOf(src) : 'streamed')
        exportsOf(r.instance, moduleKind.get(r.module)!)
      }
      return r
    }
  }
  const C = W.compile
  W.compile = async (b: BufferSource) => {
    const m = await C.call(W, b)
    moduleKind.set(m, kindOf(b))
    return m
  }
}

interface Reading {
  label: string
  t: number
  heap: number
  heapAfterGc?: number
  v8Used?: number
  backing?: number
  wasm: number
  memories: { kind: string; mib: number; age: number }[]
  detail?: Record<string, unknown>
}

const { server, base } = opt('base') ? { server: undefined, base: opt('base')!.replace(/\/$/, '') } : await serve(dist)
// --channel chrome (the installed Chrome) or --executable <path>. Which Chromium matters: up to 143
// (Playwright's own build) usedJSHeapSize counts WebAssembly memory, from 151 on it does not, and V8
// collects later when it does not (#552). The figures to trust are v8 used and wasm, apart.
const browser = await chromium.launch({ args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'], channel: opt('channel'), executablePath: opt('executable') })
console.error(`browser ${browser.version()}`)
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.addInitScript({ content: `globalThis.__name ??= (f) => f;(${wasmProbe})()` })
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
await cdp.send('HeapProfiler.enable')

const pageState = (p: Page) =>
  p.evaluate(() => {
    const live = ((globalThis as any).__semMemories ?? []) as { ref: WeakRef<WebAssembly.Memory>; at: number; kind: string }[]
    const memories = live.flatMap((x) => {
      const m = x.ref.deref()
      return m ? [{ kind: x.kind, mib: Math.round(m.buffer.byteLength / 2 ** 20), age: Math.round((performance.now() - x.at) / 1000) }] : []
    })
    return { heap: (performance as any).memory.usedJSHeapSize as number, wasm: memories.reduce((n, m) => n + m.mib, 0) * 2 ** 20, memories, t: performance.now() }
  })

const v8 = async (c: CDPSession) => {
  const u = (await c.send('Runtime.getHeapUsage' as any)) as { usedSize: number; totalSize: number; backingStorageSize?: number }
  return { v8Used: u.usedSize, backing: u.backingStorageSize }
}

// What the app's own structures hold (window.semblance, a VITE_SEMBLANCE_HANDLE build).
const detail = (p: Page, graphs: boolean) =>
  p.evaluate((graphs) => {
    const s = (window as any).semblance
    if (!s) return undefined
    const { runtime, store, sandboxes } = s
    const out: Record<string, unknown> = {}
    out.triples = store.size?.()
    out.liveMiB = store.liveBytes ? Math.round(store.liveBytes() / 2 ** 20) : undefined
    out.storeMiB = store.memoryBytes ? Math.round(store.memoryBytes() / 2 ** 20) : undefined
    out.compacting = store.compacting?.()
    out.storeFootprint = store.footprint?.()
    out.runtime = runtime.footprint?.()
    out.views = runtime.views?.footprint?.()
    out.pressure = runtime.pressure
    out.projections = runtime.projections.map((pr: any) => ({ modality: pr.engine.modality.split('#').pop(), derived: pr.engine.derivedSize, engine: pr.engine.footprint(), index: pr.index.footprint() }))
    out.dom = document.getElementsByTagName('*').length
    const mounted = sandboxes?.mounted as Map<string, any> | undefined
    if (mounted) out.sandboxes = [...mounted.values()].map((m) => ({ built: !!m.sandbox, triples: m.sandbox?.runtime?.store?.size?.(), mib: m.sandbox?.runtime?.store?.memoryBytes ? Math.round(m.sandbox.runtime.store.memoryBytes() / 2 ** 20) : undefined }))
    if (graphs) {
      const rows = store.select('SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g', [store.factory.defaultGraph()]) as Map<string, any>[]
      const byGraph: Record<string, number> = {}
      for (const r of rows) {
        const g = String(r.get('g')?.value).replace(/^urn:semblance:/, '').replace(/^https:\/\/semblance\.dev\//, '/')
        const key = /^\/|^page/.test(g) ? 'page graphs' : g
        byGraph[key] = (byGraph[key] ?? 0) + Number(r.get('n')?.value)
      }
      byGraph.default = Number((store.select('SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }', [store.factory.defaultGraph()]) as Map<string, any>[])[0]?.get('n')?.value)
      out.byGraph = byGraph
    }
    return out
  }, graphs)

// Sampling in the background: the timeline (peak, settling).
const timeline: { t: number; label: string; heap: number; wasm: number }[] = []
let label = 'load'
let sampling = true
const sampler = (async () => {
  while (sampling) {
    try {
      const s = await pageState(page)
      timeline.push({ t: Math.round(s.t), label, heap: s.heap, wasm: s.wasm })
    } catch {}
    await sleep(200)
  }
})()

const frames = () => page.evaluate(() => (window as any).__semLast ?? 0)
await context.addInitScript({
  content: `new MutationObserver(() => { globalThis.__semLast = performance.now() }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })`,
})
async function settle(capMs = 20_000) {
  const start = Date.now()
  while (Date.now() - start < capMs) {
    await sleep(150)
    const [t, last] = await page.evaluate(() => [performance.now(), (globalThis as any).__semLast ?? 0])
    if (t - last >= quietMs) return
  }
}

let chunkTo: ((c: string) => void) | undefined
cdp.on('HeapProfiler.addHeapSnapshotChunk' as any, (e: any) => chunkTo?.(e.chunk))
/** A heap snapshot after a full GC, streamed to a file. */
async function snapshot(file: string) {
  await cdp.send('HeapProfiler.collectGarbage')
  const out = createWriteStream(file)
  chunkTo = (c) => out.write(c)
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  chunkTo = undefined
  await new Promise((r) => out.end(r))
  console.error(`snapshot: ${file}`)
}

const readings: Reading[] = []
async function read(name: string, graphs = opt('graphs') === 'true') {
  const s = await pageState(page)
  const r: Reading = { label: name, t: Math.round(s.t), heap: s.heap, wasm: s.wasm, memories: s.memories, ...(await v8(cdp)) }
  if (forceGc || (name === 'final' && opt('gc-final') === 'true')) {
    await cdp.send('HeapProfiler.collectGarbage')
    await cdp.send('HeapProfiler.collectGarbage')
    const g = await pageState(page)
    r.heapAfterGc = g.heap
    r.wasm = g.wasm
    r.memories = g.memories
  }
  r.detail = await detail(page, graphs)
  readings.push(r)
  const d = r.detail as any
  console.error(
    `${name.padEnd(36)} heap ${mib(r.heap).padStart(4)}${r.heapAfterGc !== undefined ? ` (gc ${mib(r.heapAfterGc)})` : ''} wasm ${mib(r.wasm).padStart(4)} [${r.memories.map((m) => m.mib).join(' ')}] backing ${mib(r.backing)}` +
      (d ? ` triples ${Math.round(d.triples / 1000)}k live ${d.liveMiB} derived ${d.projections.map((p: any) => Math.round(p.derived / 1000) + 'k').join('/')} dom ${d.dom}${d.sandboxes ? ` sandboxes ${d.sandboxes.filter((x: any) => x.built).length}/${d.sandboxes.length}` : ''}` : ''),
  )
  return r
}

if (opt('sampling') === 'true') await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32768 })
const t0 = Date.now()
await page.goto(base + path)
await page.waitForFunction(() => performance.getEntriesByName('sem:ready').length > 0 || document.querySelector('[data-sem-c]'), null, { timeout: 60_000 })
await read('first paint', false)
if (await page.evaluate(() => !!document.querySelector('meta[name=semblance-graphs]'))) await page.waitForFunction(() => performance.getEntriesByName('sem:graphs').length > 0, null, { timeout: 60_000 }).catch(() => {})
await settle(60_000)
console.error(`interactive and quiet after ${((Date.now() - t0) / 1000).toFixed(1)} s`)
await read('baseline (graphs loaded, quiet)')
// Idle warming and anticipation run on: wait for the heap to stop moving.
await sleep(Number(opt('warm', '10')) * 1000)
await read('baseline + idle')
if (opt('snapshot') && opt('snapshot-base') === 'true') await snapshot(opt('snapshot')!.replace(/(\.heapsnapshot)?$/, '.base.heapsnapshot'))

const list = page.locator('[data-sem-c=nav-list]').filter({ visible: true }).first()
const names = (await list.getByRole('button').allTextContents()).map((n) => n.trim()).slice(0, limit)
let current = (await list.locator('button[aria-pressed=true]').textContent())?.trim()
for (let pass = 1; pass <= passes; pass++)
  for (const name of names) {
    if (name === current) continue
    label = `p${pass} ${name}`
    await list.getByRole('button', { name, exact: true }).click()
    await settle()
    current = name
    await read(label)
  }
label = 'settling'
const end = Date.now()
const sampleAt = [1, 3, 5, 10, 20, 30, 60, 120].filter((s) => s <= settleS)
for (const s of sampleAt) {
  await sleep(end + s * 1000 - Date.now())
  await read(`settled +${s}s`, false)
}
if (opt('sampling') === 'true') {
  const { profile } = (await cdp.send('HeapProfiler.stopSampling')) as any
  const self = new Map<string, number>()
  const walkNode = (n: any, stack: string[]) => {
    const f = n.callFrame
    const name = `${f.functionName || '(anon)'} ${String(f.url).split('/').pop()}:${f.lineNumber}`
    if (n.selfSize) self.set(name, (self.get(name) ?? 0) + n.selfSize)
    for (const c of n.children) walkNode(c, [...stack, name])
  }
  walkNode(profile.head, [])
  console.error('allocation sampling (live at stop, by function, self MiB):')
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.error(`  ${mib(v).padStart(5)}  ${k}`)
  if (opt('json')) writeFileSync(opt('json')!.replace(/\.json$/, '') + '.sampling.json', JSON.stringify(profile))
}
await read('final', true)
if (opt('snapshot')) await snapshot(opt('snapshot')!)
sampling = false
await sampler
const peak = timeline.reduce((a, b) => (b.heap + b.wasm > a.heap + a.wasm ? b : a), timeline[0]!)
const peakHeap = timeline.reduce((a, b) => (b.heap > a.heap ? b : a), timeline[0]!)
console.error(`peak heap+wasm ${mib(peak.heap + peak.wasm)} (heap ${mib(peak.heap)}, wasm ${mib(peak.wasm)}) at ${peak.label}; peak heap ${mib(peakHeap.heap)} at ${peakHeap.label}`)
if (opt('json')) writeFileSync(opt('json')!, JSON.stringify({ base, path, passes, forceGc, readings, timeline }, null, 1))
await browser.close()
server?.close()
