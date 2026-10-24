import { describe, expect, it } from 'vitest'
import { md5Key } from '../src/components/data.ts'
import { NETWORK_GRAPH, NS } from '../src/ns.ts'
import { mountShell } from './harness.ts'
import { expectSameRendering, implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const c = NS.c
/** A column's key in the IRIs the grid mints for it. */
const key = (iri: string) => md5Key(iri)

/** The shell on the Components page, showing the Inspection gallery group. */
function showGrids(prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountShell(5, 'oxigraph', prefer)
  const f = h.store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  h.showPage('Components')
  h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupInspection'))] })
  h.shell.flush()
  const node = (iri: string) => ([...h.document.querySelectorAll('*')].find((el) => h.shell.keyOf(el) === iri) ?? null) as HTMLElement | null
  const root = (local: string) => node(`${UI}${local}/~root`)!
  const part = (local: string, name: string) => node(`${UI}${local}/~${name}`)
  const values = (s: string, p: string) => h.store.match(f.namedNode(s.startsWith('http') ? s : UI + s), f.namedNode(p.startsWith('http') ? p : c + p), null).map((q) => q.object.value)
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  /** The grid's rows, top to bottom, as their first cells' text. */
  const rows = (grid: string) => [...root(grid).querySelectorAll('tbody > tr[role=row]')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent).join(' '))
  return { ...h, f, node, root, part, values, click, rows }
}

