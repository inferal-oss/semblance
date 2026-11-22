// The guard: every page of the site, in a headless browser, made by Semblance (docs/UNMANAGED.md).
//
//   npx tsx scripts/unmanaged-check.ts                       # a dev server of this checkout
//   npx tsx scripts/unmanaged-check.ts --build               # a production build (dist-guard/), then the check
//   npx tsx scripts/unmanaged-check.ts --dist dist-guard     # an existing build made with VITE_SEMBLANCE_HANDLE=1
//     [--pages /,/components/layout/] [--langs en,ar] [--terms 0] [--no-states] [--width 1280] [--height 900]
//
// It visits every address of the site (the site's own routes: semblance.config.ts), in English by
// default (--langs for more), the Reference's term pages left out but for --terms of them, and on
// the home page a few interactive states: the Tools open on each tab, the command palette open, a
// tooltip shown. On each it scrolls the page through (a live example builds its sandbox once seen)
// and asks the page what it did not make (window.semblance.unmanaged, src/web/unmanaged.ts): every
// visible subtree no rendering made. It fails on a finding that is neither of a kind allowed
// (um:allowed: foreign on purpose) nor allowed by one of the site's exceptions (um:Exception, in
// demo/app.ttl, each with its reason), and on an exception that matched nothing on any page: stale,
// so the list shrinks as what it allows becomes renderings. A failure names the page, the element,
// its category and why, and the nearest component Semblance made, which is what to turn it into a
// rendering of.
//
// One browser, one page at a time: the machine (or the runner) is shared.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { createServer as createHttp } from 'node:http'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'
import { launch, type Cdp } from './cdp.ts'
import { loadSite, siteRoutes } from '../src/node/site.ts'

const here = resolve(import.meta.dirname, '..')
const { values: args } = parseArgs({
  options: {
    build: { type: 'boolean', default: false },
    dist: { type: 'string', default: '' },
    pages: { type: 'string', default: '' },
    langs: { type: 'string', default: 'en' },
    terms: { type: 'string', default: '0' },
    'no-states': { type: 'boolean', default: false },
    width: { type: 'string', default: '1280' },
    height: { type: 'string', default: '900' },
  },
})

