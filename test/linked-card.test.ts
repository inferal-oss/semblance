import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { A11Y, MOD, SEM, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'

const UI = 'https://example.org/linked-card#'
const graph = `
@prefix ui: <${UI}> .
@prefix c: <https://semblance.dev/ns/component#> .
ui:linked a c:LinkedCard ; c:href "/project/acme" ; c:label "Acme project" ; c:content ui:card .
ui:card a c:Card ; c:label "Acme" ; c:content ui:detail .
ui:detail a c:Text ; c:label "Three tickets" .
`

describe('c:LinkedCard', () => {
  it('wraps a card in one named link, with its content inside', () => {
    const store = loadStore('oxigraph', graph)
    const screen = new Runtime(store).project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer, SEM.SourceLayer], name: 'screen', roots: [UI + 'linked'] })
    const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    new DomRenderer(screen.index, document.getElementById('app')!, UI + 'linked').flush()
    const link = document.querySelector('[data-sem-c="linked-card"]')!
    expect(link.localName).toBe('a')
    expect(link.getAttribute('href')).toBe('/project/acme')
    expect(link.getAttribute('aria-label')).toBe('Acme project')
    expect(link.querySelector('[data-sem-c="card"]')?.textContent).toContain('Three tickets')
    expect(link.querySelectorAll('a')).toHaveLength(0)
  })

  it('includes the target after the content in text output', () => {
    const store = loadStore('oxigraph', graph)
    const text = new Runtime(store).project({ modality: MOD.Text, layers: [STY.Layer], name: 'text', roots: [UI + 'linked'] })
    expect(toText(text.index, UI + 'linked')).toMatch(/Three tickets\n\s*<\/project\/acme>/)
  })

  it('renders the same screen and text with either rule implementation', () => {
    for (const modality of [MOD.Screen, MOD.Text]) {
      const render = (prefer: 'sparql' | 'function') => {
        const store = loadStore('oxigraph', graph)
        const projection = new Runtime(store).project({ modality, layers: [A11Y.Layer, STY.Layer, SEM.SourceLayer], name: 'linked', roots: [UI + 'linked'], prefer })
        const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
        new DomRenderer(projection.index, document.getElementById('app')!, UI + 'linked').flush()
        return document.getElementById('app')!.innerHTML
      }
      expect(render('function')).toBe(render('sparql'))
    }
  })

  it('provides a visible focus ring', () => {
    const css = compileStyles(loadStore('n3'))
    expect(css).toContain('[data-sem-c="linked-card"]:focus-visible { outline: 2px solid var(--sem-accent); outline-offset: 2px; }')
  })
})
