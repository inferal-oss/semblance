import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

/** The site as a visitor first sees it, driven only through events. */
function site() {
  const h = mountSite()
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const click = (el: Element) => h.fire(el, 'click')
  return { ...h, visible, button, navItem, click }
}

describe('the site', () => {
  it('opens on the landing page, with the tools closed', () => {
    const { value, document, visible } = site()
    expect(value(UI + 'page')).toBe(UI + 'Home')
    expect(document.body.textContent).toContain('The UI is data.')
    expect(document.body.textContent).toContain('RDF-native')
    expect(document.body.textContent).toContain('The interface is a graph.')
    // The todo, live beside its data and its text, then why that matters.
    const live = document.querySelector('[data-sem-c=live-example][data-sem-sources=hidden]')!
    expect(visible(live)).toBe(true)
    expect([...live.querySelectorAll('.sem-live-modality')].map((p) => p.textContent)).toEqual(['On screen', 'Its data, as Turtle', 'As text'])
    expect([...document.querySelectorAll('[data-sem-c=heading]')].filter(visible).map((h) => h.textContent)).toContain('Why it matters')
    expect([...document.querySelectorAll('[data-sem-c=card]')].filter(visible).length).toBeGreaterThanOrEqual(6)
    const tools = document.querySelector('[data-sem-c=app-bar] [data-sem-c=toggle]')!
    expect(tools.getAttribute('aria-pressed')).toBe('false')
    expect(tools.getAttribute('aria-keyshortcuts')).toBe('Control+.')
  })

  it('goes where its buttons say, through the graph', () => {
    const { value, button, click } = site()
    click(button('Read the docs'))
    expect(value(UI + 'page')).toBe(UI + 'Docs')
    click(button('Home'))
    click(button('See examples'))
    expect(value(UI + 'page')).toBe(UI + 'Examples')
  })

  it('opens the tools on any page, as a window docked to the bottom', () => {
    const { document, button, click, store } = site()
    click(button('Docs'))
    click(document.querySelector('[data-sem-c=app-bar] [data-sem-c=toggle]')!)
    const f = store.factory
    expect(store.match(f.namedNode(UI + 'tools'), f.namedNode(NS.c + 'open'), null)[0]!.object.value).toBe('true')
    const tools = [...document.querySelectorAll('[data-sem-c=window]')].find((w) => w.querySelector('.sem-window-bar strong')!.textContent === 'Tools')!
    expect(tools.getAttribute('data-sem-edge')).toBe('bottom')
    expect([...tools.querySelectorAll('[role=tab]')].map((t) => t.textContent)).toEqual(['Inspector', 'Query', 'Activity', 'Change log', 'Engine'])
  })

  it('has a docs section per topic, the performance one live', () => {
    const { document, value, button, navItem, click } = site()
    click(button('Docs'))
    expect(document.querySelector('[data-sem-c=heading]:not([hidden] *)')!.textContent).toBe('Overview')
    click(navItem('Performance'))
    expect(value(UI + 'docSection')).toBe(UI + 'DocPerformance')
    expect([...document.querySelectorAll('[data-sem-c=bar-chart]')].some((c) => !c.closest('[hidden]'))).toBe(true)
  })

  it('runs the sign-in example: too short, wrong, then right', () => {
    const { document, button, navItem, click, fire, visible, store } = site()
    click(button('Examples'))
    click(navItem('Sign in with a code'))
    const code = () => [...document.querySelectorAll('[data-sem-c=code-input]')].find(visible)!
    const alert = () => code().querySelector('[role=alert]')?.textContent
    click(button('Verify'))
    expect(alert()).toBe('Enter all 6 digits.')
    const type = (text: string) => {
      const input = code().querySelector('input')!
      input.value = text
      fire(input, 'input')
    }
    type('111222')
    click(button('Verify'))
    expect(alert()).toContain("isn't right")
    type('246 810')
    click(button('Verify'))
    const f = store.factory
    expect(store.match(f.namedNode(UI + 'signinFlow'), f.namedNode(UI + 'signinStep'), null)[0]!.object.value).toBe(UI + 'SigninDone')
    expect([...document.querySelectorAll('[data-sem-c=alert]')].find(visible)!.textContent).toContain("You're signed in")
    click(button('Start over'))
    expect(code().querySelector('input')!.value).toBe('')
  })
  it.each(['sparql', 'function'] as const)('says who sponsors it, with their chevron, in the app bar on every page (%s)', (prefer) => {
    const { document } = mountSite('oxigraph', prefer)
    const link = [...document.querySelectorAll('[data-sem-c=link]')].find((a) => a.textContent!.includes('Inferal'))!
    expect(link.closest('[data-sem-c=text]')!.textContent).toBe('Sponsored by Inferal')
    expect(link.closest('[data-sem-c=app-bar] .sem-brand > .sem-byline')).not.toBeNull()
    expect(link.getAttribute('href')).toBe('https://inferal.com/')
    const chevron = link.querySelector('[data-sem-c=emblem]')!
    expect(chevron.localName).toBe('svg')
    expect(chevron.getAttribute('aria-hidden')).toBe('true') // the name follows it
    expect(chevron.querySelector('path')!.getAttribute('fill')).toBe('#0070f3')
    expect(chevron.nextSibling!.textContent).toBe('Inferal')
    expect(document.body.textContent).not.toContain('an experiment in ontologically defined interfaces')
  })

  it('picks the theme from the app bar, beside the colour scheme', () => {
    const { document, store, fire } = site()
    const picker = [...document.querySelectorAll('[data-sem-c=app-bar] [data-sem-c=choice]')].find((c) => c.querySelector('select'))!
    expect(picker).toBeDefined()
    const select = picker.querySelector('select')!
    const options = [...select.querySelectorAll('option')].map((o) => o.textContent)
    expect(options).toEqual(expect.arrayContaining(['Semblance', 'Cupertino', 'Classic', 'Fluent']))
    const fluent = [...select.querySelectorAll('option')].find((o) => o.textContent === 'Fluent')!
    Object.defineProperty(select, 'value', { value: fluent.getAttribute('value'), configurable: true })
    fire(select, 'change')
    const f = store.factory
    expect(store.match(f.namedNode('https://semblance.dev/demo#shell'), f.namedNode(NS.sty + 'theme'), null)[0]!.object.value).toBe(NS.sty + 'Fluent')
    expect(document.querySelector('[data-sem-c=stack][data-sem-theme]')!.getAttribute('data-sem-theme')).toBe('fluent')
  })
})
