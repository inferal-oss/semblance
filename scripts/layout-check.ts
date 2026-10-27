// Measure pages of a checkout of the site in a real browser and record their box trees (the
// fixtures test/layout-check.test.ts checks), or check them on the spot.
//
//   npx tsx scripts/layout-check.ts [--root <checkout>] --pages 'examples/checkout@Continue to shipping,examples/shapes' \
//     [--widths 320,1280] [--themes semblance,doodle] [--langs en,uk,de,ar] [--dir rtl] [--out <dir>] [--check]
//
// A language is chosen the way the site remembers it: its policy (ui:rememberSettings) in the tab's
// sessionStorage before the page loads.
//
// It starts the checkout's Vite dev server in-process, drives a headless Chromium over the DevTools
// protocol (Node's own WebSocket; the browser is the cached Playwright or Puppeteer headless shell,
// or SEMBLANCE_CHROME), measures with src/layout/measure.ts, and stops both. The part selectors come
// from this checkout's ontology (lc:selector), so an old checkout is measured with today's roles.
// A page may name buttons to click first, by their text, after an @ each.
// One browser, one page at a time, at a low priority: the machine is shared.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Parser } from 'n3'
import { createServer } from 'vite'
import { measurePage, type MeasuredPage, type PartSelectors } from '../src/layout/measure.ts'

const here = resolve(import.meta.dirname, '..')
const { values: args } = parseArgs({
  options: {
    root: { type: 'string', default: here },
    pages: { type: 'string', default: 'examples/checkout' },
    widths: { type: 'string', default: '1280' },
    themes: { type: 'string', default: '' },
    dir: { type: 'string', default: '' },
    langs: { type: 'string', default: '' },
    out: { type: 'string', default: '' },
    label: { type: 'string', default: '' },
    check: { type: 'boolean', default: false },
  },
})

/** Part roles and their selectors (and where a width class picks another), from the ontology. */
export function partSelectors(): PartSelectors {
  const LC = 'https://semblance.dev/ns/layout-constraints#'
  const STY = 'https://semblance.dev/ns/style#'
  const quads = ['ontology/layers/constraints.ttl', 'ontology/layers/style.ttl'].flatMap((f) => new Parser().parse(readFileSync(join(here, f), 'utf8')))
  const one = (s: string, p: string) => quads.find((q) => q.subject.value === s && q.predicate.value === p)?.object.value
  const out: PartSelectors = {}
  for (const q of quads) {
    if (q.predicate.value === LC + 'selector' && q.subject.termType === 'NamedNode') (out[q.subject.value.slice(LC.length)] ??= []).push({ selector: q.object.value })
    if (q.predicate.value === LC + 'pick') {
      const media = one(one(q.object.value, LC + 'atWidth')!, STY + 'media')
      ;(out[q.subject.value.slice(LC.length)] ??= []).push({ selector: one(q.object.value, LC + 'selector')!, media })
    }
  }
  return out
}

function chrome(): string {
  if (process.env.SEMBLANCE_CHROME) return process.env.SEMBLANCE_CHROME
  const roots = [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]
  for (const r of roots) {
    if (!existsSync(r)) continue
    for (const d of readdirSync(r).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
      for (const sub of readdirSync(join(r, d))) {
        const bin = join(r, d, sub, 'chrome-headless-shell')
        if (existsSync(bin)) return bin
      }
    }
  }
  throw new Error('no headless Chromium found; set SEMBLANCE_CHROME')
}

/** A minimal DevTools protocol client over one page session. */
class Cdp {
  private id = 0
  private waiting = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>()
  sessionId = ''
  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id !== undefined) this.waiting.get(m.id)?.(m)
    })
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url)
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok)
      ws.addEventListener('error', fail)
    })
    return new Cdp(ws)
  }
  send<T = any>(method: string, params: object = {}, session = true): Promise<T> {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params, ...(session && this.sessionId ? { sessionId: this.sessionId } : {}) }))
    return new Promise((ok, fail) =>
      this.waiting.set(id, (r) => {
        this.waiting.delete(id)
        if (r.error) fail(new Error(method + ': ' + r.error.message))
        else ok(r.result as T)
      }),
    )
  }
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value as T
  }
  close() {
    this.ws.close()
  }
}

