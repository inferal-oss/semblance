// Dates and times (ontology/components/dates.ttl): the month grid, the date field, the date range and
// the time field, driven through DOM events as a person would, on Semblance's WASM engine and on
// Oxigraph, with the SPARQL rules and their function twins rendering the same HTML after every step.
import { describe, expect, it } from 'vitest'
import { calendarTexts, daysIn, parseDate, parseTime, weekday } from '../src/components/dates.ts'
import { MOD, NS } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
import { DATES_APP, EX, mountDates } from './dates-app.ts'
import { implementationGaps } from './implementations.ts'

type H = ReturnType<typeof mountDates>

/** Both implementations, driven alike; `step` checks they render the same and returns the SPARQL one. */
function both(kind: 'wat' | 'oxigraph', languages: string[] = [], app = DATES_APP) {
  const hs = (['sparql', 'function'] as const).map((p) => mountDates(kind, p, languages, app))
  const same = (what: string) => {
    const [a, b] = hs.map((h) => h.document.getElementById('app')!.innerHTML)
    if (a === b) return
    let i = 0
    while (a![i] === b![i]) i++
    expect(a!.slice(Math.max(0, i - 200), i + 200), `${what}: SPARQL and function renderings differ`).toBe(b!.slice(Math.max(0, i - 200), i + 200))
  }
  same('initial')
  const act = (what: string, f: (h: H) => unknown) => {
    for (const h of hs) f(h)
    same(what)
  }
  return { h: hs[0]!, act }
}

const opener = (h: H, id: string) => h.root(id).querySelector('.sem-date-row > [data-sem-c=icon-button], .sem-time-row > [data-sem-c=icon-button]') as HTMLElement
const days = (h: H, id: string) => [...h.root(id).querySelectorAll<HTMLElement>('.sem-mg-day')]
const day = (h: H, id: string, n: number) => days(h, id).filter((d) => !d.hasAttribute('data-outside'))[n - 1]!
const active = (h: H, id: string) => h.root(id).querySelector<HTMLElement>('.sem-mg-day[tabindex="0"]')!
const title = (h: H, id: string) => h.root(id).querySelector('.sem-mg-title')!.textContent
const input = (h: H, id: string, end = false) => h.root(id).querySelectorAll<HTMLInputElement>('input')[end ? 1 : 0]!

