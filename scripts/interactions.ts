// How long the site takes from a person's input to what it shows (#379): each interaction below,
// cold (the first after the page loaded, its graphs still arriving), first (the first once the
// page has everything and is quiet) and warm (repeated), at desktop and phone width, without and
// with 4× CPU throttling. It writes a table (interaction, mode, width, throttle, next paint, largest
// paint, settled, longest task, rule runs; medians of the runs) and fails when a first or warm,
// unthrottled measurement misses the targets: next paint under 200 ms, a page change's largest
// paint under 1 s, no long task over 200 ms.
//
//   npm run perf:interactions                       # the local static build (dist/, `npm run build`)
//   npm run perf:interactions -- --base https://semblance.dev
//   … --only nav,todo --runs 5 --widths desktop --throttle 1 --modes warm --browser webkit
//   … --json out.json --out table.md
//   … --table a.json,b.json                         # the table of saved runs, together
//
// What is measured, in the page (Event Timing, Long Tasks and Long Animation Frames, a mutation
// observer), from the input's timestamp:
//   next paint     the interaction's Event Timing duration (to the frame after its handlers: INP);
//                  where Event Timing is missing (WebKit), the frame after the input's task
//   largest paint  the frame that changed the largest visible area (an element's box, clipped to
//                  the viewport), as LCP picks its candidate: what a page change shows
//   settled        the last frame that changed anything visible, before a quiet second
//   longest task   the longest task (Chromium) between the input and settling
//   runs           rule runs of the events handled meanwhile (the `sem:turn` marks; none on older
//                  builds)
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { type Browser, type BrowserContext, chromium, type Page, webkit } from 'playwright-core'

// --- options -------------------------------------------------------------------------------

const args = process.argv.slice(2)
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const list = (name: string, fallback: string) => opt(name, fallback)!.split(',').filter(Boolean)
const here = resolve(import.meta.dirname, '..')
const dist = resolve(here, opt('dist', 'dist')!)
const runs = Number(opt('runs', '3'))
const only = opt('only')?.split(',')
const widths = list('widths', 'desktop,phone') as Width[]
const throttles = list('throttle', '1,4').map(Number)
const modes = list('modes', 'cold,first,warm') as Mode[]
const browserName = opt('browser', 'chromium')!
const quietMs = Number(opt('quiet', '1000'))

type Width = 'desktop' | 'phone'
type Mode = 'cold' | 'first' | 'warm'

/** The targets (#379): warm, unthrottled. */
export const TARGETS = { nextPaint: 200, pageLargestPaint: 1000, longTask: 200 }

// --- interactions --------------------------------------------------------------------------

interface Ctx {
  page: Page
  phone: boolean
  throttle: number
}
interface Interaction {
  id: string
  /** Where it starts. */
  path: string
  /** Whether it changes the page (its largest paint is held to the page-change target). */
  pageChange?: boolean
  /** Unmeasured, before each measured act (open a menu, focus a field). */
  prepare?: (c: Ctx) => Promise<void>
  /** The measured input. */
  act: (c: Ctx) => Promise<void>
  /** Unmeasured, after a warm act: back to where the act starts. */
  undo?: (c: Ctx) => Promise<void>
}

const button = (c: Ctx, name: string | RegExp, within = '') => (within ? c.page.locator(within) : c.page).getByRole('button', { name, exact: typeof name === 'string' }).first()
const click = (c: Ctx, name: string | RegExp, within = '') => button(c, name, within).click()
/** The site's page switcher: buttons, or a picker where the app bar has no room for them. */
const nav = async (c: Ctx, label: string) => {
  const picker = c.page.locator('select[aria-label="Page"]')
  if (c.phone && (await picker.isVisible())) await picker.selectOption({ label })
  else await click(c, label, '[data-sem-c=segmented][aria-label="Page"]')
}
/** A section's own list of pages (docs, components, examples): a picker at phone width. The other sections'
 * lists are in the document too once they are prepared (hidden), hence the visible filter. */
const section = async (c: Ctx, label: string) => {
  const list = c.page.locator('[data-sem-c=nav-list]').filter({ visible: true }).first()
  if (c.phone) await list.locator('select').selectOption({ label })
  else await list.getByRole('button', { name: label, exact: true }).click()
}
/** The app bar's display menu at phone width (Tools, the colour scheme, the theme). */
const displayMenu = async (c: Ctx) => {
  if (!c.phone) return
  const menu = button(c, 'Tools and display')
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click()
}
const type = (c: Ctx, text: string) => c.page.keyboard.type(text)
const press = (c: Ctx, key: string) => c.page.keyboard.press(key)
const live = '[data-sem-c=live-example]'

