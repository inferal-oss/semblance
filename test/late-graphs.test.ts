// A graph loaded into the running site (Runtime.load) defines rules, renderings and reactions:
// they join the engine and the bus, and the site is what it would be had the graph been loaded
// before start (#209).
import { describe, expect, it } from 'vitest'
import { mountSite, mountSiteWithout } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const SET = 'https://semblance.dev/demo/settings#'

type Site = ReturnType<typeof mountSite>

const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
const click = (h: Site, el: Element) => (h.fire(el, 'click'), h.shell.flush())
const button = (h: Site, text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
const navItem = (h: Site, text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!

/** The settings example's page. */
function open(h: Site) {
  click(h, button(h, 'Examples'))
  click(h, navItem(h, 'Settings'))
}

const html = (h: Site) => h.document.getElementById('app')!.innerHTML

/** The derived graph, without what names an input blank node (each load labels its own). */
function derived(h: Site): string[] {
  return h.store
    .match(null, null, null, h.screen.engine.graph)
    .filter((q) => q.subject.termType !== 'BlankNode' && q.object.termType !== 'BlankNode')
    .map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.termType === 'Literal' ? JSON.stringify(q.object.value) + (q.object as { language?: string }).language : q.object.value}`)
    .sort()
}

/** Type into one of the example's fields (a reaction the late graph defines turns it into its draft). */
function type(h: Site, local: string, text: string) {
  const el = (h.shell.nodeOf(UI + local + '/~root') as HTMLElement).querySelector('input, textarea') as HTMLInputElement
  el.value = text
  h.fire(el, 'input')
  h.shell.flush()
}

describe('a graph loaded after start', () => {
  for (const prefer of ['sparql', 'function'] as const) {
    it(`renders and reacts as if loaded before start (WAT, ${prefer} preferred)`, () => {
      const all = mountSite('wat', prefer)
      open(all)
      const late = mountSiteWithout(['_ex-settings.ttl'], 'wat', prefer)
      open(late)
      // Shown, but without its graph: the example's own components are not there yet.
      expect(late.shell.nodeOf(UI + 'set-status/~root')).toBeUndefined()
      expect(html(late)).not.toBe(html(all))
      const ran = late.screen.engine.stats.ruleRuns
      for (const ttl of late.later) late.runtime.load(ttl)
      late.shell.flush()
      expect(late.screen.engine.stats.ruleRuns).toBeGreaterThan(ran)
      // Its renderings (set:Changes, set:Preview) are active, in their stratum, as at start.
      const slots = (h: Site) => h.screen.engine.activeRules.map((r) => r.iri).sort()
      expect(slots(late)).toEqual(slots(all))
      expect(html(late)).toBe(html(all))
      expect(derived(late)).toEqual(derived(all))
      // Its reactions (set:TypeIntoDraft) answer events, its renderings follow them.
      for (const h of [all, late]) type(h, 'set-name', 'Ada Lovelace')
      const draft = (h: Site) => h.store.match(null, h.store.factory.namedNode(SET + 'displayName'), null).map((q) => q.object.value).sort()
      expect(draft(late)).toContain('Ada Lovelace')
      expect(draft(late)).toEqual(draft(all))
      expect(html(late)).toBe(html(all))
      expect(derived(late)).toEqual(derived(all))
    })
  }

  it('costs what it adds: loading a graph again changes nothing', () => {
    const late = mountSiteWithout(['_ex-settings.ttl'], 'wat', 'sparql')
    open(late)
    late.runtime.load(late.later[0]!)
    late.shell.flush()
    const before = html(late)
    const ran = late.screen.engine.stats.ruleRuns
    // The same triples (its blank nodes are new ones: list cells, nothing a rule reads anew).
    late.runtime.apply({ add: late.store.match(null, null, null, late.store.factory.defaultGraph()).filter((q) => q.subject.value.startsWith(SET)).slice(0, 50), remove: [] })
    late.shell.flush()
    expect(late.screen.engine.stats.ruleRuns).toBe(ran)
    expect(html(late)).toBe(before)
  })
})
