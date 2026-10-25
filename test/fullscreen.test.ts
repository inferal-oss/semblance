// Full screen as a fact (ontology/layers/fullscreen.ttl, src/fullscreen.ts): fs:fullscreen on a
// component, asserted by a full-screenable component's own toggle, a c:Toggle over the property
// (and its key), or a reaction; performed by the fullscreen effect over a stand-in host; and
// retracted when the host leaves on its own. Driven through events on the site, DOM and graph.
import { describe, expect, it } from 'vitest'
import type { StoreKind } from '../src/node/load.ts'
import { FS, NS } from '../src/ns.ts'
import { mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

function site(kind: StoreKind = 'oxigraph', prefer: 'sparql' | 'function' = 'sparql', example = 'Kanban board') {
  const h = mountSite(kind, prefer)
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  click(button('Examples'))
  click(navItem(example))
  const f = h.store.factory
  const fact = (c: string) => h.store.match(f.namedNode(c), f.namedNode(FS.fullscreen), null).map((q) => q.object.value)
  const presentation = (c: string) => h.store.match(f.namedNode(c), f.namedNode(FS.presentation), null).map((q) => q.object.value)
  const toasts = () => [...h.document.querySelectorAll('[data-sem-c=toast]')].map((t) => t.textContent).join(' | ')
  const settle = async () => {
    await h.screens.settled()
    h.shell.flush()
  }
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key: k, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...mods })
    h.document.body.dispatchEvent(e)
    h.shell.flush()
  }
  return { ...h, click, button, fact, presentation, toasts, settle, key }
}

const WALK = UI + 'ex-kanban-how'
const diagram = (h: ReturnType<typeof site>) => h.shell.nodeOf(WALK + '/~diagram') as Element
const diagramToggle = (h: ReturnType<typeof site>) => diagram(h).querySelector('.sem-fullscreen-toggle') as Element

