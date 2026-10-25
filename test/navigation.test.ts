import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { pageWindow } from '../src/components/navigation.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { A11Y, MOD, NAV_GRAPH, NS, SEM, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

/**
 * One gallery page (demo/gallery/<file>.ttl) over the framework ontology, projected on its
 * own into a DOM with the shell's layers and driven only through DOM events.
 */
function galleryPage(file: string, root: string, kind: StoreKind = 'oxigraph', prefer?: 'sparql' | 'function') {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const store = loadStore(kind, readFileSync(new URL(`../demo/gallery/${file}.ttl`, import.meta.url), 'utf8'))
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer, SEM.SourceLayer, SEM.TooltipLayer], provenance: true, name: 'screen', roots: [UI + root] }, (e) => {
    throw e
  })
  const dom = new DomRenderer(screen.index, document.getElementById('app')!, UI + root)
  dom.flush()
  const bus = new EventBus(runtime, screen, { prefer })
  bus.attach(dom, () => dom.flush())
  const f = store.factory
  const byId = (id: string) => [...document.querySelectorAll('*')].find((e) => dom.keyOf(e) === `${UI}${id}/~root`) as HTMLElement
  const click = (el: Element) => el.dispatchEvent(new window.Event('click', { bubbles: true }))
  const objects = (s: string, p: string) => store.match(f.namedNode(s), f.namedNode(p), null).map((q) => q.object.value)
  return { document, store, runtime, screen, dom, bus, root: byId, click, objects }
}

const gallery = (kind: StoreKind = 'oxigraph', prefer?: 'sparql' | 'function') => galleryPage('navigation', 'gallery-navigation', kind, prefer)

const sketch = (ttl: string, focus: string) => {
  const store = loadStore('oxigraph', `@prefix c: <${NS.c}> . @prefix rdfs: <${NS.rdfs}> . @prefix ex: <https://example.org/> .\n${ttl}`)
  return toText(new Runtime(store).project({ modality: MOD.Text, name: 'text' }).index, 'https://example.org/' + focus)
}

