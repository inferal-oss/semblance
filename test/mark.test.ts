import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderMark } from '../src/mark.ts'
import { loadStore } from '../src/node/load.ts'
import { mountSite } from './harness.ts'


describe("Semblance's mark", () => {
  it('is the favicon, rendered from the ontology (npm run gen:mark)', () => {
    expect(readFileSync(new URL('../demo/favicon.svg', import.meta.url), 'utf8')).toBe(renderMark(loadStore('n3')))
  })

  it('is the same drawing in the app bar and on the landing page, by SPARQL or by functions', () => {
    const draw = (el: Element) => [...el.querySelectorAll('path, circle')].map((p) => `${p.localName} ${p.getAttribute('d') ?? ''}${p.getAttribute('cx') ?? ''},${p.getAttribute('cy') ?? ''},${p.getAttribute('r') ?? ''} ${p.getAttribute('class')}`)
    const marks = (prefer: 'sparql' | 'function') => {
      const { document } = mountSite('oxigraph', prefer)
      return [...document.querySelectorAll('[data-sem-c=graph-mark]')]
    }
    const [logo, hero] = marks('sparql')
    expect(draw(logo!)).toEqual(draw(hero!))
    expect(draw(logo!)).toEqual(draw(marks('function')[0]!))
    // An S of three nodes on one curve, and the curve's echo.
    expect(logo!.querySelectorAll('circle')).toHaveLength(3)
    expect(logo!.querySelector('.sem-echo')!.getAttribute('transform')).toBe('translate(1.4 1.4)')
    expect(hero!.getAttribute('data-sem-size')).toBe('lg')
    expect(logo!.getAttribute('aria-label')).toBe('Semblance')
  })

  it('is drawn from the geometry on c:GraphMark (read like the rest of the ontology, when a projection is built)', () => {
    const store = loadStore('n3')
    const f = store.factory
    const C = 'https://semblance.dev/ns/component#'
    for (const q of store.match(f.namedNode(C + 'GraphMark'), f.namedNode(C + 'markPath'), null)) store.delete(q)
    store.add(f.quad(f.namedNode(C + 'GraphMark'), f.namedNode(C + 'markPath'), f.literal('M8 8 L24 24')))
    expect(renderMark(store)).toContain('<path class="sem-edge" d="M8 8 L24 24">')
  })
})
