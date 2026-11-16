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

  it('links a card title, shows its content and keeps a locked card where it is, the same either way', () => {
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
    const html = (h: (typeof shells)[number]) => (h.shell.nodeOf(UI + 'dt-board-pipeline/~root') as Element).outerHTML
    const card = (h: (typeof shells)[number], title: string) => [...h.document.querySelectorAll('[data-sem-c=board-card]')].find((c) => c.querySelector('.sem-title')!.textContent === title)!
    const press = (h: (typeof shells)[number], title: string, key: string) => {
      const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
      Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
      card(h, title).dispatchEvent(e)
      h.shell.flush()
    }
    const stage = (h: (typeof shells)[number], item: string) => h.store.match(h.store.factory.namedNode(UI + item), h.store.factory.namedNode(UI + 'stage'), null).map((q) => q.object.value.replace(UI, ''))
    expect(html(shells[1]!)).toBe(html(shells[0]!))
    for (const h of shells) {
      const linked = card(h, 'Board keyboard moves')
      expect(linked.querySelector('.sem-title')?.tagName).toBe('A')
      expect(linked.querySelector('.sem-title')?.getAttribute('href')).toBe('/docs/components/')
      expect(linked.textContent).toContain('Arrow keys move a focused card between lanes.')
      const plain = card(h, 'Money component')
      expect(plain.querySelector('.sem-title')?.tagName).toBe('SPAN')
      const locked = card(h, 'Formula rule')
      expect(locked.querySelectorAll('button')).toHaveLength(0)
      expect(locked.querySelector('.sem-locked')?.textContent).toBe('Locked')
      expect(locked.hasAttribute('aria-keyshortcuts')).toBe(false)
      press(h, 'Formula rule', 'ArrowLeft')
      expect(stage(h, 'dt-change-1')).toEqual(['StageShipped'])
    }
    expect(html(shells[1]!)).toBe(html(shells[0]!))
    // Unlocking gives the card its move back; locking it again takes it away.
    const released = (h: (typeof shells)[number]) => h.store.factory.quad(h.store.factory.namedNode(UI + 'dt-change-1'), h.store.factory.namedNode(UI + 'released'), h.store.factory.literal('true', h.store.factory.namedNode('http://www.w3.org/2001/XMLSchema#boolean')))
    for (const h of shells) {
      h.runtime.apply({ remove: [released(h)], add: [] })
      h.shell.flush()
      expect(card(h, 'Formula rule').querySelector('.sem-locked')).toBeNull()
      expect(card(h, 'Formula rule').querySelector('button[aria-label="Move to Review"]')).not.toBeNull()
    }
    expect(html(shells[1]!)).toBe(html(shells[0]!))
    for (const h of shells) {
      h.runtime.apply({ remove: [], add: [released(h)] })
      h.shell.flush()
      expect(card(h, 'Formula rule').querySelectorAll('button')).toHaveLength(0)
    }
    expect(html(shells[1]!)).toBe(html(shells[0]!))
  })

  it('draws a board, and money, as text too', () => {
    for (const prefer of ['sparql', 'function'] as const) {
      const h = mountShell(5, 'oxigraph', prefer)
      const text = h.runtime.project({ modality: MOD.Text, prefer, functions: exampleFunctions, name: 'text-data', roots: [UI + 'gallery-data'] })
      expect(toText(text.index, UI + 'dt-board-pipeline').split('\n').filter(Boolean)).toEqual([
        '## Build (1)', '  - Board keyboard moves · Barbara Liskov </docs/components/>', 'Arrow keys move a focused card between lanes.',
        '## Review (2 / 2)', '  - Money component · Grace Hopper', '  - Board lanes · Alan Kay',
        '## Shipped (1)', '  - Formula rule · Ada Lovelace (Locked)',
      ])
      expect(toText(text.index, UI + 'dt-money-eur')).toBe('€1,249.00')
    }
  })
})
