// The coffee tasting example (demo/gallery/_ex-foreign.ttl): Shoelace's <sl-rating> and a Chart.js bar
// chart as islands. The site loads both from a CDN (demo/foreign.ts); here stand-ins with the same
// surface take their place - an <sl-rating> with a `value` and `label` property that raises `sl-change`,
// and a widget registered as "chart.js" that takes `bars`, `selected` and `label` and calls
// emit('select', { id }) - and everything is driven through DOM events on them.
import { describe, expect, it } from 'vitest'
import { Islands, type Widget } from '../src/foreign.ts'
import { mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const CF = 'https://semblance.dev/demo/coffee#'

type Win = ReturnType<typeof mountSite>['window']

/** A stand-in for Shoelace's <sl-rating>: what the example relies on, and nothing else. */
function defineSlRating(win: Win) {
  const w = win as unknown as { HTMLElement: typeof HTMLElement; customElements: CustomElementRegistry; CustomEvent: typeof CustomEvent }
  if (w.customElements.get('sl-rating')) return
  w.customElements.define(
    'sl-rating',
    class extends w.HTMLElement {
      value = 0
      label = ''
      connectedCallback() {
        this.addEventListener('click', (e) => {
          const n = Number((e.target as Element).getAttribute?.('data-n'))
          if (!n) return
          this.value = n
          this.dispatchEvent(new w.CustomEvent('sl-change', { bubbles: true, composed: true }))
        })
      }
    },
  )
}

/** A stand-in for the Chart.js widget: a button per bar. */
const chart: Widget = {
  mount(element, inputs, emit) {
    let state: Record<string, unknown> = { ...inputs }
    const draw = () => {
      const bars = (state.bars as { id: string; label: string; value: number }[]) ?? []
      element.replaceChildren(
        ...bars.map((b) => {
          const button = element.ownerDocument.createElement('button')
          button.className = 'bar'
          button.textContent = `${b.label} ${b.value}`
          button.setAttribute('aria-pressed', String(b.id === state.selected))
          button.addEventListener('click', () => emit('select', { id: b.id, label: b.label }))
          return button
        }),
      )
    }
    draw()
    return { update: (changed) => ((state = { ...state, ...changed }), draw()), destroy: () => element.replaceChildren() }
  },
}

/** A stand-in for the Leaflet widget: a button per place, and one for "a click on the map at 1, 2". */
const map: Widget = {
  mount(element, inputs, emit) {
    let state: Record<string, unknown> = { ...inputs }
    const draw = () => {
      const places = (state.places as { id: string; label: string }[]) ?? []
      const doc = element.ownerDocument
      const markers = places.map((p) => {
        const button = doc.createElement('button')
        button.className = 'marker'
        button.textContent = p.label
        button.setAttribute('aria-pressed', String(p.id === state.selected))
        button.addEventListener('click', () => emit('select', { id: p.id }))
        return button
      })
      const ground = doc.createElement('button')
      ground.className = 'ground'
      ground.addEventListener('click', () => emit('place', { lat: 1.5, lng: 2 }))
      element.replaceChildren(...markers, ground)
    }
    draw()
    return { update: (changed) => ((state = { ...state, ...changed }), draw()), destroy: () => element.replaceChildren() }
  },
}

/** A stand-in for the flatpickr widget: a text input that reports a change as { date }. */
const date: Widget = {
  mount(element, inputs, emit) {
    const input = element.ownerDocument.createElement('input')
    input.className = 'date'
    input.value = String(inputs.value ?? '')
    input.addEventListener('change', () => emit('change', { date: input.value }))
    element.append(input)
    return { update: (changed) => void ('value' in changed && (input.value = String(changed.value ?? ''))), destroy: () => input.remove() }
  },
}

function tasting(prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountSite('oxigraph', prefer)
  const loaded: string[] = []
  const islands = new Islands(h.bus, h.shell, {
    modules: { 'shoelace/rating': async () => (loaded.push('shoelace/rating'), defineSlRating(h.window)) },
    widgets: { 'chart.js': chart, leaflet: map, flatpickr: date },
    onHandled: () => h.shell.flush(),
    onError: (e) => {
      throw e
    },
  })
  islands.attach()
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  const open = () => {
    click([...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Examples' && visible(b))!)
    click([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim().startsWith('Coffee tasting') && visible(b))!)
  }
  const root = () => h.shell.nodeOf(UI + 'ex-foreign/~root') as HTMLElement
  const bars = () => [...root().querySelectorAll('[data-sem-c=ex-fx-chart] .bar')].map((b) => `${b.textContent}${b.getAttribute('aria-pressed') === 'true' ? ' *' : ''}`)
  const rating = () => [...root().querySelectorAll('sl-rating')].find(visible) as (HTMLElement & { value: number; label: string }) | undefined
  const rate = (n: number) => {
    const star = h.document.createElement('span')
    star.setAttribute('data-n', String(n))
    rating()!.append(star)
    click(star)
  }
  const f = h.store.factory
  const ratingOf = (coffee: string) => h.store.match(f.namedNode(CF + coffee), f.namedNode(CF + 'rating'), null)[0]?.object.value
  const chosen = () => h.store.match(f.namedNode(CF + 'tasting'), f.namedNode(CF + 'chosen'), null)[0]?.object.value.slice(CF.length)
  return { ...h, islands, loaded, open, root, bars, rating, rate, click, ratingOf, chosen }
}

describe('the coffee tasting example', () => {
  it('loads nothing until it is shown, then mounts the chart and the chosen coffee’s rating', async () => {
    const h = tasting()
    expect(h.islands.size).toBe(0)
    expect(h.loaded).toEqual([])
    h.open()
    await h.islands.settled()
    expect(h.loaded).toEqual(['shoelace/rating'])
    expect(h.bars()).toEqual(['Yirgacheffe 4 *', 'Huila 3', 'Nyeri 5', 'Mandheling 2'])
    expect(h.rating()!.value).toBe(4)
    expect(h.rating()!.label).toBe('Yirgacheffe')
  })

  it.each(['sparql', 'function'] as const)('a rating is the coffee’s, and the chart follows it (%s)', async (prefer) => {
    const h = tasting(prefer)
    h.open()
    await h.islands.settled()
    h.rate(2)
    expect(h.ratingOf('eth')).toBe('2')
    expect(h.bars()[0]).toBe('Yirgacheffe 2 *')
    expect(h.rating()!.value).toBe(2)
    h.rate(5)
    expect(h.ratingOf('eth')).toBe('5')
    expect(h.bars()[0]).toBe('Yirgacheffe 5 *')
  })

  it('choosing a bar points the card - and the same rating element - at that coffee', async () => {
    const h = tasting()
    h.open()
    await h.islands.settled()
    const element = h.rating()
    h.click([...h.root().querySelectorAll('.bar')].find((b) => b.textContent!.startsWith('Nyeri'))!)
    expect(h.chosen()).toBe('ken')
    await h.islands.settled()
    expect(h.bars()).toEqual(['Yirgacheffe 4', 'Huila 3', 'Nyeri 5 *', 'Mandheling 2'])
    expect(h.rating()).toBe(element)
    expect(h.rating()!.label).toBe('Nyeri')
    expect(h.rating()!.value).toBe(5)
    expect(h.islands.counts.mounts).toBe(2)
    expect(h.loaded).toEqual(['shoelace/rating'])
    h.rate(3)
    expect(h.ratingOf('ken')).toBe('3')
    expect(h.ratingOf('eth')).toBe('4')
    expect(h.bars()[2]).toBe('Nyeri 3 *')
  })

  it('native components follow the rating: an alert at no stars, another at five, the average, the triples', async () => {
    const h = tasting()
    h.open()
    await h.islands.settled()
    const alerts = () => [...h.root().querySelectorAll('[data-sem-c=alert]')].filter((a) => !a.closest('[hidden]')).map((a) => a.querySelector('.sem-title, strong, b')?.textContent ?? a.textContent)
    const average = () => h.root().querySelector('[data-sem-c=stat]')!.textContent
    const triples = () => [...h.root().querySelectorAll('[data-sem-c=triples-view]')][0]!.textContent!
    expect(alerts()).toEqual([])
    expect(average()).toContain('3.5')
    h.rate(5)
    expect(alerts().join()).toContain('Top marks')
    expect(average()).toContain('3.8')
    expect(triples()).toContain('cf:rating 5')
  })

  it('a coffee added with native components gets a bar, counts in the average, and the rating turns to it', async () => {
    const h = tasting()
    h.open()
    await h.islands.settled()
    const field = h.root().querySelector('[data-sem-c=text-field] input') as HTMLInputElement
    field.value = 'Guji'
    h.fire(field, 'input')
    h.shell.flush()
    h.click([...h.root().querySelectorAll('button')].find((b) => b.textContent === 'Add to the tasting')!)
    expect(h.bars()).toEqual(['Yirgacheffe 4', 'Huila 3', 'Nyeri 5', 'Mandheling 2', 'Guji 0 *'])
    expect(h.rating()!.label).toBe('Guji')
    expect(h.rating()!.value).toBe(0)
    expect([...h.root().querySelectorAll('[data-sem-c=alert]')].filter((a) => !a.closest('[hidden]')).map((a) => a.textContent).join()).toContain('Not rated yet')
    expect(h.root().querySelector('[data-sem-c=stat]')!.textContent).toContain('2.8')
    h.rate(4)
    expect(h.bars()[4]).toBe('Guji 4 *')
    expect(field.value).toBe('')
  })

  it('the map chooses a coffee by its marker, places one without an origin, and the date is the graph’s', async () => {
    const h = tasting()
    h.open()
    await h.islands.settled()
    const markers = () => [...h.root().querySelectorAll('[data-sem-c=ex-fx-map] .marker')].map((m) => `${m.textContent}${m.getAttribute('aria-pressed') === 'true' ? ' *' : ''}`)
    expect(markers()).toEqual(['Yirgacheffe *', 'Huila', 'Nyeri', 'Mandheling'])
    h.click([...h.root().querySelectorAll('.marker')].find((m) => m.textContent === 'Huila')!)
    expect(h.chosen()).toBe('col')
    expect(h.bars()[1]).toBe('Huila 3 *')
    // A new coffee has no origin: no marker, until the map's click places it.
    const field = h.root().querySelector('[data-sem-c=text-field] input') as HTMLInputElement
    field.value = 'Guji'
    h.fire(field, 'input')
    h.shell.flush()
    h.click([...h.root().querySelectorAll('button')].find((b) => b.textContent === 'Add to the tasting')!)
    expect(markers()).toHaveLength(4)
    h.click(h.root().querySelector('[data-sem-c=ex-fx-map] .ground')!)
    expect(markers()).toEqual(['Yirgacheffe', 'Huila', 'Nyeri', 'Mandheling', 'Guji *'])
    // The date field shows the chosen coffee's date, and a change is the coffee's.
    const input = () => h.root().querySelector('[data-sem-c=ex-fx-date] input.date') as HTMLInputElement
    expect(input().value).toBe('')
    input().value = '2026-10-25'
    h.fire(input(), 'change')
    const f = h.store.factory
    const guji = h.store.match(f.namedNode(CF + 'tasting'), f.namedNode(CF + 'chosen'), null)[0]!.object
    expect(h.store.match(guji as never, f.namedNode(CF + 'tasted'), null)[0]?.object.value).toBe('2026-10-25')
    expect(h.store.match(guji as never, f.namedNode(CF + 'lat'), null)[0]?.object.value).toBe('1.5')
    h.click([...h.root().querySelectorAll('.marker')].find((m) => m.textContent === 'Yirgacheffe')!)
    expect(input().value).toBe('2026-10-18')
  })

  it('records ratings and choices in the change log, and announces a rating', async () => {
    const h = tasting()
    h.open()
    await h.islands.settled()
    h.rate(1)
    const f = h.store.factory
    const rated = h.store.match(null, f.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), f.namedNode(UI + 'FxRated'))
    expect(rated.length).toBe(1)
    expect([...h.document.querySelectorAll('[data-sem-c=toast]')].map((t) => t.textContent).join(' | ')).toContain('Rating saved')
  })
})
