// The room bookings example (demo/gallery/_ex-calendar.ttl) on a c:Calendar: a week of meetings, a
// room held by one meeting at a time (c:exclusiveBy), rooms that seat so many (sh:maxInclusive), and
// the same meetings as an agenda - driven through events on the site.
import { describe, expect, it } from 'vitest'
import { mountSite } from './harness.ts'
import { fakeLayout } from './drag-layout.ts'
import { implementationGaps } from './implementations.ts'
import { A11Y, MOD, NS, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'

const UI = 'https://semblance.dev/demo#'
const CAL = 'https://semblance.dev/demo/calendar#'
const WEEK = UI + 'ex-calendar-week'

function bookings(prefer: 'sparql' | 'function' = 'sparql', kind: 'oxigraph' | 'wat' = 'oxigraph', grow = 0) {
  const h = mountSite(kind, prefer)
  if (grow) {
    // More meetings, all on Thursday and Friday in a room of their own: nothing the moves below touch.
    const f = h.store.factory
    const nn = (s: string) => f.namedNode(s)
    const add = [f.quad(nn(CAL + 'annex'), nn(NS.rdf + 'type'), nn(CAL + 'Room')), f.quad(nn(CAL + 'annex'), nn(NS.rdfs + 'label'), f.literal('Annex'))]
    for (let i = 0; i < grow; i++) {
      const m = nn(`${CAL}extra-${i}`)
      add.push(
        f.quad(m, nn(NS.rdf + 'type'), nn(CAL + 'Meeting')),
        f.quad(m, nn(CAL + 'title'), f.literal(`Extra ${i}`)),
        f.quad(m, nn(CAL + 'day'), nn(CAL + (i % 2 ? 'thu' : 'fri'))),
        f.quad(m, nn(CAL + 'start'), f.literal(String(9 + (i % 8)), nn(NS.xsd + 'integer'))),
        f.quad(m, nn(CAL + 'hours'), f.literal('1', nn(NS.xsd + 'integer'))),
        f.quad(m, nn(CAL + 'room'), nn(CAL + 'annex')),
        f.quad(m, nn(CAL + 'attendees'), f.literal('2', nn(NS.xsd + 'integer'))),
        f.quad(nn(WEEK), nn(NS.c + 'entry'), m),
      )
    }
    h.runtime.apply({ add, remove: [] })
    h.shell.flush()
  }
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  click(button('Examples'))
  click(navItem('Room bookings'))
  const root = () => h.shell.nodeOf(UI + 'ex-calendar/~root') as Element
  const week = () => root().querySelector('[data-sem-c=calendar]')!
  const entry = (title: string) => [...week().querySelectorAll('[data-sem-c=calendar-entry]')].find((e) => e.querySelector('.sem-title')!.textContent === title) as HTMLElement
  /** Where each meeting is drawn: its cell (day and hour) and what it says. */
  const where = (title: string) => {
    const e = entry(title)
    const cell = e.closest('.sem-cal-cell')!
    const slot = cell.getAttribute('data-sem-drop-zone')!.replace(/^.*~slot-/, '')
    return `${decodeURIComponent(slot).replace(CAL, '')} ${e.textContent}`
  }
  const place = (title: string) => entry(title).closest('.sem-cal-place')!.getAttribute('style')
  const value = (s: string, p: string) => h.store.match(h.store.factory.namedNode(CAL + s), h.store.factory.namedNode(CAL + p), null).map((q) => q.object.value.replace(CAL, ''))
  const alert = () => root().querySelector('[data-sem-c=alert]')!
  const agenda = () => [...root().querySelectorAll('[data-sem-c=table] tbody tr')].map((tr) => [...tr.querySelectorAll('td, th')].map((c) => c.textContent!.trim()).join(' | '))
  const toasts = () => [...h.document.querySelectorAll('[data-sem-c=toast]')].map((t) => t.textContent).join(' | ')
  const press = (el: Element, key: string) => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
    el.dispatchEvent(e)
    h.shell.flush()
  }
  const zones = () => [...h.document.querySelectorAll('[data-sem-drop-zone]')].filter((z) => visible(z)) as HTMLElement[]
  const zoneOf = (receptacle: string) => zones().findIndex((z) => z.getAttribute('data-sem-drop-zone') === receptacle)
  const slot = (day: string, hour: number) => `${WEEK}/~slot-${encodeURIComponent(CAL + day)}-${hour}`
  const refusing = () => zones().filter((z) => z.getAttribute('data-sem-drop') === 'refuses').map((z) => `${decodeURIComponent(z.getAttribute('data-sem-drop-zone')!.replace(/^.*~slot-/, '')).replace(CAL, '')}: ${z.getAttribute('data-sem-drop-reason')}`)
  return { ...h, click, root, week, entry, where, place, value, alert, agenda, toasts, press, zones, zoneOf, slot, refusing }
}

