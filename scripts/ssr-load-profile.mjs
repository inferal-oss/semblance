// semblance.dev's load in Chrome (#201), phase by phase (the sem:* marks in
// demo/boot.ts and demo/main.ts), on a cold and a warm cache, at desktop speed and at a throttled
// phone's (Lighthouse's Slow 4G: 150 ms, 1.6 Mbps down, 750 kbps up, 4x CPU). Serves dist/ as
// GitHub Pages does (gzip, max-age=600) unless a URL is given. Not a test; numbers for the design.
//   npm run build && node scripts/ssr-load-profile.mjs [url] [--runs=3] [--dist=dist]
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const args = process.argv.slice(2)
const runs = Number(args.find((a) => a.startsWith('--runs='))?.slice(7) ?? 3)
const dist = resolve(args.find((a) => a.startsWith('--dist='))?.slice(7) ?? 'dist')
const path = args.find((a) => a.startsWith('--path='))?.slice(7) ?? ''
const waitFor = args.find((a) => a.startsWith('--wait='))?.slice(7) ?? 'sem:ready'
const only = args.find((a) => a.startsWith('--only='))?.slice(7)
let url = args.find((a) => !a.startsWith('--'))
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain' }
let server
if (!url) {
  const gz = new Map()
  server = createServer((req, res) => {
    let path = decodeURIComponent(req.url.split(/[?#]/)[0])
    if (path.endsWith('/')) path += 'index.html'
    const file = join(dist, path)
    if (!file.startsWith(dist) || !existsSync(file)) return res.writeHead(404).end()
    const type = TYPES[extname(file)] ?? 'application/octet-stream'
    let body = gz.get(file)
    if (!body) gz.set(file, (body = gzipSync(readFileSync(file), { level: 6 })))
    res.writeHead(200, { 'Content-Type': type, 'Content-Encoding': 'gzip', 'Cache-Control': 'max-age=600' }).end(body)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${server.address().port}/${path}`
}

const profileDir = mkdtempSync(join(tmpdir(), 'sem-ssr-'))
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
const wsUrl = await new Promise((resolveUrl, reject) => {
  let err = ''
  chrome.stderr.on('data', (d) => {
    err += d
    const m = /DevTools listening on (ws:\S+)/.exec(err)
    if (m) resolveUrl(m[1])
  })
  chrome.on('exit', () => reject(new Error('Chrome exited: ' + err)))
})

const ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let nextId = 1
const pending = new Map()
const listeners = new Set()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const { resolve: ok, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : ok(m.result)
  } else for (const l of listeners) l(m)
})
const send = (method, params = {}, sessionId) =>
  new Promise((ok, reject) => {
    const id = nextId++
    pending.set(id, { resolve: ok, reject })
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })

// Records when #app first has content and the first contentful paint, as marks.
const OBSERVE = `
window.__muts = []
const record = (ms) => {
  for (const m of ms) if (window.__muts.length < 400) window.__muts.push(m.type + ' ' + (m.target.getAttribute?.('data-sem-c') ?? m.target.nodeName) + ' ' + (m.attributeName ?? '') + ' +' + m.addedNodes.length + ' -' + m.removedNodes.length + ' ' + [...m.addedNodes].map((n) => n.nodeName + ':' + (n.getAttribute?.('data-sem-c') ?? (n.data ?? '').slice(0, 20))).join(','))
}
let watching = false
new MutationObserver((_, o) => {
  const app = document.getElementById('app')
  if (app && !watching && document.querySelector('script[type=module]')) watching = true, new MutationObserver(record).observe(app, { childList: true, subtree: true, attributes: true, characterData: true })
  if (app?.firstChild) { performance.mark('sem:firstContent'); o.disconnect() }
}).observe(document, { childList: true, subtree: true })`

const PROFILES = {
  desktop: { cpu: 1, net: null },
  phone: { cpu: 4, net: { offline: false, latency: 150, downloadThroughput: (1.6e6 / 8) | 0, uploadThroughput: (750e3 / 8) | 0 } },
}

async function load(sessionId, waitMs = 60000) {
  await send('Page.navigate', { url }, sessionId)
  const t0 = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 100))
    const { result } = await send('Runtime.evaluate', { expression: `performance.getEntriesByName('${waitFor}').length`, returnByValue: true }, sessionId).catch(() => ({ result: { value: 0 } }))
    if (result.value) { await new Promise((r) => setTimeout(r, 1500)); break }
    if (Date.now() - t0 > waitMs) throw new Error('timed out waiting for sem:ready')
  }
  const { result } = await send(
    'Runtime.evaluate',
    {
      returnByValue: true,
      expression: `(() => {
        const nav = performance.getEntriesByType('navigation')[0]
        const marks = Object.fromEntries(performance.getEntriesByType('mark').map((m) => [m.name, m.startTime]))
        const paint = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, p.startTime]))
        const res = performance.getEntriesByType('resource').map((r) => ({ name: r.name.split('/').pop(), start: r.startTime, end: r.responseEnd, transfer: r.transferSize, body: r.decodedBodySize }))
        const detail = (n) => performance.getEntriesByName(n)[0]?.detail
        return { muts: window.__muts, adopted: detail('sem:adopted'), patchOps: JSON.stringify(detail('sem:patch')), html: nav.responseEnd, dcl: nav.domContentLoadedEventEnd, marks, paint, res }
      })()`,
    },
    sessionId,
  )
  return result.value
}

async function context(profile) {
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Page.bringToFront', {}, sessionId)
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)
  await send('Network.enable', {}, sessionId)
  await send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVE }, sessionId)
  await send('Emulation.setCPUThrottlingRate', { rate: PROFILES[profile].cpu }, sessionId)
  if (PROFILES[profile].net) await send('Network.emulateNetworkConditions', PROFILES[profile].net, sessionId)
  return { sessionId, close: () => send('Target.disposeBrowserContext', { browserContextId }) }
}

const PHASES = [
  ['html', null, 'html'],
  ['scripts (fetch, parse, run bundles)', 'html', 'sem:main'],
  ['engine wasm (fetch + compile)', 'sem:main', 'sem:wasm'],
  ['turtle parse + store load', 'sem:wasm', 'sem:store'],
  ['restore (persistence, address)', 'sem:store', 'sem:restore'],
  ['first rule run (projection)', 'sem:restore', 'sem:rules'],
  ['compile styles', 'sem:rules', 'sem:styles'],
  ['sandboxes created', 'sem:styles', 'sem:sandboxes'],
  ['sandboxes attached', 'sem:sandboxes', 'sem:sandboxesAttached'],
  ['first DOM patch', 'sem:sandboxesAttached', 'sem:patch'],
  ['effects attached, settings', 'sem:patch', 'sem:ready'],
]
const at = (r, k) => (k === null ? 0 : k === 'html' ? r.html : (r.marks[k] ?? NaN))
const median = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1]

const results = {}
for (const profile of Object.keys(PROFILES).filter((p) => !only || only.split(',').includes(p))) {
  for (const cache of ['cold', 'warm']) {
    const samples = []
    for (let i = 0; i < runs; i++) {
      const ctx = await context(profile)
      if (cache === 'warm') await load(ctx.sessionId) // fills the HTTP (and code) cache
      samples.push(await load(ctx.sessionId))
      await ctx.close()
    }
    results[`${profile} ${cache}`] = samples
  }
}

const rows = PHASES.map(([name, from, to]) => [name, ...Object.values(results).map((s) => median(s.map((r) => at(r, to) - at(r, from))))])
rows.push(['**first content (#app has nodes)**', ...Object.values(results).map((s) => median(s.map((r) => r.marks['sem:firstContent'])))])
rows.push(['**first contentful paint**', ...Object.values(results).map((s) => median(s.map((r) => r.paint['first-contentful-paint'] ?? NaN)))])
rows.push(['**ready (effects attached)**', ...Object.values(results).map((s) => median(s.map((r) => r.marks['sem:ready'])))])
const transfer = Object.values(results).map((s) => median(s.map((r) => r.res.reduce((n, x) => n + (x.transfer || 0), 0))))
console.log(`${url} — median of ${runs} runs, ms\n`)
console.log(`| phase | ${Object.keys(results).join(' | ')} |\n|---|${Object.keys(results).map(() => '--:').join('|')}|`)
for (const [name, ...v] of rows) console.log(`| ${name} | ${v.map((x) => (Number.isFinite(x) ? Math.round(x) : '–')).join(' | ')} |`)
console.log(`| transferred (KiB) | ${transfer.map((x) => (x / 1024).toFixed(0)).join(' | ')} |`)
const sample = Object.values(results)[0][0]
for (const [k, s] of Object.entries(results)) console.log(`${k}: adopted ${JSON.stringify(s[0].adopted)}, DOM ops at first patch ${s[0].patchOps}`)
if (process.env.MUTS) { const c = {}; for (const m of Object.values(results)[0][0].muts) c[m] = (c[m] ?? 0) + 1; console.log(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 25)) }
console.log('\nresources (first cold sample):')
for (const r of sample.res.filter((r) => r.body > 10000)) console.log(`  ${r.name}: ${(r.transfer / 1024).toFixed(0)} KiB over the wire, ${(r.body / 1024).toFixed(0)} KiB, ${Math.round(r.start)}–${Math.round(r.end)} ms`)

ws.close()
chrome.kill()
server?.close()
await new Promise((r) => chrome.once('exit', r))
rmSync(profileDir, { recursive: true, force: true })