export async function launch(): Promise<{ cdp: Cdp; stop: () => void }> {
  const profile = join(tmpdir(), 'semblance-layout-' + process.pid)
  const proc = spawn(chrome(), ['--headless', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--hide-scrollbars', '--font-render-hinting=none', 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const url = await new Promise<string>((ok, fail) => {
    let err = ''
    proc.stderr!.on('data', (d) => {
      err += d
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err)
      if (m) ok(m[1])
    })
    proc.on('exit', () => fail(new Error('chrome exited: ' + err)))
  })
  // never leave a browser behind, however this process ends
  process.on('exit', () => proc.kill())
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(1))
  const cdp = await Cdp.connect(url)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }, false)
  cdp.sessionId = (await cdp.send('Target.attachToTarget', { targetId, flatten: true }, false)).sessionId
  await cdp.send('Runtime.enable')
  return { cdp, stop: () => (cdp.close(), proc.kill()) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wait until the page has rendered components and stopped changing. */
export async function settle(cdp: Cdp): Promise<void> {
  let last = -1
  let still = 0
  for (let i = 0; i < 120 && still < 4; i++) {
    await sleep(250)
    const n = await cdp.evaluate<number>(`document.querySelectorAll('[data-sem-c]').length + document.body.innerHTML.length`)
    still = n === last && n > 1000 ? still + 1 : 0
    last = n
  }
}

const LANGUAGES: Record<string, string> = { en: 'English', uk: 'Ukrainian', de: 'German', ar: 'Arabic' }

export async function measure(base: string, pages: string[], widths: number[], themes: string[], dir: string, langs: string[] = []): Promise<MeasuredPage[]> {
  const parts = partSelectors()
  const { cdp, stop } = await launch()
  const out: MeasuredPage[] = []
  try {
    for (const lang of langs.length ? langs : ['']) {
    if (lang) {
      await cdp.send('Page.navigate', { url: base + 'favicon.ico' })
      const nt = `<https://semblance.dev/demo#app> <https://semblance.dev/ns/l10n#language> <https://semblance.dev/ns/l10n#${LANGUAGES[lang]}> .\n`
      await cdp.evaluate(`sessionStorage.setItem('semblance:https://semblance.dev/demo#rememberSettings', ${JSON.stringify(JSON.stringify({ version: '1', savedAt: Date.now(), nt }))})`)
    }
    for (const width of widths) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
      for (const page of pages) {
        const [path, ...clicks] = page.split('@')
        await cdp.send('Page.navigate', { url: `${base}?store=hybrid#${path}` })
        await settle(cdp)
        for (const text of clicks) {
          const found = await cdp.evaluate<boolean>(`(() => {
            const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})
            b?.click(); return !!b })()`)
          if (!found) throw new Error(`no button "${text}" on ${path}`)
          await settle(cdp)
        }
        for (const theme of themes.length ? themes : ['']) {
          if (theme || dir)
            await cdp.evaluate(`(() => {
              const shell = document.querySelector('[data-sem-theme]'); const was = shell?.getAttribute('data-sem-theme')
              for (const el of document.querySelectorAll('[data-sem-theme]')) if (${JSON.stringify(theme)} && el.getAttribute('data-sem-theme') === was) el.setAttribute('data-sem-theme', ${JSON.stringify(theme)})
              if (${JSON.stringify(dir)}) document.documentElement.dir = ${JSON.stringify(dir)}
            })()`)
          await cdp.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
          await sleep(150)
          // tsx (esbuild) wraps named functions in __name(); give the page one
          const m = await cdp.evaluate<MeasuredPage>(`((__name) => (${measurePage.toString()})(${JSON.stringify(parts)}))((f) => f)`)
          m.lang = lang || 'en'
          if (m.nodes.length < 10) throw new Error(`${page} did not render (${m.nodes.length} boxes)`)
          out.push(m)
          console.log(`measured ${page} at ${width}px${theme ? ' in ' + theme : ''}${lang ? ' (' + lang + ')' : ''}${dir ? ' ' + dir : ''}: ${m.nodes.length} boxes, page ${m.scrollWidth}px wide`)
        }
      }
    }
    }
  } finally {
    stop()
  }
  return out
}

async function main() {
  const root = resolve(args.root!)
  // node_modules may be a link to another checkout's: let Vite serve from where it really is
  const allow = [root, realpathSync(join(root, 'node_modules'))]
  const server = await createServer({ configFile: join(root, 'vite.config.ts'), root: join(root, 'demo'), server: { port: 0, strictPort: false, fs: { allow } }, logLevel: 'warn' })
  await server.listen()
  const port = (server.httpServer!.address() as { port: number }).port
  try {
    const pages = await measure(
      `http://localhost:${port}/`,
      args.pages!.split(','),
      args.widths!.split(',').map(Number),
      args.themes ? args.themes.split(',') : [],
      args.dir!,
      args.langs ? args.langs.split(',') : [],
    )
    if (args.out) {
      mkdirSync(args.out, { recursive: true })
      for (const p of pages) {
        const name = [args.label, p.url.split('#')[1].replace(/[/@ ]/g, '-'), p.width, p.theme, p.lang && p.lang !== 'en' ? p.lang : '', p.dir === 'rtl' ? 'rtl' : ''].filter(Boolean).join('_')
        writeFileSync(join(args.out, name + '.json'), JSON.stringify(p) + '\n')
      }
    }
    if (args.check) {
      const { checkMeasured, describe, readDeclarations } = await import('../src/layout/invariants.ts')
      const { loadStore } = await import('../src/node/load.ts')
      const declarations = readDeclarations(loadStore('oxigraph'))
      for (const p of pages) for (const f of checkMeasured(p, declarations)) console.log(describe(p, f))
    }
  } finally {
    await server.close()
  }
}

if (import.meta.main ?? process.argv[1]?.endsWith('layout-check.ts')) await main()
