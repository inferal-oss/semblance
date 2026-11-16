import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadSite, pageGraphs, renderSite } from '../src/node/site.ts'
import { renderDocument } from '../src/server/document.ts'
import { pageGraphsMeta } from '../src/server/page-graphs.ts'
import { type Cdp, chromePath, launch } from '../scripts/cdp.ts'

// Real clicks on the home page's live todo (#263): a headless Chromium moves the mouse and presses
// and releases its button (DevTools Input.dispatchMouseEvent: pointer, mouse, focus and click events
// as a visitor's), over the page the server rendered (its graphs named, the rest loaded in idle
// time, the example's sandbox built once its ontology is here), served with the site's client. The
// first click is applied, once, whether the example was still pending or live, and a click on a live
// example is applied at once.

const here = resolve(import.meta.dirname, '..')
const chrome = chromePath()

describe.skipIf(!chrome)('real clicks on the home page’s live todo', () => {
  let server: ViteDevServer
  let cdp: Cdp
  let stop: () => void
  let url: string

  beforeAll(async () => {
    const site = await loadSite(join(here, 'semblance.config.ts'))
    const rendered = await renderSite(site, '/')
    const graphs = await pageGraphs(site, '/', rendered.html)
    expect(graphs).toBeDefined()
    const template = readFileSync(join(here, 'demo/index.html'), 'utf8')
    const page = renderDocument(template, rendered, { mount: site.mount, stylesheet: 'inline', attributes: rendered.attributes, head: pageGraphsMeta(graphs!) })
    rendered.runtime.dispose()
    // The site's client from the dev server, under the server's page (as the build writes it).
    server = await createServer({
      configFile: join(here, 'vite.config.ts'),
      root: join(here, 'demo'),
      server: { port: 0, strictPort: false, fs: { allow: [here, realpathSync(join(here, 'node_modules'))] } },
      logLevel: 'warn',
      plugins: [
        {
          name: 'server-rendered-home',
          configureServer(s) {
            s.middlewares.use(async (req, res, next) => {
              if (req.url !== '/' && req.url !== '/index.html') return next()
              res.setHeader('content-type', 'text/html')
              res.end(await s.transformIndexHtml('/', page))
            })
          },
        },
      ],
    })
    await server.listen()
    url = `http://localhost:${(server.httpServer!.address() as { port: number }).port}/`
    ;({ cdp, stop } = await launch())
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    // Where the visitor's pointer was released, and when the example's text changed.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__ups = []; window.__changes = []
        addEventListener('pointerup', () => __ups.push(performance.now()), true)
        const watch = () => { const t = document.querySelector('[data-sem-c=live-example] .sem-live-text'); if (!t) return setTimeout(watch, 10); new MutationObserver(() => __changes.push([performance.now(), t.textContent])).observe(t, { subtree: true, characterData: true, childList: true }) }
        addEventListener('DOMContentLoaded', watch)
        const live = () => { const ex = document.querySelector('[data-sem-c=live-example]'); if (!ex) return setTimeout(live, 10); new MutationObserver(() => { if (ex.getAttribute('data-sem-state') === 'live') window.__live ??= performance.now() }).observe(ex, { attributes: true }) }
        addEventListener('DOMContentLoaded', live)`,
    })
  })

  afterAll(async () => {
    stop?.()
    await server?.close()
  })

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const until = async (expression: string, ms = 120_000) => {
    // (Not there yet while the page loads.)
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(25)) if (await cdp.evaluate<boolean>(`(() => { try { return ${expression} } catch { return false } })()`)) return
    throw new Error('timed out waiting for ' + expression)
  }
  const EXAMPLE = `document.querySelector('[data-sem-c=live-example]')`
  const item = (label: string) => `[...${EXAMPLE}.querySelectorAll('.sem-live-screen li')].find((li) => li.textContent.includes(${JSON.stringify(label)}))`
  const text = () => cdp.evaluate<string>(`${EXAMPLE}.querySelector('.sem-live-text').textContent`)
  const state = () => cdp.evaluate<string>(`${EXAMPLE}.getAttribute('data-sem-state')`)
  /** The example's own graph (the dev build's handle): whether the todo labelled `label` is done. */
  const done = (label: string) =>
    cdp.evaluate<string | undefined>(`(() => {
      const { sandboxes, store } = window.semblance
      const f = store.factory
      const ex = store.match(null, f.namedNode('${'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'}'), f.namedNode('https://semblance.dev/ns/component#LiveExample')).map((q) => sandboxes.sandboxOf(q.subject.value)).find(Boolean)
      if (!ex) return undefined
      const g = ex.store, gf = g.factory
      const todo = g.match(null, gf.namedNode('http://www.w3.org/2000/01/rdf-schema#label'), gf.literal(${JSON.stringify(label)}))[0]?.subject
      return todo && g.match(todo, gf.namedNode('https://example.org/todo#done'), null)[0]?.object.value
    })()`)

  /** A visitor's click: the pointer comes in from the side, presses and releases on the element's middle. */
  async function click(element: string) {
    const at = await cdp.evaluate<{ x: number; y: number }>(`(() => { const r = (${element}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    for (let i = 3; i >= 0; i--) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x - i * 20, y: at.y + i * 5 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await sleep(60)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  }

  it('applies the first click, once, made while the example is pending', async () => {
    await cdp.send('Page.navigate', { url })
    await until(`!!(${item('Sketch')})`)
    await cdp.evaluate(`(${item('Sketch')}).scrollIntoView({ block: 'center' })`)
    expect(await text()).toContain('[ ] Sketch the style layer')
    const pending = (await state()) === 'pending'
    await click(`(${item('Sketch')}).querySelector('input')`)
    // Kept until the sandbox runs (nothing changes before then), then done: the box, the graph, the text.
    await until(`${EXAMPLE}.getAttribute('data-sem-state') === 'live' && ${EXAMPLE}.querySelector('.sem-live-text').textContent.includes('[x] Sketch')`)
    // Live soon after the page is (its sandbox waits for the ontology's text, not for the site's graph
    // to take in every graph; the rest are read as fast as idle time allows): a click waits that long.
    const wait = await cdp.evaluate<number>(`__live - performance.getEntriesByName('sem:ready')[0].startTime`)
    console.log(`live ${Math.round(wait)} ms after sem:ready`)
    expect(wait).toBeLessThan(3000)
    expect(await cdp.evaluate(`(${item('Sketch')}).querySelector('input').checked`)).toBe(true)
    expect(await done('Sketch the style layer')).toBe('true')
    expect(await cdp.evaluate(`!!${EXAMPLE}.querySelector('.sem-live-data [data-sem-change=added]')`)).toBe(true)
    // Done once: no second change undid it.
    await sleep(300)
    expect(await text()).toContain('[x] Sketch the style layer')
    expect(pending || (await state()) === 'live').toBe(true)
  })

  it('applies each click on the live example at once', async () => {
    await until(`${EXAMPLE}.getAttribute('data-sem-state') === 'live'`)
    for (const [label, after] of [
      ['Sketch', '[ ] Sketch the style layer'],
      ['Wire up', '[x] Wire up behaviour'],
      ['Sketch', '[x] Sketch the style layer'],
    ]) {
      const ups = await cdp.evaluate<number>('__ups.length')
      const changes = await cdp.evaluate<number>('__changes.length')
      await click(`(${item(label!)}).querySelector('input')`)
      await until(`__changes.slice(${changes}).some(([, t]) => t.includes(${JSON.stringify(after)}))`, 5000)
      // From the pointer's release to the example's text: a turn, not a wait (a frame on a desktop; generous for a busy test machine).
      const ms = await cdp.evaluate<number>(`__changes.slice(${changes}).find(([, t]) => t.includes(${JSON.stringify(after)}))[0] - __ups[${ups}]`)
      expect(ms).toBeLessThan(250)
    }
    expect(await done('Wire up behaviour')).toBe('true')
  })

  it('adds a todo typed and added with real input', async () => {
    const field = `${EXAMPLE}.querySelector('.sem-live-screen input[type=text]')`
    await click(field)
    await cdp.send('Input.insertText', { text: 'Probe one' })
    await click(`[...${EXAMPLE}.querySelectorAll('.sem-live-screen button')].find((b) => b.textContent === 'Add')`)
    await until(`!!(${item('Probe one')})`, 5000)
    await until(`${EXAMPLE}.querySelector('.sem-live-text').textContent.includes('Probe one')`, 5000)
  })
})