const INTERACTIONS: Interaction[] = [
  // The site's nav, one section to the next.
  { id: 'nav home→docs', path: '/', pageChange: true, act: (c) => nav(c, 'Docs'), undo: (c) => nav(c, 'Home') },
  { id: 'nav docs→components', path: '/docs/overview/', pageChange: true, act: (c) => nav(c, 'Components'), undo: (c) => nav(c, 'Docs') },
  { id: 'nav components→reference', path: '/components/foundations/', pageChange: true, act: (c) => nav(c, 'Reference'), undo: (c) => nav(c, 'Components') },
  { id: 'nav reference→examples', path: '/reference/c:Window/', pageChange: true, act: (c) => nav(c, 'Examples'), undo: (c) => nav(c, 'Reference') },
  { id: 'nav examples→home', path: '/examples/todo/', pageChange: true, act: (c) => nav(c, 'Home'), undo: (c) => nav(c, 'Examples') },
  // One page to another within a section.
  { id: 'docs page', path: '/docs/overview/', pageChange: true, act: (c) => section(c, 'Rules and the engine'), undo: (c) => section(c, 'Overview') },
  { id: 'components page', path: '/components/foundations/', pageChange: true, act: (c) => section(c, 'Inputs'), undo: (c) => section(c, 'Foundations') },
  {
    id: 'reference term',
    path: '/reference/c:Window/',
    pageChange: true,
    act: (c) => click(c, 'Desktop', '[data-sem-c=term-tree]'),
    undo: (c) => click(c, 'Window', '[data-sem-c=term-tree]'),
  },
  { id: 'examples menu', path: '/examples/todo/', pageChange: true, act: (c) => section(c, 'Kanban board'), undo: (c) => section(c, 'Todo, two projections') },
  // The live todo on the home page (#263).
  {
    id: 'home todo check',
    path: '/',
    act: (c) => c.page.locator(`${live} [data-sem-c=list-item] input[type=checkbox]`).filter({ visible: true }).first().click(),
    undo: (c) => c.page.locator(`${live} [data-sem-c=list-item] input[type=checkbox]`).filter({ visible: true }).first().click(),
  },
  {
    id: 'home todo add',
    path: '/',
    prepare: async (c) => {
      await c.page.locator(`${live} [data-sem-c=text-field] input`).filter({ visible: true }).first().click()
      await type(c, 'Milk')
    },
    act: (c) => click(c, 'Add', live),
  },
  // Each example's main interactions.
  {
    id: 'sheet cell edit',
    path: '/examples/sheet/',
    prepare: async (c) => {
      await c.page.locator('[data-sem-c=sheet-cell] input[aria-label="B2"], input[aria-label="B2"]').filter({ visible: true }).first().dblclick()
      await press(c, 'Meta+A')
    },
    act: async (c) => {
      await type(c, '42')
      await press(c, 'Enter')
    },
  },
  { id: 'kanban move', path: '/examples/kanban/', act: (c) => click(c, /^Move to Doing/), undo: (c) => click(c, 'Undo') },
  { id: 'checkout step', path: '/examples/checkout/', act: (c) => click(c, 'Continue to shipping'), undo: (c) => click(c, /^Back/) },
  { id: 'dashboard facet', path: '/examples/dashboard/', act: (c) => click(c, /^North/), undo: (c) => click(c, /^North/) },
  { id: 'warehouse sale', path: '/examples/warehouse/', act: (c) => click(c, 'Sell'), undo: (c) => click(c, 'Restock') },
  {
    id: 'chat send',
    path: '/examples/chat/',
    prepare: async (c) => {
      await c.page.locator('[data-sem-c=text-area] textarea').filter({ visible: true }).first().click()
      await type(c, 'Hello')
    },
    act: (c) => click(c, 'Send'),
  },
  {
    id: 'settings field',
    path: '/examples/settings/',
    prepare: (c) => c.page.locator('[data-sem-c=text-field] input').filter({ visible: true }).first().click(),
    act: (c) => type(c, 'x'),
    undo: (c) => press(c, 'Backspace'),
  },
  {
    id: 'block editor typing',
    path: '/examples/block-types/',
    prepare: (c) => c.page.locator('[data-sem-c=block-editor] [data-sem-c=blk-paragraph] .sem-text').filter({ visible: true }).first().click(),
    act: (c) => type(c, 'x'),
    undo: (c) => press(c, 'Backspace'),
  },
  // The command palette and search.
  { id: 'palette open', path: '/', act: (c) => click(c, 'Search'), undo: (c) => press(c, 'Escape') },
  {
    id: 'palette search',
    path: '/',
    prepare: async (c) => {
      await click(c, 'Search')
      await c.page.locator('[data-sem-c=command-palette] input').filter({ visible: true }).first().waitFor()
    },
    act: (c) => type(c, 'kanban'),
    undo: (c) => press(c, 'Escape'),
  },
  // Theme and colour scheme.
  {
    id: 'colour scheme',
    path: '/',
    prepare: displayMenu,
    act: (c) => click(c, /Night$/, '[data-sem-c=theme-switcher]'),
    undo: async (c) => {
      await displayMenu(c)
      await click(c, /Day$/, '[data-sem-c=theme-switcher]')
    },
  },
  {
    id: 'theme',
    path: '/',
    prepare: displayMenu,
    act: async (c) => void (await c.page.locator('select:has(option:text-is("Classic"))').filter({ visible: true }).first().selectOption({ label: 'Classic' })),
    undo: async (c) => {
      await displayMenu(c)
      await c.page.locator('select:has(option:text-is("Classic"))').filter({ visible: true }).first().selectOption({ label: 'Semblance' })
    },
  },
  // The inspector and the workbench.
  {
    id: 'inspector open',
    path: '/',
    prepare: displayMenu,
    act: (c) => click(c, 'Tools'),
    undo: async (c) => {
      await displayMenu(c)
      await click(c, 'Tools')
    },
  },
  {
    id: 'workbench open',
    path: '/',
    prepare: async (c) => {
      await displayMenu(c)
      const tools = button(c, 'Tools')
      if ((await tools.getAttribute('aria-pressed')) !== 'true') await tools.click()
      await c.page.getByRole('tab', { name: 'Query', exact: true }).first().waitFor()
    },
    act: (c) => c.page.getByRole('tab', { name: 'Query', exact: true }).first().click(),
    undo: (c) => c.page.getByRole('tab', { name: 'Inspector', exact: true }).first().click(),
  },
]

