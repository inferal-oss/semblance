// The "Your activity" example (demo/gallery/_ex-activity.ttl): a dashboard of SPARQL views over
// the change log, driven through events on the site.
import { describe, expect, it } from 'vitest'
import { mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

function activity() {
  const h = mountSite()
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const open = () => {
    click(button('Examples'))
    click(navItem('Your activity'))
  }
  const root = () => h.shell.nodeOf(UI + 'ex-activity/~root') as Element
  const stat = (label: string) => [...root().querySelectorAll('[data-sem-c=stat]')].find((s) => s.querySelector('.sem-label')!.textContent === label)!.querySelector('.sem-value')!.textContent
  const bars = () => Object.fromEntries([...root().querySelectorAll('[data-sem-c=bar-chart] .sem-bar')].map((b) => [b.querySelector('.sem-category')!.textContent, b.querySelector('.sem-total')!.textContent]))
  const components = () => [...root().querySelectorAll('[data-sem-c=table] tbody tr')].map((tr) => tr.querySelector('td, th')!.textContent)
  const header = (text: string) => [...root().querySelectorAll('[data-sem-c=table] th button')].find((t) => t.textContent!.includes(text))!
  const recent = () => [...root().querySelectorAll('[data-sem-c=timeline] li')].length
  return { ...h, click, button, navItem, open, root, stat, bars, components, header, recent }
}

describe('the activity example', () => {
  it('counts what happened since the page was opened, and everything in the log', () => {
    const h = activity()
    h.click(h.button('Docs'))
    h.open()
    expect(h.stat('Since you opened this page')).toBe('0')
    expect(h.stat('In the log')).toBe('3')
    h.click(h.header('Events'))
    h.click(h.header('Events'))
    expect(h.stat('Since you opened this page')).toBe('2')
    expect(h.stat('In the log')).toBe('5')
    expect(Number(h.stat('Triples changed'))).toBeGreaterThan(5)
  })

  it('charts events by type and lists the most-used components, live', () => {
    const h = activity()
    h.open()
    expect(h.bars()).toEqual({ Click: '2.00' })
    expect(h.components()).toEqual(['nav-list', 'segmented'])
    h.click(h.header('Component'))
    h.click(h.header('Component'))
    h.click(h.header('Component'))
    expect(h.bars()).toEqual({ Click: '5.00' })
    // Sorted by component now (the header clicks sort the table).
    expect(h.components()).toEqual(['nav-list', 'segmented', 'table'])
    expect(h.recent()).toBe(5)
  })

  it('is parked while not shown, and cheap while it is', () => {
    const measure = (h: ReturnType<typeof activity>, action: () => void) => {
      const s = h.screen.engine.stats
      const before = s.ruleRuns
      action()
      return s.ruleRuns - before
    }
    // Shown: an event re-runs its views (and what the click itself changes).
    const shown = activity()
    shown.open()
    const whileShown = measure(shown, () => shown.click(shown.header('Events')))
    expect(whileShown).toBeLessThan(40)
    // Elsewhere, a click costs the same whether the dashboard was ever opened or not.
    const visited = activity()
    visited.open()
    visited.click(visited.button('Docs'))
    const never = activity()
    never.click(never.button('Examples'))
    never.click(never.navItem('Sign in with a code'))
    never.click(never.button('Docs'))
    const night = (h: ReturnType<typeof activity>) => () => h.click(h.button('☾Night'))
    expect(measure(visited, night(visited))).toBe(measure(never, night(never)))
    // Coming back, it has caught up.
    visited.click(visited.button('Examples'))
    expect(visited.stat('Since you opened this page')).toBe('3')
  })
})
