// The "Maintained views" example (demo/gallery/_ex-views.ttl): a dashboard of maintained views
// over the change log, a stream of 100 scheduled events, and a window that ages out on the clock.
import { describe, expect, it } from 'vitest'
import { ManualClock } from '../src/behaviour/clock.ts'
import { mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const VX = 'https://semblance.dev/demo/views#'

function views(prefer: 'sparql' | 'function' = 'sparql') {
  const clock = new ManualClock()
  const h = mountSite('oxigraph', prefer, clock)
  // One clock for events (beh:at), the scheduler (beh:dueAt) and the views' windows.
  h.runtime.views.clock = clock
  h.runtime.views.strict = true
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const open = () => {
    click(button('Examples'))
    click(navItem('Maintained views'))
  }
  const root = () => h.shell.nodeOf(UI + 'ex-views/~root') as Element
  const stat = (label: string) => [...root().querySelectorAll('[data-sem-c=stat]')].find((s) => s.querySelector('.sem-label')!.textContent === label)!.querySelector('.sem-value')!.textContent
  const bars = () => Object.fromEntries([...root().querySelectorAll('[data-sem-c=bar-chart] .sem-bar')].map((b) => [b.querySelector('.sem-category')!.textContent, b.querySelector('.sem-total')!.textContent]))
  const costs = () => [...root().querySelectorAll('[data-sem-c=table] tbody tr')].map((tr) => [...tr.querySelectorAll('td, th')].map((c) => c.textContent))
  const advance = (ms: number) => (clock.advance(ms), h.shell.flush())
  const log = () => h.bus.recent(1000).length
  return { ...h, clock, click, button, open, root, stat, bars, costs, advance, log }
}

describe('the maintained views example', () => {
  for (const prefer of ['sparql', 'function'] as const) {
    it(`counts the log and the last 30 seconds as events stream in (${prefer} rules)`, () => {
      const h = views(prefer)
      h.open()
      expect(h.stat('In the log')).toBe(String(h.log()))
      expect(h.stat('Last 30 seconds')).toBe(String(h.log()))
      h.click(h.button('Stream 100 events'))
      // Twenty a second: five seconds of beh:Due events, each one tick, each checked against a
      // from-scratch run of every view (strict).
      h.advance(5000)
      expect(h.log()).toBe(Math.min(200, 3 + 100))
      expect(h.stat('In the log')).toBe('103')
      expect(h.stat('Last 30 seconds')).toBe('103')
      expect(h.bars()).toMatchObject({ Due: '100' })
      expect(Number(h.stat('Largest change'))).toBeGreaterThan(0)
      // Nothing happens for 40 seconds: the window empties on the clock alone.
      h.advance(40_000)
      expect(h.stat('Last 30 seconds')).toBe('0')
      expect(h.bars()).toEqual({})
      expect(h.stat('In the log')).toBe('103')
    }, 120_000)
  }

  it('shows what each view costs against a from-scratch run', () => {
    const h = views()
    h.open()
    h.click(h.button('Stream 100 events'))
    h.advance(5000)
    h.runtime.warm(8)
    h.shell.flush()
    const rows = Object.fromEntries(h.costs().map(([view, ...cells]) => [view, cells.map((c) => Number(c!.replace(/,/g, '')))]))
    expect(Object.keys(rows).sort()).toEqual(['events per type, last 30 s', 'events, last 30 s', 'the whole log'])
    const [state, last, , reads] = rows['the whole log']!
    expect(reads).toBe(103) // a re-run reads every member
    expect(last).toBeLessThan(10) // the last event was a few rows of work
    expect(state).toBeGreaterThanOrEqual(103)
  }, 120_000)

  it('does nothing while it is not shown, and catches up when shown again', () => {
    const h = views()
    h.open()
    const whole = h.runtime.views.view(VX + 'Whole')!
    // The click that leaves is still counted (the view steps before the page changes).
    h.click(h.button('Docs'))
    const ticks = whole.figures.ticks
    for (let i = 0; i < 5; i++) h.click(h.button(i % 2 ? '☀Day' : '☾Night'))
    expect(whole.figures.ticks).toBe(ticks)
    h.open()
    expect(h.stat('In the log')).toBe(String(h.log()))
  }, 120_000)
})
