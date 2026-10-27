import { parseHTML } from 'linkedom'
import { Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { DomRenderer } from '../src/render/dom.ts'
import { HtmlIndex } from '../src/render/html-index.ts'
import { toHTML } from '../src/render/serialize.ts'

const prefix = `@prefix ui: <https://example.org/ui#> .
@prefix h: <https://ia2.dev/spec/rdf-html#> .
@prefix svg: <https://semblance.dev/ns/svg#> .
@prefix sem: <https://semblance.dev/ns/core#> .`
const parse = (text: string) => new Parser().parse(prefix + text)
const root = 'https://example.org/ui#root'
const style = (value: string) => `ui:root h:style ${JSON.stringify(value)} .`
function fixture(cls = 'h:Div') {
  const { document } = parseHTML('<html><body><main></main></body></html>')
  const host = document.querySelector('main')!, index = new HtmlIndex()
  const renderer = new DomRenderer(index, host, 'https://example.org/ui#page')
  index.apply({ remove: [], add: parse(`ui:root a ${cls} ; sem:renders ui:page .`) })
  renderer.flush()
  return { host, renderer, index, element: renderer.nodeOf(root) as HTMLElement,
    patch(before: string, after: string) {
      index.apply({ remove: before ? parse(style(before)) : [], add: after ? parse(style(after)) : [] })
      renderer.flush()
    },
  }
}

describe('graph style declaration reflection', () => {
  it('uses the CSSOM for initial styles and updates without replacing the keyed element', () => {
    const f = fixture(), original = f.element, calls: string[] = []
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(f.element.style), 'cssText')!
    Object.defineProperty(f.element.style, 'cssText', { configurable: true,
      get() { return descriptor.get!.call(this) },
      set(value: string) { calls.push(value); descriptor.set!.call(this, value) },
    })
    f.patch('', 'width: 75%; --sem-progress: 75; color: green')
    expect(f.element.style.getPropertyValue('width')).toBe('75%')
    expect(f.element.style.getPropertyValue('--sem-progress')).toBe('75')
    const writes = calls.length
    f.patch('width: 75%; --sem-progress: 75; color: green', 'width: 25%; --sem-progress: 75; color: green')
    expect(calls.slice(writes)).toEqual(['width: 25%; --sem-progress: 75; color: green'])
    expect(f.renderer.nodeOf(root)).toBe(original)
    expect(f.element.style.getPropertyValue('width')).toBe('25%')
  })
  it('removes declarations absent from the new graph style, then removes the whole style attribute', () => {
    const f = fixture()
    f.patch('', 'width: 75%; color: green; --sem-progress: 75')
    f.patch('width: 75%; color: green; --sem-progress: 75', 'width: 25%')
    expect(f.element.style.getPropertyValue('color')).toBe('')
    expect(f.element.style.getPropertyValue('--sem-progress')).toBe('')
    f.patch('width: 25%', '')
    expect(f.element.hasAttribute('style')).toBe(false)
  })
  it('preserves CSS punctuation and priority syntax for the browser parser', () => {
    const f = fixture(), value = '--quoted: "a;b:c"; background-image: url("data:image/svg+xml;a:b"); color: green !important'
    f.patch('', value)
    expect(f.element.getAttribute('style')).toContain('!important')
    // The RDF/HTML serializer is independent of CSSOM normalization.
    expect(toHTML(f.index, 'https://example.org/ui#page')).toContain('a;b:c')
    expect(toHTML(f.index, 'https://example.org/ui#page')).toContain('green !important')
  })
  it('does no style writes when an unrelated attribute changes', () => {
    const f = fixture(), value = 'width: 75%; --sem-progress: 75'
    f.patch('', value)
    const ops = f.renderer.ops
    f.index.apply({ remove: [], add: parse('ui:root h:title "Current sample" .') })
    f.renderer.flush()
    expect(f.renderer.ops - ops).toBe(1)
    expect(f.element.style.getPropertyValue('--sem-progress')).toBe('75')
  })
  it('reflects SVG presentation styles through the same CSSOM path', () => {
    const f = fixture('svg:Svg'), value = 'stroke: var(--sem-series-1); fill: none'
    f.patch('', value)
    expect(f.element.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(f.element.style.getPropertyValue('stroke')).toBe('var(--sem-series-1)')
    expect(f.element.style.getPropertyValue('fill')).toBe('none')
  })
})
