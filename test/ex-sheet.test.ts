// The spreadsheet example (demo/gallery/_ex-sheet.ttl) and its components (c:Sheet, c:SheetCell),
// driven only through events; the host's recalculation trace (src/recalculation.ts) wired as the demo wires it.
import { describe, expect, it } from 'vitest'
import { RecalculationTrace } from '../src/recalculation.ts'
import type { StoreKind } from '../src/node/load.ts'
import { mountSite } from './harness.ts'
import { implementationGaps } from './implementations.ts'

const SS = 'https://semblance.dev/demo/sheet#'
const C = 'https://semblance.dev/ns/component#'

// On Semblance's own engine (the site's store), where a sheet this size opens in half a second; the
// typed formulas are also checked on Oxigraph.
function open(prefer: 'sparql' | 'function' = 'function', kind: StoreKind = 'wat') {
  const h = mountSite(kind, prefer)
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
  const cell = (name: string) => h.shell.nodeOf((name.includes('-') ? SS + 'sales' : SS) + name + '/~root') as HTMLElement
  const value = (name: string) => {
    const c = cell(name)
    const input = c.querySelector('input')
    return input ? (input.getAttribute('value') ?? '') : c.querySelector('output')!.textContent
  }
  const write = (name: string, text: string, commit = false) => {
    const input = cell(name).querySelector('input')!
    input.value = text
    fire(input, 'input')
    if (commit) fire(input, 'change')
  }
  const type = (name: string, text: string) => write(name, text)
  const status = () => sheet().querySelector('.sem-sheet-status')!.textContent
  const bar = () => sheet().querySelector('.sem-sheet-bar')!.textContent
  const flashing = () => [...sheet().querySelectorAll('[data-sem-recalculated]')].map((c) => c.querySelector('output, input')!.getAttribute('aria-label')).sort()
  // The dependency arrows are connectors: what the cell reads in the accent, what reads it in success.
  const arrows = (way: string) => sheet().querySelectorAll(`[data-sem-c=connector][data-sem-tone=${way === 'in' ? 'accent' : 'success'}]`).length
  const button = (label: string) => fire([...sheet().querySelectorAll('button')].find((b) => b.textContent!.trim() === label)!, 'click')
  /** A DOM event with modifier keys and a key, as the browser sends it. */
  const send = (el: Element, type: string, init: { shiftKey?: boolean; key?: string } = {}) => {
    const e = new h.window.Event(type, { bubbles: true })
    for (const [k, v] of Object.entries({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...init })) Object.defineProperty(e, k, { value: v })
    el.dispatchEvent(e)
    trace.record()
    h.shell.flush()
  }
  const control = (name: string) => cell(name).querySelector('input, output')!
  /** A click as a pointer makes it: the press (which focuses the cell), the release, the click. */
  const click = (name: string, shiftKey = false) => {
    const el = control(name)
    send(el, 'pointerdown', { shiftKey })
    send(el, 'focusin')
    send(el, 'pointerup', { shiftKey })
    send(el, 'click', { shiftKey })
  }
  const key = (name: string, k: string) => send(control(name), 'keydown', { key: k, shiftKey: true })
  const ranged = () => Object.fromEntries([...sheet().querySelectorAll('[data-sem-range]')].map((c) => [c.querySelector('input, output')!.getAttribute('aria-label'), c.getAttribute('data-sem-range')]))
  return { ...h, trace, fire, sheet, cell, value, write, type, status, bar, flashing, arrows, button, send, click, key, ranged }
}

/** The cells a change to B4 (the cappuccinos' first quarter) re-runs. */
const RIPPLE = ['B18', 'B19', 'B20', 'F18', 'F19', 'F20', 'F4', 'G4', 'J18', 'J4', ...Array.from({ length: 16 }, (_, i) => `H${i + 2}`)].sort()

