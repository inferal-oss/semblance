import { describe, expect, it } from 'vitest'
import { mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const CO = 'https://semblance.dev/demo/checkout#'

/** The Checkout example, reached as a visitor reaches it: Examples, then Checkout. */
function checkout(prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountSite('oxigraph', prefer)
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
  const step = () => card().querySelector('[aria-current=step]')!.textContent
  const text = (iri: string) => h.shell.nodeOf(`${UI}${iri}/~root`)?.textContent
  const hint = () => [...card().querySelectorAll('[data-sem-c=text]')].find((t) => visible(t) && /shipping|empty/.test(t.textContent!))?.textContent
  return { ...h, visible, button, click, card, figures, field, type, step, text, hint }
}

describe('the checkout example', () => {
  it('derives every figure from the lines, and makes standard shipping free over $60', () => {
    const h = checkout()
    expect(h.figures()).toEqual({ Items: '3 items', Subtotal: '$56.00', Shipping: '$4.90', 'Tax (8%)': '$4.48', Total: '$65.38' })
    expect(h.hint()).toBe('Add $4.00 more for free standard shipping.')
    // Below it, how it works, naming the rule.
    const how = h.shell.nodeOf(`${UI}ex-checkout-how/~root`) as Element
    expect(h.visible(how) && how.textContent).toContain('How it works')
    expect(how.querySelector('[data-sem-c=mention]')).toBeTruthy()
    expect(how.textContent).toContain('co:Pricing')
    // − is disabled at one; one more mug crosses the threshold.
    expect(h.button('Remove one Stoneware mug').disabled).toBe(true)
    h.click(h.button('Add one Stoneware mug'))
    expect(h.figures()).toEqual({ Items: '4 items', Subtotal: '$68.50', Shipping: 'Free', 'Tax (8%)': '$5.48', Total: '$73.98' })
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
    h.type('Postal code', '9')
    expect(next().disabled).toBe(true)
    expect(h.field('Postal code').getAttribute('aria-invalid')).toBe('true')
    expect(h.card().textContent).toContain('Enter a postal code, like 94110 or SW1A 1AA.')
    h.click(next())
    expect(h.step()).toContain('Shipping') // the reaction checks too
    h.type('Postal code', '94110')
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
      City: 'San Francisco 94110',
      Country: 'United States',
      Delivery: 'Express',
      Payment: 'Pay on delivery',
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