describe('full screen (fs:fullscreen)', () => {
  for (const [kind, prefer] of [
    ['oxigraph', 'sparql'],
    ['oxigraph', 'function'],
    ['wat', 'sparql'],
  ] as const)
    it(`a walkthrough's own toggle shows its diagram full screen; Esc retracts the fact (${kind}, ${prefer})`, async () => {
      const h = site(kind, prefer)
      const toggle = diagramToggle(h)
      expect(toggle.getAttribute('aria-label')).toBe('Full screen')
      expect(toggle.getAttribute('aria-pressed')).toBe('false')
      expect(diagram(h).hasAttribute('data-sem-fullscreen')).toBe(false)
      h.click(toggle)
      // The fact, and the host asked in the click's own task, for the part the class names.
      expect(h.fact(WALK)).toEqual(['true'])
      expect(h.fullscreen.requests).toEqual([diagram(h)])
      expect(diagramToggle(h).getAttribute('aria-pressed')).toBe('true')
      await h.settle()
      // How the host shows it came back as an event: recorded, marked, said.
      expect(h.presentation(WALK)).toEqual([FS.Native])
      expect(diagram(h).getAttribute('data-sem-fullscreen')).toBe('native')
      expect(h.toasts()).toContain('Full screen. Esc leaves it')
      // The person leaves (Esc, the browser's control): the graph follows the screen.
      h.fullscreen.leave()
      h.shell.flush()
      expect(h.fact(WALK)).toEqual([])
      expect(h.presentation(WALK)).toEqual([])
      expect(diagram(h).hasAttribute('data-sem-fullscreen')).toBe(false)
      expect(diagramToggle(h).getAttribute('aria-pressed')).toBe('false')
      expect(h.toasts()).toContain('Left full screen')
    })

  it('pressing the toggle again retracts the fact, and the host leaves full screen', async () => {
    const h = site()
    h.click(diagramToggle(h))
    await h.settle()
    expect(h.fullscreen.element).toBe(diagram(h))
    h.click(diagramToggle(h))
    expect(h.fact(WALK)).toEqual(['false'])
    expect(h.fullscreen.element).toBeNull()
    await h.settle()
    expect(h.presentation(WALK)).toEqual([])
    expect(diagram(h).hasAttribute('data-sem-fullscreen')).toBe(false)
  })

  it('where the host refuses, it is shown over the page (fs:Maximized), and Esc leaves that too', async () => {
    const h = site()
    h.fullscreen.allowed = false
    h.click(diagramToggle(h))
    await h.settle()
    expect(h.fullscreen.element).toBeNull()
    expect(h.presentation(WALK)).toEqual([FS.Maximized])
    expect(diagram(h).getAttribute('data-sem-fullscreen')).toBe('maximized')
    expect(h.toasts()).toContain('Shown over the page')
    h.key('Escape')
    await h.settle()
    expect(h.fact(WALK)).toEqual([])
    expect(diagram(h).hasAttribute('data-sem-fullscreen')).toBe(false)
  })

  it("a source view's toggle shows the whole source view (its root)", async () => {
    const h = site()
    const view = h.shell.nodeOf(UI + 'exs-kanban/~root') as Element
    const toggle = view.querySelector('.sem-source-head .sem-fullscreen-toggle')!
    h.click(toggle)
    await h.settle()
    expect(h.fact(UI + 'exs-kanban')).toEqual(['true'])
    expect(h.fullscreen.element).toBe(view)
    expect(view.getAttribute('data-sem-fullscreen')).toBe('native')
    // The walkthrough around it is not affected.
    expect(h.fact(WALK)).toEqual([])
  })

  it('a c:Toggle over fs:fullscreen, by click and by its key, and a reaction asserting the fact (the dashboard)', async () => {
    const h = site('oxigraph', 'sparql', 'Sales dashboard')
    const card = UI + 'ex-dashboard-region-card'
    const cardEl = () => h.shell.nodeOf(card + '/~root') as Element
    const toggle = () => cardEl().querySelector('[data-sem-c=toggle]') as Element
    expect(toggle().textContent).toBe('Full screen')
    h.click(toggle())
    await h.settle()
    expect(h.fact(card)).toEqual(['true'])
    expect(h.fullscreen.element).toBe(cardEl())
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    // F presses the toggle again: the fact goes, and so does the host's full screen.
    h.key('f')
    await h.settle()
    expect(h.fact(card)).toEqual(['false'])
    expect(h.fullscreen.element).toBeNull()
    // A reaction of the example's own asserts the same fact for the other chart.
    const product = UI + 'ex-dashboard-product-card'
    h.click(h.button('Present'))
    await h.settle()
    expect(h.fact(product)).toEqual(['true'])
    expect(h.fullscreen.element).toBe(h.shell.nodeOf(product + '/~root'))
    h.fullscreen.leave()
    h.shell.flush()
    expect(h.fact(product)).toEqual([])
  })

  it('a fact for a component that is not shown is retracted: nothing is full screen', async () => {
    const h = site()
    const f = h.store.factory
    const hidden = UI + 'ex-dashboard-region-card'
    h.runtime.apply({ remove: [], add: [f.quad(f.namedNode(hidden), f.namedNode(FS.fullscreen), f.literal('true', f.namedNode(NS.xsd + 'boolean')))] })
    await h.settle()
    expect(h.fullscreen.requests).toEqual([])
    expect(h.fact(hidden)).toEqual([])
  })

  it('SPARQL and function rules render the same, at every step', async () => {
    const [s, fn] = [site('oxigraph', 'sparql'), site('oxigraph', 'function')]
    const html = (h: ReturnType<typeof site>) => (h.shell.nodeOf(WALK + '/~root') as Element).outerHTML
    expect(html(fn)).toBe(html(s))
    for (const h of [s, fn]) h.click(diagramToggle(h))
    expect(html(fn)).toBe(html(s))
    for (const h of [s, fn]) await h.settle()
    expect(html(fn)).toBe(html(s))
    for (const h of [s, fn]) (h.fullscreen.leave(), h.shell.flush())
    expect(html(fn)).toBe(html(s))
  })
})
