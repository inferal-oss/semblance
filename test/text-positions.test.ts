import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { codePoints, pointOf } from '../src/behaviour/text.ts'

// Where a DOM point is in a rich text region's text (src/behaviour/text.ts): a node and an offset in
// code points, also for points between elements.

const page = () => {
  const { document } = parseHTML(`<!doctype html><html><body><div data-sem-text-root=""><p><span data-sem-text="a">ab<strong>cd</strong>ef<span class="x"></span>gh</span></p><p><span data-sem-text="b">😀z</span></p></div></body></html>`)
  const region = document.querySelector('[data-sem-text-root]')!
  return { document, region, a: document.querySelector('[data-sem-text="a"]')!, b: document.querySelector('[data-sem-text="b"]')! }
}

describe('text positions', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(codePoints('😀z')).toBe(2)
    const { region, b } = page()
    expect(pointOf(region, b.firstChild!, 2)).toEqual({ node: 'b', offset: 1 })
  })
  it('maps a point after an element\'s last child, and in an empty element, to the text before it', () => {
    const { region, a } = page()
    const strong = a.querySelector('strong')!
    expect(pointOf(region, strong, 1)).toEqual({ node: 'a', offset: 4 })
    expect(pointOf(region, a.querySelector('.x')!, 0)).toEqual({ node: 'a', offset: 6 })
    expect(pointOf(region, a, 1)).toEqual({ node: 'a', offset: 2 })
  })
  it('maps a point between blocks to the start of the next, and one at the region\'s end to the end of the last', () => {
    const { region } = page()
    expect(pointOf(region, region, 1)).toEqual({ node: 'b', offset: 0 })
    expect(pointOf(region, region, region.childNodes.length)).toEqual({ node: 'b', offset: 2 })
    const first = region.firstElementChild!
    expect(pointOf(region, first, first.childNodes.length)).toEqual({ node: 'b', offset: 0 })
  })
})