describe('data grid', () => {
  it('has both implementations, and they render the same', () => {
    expect(implementationGaps(['components/grid.ttl'])).toEqual({ noSparql: [], noFunction: [] })
    expectSameRendering(['GroupInspection'])
  })

  for (const prefer of ['sparql', 'function'] as const) {
    describe(`(${prefer})`, () => {
      it('shows the newest page of members in capture order', () => {
        const h = showGrids(prefer)
        const { root, rows, part } = h
        const grid = root('in-grid-logGrid')
        expect(grid.getAttribute('data-sem-c')).toBe('data-grid')
        expect(grid.querySelector('table')!.getAttribute('role')).toBe('grid')
        const shown = rows('in-grid-logGrid')
        expect(shown).toHaveLength(8)
        expect(shown[0]).toMatch(/^5/)
        expect(shown[7]).toMatch(/^12/)
        expect(part('in-grid-logGrid', 'status')!.textContent).toBe('12 matching · showing 5–12')
        // The specimens conform to the component shapes.
        const invalid = h.store.match(null, h.f.namedNode('http://www.w3.org/ns/shacl#focusNode'), null).map((q) => q.object.value).filter((v) => v.includes('in-grid'))
        expect(invalid).toEqual([])
        expect(part('in-grid-logGrid', 'older')!.hasAttribute('disabled')).toBe(false)
        expect(part('in-grid-logGrid', 'newer')!.hasAttribute('disabled')).toBe(true)
        // The first row takes focus when Tab enters the grid; the others are reached with arrow keys.
        expect([...grid.querySelectorAll('tbody > tr')].map((tr) => tr.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1', '-1', '-1', '-1'])
      })

      it('sorts by a header, and reverses on a second click', () => {
        const { root, rows, part, click, values } = showGrids(prefer)
        const levelHead = part('in-grid-logGrid', `h-${key(UI + 'in-grid-col-level')}`)!
        click(levelHead.querySelector('button')!)
        expect(values('in-grid-logGrid', 'sortColumn')).toEqual([UI + 'in-grid-col-level'])
        expect(levelHead.getAttribute('aria-sort')).toBe('ascending')
        // By the levels' sem:order (debug, info, warning, error); ties keep capture order.
        expect(rows('in-grid-logGrid').map((r) => r.split(/\s+/)[1])).toEqual(['Debug', 'Debug', 'Info', 'Info', 'Info', 'Info', 'Warning', 'Error'])
        click(levelHead.querySelector('button')!)
        expect(root('in-grid-logGrid').querySelector('th[aria-sort]')!.getAttribute('aria-sort')).toBe('descending')
        expect(rows('in-grid-logGrid').map((r) => r.split(/\s+/)[1])).toEqual(['Error', 'Warning', 'Info', 'Info', 'Info', 'Info', 'Debug', 'Debug'])
        // A text column sorts as text.
        click(part('in-grid-logGrid', `h-${key(UI + 'in-grid-col-source')}`)!.querySelector('button')!)
        expect(rows('in-grid-logGrid').map((r) => r.split(/\s+/)[2])).toEqual(['dom', 'engine', 'engine', 'fetch', 'fetch', 'fetch', 'persistence', 'vite'])
      })

      it('selects a row (and pins the window); the selected row again deselects it', () => {
        const { root, click, values, rows, part } = showGrids(prefer)
        const grid = root('in-grid-logGrid')
        const row = () => [...grid.querySelectorAll('tbody > tr')].find((tr) => tr.textContent!.startsWith('7'))!
        click(row().querySelector('td:last-child')!)
        expect(values('in-grid-logGrid', 'selectedRow')).toEqual([UI + 'log-7'])
        expect(row().getAttribute('aria-selected')).toBe('true')
        expect(row().getAttribute('tabindex')).toBe('0')
        expect(grid.querySelectorAll('tr[aria-selected=true]')).toHaveLength(1)
        expect(values('in-grid-logGrid', 'followTail')).toEqual(['false'])
        expect(values('in-grid-logGrid', 'windowEnd').map(Number)).toEqual([12])
        expect(part('in-grid-logGrid', 'follow')!.getAttribute('aria-pressed')).toBe('false')
        expect(part('in-grid-logGrid', 'jump')!.textContent).toBe('0 new · Jump to latest')
        // The metrics beside the grid read the selection back.
        expect(root('in-grid-selected').textContent).toContain('log-7')
        click(row())
        expect(values('in-grid-logGrid', 'selectedRow')).toEqual([])
        expect(grid.querySelectorAll('tr[aria-selected=true]')).toHaveLength(0)
        expect(rows('in-grid-logGrid')).toHaveLength(8)
      })

      it('follows new members, or keeps a pinned window and counts what is new', () => {
        const h = showGrids(prefer)
        const { rows, part, click, values, f } = h
        const add = (n: number) => {
          const m = f.namedNode(UI + 'log-x' + n)
          h.runtime.apply({ remove: [], add: [
            f.quad(f.namedNode(UI + 'buildLog'), f.namedNode(NS.tree + 'member'), m),
            f.quad(m, f.namedNode(UI + 'line'), f.literal(String(n), f.namedNode(NS.xsd + 'integer'))),
            f.quad(m, f.namedNode(UI + 'level'), f.namedNode(UI + 'LevelInfo')),
            f.quad(m, f.namedNode(UI + 'message'), f.literal('line ' + n)),
          ] })
          h.shell.flush()
        }
        add(13)
        expect(rows('in-grid-logGrid')[7]).toMatch(/^13/)
        expect(part('in-grid-logGrid', 'status')!.textContent).toBe('13 matching · showing 6–13')
        // Pausing the follow pins the window where it is.
        click(part('in-grid-logGrid', 'follow')!)
        expect(values('in-grid-logGrid', 'followTail')).toEqual(['false'])
        add(14)
        add(15)
        expect(rows('in-grid-logGrid')[7]).toMatch(/^13/)
        expect(part('in-grid-logGrid', 'jump')!.textContent).toBe('2 new · Jump to latest')
        click(part('in-grid-logGrid', 'jump')!)
        expect(values('in-grid-logGrid', 'followTail')).toEqual(['true'])
        expect(values('in-grid-logGrid', 'windowEnd')).toEqual([])
        expect(rows('in-grid-logGrid')[7]).toMatch(/^15/)
      })

      it('pages older and newer over the matching members', () => {
        const { rows, part, click, values } = showGrids(prefer)
        click(part('in-grid-logGrid', 'older')!)
        expect(values('in-grid-logGrid', 'windowEnd').map(Number)).toEqual([4])
        expect(rows('in-grid-logGrid').map((r) => r.split(/\s+/)[0])).toEqual(['1', '2', '3', '4'])
        expect(part('in-grid-logGrid', 'status')!.textContent).toBe('12 matching · showing 1–4')
        expect(part('in-grid-logGrid', 'older')!.hasAttribute('disabled')).toBe(true)
        // The newer page reaches the newest: the grid follows again.
        click(part('in-grid-logGrid', 'newer')!)
        expect(values('in-grid-logGrid', 'followTail')).toEqual(['true'])
        expect(rows('in-grid-logGrid')).toHaveLength(8)
      })

      it('filters by text, by value and by a flag, through ordinary controls', () => {
        const h = showGrids(prefer)
        const { rows, part, root, values } = h
        const search = root('in-grid-filterText').querySelector('input')!
        search.value = 'fetch'
        h.fire(search, 'input')
        h.shell.flush()
        expect(values('in-grid-search', 'filterText')).toEqual(['fetch'])
        expect(rows('in-grid-logGrid').map((r) => r.split(/\s+/)[0])).toEqual(['7', '8', '9'])
        expect(part('in-grid-logGrid', 'status')!.textContent).toBe('3 matching · showing 1–3')
        search.value = ''
        h.fire(search, 'input')
        h.shell.flush()
        const select = root('in-grid-filterLevel').querySelector('select')!
        // linkedom's <select> has no value setter: the chosen option's value, as the browser reports it.
        Object.defineProperty(select, 'value', { value: UI + 'LevelWarning', configurable: true })
        h.fire(select, 'change')
        h.shell.flush()
        expect(rows('in-grid-logGrid').map((r) => r.split(/\s+/)[0])).toEqual(['4', '10'])
        Object.defineProperty(select, 'value', { value: NS.c + 'AnyValue', configurable: true })
        h.fire(select, 'change')
        h.shell.flush()
        // Debug lines off: the flag filter excludes them.
        h.click(root('in-grid-filterDebug').querySelector('button')!)
        expect(values('in-grid-debug', 'included')).toEqual(['false'])
        expect(rows('in-grid-logGrid').some((r) => r.includes('Debug'))).toBe(false)
        expect(part('in-grid-logGrid', 'status')!.textContent).toBe('9 matching · showing 2–9')
        // Nothing matches: the empty text.
        search.value = 'no such line'
        h.fire(search, 'input')
        h.shell.flush()
        expect(part('in-grid-logGrid', 'empty-cell')!.textContent).toBe('No log lines match the filters.')
        expect(part('in-grid-logGrid', 'empty-cell')!.getAttribute('colspan')).toBe('4')
      })

      it('shows the columns c:shows names (the chips are its display preferences)', () => {
        const { root, part, click, values } = showGrids(prefer)
        const chip = [...root('in-grid-columns').querySelectorAll('button')].find((b) => b.textContent === 'Source')!
        click(chip)
        expect(values('in-grid-logGrid', 'shows')).not.toContain(UI + 'in-grid-col-source')
        const grid = root('in-grid-logGrid')
        expect([...grid.querySelectorAll('thead th')].map((th) => th.textContent!.replace(/[↕↑↓]/g, ''))).toEqual(['#', 'Level', 'Message'])
        expect([...grid.querySelectorAll('tbody > tr:first-child > td')]).toHaveLength(3)
        click(chip)
        expect([...grid.querySelectorAll('thead th')].map((th) => th.textContent!.replace(/[↕↑↓]/g, ''))).toEqual(['#', 'Level', 'Source', 'Message'])
        expect(part('in-grid-logGrid', `h-${key(UI + 'in-grid-col-source')}`)).not.toBeNull()
      })

      it('resizes a column by its header edge, by pointer or keys', () => {
        const h = showGrids(prefer)
        const { part, values } = h
        const handle = part('in-grid-logGrid', `h-${key(UI + 'in-grid-col-source')}-resize`)!
        expect(handle.getAttribute('role')).toBe('separator')
        expect(handle.getAttribute('aria-valuenow')).toBe('120')
        handle.dispatchEvent(new h.window.CustomEvent('sem-size', { bubbles: true, detail: { size: 200, extent: 900 } }))
        h.shell.flush()
        expect(values('in-grid-col-source', 'width')).toEqual(['200'])
        expect(part('in-grid-logGrid', `h-${key(UI + 'in-grid-col-source')}`)!.getAttribute('style')).toBe('width: 200px')
        expect(part('in-grid-logGrid', `h-${key(UI + 'in-grid-col-source')}-resize`)!.getAttribute('aria-valuenow')).toBe('200')
        // Arrow keys on the focused separator: a step from its measured width.
        const th = part('in-grid-logGrid', `h-${key(UI + 'in-grid-col-source')}`)!
        ;(th as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ width: 200, height: 30 })
        const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as Event & { key: string }
        Object.defineProperty(e, 'key', { value: 'ArrowLeft' })
        part('in-grid-logGrid', `h-${key(UI + 'in-grid-col-source')}-resize`)!.dispatchEvent(e)
        h.shell.flush()
        expect(values('in-grid-col-source', 'width')).toEqual(['184'])
        // Never narrower than 48px.
        part('in-grid-logGrid', `h-${key(UI + 'in-grid-col-source')}-resize`)!.dispatchEvent(new h.window.CustomEvent('sem-size', { bubbles: true, detail: { size: 10, extent: 900 } }))
        h.shell.flush()
        expect(values('in-grid-col-source', 'width')).toEqual(['48'])
      })

      it('moves the selection with arrow keys (focusing a row selects it)', () => {
        const h = showGrids(prefer)
        const { root, values } = h
        const grid = root('in-grid-logGrid')
        const first = grid.querySelector('tbody > tr')! as HTMLElement
        first.focus?.()
        const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as Event & { key: string }
        Object.defineProperty(e, 'key', { value: 'ArrowDown' })
        first.dispatchEvent(e)
        h.shell.flush()
        expect(values('in-grid-logGrid', 'selectedRow')).toEqual([UI + 'log-6'])
        expect(grid.querySelector('tr[aria-selected=true]')!.textContent).toMatch(/^6/)
      })

      it('draws a waterfall: bars on the scale of the rows shown, open spans to its end', () => {
        const { root } = showGrids(prefer)
        const grid = root('in-grid-traceGrid')
        expect(grid.querySelector('tbody')!.getAttribute('style')).toBe('--scale-start: 0; --scale-end: 412')
        const bars = [...grid.querySelectorAll('.sem-bar')]
        expect(bars[1]!.getAttribute('style')).toBe('--from: 18; --to: 64; --bar: var(--sem-series-2)')
        expect(bars[1]!.getAttribute('aria-label')).toBe('from 18 ms for 46 ms')
        const open = bars.at(-1)!
        expect(open.getAttribute('class')).toBe('sem-bar sem-open')
        expect(open.getAttribute('aria-label')).toBe('from 408 ms, still running')
        expect([...grid.querySelectorAll('tbody td.sem-end')].map((td) => td.textContent)).toEqual(['412 ms', '46 ms', '29 ms', '291 ms', '33 ms', '7 ms', '…'])
        // The header's axis is on the same scale.
        const axis = grid.querySelector('[data-sem-c=time-axis]')!
        expect(axis.getAttribute('style')).toBe('--span: 412')
        expect([...axis.querySelectorAll('.sem-tick')].map((t) => t.textContent)).toEqual(['0 ms', '100 ms', '200 ms', '300 ms', '400 ms'])
      })

      it('a time axis on its own picks a 1-2-5 interval', () => {
        const { root } = showGrids(prefer)
        expect([...root('in-grid-axis-short').querySelectorAll('.sem-tick')].map((t) => t.textContent)).toEqual(['0 ms', '50 ms', '100 ms', '150 ms'])
        expect([...root('in-grid-axis-long').querySelectorAll('.sem-tick')].map((t) => t.textContent)).toEqual(['0 ms', '2 s', '4 s', '6 s', '8 s'])
      })
    })
  }
})

/** The site's Examples page, showing the network inspector (demo/gallery/_network.ttl). */
function showNetwork(prefer: 'sparql' | 'function') {
  const h = showGrids(prefer)
  const { f } = h
  const app = f.namedNode(UI + 'app')
  h.runtime.apply({
    remove: [...h.store.match(app, f.namedNode(UI + 'page'), null), ...h.store.match(app, f.namedNode(UI + 'example'), null)],
    add: [f.quad(app, f.namedNode(UI + 'page'), f.namedNode(UI + 'Examples')), f.quad(app, f.namedNode(UI + 'example'), f.namedNode(UI + 'ExNetwork'))],
  })
  h.shell.flush()
  return h
}

describe('the network inspector example', () => {
  it('renders the same with SPARQL and with functions', () => {
    const [a, b] = (['sparql', 'function'] as const).map((p) => showNetwork(p).root('net-inspector').outerHTML)
    if (a !== b) {
      let i = 0
      while (i < a!.length && a![i] === b![i]) i++
      expect(a!.slice(Math.max(0, i - 300), i + 300)).toBe(b!.slice(Math.max(0, i - 300), i + 300))
    }
  })

  for (const prefer of ['sparql', 'function'] as const) {
    it(`lists captured entries, filters them and shows the selected one's details (${prefer})`, () => {
      const h = showNetwork(prefer)
      const { root, rows, part, click, f } = h
      expect(rows('net-grid')).toHaveLength(18)
      expect(root('net-count').textContent).toContain('18')
      // The page's own activity arrives as members of net:Capture in the network graph.
      const g = f.namedNode(NETWORK_GRAPH)
      const e = f.namedNode('urn:semblance:net:test-1')
      h.runtime.write(NETWORK_GRAPH, {
        remove: [],
        add: [
          f.quad(f.namedNode(NS.net + 'Capture'), f.namedNode(NS.tree + 'member'), e, g),
          f.quad(e, f.namedNode(NS.rdf + 'type'), f.namedNode(NS.net + 'Event'), g),
          f.quad(e, f.namedNode(NS.net + 'kind'), f.namedNode(NS.net + 'EventKind'), g),
          f.quad(e, f.namedNode(NS.net + 'label'), f.literal('Pressed the button'), g),
          f.quad(e, f.namedNode(NS.net + 'sequence'), f.literal('1', f.namedNode(NS.xsd + 'integer')), g),
          f.quad(e, f.namedNode(NS.net + 'startedAt'), f.literal('6000', f.namedNode(NS.xsd + 'double')), g),
          f.quad(e, f.namedNode(NS.net + 'status'), f.namedNode(NS.net + 'Recorded'), g),
          f.quad(e, f.namedNode(NS.net + 'data'), f.literal('{"button":"save"}'), g),
        ],
      })
      h.shell.flush()
      expect(rows('net-grid').at(-1)).toContain('Pressed the button')
      // The earlier visit's samples hide with their switch.
      click(root('net-filter-samples').querySelector('button')!)
      expect(rows('net-grid')).toHaveLength(1)
      click(root('net-filter-samples').querySelector('button')!)
      // Select the failed request: its summary, response and body follow the selection.
      const failed = [...root('net-grid').querySelectorAll('tbody > tr')].find((tr) => tr.textContent!.includes('Failed'))!
      click(failed.querySelector('td')!)
      expect(root('net-summary').textContent).toContain('https://example.org/api/stats')
      expect(root('net-response').textContent).toContain('503')
      expect(root('net-response-body').textContent).toContain('unavailable')
      // Deselect (a c:Unsetter) clears it.
      click(root('net-deselect').querySelector('button') ?? root('net-deselect'))
      expect(h.store.match(f.namedNode(UI + 'net-grid'), f.namedNode(NS.c + 'selectedRow'), null)).toHaveLength(0)
      expect(root('net-summary').textContent).toBe('Select a request, message or event to inspect it.')
      expect(part('net-grid', 'status')!.textContent).toBe('19 matching · showing 1–19')
    })
  }
})
