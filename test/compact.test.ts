// On a compact screen (a phone held upright): width classes in the style compiler, the app bar's
// More button, and segmented controls / nav lists presented as pickers.
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { NS } from '../src/ns.ts'
import { compileStyles } from '../src/style/compile.ts'
import { mountSite } from './harness.ts'

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

  it('show the app bar’s More button only on a compact screen', () => {
    const components = layerOf(css, 'components')
    const media = components.indexOf(COMPACT)
    expect(media).toBeGreaterThan(0)
    // Where there is room the More button is not shown; on a compact screen it is.
    const plain = components.indexOf('  [data-sem-c="app-bar"] .sem-more-toggle { display: none; }')
    const compact = components.indexOf('    [data-sem-c="app-bar"] .sem-more-toggle { ', media)
    expect(plain).toBeGreaterThan(0)
    expect(plain).toBeLessThan(media)
    expect(compact).toBeGreaterThan(media)
    expect(components.slice(compact, components.indexOf('}', compact))).toContain('display: inline-grid;')
  })

  it('narrows rules by a hooked value inside the condition too (a segmented control as a picker)', () => {
    const variants = layerOf(css, 'variants')
    const media = variants.indexOf(COMPACT)
    expect(media).toBeGreaterThan(0)
    const picker = '[data-sem-c="segmented"][data-sem-compact-as="picker"] > .sem-picker'
    expect(variants.indexOf(picker, media)).toBeGreaterThan(media)
    // A nav list is a segmented control: the rule reaches it.
    expect(variants.indexOf('[data-sem-c="nav-list"][data-sem-compact-as="picker"] > .sem-picker', media)).toBeGreaterThan(media)
    // Everywhere else the picker is not shown.
    expect(css).toContain('  [data-sem-c="segmented"] > .sem-picker, [data-sem-c="nav-list"] > .sem-picker')
    expect(css).toMatch(/\[data-sem-c="theme-switcher"\] > \.sem-picker \{ display: none; \}/)
  })
})

/** The site, driven only through events, with either rule implementation preferred. */
function site(prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountSite('oxigraph', prefer)
  const $ = (s: string) => h.document.querySelector(s)!
  const choose = (select: Element, text: string) => {
    const option = [...select.querySelectorAll('option')].find((o) => o.textContent === text)!
    Object.defineProperty(select, 'value', { value: option.getAttribute('value'), configurable: true })
    h.fire(select, 'change')
  }
  return { ...h, $, choose }
}

describe('the app bar on a compact screen', () => {
  it('puts the more actions after the others, behind a More button that says what it opens', () => {
    const { $ } = site()
    const actions = $('[data-sem-c=app-bar] > .sem-actions')
    expect([...actions.children].map((c) => c.getAttribute('data-sem-c') ?? c.className)).toEqual(['segmented', 'sem-more'])
    const toggle = actions.querySelector('.sem-more > .sem-more-toggle')!
    const body = actions.querySelector('.sem-more > .sem-more-body')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toBe(body.id)
    expect(toggle.getAttribute('aria-label')).toBe('Tools and display')
    expect(toggle.querySelector('[aria-hidden=true]')!.textContent).toBe('⋯')
    expect([...body.children].map((c) => c.getAttribute('data-sem-c'))).toEqual(['toggle', 'theme-switcher', 'choice'])
  })

  it('opens and closes them through the graph (c:expanded)', () => {
    const { $, fire, store } = site()
    const f = store.factory
    const expanded = () => store.match(f.namedNode(UI + 'appBar'), f.namedNode(NS.c + 'expanded'), null)[0]?.object.value
    fire($('.sem-more-toggle'), 'click')
    expect(expanded()).toBe('true')
    expect($('.sem-more-toggle').getAttribute('aria-expanded')).toBe('true')
    expect($('.sem-more').getAttribute('data-open')).toBe('true')
    fire($('.sem-more-toggle'), 'click')
    expect(expanded()).toBe('false')
    expect($('.sem-more').getAttribute('data-open')).toBe('false')
  })

  it('closes them on Escape, giving the focus back to the More button, and on a press outside', () => {
    const { $, fire, document, window, store } = site()
    const f = store.factory
    const expanded = () => store.match(f.namedNode(UI + 'appBar'), f.namedNode(NS.c + 'expanded'), null)[0]?.object.value
    expect($('.sem-more-toggle').hasAttribute('data-sem-escape')).toBe(false)
    fire($('.sem-more-toggle'), 'click')
    // Open, the toggle declares what closes it; the event bus clicks it, so its reaction does.
    expect($('.sem-more-toggle').hasAttribute('data-sem-escape')).toBe(true)
    expect($('.sem-more-toggle').hasAttribute('data-sem-dismiss-outside')).toBe(true)
    let focused: Element | undefined
    const toggle = $('.sem-more-toggle') as HTMLElement
    toggle.focus = () => void (focused = toggle)
    const esc = new window.Event('keydown', { bubbles: true })
    Object.defineProperty(esc, 'key', { value: 'Escape' })
    document.dispatchEvent(esc)
    expect(expanded()).toBe('false')
    expect(focused).toBe(toggle)
    // A press inside the panel leaves it open; one anywhere else closes it.
    fire($('.sem-more-toggle'), 'click')
    fire($('.sem-more-body [data-sem-c=theme-switcher] button'), 'pointerdown')
    expect(expanded()).toBe('true')
    fire($('main, [data-sem-c=switch]'), 'pointerdown')
    expect(expanded()).toBe('false')
    expect($('.sem-more-toggle').hasAttribute('data-sem-dismiss-outside')).toBe(false)
  })

  it('renders the same through its SPARQL and function rules, folded and open', () => {
    const a = site('sparql')
    const b = site('function')
    expect(a.$('[data-sem-c=app-bar]').outerHTML).toBe(b.$('[data-sem-c=app-bar]').outerHTML)
    a.fire(a.$('.sem-more-toggle'), 'click')
    b.fire(b.$('.sem-more-toggle'), 'click')
    expect(a.$('[data-sem-c=app-bar]').outerHTML).toBe(b.$('[data-sem-c=app-bar]').outerHTML)
  })
})