// --- in the page ---------------------------------------------------------------------------

/** Installed before the page's own scripts: what the measurements read. */
function probe() {
  interface Frame { t: number; area: number }
  const S = ((window as any).__semPerf = { events: [] as any[], longs: [] as any[], loafs: [] as any[], frames: [] as Frame[], inputs: [] as any[], turns: [] as any[], armed: false, longTasks: PerformanceObserver.supportedEntryTypes?.includes('longtask') })
  const observe = (type: string, f: (e: any) => void, extra = {}) => {
    try {
      new PerformanceObserver((l) => l.getEntries().forEach(f)).observe({ type, buffered: true, ...extra } as PerformanceObserverInit)
    } catch {}
  }
  observe('event', (e) => e.interactionId && S.events.push({ name: e.name, start: e.startTime, duration: e.duration, id: e.interactionId, processing: e.processingEnd - e.processingStart }), { durationThreshold: 16 })
  observe('longtask', (e) => S.longs.push({ start: e.startTime, duration: e.duration }))
  observe('long-animation-frame', (e) =>
    S.loafs.push({
      start: e.startTime,
      duration: e.duration,
      blocking: e.blockingDuration,
      render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0,
      scripts: e.scripts.map((s: any) => ({ invoker: s.invoker, fn: s.sourceFunctionName, url: (s.sourceURL || '').split('/').pop(), at: s.sourceCharPosition, duration: s.duration })),
    }),
  )
  observe('mark', (e) => e.name === 'sem:turn' && S.turns.push({ t: e.startTime, ...(e.detail ?? {}) }))
  // The frame after an input's task (next paint where Event Timing is missing).
  for (const type of ['pointerdown', 'keydown', 'change']) {
    addEventListener(
      type,
      (e) => {
        if (!S.armed) return
        const rec: any = { type, t: e.timeStamp }
        S.inputs.push(rec)
        requestAnimationFrame(() => {
          const ch = new MessageChannel()
          ch.port1.onmessage = () => (rec.painted = performance.now())
          ch.port2.postMessage(0)
        })
      },
      true,
    )
  }
  // The frames that changed something visible, and how much (the largest element's box).
  const skip = '[data-sem-c=status-bar],[data-sem-c=graph-mark]'
  let pending = new Set<Node>()
  let scheduled = false
  const measure = () => {
    // (Not the frame's timestamp: its vsync, which can be before a long task the frame waited for.)
    const t = performance.now()
    scheduled = false
    const nodes = pending
    pending = new Set()
    let area = 0
    let n = 0
    for (const node of nodes) {
      const el = node.nodeType === 1 ? (node as Element) : node.parentElement
      if (!el || !el.isConnected || el.closest(skip) || ++n > 400) continue
      let r = el.getBoundingClientRect()
      // (A display: contents box has no size of its own: what it holds has.)
      if (!r.width || !r.height) {
        const range = document.createRange()
        range.selectNodeContents(el)
        r = range.getBoundingClientRect()
      }
      const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0)
      const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)
      if (w > 0 && h > 0) area = Math.max(area, w * h)
    }
    if (area > 0) S.frames.push({ t, area })
  }
  new MutationObserver((records) => {
    for (const r of records) {
      pending.add(r.target)
      r.addedNodes.forEach((n) => pending.add(n))
    }
    if (!scheduled) {
      scheduled = true
      requestAnimationFrame(measure)
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
}

// --- a static server for dist/ (as GitHub Pages serves it) ----------------------------------

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttl': 'text/turtle', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml' }

function serve(root: string): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url!, 'http://x').pathname)
    let file = join(root, path)
    if (!file.startsWith(root)) return void res.writeHead(403).end()
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    let status = 200
    if (!existsSync(file)) {
      if (existsSync(file + '.html')) file += '.html'
      else ((file = join(root, '404.html')), (status = 404))
    }
    res.writeHead(status, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=600' })
    createReadStream(file).pipe(res)
  })
  return new Promise((ok) => server.listen(0, () => ok({ server, base: `http://localhost:${(server.address() as { port: number }).port}` })))
}

