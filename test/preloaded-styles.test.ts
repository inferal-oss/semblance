// A host that serves the stylesheet itself (#91): a [data-sem-styles] element in the document means
// mount neither compiles nor adopts one, and unmount leaves the host's stylesheet where it is.
import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '../src/web/mount.ts'

const hello = ['app.ttl', 'tally.ttl'].map((f) => readFileSync(new URL(`../examples/hello/${f}`, import.meta.url), 'utf8'))
const HELLO = 'https://example.org/hello#'

function host(head = '') {
  const { document, window } = parseHTML(`<!doctype html><html><head>${head}</head><body><main id="app"></main></body></html>`)
  document.adoptedStyleSheets = []
  class Sheet { text = ''; replaceSync(text: string) { this.text = text } }
  Object.defineProperty(window, 'CSSStyleSheet', { value: Sheet, configurable: true })
  Object.defineProperty(window, 'requestAnimationFrame', { value: () => 1, configurable: true })
  Object.defineProperty(window, 'cancelAnimationFrame', { value: () => {}, configurable: true })
  vi.stubGlobal('requestIdleCallback', () => 0)
  vi.stubGlobal('fetch', async () => new Response(readFileSync(new URL('../rdf-engine/build/wat.wasm', import.meta.url)), { headers: { 'Content-Type': 'application/wasm' } }))
  return { document, element: document.getElementById('app')! }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the stylesheet of a mount', () => {
  it('is compiled and adopted by default, and dropped on unmount', async () => {
    const { document, element } = host()
    const app = await mount(element, { root: HELLO + 'page', graphs: hello, store: 'wat', files: false, fullscreen: false })
    const [sheet] = document.adoptedStyleSheets as unknown as { text: string }[]
    expect(sheet!.text).toContain('[data-sem-c="ex-tally"]')
    expect(element.textContent).toContain('0 cups')
    app.unmount()
    expect(document.adoptedStyleSheets).toHaveLength(0)
  })

  it('is the host’s when the document has a [data-sem-styles] stylesheet: none is compiled, and it stays', async () => {
    const { document, element } = host('<link rel="stylesheet" href="/semblance.css" data-sem-styles>')
    const app = await mount(element, { root: HELLO + 'page', graphs: hello, store: 'wat', files: false, fullscreen: false })
    expect(document.adoptedStyleSheets).toHaveLength(0)
    expect(element.textContent).toContain('0 cups')
    app.unmount()
    expect(document.querySelector('link[data-sem-styles]')).not.toBeNull()
  })
})