describe('dates and times as rules', () => {
  it('every rendering has a SPARQL rule and a function twin (the locale texts are Intl, function only)', () => {
    expect(implementationGaps(['components/dates.ttl', 'layers/l10n.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })
})

describe('calendar arithmetic and reading', () => {
  it('knows weekdays and month lengths', () => {
    expect(weekday(2026, 10, 24)).toBe(6)
    expect(weekday(2026, 10, 19)).toBe(1)
    expect(weekday(2000, 1, 1)).toBe(6)
    expect(weekday(2024, 2, 29)).toBe(4)
    expect([daysIn(2024, 2), daysIn(2026, 2), daysIn(1900, 2), daysIn(2000, 2), daysIn(2026, 4), daysIn(2026, 12)]).toEqual([29, 28, 28, 29, 30, 31])
  })

  it('reads dates in a locale’s order, ISO always, two-digit years in this century', () => {
    expect(parseDate('10/24/2026', '%m/%d/%y')).toBe('2026-10-24')
    expect(parseDate('24.10.2026', '%d.%m.%y')).toBe('2026-10-24')
    expect(parseDate(' 5.3.26 ', '%d.%m.%y')).toBe('2026-03-05')
    expect(parseDate('2026-10-24', '%d.%m.%y')).toBe('2026-10-24')
    expect(parseDate('٢٤/١٠/٢٠٢٦', '%d/%m/%y', '٠١٢٣٤٥٦٧٨٩')).toBe('2026-10-24')
    for (const bad of ['31.02.2026', '24.13.2026', '24.10.202', 'tomorrow', '', '1/2']) expect(parseDate(bad, '%d.%m.%y'), bad).toBeUndefined()
  })

  it('reads times in either hour cycle and the locale’s day periods', () => {
    expect(parseTime('14:30')).toBe('14:30:00')
    expect(parseTime('1430')).toBe('14:30:00')
    expect(parseTime('9')).toBe('09:00:00')
    expect(parseTime('2:30 pm')).toBe('14:30:00')
    expect(parseTime('12:05 AM')).toBe('00:05:00')
    expect(parseTime('12 p.m.')).toBe('12:00:00')
    expect(parseTime('2:30 م', 'ص', 'م')).toBe('14:30:00')
    for (const bad of ['25:00', '13 pm', '9:75', 'noon']) expect(parseTime(bad), bad).toBeUndefined()
  })

  it('puts a locale’s calendar into patterns and names', () => {
    const en = calendarTexts('en')
    expect([en.datePattern, en.dateHint, en.monthYearPattern, en.timePattern, en.hourCycle, en.firstWeekday]).toEqual(['%m/%d/%y', 'mm/dd/yyyy', '%M %y', '%h:%n %a', 'h12', 7])
    const uk = calendarTexts('uk')
    expect([uk.datePattern, uk.firstWeekday, uk.hourCycle]).toEqual(['%d.%m.%y', 1, 'h23'])
    expect([uk.months[9]!.label, uk.months[9]!.inDate]).toEqual(['жовтень', 'жовтня'])
    expect(uk.longDatePattern).toContain('%e %M %y')
    const de = calendarTexts('de')
    expect([de.datePattern, de.weekdays[0]!.label]).toEqual(['%d.%m.%y', 'Montag'])
    expect(calendarTexts('ar-EG').digits).toBe('٠١٢٣٤٥٦٧٨٩')
    expect(calendarTexts('en-GB').firstWeekday).toBe(1)
  })
})

describe.each(['wat', 'oxigraph'] as const)('dates and times (%s)', (kind) => {
  it('a month grid is a WAI-ARIA grid of the month, from the locale’s first day', () => {
    const { h } = both(kind)
    const grid = h.root('grid')
    expect(grid.getAttribute('data-sem-c')).toBe('month-grid')
    const table = grid.querySelector('table')!
    expect(table.getAttribute('role')).toBe('grid')
    expect(table.getAttribute('aria-labelledby')).toBe(grid.querySelector('.sem-mg-title')!.id)
    expect(title(h, 'grid')).toBe('October 2026')
    // English weeks start on Sunday; October 2026 starts on a Thursday and spans five weeks.
    expect([...grid.querySelectorAll('th')].map((th) => [th.textContent, th.getAttribute('abbr')])[0]).toEqual(['Sun', 'Sunday'])
    expect(grid.querySelectorAll('tbody tr')).toHaveLength(5)
    expect(days(h, 'grid').slice(0, 5).map((d) => [d.textContent, d.hasAttribute('data-outside')])).toEqual([
      ['27', true], ['28', true], ['29', true], ['30', true], ['1', false],
    ])
    // The value is selected and is the one day in the tab order; today is marked.
    expect(active(h, 'grid').textContent).toBe('24')
    expect(active(h, 'grid').getAttribute('aria-label')).toBe('Saturday, October 24, 2026')
    expect(active(h, 'grid').parentElement!.getAttribute('aria-selected')).toBe('true')
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
    expect(day(h, 'grid', 21).getAttribute('aria-current')).toBe('date')
    // The month buttons are icon buttons, named in the viewer's language.
    expect([...grid.querySelectorAll('.sem-mg-head [data-sem-c=icon-button]')].map((b) => b.getAttribute('aria-label'))).toEqual(['Previous month', 'Next month'])
  })

  it('moves the active day by the WAI-ARIA keys, the month following it', () => {
    const { h, act } = both(kind)
    const key = (k: string, shift = false) => act(k, (x) => x.press(active(x, 'grid'), k, shift))
    key('ArrowRight')
    expect(active(h, 'grid').textContent).toBe('25')
    key('ArrowDown')
    expect([title(h, 'grid'), active(h, 'grid').textContent]).toEqual(['November 2026', '1'])
    key('ArrowLeft')
    key('ArrowUp')
    expect([title(h, 'grid'), active(h, 'grid').textContent]).toEqual(['October 2026', '24'])
    key('Home')
    expect(active(h, 'grid').textContent).toBe('18')
    key('End')
    expect(active(h, 'grid').textContent).toBe('24')
    key('PageDown')
    expect([title(h, 'grid'), active(h, 'grid').textContent]).toEqual(['November 2026', '24'])
    key('PageUp', true)
    expect(title(h, 'grid')).toBe('November 2025')
    act('Shift+PageDown', (x) => x.press(active(x, 'grid'), 'PageDown', true))
    expect(title(h, 'grid')).toBe('November 2026')
    // The active day takes the focus after a key; the value has not changed.
    expect(active(h, 'grid').hasAttribute('data-sem-takes-focus')).toBe(true)
    expect(h.values('departure')).toEqual(['2026-10-24'])
    // The keys cross into other months and years.
    act('to 31', (x) => x.press(active(x, 'grid'), 'End'))
    for (let i = 0; i < 7; i++) key('ArrowRight')
    act('January', (x) => x.press(active(x, 'grid'), 'PageDown'))
    expect(title(h, 'grid')).toBe('January 2027')
    expect(h.state('grid', 'activeDate')).toEqual(['2027-01-05'])
  })

  it('swaps left and right in a right-to-left page, and speaks the locale', () => {
    const { h, act } = both(kind, ['ar'])
    expect(title(h, 'grid')).toBe('أكتوبر 2026')
    expect(h.root('grid').querySelector('th')!.getAttribute('abbr')).toBe('السبت')
    act('right', (x) => x.press(active(x, 'grid'), 'ArrowRight'))
    expect(active(h, 'grid').textContent).toBe('23')
    act('left', (x) => x.press(active(x, 'grid'), 'ArrowLeft'))
    expect(active(h, 'grid').textContent).toBe('24')
    expect(input(h, 'departs').value).toBe('24‏/10‏/2026')
  })

  it('pages months with its buttons, keeping their focus, and picks a day', () => {
    const { h, act } = both(kind)
    const next = () => h.root('grid').querySelectorAll<HTMLElement>('.sem-mg-head [data-sem-c=icon-button]')[1]!
    act('next', (x) => x.fire(x.root('grid').querySelectorAll('.sem-mg-head [data-sem-c=icon-button]')[1]!, 'click'))
    expect(title(h, 'grid')).toBe('November 2026')
    expect(h.state('grid', 'gridFocus')).toEqual(['false'])
    expect(h.root('grid').querySelector('[data-sem-takes-focus]')).toBeNull()
    expect(next()).toBeTruthy()
    act('pick', (x) => x.fire(day(x, 'grid', 3), 'click'))
    expect(h.values('departure')).toEqual(['2026-11-03'])
    expect(active(h, 'grid').textContent).toBe('3')
    expect(active(h, 'grid').parentElement!.getAttribute('aria-selected')).toBe('true')
    // The date field shows the same value.
    expect(input(h, 'departs').value).toBe('11/03/2026')
  })

  it('a date field opens its grid in a dialog on the value, picks, and closes', () => {
    const { h, act } = both(kind)
    const button = opener(h, 'departs')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    const popup = h.root('departs').querySelector<HTMLElement>('.sem-date-popup')!
    expect(button.getAttribute('aria-controls')).toBe(popup.id)
    expect(popup.getAttribute('role')).toBe('dialog')
    expect(popup.hidden).toBe(true)
    expect(input(h, 'departs').value).toBe('10/24/2026')
    expect(input(h, 'departs').getAttribute('placeholder')).toBe('mm/dd/yyyy')
    act('open', (x) => x.fire(opener(x, 'departs'), 'click'))
    expect(opener(h, 'departs').getAttribute('aria-expanded')).toBe('true')
    expect(h.root('departs').querySelector<HTMLElement>('.sem-date-popup')!.hidden).toBe(false)
    // The calendar is anchored to its row (the host lifts it out of a clipping container).
    const anchor = h.root('departs').querySelector<HTMLElement>('.sem-date-popup')!.getAttribute('data-sem-anchor')!
    expect(h.document.getElementById(anchor)!.classList.contains('sem-date-row')).toBe(true)
    // Escape and a press outside click the button; the grid's day takes the focus.
    expect(opener(h, 'departs').hasAttribute('data-sem-escape')).toBe(true)
    expect(opener(h, 'departs').hasAttribute('data-sem-dismiss-outside')).toBe(true)
    expect(active(h, 'departs').textContent).toBe('24')
    expect(active(h, 'departs').hasAttribute('data-sem-takes-focus')).toBe(true)
    // Days outside the shape's bounds cannot be picked.
    expect(day(h, 'departs', 4).getAttribute('aria-disabled')).toBe('true')
    act('disabled', (x) => x.fire(day(x, 'departs', 4), 'click'))
    expect(h.values('departure')).toEqual(['2026-10-24'])
    act('down', (x) => x.press(active(x, 'departs'), 'ArrowDown'))
    act('pick', (x) => x.fire(active(x, 'departs'), 'click'))
    expect(h.values('departure')).toEqual(['2026-10-31'])
    expect(h.state('departs', 'expanded')).toEqual([])
    expect(h.root('departs').querySelector<HTMLElement>('.sem-date-popup')!.hidden).toBe(true)
    expect(input(h, 'departs').value).toBe('10/31/2026')
    // The button takes the focus back; reopening starts afresh on the value.
    expect(opener(h, 'departs').hasAttribute('data-sem-takes-focus')).toBe(true)
    act('reopen', (x) => x.fire(opener(x, 'departs'), 'click'))
    act('away', (x) => x.press(active(x, 'departs'), 'PageDown'))
    act('close', (x) => x.fire(opener(x, 'departs'), 'click'))
    act('reopen again', (x) => x.fire(opener(x, 'departs'), 'click'))
    expect([title(h, 'departs'), active(h, 'departs').textContent]).toEqual(['October 2026', '31'])
  })

  it('Escape closes the popup through its button', () => {
    const { h, act } = both(kind)
    act('open', (x) => x.fire(opener(x, 'departs'), 'click'))
    act('escape', (x) => {
      const e = new x.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
      Object.assign(e, { key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
      active(x, 'departs').dispatchEvent(e)
      x.renderer.flush()
    })
    expect(h.state('departs', 'expanded')).toEqual(['false'])
    expect(h.root('departs').querySelector<HTMLElement>('.sem-date-popup')!.hidden).toBe(true)
  })

  it('reads what is typed in the locale, and says how to write a date when it is not one', () => {
    const { h, act } = both(kind)
    act('type', (x) => x.type(input(x, 'departs'), '11/5/26'))
    expect(h.state('departs', 'value')).toEqual(['11/5/26'])
    act('commit', (x) => x.fire(input(x, 'departs'), 'change'))
    expect(h.values('departure')).toEqual(['2026-11-05'])
    expect(h.state('departs', 'value')).toEqual([])
    expect(input(h, 'departs').value).toBe('11/05/2026')
    act('iso', (x) => x.commit(input(x, 'departs'), '2026-10-30'))
    expect(h.values('departure')).toEqual(['2026-10-30'])
    act('nonsense', (x) => x.commit(input(x, 'departs'), 'next friday'))
    expect(h.values('departure')).toEqual(['2026-10-30'])
    expect(h.state('departs', 'error')).toEqual(['Enter a date as mm/dd/yyyy.'])
    expect(input(h, 'departs').getAttribute('aria-invalid')).toBe('true')
    expect(input(h, 'departs').getAttribute('aria-describedby')).toContain(h.root('departs').querySelector('.sem-error')!.id)
    expect(h.root('departs').querySelector('.sem-error')!.getAttribute('role')).toBe('alert')
    // Out of the shape's bounds: its message.
    act('early', (x) => x.commit(input(x, 'departs'), '10/1/2026'))
    expect(h.values('departure')).toEqual(['2026-10-01'])
    expect(h.state('departs', 'error')).toEqual(['Between 5 October and 20 November.'])
    act('clear', (x) => x.commit(input(x, 'departs'), ''))
    expect(h.values('departure')).toEqual([])
    expect(h.state('departs', 'error')).toEqual([])
  })

  it('reads typed dates in the viewer’s order (Ukrainian: day first)', () => {
    const { h, act } = both(kind, ['uk'])
    expect(input(h, 'departs').value).toBe('24.10.2026')
    expect(input(h, 'departs').getAttribute('placeholder')).toBe('dd.mm.yyyy')
    act('commit', (x) => x.commit(input(x, 'departs'), '5.11.2026'))
    expect(h.values('departure')).toEqual(['2026-11-05'])
    act('open', (x) => x.fire(opener(x, 'departs'), 'click'))
    expect(title(h, 'departs')).toBe('листопад 2026 р.')
    // Ukrainian weeks start on Monday.
    expect(h.root('departs').querySelector('th')!.getAttribute('abbr')).toBe('понеділок')
    expect(active(h, 'departs').getAttribute('aria-label')).toContain('5 листопада 2026')
    expect(opener(h, 'departs').getAttribute('aria-label')).toBe('Виберіть дату')
  })

  it('a date range picks its start, then its end, previewing the span', () => {
    const { h, act } = both(kind)
    expect([input(h, 'trip').value, input(h, 'trip', true).value]).toEqual(['10/20/2026', '10/23/2026'])
    expect(input(h, 'trip', true).getAttribute('aria-label')).toBe('Trip – end')
    act('open', (x) => x.fire(opener(x, 'trip'), 'click'))
    const range = () => days(h, 'trip').filter((d) => d.parentElement!.hasAttribute('data-range')).map((d) => `${d.textContent}:${d.parentElement!.getAttribute('data-range')}`)
    expect(range()).toEqual(['20:start', '21:inside', '22:inside', '23:end'])
    act('start', (x) => x.fire(day(x, 'trip', 26), 'click'))
    expect([h.values('from'), h.values('until')]).toEqual([['2026-10-26'], []])
    expect(h.state('trip', 'expanded')).toEqual(['true'])
    // While the end is picked, the span to the day under the pointer (or the focused day) is previewed.
    act('hover', (x) => x.fire(day(x, 'trip', 29), 'mouseover'))
    expect(range()).toEqual(['26:start', '27:preview', '28:preview', '29:preview'])
    act('before the start', (x) => x.fire(day(x, 'trip', 25), 'mouseover'))
    expect(range()).toEqual(['26:start'])
    act('end', (x) => x.fire(day(x, 'trip', 30), 'click'))
    expect([h.values('from'), h.values('until')]).toEqual([['2026-10-26'], ['2026-10-30']])
    expect(h.state('trip', 'expanded')).toEqual([])
    expect([input(h, 'trip').value, input(h, 'trip', true).value]).toEqual(['10/26/2026', '10/30/2026'])
    // A pick before the start starts again from there.
    act('again', (x) => x.fire(opener(x, 'trip'), 'click'))
    act('restart', (x) => x.fire(day(x, 'trip', 2), 'click'))
    act('before', (x) => x.fire(day(x, 'trip', 1), 'click'))
    expect([h.values('from'), h.values('until')]).toEqual([['2026-10-01'], []])
    // Typed out of order: the shape's sh:lessThanOrEquals speaks.
    act('end typed', (x) => x.commit(input(x, 'trip', true), '9/30/2026'))
    expect(h.values('until')).toEqual(['2026-09-30'])
    expect(h.state('trip', 'error')).toEqual(['The trip ends before it starts.'])
  })

  it('a time field lists times within its bounds, moves through them, and reads typed times', () => {
    const { h, act } = both(kind)
    const field = () => input(h, 'start')
    expect(field().getAttribute('role')).toBe('combobox')
    expect(field().value).toBe('9:30 AM')
    expect(field().getAttribute('aria-expanded')).toBe('false')
    act('open', (x) => x.fire(opener(x, 'start'), 'click'))
    const options = () => [...h.root('start').querySelectorAll('[role=option]')]
    expect(options().map((o) => o.textContent)).toEqual(['8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM'])
    expect(field().getAttribute('aria-controls')).toBe(h.root('start').querySelector('[role=listbox]')!.id)
    expect(field().hasAttribute('data-sem-takes-focus')).toBe(true)
    act('down', (x) => x.press(input(x, 'start'), 'ArrowDown'))
    const selected = () => h.root('start').querySelector('[aria-selected=true]')
    expect(selected()!.textContent).toBe('10:00 AM')
    expect(field().getAttribute('aria-activedescendant')).toBe(selected()!.id)
    act('up', (x) => x.press(input(x, 'start'), 'ArrowUp'))
    act('up again', (x) => x.press(input(x, 'start'), 'ArrowUp'))
    expect(selected()!.textContent).toBe('8:00 AM')
    act('wrap', (x) => x.press(input(x, 'start'), 'ArrowUp'))
    expect(selected()!.textContent).toBe('6:00 PM')
    act('enter', (x) => x.press(input(x, 'start'), 'Enter'))
    expect(h.values('pickup')).toEqual(['18:00:00'])
    expect(field().getAttribute('aria-expanded')).toBe('false')
    act('click option', (x) => {
      x.fire(opener(x, 'start'), 'click')
      x.fire(x.root('start').querySelectorAll('[role=option]')[2]!, 'click')
    })
    expect(h.values('pickup')).toEqual(['10:00:00'])
    act('typed', (x) => x.commit(input(x, 'start'), '2:45 pm'))
    expect(h.values('pickup')).toEqual(['14:45:00'])
    expect(field().value).toBe('2:45 PM')
    act('late', (x) => x.commit(input(x, 'start'), '19:15'))
    expect(h.state('start', 'error')).toEqual(['Between 8:00 and 18:00.'])
    act('bad', (x) => x.commit(input(x, 'start'), 'soon'))
    expect(h.state('start', 'error')).toEqual(['Enter a time as hh:mm AM.'])
    act('escape clears the text', (x) => x.press(input(x, 'start'), 'Escape'))
    expect(h.state('start', 'value')).toEqual([])
  })

  it('a time field in a 24-hour locale', () => {
    const { h, act } = both(kind, ['de'])
    expect(input(h, 'start').value).toBe('9:30')
    act('typed', (x) => x.commit(input(x, 'start'), '1415'))
    expect(h.values('pickup')).toEqual(['14:15:00'])
    expect(input(h, 'start').value).toBe('14:15')
  })

  it('reads as text', () => {
    const { h } = both(kind)
    const text = h.runtime.project({ modality: MOD.Text, name: 'text', roots: [EX + 'page'] })
    expect(toText(text.index, EX + 'departs')).toBe('Departure: [10/24/2026_] ▦\n  The day you leave.')
    expect(toText(text.index, EX + 'trip')).toBe('Trip: [10/20/2026_] – [10/23/2026_] ▦')
    expect(toText(text.index, EX + 'start')).toBe('Pickup: [9:30 AM_] ◷')
    expect(toText(text.index, EX + 'grid').split('\n').slice(0, 3)).toEqual(['‹ October 2026 ›', 'Sun Mon Tue Wed Thu Fri Sat', '· · · · 1 2 3'])
    expect(toText(text.index, EX + 'grid')).toContain('[24]')
  })

  it('checks its components against their shapes', () => {
    const { h } = both(kind)
    const violations = (focus: string) => h.store.match(null, h.store.factory.namedNode(NS.sh + 'focusNode'), h.store.factory.namedNode(EX + focus)).length
    for (const id of ['departs', 'trip', 'grid', 'start']) expect(violations(id), id).toBe(0)
    const bad = both(kind, [], DATES_APP.replace('c:minuteStep 60', 'c:minuteStep 7').replace('c:endProperty ex:until ;', '')).h
    const messages = (focus: string) =>
      bad.store.match(null, bad.store.factory.namedNode(NS.sh + 'focusNode'), bad.store.factory.namedNode(EX + focus)).flatMap((q) =>
        bad.store.match(q.subject, bad.store.factory.namedNode(NS.sh + 'resultMessage'), null).map((m) => m.object.value),
      )
    expect(messages('start')).toEqual(['The minutes between listed times divide an hour (5, 10, 15, 30, 60…).'])
    expect(messages('trip')).toEqual(['A date range names the property of its end (c:endProperty).'])
  })
})