// --- measuring ------------------------------------------------------------------------------

interface Sample {
  nextPaint?: number
  largestPaint?: number
  settled?: number
  longTask?: number
  runs?: number
  error?: string
  loafs?: unknown[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = (page: Page) => page.evaluate(() => performance.now())

/** Until nothing visible changed for `quietMs` (at most `capMs`). */
async function settle(page: Page, from: number, capMs: number, quiet = quietMs) {
  const start = Date.now()
  while (Date.now() - start < capMs) {
    await sleep(150)
    const [t, last] = await page.evaluate(() => [performance.now(), (window as any).__semPerf.frames.at(-1)?.t ?? 0])
    if (t - Math.max(last, from) >= quiet) return
  }
}

async function measure(page: Page, it: Interaction, c: Ctx, capMs: number): Promise<Sample> {
  if (it.prepare) {
    await it.prepare(c)
    await settle(page, await now(page), capMs)
  }
  const mark = await page.evaluate(() => {
    const S = (window as any).__semPerf
    S.armed = true
    S.inputs.length = 0
    return performance.now()
  })
  await it.act(c)
  // (Quiet for longer on a slower CPU: what the input started may take that much longer to show.)
  await settle(page, await now(page), capMs, quietMs * c.throttle)
  return page.evaluate(
    ({ mark, pageChange }) => {
      const S = (window as any).__semPerf
      S.armed = false
      const t0 = Math.min(S.inputs[0]?.t ?? Infinity, ...S.events.filter((e: any) => e.start >= mark - 5).map((e: any) => e.start), Infinity)
      const from = Number.isFinite(t0) ? t0 : mark
      const events = S.events.filter((e: any) => e.start >= from - 1)
      const nextPaint = events.length ? Math.max(...events.map((e: any) => e.duration)) : Math.max(...S.inputs.filter((i: any) => i.painted).map((i: any) => i.painted - i.t), -Infinity)
      const frames = S.frames.filter((f: any) => f.t >= from)
      let largest: any
      for (const f of frames) if (!largest || f.area > largest.area) largest = f
      const end = frames.at(-1)?.t ?? from
      const longs = S.longs.filter((l: any) => l.start + l.duration >= from && l.start <= end + 50)
      const loafs = S.loafs.filter((l: any) => l.start + l.duration >= from && l.start <= end + 50 && l.duration >= 100)
      const turns = S.turns.filter((t: any) => t.t >= from - 1)
      return {
        nextPaint: Number.isFinite(nextPaint) ? nextPaint : undefined,
        largestPaint: largest ? largest.t - from : undefined,
        settled: frames.length ? end - from : undefined,
        longTask: longs.length ? Math.max(...longs.map((l: any) => l.duration)) : S.longTasks ? 0 : undefined,
        runs: turns.length ? turns.reduce((n: number, t: any) => n + (t.runs ?? 0), 0) : undefined,
        loafs: loafs.map((l: any) => ({ ...l, start: l.start - from })),
        pageChange,
      }
    },
    { mark, pageChange: !!it.pageChange },
  )
}

async function open(browser: Browser, base: string, path: string, width: Width, throttle: number): Promise<{ context: BrowserContext; page: Page }> {
  const phone = width === 'phone'
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    deviceScaleFactor: phone ? 3 : 1,
    isMobile: phone && browserName === 'chromium',
    hasTouch: phone,
  })
  // (tsx keeps functions' names with a helper the page does not have.)
  await context.addInitScript({ content: `globalThis.__name ??= (f) => f;(${probe})()` })
  const page = await context.newPage()
  if (throttle > 1 && browserName === 'chromium') {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
  }
  await page.goto(base + path, { timeout: 60_000 * throttle })
  await page.waitForFunction(() => performance.getEntriesByName('sem:ready').length > 0, null, { timeout: 120_000 })
  return { context, page }
}

