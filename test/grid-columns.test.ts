import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { key, showGrids } from './grid-harness.ts'

// The data grid's columns, filters and keys, its waterfall and the time axis (the Data gallery
// page, demo/gallery/_dt-grid.ttl). Its rows, sorting, selection and paging: test/grid.test.ts.

const UI = 'https://semblance.dev/demo#'

for (const prefer of ['sparql', 'function'] as const) {
  describe(`data grid columns and time scale (${prefer})`, () => {
      it('filters by text, by value and by a flag, through ordinary controls', () => {
        const h = showGrids(prefer)
        const { rows, part, root, values } = h
        const search = root('dt-grid-filterText').querySelector('input')!
        search.value = 'fetch'
        h.fire(search, 'input')
        h.shell.flush()
        expect(values('dt-grid-search', 'filterText')).toEqual(['fetch'])
        expect(rows('dt-grid-logGrid').map((r) => r.split(/\s+/)[0])).toEqual(['7', '8', '9'])
        expect(part('dt-grid-logGrid', 'status')!.textContent).toBe('3 matching · showing 1–3')
        search.value = ''
        h.fire(search, 'input')
        h.shell.flush()
        const select = root('dt-grid-filterLevel').querySelector('select')!
        // linkedom's <select> has no value setter: the chosen option's value, as the browser reports it.
        Object.defineProperty(select, 'value', { value: UI + 'LevelWarning', configurable: true })
        h.fire(select, 'change')
        h.shell.flush()
        expect(rows('dt-grid-logGrid').map((r) => r.split(/\s+/)[0])).toEqual(['4', '10'])
        Object.defineProperty(select, 'value', { value: NS.c + 'AnyValue', configurable: true })
        h.fire(select, 'change')
        h.shell.flush()
        // Debug lines off: the flag filter excludes them.
        h.click(root('dt-grid-filterDebug').querySelector('button')!)
        expect(values('dt-grid-debug', 'included')).toEqual(['false'])
        expect(rows('dt-grid-logGrid').some((r) => r.includes('Debug'))).toBe(false)
        expect(part('dt-grid-logGrid', 'status')!.textContent).toBe('9 matching · showing 2–9')
        // Nothing matches: the empty text.
        search.value = 'no such line'
        h.fire(search, 'input')
        h.shell.flush()
        expect(part('dt-grid-logGrid', 'empty-cell')!.textContent).toBe('No log lines match the filters.')
        expect(part('dt-grid-logGrid', 'empty-cell')!.getAttribute('colspan')).toBe('4')
      })

      it('shows the columns c:shows names (the chips are its display preferences)', () => {
        const { root, part, click, values } = showGrids(prefer)
        const chip = [...root('dt-grid-columns').querySelectorAll('button')].find((b) => b.textContent === 'Source')!
        click(chip)
        expect(values('dt-grid-logGrid', 'shows')).not.toContain(UI + 'dt-grid-col-source')
        const grid = root('dt-grid-logGrid')
        expect([...grid.querySelectorAll('thead th')].map((th) => th.textContent!.replace(/[↕↑↓]/g, ''))).toEqual(['#', 'Level', 'Message'])
        expect([...grid.querySelectorAll('tbody > tr:first-child > td')]).toHaveLength(3)
        click(chip)
        expect([...grid.querySelectorAll('thead th')].map((th) => th.textContent!.replace(/[↕↑↓]/g, ''))).toEqual(['#', 'Level', 'Source', 'Message'])
        expect(part('dt-grid-logGrid', `h-${key(UI + 'dt-grid-col-source')}`)).not.toBeNull()
      })

      it('resizes a column by its header edge, by pointer or keys', () => {
        const h = showGrids(prefer)
        const { part, values } = h
        const handle = part('dt-grid-logGrid', `h-${key(UI + 'dt-grid-col-source')}-resize`)!
        expect(handle.getAttribute('role')).toBe('separator')
        expect(handle.getAttribute('aria-valuenow')).toBe('120')
        handle.dispatchEvent(new h.window.CustomEvent('sem-size', { bubbles: true, detail: { size: 200, extent: 900 } }))
        h.shell.flush()
        expect(values('dt-grid-col-source', 'width')).toEqual(['200'])
        expect(part('dt-grid-logGrid', `h-${key(UI + 'dt-grid-col-source')}`)!.getAttribute('style')).toBe('width: 200px')
        expect(part('dt-grid-logGrid', `h-${key(UI + 'dt-grid-col-source')}-resize`)!.getAttribute('aria-valuenow')).toBe('200')
        // Arrow keys on the focused separator: a step from its measured width.
        const th = part('dt-grid-logGrid', `h-${key(UI + 'dt-grid-col-source')}`)!
        ;(th as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ width: 200, height: 30 })
        const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as Event & { key: string }
        Object.defineProperty(e, 'key', { value: 'ArrowLeft' })
        part('dt-grid-logGrid', `h-${key(UI + 'dt-grid-col-source')}-resize`)!.dispatchEvent(e)
        h.shell.flush()
        expect(values('dt-grid-col-source', 'width')).toEqual(['184'])
        // Never narrower than 48px.
        part('dt-grid-logGrid', `h-${key(UI + 'dt-grid-col-source')}-resize`)!.dispatchEvent(new h.window.CustomEvent('sem-size', { bubbles: true, detail: { size: 10, extent: 900 } }))
        h.shell.flush()
        expect(values('dt-grid-col-source', 'width')).toEqual(['48'])
      })

      it('moves the selection with arrow keys (focusing a row selects it)', () => {
        const h = showGrids(prefer)
        const { root, values } = h
        const grid = root('dt-grid-logGrid')
        const first = grid.querySelector('tbody > tr')! as HTMLElement
        first.focus?.()
        const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as Event & { key: string }
        Object.defineProperty(e, 'key', { value: 'ArrowDown' })
        first.dispatchEvent(e)
        h.shell.flush()
        expect(values('dt-grid-logGrid', 'selectedRow')).toEqual([UI + 'log-6'])
        expect(grid.querySelector('tr[aria-selected=true]')!.textContent).toMatch(/^6/)
      })

      it('draws a waterfall: bars on the scale of the rows shown, open spans to its end', () => {
        const { root } = showGrids(prefer)
        const grid = root('dt-grid-traceGrid')
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
        expect([...root('dt-grid-axis-short').querySelectorAll('.sem-tick')].map((t) => t.textContent)).toEqual(['0 ms', '50 ms', '100 ms', '150 ms'])
        expect([...root('dt-grid-axis-long').querySelectorAll('.sem-tick')].map((t) => t.textContent)).toEqual(['0 ms', '2 s', '4 s', '6 s', '8 s'])
      })
  })
}