describe('c:NavLink', () => {
  it('is a c:Link: logo, current page and a spoken count, the same from SPARQL and the function', () => {
    const html: string[] = []
    for (const prefer of ['sparql', 'function'] as const) {
      const { root } = gallery('oxigraph', prefer)
      const home = root('nv-link-home')
      expect(home.localName).toBe('a')
      expect(home.getAttribute('data-sem-c')).toBe('nav-link')
      expect(home.getAttribute('href')).toBe('#home')
      expect(home.getAttribute('aria-current')).toBeNull()
      expect(home.querySelector('[data-sem-c=emblem]')).not.toBeNull()
      // Current only once the address says so (the next test); nothing reports one here.
      expect(root('nv-link-navigation').getAttribute('aria-current')).toBeNull()
      const components = root('nv-link-components')
      // The figure is hidden from assistive technology; the number and what it counts are said.
      expect(components.querySelector('.sem-count > [aria-hidden=true]')?.textContent).toBe('3')
      expect(components.querySelector('.sem-count > .sem-visually-hidden')?.textContent).toBe(', 3 new')
      expect(components.textContent).toBe('Components3, 3 new')
      expect(root('nv-link-home').querySelector('.sem-count')).toBeNull()
      html.push(root('nv-links-list').outerHTML)
    }
    expect(html[1]).toBe(html[0])
  })

  it('says the count in the viewer\'s language', () => {
    for (const prefer of ['sparql', 'function'] as const) {
      const { root, screen, dom } = gallery('oxigraph', prefer)
      screen.engine.reconfigure({ languages: ['uk'] })
      dom.flush()
      const components = root('nv-link-components')
      expect(components.querySelector('.sem-visually-hidden')?.textContent).toBe(', 3 нові')
    }
  })

  it('is the current page while the address is its own, unless it says otherwise', () => {
    const root = 'https://example.org/list'
    for (const prefer of ['sparql', 'function'] as const) {
      const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
      const store = loadStore('oxigraph', `@prefix c: <${NS.c}> . @prefix nav: <${NS.nav}> . @prefix ex: <https://example.org/> .
        ex:loc a nav:Location .
        ex:a a c:NavLink ; c:href "#a" ; c:label "A" .
        ex:b a c:Link ; c:href "#b" ; c:label "B" .
        ex:never a c:Link ; c:href "#b" ; c:label "Not this one" ; c:currentPage false .
        <${root}> a c:Stack ; c:children ( ex:a ex:b ex:never ) .`)
      const runtime = new Runtime(store)
      const screen = runtime.project({ modality: MOD.Screen, prefer, roots: [root], name: 'links' })
      const dom = new DomRenderer(screen.index, document.getElementById('app')!, root)
      const f = store.factory
      const address = (a: string) => f.quad(f.namedNode('https://example.org/loc'), f.namedNode(NS.nav + 'address'), f.literal(a))
      const current = () => {
        dom.flush()
        return [...document.querySelectorAll('a[aria-current=page]')].map((a) => a.textContent)
      }
      expect(current()).toEqual([])
      // The effect reports the query too; links spell only the fragment.
      runtime.write(NAV_GRAPH, { add: [address('?q=1#b')], remove: [] })
      expect(current(), prefer).toEqual(['B'])
      runtime.write(NAV_GRAPH, { add: [address('#a')], remove: [address('?q=1#b')] })
      expect(current(), prefer).toEqual(['A'])
    }
  })

  it('shows 99+ past 99 and nothing for zero, on any c:Link', () => {
    const root = 'https://example.org/list'
    for (const prefer of ['sparql', 'function'] as const) {
      const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
      const store = loadStore('oxigraph', `@prefix c: <${NS.c}> . @prefix ex: <https://example.org/> .
        ex:many a c:Link ; c:href "/a" ; c:label "A" ; c:count 120 ; c:currentPage true .
        ex:none a c:Link ; c:href "/b" ; c:label "B" ; c:count 0 .
        <${root}> a c:Stack ; c:children ( ex:many ex:none ) .`)
      const screen = new Runtime(store).project({ modality: MOD.Screen, prefer, roots: [root], name: 'links' })
      new DomRenderer(screen.index, document.getElementById('app')!, root).flush()
      const [many, none] = [...document.querySelectorAll('a')]
      expect(many.getAttribute('aria-current')).toBe('page')
      expect(many.querySelector('[aria-hidden=true]')?.textContent).toBe('99+')
      expect(many.querySelector('.sem-visually-hidden')?.textContent).toBe(', 120')
      expect(none.querySelector('.sem-count')).toBeNull()
    }
  })

  it('shares one count pill with the nav list (a style rule for several classes)', () => {
    const css = compileStyles(loadStore('n3'))
    const pills = css.split('\n').filter((line) => line.includes('.sem-count > [aria-hidden]') && line.includes('{'))
    const shared = pills.filter((line) => line.includes('[data-sem-c="nav-list"] .sem-count') && line.includes('[data-sem-c="nav-link"] .sem-count'))
    expect(shared).toHaveLength(1)
    expect(shared[0]).toContain('[data-sem-c="link"] .sem-count')
    expect(shared[0]).toContain('[data-sem-c="segmented"] .sem-count')
  })

  it('sketches the link and count as text', () => {
    expect(sketch('ex:n a c:NavLink ; c:href "/inbox" ; c:label "Inbox" ; c:count 3 .', 'n')).toBe('Inbox (3) </inbox>')
  })
})

