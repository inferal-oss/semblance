import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { A11Y, MOD, SEM, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'
import { mountShell } from './harness.ts'
import { expectSameRendering } from './implementations.ts'

// c:LinkedCard is a c:Link whose body is a component (c:content): one link around a card, with
// everything a link has (c:to, c:external and its spoken hint, c:currentPage).

const UI = 'https://example.org/linked-card#'
const graph = `
@prefix ui: <${UI}> .
@prefix c: <https://semblance.dev/ns/component#> .
ui:named a c:LinkedCard ; c:href "/project/acme" ; c:label "Acme project" ; c:content ui:card .
ui:unnamed a c:LinkedCard ; c:href "#acme" ; c:currentPage true ; c:content ui:card2 .
ui:out a c:LinkedCard ; c:href "https://example.com/acme" ; c:label "Acme site" ; c:content ui:card3 .
ui:current a c:Link ; c:href "#here" ; c:label "Here" ; c:currentPage true .
ui:card a c:Card ; c:label "Acme" ; c:badge "3" ; c:note "Three tickets" ; c:content ui:detail .
ui:detail a c:Text ; c:label "Due Friday" .
ui:card2 a c:Card ; c:label "Beta" ; c:content ui:detail2 .
ui:detail2 a c:Text ; c:label "Nothing due" .
ui:card3 a c:Card ; c:label "Acme on the web" ; c:content ui:detail3 .
ui:detail3 a c:Text ; c:label "Its public site" .
ui:all a c:Stack ; c:children ( ui:named ui:unnamed ui:out ui:current ) .
`

function screen(prefer: 'sparql' | 'function', languages?: string[]) {
  const store = loadStore('oxigraph', graph)
  const projection = new Runtime(store).project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer, SEM.SourceLayer], name: 'screen', roots: [UI + 'all'], prefer, languages })
  const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  new DomRenderer(projection.index, document.getElementById('app')!, UI + 'all').flush()
  return document
}
const text = (prefer: 'sparql' | 'function') => {
  const store = loadStore('oxigraph', graph)
  return toText(new Runtime(store).project({ modality: MOD.Text, layers: [STY.Layer], name: 'text', roots: [UI + 'all'], prefer }).index, UI + 'all')
}
const card = (document: Document, n: number) => document.querySelectorAll('[data-sem-c="linked-card"]')[n]!

describe('c:LinkedCard', () => {
  for (const prefer of ['sparql', 'function'] as const) {
    describe(`with ${prefer} rules`, () => {
      it('wraps a card in one link named by its label', () => {
        const link = card(screen(prefer), 0)
        expect(link.localName).toBe('a')
        expect(link.getAttribute('href')).toBe('/project/acme')
        expect(link.getAttribute('aria-label')).toBe('Acme project')
        expect(link.children[0]!.getAttribute('data-sem-c')).toBe('card')
        expect(link.textContent).toContain('Three tickets')
        // The card is the body: no label text of its own, no link inside.
        expect(link.childNodes).toHaveLength(1)
        expect(link.querySelectorAll('a')).toHaveLength(0)
      })

      it("is named by its card's text when it has no label, and marks the current page", () => {
        const link = card(screen(prefer), 1)
        expect(link.hasAttribute('aria-label')).toBe(false)
        expect(link.getAttribute('aria-current')).toBe('page')
      })

      it('opens an external address in a new tab, and says so in its name in the viewer\'s language', () => {
        const link = card(screen(prefer), 2)
        expect(link.getAttribute('target')).toBe('_blank')
        expect(link.getAttribute('rel')).toBe('noopener noreferrer')
        expect(link.querySelector('.sem-external')?.getAttribute('aria-hidden')).toBe('true')
        expect(link.getAttribute('aria-label')).toBe('Acme site (opens in a new tab)')
        expect(card(screen(prefer, ['ar']), 2).getAttribute('aria-label')).toBe('Acme site (يفتح في علامة تبويب جديدة)')
        expect(card(screen(prefer, ['uk']), 2).getAttribute('aria-label')).toBe('Acme site (відкривається в новій вкладці)')
      })

      it('gives c:Link the current page too', () => {
        const link = screen(prefer).querySelector('[data-sem-c="link"]')!
        expect(link.getAttribute('aria-current')).toBe('page')
        expect(link.hasAttribute('aria-label')).toBe(false)
      })

      it('gives the address after the content in text', () => {
        const out = text(prefer)
        expect(out).toMatch(/Due Friday\s*<\/project\/acme>/)
        expect(out).toMatch(/Its public site\s*<https:\/\/example\.com\/acme> ↗/)
        expect(out).toContain('Here <#here>')
      })
    })
  }

  it('renders the same screen and text with either rule implementation', () => {
    expect(screen('function').getElementById('app')!.innerHTML).toBe(screen('sparql').getElementById('app')!.innerHTML)
    expect(screen('function', ['ar']).getElementById('app')!.innerHTML).toBe(screen('sparql', ['ar']).getElementById('app')!.innerHTML)
    expect(text('function')).toBe(text('sparql'))
  })

  it('is styled as a surface, not as running text: block, its focus ring, its edge lit when current', () => {
    const css = compileStyles(loadStore('n3'))
    expect(css).toMatch(/\[data-sem-c="linked-card"\] \{[^}]*display: block;[^}]*text-decoration: none;/)
    expect(css).toMatch(/\[data-sem-c="linked-card"\]:focus-visible \{[^}]*box-shadow: var\(--sem-ring\);/)
    expect(css).toContain('[data-sem-c="linked-card"]:is(:hover, [aria-current=page]) > :not(.sem-external, .sem-sr)')
  })
})

describe('the Layout gallery page', () => {
  it('links a card to a specimen where the site shows it (c:to)', () => {
    const h = mountShell()
    const f = h.store.factory
    h.showPage('Components')
    const app = f.namedNode('https://semblance.dev/demo#app')
    const p = f.namedNode('https://semblance.dev/demo#galleryGroup')
    h.runtime.apply({ remove: h.store.match(app, p, null), add: [f.quad(app, p, f.namedNode('https://semblance.dev/demo#GroupLayout'))] })
    h.shell.flush()
    const cards = h.document.querySelectorAll('[data-sem-c="linked-card"]')
    expect(cards.length).toBe(3)
    expect(cards[1]!.getAttribute('href')).not.toBe('#type')
    expect(cards[1]!.getAttribute('href')).toMatch(/ty-links/)
  })

  it('renders the same with SPARQL rules as with functions', () => {
    expectSameRendering(['GroupLayout', 'GroupType'])
  })
})