/** All graphs in (or as long as they take, up to a limit), then a quiet page. */
async function warmUp(page: Page, capMs: number) {
  // (A page that names no first graphs loaded them all at once: no sem:graphs.)
  if (await page.evaluate(() => !!document.querySelector('meta[name=semblance-graphs]'))) await page.waitForFunction(() => performance.getEntriesByName('sem:graphs').length > 0, null, { timeout: capMs }).catch(() => {})
  await settle(page, await now(page), capMs)
}

interface Row {
  id: string
  mode: Mode
  width: Width
  throttle: number
  pageChange: boolean
  samples: Sample[]
}

async function run(browser: Browser, base: string, it: Interaction, mode: Mode, width: Width, throttle: number): Promise<Row> {
  const capMs = 10_000 * throttle
  const samples: Sample[] = []
  const attempt = async (f: () => Promise<Sample>) => {
    try {
      samples.push(await f())
    } catch (e) {
      samples.push({ error: (e as Error).message.split('\n')[0] })
    }
  }
  if (mode !== 'warm') {
    for (let i = 0; i < runs; i++) {
      await attempt(async () => {
        const { context, page } = await open(browser, base, it.path, width, throttle)
        try {
          // First: once the page has all its graphs and is quiet, the first time.
          if (mode === 'first') await warmUp(page, 30_000 * throttle)
          return await measure(page, it, { page, phone: width === 'phone', throttle }, capMs)
        } finally {
          await context.close()
        }
      })
    }
  } else {
    let context: BrowserContext | undefined
    try {
      const opened = await open(browser, base, it.path, width, throttle)
      context = opened.context
      const page = opened.page
      const c = { page, phone: width === 'phone', throttle }
      await warmUp(page, 30_000 * throttle)
      // Once unmeasured: what the first time loads or builds is the cold column's.
      await measure(page, it, c, capMs)
      if (it.undo) await it.undo(c), await settle(page, await now(page), capMs)
      for (let i = 0; i < runs; i++) {
        await attempt(() => measure(page, it, c, capMs))
        if (it.undo) await it.undo(c), await settle(page, await now(page), capMs)
      }
    } catch (e) {
      samples.push({ error: (e as Error).message.split('\n')[0] })
    }
    await context?.close()
  }
  return { id: it.id, mode, width, throttle, pageChange: !!it.pageChange, samples }
}

// --- the table -----------------------------------------------------------------------------