type Finding = { category: string; reason: string; path: string; elements: number; near?: string; exception?: string; allowed: boolean }
type Report = { visible: number; managed: number; exceptions: string[]; findings: Finding[] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The addresses to visit: the site's routes in the languages asked for, a Reference term page only for --terms. */
async function routes(): Promise<string[]> {
  if (args.pages) return args.pages.split(',')
  const all = await siteRoutes(await loadSite(join(here, 'semblance.config.ts')))
  const langs = new Set(args.langs!.split(','))
  let terms = Number(args.terms)
  return all.filter((r) => {
    const lang = /^\/(uk|de|ar)\//.exec(r)?.[1] ?? 'en'
    if (!langs.has(lang)) return false
    if (/\/reference\/[^/]+\/$/.test(r)) return terms-- > 0
    return true
  })
}

/** A static server of a build: each address's index.html, the 404 page for what the build did not render. */
function serveDist(dir: string): Promise<{ url: string; close: () => void }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json', '.ttl': 'text/turtle', '.jelly': 'application/octet-stream', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' }
  const server = createHttp((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    let file = join(dir, path)
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    const found = existsSync(file)
    if (!found) file = join(dir, '404.html')
    res.writeHead(found ? 200 : 404, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((ok) => server.listen(0, () => ok({ url: `http://localhost:${(server.address() as { port: number }).port}`, close: () => server.close() })))
}

async function build(outDir: string): Promise<void> {
  console.error(`unmanaged-check: building the site into ${outDir} (VITE_SEMBLANCE_HANDLE=1)…`)
  await new Promise<void>((ok, fail) => {
    const p = spawn('npx', ['vite', 'build', '--outDir', outDir], { cwd: here, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, VITE_SEMBLANCE_HANDLE: '1' } })
    p.on('exit', (code) => (code ? fail(new Error('vite build failed: ' + code)) : ok()))
  })
}

/** Wait until the page has its handle and has stopped changing; a suspended update (the page is busy) is resumed. */
async function settle(cdp: Cdp): Promise<void> {
  for (let i = 0; i < 240; i++) {
    if (await cdp.evaluate<boolean>(`!!window.semblance?.unmanaged`)) break
    await sleep(250)
  }
  let last = -1
  for (let i = 0, still = 0; i < 240 && still < 3; i++) {
    await sleep(250)
    const resumed = await cdp.evaluate<boolean>(`(() => {
      const b = [...document.querySelectorAll('dialog button, [role=dialog] button, [role=alertdialog] button')].find((b) => b.textContent.trim() === 'Continue' && b.getClientRects().length)
      b?.click(); return !!b })()`)
    const n = await cdp.evaluate<number>(`document.getElementsByTagName('*').length + document.body.innerHTML.length`)
    still = n === last && !resumed ? still + 1 : 0
    last = n
  }
}

/** Scroll the page through, so what builds once seen (a live example's sandbox) is there, and back. */
async function scrollThrough(cdp: Cdp): Promise<void> {
  const height = await cdp.evaluate<number>(`document.documentElement.scrollHeight`)
  const step = Number(args.height)
  for (let y = 0; y < height; y += step) {
    await cdp.evaluate(`window.scrollTo(0, ${y})`)
    await sleep(120)
  }
  await cdp.evaluate(`window.scrollTo(0, 0)`)
}

/** Write a triple of the site's state through the page's runtime (as a control would) and patch. */
const SET = `(s, p, o, literal) => { const h = window.semblance, f = h.store.factory, nn = (i) => f.namedNode(i)
  h.runtime.apply({ remove: h.store.match(nn(s), nn(p), null), add: [f.quad(nn(s), nn(p), literal ? f.literal(o, nn('http://www.w3.org/2001/XMLSchema#boolean')) : nn(o))] }); h.shell.flush() }`
const UI = 'https://semblance.dev/demo#'
const C = 'https://semblance.dev/ns/component#'

/** The interactive states on the home page: the Tools on each tab, the palette, a tooltip. */
function states(cdp: Cdp): { name: string; enter: () => Promise<void>; leave: () => Promise<void> }[] {
  const set = (s: string, p: string, o: string, literal = false): Promise<void> => cdp.evaluate<void>(`(${SET})(${JSON.stringify(s)}, ${JSON.stringify(p)}, ${JSON.stringify(o)}, ${literal})`)
  const tabs = ['inspectorTab', 'queryTab', 'activityTab', 'logTab', 'memoryTab', 'engineTab']
  const out = tabs.map((t) => ({
    name: `Tools › ${t.replace(/Tab$/, '')}`,
    enter: async () => {
      await set(UI + 'tools', C + 'open', 'true', true)
      await set(UI + 'views', C + 'selected', UI + t)
    },
    leave: () => set(UI + 'tools', C + 'open', 'false', true),
  }))
  out.push({
    name: 'Tools › Inspector › Not made by Semblance',
    enter: async () => {
      await set(UI + 'tools', C + 'open', 'true', true)
      await set(UI + 'views', C + 'selected', UI + 'inspectorTab')
      await set(UI + 'app', UI + 'inspects', UI + 'unmanaged')
    },
    leave: async () => {
      await set(UI + 'app', UI + 'inspects', UI + 'ElementView')
      await set(UI + 'tools', C + 'open', 'false', true)
    },
  })
  out.push({ name: 'command palette', enter: () => set(UI + 'palette', C + 'open', 'true', true), leave: () => set(UI + 'palette', C + 'open', 'false', true) })
  out.push({
    name: 'a tooltip',
    enter: async () => {
      // The pointer over the first visible element that has one, as a visitor's.
      const at = await cdp.evaluate<{ x: number; y: number } | null>(`(() => {
        const el = [...document.querySelectorAll('[data-sem-tooltip]')].find((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && r.top >= 0 && r.bottom <= innerHeight })
        if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
      if (!at) return
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
      await sleep(1200)
    },
    leave: async () => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
      await sleep(400)
    },
  })
  return out
}

async function main() {
  let base: string
  let close: () => void | Promise<void>
  if (args.build || args.dist) {
    const dir = resolve(here, args.dist || 'dist-guard')
    if (args.build) await build(dir)
    const s = await serveDist(dir)
    base = s.url
    close = s.close
  } else {
    const allow = [here, realpathSync(join(here, 'node_modules'))]
    const server = await createServer({ configFile: join(here, 'vite.config.ts'), root: join(here, 'demo'), server: { port: 0, strictPort: false, fs: { allow } }, logLevel: 'warn' })
    await server.listen()
    base = `http://localhost:${(server.httpServer!.address() as { port: number }).port}`
    close = () => server.close()
  }
  const pages = await routes()
  const { cdp, stop } = await launch()
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: Number(args.width), height: Number(args.height), deviceScaleFactor: 1, mobile: false })
  const failures: string[] = []
  const used = new Set<string>()
  let declared: string[] = []
  let visible = 0
  let managed = 0
  const check = async (where: string) => {
    const r = await cdp.evaluate<Report>(`window.semblance.unmanaged()`)
    declared = r.exceptions
    visible += r.visible
    managed += r.managed
    for (const f of r.findings) {
      if (f.exception) used.add(f.exception)
      if (f.allowed || f.exception) continue
      failures.push(`${where}\n    ${f.category} (${f.reason}): ${f.path}\n    ${f.elements} visible element${f.elements === 1 ? '' : 's'}; nearest Semblance component: ${f.near ?? '(none)'}`)
    }
  }
  const t0 = Date.now()
  try {
    for (const [i, page] of pages.entries()) {
      await cdp.send('Page.navigate', { url: base + page })
      await settle(cdp)
      await scrollThrough(cdp)
      await settle(cdp)
      await check(page)
      if (page === '/' && !args['no-states']) {
        for (const s of states(cdp)) {
          await s.enter()
          await settle(cdp)
          await check(`${page} (${s.name})`)
          await s.leave()
        }
      }
      if ((i + 1) % 10 === 0) console.error(`unmanaged-check: ${i + 1}/${pages.length} pages, ${failures.length} failing`)
    }
  } finally {
    stop()
    await close()
  }
  // Only a full run can tell an exception that matched nothing from one whose page was not visited.
  const full = !args.pages && !args['no-states']
  const stale = full ? declared.filter((x) => !used.has(x)) : []
  const secs = Math.round((Date.now() - t0) / 1000)
  console.log(`unmanaged-check: ${pages.length} pages in ${secs} s; ${managed} of ${visible} visible elements made by Semblance; ${used.size} of ${declared.length} exceptions in use.`)
  if (failures.length) {
    console.log(`\nNot made by Semblance, and no exception allows it (${failures.length}):\n`)
    for (const f of failures) console.log('  ' + f + '\n')
    console.log(`Make it a rendering (AGENTS.md, ground rules 1 and 2). If it must stay as it is, add a um:Exception to demo/app.ttl
with um:selector or um:slot, um:because (why) and um:issue (what removes it): docs/UNMANAGED.md.`)
  }
  if (stale.length) {
    console.log(`\nExceptions that matched nothing on any page (stale: remove them from demo/app.ttl):\n`)
    for (const x of stale) console.log('  ' + x)
  }
  if (failures.length || stale.length) process.exit(1)
}

await main()
