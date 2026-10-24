// The shared agenda example (demo/gallery/_ex-collab.ttl) on a c:Outline: two scripted peers and
// you editing one outline, presence as graph state, conflicts resolved in the graph, every change
// an attributed edit in the history, and a slider that replays it - driven through events and time.
import { describe, expect, it } from 'vitest'
import { ManualClock } from '../src/behaviour/clock.ts'
import { mountSite } from './harness.ts'
import { implementationGaps } from './implementations.ts'
import { A11Y, MOD, NS, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'

const UI = 'https://semblance.dev/demo#'
const CO = 'https://semblance.dev/demo/collab#'
const DOC = UI + 'ex-collab-doc'

function agenda(prefer: 'sparql' | 'function' = 'sparql', grow = 0) {
  const clock = new ManualClock()
  const h = mountSite('oxigraph', prefer, clock)
  if (grow) {
    // An older history: edits of a point no longer on the agenda.
    const f = h.store.factory
    const nn = (s: string) => f.namedNode(s)
    const int = (n: number) => f.literal(String(n), nn(NS.xsd + 'integer'))
    const add = []
    for (let i = 1; i <= grow; i++) {
      const e = nn(`${CO}old-${i}`)
      add.push(f.quad(nn(CO + 'history'), nn('https://w3id.org/tree#member'), e), f.quad(e, nn(NS.rdf + 'type'), nn(CO + 'Edit')), f.quad(e, nn(CO + 'seq'), int(-i)),
        f.quad(e, nn(CO + 'on'), nn(CO + 'archived')), f.quad(e, nn(CO + 'kind'), nn(CO + 'Rewrote')), f.quad(e, nn(CO + 'text'), f.literal(`Old ${i}`)), f.quad(e, nn(NS.prov + 'wasAttributedTo'), nn(CO + 'ada')))
    }
    h.runtime.apply({ add, remove: [] })
    h.shell.flush()
  }
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => (b.textContent!.trim() === text || b.getAttribute('aria-label') === text) && visible(b))!
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  click(button('Examples'))
  click(navItem('Shared agenda'))
  const root = () => h.shell.nodeOf(UI + 'ex-collab/~root') as Element
  const items = () => [...root().querySelectorAll('[data-sem-c=outline-item]')] as HTMLElement[]
  const item = (text: string) => items().find((i) => i.querySelector('.sem-text')!.textContent!.startsWith(text))!
  /** A point as one line: who is on it (* typing), its text, its note, its flag. */
  const line = (i: HTMLElement) => {
    const who = [...i.querySelectorAll('.sem-who')].map((w) => w.querySelector('[data-sem-c=avatar]')!.getAttribute('aria-label') + (w.classList.contains('sem-typing') ? '*' : ''))
    const flag = i.querySelector('.sem-flag')?.textContent
    return `${who.length ? `[${who.join(', ')}] ` : ''}${i.querySelector('.sem-text')!.textContent} (${i.querySelector('.sem-note')?.textContent})${flag ? ' ⚠ ' + flag : ''}`
  }
  const lines = () => items().map(line)
  const advance = (ms: number) => (clock.advance(ms), h.shell.flush())
  const tables = () => [...root().querySelectorAll('[data-sem-c=table]')]
  const rows = (t: number) => [...tables()[t]!.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td, th')].map((c) => c.textContent!.trim()).join(' | '))
  const alert = () => root().querySelector('[data-sem-c=alert]')!
  const field = () => root().querySelector('[data-sem-c=text-field] input') as HTMLInputElement
  const type = (text: string) => {
    field().value = text
    h.fire(field(), 'input')
    h.shell.flush()
  }
  const value = (s: string, p: string) => h.store.match(h.store.factory.namedNode(s), h.store.factory.namedNode(p), null).map((q) => q.object.value)
  const slider = () => root().querySelector('[data-sem-c=slider] input') as HTMLInputElement
  return { ...h, clock, click, button, root, items, item, line, lines, advance, tables, rows, alert, field, type, value, slider }
}

describe('the shared agenda example', () => {
  it('has SPARQL and function implementations of the outline', () => {
    expect(implementationGaps(['components/outline.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })

  it('shows the agenda as an outline, and its history', () => {
    const h = agenda()
    expect(h.lines()).toEqual([
      'Welcome and goals (Ada Lovelace, step 1)', 'Review last quarter (Grace Hopper, step 2)', 'Revenue and churn (Tim Berners-Lee, step 3)',
      'Roadmap for spring (Ada Lovelace, step 4)', 'Hiring plan (Grace Hopper, step 5)', 'Dinner at seven (Tim Berners-Lee, step 6)',
    ])
    expect(h.root().querySelector('[data-sem-c=outline]')!.getAttribute('role')).toBe('list')
    expect(h.item('Revenue').getAttribute('style')).toBe('--sem-level: 1')
    expect(h.item('Revenue').getAttribute('role')).toBe('listitem')
    expect(h.item('Revenue').querySelector('button.sem-text')!.getAttribute('aria-pressed')).toBe('false')
    expect(h.alert().textContent).toContain('Step 6 of 6: Tim Berners-Lee added “Dinner at seven”.')
    expect(h.rows(1)[0]).toBe('6 | Tim Berners-Lee | added | Dinner at seven | ')
    expect(h.rows(0)).toHaveLength(6)
  })

  it('plays Grace and Tim on a schedule: presence, typing, and a conflict the graph resolves', () => {
    const h = agenda()
    h.advance(0) // both scripts are long due: they start as soon as the agenda is shown
    expect(h.line(h.item('Revenue'))).toBe('[Grace Hopper*] Revenue and churn (Tim Berners-Lee, step 3)')
    expect(h.line(h.item('Welcome'))).toBe('[Tim Berners-Lee] Welcome and goals (Ada Lovelace, step 1)')
    expect(h.item('Revenue').classList.contains('sem-busy')).toBe(true)
    expect(h.item('Revenue').querySelector('.sem-typing .sem-visually-hidden')!.textContent).toBe(' is typing')
    h.advance(1500) // Tim goes to point 3 too, to write it
    expect(h.line(h.item('Revenue'))).toBe('[Grace Hopper*, Tim Berners-Lee*] Revenue and churn (Tim Berners-Lee, step 3)')
    h.advance(1500) // Tim writes first
    expect(h.line(h.item('Revenue'))).toBe('[Grace Hopper*, Tim Berners-Lee] Revenue and churn, by region (Tim Berners-Lee, step 7)')
    expect(h.value(CO + 'edit-7', NS.prov + 'wasAttributedTo')).toEqual([CO + 'tim'])
    h.advance(1500) // Grace writes, never having seen Tim's version: hers wins, and his is kept
    expect(h.line(h.item('Revenue'))).toBe("[Grace Hopper, Tim Berners-Lee] Revenue, churn and the pricing test (Grace Hopper, step 8) ⚠ Grace Hopper wrote over Tim Berners-Lee's “Revenue and churn, by region” (step 7) without having seen it")
    expect(h.item('Revenue').classList.contains('sem-flagged')).toBe(true)
    expect(h.value(CO + 'edit-8', CO + 'overwrote')).toEqual([CO + 'edit-7'])
    expect(h.value(CO + 'edit-8', CO + 'basedOn')).toEqual(['3'])
    expect(h.alert().getAttribute('data-sem-tone')).toBe('warning')
    expect(h.alert().textContent).toContain('Step 8 of 8: Grace Hopper rewrote “Revenue, churn and the pricing test” - over step 7 by Tim Berners-Lee, which Grace Hopper had not seen.')
    expect(h.rows(1)[0]).toBe('8 | Grace Hopper | rewrote | Revenue, churn and the pricing test | step 7 (Tim Berners-Lee)')
    // The rest of the scripts: Tim at dinner, Grace on the roadmap, Tim adds a point, both leave.
    h.advance(10_000)
    expect(h.lines()).toEqual([
      'Welcome and goals (Ada Lovelace, step 1)', 'Review last quarter (Grace Hopper, step 2)',
      "Revenue, churn and the pricing test (Grace Hopper, step 8) ⚠ Grace Hopper wrote over Tim Berners-Lee's “Revenue and churn, by region” (step 7) without having seen it",
      'Roadmap for spring: two bets, one owner each (Grace Hopper, step 10)', 'Hiring plan (Grace Hopper, step 5)',
      'Offsite budget (Tim Berners-Lee, step 11)', 'Dinner at seven, at Nopi (Tim Berners-Lee, step 9)',
    ])
    expect(h.item('Offsite').getAttribute('style')).toBe('--sem-level: 1')
    expect(h.rows(1)).toHaveLength(11)
  })

  it('replays the history: a step back is the agenda as it was, and following live jumps to the latest', () => {
    const h = agenda()
    h.advance(0)
    h.advance(4500)
    expect(h.slider().value).toBe('8')
    h.click(h.button('One step back'))
    expect(h.value(CO + 'replay', CO + 'live')).toEqual(['false'])
    expect(h.alert().textContent).toContain('Step 7 of 8: Tim Berners-Lee rewrote “Revenue and churn, by region”.')
    expect(h.rows(0)[2]).toBe('Revenue and churn, by region | Tim Berners-Lee | 7')
    expect(h.rows(1)).toHaveLength(7)
    h.click(h.button('One step back'))
    expect(h.rows(0)[2]).toBe('Revenue and churn | Tim Berners-Lee | 3')
    // While looking back, new steps do not move the slider.
    h.advance(3000)
    expect(h.value(CO + 'doc', CO + 'seq')).toEqual(['9'])
    expect(h.slider().value).toBe('6')
    // Dragging the slider (an input event) to the very beginning.
    h.slider().value = '0'
    h.fire(h.slider(), 'input')
    h.shell.flush()
    expect(h.alert().textContent).toContain('Before the first step: an empty page.')
    expect(h.rows(0)).toEqual(['Nothing written yet.'])
    h.click(h.button('One step forward'))
    expect(h.rows(0)).toEqual(['Welcome and goals | Ada Lovelace | 1'])
    // Following live again: straight to the latest step, and on with every new one.
    h.click(h.root().querySelector('[data-sem-c=toggle-switch] button, [data-sem-c=toggle-switch] [role=switch]')!)
    expect(h.value(CO + 'replay', CO + 'live')).toEqual(['true'])
    expect(h.slider().value).toBe('9')
    h.advance(2000)
    expect(h.slider().value).toBe('10')
  })

  it('lets you pick a point and rewrite it - resolving the flag, or writing over a peer unseen', () => {
    const h = agenda()
    h.advance(0)
    h.advance(4500) // point 3 is flagged now
    h.click(h.item('Revenue').querySelector('button.sem-text')!)
    expect(h.value(CO + 'ada', CO + 'cursor')).toEqual([CO + 'p3'])
    expect(h.item('Revenue').querySelector('button.sem-text')!.getAttribute('aria-pressed')).toBe('true')
    expect(h.line(h.item('Revenue'))).toMatch(/^\[Ada Lovelace\*, Grace Hopper, Tim Berners-Lee\] Revenue, churn and the pricing test/)
    expect(h.field().value).toBe('Revenue, churn and the pricing test')
    h.type('Revenue and churn by region, and the pricing test')
    h.click(h.button('Save'))
    // Ada had seen step 8: no conflict, and the flag is gone - the merge resolved it.
    expect(h.line(h.item('Revenue'))).toBe('[Ada Lovelace, Grace Hopper, Tim Berners-Lee] Revenue and churn by region, and the pricing test (Ada Lovelace, step 9)')
    expect(h.value(CO + 'edit-9', NS.prov + 'wasAttributedTo')).toEqual([CO + 'ada'])
    expect(h.value(CO + 'edit-9', CO + 'overwrote')).toEqual([])
    // Now pick the dinner, which Tim is about to write, and save after he has.
    h.advance(1000) // Tim is on the dinner (step 5.5 s)
    h.click(h.item('Dinner').querySelector('button.sem-text')!)
    h.type('Dinner at eight')
    h.advance(2000) // Tim writes it (7.5 s)
    expect(h.value(CO + 'p6', CO + 'text')).toEqual(['Dinner at seven, at Nopi'])
    h.click(h.button('Save'))
    expect(h.line(h.item('Dinner'))).toBe("[Ada Lovelace, Tim Berners-Lee] Dinner at eight (Ada Lovelace, step 11) ⚠ Ada Lovelace wrote over Tim Berners-Lee's “Dinner at seven, at Nopi” (step 10) without having seen it")
  })

  it('renders the same with SPARQL and with function rules, as the scripts play and you write', () => {
    const [a, b] = [agenda('sparql'), agenda('function')]
    const html = (h: typeof a) => h.root().innerHTML
    expect(html(b)).toBe(html(a))
    for (const ms of [0, 1500, 1500, 1500]) {
      for (const h of [a, b]) h.advance(ms)
      expect(html(b)).toBe(html(a))
    }
    for (const h of [a, b]) h.click(h.item('Revenue').querySelector('button.sem-text')!)
    expect(html(b)).toBe(html(a))
    for (const h of [a, b]) h.click(h.button('One step back'))
    expect(html(b)).toBe(html(a))
  }, 120_000)

  it('draws the outline as text too', () => {
    for (const prefer of ['sparql', 'function'] as const) {
      const h = agenda(prefer)
      const text = h.runtime.project({ modality: MOD.Text, prefer, name: 'text-outline', roots: [DOC] })
      expect(toText(text.index, DOC).split('\n').filter(Boolean)).toEqual([
        '- Welcome and goals (Ada Lovelace, step 1)', '- Review last quarter (Grace Hopper, step 2)', '  - Revenue and churn (Tim Berners-Lee, step 3)',
        '- Roadmap for spring (Ada Lovelace, step 4)', '  - Hiring plan (Grace Hopper, step 5)', '- Dinner at seven (Tim Berners-Lee, step 6)',
      ])
    }
  })
})

describe('a step of the agenda costs what it changes', () => {
  it('the outline does the same work after six edits as after three hundred more', () => {
    const measure = (grow: number) => {
      const h = agenda('sparql', grow)
      const outline = h.runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer], prefer: 'sparql', name: 'outline', roots: [DOC] })
      const renderer = new DomRenderer(outline.index, h.document.createElement('div'), DOC)
      renderer.flush()
      const snap = () => ({ ruleRuns: h.screen.engine.stats.ruleRuns, outlineRuns: outline.engine.stats.ruleRuns, outlineOps: renderer.ops })
      const steps: ReturnType<typeof snap>[] = []
      for (const ms of [0, 1500, 1500, 1500]) {
        const a = snap()
        h.advance(ms)
        renderer.flush()
        const b = snap()
        steps.push({ ruleRuns: b.ruleRuns - a.ruleRuns, outlineRuns: b.outlineRuns - a.outlineRuns, outlineOps: b.outlineOps - a.outlineOps })
      }
      return steps
    }
    const small = measure(0)
    const large = measure(300)
    expect(large).toEqual(small)
    console.info('[agenda cost]', JSON.stringify(small))
  }, 120_000)
})
