// The outlines layer (ontology/layers/outline.ttl): the Layers gallery page's outlined report,
// driven through events as a person would - the switch flipped, the viewer's language changed -
// with the DOM and the graph checked, and the SPARQL rules and their function twins rendering the
// same HTML after every step, on Oxigraph and on Semblance's own engine.
import { describe, expect, it } from 'vitest'
import { OL } from '../src/ns.ts'
import { compileStyles } from '../src/style/compile.ts'
import { mountShell } from './harness.ts'
import { implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
type Kind = 'oxigraph' | 'wat'

function layers(kind: Kind = 'oxigraph', prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountShell(5, kind, prefer)
  const f = h.store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  h.showPage('Components')
  h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupLayers'))] })
  h.shell.flush()
  const root = (id: string) => h.shell.nodeOf(`${UI}${id}/~root`) as HTMLElement
  const flip = () => (h.fire(root('outlineSwitch').querySelector('button')!, 'click'), h.shell.flush())
  const language = (code: string) => (h.screen.engine.reconfigure({ languages: [code] }), h.shell.flush())
  const shows = () => h.store.match(f.namedNode(UI + 'outlineReport'), f.namedNode(OL.shows), null).map((q) => q.object.value)
  /** The outline names in the report, in document order. */
  const names = () => [...root('outlineReport').querySelectorAll('[data-sem-outline]')].map((e) => e.getAttribute('data-sem-outline'))
  return { ...h, root, flip, language, shows, names, html: () => root('l-outlines-spec').outerHTML }
}

describe('the outlines layer', () => {
  it('names the named components and marks the container that shows them', () => {
    const h = layers()
    expect(h.root('outlineReport').getAttribute('data-sem-outlines')).toBe('shown')
    expect(h.names()).toEqual(['title', 'figures', 'stat', 'actions'])
    // An unnamed component is not outlined; the name is on the component's own root.
    expect(h.root('outlineReturns').hasAttribute('data-sem-outline')).toBe(false)
    expect(h.root('outlineOrders').getAttribute('data-sem-outline')).toBe('stat')
    expect(h.root('outlineSwitch').querySelector('button')!.getAttribute('aria-checked')).toBe('true')
  })

  it('turns outlines off and on with a switch that controls ol:shows, the names staying', () => {
    const h = layers()
    h.flip()
    expect(h.shows()).toEqual(['false'])
    expect(h.root('outlineReport').hasAttribute('data-sem-outlines')).toBe(false)
    expect(h.root('outlineSwitch').querySelector('button')!.getAttribute('aria-checked')).toBe('false')
    expect(h.names()).toEqual(['title', 'figures', 'stat', 'actions'])
    h.flip()
    expect(h.shows()).toEqual(['true'])
    expect(h.root('outlineReport').getAttribute('data-sem-outlines')).toBe('shown')
  })

  it("names in the viewer's language", () => {
    const h = layers()
    h.language('uk')
    expect(h.names()).toEqual(['заголовок', 'показники', 'показник', 'дії'])
    h.language('ar')
    expect(h.names()).toEqual(['العنوان', 'الأرقام', 'رقم', 'الإجراءات'])
    h.language('en')
    expect(h.names()).toEqual(['title', 'figures', 'stat', 'actions'])
  })

  it('follows a renamed component, and a component named or unnamed later', () => {
    const h = layers()
    const f = h.store.factory
    const title = f.namedNode(UI + 'outlineTitle')
    const returns = f.namedNode(UI + 'outlineReturns')
    h.runtime.apply({ remove: h.store.match(title, f.namedNode(OL.label), null), add: [f.quad(title, f.namedNode(OL.label), f.literal('headline'))] })
    h.runtime.apply({ remove: [], add: [f.quad(returns, f.namedNode(OL.label), f.literal('returns'))] })
    h.shell.flush()
    expect(h.names()).toEqual(['headline', 'figures', 'stat', 'returns', 'actions'])
    h.runtime.apply({ remove: h.store.match(returns, f.namedNode(OL.label), null), add: [] })
    h.shell.flush()
    expect(h.names()).toEqual(['headline', 'figures', 'stat', 'actions'])
  })

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders the same with SPARQL rules as with functions after every step (${kind})`, () => {
      const [a, b] = [layers(kind, 'sparql'), layers(kind, 'function')]
      const same = (step: string) => expect(a.html(), step).toBe(b.html())
      same('first render')
      for (const h of [a, b]) h.flip()
      same('switched off')
      for (const h of [a, b]) h.language('de')
      same('in German')
      for (const h of [a, b]) h.flip()
      same('switched on in German')
      expect(a.names()).toEqual(['Titel', 'Kennzahlen', 'Kennzahl', 'Aktionen'])
    })
  }

  it('has a SPARQL rule and a function for each rendering', () => {
    expect(implementationGaps(['layers/outline.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })

  it('draws overlays that never move anything, the tag mirrored by logical insets', () => {
    const css = compileStyles(layers().store)
    const block = (selector: string) => css.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[[\]()]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? ''
    const outline = block('[data-sem-outlines=shown] [data-sem-outline]')
    expect(outline).toContain('outline: 2px dashed var(--sem-accent)')
    expect(outline).not.toMatch(/(^|[\s;])(margin|padding|border|width|height)[\w-]*:/)
    // Its position only where nothing else positions the component (no specificity).
    expect(block(':where([data-sem-outlines=shown] [data-sem-outline])')).toContain('position: relative')
    const tag = block('[data-sem-outlines=shown] [data-sem-outline]::before')
    expect(tag).toContain('position: absolute')
    expect(tag).toContain('inset-inline-start:')
    expect(tag).not.toMatch(/(^|[\s;])(left|right):/)
    expect(tag).toContain('pointer-events: none')
    expect(tag).toContain('content: attr(data-sem-outline) / ""')
  })
})
