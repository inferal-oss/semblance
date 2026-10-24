import { describe, expect, it } from 'vitest'
import { mountSite } from './harness.ts'
import type { StoreKind } from '../src/node/load.ts'

const UI = 'https://semblance.dev/demo#'
const CO = 'https://semblance.dev/demo/checkout#'

/** The Checkout example, reached as a visitor reaches it: Examples, then Checkout. */
function checkout(prefer: 'sparql' | 'function' = 'sparql', kind: StoreKind = 'oxigraph') {
  const h = mountSite(kind, prefer)
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const button = (text: string) =>
    [...h.document.querySelectorAll('button')].find((b) => (b.textContent!.trim() === text || b.getAttribute('aria-label') === text) && visible(b)) as HTMLButtonElement
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const click = (el: Element) => h.fire(el, 'click')
  click(button('Examples'))
  click(navItem('Checkout'))
  const card = () => h.document.querySelector('[data-sem-c=stepper]')!.closest('[data-sem-c=card]')!
  /** The visible description lists as term -> value pairs, merged. */
  const figures = () =>
    Object.fromEntries(
      [...card().querySelectorAll('.sem-pair')].filter(visible).map((p) => [p.querySelector('dt')!.textContent, p.querySelector('dd')!.textContent]),
    )
  const field = (label: string) => {
    const l = [...card().querySelectorAll('label')].find((x) => x.textContent === label && visible(x))!
    return h.document.getElementById(l.getAttribute('for')!) as HTMLInputElement
  }
  const type = (label: string, value: string) => {
    const input = field(label)
    input.value = value
    h.fire(input, 'input')
  }
  /** The labels of the visible text fields, in order. */
  const labels = () => [...card().querySelectorAll('[data-sem-c=text-field] label')].filter(visible).map((l) => l.textContent)
  /** A visible dropdown by its caption. */
  const dropdown = (caption: string) =>
    [...card().querySelectorAll('[data-sem-c=choice]')].find((c) => visible(c) && c.querySelector('span')?.textContent === caption) as HTMLElement | undefined
  /** A dropdown's options and the selected one, as their texts. */
  const options = (caption: string) => [...dropdown(caption)!.querySelectorAll('option')].map((o) => o.textContent)
  const selected = (caption: string) => [...dropdown(caption)!.querySelectorAll('option')].find((o) => o.hasAttribute('selected'))?.textContent
  /** Pick an option of a dropdown by its text, as a change event. */
  const choose = (caption: string, option: string) => {
    const select = dropdown(caption)!.querySelector('select')!
    const o = [...select.querySelectorAll('option')].find((x) => x.textContent === option)!
    Object.defineProperty(select, 'value', { value: o.getAttribute('value'), configurable: true })
    h.fire(select, 'change')
  }
  const step = () => card().querySelector('[aria-current=step]')!.textContent
  const text = (iri: string) => h.shell.nodeOf(`${UI}${iri}/~root`)?.textContent
  const hint = () => [...card().querySelectorAll('[data-sem-c=text]')].find((t) => visible(t) && /shipping|empty/.test(t.textContent!))?.textContent
  /** Fill in the shipping form with a US address. */
  const fillUS = () => {
    type('Full name', 'Ada Lovelace')
    type('Street address', '12 Harbour Road')
    type('City', 'San Francisco')
    type('ZIP code', '94110')
    type('Phone', '415 555 0132')
  }
  return { ...h, visible, button, click, card, figures, field, type, labels, dropdown, options, selected, choose, step, text, hint, fillUS }
}

