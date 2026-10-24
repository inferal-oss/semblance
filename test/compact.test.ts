// On a compact screen (a phone held upright): width classes in the style compiler.
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { NS } from '../src/ns.ts'
import { compileStyles } from '../src/style/compile.ts'

const UI = 'https://semblance.dev/demo#'
const COMPACT = '@media (max-width: 640px) {'

/** The body of one @layer of the compiled CSS. */
function layerOf(css: string, name: string): string {
  const at = css.indexOf(`@layer sem.${name} {\n`)
  if (at < 0) throw new Error(`no layer ${name}`)
  return css.slice(at, css.indexOf('\n}', at))
}

describe('width classes (sty:atWidth)', () => {
  const css = compileStyles(loadStore('n3'))

  it('compile a rule inside its width class’s media condition, after the layer’s other rules', () => {
    const components = layerOf(css, 'components')
    const media = components.indexOf(COMPACT)
    expect(media).toBeGreaterThan(0)
    // The status bar's contents wrap where there is room; on a compact screen they are one line.
    const plain = components.indexOf('  [data-sem-c="status-bar"] > .sem-bar-body { ')
    const compact = components.indexOf('    [data-sem-c="status-bar"] > .sem-bar-body { ', media)
    expect(plain).toBeGreaterThan(0)
    expect(plain).toBeLessThan(media)
    expect(components.slice(plain, components.indexOf('}', plain))).toContain('flex-wrap: wrap;')
    expect(compact).toBeGreaterThan(media)
    expect(components.slice(compact, components.indexOf('}', compact))).toContain('flex-wrap: nowrap;')
  })

  it('fold the chrome and stack what sits side by side on a phone', () => {
    const compact = css.slice(css.indexOf(COMPACT))
    // The status bar is one scrolling line, a split view stacks, a docked sheet keeps to half the screen.
    expect(compact).toMatch(/\[data-sem-c="status-bar"\] > \.sem-bar-body \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/)
    expect(compact).toMatch(/\[data-sem-c="split-view"\] \{ flex-direction: column; \}/)
    expect(compact).toMatch(/\[data-sem-c="split-view"\] > \.sem-divider \{ display: none; \}/)
    expect(css).toMatch(/@media \(max-width: 640px\) \{[^@]*\[data-sem-edge="bottom"\][^{]*\{ max-height: 50dvh; \}/)
    // The navigation of an aside layout is as wide as the page.
    expect(compact).toContain('[data-sem-layout=aside] > :first-child:not(:only-child) { flex-basis: 100%; max-width: 100%; }')
  })

  it('compile any width class declared as data', () => {
    const store = loadStore('n3')
    const f = store.factory
    const n = (s: string) => f.namedNode(s)
    const rule = n('urn:test:wide-rule')
    const decl = n('urn:test:wide-decl')
    store.add(f.quad(n(NS.sty + 'Wide'), n(NS.rdf + 'type'), n(NS.sty + 'WidthClass')))
    store.add(f.quad(n(NS.sty + 'Wide'), n(NS.sty + 'media'), f.literal('(min-width: 1400px)')))
    store.add(f.quad(rule, n(NS.rdf + 'type'), n(NS.sty + 'StyleRule')))
    store.add(f.quad(rule, n(NS.sty + 'appliesTo'), n(NS.c + 'Card')))
    store.add(f.quad(rule, n(NS.sty + 'atWidth'), n(NS.sty + 'Wide')))
    store.add(f.quad(rule, n(NS.sty + 'declares'), decl))
    store.add(f.quad(decl, n(NS.sty + 'property'), f.literal('max-width')))
    store.add(f.quad(decl, n(NS.sty + 'raw'), f.literal('72rem')))
    const wide = compileStyles(store)
    expect(wide).toContain('  @media (min-width: 1400px) {\n    [data-sem-c="card"] { max-width: 72rem; }\n  }')
  })
})
