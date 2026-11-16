import { join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Cdp, chromePath, launch } from '../scripts/cdp.ts'

// Where the caret is when a field takes the focus (#338), with real input: a headless Chromium moves
// the mouse, presses and types (DevTools Input.dispatch*), over the site's pages, which linkedom
// cannot say anything about: it has no selection. A sheet's cell selects its text however it is entered
// (the browser would put a click left of right-aligned text before it, and typing would prepend), a
// click in the cell that has the focus places the caret, and Escape puts back what it held. A field
// the framework focuses (the RDF editor's, on Enter or a typed character) has its caret after the text.

const here = resolve(import.meta.dirname, '..')
const chrome = chromePath()

describe.skipIf(!chrome)('the caret of a field taking the focus', () => {
  let server: ViteDevServer
  let cdp: Cdp
  let stop: () => void
  let base: string

  beforeAll(async () => {
    server = await createServer({
      configFile: join(here, 'vite.config.ts'),
      root: join(here, 'demo'),
      server: { port: 0, strictPort: false, fs: { allow: [here, realpathSync(join(here, 'node_modules'))] } },
      logLevel: 'warn',
    })
    await server.listen()
    base = `http://localhost:${(server.httpServer!.address() as { port: number }).port}`
    ;({ cdp, stop } = await launch())
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
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
  /** A click at a fraction of the element's width, from its start in the page's left-to-right sense. */
  async function press(element: string, x0: number, x1 = x0) {
    const at = await cdp.evaluate<{ x: number; w: number; y: number }>(`(() => { const e = ${element}; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x, w: r.width, y: r.y + r.height / 2 } })()`)
    const [from, to] = [at.x + at.w * x0, at.x + at.w * x1]
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from, y: at.y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from, y: at.y, button: 'left', clickCount: 1 })
    if (to !== from) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to, y: at.y, button: 'left', buttons: 1 })
    await sleep(40)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to, y: at.y, button: 'left', clickCount: 1 })
    await sleep(100)
  }
  const CODES: Record<string, number> = { Tab: 9, Enter: 13, Escape: 27 }
  async function key(name: string) {
    // (Enter's text is what makes it a press that commits: the browser's change event.)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: CODES[name], ...(name === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: CODES[name] })
    await sleep(100)
  }
  async function type(text: string) {
    for (const ch of text) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
      await sleep(60)
    }
  }
  /** The field with the focus: its name, its selection, its text. */
  const active = () => cdp.evaluate<[string | null, number, number, string]>(`(() => { const a = document.activeElement; return [a.getAttribute('aria-label'), a.selectionStart, a.selectionEnd, a.value] })()`)
  const cell = (name: string) => `document.querySelector('[data-sem-c=sheet] [aria-label=${name}]')`
  const cellText = (name: string) => cdp.evaluate<string>(`(() => { const c = ${cell(name)}; return c.value ?? c.textContent })()`)

  describe('in a sheet', () => {
    beforeAll(async () => {
      await cdp.send('Page.navigate', { url: base + '/examples/sheet/' })
      await until(`!!${cell('C3')} && !!document.querySelector('.sem-sheet-bar')`)
      // (The site's rules are at work until the sheet answers a press.)
      await until(`(() => { const e = ${cell('D3')}; e.focus(); return e.closest('[data-sem-selected]') !== null })()`)
    })

    it('selects a right-aligned value on a click left of its text, and typing replaces it', async () => {
      await press(cell('C3'), 0.5)
      expect(await active()).toEqual(['C3', 0, 4, '5480'])
      const year = await cellText('F3')
      await type('1')
      expect(await active()).toEqual(['C3', 1, 1, '1'])
      await until(`${cell('F3')}.textContent !== ${JSON.stringify(year)}`, 5000)
      await key('Escape')
      expect(await cellText('F3')).toBe(year)
    })

    it('enters a cell by a click as by Tab', async () => {
      await press(cell('B4'), 0.9)
      expect(await active()).toEqual(['B4', 0, 4, '3900'])
      await key('Tab')
      expect(await active()).toEqual(['C4', 0, 4, '4120'])
      // A text cell (left-aligned, where a click would land after its text).
      await press(cell('A5'), 0.5)
      expect(await active()).toEqual(['A5', 0, 10, 'Flat white'])
    })

    it('replaces with a formula typed over a value', async () => {
      await press(cell('B7'), 0.5)
      await type('=B2+B3')
      expect((await active())[3]).toBe('=B2+B3')
      await key('Escape')
      expect(await active()).toEqual(['B7', 0, 4, '2100'])
    })

    it('puts back what the cell held on Escape, the formulas following, with its text selected', async () => {
      await press(cell('E5'), 0.5)
      const year = await cellText('F5')
      await type('77')
      await until(`${cell('F5')}.textContent !== ${JSON.stringify(year)}`, 5000)
      await key('Escape')
      expect(await active()).toEqual(['E5', 0, 4, '3420'])
      expect(await cellText('F5')).toBe(year)
      await type('9')
      expect((await active())[3]).toBe('9')
      // Committed, it stays: Escape has nothing to undo after Enter.
      await key('Enter')
      await key('Escape')
      expect((await active())[3]).toBe('9')
    })

    it('places the caret on a press in the cell that has the focus, and keeps a dragged selection', async () => {
      await press(cell('D6'), 0.5)
      expect(await active()).toEqual(['D6', 0, 4, '1240'])
      await press(cell('D6'), 0.98)
      expect(await active()).toEqual(['D6', 4, 4, '1240'])
      await key('Tab')
      // A drag across the text of a cell it enters: what it dragged over.
      await press(cell('D7'), 0.9, 0.72)
      const [name, start, end] = await active()
      expect(name).toBe('D7')
      expect(end - start).toBeGreaterThan(0)
      expect(end - start).toBeLessThan(4)
    })
  })

  describe('in an RDF editor', () => {
    const LITERAL = `[...document.querySelectorAll('[data-sem-c=rdf-editor] .sem-label.sem-literal')].find((e) => e.offsetParent)`

    beforeAll(async () => {
      await cdp.send('Page.navigate', { url: base + '/examples/rdf-editor/' })
      await until(`!!(${LITERAL})`)
      await until(`document.readyState === 'complete'`)
      await sleep(1500)
    })

    it('has the caret after the text of a field Enter opened', async () => {
      await cdp.evaluate(`(${LITERAL}).focus()`)
      const text = await cdp.evaluate<string>(`(${LITERAL}).textContent`)
      await key('Enter')
      const [, start, end, value] = await active()
      expect(text).toContain(value)
      expect([start, end]).toEqual([value.length, value.length])
      await type('xy')
      expect((await active())[3]).toBe(value + 'xy')
      await key('Escape')
    })

    it('keeps the order of what is typed to start editing', async () => {
      await cdp.evaluate(`(${LITERAL}).focus()`)
      await type('abc')
      expect((await active())[3]).toBe('abc')
      await key('Escape')
    })
  })
})
