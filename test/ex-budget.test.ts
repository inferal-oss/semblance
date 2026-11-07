// The budget sheet example (demo/gallery/_ex-budget.ttl), driven through events on the site.
import { describe, expect, it } from 'vitest'
import { mountSite } from './harness.ts'

const BUD = 'https://semblance.dev/demo/budget#'

function budget(prefer: 'sparql' | 'function' = 'sparql', kind: 'oxigraph' | 'wat' = 'oxigraph') {
  const h = mountSite(kind, prefer)
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => h.fire(el, 'click')
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  click(button('Examples'))
  click(navItem('Budget sheet'))
  const root = () => h.shell.nodeOf('https://semblance.dev/demo#ex-budget/~root') as Element
  const stat = (label: string) => {
    const s = [...root().querySelectorAll('[data-sem-c=stat]')].find((x) => x.querySelector('.sem-label')!.textContent === label)!
    return { value: s.querySelector('.sem-value')!.textContent, tone: s.getAttribute('data-sem-tone') }
  }
  const field = (label: string) => {
    const f = [...root().querySelectorAll('[data-sem-c=text-field]')].find((x) => x.querySelector('label')!.textContent === label)!
    return { input: f.querySelector('input')!, error: () => f.querySelector('[role=alert]')?.textContent }
  }
  const type = (label: string, text: string) => {
    const input = field(label).input
    input.value = text
    h.fire(input, 'input')
    h.shell.flush()
  }
  const amount = (entry: string) => h.store.match(h.store.factory.namedNode(BUD + entry), h.store.factory.namedNode(BUD + 'amount'), null)[0]!.object.value
  const tableRows = () => [...root().querySelectorAll('[data-sem-c=table] tbody tr')].map((tr) => [...tr.querySelectorAll('td, th')].map((td) => td.textContent))
  const bars = () => [...root().querySelectorAll('[data-sem-c=bar-chart] .sem-bar')].map((b) => [b.querySelector('.sem-category')!.textContent, b.querySelector('.sem-total')!.textContent])
  return { ...h, root, stat, field, type, amount, tableRows, bars }
}

describe('the budget sheet example', () => {
  it('derives the totals, the balance and the savings rate by queries', () => {
    const { stat } = budget()
    expect(stat('Income').value).toBe('4,850')
    expect(stat('Expenses').value).toBe('2,496')
    expect(stat('Balance')).toEqual({ value: '2,354', tone: 'success' })
    expect(stat('Savings rate').value).toBe('48.5')
  })

  it('shows the category totals in a table and the spending in a chart', () => {
    const { tableRows, bars } = budget()
    expect(tableRows().map((r) => r[0])).toEqual(['Salary', 'Side work', 'Housing', 'Food', 'Transport', 'Utilities', 'Leisure'])
    expect(tableRows()[3]).toEqual(['Food', 'Expense', '2', '700.00'])
    expect(bars().map(([c]) => c)).toEqual(['Housing', 'Food', 'Transport', 'Utilities', 'Leisure'])
    expect(bars()[1]).toEqual(['Food', '700 €'])
  })

  it('follows an edited amount: totals, table and chart', () => {
    const { type, stat, amount, tableRows, bars } = budget()
    type('Groceries', '610.5')
    expect(amount('groceries')).toBe('610.5')
    expect(stat('Expenses').value).toBe('2,586.5')
    expect(stat('Balance').value).toBe('2,263.5')
    expect(tableRows()[3]).toEqual(['Food', 'Expense', '2', '790.50'])
    expect(bars()[1]).toEqual(['Food', '791 €'])
  })

  it('turns the balance red when expenses pass the income', () => {
    const { type, stat } = budget()
    type('Illustration commission', '0')
    type('Rent', '4000')
    expect(stat('Balance')).toEqual({ value: '-846', tone: 'danger' })
    expect(stat('Savings rate').tone).toBe('danger')
    type('Rent', '1450')
    expect(stat('Balance').tone).toBe('success')
  })

  it('keeps the last good amount while the text is not a number, and says why', () => {
    const { type, field, amount, stat } = budget()
    type('Rent', '12x')
    expect(amount('rent')).toBe('1450')
    expect(field('Rent').error()).toBe('An amount of zero or more, like 86 or 120.50.')
    expect(stat('Expenses').value).toBe('2,496')
  })

  // What the sheet does with each text: the amount it becomes, or the field says what is wrong.
  const MESSAGE = 'An amount of zero or more, like 86 or 120.50.'
  for (const [kind, prefer] of [['oxigraph', 'sparql'], ['oxigraph', 'function'], ['wat', 'sparql']] as const) {
    it(`a text that is not an amount is reported by the field, and the figures keep the old amount (${kind}, ${prefer})`, () => {
      const { type, field, amount, stat, store } = budget(prefer, kind)
      const f = store.factory
      const invalid = () => store.match(f.namedNode('https://semblance.dev/demo#ex-budget-f-salary'), f.namedNode('https://semblance.dev/ns/validation#invalid'), null).length
      for (const text of ['', '   ', '1e3', '-5', '0x10', '.']) {
        type('Salary', text)
        expect(field('Salary').error(), text).toBe(MESSAGE)
        expect(field('Salary').input.getAttribute('aria-invalid'), text).toBe('true')
        expect(invalid(), text).toBe(1)
        expect(Number(amount('salary')), text).toBe(4200)
        expect(stat('Income').value, text).toBe('4,850')
        expect(stat('Balance').value, text).toBe('2,354')
      }
      // Good text again: the message goes and the figures follow.
      type('Salary', '4000')
      expect(field('Salary').error()).toBeUndefined()
      expect(field('Salary').input.getAttribute('aria-invalid')).not.toBe('true')
      expect(invalid()).toBe(0)
      expect(stat('Income').value).toBe('4,650')
    })

    it(`every spelling of a decimal is an amount, and the figures follow (${kind}, ${prefer})`, () => {
      const { type, field, stat, amount } = budget(prefer, kind)
      for (const [text, income] of [['.5', '650.5'], ['5.', '655'], [' 7 ', '657'], ['0', '650']] as const) {
        type('Salary', text)
        expect(field('Salary').error(), text).toBeUndefined()
        expect(Number(amount('salary')), text).toBe(Number(text))
        expect(stat('Income').value, text).toBe(income)
      }
    })
  }

  it('renders the same with function rules preferred', () => {
    const a = budget('sparql')
    const b = budget('function')
    for (const text of ['1500', '', '1e3', '-5', '.5', '5.']) {
      for (const h of [a, b]) h.type('Rent', text)
      expect(b.root().innerHTML).toBe(a.root().innerHTML)
    }
  })
})
