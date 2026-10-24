// The spreadsheet example (demo/gallery/_ex-sheet.ttl) and its components (c:Sheet, c:SheetCell),
// driven only through events; the host's recalculation trace (src/recalculation.ts) wired as the demo wires it.
import { describe, expect, it } from 'vitest'
import { RecalculationTrace } from '../src/recalculation.ts'
import { mountSite } from './harness.ts'
import { implementationGaps } from './implementations.ts'

const SS = 'https://semblance.dev/demo/sheet#'

function open(prefer: 'sparql' | 'function' = 'function') {
  const h = mountSite('oxigraph', prefer)
  const trace = new RecalculationTrace(h.runtime, h.screen)
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const fire = (el: Element, type: string) => {
    h.fire(el, type)
    trace.record()
    h.shell.flush()
  }
  fire([...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Examples' && visible(b))!, 'click')
  fire([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === 'Spreadsheet' && visible(b))!, 'click')
  const sheet = () => h.document.querySelector('[data-sem-c=sheet]') as HTMLElement
  const cell = (name: string) => h.shell.nodeOf(SS + name + '/~root') as HTMLElement
  const value = (name: string) => {
    const c = cell(name)
    return c.querySelector('input')?.getAttribute('value') ?? c.querySelector('output')!.textContent
  }
  const type = (name: string, text: string) => {
    const input = cell(name).querySelector('input')!
    input.value = text
    fire(input, 'input')
  }
  const status = () => sheet().querySelector('.sem-sheet-status')!.textContent
  const bar = () => sheet().querySelector('.sem-sheet-bar')!.textContent
  const flashing = () => [...sheet().querySelectorAll('[data-sem-recalculated]')].map((c) => c.querySelector('output, input')!.getAttribute('aria-label')).sort()
  const arrows = (way: string) => sheet().querySelectorAll(`.sem-link.sem-${way}`).length
  return { ...h, trace, fire, sheet, cell, value, type, status, bar, flashing, arrows }
}

describe('a spreadsheet of resources and queries', () => {
  it.each(['sparql', 'function'] as const)('computes every formula from the cells it reads (%s)', (prefer) => {
    const s = open(prefer)
    expect(['D2', 'D3', 'D4', 'D5', 'B6', 'D6', 'D7', 'D8'].map(s.value)).toEqual(['34', '50', '28.5', '8', '10', '120.5', '9.64', '130.14'])
    // Lettered columns, numbered rows, each cell where its row and column say.
    expect([...s.sheet().querySelectorAll('.sem-sheet-head')].map((h) => h.textContent).join(' ')).toBe('A B C D 1 2 3 4 5 6 7 8')
    expect(s.cell('C3').getAttribute('style')).toBe('grid-row: 4; grid-column: 4')
    expect(s.cell('D3').getAttribute('data-sem-kind')).toBe('formula')
    expect(s.cell('D3').querySelector('output')!.getAttribute('aria-label')).toBe('D3')
  })

  it.each(['sparql', 'function'] as const)('recalculates what reads a change, and only that, and says so (%s)', (prefer) => {
    const s = open(prefer)
    s.type('C3', '15')
    expect(['D3', 'D6', 'D7', 'D8'].map(s.value)).toEqual(['60', '130.5', '10.44', '140.94'])
    expect(s.status()).toBe('The last change recalculated 4 of 8 formulas.')
    expect(s.flashing()).toEqual(['D3', 'D6', 'D7', 'D8'])
    // The value is a number in the graph.
    const v = s.store.match(s.store.factory.namedNode(SS + 'C3'), s.store.factory.namedNode('https://semblance.dev/ns/component#value'), null)[0]!.object
    expect(v.termType === 'Literal' && v.datatype.value).toBe('http://www.w3.org/2001/XMLSchema#decimal')
    // A quantity reaches the item count too.
    s.type('B2', '2')
    expect(s.status()).toBe('The last change recalculated 5 of 8 formulas.')
    expect(s.flashing()).toEqual(['B6', 'D2', 'D6', 'D7', 'D8'])
    expect(s.value('B6')).toBe('11')
    // The tax rate: two.
    s.type('C7', '0.1')
    expect(s.flashing()).toEqual(['D7', 'D8'])
  })

  it('evaluates exactly the formulas downstream of a change, however the sheet is shown', () => {
    const s = open('function')
    const ran: string[] = []
    const stop = s.screen.engine.onEvaluate((slot, focus) => slot.endsWith('#Formula') && focus.startsWith(SS) && s.store.match(s.store.factory.namedNode(focus), s.store.factory.namedNode('https://semblance.dev/ns/component#valueQuery'), null).length && ran.push(focus.slice(SS.length)))
    s.type('C3', '13')
    stop()
    expect([...new Set(ran)].sort()).toEqual(['D3', 'D6', 'D7', 'D8'])
  })

  it.each(['sparql', 'function'] as const)("shows the selected cell's formula and draws what it reads and what reads it (%s)", (prefer) => {
    const s = open(prefer)
    // D6 is selected to begin with: four lines in, two readers out.
    expect(s.bar()).toBe('D6  =SUM(D2:D5)  →  120.5')
    expect([s.arrows('in'), s.arrows('out')]).toEqual([4, 2])
    expect(s.cell('D6').getAttribute('data-sem-selected')).toBe('true')
    s.fire(s.cell('C3').querySelector('input')!, 'click')
    expect(s.bar()).toMatch(/^C3  12\.50?$/) // as the store writes the decimal
    expect([s.arrows('in'), s.arrows('out')]).toEqual([0, 1])
    expect(s.cell('D6').hasAttribute('data-sem-selected')).toBe(false)
  })

  it('renders the same with SPARQL rules and reactions as with functions', () => {
    expect(implementationGaps(['components/sheet.ttl'])).toEqual({ noSparql: [], noFunction: [] })
    const [a, b] = (['sparql', 'function'] as const).map((prefer) => {
      const s = open(prefer)
      const html = [s.sheet().outerHTML]
      s.type('C3', '15')
      s.fire(s.cell('D3').querySelector('output')!, 'click')
      html.push(s.sheet().outerHTML)
      s.type('A2', 'Pour-over kettle')
      html.push(s.sheet().outerHTML)
      return html
    })
    a!.forEach((html, i) => expect(html, `state ${i}`).toBe(b![i]))
  })
})
