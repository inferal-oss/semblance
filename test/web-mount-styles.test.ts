import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { mount } from '../src/web/mount.ts'

const root = 'https://example.org/ui#message'
const graph = `
@prefix ui: <https://example.org/ui#> .
@prefix c: <https://semblance.dev/ns/component#> .
ui:message a c:Text ; c:label "Hello" .
`

function host(disallowSheet = false) {
  const { document, window } = parseHTML('<!doctype html><html><body><main id="app"></main></body></html>')
  const original = { replaceSync() {} } as unknown as CSSStyleSheet
  document.adoptedStyleSheets = [original]
  class Sheet {
    css = ''
    constructor() {
      if (disallowSheet) throw new Error('The host already loaded the stylesheet')
    }
    replaceSync(css: string) { this.css = css }
  }
  Object.defineProperty(window, 'CSSStyleSheet', { value: Sheet, configurable: true })
  Object.defineProperty(window, 'requestAnimationFrame', { value: () => 1, configurable: true })
  Object.defineProperty(window, 'cancelAnimationFrame', { value: () => {}, configurable: true })
  return { document, element: document.getElementById('app')!, original }
}

describe('web mount styles', () => {
  it('uses a host stylesheet without injecting or removing it', async () => {
    const { document, element, original } = host(true)
    const app = await mount(element, { root, graphs: [graph], store: 'n3', styles: false, files: false, fullscreen: false })
    expect(element.textContent).toContain('Hello')
    expect(document.adoptedStyleSheets).toEqual([original])
    app.unmount()
    expect(document.adoptedStyleSheets).toEqual([original])
  })

  it('still injects and removes its own stylesheet by default', async () => {
    const { document, element, original } = host()
    const app = await mount(element, { root, graphs: [graph], store: 'n3', files: false, fullscreen: false })
    expect(document.adoptedStyleSheets).toHaveLength(2)
    expect(document.adoptedStyleSheets[1]).toHaveProperty('css', expect.stringContaining('[data-sem-c="text"]'))
    app.unmount()
    expect(document.adoptedStyleSheets).toEqual([original])
  })
})
