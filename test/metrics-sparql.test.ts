// c:Metrics in SPARQL (#7): a chip per field, an IRI compacted by the longest declared namespace with its
// local part percent-decoded (sx:decodeURI), a decimal with two places (sx:formatNumber), labels and units
// in the viewer's language; the same from the SPARQL rule as from its function twin. On wat (Oxigraph has
// no sx: functions, so it runs the twin either way).
import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

describe('metrics, SPARQL and function rules alike (wat)', () => {
  const sites = () => (['sparql', 'function'] as const).map((prefer) => mountShell(5, 'wat', prefer))
  type H = ReturnType<typeof mountShell>
  const show = (h: H, group: string) => {
    const f = h.store.factory
    const app = f.namedNode(UI + 'app')
    const p = f.namedNode(UI + 'galleryGroup')
    h.showPage('Components')
    h.runtime.apply({ remove: h.store.match(app, p, null), add: [f.quad(app, p, f.namedNode(UI + group))] })
    h.shell.flush()
  }
  const metrics = (h: H) => [...h.document.querySelectorAll('[data-sem-c=metrics]')].map((m) => m.outerHTML)

  it('chooses the SPARQL rule on wat', () => {
    const rules = (mountShell(5, 'wat').screen.engine as unknown as { rules: { slot: string; kind: string }[] }).rules
    expect(rules.find((r) => r.slot === NS.c + 'MetricsRendering')?.kind).toBe('sparql')
  })

  it('renders the same chips as their values change, in every language', () => {
    const hs = sites()
    const same = (what: string) => {
      const [a, b] = hs.map(metrics)
      expect(a!.length, what).toBeGreaterThan(2)
      expect(a, what).toEqual(b)
    }
    for (const h of hs) show(h, 'GroupActions')
    same('actions')
    const set = (value: (h: H) => Parameters<H['store']['factory']['quad']>[2], property = 'act-tb-kind') => {
      for (const h of hs) {
        const f = h.store.factory
        const s = f.namedNode(UI + 'act-tb-filter')
        const p = f.namedNode(UI + property)
        h.runtime.apply({ remove: h.store.match(s, p, null), add: [f.quad(s, p, value(h))] })
        h.shell.flush()
      }
    }
    set((h) => h.store.factory.namedNode(UI + 'caf%C3%A9%20au%20lait'))
    same('a percent-encoded IRI')
    expect(metrics(hs[0]!).join()).toContain('ui:café au lait')
    set((h) => h.store.factory.namedNode(UI + 'bad%E0%A4%A'))
    same('a malformed escape')
    set((h) => h.store.factory.namedNode(NS.c + 'Button'))
    same('a framework IRI')
    set((h) => h.store.factory.namedNode('http://example.org/a/very/long/path/that/goes/on/and/on/and/on/to/the/end'))
    same('an undeclared, long IRI')
    set((h) => h.store.factory.literal('1.005', h.store.factory.namedNode(NS.xsd + 'decimal')), 'act-tb-text')
    same('a decimal')
    set((h) => h.store.factory.literal('-12.5'), 'act-tb-text')
    same('a negative decimal')
    for (const languages of [['uk'], ['de'], ['ar'], ['en']]) {
      for (const h of hs) h.screen.engine.reconfigure({ languages })
      for (const h of hs) h.shell.flush()
      same(languages.join())
    }
    for (const group of ['GroupInputs', 'GroupFeedback', 'GroupData']) {
      for (const h of hs) show(h, group)
      same(group)
    }
  })
})
