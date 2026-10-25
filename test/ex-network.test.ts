import { describe, expect, it } from 'vitest'
import { NETWORK_GRAPH, NS } from '../src/ns.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

// The network inspector example (demo/gallery/_network.ttl): general components - a dock panel,
// a toolbar of filters, a split view, a data grid with a waterfall, body viewers - over the
// page's own captured traffic. (Its parts are tested on their gallery pages: test/grid.test.ts,
// test/panes.test.ts, test/payload.test.ts, test/toolbar.test.ts.)

/** The site's Examples page, showing the network inspector. */
function showNetwork(prefer: 'sparql' | 'function') {
  const h = mountShell(5, 'oxigraph', prefer)
  const f = h.store.factory
  const app = f.namedNode(UI + 'app')
  h.runtime.apply({
    remove: [...h.store.match(app, f.namedNode(UI + 'page'), null), ...h.store.match(app, f.namedNode(UI + 'example'), null)],
    add: [f.quad(app, f.namedNode(UI + 'page'), f.namedNode(UI + 'Examples')), f.quad(app, f.namedNode(UI + 'example'), f.namedNode(UI + 'ExNetwork'))],
  })
  h.shell.flush()
  const node = (iri: string) => ([...h.document.querySelectorAll('*')].find((el) => h.shell.keyOf(el) === iri) ?? null) as HTMLElement | null
  const root = (local: string) => node(`${UI}${local}/~root`)!
  const part = (local: string, name: string) => node(`${UI}${local}/~${name}`)
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  /** The grid's rows, top to bottom, as their cells' text. */
  const rows = (grid: string) => [...root(grid).querySelectorAll('tbody > tr[role=row]')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent).join(' '))
  return { ...h, f, node, root, part, click, rows }
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
