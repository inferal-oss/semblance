// The walkthrough in SPARQL (#7): its diagram is data first (ontology/components/walkthrough-diagram.ttl):
// its terms, why they are linked, their names, the links, the bands and each band's rows (a band reads
// its nodes' neighbours above, and is read again when one moves). The walkthrough's rendering
// (c:WalkthroughRendering-sparql, c:WalkthroughAsText-sparql) reads it, and is the same as its function
// twin's, byte for byte, on every page that shows one, on screen and as text.
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { MOD, NS } from '../src/ns.ts'
import { toHTML } from '../src/render/serialize.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
type Shell = ReturnType<typeof mountShell>

const EXAMPLES = ['ExTodo', 'ExActivity', 'ExBudget', 'ExCalendar', 'ExChat', 'ExCheckout', 'ExCollab', 'ExDashboard', 'ExFiles', 'ExForeign', 'ExKanban', 'ExLocalized', 'ExNetwork', 'ExPhotos', 'ExRdf', 'ExReader', 'ExSettings', 'ExShapes', 'ExSheet', 'ExSignin', 'ExWarehouse']

function shells() {
  return (['sparql', 'function'] as const).map((prefer) => {
    const h = mountShell(5, 'wat', prefer)
    const text = h.runtime.project({ modality: MOD.Text, prefer, name: 'text', roots: [UI + 'shell'] })
    const f = h.store.factory
    const set = (s: string, p: string, o: string) => {
      h.runtime.apply({ remove: h.store.match(f.namedNode(s), f.namedNode(p), null), add: [f.quad(f.namedNode(s), f.namedNode(p), f.namedNode(o))] })
      h.shell.flush()
    }
    /** The walkthroughs shown, by IRI: on screen and as text. */
    const walks = () =>
      new Map(
        h.store
          .match(null, f.namedNode(NS.rdf + 'type'), f.namedNode(NS.c + 'Walkthrough'))
          .map((q) => q.subject.value)
          .filter((w) => h.shell.nodeOf(w + '/~root'))
          .map((w) => [w, toHTML(h.screen.index, w) + '\n' + toHTML(text.index, w)]),
      )
    return { ...h, set, walks, text }
  })
}

/** The first difference between two texts, with some context. */
function diff(a: string, b: string): string {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return `at ${i}:\n  sparql:   ${a.slice(Math.max(0, i - 160), i + 160)}\n  function: ${b.slice(Math.max(0, i - 160), i + 160)}`
}

/** Where the drawing puts each node (data-sem-term → its dot's centre). */
function drawn(html: string): Record<string, string> {
  const { document } = parseHTML(`<div>${html}</div>`)
  return Object.fromEntries([...document.querySelectorAll('.sem-plot [data-sem-term]')].map((g) => [g.getAttribute('data-sem-term')!, `${g.querySelector('circle')!.getAttribute('cx')},${g.querySelector('circle')!.getAttribute('cy')}`]))
}

describe('walkthroughs in SPARQL (wat)', () => {
  it('render as their function twins do, on every example, on screen and as text', () => {
    const hs = shells()
    let seen = 0
    for (const ex of EXAMPLES) {
      for (const h of hs) h.set(UI + 'app', UI + 'page', UI + 'Examples'), h.set(UI + 'app', UI + 'example', UI + ex)
      const [a, b] = hs.map((h) => h.walks())
      expect([...a!.keys()], ex).toEqual([...b!.keys()])
      for (const [w, html] of a!) {
        seen++
        const other = b!.get(w)!
        if (html !== other) expect.fail(`${ex} ${w.replace(UI, '')} ${diff(html, other)}`)
      }
    }
    expect(seen).toBeGreaterThanOrEqual(EXAMPLES.length)
    // The SPARQL rules drew them.
    expect(hs[0]!.screen.engine.stats.byRule.get(NS.c + 'WalkthroughRendering-sparql')?.runs ?? 0).toBeGreaterThan(0)
  })

  it('and on the Type page, and the data places every node where the twin draws it', () => {
    const hs = shells()
    for (const h of hs) h.set(UI + 'app', UI + 'page', UI + 'Components'), h.set(UI + 'app', UI + 'galleryGroup', UI + 'GroupType')
    const [a, b] = hs.map((h) => h.walks())
    expect(a!.size).toBeGreaterThan(0)
    for (const [w, html] of a!) if (html !== b!.get(w)) expect.fail(`${w.replace(UI, '')} ${diff(html, b!.get(w)!)}`)
    // The bands' rows (c:x, c:y) are where the dots are.
    const h = hs[0]!
    const f = h.store.factory
    for (const [w, html] of a!) {
      const placed: Record<string, string> = {}
      for (const q of h.store.match(null, f.namedNode(NS.c + 'walkNodeIn'), f.namedNode(w))) {
        const v = (p: string) => h.store.match(q.subject, f.namedNode(NS.c + p), null)[0]?.object.value
        placed[v('nodeTerm')!] = `${v('x')},${v('y')}`
      }
      expect(placed, w).toEqual(drawn(html))
    }
  })

  it('in the docs, and in every language', () => {
    const hs = shells()
    const same = (what: string) => {
      const [a, b] = hs.map((h) => h.walks())
      expect(a!.size, what).toBeGreaterThan(0)
      for (const [w, html] of a!) if (html !== b!.get(w)) expect.fail(`${what} ${w.replace(UI, '')} ${diff(html, b!.get(w)!)}`)
    }
    for (const h of hs) h.set(UI + 'app', UI + 'page', UI + 'Docs'), h.set(UI + 'app', UI + 'docSection', UI + 'DocRules')
    same('docs')
    for (const [lang, ex] of [['Arabic', 'ExLocalized'], ['Ukrainian', 'ExTodo'], ['German', 'ExLocalized'], ['English', 'ExDashboard']]) {
      for (const h of hs) h.set(UI + 'app', NS.l10n + 'language', NS.l10n + lang!), h.set(UI + 'app', UI + 'page', UI + 'Examples'), h.set(UI + 'app', UI + 'example', UI + ex!)
      same(`${lang} ${ex}`)
      if (lang === 'Arabic') expect([...hs[0]!.walks().values()].join()).toContain('كيف يعمل')
    }
  })

  it('reading a walkthrough does not lay its diagram out again', () => {
    const [h] = shells()
    h!.set(UI + 'app', UI + 'page', UI + 'Examples')
    h!.set(UI + 'app', UI + 'example', UI + 'ExTodo')
    const runs = (rule: string) => h!.screen.engine.stats.byRule.get(NS.c + rule)?.runs ?? 0
    const before = ['WalkNodes-sparql', 'WalkVias-sparql', 'WalkRows-sparql', 'WalkthroughRendering-sparql'].map(runs)
    const steps = [...h!.document.querySelectorAll('[data-sem-c=walkthrough] .sem-walk-step')]
    steps[2]!.dispatchEvent(new h!.window.CustomEvent('sem-step', { bubbles: true }))
    h!.shell.flush()
    expect(['WalkNodes-sparql', 'WalkVias-sparql', 'WalkRows-sparql', 'WalkthroughRendering-sparql'].map(runs)).toEqual(before)
  })
})

export type { Shell }