/** With a fake layout: every shown zone side by side, 100px apart, its draggables in 40px rows. */
function dragging(prefer: 'sparql' | 'function' = 'sparql', kind: 'oxigraph' | 'wat' = 'oxigraph', grow = 0) {
  const h = bookings(prefer, kind, grow)
  const { rectOf, pointer } = fakeLayout(h, { width: 100, row: 40 })
  /** Pick a meeting up and hold it over a zone (by its receptacle). */
  const hold = (title: string, receptacle: string) => {
    const el = h.entry(title)
    const r = rectOf(el)
    pointer(el, 'pointerdown', r.left + 10, r.top + 10)
    pointer(h.document, 'pointermove', r.left + 20, r.top + 20)
    const z = h.zoneOf(receptacle)
    expect(z, receptacle).toBeGreaterThanOrEqual(0)
    pointer(h.document, 'pointermove', z * 100 + 50, 100 + 5)
    h.shell.flush()
    return z
  }
  const drop = (title: string, receptacle: string) => {
    const z = hold(title, receptacle)
    pointer(h.document, 'pointerup', z * 100 + 50, 100 + 5)
    h.shell.flush()
  }
  return { ...h, pointer, hold, drop }
}

describe('the room bookings example', () => {
  it('has SPARQL and function implementations of the calendar', () => {
    expect(implementationGaps(['components/calendar.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })

  // #149: the conflict note ("Overlaps …") and every other text in the viewer's language, the same
  // with SPARQL rules as with their function twins.
  for (const language of ['uk', 'de', 'ar']) {
    it(`renders the same with SPARQL and functions in ${language}, conflict notes included`, () => {
      const [a, b] = (['sparql', 'function'] as const).map((prefer) => {
        const h = bookings(prefer)
        h.screen.engine.reconfigure({ languages: [language] })
        h.shell.flush()
        return h
      })
      expect(a!.root().outerHTML).toBe(b!.root().outerHTML)
      if (language === 'uk') expect(a!.where('Planning')).toContain('Перетинається з')
    })
  }

  it('lays out the week, marks the double booking, and lists the same meetings as an agenda', () => {
    const h = bookings()
    const days = [...h.week().querySelectorAll('[role=columnheader]')].map((d) => d.textContent)
    expect(days).toEqual(['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])
    expect([...h.week().querySelectorAll('[role=rowheader]')].map((r) => r.textContent)).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'])
    expect(h.week().querySelector('[role=table]')!.getAttribute('aria-label')).toBe('Week 43')
    // Each meeting in the cell of its day and hour, as far down as its minutes, as tall as it lasts.
    expect(h.where('Standup')).toBe('mon-9 Standup09:30–10:00Babbage')
    expect(h.place('Design review')).toBe('--sem-start: 0; --sem-span: 90; --sem-lane: 0; --sem-lanes: 1')
    // Tuesday's customer call and planning overlap in Lovelace: side by side, each naming the other.
    expect(h.where('Customer call')).toBe('tue-14 Customer call14:00–15:00LovelaceOverlaps Planning')
    expect(h.where('Planning')).toBe('tue-14 Planning14:30–16:00LovelaceOverlaps Customer call')
    expect(h.place('Customer call')).toBe('--sem-start: 0; --sem-span: 60; --sem-lane: 0; --sem-lanes: 2')
    expect(h.place('Planning')).toBe('--sem-start: 30; --sem-span: 90; --sem-lane: 1; --sem-lanes: 2')
    expect(h.entry('Planning').classList.contains('sem-conflict')).toBe(true)
    expect(h.entry('Retro').classList.contains('sem-conflict')).toBe(false)
    // A meeting is tinted by its room's tone, is draggable, and is described by its time and room.
    const retro = h.entry('Retro')
    expect(retro.getAttribute('data-sem-tone')).toBe('accent')
    expect(retro.getAttribute('data-sem-drag')).toBe(CAL + 'm10')
    expect(retro.getAttribute('aria-describedby')!.split(' ').map((id) => h.document.getElementById(id)!.textContent)).toEqual(['15:00–16:00', 'Lovelace'])
    expect(h.alert().getAttribute('data-sem-tone')).toBe('danger')
    expect(h.alert().textContent).toContain('1 double booking: Customer call and Planning overlap in Lovelace on Tuesday.')
    expect(h.agenda()[3]).toBe('Tuesday | 14:00–15:00 | Customer call | Lovelace | 5 | Planning')
    expect(h.agenda()).toHaveLength(11)
  })

  it('carries a meeting by keyboard to another day, and the double booking is gone everywhere', () => {
    const h = bookings()
    const before = h.bus.recent(1000).length
    h.press(h.entry('Planning'), ' ')
    // While it is carried, the slots where it would double-book Lovelace refuse it, and so does
    // Babbage, which seats four.
    expect(h.refusing()).toEqual([
      'mon-12: That room is booked then.',
      'mon-13: That room is booked then.',
      'tue-13: That room is booked then.',
      'fri-14: That room is booked then.',
      'fri-15: That room is booked then.',
      'babbage: Babbage seats 4.',
    ])
    expect(h.bus.recent(1000).length).toBe(before) // lifting is not history
    h.press(h.entry('Planning'), 'ArrowRight')
    expect(h.document.querySelector('[data-sem-drag-live]')!.textContent).toBe('Planning: Wednesday 14:00.')
    h.press(h.entry('Planning'), ' ')
    expect(h.value('m5', 'day')).toEqual(['wed'])
    expect(h.value('m5', 'start')).toEqual(['14.5'])
    expect(h.where('Planning')).toBe('wed-14 Planning14:30–16:00Lovelace')
    expect(h.where('Customer call')).toBe('tue-14 Customer call14:00–15:00Lovelace')
    expect(h.place('Customer call')).toBe('--sem-start: 0; --sem-span: 60; --sem-lane: 0; --sem-lanes: 1')
    expect(h.place('Planning')).toBe('--sem-start: 30; --sem-span: 90; --sem-lane: 0; --sem-lanes: 1')
    expect(h.alert().getAttribute('data-sem-tone')).toBe('success')
    expect(h.alert().textContent).toContain('No room is double-booked.')
    expect(h.agenda()).toContain('Wednesday | 14:30–16:00 | Planning | Lovelace | 6 | ')
    // One drop, one member of the change log.
    expect(h.bus.recent(1000).length).toBe(before + 1)
    expect(h.toasts()).toContain('Moved')
  })

  it('refuses a drop that would double-book a room, or a room too small, with the shape’s message', () => {
    const h = dragging()
    h.drop('Retro', h.slot('mon', 13))
    expect(h.toasts()).toContain('That room is booked then.')
    expect(h.value('m10', 'day')).toEqual(['fri'])
    expect(h.entry('Retro').hasAttribute('data-sem-refused')).toBe(true)
    // The all-hands (twelve people) does not fit in Babbage.
    h.drop('All hands', CAL + 'babbage')
    expect(h.toasts()).toContain('Babbage seats 4.')
    expect(h.value('m7', 'room')).toEqual(['hopper'])
    // Lovelace is free on Thursday at 13:00, but seats eight: Architecture (nine) is refused...
    h.drop('Architecture', CAL + 'lovelace')
    expect(h.toasts()).toContain('Lovelace seats 8.')
    // A meeting that fits a free room moves there: one triple.
    h.drop('Hiring sync', CAL + 'lovelace')
    expect(h.value('m3', 'room')).toEqual(['lovelace'])
    expect(h.where('Hiring sync')).toBe('tue-10 Hiring sync10:00–11:00Lovelace')
    expect(h.toasts()).toContain('Moved to another room')
  })

  it('a room booked while the meeting is on objects to it', () => {
    const h = dragging()
    h.hold('Architecture', CAL + 'hopper')
    // Architecture is in Hopper already: Hopper takes it back. Lovelace seats eight; Babbage four.
    expect(h.refusing().filter((r) => !r.includes('-'))).toEqual(['lovelace: Lovelace seats 8.', 'babbage: Babbage seats 4.'])
    h.pointer(h.document, 'pointerup', 0, 0)
    h.shell.flush()
    // The planning session overlaps the customer call in Lovelace; Hopper is free then, and takes it.
    h.drop('Planning', CAL + 'hopper')
    expect(h.value('m5', 'room')).toEqual(['hopper'])
    expect(h.alert().textContent).toContain('No room is double-booked.')
    // Now the customer call may not go to Hopper: the planning session is there at 14:30.
    h.hold('Customer call', CAL + 'hopper')
    expect(h.refusing()).toContain('hopper: That room is booked then.')
  })

  for (const [kind, prefer] of [['oxigraph', 'sparql'], ['wat', 'sparql'], ['oxigraph', 'function']] as const) {
    it(`refuses in the viewer's language: the objections, the shapes and the toast (${kind}, ${prefer})`, () => {
      const h = dragging(prefer, kind)
      h.screen.engine.reconfigure({ languages: ['de'] })
      h.shell.flush()
      h.press(h.entry('Planning'), ' ')
      expect(h.refusing()).toEqual([
        'mon-12: Der Raum ist dann belegt.',
        'mon-13: Der Raum ist dann belegt.',
        'tue-13: Der Raum ist dann belegt.',
        'fri-14: Der Raum ist dann belegt.',
        'fri-15: Der Raum ist dann belegt.',
        'babbage: Babbage hat 4 Plätze.',
      ])
      h.press(h.entry('Planning'), 'Escape')
      h.drop('Retro', h.slot('mon', 13))
      expect(h.toasts()).toContain('Der Raum ist dann belegt.')
    })
  }

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`renders the same with SPARQL (${kind}) and with function rules, while carrying and after drops`, () => {
      const [a, b] = [dragging('sparql', kind), dragging('function', 'oxigraph')]
      const html = (h: typeof a) => h.root().innerHTML
      expect(html(b)).toBe(html(a))
      for (const h of [a, b]) h.hold('Planning', h.slot('wed', 9))
      expect(html(b)).toBe(html(a))
      expect(html(a)).toContain('data-sem-drop="refuses"')
      for (const h of [a, b]) h.pointer(h.document, 'pointerup', h.zoneOf(h.slot('wed', 9)) * 100 + 50, 105), h.shell.flush()
      expect(a.where('Planning')).toBe('wed-9 Planning09:30–11:00Lovelace')
      expect(html(b)).toBe(html(a))
      for (const h of [a, b]) h.drop('Hiring sync', h.slot('wed', 10))
      expect(a.place('Hiring sync')).toBe('--sem-start: 0; --sem-span: 60; --sem-lane: 1; --sem-lanes: 2')
      expect(html(b)).toBe(html(a))
      for (const h of [a, b]) h.drop('Planning', CAL + 'hopper')
      expect(html(b)).toBe(html(a))
    }, 120_000)
  }

  it('draws the week as text too', () => {
    for (const prefer of ['sparql', 'function'] as const) {
      const h = bookings(prefer)
      const text = h.runtime.project({ modality: MOD.Text, prefer, name: 'text-calendar', roots: [WEEK] })
      expect(toText(text.index, WEEK).split('\n').filter(Boolean)).toEqual([
        '## Monday', '  09:30–10:00 Standup · Babbage', '  13:00–14:30 Design review · Lovelace',
        '## Tuesday', '  10:00–11:00 Hiring sync · Babbage', '  14:00–15:00 Customer call · Lovelace (overlaps Planning)', '  14:30–16:00 Planning · Lovelace (overlaps Customer call)',
        '## Wednesday', '  09:30–10:00 Standup · Babbage', '  16:00–17:00 All hands · Hopper',
        '## Thursday', '  11:00–11:30 1:1 with Grace · Babbage', '  13:00–15:00 Architecture · Hopper',
        '## Friday', '  10:00–11:30 Demo prep · Hopper', '  15:00–16:00 Retro · Lovelace',
      ])
    }
  })
})

describe('moving a meeting costs what it changes', () => {
  it('the same rule runs and DOM operations with eleven meetings as with fifty more', () => {
    const measure = (grow: number) => {
      // The site's store: rule runs and DOM operations are the same on any, and Oxigraph's first
      // render of the week takes most of a minute.
      const h = bookings('sparql', 'wat', grow)
      // The week alone, in a projection of its own: its DOM operations are the calendar's.
      const week = h.runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer], prefer: 'sparql', name: 'week', roots: [WEEK] })
      const el = h.document.createElement('div')
      const renderer = new DomRenderer(week.index, el, WEEK)
      renderer.flush()
      const snap = () => ({ ruleRuns: h.screen.engine.stats.ruleRuns, weekRuns: week.engine.stats.ruleRuns, weekOps: renderer.ops })
      const steps: ReturnType<typeof snap>[] = []
      const step = (act: () => void) => {
        const a = snap()
        act()
        renderer.flush()
        const b = snap()
        steps.push({ ruleRuns: b.ruleRuns - a.ruleRuns, weekRuns: b.weekRuns - a.weekRuns, weekOps: b.weekOps - a.weekOps })
      }
      step(() => h.press(h.entry('Planning'), ' '))
      step(() => h.press(h.entry('Planning'), 'ArrowRight'))
      step(() => h.press(h.entry('Planning'), ' '))
      return steps
    }
    const small = measure(0)
    const large = measure(50)
    expect(large).toEqual(small)
    // The drop: the week's rule, the entries whose place or marks changed, and the layers over
    // them; the cells' drop marks come and go with the drag (a week's worth, whatever it holds).
    expect(small[2]!.weekRuns).toBeLessThan(30)
    console.info('[calendar cost]', JSON.stringify(small))
  }, 120_000)
})
