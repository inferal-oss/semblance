// Measure pages of a checkout of the site in a real browser and record their box trees (the
// fixtures test/layout-check.test.ts checks), or check them on the spot.
//
//   npx tsx scripts/layout-check.ts [--root <checkout>] --pages 'examples/checkout@Continue to shipping,examples/shapes' \
//     [--widths 320,1280] [--height 900] [--scroll 0] [--themes semblance,doodle] [--langs en,uk,de,ar] [--dir rtl] [--out <dir>] [--check]
//
// A language is chosen the way the site remembers it: its policy (ui:rememberSettings) in the tab's
// sessionStorage before the page loads.
//
// It starts the checkout's Vite dev server in-process, drives a headless Chromium over the DevTools
// protocol (Node's own WebSocket; the browser is the cached Playwright or Puppeteer headless shell,
// or SEMBLANCE_CHROME), measures, and stops both. With --source dom (the default) it measures the
// document with src/layout/measure.ts: everything on the page, the live examples' sandboxes too,
// and any checkout. With --source rnd it reads the page's own rendered state: the shell observes its
// layout (rnd:observes rnd:Layout), and the rendered graph is read into the same box tree
// (fromRendered), as the checker reads a live store; what the shell renders only. Boxes are as laid
// out, before transforms (src/layout/box.ts), either way. Parts are the elements
// the checkout's components mark (data-sem-part, from lc:role), so a checkout from before they did
// (#193) records component boxes only.
// A page may name buttons to click first, by their text, after an @ each. With --scroll the page is
// scrolled down that far before it is measured (what sticks is measured where it stuck), in a
// viewport --height tall.
// One browser, one page at a time, at a low priority: the machine is shared.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Parser } from 'n3'
import { createServer } from 'vite'
import { launch, type Cdp } from './cdp.ts'
import { layoutBox } from '../src/layout/box.ts'
import { fromRendered, readDeclarations, type Declarations } from '../src/layout/invariants.ts'
import { measurePage, pagePath, type MeasuredPage, type PartHooks } from '../src/layout/measure.ts'
import { loadStore } from '../src/node/load.ts'
import type { GraphStore } from '../src/store/types.ts'

const here = resolve(import.meta.dirname, '..')
const { values: args } = parseArgs({
  options: {
    root: { type: 'string', default: here },
    pages: { type: 'string', default: 'examples/checkout' },
    widths: { type: 'string', default: '1280' },
    height: { type: 'string', default: '900' },
    scroll: { type: 'string', default: '0' },
    themes: { type: 'string', default: '' },
    dir: { type: 'string', default: '' },
    langs: { type: 'string', default: '' },
    out: { type: 'string', default: '' },
    label: { type: 'string', default: '' },
    check: { type: 'boolean', default: false },
    source: { type: 'string', default: 'dom' },
  },
})
const source = args.source as 'dom' | 'rnd'
let declarations: Declarations | undefined
let ontology: GraphStore | undefined

