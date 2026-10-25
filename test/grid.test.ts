import { describe, expect, it } from 'vitest'
import { md5Key } from '../src/components/data.ts'
import { NETWORK_GRAPH, NS } from '../src/ns.ts'
import { showGrids } from './grid-harness.ts'
import { expectSameRendering, implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const c = NS.c
/** A column's key in the IRIs the grid mints for it. */
const key = (iri: string) => md5Key(iri)

describe('data grid', () => {
  it('has both implementations, and they render the same', () => {
    expect(implementationGaps(['components/grid.ttl'])).toEqual({ noSparql: [], noFunction: [] })
    expectSameRendering(['GroupData'])
  })

  for (const prefer of ['sparql', 'function'] as const) {
    describe(`(${prefer})`, () => {
      it('shows the newest page of members in capture order', () => {
        const h = showGrids(prefer)
        const { root, rows, part } = h
        const grid = root('dt-grid-logGrid')
        expect(grid.getAttribute('data-sem-c')).toBe('data-grid')
        expect(grid.querySelector('table')!.getAttribute('role')).toBe('grid')
        const shown = rows('dt-grid-logGrid')
        expect(shown).toHaveLength(8)
        expect(shown[0]).toMatch(/^5/)
        expect(shown[7]).toMatch(/^12/)
        expect(part('dt-grid-logGrid', 'status')!.textContent).toBe('12 matching · showing 5–12')
        // The specimens conform to the component shapes.
        const invalid = h.store.match(null, h.f.namedNode('http://www.w3.org/ns/shacl#focusNode'), null).map((q) => q.object.value).filter((v) => v.includes('dt-grid'))
        expect(invalid).toEqual([])
        expect(part('dt-grid-logGrid', 'older')!.hasAttribute('disabled')).toBe(false)
        expect(part('dt-grid-logGrid', 'newer')!.hasAttribute('disabled')).toBe(true)
        // The first row takes focus when Tab enters the grid; the others are reached with arrow keys.
        expect([...grid.querySelectorAll('tbody > tr')].map((tr) => tr.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1', '-1', '-1', '-1'])
      })

      it('sorts by a header, and reverses on a second click', () => {
        const { root, rows, part, click, values } = showGrids(prefer)
        const levelHead = part('dt-grid-logGrid', `h-${key(UI + 'dt-grid-col-level')}`)!
        click(levelHead.querySelector('button')!)
        expect(values('dt-grid-logGrid', 'sortColumn')).toEqual([UI + 'dt-grid-col-level'])
        expect(levelHead.getAttribute('aria-sort')).toBe('ascending')
        // By the levels' sem:order (debug, info, warning, error); ties keep capture order.
        expect(rows('dt-grid-logGrid').map((r) => r.split(/\s+/)[1])).toEqual(['Debug', 'Debug', 'Info', 'Info', 'Info', 'Info', 'Warning', 'Error'])
        click(levelHead.querySelector('button')!)
        expect(root('dt-grid-logGrid').querySelector('th[aria-sort]')!.getAttribute('aria-sort')).toBe('descending')
        expect(rows('dt-grid-logGrid').map((r) => r.split(/\s+/)[1])).toEqual(['Error', 'Warning', 'Info', 'Info', 'Info', 'Info', 'Debug', 'Debug'])
        // A text column sorts as text.
        click(part('dt-grid-logGrid', `h-${key(UI + 'dt-grid-col-source')}`)!.querySelector('button')!)
        expect(rows('dt-grid-logGrid').map((r) => r.split(/\s+/)[2])).toEqual(['dom', 'engine', 'engine', 'fetch', 'fetch', 'fetch', 'persistence', 'vite'])
      })

      it('selects a row (and pins the window); the selected row again deselects it', () => {
        const { root, click, values, rows, part } = showGrids(prefer)
        const grid = root('dt-grid-logGrid')
        const row = () => [...grid.querySelectorAll('tbody > tr')].find((tr) => tr.textContent!.startsWith('7'))!
        click(row().querySelector('td:last-child')!)
        expect(values('dt-grid-logGrid', 'selectedRow')).toEqual([UI + 'log-7'])
        expect(row().getAttribute('aria-selected')).toBe('true')
        expect(row().getAttribute('tabindex')).toBe('0')
        expect(grid.querySelectorAll('tr[aria-selected=true]')).toHaveLength(1)
        expect(values('dt-grid-logGrid', 'followTail')).toEqual(['false'])
        expect(values('dt-grid-logGrid', 'windowEnd').map(Number)).toEqual([12])
        expect(part('dt-grid-logGrid', 'follow')!.getAttribute('aria-pressed')).toBe('false')
        expect(part('dt-grid-logGrid', 'jump')!.textContent).toBe('0 new · Jump to latest')
        // The metrics beside the grid read the selection back.
        expect(root('dt-grid-selected').textContent).toContain('log-7')
        click(row())
        expect(values('dt-grid-logGrid', 'selectedRow')).toEqual([])
        expect(grid.querySelectorAll('tr[aria-selected=true]')).toHaveLength(0)
        expect(rows('dt-grid-logGrid')).toHaveLength(8)
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
        expect(rows('dt-grid-logGrid')[7]).toMatch(/^13/)
        expect(part('dt-grid-logGrid', 'status')!.textContent).toBe('13 matching · showing 6–13')
        // Pausing the follow pins the window where it is.
        click(part('dt-grid-logGrid', 'follow')!)
        expect(values('dt-grid-logGrid', 'followTail')).toEqual(['false'])
        add(14)
        add(15)
        expect(rows('dt-grid-logGrid')[7]).toMatch(/^13/)
        expect(part('dt-grid-logGrid', 'jump')!.textContent).toBe('2 new · Jump to latest')
        click(part('dt-grid-logGrid', 'jump')!)
        expect(values('dt-grid-logGrid', 'followTail')).toEqual(['true'])
        expect(values('dt-grid-logGrid', 'windowEnd')).toEqual([])
        expect(rows('dt-grid-logGrid')[7]).toMatch(/^15/)
      })

      it('pages older and newer over the matching members', () => {
        const { rows, part, click, values } = showGrids(prefer)
        click(part('dt-grid-logGrid', 'older')!)
        expect(values('dt-grid-logGrid', 'windowEnd').map(Number)).toEqual([4])
        expect(rows('dt-grid-logGrid').map((r) => r.split(/\s+/)[0])).toEqual(['1', '2', '3', '4'])
        expect(part('dt-grid-logGrid', 'status')!.textContent).toBe('12 matching · showing 1–4')
        expect(part('dt-grid-logGrid', 'older')!.hasAttribute('disabled')).toBe(true)
        // The newer page reaches the newest: the grid follows again.
        click(part('dt-grid-logGrid', 'newer')!)
        expect(values('dt-grid-logGrid', 'followTail')).toEqual(['true'])
        expect(rows('dt-grid-logGrid')).toHaveLength(8)
      })

    })
  }
})