describe('a spreadsheet of resources and queries', () => {
  it.each(['sparql', 'function'] as const)('computes every formula from the cells it reads (%s)', (prefer) => {
    const s = open(prefer)
    // A row: its year, its average, its share of the year's total, its gap to the target.
    expect(['F2', 'G2', 'J2'].map(s.value)).toEqual(['16950', '4237.5', '-50'])
    expect(s.value('F18')).toBe('152200')
    expect(s.value('H2')).toBe('0.1114')
    // Each column's total, best and average.
    expect(['B18', 'B19', 'B20'].map(s.value)).toEqual(['35250', '5200', '2203.13'])
    // Lettered columns, numbered rows, each cell where its row and column say.
    expect([...s.sheet().querySelectorAll('.sem-sheet-head')].map((h) => h.textContent).join(' ')).toBe('A B C D E F G H I J ' + Array.from({ length: 20 }, (_, i) => i + 1).join(' '))
    expect(s.cell('B4').getAttribute('style')).toBe('grid-row: 5; grid-column: 3')
    expect(s.cell('F4').getAttribute('data-sem-kind')).toBe('formula')
    expect(s.cell('F4').querySelector('output')!.getAttribute('aria-label')).toBe('F4')
  })

  it.each(['sparql', 'function'] as const)('recalculates what reads a change, and only that, and says so (%s)', (prefer) => {
    const s = open(prefer)
    s.type('B4', '4000')
    expect(['F4', 'G4', 'B18', 'F18'].map(s.value)).toEqual(['16300', '4075', '35350', '152300'])
    expect(s.status()).toBe('The last change recalculated 26 of 81 formulas.')
    expect(s.flashing()).toEqual(RIPPLE)
    // The value is a number in the graph.
    const v = s.store.match(s.store.factory.namedNode(SS + 'B4'), s.store.factory.namedNode(C + 'value'), null)[0]!.object
    expect(v.termType === 'Literal' && v.datatype.value).toBe('http://www.w3.org/2001/XMLSchema#decimal')
    // A target: its gap, and the total's.
    s.type('I3', '20000')
    expect(s.flashing()).toEqual(['I18', 'J18', 'J3'])
  })

  it('evaluates exactly the formulas downstream of a change, at a cost the size of the sheet does not change', () => {
    const s = open('function')
    const ran: string[] = []
    // (the formula layer is offered every cell; a value cell is passed over)
    const formula = (focus: string) => s.store.match(s.store.factory.namedNode(focus), s.store.factory.namedNode(C + 'formulaText'), null).length > 0
    const stop = s.screen.engine.onEvaluate((slot, focus) => slot.endsWith('#Formula') && focus.startsWith(SS) && formula(focus) && ran.push(focus.slice(SS.length)))
    const edit = (text: string) => {
      ran.length = 0
      const before = s.screen.engine.stats.ruleRuns
      s.type('B4', text)
      return { formulas: [...new Set(ran)].sort(), ruleRuns: s.screen.engine.stats.ruleRuns - before }
    }
    edit('4000') // the first change also starts the trace
    const small = edit('4001')
    expect(small.formulas).toEqual(RIPPLE)
    // Ten more rows: the same edit costs the same.
    for (let i = 0; i < 10; i++) s.button('Add a row')
    const large = edit('4002')
    stop()
    expect(JSON.stringify(large)).toBe(JSON.stringify(small))
  })

  it.each(['sparql', 'function'] as const)("shows the selected cell's formula and draws what it reads and what reads it (%s)", (prefer) => {
    const s = open(prefer)
    // F4 is selected to begin with: its four quarters in; its share, gap, and the year's total, best and average out.
    expect(s.bar()).toBe('F4  =SUM(B4:E4)  →  16200')
    expect([s.arrows('in'), s.arrows('out')]).toEqual([4, 5])
    expect(s.cell('F4').getAttribute('data-sem-selected')).toBe('true')
    s.fire(s.cell('B4').querySelector('input')!, 'click')
    expect(s.bar()).toBe('B4  3900')
    expect([s.arrows('in'), s.arrows('out')]).toEqual([0, 5])
    expect(s.cell('F4').hasAttribute('data-sem-selected')).toBe(false)
  })

  it.each([
    ['sparql', 'wat'],
    ['function', 'wat'],
    ['sparql', 'oxigraph'],
  ] as const)('takes a typed formula, and grows by a row or a column (%s, %s)', (prefer, kind) => {
    const s = open(prefer, kind)
    s.button('Add a column')
    expect(s.sheet().querySelectorAll('.sem-sheet-head')[10]!.textContent).toBe('K')
    expect(s.value('-K2')).toBe('')
    // Typing is text until it is committed; then it is the cell's formula, read into a query.
    s.write('-K2', '=average(b2:b17)')
    expect(s.value('-K2')).toBe('=average(b2:b17)')
    s.write('-K2', '=average(b2:b17)', true)
    expect(s.cell('-K2').getAttribute('data-sem-kind')).toBe('formula')
    expect(s.value('-K2')).toBe('2203.13')
    const f = s.store.factory
    expect(s.store.match(f.namedNode(SS + 'sales-K2'), f.namedNode(C + 'formulaText'), null).map((q) => q.object.value)).toEqual(['=AVERAGE(B2:B17)'])
    s.write('-K3', '=B3*I3', true)
    expect(s.value('-K3')).toBe(String(5200 * 21000))
    // Both recalculate with what they read.
    s.type('B3', '5300')
    expect(s.flashing()).toEqual(expect.arrayContaining(['K2', 'K3']))
    expect(s.value('-K3')).toBe(String(5300 * 21000))
    // Text that is no formula this sheet knows stays a value.
    s.write('-K4', '=FOO(A1)', true)
    expect(s.value('-K4')).toBe('=FOO(A1)')
    // A row under the last, a cell in each column.
    s.button('Add a row')
    expect(s.cell('-A21')).toBeTruthy()
    expect(s.cell('-K21')).toBeTruthy()
  })

  it.each([
    ['sparql', 'wat'],
    ['function', 'wat'],
    ['sparql', 'oxigraph'],
  ] as const)('selects a range with Shift, marks its edges and sums it up (%s, %s)', (prefer, kind) => {
    const s = open(prefer, kind)
    s.click('B2')
    expect(s.ranged()).toEqual({})
    // Shift+click: from the selected cell to this one; the selected cell stays where it was.
    s.click('C3', true)
    expect(s.ranged()).toEqual({ B2: 'top start', C2: 'top end', B3: 'bottom start', C3: 'bottom end' })
    expect(s.cell('B2').getAttribute('data-sem-selected')).toBe('true')
    expect(s.status()).toBe('B2:C3  ·  Sum 19130  ·  Average 4782.5  ·  Count 4')
    // Shift with the arrow keys moves the far corner, wherever the focus is.
    s.key('C3', 'ArrowDown')
    expect(s.status()).toBe('B2:C4  ·  Sum 27150  ·  Average 4525  ·  Count 6')
    expect(s.ranged().C3).toBe('end')
    expect(s.ranged().B3).toBe('start')
    s.key('C3', 'ArrowRight')
    expect(Object.keys(s.ranged()).length).toBe(9)
    // A value in the range changes: the sum follows.
    s.type('B3', '5300')
    expect(s.status()).toBe('B2:D4  ·  Sum 40280  ·  Average 4475.56  ·  Count 9')
    // Text counts, but is not summed; a range with no numbers only counts.
    s.click('A2')
    s.key('A2', 'ArrowDown')
    expect(s.status()).toBe('A2:A3  ·  Count 2')
    s.key('A2', 'ArrowRight')
    expect(s.status()).toBe('A2:B3  ·  Sum 9400  ·  Average 4700  ·  Count 4')
    // Back onto the selected cell: no range.
    s.key('A2', 'ArrowUp')
    s.key('A2', 'ArrowLeft')
    expect(s.ranged()).toEqual({})
    // A plain click selects one cell again.
    s.click('C3', true)
    expect(Object.keys(s.ranged()).length).toBe(6)
    s.click('D5')
    expect(s.ranged()).toEqual({})
    expect(s.bar()).toBe('D5  3190')
  })

  it.each(['sparql', 'function'] as const)('swaps left and right in a right-to-left language (%s)', (prefer) => {
    const s = open(prefer)
    const f = s.store.factory
    const app = s.store.match(null, f.namedNode('https://semblance.dev/ns/l10n#language'), null)[0]!
    s.runtime.apply({ remove: [app], add: [f.quad(app.subject, app.predicate, f.namedNode('https://semblance.dev/ns/l10n#Arabic'))] })
    s.shell.flush()
    s.click('C3')
    s.key('C3', 'ArrowLeft')
    expect(Object.keys(s.ranged()).sort()).toEqual(['C3', 'D3'])
    s.key('C3', 'ArrowRight')
    s.key('C3', 'ArrowRight')
    expect(Object.keys(s.ranged()).sort()).toEqual(['B3', 'C3'])
  })

  it('renders the same with SPARQL rules and reactions as with functions', () => {
    expect(implementationGaps(['components/sheet.ttl'])).toEqual({ noSparql: [], noFunction: [] })
    const [a, b] = (['sparql', 'function'] as const).map((prefer) => {
      const s = open(prefer)
      const html = [s.sheet().outerHTML]
      s.type('B4', '4000')
      s.fire(s.cell('H4').querySelector('output')!, 'click')
      html.push(s.sheet().outerHTML)
      s.click('B2')
      s.click('D5', true)
      s.key('D5', 'ArrowRight')
      html.push(s.sheet().outerHTML)
      s.type('C3', '2500')
      html.push(s.sheet().outerHTML)
      s.type('A2', 'Ristretto')
      html.push(s.sheet().outerHTML)
      s.button('Add a column')
      s.write('-K2', '=MAX(B2:E2)', true)
      s.button('Add a row')
      html.push(s.sheet().outerHTML)
      return html
    })
    a!.forEach((html, i) => expect(html, `state ${i}`).toBe(b![i]))
  })
})