describe('the checkout example', () => {
  it('derives every figure from the lines, and makes standard shipping free over $60', () => {
    const h = checkout()
    expect(h.figures()).toEqual({ Items: '3 items', Subtotal: '$56.00', Shipping: '$4.90', 'Sales tax (8%)': '$4.48', Total: '$65.38' })
    expect(h.hint()).toBe('Add $4.00 more for free standard shipping.')
    // Below it, how it works, naming the rule.
    const how = h.shell.nodeOf(`${UI}ex-checkout-how/~root`) as Element
    expect(h.visible(how) && how.textContent).toContain('How it works')
    expect(how.querySelector('[data-sem-c=mention]')).toBeTruthy()
    expect(how.textContent).toContain('co:Pricing')
    // − is disabled at one; one more mug crosses the threshold.
    expect(h.button('Remove one Stoneware mug').disabled).toBe(true)
    h.click(h.button('Add one Stoneware mug'))
    expect(h.figures()).toEqual({ Items: '4 items', Subtotal: '$68.50', Shipping: 'Free', 'Sales tax (8%)': '$5.48', Total: '$73.98' })
    expect(h.hint()).toBe('Standard shipping is free on this order.')
    expect(h.button('Remove one Stoneware mug').disabled).toBe(false)
    expect([h.text('co-mug-qty'), h.text('co-mug-total')]).toEqual(['2', '$25.00'])
    // The rows take their columns from the list, so their cells line up.
    const lines = h.shell.nodeOf(`${UI}co-lines/~root`) as Element
    expect(lines.getAttribute('data-sem-layout')).toBe('cart-columns')
    expect((h.shell.nodeOf(`${UI}co-mug-row/~root`) as Element).getAttribute('data-sem-layout')).toBe('subgrid')
    // Back under the threshold.
    h.click(h.button('Remove one Stoneware mug'))
    expect(h.figures().Shipping).toBe('$4.90')
  })

  it('removes a line with undo, and blocks Continue when the cart is empty', () => {
    const h = checkout()
    h.click(h.button('Remove Pour-over kettle from the cart'))
    expect(h.card().textContent).toContain('Pour-over kettle removed.')
    expect(h.figures().Subtotal).toBe('$22.00')
    h.click(h.button('Undo'))
    expect(h.figures().Subtotal).toBe('$56.00')
    for (const name of ['Pour-over kettle', 'Stoneware mug', 'Single-origin beans']) h.click(h.button(`Remove ${name} from the cart`))
    expect(h.figures()).toMatchObject({ Items: '0 items', Subtotal: '$0.00', Total: '$0.00' })
    expect(h.hint()).toBe('Your cart is empty.')
    expect(h.button('Continue to shipping').disabled).toBe(true)
    h.click(h.button('Continue to shipping')) // a stale click does nothing either
    expect(h.step()).toContain('Cart')
  })

  it('gates Continue on the shipping shapes, moves back and forth, and places the order', () => {
    const h = checkout()
    h.click(h.button('Continue to shipping'))
    expect(h.step()).toContain('Shipping')
    const next = () => h.button('Continue to review')
    expect(next().disabled).toBe(true) // pristine required fields: invalid but quiet
    expect(h.card().querySelector('[role=alert]')).toBeNull()
    h.type('Full name', 'Ada Lovelace')
    h.type('Street address', '12 Harbour Road')
    h.type('City', 'San Francisco')
    h.type('Phone', '415 555 0132')
    h.type('ZIP code', '9')
    expect(next().disabled).toBe(true)
    expect(h.field('ZIP code').getAttribute('aria-invalid')).toBe('true')
    expect(h.card().textContent).toContain('Enter a 5-digit ZIP code, like 94110.')
    h.click(next())
    expect(h.step()).toContain('Shipping') // the reaction checks too
    h.type('ZIP code', '94110')
    expect(next().disabled).toBe(false)
    // Delivery changes the shipping line; express is never free.
    const express = [...h.card().querySelectorAll('input[type=radio]')].find((r) => (r as HTMLInputElement).value === CO + 'Express') as HTMLInputElement
    express.checked = true
    h.fire(express, 'change')
    // Back to the cart keeps what was typed; forward again.
    h.click(h.button('Back to cart'))
    expect(h.step()).toContain('Cart')
    expect(h.figures().Shipping).toBe('$12.00')
    h.click(h.button('Continue to shipping'))
    expect(h.field('Full name').value).toBe('Ada Lovelace')
    h.click(next())
    expect(h.step()).toContain('Review')
    const review = h.figures()
    expect(review).toMatchObject({
      Recipient: 'Ada Lovelace',
      'Street address': '12 Harbour Road',
      City: 'San Francisco, CA 94110',
      Country: 'United States',
      Phone: '+1 415 555 0132',
      Delivery: 'Express',
      Payment: 'Pay on delivery',
      Currency: 'US dollars ($)',
      'Pour-over kettle × 1': '$34.00',
      'Stoneware mug × 1': '$12.50',
      'Single-origin beans × 1': '$9.50',
      Shipping: '$12.00',
      Total: '$72.48',
    })
    h.click(h.button('Back'))
    expect(h.step()).toContain('Shipping')
    h.click(next())
    h.click(h.button('Place order'))
    expect(h.step()).toContain('Done')
    const done = h.figures()
    expect(done['Order number']).toMatch(/^SB-[0-9A-F]{6}$/)
    expect(done['Total due']).toBe('$72.48')
    const region = h.shell.nodeOf(`${UI}announcements/~root`) as Element
    expect([...region.querySelectorAll('[data-sem-c=toast]')].map((t) => t.textContent).at(-1)).toContain('Order placed')
    // A new order starts from the cart as it was.
    h.click(h.button('Start a new order'))
    expect(h.step()).toContain('Cart')
    expect(h.figures().Subtotal).toBe('$56.00')
    const f = h.store.factory
    expect(h.store.match(f.namedNode(UI + 'ex-checkout'), f.namedNode(CO + 'orderNumber'), null)).toHaveLength(0)
  })

  it('reshapes the shipping form with the country: labels, shapes, regions, defaults, tax and currency', () => {
    const h = checkout()
    h.click(h.button('Continue to shipping'))
    const next = () => h.button('Continue to review')
    const root = (local: string) => h.shell.nodeOf(`${UI}${local}/~root`) as Element
    // The United States: a ZIP code, a state, dollars, +1, sales tax.
    expect(h.selected('Country')).toBe('United States')
    expect(h.labels()).toEqual(['Full name', 'Street address', 'City', 'ZIP code', 'Phone'])
    expect(h.field('ZIP code').getAttribute('placeholder')).toBe('94110')
    expect(h.options('State')).toEqual(['California', 'Illinois', 'Massachusetts', 'New York', 'Texas', 'Washington'])
    expect(h.selected('State')).toBe('California')
    expect([h.selected('Code'), h.selected('Pay in')]).toEqual(['+1', 'US dollars ($)'])
    expect(h.field('Phone').getAttribute('placeholder')).toBe('415 555 0132')
    expect(h.figures()).toEqual({ Items: '3 items', Subtotal: '$56.00', Shipping: '$4.90', 'Sales tax (8%)': '$4.48', Total: '$65.38' })
    expect(h.text('co-ships-from')).toBe('Ships from our San Francisco store.')
    h.fillUS()
    h.choose('State', 'New York')
    expect(next().disabled).toBe(false)

    // The United Kingdom: a postcode with its own shape, no region, pounds, +44, VAT.
    h.choose('Country', 'United Kingdom')
    expect(h.labels()).toEqual(['Full name', 'Street address', 'Town or city', 'Postcode', 'Phone'])
    expect(h.field('Postcode').getAttribute('placeholder')).toBe('SW1A 1AA')
    expect(h.dropdown('State')).toBeUndefined()
    expect(root('co-region').hasAttribute('hidden')).toBe(true)
    // What was typed stays; the country's shape judges it now.
    expect(h.field('Postcode').value).toBe('94110')
    expect(h.field('Postcode').getAttribute('aria-invalid')).toBe('true')
    expect(h.card().textContent).toContain('Enter a postcode, like SW1A 1AA.')
    expect(next().disabled).toBe(true)
    expect([h.selected('Code'), h.selected('Pay in')]).toEqual(['+44', 'Pounds sterling (£)'])
    expect(h.field('Phone').getAttribute('placeholder')).toBe('20 7946 0958')
    expect(h.figures()).toEqual({ Items: '3 items', Subtotal: '£44.25', Shipping: '£3.87', 'VAT (20%)': '£8.85', Total: '£56.97' })
    expect(h.text('co-ships-from')).toBe('Ships from San Francisco: import duties may be due on delivery.')
    const f = h.store.factory
    const order = (p: string) => h.store.match(f.namedNode(UI + 'ex-checkout'), f.namedNode(CO + p), null).map((q) => q.object.value)
    expect(order('region')).toEqual([]) // the state the United States chose is cleared
    h.type('Town or city', 'London')
    h.type('Postcode', 'SW1A 1AA')
    h.type('Phone', '20 7946 0958')
    expect(next().disabled).toBe(false)
    h.click(next())
    expect(h.step()).toContain('Review')
    expect(h.figures()).toMatchObject({
      City: 'London SW1A 1AA',
      Country: 'United Kingdom',
      Phone: '+44 20 7946 0958',
      Currency: 'Pounds sterling (£)',
      'Pour-over kettle × 1': '£26.86',
      'VAT (20%)': '£8.85',
      Total: '£56.97',
    })

    // Canada: a province, Canadian dollars, still +1, GST.
    h.click(h.button('Back'))
    h.choose('Country', 'Canada')
    expect(h.labels()).toEqual(['Full name', 'Street address', 'City', 'Postal code', 'Phone'])
    expect(h.options('Province')).toEqual(['Alberta', 'British Columbia', 'Ontario', 'Quebec'])
    expect(h.selected('Province')).toBe('Ontario')
    expect(root('co-region').hasAttribute('hidden')).toBe(false)
    expect(h.card().textContent).toContain('Enter a postal code like M5V 2T6.')
    expect([h.selected('Code'), h.selected('Pay in')]).toEqual(['+1', 'Canadian dollars (CA$)'])
    expect(h.figures()).toEqual({ Items: '3 items', Subtotal: 'CA$76.73', Shipping: 'CA$6.71', 'GST (5%)': 'CA$3.84', Total: 'CA$87.28' })

    // Germany, paying in dollars: a default is only a default.
    h.choose('Country', 'Germany')
    expect(h.labels()).toContain('Postal code (PLZ)')
    expect(h.figures()).toMatchObject({ Subtotal: '€51.52', Shipping: '€4.51', 'VAT (19%)': '€9.79', Total: '€65.82' })
    h.choose('Pay in', 'US dollars ($)')
    expect(h.figures()).toEqual({ Items: '3 items', Subtotal: '$56.00', Shipping: '$4.90', 'VAT (19%)': '$10.64', Total: '$71.54' })
    expect(h.selected('Code')).toBe('+49')
    // ...until the country changes again: the Netherlands' defaults replace it.
    h.choose('Country', 'Netherlands')
    expect([h.selected('Code'), h.selected('Pay in')]).toEqual(['+31', 'Euros (€)'])
    expect(h.figures()).toMatchObject({ Subtotal: '€51.52', 'VAT (21%)': '€10.82', Total: '€66.85' })
    h.type('Postcode', '1012 AB')
    h.type('City', 'Amsterdam')
    h.type('Phone', '20 794 6000')
    h.click(next())
    expect(h.figures()).toMatchObject({ City: '1012 AB Amsterdam', Country: 'Netherlands', Phone: '+31 20 794 6000' }) // postcode first
    // The cart shows its prices in the order's currency too.
    h.click(h.button('Back'))
    h.click(h.button('Back to cart'))
    expect(h.text('co-kettle-detail')).toBe('Stainless steel, 1 L · €31.28 each')
    expect(h.hint()).toBe('Add €3.68 more for free standard shipping.')
  })

  it('reshapes the form the same with the function twins, and on the wasm engine', () => {
    const runs = [checkout('sparql'), checkout('function'), checkout('sparql', 'wat')]
    const snapshots = runs.map((h) => {
      const shots: string[] = []
      h.click(h.button('Continue to shipping'))
      h.fillUS()
      shots.push(h.card().innerHTML)
      h.choose('Country', 'United Kingdom')
      shots.push(h.card().innerHTML)
      h.choose('Country', 'Canada')
      h.choose('Pay in', 'Euros (€)')
      shots.push(h.card().innerHTML)
      h.click(h.button('Back to cart'))
      h.click(h.button('Add one Stoneware mug'))
      shots.push(h.card().innerHTML)
      return shots
    })
    expect(snapshots[1]).toEqual(snapshots[0])
    expect(snapshots[2]).toEqual(snapshots[0])
  })

  it('prices the same with the function twin', () => {
    const a = checkout('sparql')
    const b = checkout('function')
    for (const h of [a, b]) {
      h.click(h.button('Add one Stoneware mug'))
      h.click(h.button('Add one Single-origin beans'))
      h.click(h.button('Remove Pour-over kettle from the cart'))
    }
    expect(b.figures()).toEqual(a.figures())
    expect(b.hint()).toBe(a.hint())
    expect(b.card().innerHTML).toBe(a.card().innerHTML)
  })

  it('costs the same for each quantity change, and little', () => {
    const h = checkout()
    const s = h.screen.engine.stats
    const snap = () => ({ ruleRuns: s.ruleRuns, written: s.derivedAdded + s.derivedRemoved, domOps: h.shell.ops })
    const measure = (act: () => void) => {
      const a = snap()
      act()
      const b = snap()
      return { ruleRuns: b.ruleRuns - a.ruleRuns, written: b.written - a.written, domOps: b.domOps - a.domOps }
    }
    h.click(h.button('Add one Pour-over kettle')) // warm
    const first = measure(() => h.click(h.button('Add one Pour-over kettle')))
    const second = measure(() => h.click(h.button('Add one Pour-over kettle')))
    console.log('checkout: one more kettle costs', first)
    expect(second).toEqual(first)
    expect(first.ruleRuns).toBeLessThan(40)
  })
})
