// The board, money and formula components: both implementations where there are two, and the
// gallery's Data page (their specimens) rendering the same either way.
import { describe, expect, it } from 'vitest'
import { implementationGaps } from './implementations.ts'
import { mountShell } from './harness.ts'
import { MOD } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
import { exampleFunctions } from '../src/examples/index.ts'

const UI = 'https://semblance.dev/demo#'

describe('board, money and formula', () => {
  it('have SPARQL and function implementations (or say why not)', () => {
    expect(implementationGaps(['components/board.ttl', 'components/money.ttl', 'components/formula.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })

  it('render their specimens the same with SPARQL and with functions, also after a move', () => {
    const shells = (['sparql', 'function'] as const).map((prefer) => {
      const h = mountShell(5, 'oxigraph', prefer)
      const f = h.store.factory
      const app = f.namedNode(UI + 'app')
      const group = f.namedNode(UI + 'galleryGroup')
      h.showPage('Components')
      h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupData'))] })
      h.shell.flush()
      return h
    })
    const html = (h: (typeof shells)[number]) => (h.shell.nodeOf(UI + 'dt-board-pipeline/~root') as Element).outerHTML + (h.shell.nodeOf(UI + 'dt-money-spec/~root') as Element).outerHTML + (h.shell.nodeOf(UI + 'dt-formula-spec/~root') as Element).outerHTML
    expect(html(shells[1]!)).toBe(html(shells[0]!))
    for (const h of shells) {
      const card = [...h.document.querySelectorAll('[data-sem-c=board-card]')].find((c) => c.textContent!.includes('Board keyboard moves'))!
      h.fire(card.querySelector('button[aria-label="Move to Review"]')!, 'click')
      h.shell.flush()
    }
    // Review was full (2 / 2): the move is refused in both.
    expect(html(shells[1]!)).toBe(html(shells[0]!))
    expect(html(shells[0]!)).toContain('2 / 2')
    expect(html(shells[0]!)).toContain('sem-refused')
  })

  it('links a card title when its item has the configured address', () => {
    const html = (['sparql', 'function'] as const).map((prefer) => {
      const h = mountShell(5, 'oxigraph', prefer)
      const f = h.store.factory
      const board = f.namedNode(UI + 'dt-board-pipeline')
      const item = f.namedNode(UI + 'dt-change-4')
      const href = f.namedNode(UI + 'cardHref')
      const content = f.namedNode(UI + 'cardContent')
      const detail = f.namedNode(UI + 'cardDetail')
      const locked = f.namedNode(UI + 'cardLocked')
      const app = f.namedNode(UI + 'app')
      const group = f.namedNode(UI + 'galleryGroup')
      h.showPage('Components')
      h.runtime.apply({ remove: h.store.match(app, group, null), add: [
        f.quad(app, group, f.namedNode(UI + 'GroupData')),
        f.quad(board, f.namedNode('https://semblance.dev/ns/component#cardHref'), href),
        f.quad(item, href, f.literal('/changes/board-keyboard-moves')),
        f.quad(board, f.namedNode('https://semblance.dev/ns/component#cardContent'), content),
        f.quad(item, content, detail),
        f.quad(detail, f.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), f.namedNode('https://semblance.dev/ns/component#Text')),
        f.quad(detail, f.namedNode('https://semblance.dev/ns/component#label'), f.literal('A generic detail')),
        f.quad(board, f.namedNode('https://semblance.dev/ns/component#cardLocked'), locked),
        f.quad(f.namedNode(UI + 'dt-change-1'), locked, f.literal('true', f.namedNode('http://www.w3.org/2001/XMLSchema#boolean'))),
      ] })
      h.shell.flush()
      const card = [...h.document.querySelectorAll('[data-sem-c=board-card]')].find((c) => c.textContent!.includes('Board keyboard moves'))!
      expect(card.querySelector('.sem-title')?.tagName).toBe('A')
      expect(card.querySelector('.sem-title')?.getAttribute('href')).toBe('/changes/board-keyboard-moves')
      expect(card.textContent).toContain('A generic detail')
      const plain = [...h.document.querySelectorAll('[data-sem-c=board-card]')].find((c) => c.textContent!.includes('Formula rule'))!
      expect(plain.querySelector('.sem-title')?.tagName).toBe('SPAN')
      expect(plain.querySelectorAll('button')).toHaveLength(0)
      return (h.shell.nodeOf(UI + 'dt-board-pipeline/~root') as Element).outerHTML
    })
    expect(html[1]).toBe(html[0])
  })

  it('draws a board, and money, as text too', () => {
    for (const prefer of ['sparql', 'function'] as const) {
      const h = mountShell(5, 'oxigraph', prefer)
      const text = h.runtime.project({ modality: MOD.Text, prefer, functions: exampleFunctions, name: 'text-data', roots: [UI + 'gallery-data'] })
      expect(toText(text.index, UI + 'dt-board-pipeline').split('\n').filter(Boolean)).toEqual([
        '## Build (1)', '  - Board keyboard moves · Barbara Liskov',
        '## Review (2 / 2)', '  - Money component · Grace Hopper', '  - Board lanes · Alan Kay',
        '## Shipped (1)', '  - Formula rule · Ada Lovelace',
      ])
      expect(toText(text.index, UI + 'dt-money-eur')).toBe('€1,249.00')
    }
  })
})
