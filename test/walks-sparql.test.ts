import { describe, expect, it } from 'vitest'
import { MOD, NS } from '../src/ns.ts'
import { toHTML } from '../src/render/serialize.ts'
import { mountShell } from './harness.ts'

// Renderings that walk a hierarchy or a stream, in SPARQL over building blocks that put the walk's
// edges in the graph (breadcrumbs' c:stepUp / c:trailUp), or over an unrolled walk (stream
// members): the same HTML as their function twins, as the walked data changes.
const UI = 'https://semblance.dev/demo#'

function pair() {
  return (['sparql', 'function'] as const).map((prefer) => {
    const h = mountShell(5, 'oxigraph', prefer)
    const text = h.runtime.project({ modality: MOD.Text, prefer, name: 'text', roots: [UI + 'shell'] })
    const set = (s: string, p: string, o: string) => {
      const f = h.store.factory
      h.runtime.apply({ remove: h.store.match(f.namedNode(s), f.namedNode(p), null), add: [f.quad(f.namedNode(s), f.namedNode(p), o.startsWith('"') ? f.literal(o.slice(1, -1), f.namedNode(NS.xsd + 'boolean')) : f.namedNode(o))] })
      h.shell.flush()
    }
    const html = (id: string) => (toHTML(h.screen.index, UI + id) + '\n' + toHTML(text.index, UI + id)).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T')
    return { ...h, set, html }
  })
}

describe('walks in SPARQL', () => {
  it('breadcrumbs: explicit, derived along c:parentProperty, and following a selection', () => {
    const shells = pair()
    const same = (ids: string[], label: string) => {
      for (const id of ids) {
        const [a, b] = shells.map((h) => h.html(id))
        expect(a, `${label}: ${id}`).toBe(b)
      }
    }
    for (const h of shells) h.set(UI + 'app', UI + 'page', UI + 'Components')
    for (const group of ['GroupNavigation', 'GroupData']) {
      for (const h of shells) h.set(UI + 'app', UI + 'galleryGroup', UI + group)
      same(['nv-crumbs-explicit', 'nv-crumbs-derived', 'dt-tree-crumbs'], group)
    }
    expect(shells[0]!.html('nv-crumbs-derived')).toContain('Segmented')
    for (const cls of [NS.c + 'NavList', NS.c + 'Tabs', NS.sem + 'Component']) {
      for (const h of shells) h.set(UI + 'dt-browse', UI + 'browsing', cls)
      same(['dt-tree-crumbs'], cls)
    }
  })

  it('stream members: the newest members, from the head, as the log grows', () => {
    const shells = pair()
    for (const h of shells) {
      h.set(UI + 'app', UI + 'page', UI + 'Components')
      h.set(UI + 'app', UI + 'galleryGroup', UI + 'GroupWindows')
      h.set(UI + 'win-log', NS.c + 'open', '"true"')
    }
    const [empty] = shells.map((h) => h.html('win-log-members'))
    expect(empty).toContain('sem-empty')
    for (let i = 0; i < 9; i++) {
      for (const h of shells) {
        const field = h.document.querySelector('[data-sem-c=text-field] input') as HTMLInputElement
        field.value = 'x'.repeat(i + 1)
        h.fire(field, 'input')
      }
      const [a, b] = shells.map((h) => h.html('win-log-members'))
      expect(a, `after ${i + 1} events`).toBe(b)
    }
    expect((shells[0]!.html('win-log-members').match(/data-sem-c="triples-view"/g) ?? []).length).toBe(6)
  })
})