describe('c:Breadcrumbs', () => {
  it('renders a labelled nav with an ordered trail, the last crumb current', () => {
    const { root } = gallery()
    const nav = root('nv-crumbs-explicit')
    expect(nav.localName).toBe('nav')
    expect(nav.getAttribute('aria-label')).toBe('Breadcrumb')
    const items = [...nav.querySelectorAll('ol > li')]
    expect(items.map((li) => li.querySelector('.sem-crumb, .sem-current')!.textContent)).toEqual(['Semblance', 'Components', 'Navigation', 'Breadcrumbs'])
    expect(items[3]!.querySelector('[aria-current=page]')!.textContent).toBe('Breadcrumbs')
    expect(nav.querySelectorAll('[aria-current]')).toHaveLength(1)
    expect(items[0]!.querySelector('.sem-sep')!.getAttribute('aria-hidden')).toBe('true')
    expect(items[3]!.querySelector('.sem-sep')).toBeNull()
    expect([...nav.querySelectorAll('a.sem-crumb')].map((link) => link.getAttribute('href'))).toEqual([
      '#home', '#components', '#components/navigation',
    ])
    // without c:controls the crumbs are links, not graph-selection buttons
    expect(nav.querySelector('button')).toBeNull()
  })

  it('renders linked crumbs from the N3 store while leaving the current item a span', () => {
    const root = 'https://example.org/trail'
    const store = loadStore('n3', `@prefix c: <${NS.c}> . @prefix nav: <${NS.nav}> . @prefix ex: <https://example.org/> .
      ex:home c:label "Home" ; c:href "/" .
      ex:docs c:label "Docs" ; c:href "/old-docs/" ; nav:href "/docs/" .
      ex:current c:label "Guide" .
      <${root}> a c:Breadcrumbs ; c:items ( ex:home ex:docs ex:current ) .`)
    const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    const screen = new Runtime(store).project({ modality: MOD.Screen, prefer: 'function', roots: [root], name: 'breadcrumbs' })
    new DomRenderer(screen.index, document.getElementById('app')!, root).flush()
    expect([...document.querySelectorAll('a.sem-crumb')].map((link) => link.getAttribute('href'))).toEqual(['/', '/docs/'])
    expect(document.querySelectorAll('button')).toHaveLength(0)
    expect(document.querySelector('[aria-current="page"]')?.textContent).toBe('Guide')
  })

  it('derives the trail by walking c:parentProperty up from c:of', () => {
    const { root } = gallery()
    const nav = root('nv-crumbs-derived')
    expect(nav.getAttribute('aria-label')).toBe('Class path')
    expect([...nav.querySelectorAll('li')].map((li) => li.firstElementChild!.textContent)).toEqual(['Component', 'Segmented', 'ThemeSwitcher'])
  })

  it('sketches the trail on one line', () => {
    expect(sketch('ex:b rdfs:subClassOf ex:a . ex:c rdfs:subClassOf ex:b . ex:t a c:Breadcrumbs ; c:of ex:c ; c:parentProperty rdfs:subClassOf .', 't')).toBe('a › b › c')
  })
})

describe('c:Pagination', () => {
  it('folds long runs into an ellipsis around the current page', () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5])
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5, 0, 20])
    expect(pageWindow(5, 20)).toEqual([1, 0, 4, 5, 6, 0, 20])
    expect(pageWindow(4, 20)).toEqual([1, 2, 3, 4, 5, 0, 20])
    expect(pageWindow(18, 20)).toEqual([1, 0, 16, 17, 18, 19, 20])
    expect(pageWindow(5, 8)).toEqual([1, 0, 4, 5, 6, 7, 8])
  })

  it('renders previous, numbered and next buttons in a labelled nav', () => {
    const { root } = gallery()
    const nav = root('nv-pages-long')
    expect(nav.localName).toBe('nav')
    expect(nav.getAttribute('aria-label')).toBe('Results pages')
    const buttons = [...nav.querySelectorAll('button')]
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Previous page', 'Page 1', 'Page 4', 'Page 5', 'Page 6', 'Page 20', 'Next page'])
    expect(nav.querySelector('[aria-current=page]')!.textContent).toBe('5')
    expect([...nav.querySelectorAll('.sem-gap')].map((g) => g.getAttribute('aria-hidden'))).toEqual(['true', 'true'])
    expect(root('nv-pages-short').getAttribute('data-sem-size')).toBe('sm')
  })

  it('writes c:page when a page, previous or next is clicked, and disables the ends', () => {
    for (const prefer of ['sparql', 'function'] as const) {
      const { root, click, objects } = gallery('oxigraph', prefer)
      const nav = () => root('nv-pages-long')
      const button = (label: string) => nav().querySelector(`[aria-label="${label}"]`) as HTMLButtonElement
      const page = () => objects(UI + 'nv-pages-long', NS.c + 'page')
      click(button('Page 6'))
      expect(page()).toEqual(['6'])
      expect(nav().querySelector('[aria-current=page]')!.textContent).toBe('6')
      click(button('Next page'))
      expect(page()).toEqual(['7'])
      click(button('Page 20'))
      expect(page()).toEqual(['20'])
      expect(button('Next page').hasAttribute('disabled')).toBe(true)
      click(button('Next page'))
      expect(page()).toEqual(['20'])
      click(button('Page 1'))
      expect(button('Previous page').hasAttribute('disabled')).toBe(true)
      click(nav().querySelector('[aria-current=page]')!) // the current page is not a link
      expect(page()).toEqual(['1'])
    }
  })

  it('sketches the pages on one line', () => {
    expect(sketch('ex:p a c:Pagination ; c:page 3 ; c:pages 9 .', 'p')).toBe('‹ 1 2 [3] 4 5 … 9 ›')
  })
})