const median = (xs: (number | undefined)[]) => {
  const v = xs.filter((x): x is number => x !== undefined && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return undefined
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
const ms = (x: number | undefined) => (x === undefined ? '–' : `${Math.round(x)}`)

function verdict(r: Row): string[] {
  if (r.mode === 'cold' || r.throttle !== 1) return []
  const out: string[] = []
  const np = median(r.samples.map((s) => s.nextPaint))
  const lp = median(r.samples.map((s) => s.largestPaint))
  const lt = median(r.samples.map((s) => s.longTask))
  if (np !== undefined && np >= TARGETS.nextPaint) out.push(`next paint ${ms(np)} ms ≥ ${TARGETS.nextPaint}`)
  if (r.pageChange && lp !== undefined && lp >= TARGETS.pageLargestPaint) out.push(`largest paint ${ms(lp)} ms ≥ ${TARGETS.pageLargestPaint}`)
  if (lt !== undefined && lt > TARGETS.longTask) out.push(`long task ${ms(lt)} ms > ${TARGETS.longTask}`)
  if (r.samples.every((s) => s.error)) out.push('failed: ' + r.samples[0]?.error)
  return out
}

function table(rows: Row[], base: string): string {
  const head = `Interactions on ${base} (${browserName}; medians of ${runs}; ms from the input). Targets, first and warm, unthrottled: next paint < ${TARGETS.nextPaint}, a page change's largest paint < ${TARGETS.pageLargestPaint}, no long task > ${TARGETS.longTask}.\n\n`
  const lines = ['| interaction | mode | width | CPU | next paint | largest paint | settled | longest task | runs | |', '|---|---|---|---:|---:|---:|---:|---:|---:|---|']
  for (const r of rows) {
    const s = r.samples
    const errors = s.filter((x) => x.error).length
    const v = verdict(r)
    lines.push(
      `| ${r.id} | ${r.mode} | ${r.width} | ${r.throttle}× | ${ms(median(s.map((x) => x.nextPaint)))} | ${ms(median(s.map((x) => x.largestPaint)))} | ${ms(median(s.map((x) => x.settled)))} | ${ms(median(s.map((x) => x.longTask)))} | ${ms(median(s.map((x) => x.runs)))} | ${v.length ? '❌ ' + v.join('; ') : r.mode !== 'cold' && r.throttle === 1 ? '✓' : ''}${errors ? ` (${errors} failed)` : ''} |`,
    )
  }
  return head + lines.join('\n') + '\n'
}

// --- main ----------------------------------------------------------------------------------

/** Write the table (and the JSON, after every row: a run cut short keeps what it measured). */
function report(rows: Row[], base: string, final: boolean) {
  if (opt('json')) writeFileSync(opt('json')!, JSON.stringify({ base, browser: browserName, runs, rows }, null, 1))
  if (!final) return
  const out = table(rows, base)
  console.log(out)
  if (opt('out')) writeFileSync(opt('out')!, out)
  const failing = rows.filter((r) => verdict(r).length)
  if (failing.length) {
    console.error(`\n${failing.length} over the targets:\n` + failing.map((r) => `  ${r.id} (${r.width}): ${verdict(r).join('; ')}`).join('\n'))
    process.exitCode = 1
  }
}

// --table a.json,b.json: the table of earlier runs' JSON, together (no browser).
if (opt('table')) {
  const saved = opt('table')!.split(',').map((f) => JSON.parse(readFileSync(f, 'utf8')) as { base: string; rows: Row[] })
  report(saved.flatMap((x) => x.rows), saved[0]!.base, true)
  process.exit()
}

let base = opt('base')
let server: Server | undefined
if (!base) {
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`no static build in ${dist}: npm run build, or --base <url>`)
  ;({ server, base } = await serve(dist))
}
base = base.replace(/\/$/, '')
const browser = await (browserName === 'webkit' ? webkit : chromium).launch()
const chosen = INTERACTIONS.filter((it) => !only || only.some((o) => it.id.includes(o)))
const rows: Row[] = []
for (const it of chosen)
  for (const mode of modes)
    for (const width of widths)
      for (const throttle of throttles) {
        if (throttle > 1 && browserName !== 'chromium') continue
        const started = Date.now()
        const row = await run(browser, base, it, mode, width, throttle)
        rows.push(row)
        report(rows, base, false)
        const s = row.samples
        console.error(`${it.id} · ${mode} · ${width} · ${throttle}× → next ${ms(median(s.map((x) => x.nextPaint)))} largest ${ms(median(s.map((x) => x.largestPaint)))} settled ${ms(median(s.map((x) => x.settled)))} task ${ms(median(s.map((x) => x.longTask)))} runs ${ms(median(s.map((x) => x.runs)))} (${((Date.now() - started) / 1000).toFixed(0)} s)${s.some((x) => x.error) ? ' errors: ' + s.filter((x) => x.error).map((x) => x.error).join(' | ') : ''}`)
      }
await browser.close()
server?.close()
report(rows, base, true)
