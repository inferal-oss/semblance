import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { A11Y, MOD, SEM, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'

const UI = 'https://semblance.dev/demo#'

/** The Layout gallery page, projected on its own into a DOM. */
function showPage() {
  const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const store = loadStore('oxigraph', readFileSync(new URL('../demo/gallery/layout.ttl', import.meta.url), 'utf8'))
  const runtime = new Runtime(store)
  const root = UI + 'gallery-layout'
  const screen = runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer, SEM.SourceLayer], name: 'screen', roots: [root] }, (e) => {
    throw e
  })
  const dom = new DomRenderer(screen.index, document.getElementById('app')!, root)
  dom.flush()
  const byKey = (key: string) => [...document.querySelectorAll('*')].find((e) => dom.keyOf(e) === key) as HTMLElement
  return { document, store, runtime, dom, root: (id: string) => byKey(`${UI}${id}/~root`) }
}

describe('layout components', () => {
  it('render surfaces with their elevation and tone as hooks', () => {
    const { root } = showPage()
    expect(root('ly-flat').getAttribute('data-sem-elevation')).toBe('flat')
    expect(root('ly-raised').getAttribute('data-sem-elevation')).toBe('raised')
    expect(root('ly-overlay').getAttribute('data-sem-elevation')).toBe('overlay')
    expect(root('ly-tint-danger').getAttribute('data-sem-tone')).toBe('danger')
    expect(root('ly-tint-danger').getAttribute('data-sem-inset')).toBe('space-4')
    expect(root('ly-raised').querySelectorAll(':scope > [data-sem-c=text]')).toHaveLength(3)
  })

  it('render dividers as rules or labelled separators, either way up', () => {
    const { root } = showPage()
    expect(root('ly-div-plain').localName).toBe('hr')
    expect(root('ly-div-plain').hasAttribute('aria-orientation')).toBe(false)
    expect(root('ly-div-v1').localName).toBe('hr')
    expect(root('ly-div-v1').getAttribute('aria-orientation')).toBe('vertical')
    const labelled = root('ly-div-label')
    expect(labelled.getAttribute('role')).toBe('separator')
    expect(labelled.getAttribute('aria-label')).toBe('or continue with')
    expect(labelled.textContent).toBe('or continue with')
  })

  it('pass grid parameters to the theme as custom properties', () => {
    const { root } = showPage()
    expect(root('ly-grid-auto').getAttribute('style')).toBe('--grid-min: 140px')
    expect(root('ly-grid-auto').hasAttribute('data-columns')).toBe(false)
    expect(root('ly-grid-three').getAttribute('style')).toBe('--grid-columns: 3')
    expect(root('ly-grid-three').getAttribute('data-columns')).toBe('3')
    expect(root('ly-grid-auto').children).toHaveLength(6)
    expect(root('ly-sp-spacer').getAttribute('aria-hidden')).toBe('true')
  })

  it('never let data inject CSS through a grid parameter', () => {
    const store = loadStore(
      'oxigraph',
      `@prefix c: <https://semblance.dev/ns/component#> . @prefix ex: <https://example.org/> .
       ex:g a c:Grid ; c:minWidth "1px; background: red" ; c:columns 999 ; c:children ( ) .`,
    )
    const screen = new Runtime(store).project({ modality: MOD.Screen, layers: [STY.Layer], name: 'screen' })
    const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    new DomRenderer(screen.index, document.getElementById('app')!, 'https://example.org/g').flush()
    const grid = document.querySelector('[data-sem-c=grid]')!
    expect(grid.hasAttribute('style')).toBe(false)
    expect(grid.hasAttribute('data-columns')).toBe(false)
  })

  it('compile elevations, tints and grids from the theme', () => {
    const css = compileStyles(loadStore('n3'))
    expect(css).toMatch(/\[data-sem-c="surface"\]\[data-sem-elevation="raised"\] \{ box-shadow: var\(--sem-shadow-2\); \}/)
    expect(css).toMatch(/\[data-sem-c="surface"\]\[data-sem-elevation="overlay"\] \{[^}]*box-shadow: var\(--sem-shadow-3\)/)
    expect(css).toMatch(/\[data-sem-c="surface"\]\[data-sem-tone\] \{[^}]*background: var\(--tone-soft\)/)
    // the position layer wins over the surface's defaults
    expect(css).toContain('[data-sem-c="surface"]:not([data-sem-inset]) { padding: var(--sem-space-5); }')
    expect(css).toMatch(/\[data-sem-c="grid"\]\[data-columns\] \{ grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, max\(var\(--grid-min, 160px\)/)
  })

  it('sketch the layout in the text modality', () => {
    const store = loadStore(
      'oxigraph',
      `@prefix c: <https://semblance.dev/ns/component#> . @prefix ex: <https://example.org/> . @prefix pos: <https://semblance.dev/ns/position#> .
       ex:s a c:Surface ; c:children ( ex:t ex:d ex:l ) .
       ex:t a c:Text ; c:label "Inside" .
       ex:d a c:Divider .
       ex:l a c:Divider ; c:label "or" .`,
    )
    const text = new Runtime(store).project({ modality: MOD.Text, layers: [STY.Layer], name: 'text' })
    expect(toText(text.index, 'https://example.org/s')).toBe('┌\nInside\n────────\n──── or ────\n└')
  })
})