/** What the part hooks mean, from the ontology: each role's slug, each width class's slug and media condition. */
export function partHooks(): PartHooks {
  const LC = 'https://semblance.dev/ns/layout-constraints#'
  const STY = 'https://semblance.dev/ns/style#'
  const SLUG = 'https://semblance.dev/ns/core#slug'
  const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
  const quads = ['ontology/layers/constraints.ttl', 'ontology/layers/style.ttl'].flatMap((f) => new Parser().parse(readFileSync(join(here, f), 'utf8')))
  const one = (s: string, p: string) => quads.find((q) => q.subject.value === s && q.predicate.value === p)?.object.value
  const out: PartHooks = { roles: {}, widths: {} }
  for (const q of quads) {
    if (q.predicate.value !== TYPE) continue
    const slug = one(q.subject.value, SLUG)
    if (!slug) continue
    if (q.object.value === LC + 'Role') out.roles[slug] = q.subject.value.slice(LC.length)
    if (q.object.value === STY + 'WidthClass') out.widths[slug] = one(q.subject.value, STY + 'media')!
  }
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wait until the page has rendered components and stopped changing. */
export async function settle(cdp: Cdp): Promise<void> {
  let last = -1
  let still = 0
  for (let i = 0; i < 240 && still < 4; i++) {
    await sleep(250)
    // On a loaded machine an update can outrun its turn budget: the site then suspends it behind
    // "The page is busy" until Continue. Measuring then would record the page before the update.
    const resumed = await cdp.evaluate<boolean>(`(() => {
      const b = [...document.querySelectorAll('dialog button, [role=dialog] button, [role=alertdialog] button')].find((b) => b.textContent.trim() === 'Continue' && b.getClientRects().length)
      b?.click(); return !!b })()`)
    const n = await cdp.evaluate<number>(`document.querySelectorAll('[data-sem-c]').length + document.body.innerHTML.length`)
    if (resumed) console.error("layout-check: resumed a suspended update (the page is busy)")
    still = n === last && n > 1000 && !resumed ? still + 1 : 0
    last = n
  }
}

/**
 * The page's own rendered state as a box tree: its shell observes its layout, and what the rendered
 * graph says (with each observed component's classes and position) is read as the checker reads a
 * live store. The site exposes its runtime in development (window.semblance).
 */
async function fromPage(cdp: Cdp, d: Declarations): Promise<MeasuredPage> {
  const dump = await cdp.evaluate<{ rendered: string[]; data: string[]; url: string; theme: string; dir: string }>(`(async () => {
    const s = window.semblance, f = s.store.factory, nn = (i) => f.namedNode(i)
    const RND = 'https://semblance.dev/ns/rendered#', POS = 'https://semblance.dev/ns/position#'
    const ask = f.quad(nn(s.shell.rootFocus), nn(RND + 'observes'), nn(RND + 'Layout'))
    if (!s.store.has(ask)) s.runtime.apply({ add: [ask], remove: [] })
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    s.rendered.invalidate(); s.rendered.flush()
    const term = (t) => t.termType === 'NamedNode' ? '<' + t.value + '>' : t.termType === 'BlankNode' ? '_:' + t.value : JSON.stringify(t.value) + '^^<' + t.datatype.value + '>'
    const nt = (q) => term(q.subject) + ' ' + term(q.predicate) + ' ' + term(q.object) + ' .'
    const g = nn('urn:semblance:rendered')
    const rendered = s.store.match(null, null, null, g).map(nt)
    const data = []
    for (const c of new Set(s.store.match(null, nn(RND + 'of'), null, g).map((q) => q.object.value)))
      for (const p of ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type', POS + 'direction', POS + 'layout'])
        for (const q of s.store.match(nn(c), nn(p), null)) data.push(nt(q))
    const root = document.querySelector('[data-sem-theme]')
    return { rendered, data, url: location.href, theme: root?.getAttribute('data-sem-theme') ?? '', dir: document.documentElement.dir || 'ltr' }
  })()`)
  const store = (ontology ??= loadStore('oxigraph'))
  const f = store.factory
  const added = [
    ...new Parser().parse(dump.rendered.join('\n')).map((q) => f.quad(q.subject, q.predicate, q.object, f.namedNode('urn:semblance:rendered'))),
    ...new Parser().parse(dump.data.join('\n')),
  ].filter((q) => !store.has(q))
  for (const q of added) store.add(q)
  try {
    const { page } = fromRendered(store, d)
    return { ...page, url: dump.url, theme: dump.theme, dir: dump.dir }
  } finally {
    for (const q of added) store.delete(q)
  }
}

const LANGUAGES: Record<string, string> = { en: 'English', uk: 'Ukrainian', de: 'German', ar: 'Arabic' }

export async function measure(base: string, pages: string[], widths: number[], themes: string[], dir: string, langs: string[] = [], height = 900, scroll = 0): Promise<MeasuredPage[]> {
  const parts = partHooks()
  if (source === 'rnd') declarations ??= readDeclarations((ontology ??= loadStore('oxigraph')))
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
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
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
          if (scroll) await cdp.evaluate(`scrollTo(0, ${scroll})`)
          await cdp.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
          await sleep(150)
          // tsx (esbuild) wraps named functions in __name(); give the page one
          const m = source === 'rnd' ? await fromPage(cdp, declarations!) : await cdp.evaluate<MeasuredPage>(`((__name) => (${measurePage.toString()})(${JSON.stringify(parts)}, ${layoutBox.toString()}))((f) => f)`)
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
      Number(args.height),
      Number(args.scroll),
    )
    if (args.out) {
      mkdirSync(args.out, { recursive: true })
      for (const p of pages) {
        const name = [args.label, pagePath(p).replace(/[/@ ]/g, '-'), p.width, args.height !== '900' ? 'h' + args.height : '', args.scroll !== '0' ? 'scrolled' + args.scroll : '', p.theme, p.lang && p.lang !== 'en' ? p.lang : '', p.dir === 'rtl' ? 'rtl' : ''].filter(Boolean).join('_')
        writeFileSync(join(args.out, name + '.json'), JSON.stringify(p) + '\n')
      }
    }
    if (args.check) {
      const { checkMeasured, describe } = await import('../src/layout/invariants.ts')
      const d = (declarations ??= readDeclarations((ontology ??= loadStore('oxigraph'))))
      for (const p of pages) for (const f of checkMeasured(p, d)) console.log(describe(p, f))
    }
  } finally {
    await server.close()
  }
}

if (import.meta.main ?? process.argv[1]?.endsWith('layout-check.ts')) await main()