describe('pickers (c:compactAs c:Picker)', () => {
  it('give the page switcher a select of the pages, before its buttons, that changes the page', () => {
    const { $, choose, value } = site()
    const nav = $('[data-sem-c=app-bar] [data-sem-c=segmented]')
    expect(nav.getAttribute('data-sem-compact-as')).toBe('picker')
    const picker = nav.firstElementChild!
    expect(picker.localName).toBe('select')
    expect(picker.getAttribute('aria-label')).toBe('Page')
    expect([...picker.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Home', 'Docs', 'Components', 'Reference', 'Examples'])
    expect(picker.querySelector('option[selected]')!.textContent).toBe('Home')
    choose(picker, 'Docs')
    expect(value(UI + 'page')).toBe(UI + 'Docs')
    expect($('[data-sem-c=app-bar] [data-sem-c=segmented] > select option[selected]').textContent).toBe('Docs')
  })

  it('give a nav list one too: the docs sections, the current one selected', () => {
    const { $, choose, value, showPage, document } = site()
    showPage('Docs')
    const list = [...document.querySelectorAll('[data-sem-c=nav-list]')].find((l) => !l.closest('[hidden]'))!
    const picker = list.querySelector(':scope > select.sem-picker')!
    expect(picker.getAttribute('aria-label')).toBe('Docs')
    expect(picker.querySelectorAll('option')).toHaveLength(list.querySelectorAll(':scope > button').length)
    expect(picker.querySelector('option[selected]')!.textContent).toBe(list.querySelector('button[aria-pressed=true]')!.textContent)
    choose(picker, 'Layers')
    expect(value(UI + 'docSection')).toBe(UI + 'DocLayers')
    expect(list.querySelector('button[aria-pressed=true]')!.textContent).toBe('Layers')
    expect($('[data-sem-c=app-bar] [data-sem-c=segmented]')).toBeDefined()
  })

  it('render the same through their SPARQL and function rules', () => {
    const a = site('sparql')
    const b = site('function')
    for (const h of [a, b]) h.showPage('Docs')
    const lists = (h: ReturnType<typeof site>) => [...h.document.querySelectorAll('[data-sem-c=nav-list]')].map((l) => l.outerHTML)
    expect(lists(a)).toEqual(lists(b))
    for (const h of [a, b]) h.showPage('Components')
    expect(lists(a)).toEqual(lists(b))
  })

  it('are left out where not asked for', () => {
    const { document, showPage } = site()
    showPage('Components')
    const themeSwitcher = document.querySelector('[data-sem-c=theme-switcher]')!
    expect(themeSwitcher.querySelector('select')).toBeNull()
    expect(themeSwitcher.hasAttribute('data-sem-compact-as')).toBe(false)
  })
})