describe('c:Stepper', () => {
  it('marks steps complete, current and upcoming', () => {
    const { root } = gallery()
    const ol = root('nv-stepper-make')
    expect(ol.localName).toBe('ol')
    expect(ol.getAttribute('aria-label')).toBe('Making a component')
    const items = [...ol.querySelectorAll(':scope > li')]
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['complete', 'complete', 'current', 'upcoming', 'upcoming'])
    expect(items[2]!.querySelector('[aria-current=step]')!.textContent).toContain('Style')
    expect(ol.querySelectorAll('[aria-current]')).toHaveLength(1)
    expect(items[0]!.querySelector('.sem-marker')!.textContent).toBe('✓')
    expect(items[3]!.querySelector('.sem-marker')!.textContent).toBe('4')
    expect(items[0]!.querySelector('.sem-visually-hidden')!.textContent).toBe(' (completed)')
    expect(items[3]!.querySelector('.sem-help')!.textContent).toBe('Reactions to its events')
  })

  it('goes to a clicked step when navigable', () => {
    for (const prefer of ['sparql', 'function'] as const) {
      const { root, click, objects } = gallery('oxigraph', prefer)
      const states = () => [...root('nv-stepper-make').querySelectorAll(':scope > li')].map((li) => li.getAttribute('data-state'))
      click(root('nv-stepper-make').querySelectorAll('button')[3]!.querySelector('.sem-label')!)
      expect(objects(UI + 'nv-stepper-make', NS.c + 'current')).toEqual([UI + 'nv-step-react'])
      expect(states()).toEqual(['complete', 'complete', 'complete', 'current', 'upcoming'])
      click(root('nv-stepper-make').querySelector('button')!)
      expect(states()).toEqual(['current', 'upcoming', 'upcoming', 'upcoming', 'upcoming'])
    }
  })

  it('sketches its progress on one line', () => {
    const ttl = 'ex:a c:label "A" . ex:b c:label "B" . ex:c c:label "C" . ex:s a c:Stepper ; c:steps ( ex:a ex:b ex:c ) ; c:current ex:b .'
    expect(sketch(ttl, 's')).toBe('✓ A → ● B → ○ C')
  })
})

describe('c:NavList', () => {
  it('still picks one value of a property, from its range', () => {
    const { root, click, objects } = gallery()
    const list = root('nv-navlist-sections')
    // Each option's count (c:countProperty) follows its label when above zero, spelled out once.
    expect([...list.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Overview', 'Rules', 'Theme2, 2 open questions', 'Behaviour12, 12 open questions'])
    expect([...list.querySelectorAll('.sem-count [aria-hidden=true]')].map((c) => c.textContent)).toEqual(['2', '12'])
    click([...list.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Theme'))!)
    expect(objects(UI + 'nv-doc', UI + 'nvSection')).toEqual([UI + 'NvTheme'])
    expect(root('nv-navlist-sections').querySelector('[aria-pressed=true] > span')!.textContent).toBe('Theme')
  })
})

describe('in the demo shell', () => {
  it('shows the group on the Components page', () => {
    const { document, store, runtime, shell, showPage } = mountShell()
    const f = store.factory
    showPage('Components')
    const app = f.namedNode(UI + 'app')
    const p = f.namedNode(UI + 'galleryGroup')
    runtime.apply({ remove: store.match(app, p, null), add: [f.quad(app, p, f.namedNode(UI + 'GroupNavigation'))] })
    shell.flush()
    const kinds = new Set([...document.querySelectorAll('[data-sem-c]')].map((e) => e.getAttribute('data-sem-c')))
    for (const k of ['breadcrumbs', 'pagination', 'stepper', 'nav-list']) expect(kinds, k).toContain(k)
  })
})
