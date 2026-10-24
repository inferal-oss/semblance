// The localized product page example (demo/gallery/_ex-localized.ttl), driven through events.
import { describe, expect, it } from 'vitest'
import { L10N, NS } from '../src/ns.ts'
import { mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

function product(prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountSite('oxigraph', prefer)
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), sync())
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  // What the host does after every change (demo/main.ts syncSettings): the viewer's language
  // becomes the projection's, and a right-to-left one flips the document.
  const sync = () => {
    const f = h.store.factory
    const language = h.store.match(f.namedNode(UI + 'app'), f.namedNode(L10N.language), null)[0]?.object
    const code = language && h.store.match(language as never, f.namedNode(L10N.code), null)[0]?.object.value
    if (code && h.screen.engine.languages[0] !== code) h.screen.engine.reconfigure({ languages: [code] })
    const rtl = !!language && h.store.match(language as never, f.namedNode(L10N.direction), f.namedNode(L10N.RTL)).length > 0
    h.document.documentElement.setAttribute('lang', code ?? 'en')
    h.document.documentElement.setAttribute('dir', rtl ? 'rtl' : 'ltr')
    h.shell.flush()
  }
  click(button('Examples'))
  click(navItem('Localized product page'))
  const root = () => h.shell.nodeOf(UI + 'ex-localized/~root') as Element
  const language = (symbol: string) => click([...root().querySelectorAll('[data-sem-c=segmented] button')].find((b) => b.textContent!.startsWith(symbol))!)
  const price = () => root().querySelector('[data-sem-c=money]')!
  const card = () => root().querySelector('[data-sem-c=card]')!
  const specs = () => [...root().querySelectorAll('[data-sem-c=description-list] dd')].map((d) => d.textContent!.replace(/\s/g, ' '))
  const cart = () => root().querySelector('[data-sem-c=stat] .sem-value')!.textContent
  return { ...h, click, sync, root, language, price, card, specs, cart }
}

const spaces = (s: string | null) => s!.replace(/[  ]/g, ' ')

describe('the localized product page example', () => {
  it('shows the product in English, the price as English writes it', () => {
    const h = product()
    expect(h.card().textContent).toContain('Halden espresso machine')
    expect(h.price().textContent).toBe('€1,249.00')
    expect(h.price().getAttribute('value')).toBe('1249')
    expect(h.specs()).toEqual(['15 bar', '1.8 L', '7.4 kg', '2 years'])
  })

  it('switches the whole page with its own language control, price and numbers included', () => {
    const h = product()
    h.language('DE')
    expect(h.card().textContent).toContain('Espressomaschine Halden')
    expect(h.card().textContent).toContain('Auf Lager')
    expect(h.root().textContent).toContain('In den Warenkorb')
    expect(spaces(h.price().textContent)).toBe('1.249,00 €')
    expect(h.specs()).toEqual(['15 bar', '1,8 l', '7,4 kg', '2 Jahre'])
    h.language('UK')
    expect(h.card().textContent).toContain('Еспресо-машина Halden')
    expect(spaces(h.price().textContent)).toBe('1 249,00 €')
    expect(h.document.documentElement.getAttribute('dir')).toBe('ltr')
    // The site's own navigation followed: the setting is the app's.
    const f = h.store.factory
    expect(h.store.match(f.namedNode(UI + 'app'), f.namedNode(L10N.language), null)[0]!.object.value).toBe(NS.l10n + 'Ukrainian')
  })

  it('lays Arabic out right to left, with the price as Arabic writes it', () => {
    const h = product()
    h.language('AR')
    expect(h.document.documentElement.getAttribute('dir')).toBe('rtl')
    expect(h.document.documentElement.getAttribute('lang')).toBe('ar')
    expect(h.card().textContent).toContain('آلة إسبريسو هالدن')
    expect(h.price().textContent).toBe(new Intl.NumberFormat('ar', { style: 'currency', currency: 'EUR', currencyDisplay: 'narrowSymbol' }).format(1249))
    expect(h.price().textContent).toContain('€')
    h.language('EN')
    expect(h.document.documentElement.getAttribute('dir')).toBe('ltr')
    expect(h.price().textContent).toBe('€1,249.00')
  })

  it('adds to the cart and announces it in the viewer’s language', () => {
    const h = product()
    h.language('UK')
    const add = [...h.root().querySelectorAll('button')].find((b) => b.textContent === 'Додати в кошик')!
    h.click(add)
    h.click(add)
    expect(h.cart()).toBe('2')
    expect([...h.document.querySelectorAll('[data-sem-c=toast]')].map((t) => t.textContent).join(' ')).toContain('Додано в кошик')
  })

  it('renders the same with function rules preferred, in every language', () => {
    const a = product('sparql')
    const b = product('function')
    for (const symbol of ['EN', 'DE', 'AR']) {
      a.language(symbol)
      b.language(symbol)
      expect(b.price().outerHTML).toBe(a.price().outerHTML)
      // (A card's badge is read through its SPARQL rule in the source language, as phrases are.)
      expect(b.root().querySelector('[data-sem-c=text]')!.textContent).toBe(a.root().querySelector('[data-sem-c=text]')!.textContent)
      expect(b.specs()).toEqual(a.specs())
    }
  })
})
