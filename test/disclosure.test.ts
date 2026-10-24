import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { A11Y, MOD, NS, SEM, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'

const UI = 'https://semblance.dev/demo#'

/** The Disclosure gallery page, projected on its own into a DOM and driven through events. */
function showPage(kind: StoreKind = 'oxigraph', prefer?: 'sparql' | 'function') {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const store = loadStore(kind, readFileSync(new URL('../demo/gallery/disclosure.ttl', import.meta.url), 'utf8'))
  const runtime = new Runtime(store)
  const root = UI + 'gallery-disclosure'
  const screen = runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer, SEM.SourceLayer], name: 'screen', roots: [root] }, (e) => {
    throw e
  })
  const dom = new DomRenderer(screen.index, document.getElementById('app')!, root)
  dom.flush()
  const bus = new EventBus(runtime, screen, { prefer })
  bus.attach(dom, () => dom.flush())
  const byKey = (key: string) => [...document.querySelectorAll('*')].find((e) => dom.keyOf(e) === key) as HTMLElement
  const item = (id: string) => byKey(`${UI}${id}/~root`)
  const header = (id: string) => item(id).querySelector('.sem-trigger') as HTMLButtonElement
  const click = (el: Element) => el.dispatchEvent(new window.Event('click', { bubbles: true }))
  const expanded = (id: string) => header(id).getAttribute('aria-expanded') === 'true'
  // Runs of every implementation of a rendering (SPARQL or function, whichever is preferred).
    const runs = (rendering: string) => [...screen.engine.stats.byRule].filter(([iri]) => iri.startsWith(NS.c + rendering.replace(/-(fn|sparql)$/, '') + '-')).reduce((n, [, s]) => n + s.runs, 0)
  return { document, store, runtime, screen, dom, bus, item, header, click, expanded, runs }
}

const LAYERS = ['modality', 'style', 'position', 'a11y', 'behaviour', 'provenance', 'source'].map((k) => 'dc-layer-' + k)

describe('c:Accordion', () => {
  it('renders each item as a heading button controlling a labelled region', () => {
    const { item, header, expanded } = showPage()
    const first = item(LAYERS[0]!)
    const button = header(LAYERS[0]!)
    const panel = first.querySelector('.sem-panel')!
    expect(button.closest('h3')).not.toBeNull()
    expect(button.getAttribute('type')).toBe('button')
    expect(button.getAttribute('aria-controls')).toBe(panel.getAttribute('id'))
    expect(panel.getAttribute('role')).toBe('region')
    expect(panel.getAttribute('aria-labelledby')).toBe(button.getAttribute('id'))
    expect(expanded(LAYERS[0]!)).toBe(true)
    expect(first.getAttribute('data-expanded')).toBe('true')
    expect(panel.hasAttribute('inert')).toBe(false)
    expect(expanded(LAYERS[1]!)).toBe(false)
    expect(item(LAYERS[1]!).querySelector('.sem-panel')!.hasAttribute('inert')).toBe(true)
    expect(button.textContent).toBe('ModalityScreen and Text projections of one graph')
  })

  for (const [kind, prefer] of [['oxigraph', 'sparql'], ['oxigraph', 'function'], ['n3', undefined], ['wat', 'sparql'], ['rust', 'sparql']] as const) {
    it(`toggles through a reaction; exclusive accordions close the others (${kind}${prefer ? ', ' + prefer : ''})`, () => {
      const { store, click, header, expanded, item } = showPage(kind, prefer)
      const f = store.factory
      const state = (id: string) => store.match(f.namedNode(UI + id), f.namedNode(NS.c + 'expanded'), null).map((q) => q.object.value)
      // Opening another item closes the open one.
      click(header(LAYERS[2]!))
      expect(LAYERS.map((id) => expanded(id))).toEqual([false, false, true, false, false, false, false])
      expect(state(LAYERS[0]!)).toEqual([]) // closed by removing its c:expanded true
      expect(state(LAYERS[2]!)).toEqual(['true'])
      // Clicking it again closes it.
      click(header(LAYERS[2]!))
      expect(LAYERS.some((id) => expanded(id))).toBe(false)
      // A click inside a panel's content does not toggle.
      click(header(LAYERS[3]!))
      click(item(LAYERS[3]!).querySelector('.sem-panel-body p')!)
      expect(expanded(LAYERS[3]!)).toBe(true)
      // Without c:exclusive, items open independently.
      click(header('dc-faq-3'))
      expect(['dc-faq-1', 'dc-faq-2', 'dc-faq-3'].map((id) => expanded(id))).toEqual([true, true, true])
      click(header('dc-faq-1'))
      expect(['dc-faq-1', 'dc-faq-2', 'dc-faq-3'].map((id) => expanded(id))).toEqual([false, true, true])
    })
  }

  it('re-renders only the items that changed', () => {
    const { click, header, runs, dom } = showPage()
    const items = runs('AccordionItemRendering-fn')
    const accordions = runs('AccordionRendering-fn')
    const ops = dom.ops
    click(header(LAYERS[4]!)) // opens one, closes another
    expect(runs('AccordionItemRendering-fn') - items).toBe(2)
    expect(runs('AccordionRendering-fn') - accordions).toBe(0)
    const opsOpenClose = dom.ops - ops
    // Toggling an item in the other, non-exclusive accordion touches only that item.
    const before = runs('AccordionItemRendering-fn')
    click(header('dc-faq-3'))
    expect(runs('AccordionItemRendering-fn') - before).toBe(1)
    expect(opsOpenClose).toBeLessThan(20)
  })

  it('animates the panel with the motion tokens', () => {
    const css = compileStyles(loadStore('n3'))
    const panel = css.match(/\[data-sem-c="accordion-item"\] > \.sem-panel \{([^}]*)\}/)![1]
    expect(panel).toContain('grid-template-rows: 0fr;')
    expect(panel).toContain('transition: grid-template-rows var(--sem-duration) var(--sem-ease), opacity var(--sem-duration) var(--sem-ease);')
    expect(css).toMatch(/\[data-sem-c="accordion-item"\]\[data-expanded=true\] > \.sem-panel \{[^}]*grid-template-rows: 1fr/)
  })

  it('sketches open items with their content in the text modality', () => {
    const store = loadStore(
      'oxigraph',
      `@prefix c: <https://semblance.dev/ns/component#> . @prefix ex: <https://example.org/> .
       ex:acc a c:Accordion ; c:items ( ex:a ex:b ) .
       ex:a a c:AccordionItem ; c:label "Open" ; c:expanded true ; c:content ex:a-text .
       ex:a-text a c:Text ; c:label "Shown." .
       ex:b a c:AccordionItem ; c:label "Closed" ; c:content ex:b-text .
       ex:b-text a c:Text ; c:label "Hidden." .`,
    )
    const text = new Runtime(store).project({ modality: MOD.Text, layers: [A11Y.Layer, STY.Layer], name: 'text' })
    expect(toText(text.index, 'https://example.org/acc')).toBe('▾ Open\nShown.\n▸ Closed')
  })
})
