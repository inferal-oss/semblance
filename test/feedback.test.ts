import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { mountShell } from './harness.ts'
import type { NamedNode, Quad } from '@rdfjs/types'

const UI = 'https://semblance.dev/demo#'

/** The shell on the Components page, showing one gallery group. */
function showGroup(key: string, kind: 'oxigraph' | 'hybrid' | 'n3' = 'oxigraph') {
  const h = mountShell(5, kind)
  const f = h.store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  h.showPage('Components')
  h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + key))] })
  h.shell.flush()
  const $ = (sel: string) => h.document.querySelector(sel) as HTMLElement
  const $$ = (sel: string) => [...h.document.querySelectorAll(sel)] as HTMLElement[]
  const byId = (iri: string) => h.document.getElementById(iri) as HTMLElement
  // The DOM node rendered for an RDF/HTML node (keyed by its IRI).
  const node = (iri: string) => ([...h.document.querySelectorAll('*')].find((el) => h.shell.keyOf(el) === iri) ?? null) as HTMLElement
  const root = (local: string) => node(`${UI}${local}/~root`)
  const fact = (s: string, p: string) => h.store.match(f.namedNode(UI + s), f.namedNode(NS.c + p), null)[0]?.object.value
  const click = (el: Element) => h.fire(el, 'click')
  return { ...h, $, $$, byId, root, fact, click }
}

describe('feedback components', () => {
  it('renders every kind on the Feedback page', () => {
    const { $$ } = showGroup('GroupFeedback')
    const kinds = new Set($$('[data-sem-c]').map((e) => e.getAttribute('data-sem-c')))
    for (const k of ['badge', 'alert', 'tag', 'spinner', 'skeleton', 'empty-state', 'toast', 'toast-region']) expect(kinds, k).toContain(k)
  })

  it('tags: toned, removable (✕ marks them removed) and selectable (aria-pressed over c:checked)', () => {
    const { root, fact, click } = showGroup('GroupFeedback')
    expect(root('fb-tag-info').getAttribute('data-sem-tone')).toBe('info')
    const removable = root('fb-tag-rm-2')
    const x = removable.querySelector('.sem-remove')!
    expect(x.getAttribute('aria-label')).toBe('Remove text')
    click(x)
    expect(fact('fb-tag-rm-2', 'removed')).toBe('true')
    expect(root('fb-tag-rm-2').hasAttribute('hidden')).toBe(true)
    expect(root('fb-tag-rm-2').children).toHaveLength(0)

    const toggle = () => root('fb-tag-sel-2').querySelector('.sem-tag-toggle')!
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    click(toggle())
    expect(fact('fb-tag-sel-2', 'checked')).toBe('true')
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(root('fb-tag-sel-2').getAttribute('data-checked')).toBe('true')
    click(toggle())
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    // a selectable and removable tag: the ✕ removes, it does not toggle
    click(root('fb-tag-sel-4').querySelector('.sem-remove')!)
    expect(fact('fb-tag-sel-4', 'checked')).toBe('true')
    expect(fact('fb-tag-sel-4', 'removed')).toBe('true')
  })

  it('spinners are named status regions; skeletons are hidden placeholders', () => {
    const { root } = showGroup('GroupFeedback')
    const spin = root('fb-spin-lg')
    expect(spin.getAttribute('role')).toBe('status')
    expect(spin.querySelector('.sem-sr')!.textContent).toBe('Loading the graph')
    expect(spin.querySelector('.sem-ring')!.getAttribute('aria-hidden')).toBe('true')
    expect(spin.getAttribute('data-sem-size')).toBe('lg')
    const lines = root('fb-skel-para')
    expect(lines.getAttribute('aria-hidden')).toBe('true')
    expect(lines.getAttribute('data-shape')).toBe('text')
    expect(lines.querySelectorAll('.sem-bone')).toHaveLength(5)
    const avatar = root('fb-skel-avatar')
    expect(avatar.getAttribute('data-shape')).toBe('circle')
    expect(avatar.getAttribute('style')).toContain('width: 44px')
  })

  it('empty state: glyph, title, hint and actions', () => {
    const { root } = showGroup('GroupFeedback')
    const empty = root('fb-empty-state')
    expect(empty.querySelector('.sem-title')!.textContent).toBe('No triples match')
    expect(empty.querySelector('.sem-body')!.textContent).toContain('Nothing in the graph')
    expect(empty.querySelectorAll('.sem-actions [data-sem-c=button]')).toHaveLength(2)
  })

  it('toasts open in a polite live region on the desktop and are dismissed by their ✕', () => {
    const { root, fact, click, $ } = showGroup('GroupFeedback')
    const region = root('fb-toast-region')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.getAttribute('aria-label')).toBe('Notifications')
    expect($('[data-sem-c=desktop]').contains(region)).toBe(true)
    expect(root('fb-live-saved').hasAttribute('hidden')).toBe(true)

    const show = root('fb-show-saved')
    expect(show.getAttribute('aria-controls')).toBe(`${UI}fb-live-saved/~root`)
    expect(show.getAttribute('aria-expanded')).toBe('false')
    click(show)
    expect(fact('fb-live-saved', 'open')).toBe('true')
    const toast = root('fb-live-saved')
    expect(toast.hasAttribute('hidden')).toBe(false)
    expect(region.contains(toast)).toBe(true)
    expect(toast.textContent).toContain('Todo saved')
    expect(show.getAttribute('aria-expanded')).toBe('true')

    click(toast.querySelector('.sem-close')!)
    expect(fact('fb-live-saved', 'open')).toBe('false')
    expect(root('fb-live-saved').hasAttribute('hidden')).toBe(true)

    // danger toasts are assertive
    click(root('fb-show-failed'))
    expect(root('fb-live-failed').getAttribute('role')).toBe('alert')
  })

  it('inline toasts are dismissed and reopened through the graph', () => {
    const { root, click } = showGroup('GroupFeedback')
    click(root('fb-toast-info').querySelector('.sem-close')!)
    click(root('fb-toast-success').querySelector('.sem-close')!)
    expect(root('fb-toast-info').hasAttribute('hidden')).toBe(true)
    click(root('fb-toasts-reset'))
    expect(root('fb-toast-info').hasAttribute('hidden')).toBe(false)
    expect(root('fb-toast-success').hasAttribute('hidden')).toBe(false)
  })

  it.each(['sparql', 'function'] as const)('a dismissed announcement leaves nothing behind once it is no longer derived (%s)', (prefer) => {
    const h = mountShell(5, 'oxigraph', prefer)
    const f = h.store.factory
    const c = (p: string) => f.namedNode(NS.c + p)
    const region = f.namedNode(UI + 'announcements')
    // Z pauses and resumes the inspector, and each says so: a toast from the change log (ann:Toasts).
    const z = () => {
      const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
      Object.assign(e, { key: 'z', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
      h.document.dispatchEvent(e)
      h.shell.flush()
    }
    const hosted = () => h.store.match(region, c('hosts'), null).map((q) => q.object.value).sort()
    const dismiss = (toast: string) => {
      const el = [...h.document.querySelectorAll('*')].find((x) => h.shell.keyOf(x) === toast + '/~root')!
      h.fire(el.querySelector('.sem-close')!, 'click')
      h.shell.flush()
    }
    const left = () => h.store.match(null, c('open'), null, f.defaultGraph()).filter((q: Quad) => q.subject.value.startsWith(region.value + '/~'))
    z()
    const first = hosted().at(-1)!
    expect(first).toContain(region.value + '/~ann-')
    dismiss(first)
    expect(h.store.match(f.namedNode(first), c('open'), null).map((q) => q.object.value)).toEqual(['false'])
    // Newer announcements push it out of the region's three: no rule derives it any more.
    for (let i = 0; i < 4; i++) z()
    expect(hosted()).not.toContain(first)
    // The next dismissal in the region forgets it: no c:open false about a toast that is gone.
    dismiss(hosted().at(-1)!)
    expect(h.store.match(f.namedNode(first), c('open'), null)).toHaveLength(0)
    expect(h.store.match(region, c('dismissedToast'), f.namedNode(first))).toHaveLength(0)
    // What is left is about toasts the region still shows.
    for (const q of left()) expect(hosted()).toContain(q.subject.value)
    // Many dismissals later, it stays within the region's limit.
    for (let i = 0; i < 12; i++) z(), dismiss(hosted().at(-1)!)
    expect(left().length).toBeLessThanOrEqual(3)
    expect(h.store.match(region, c('dismissedToast'), null).length).toBeLessThanOrEqual(3)
  })

  it.each(['sparql', 'function'] as const)('an announcement that waits for acknowledgement stays until it is dismissed (%s)', async (prefer) => {
    const h = mountShell(5, 'oxigraph', prefer)
    const f = h.store.factory
    const c = (p: string) => f.namedNode(NS.c + p)
    const nn = (iri: string) => f.namedNode(iri)
    const region = nn(UI + 'announcements')
    const log = nn(NS.beh + 'ChangeLog')
    const member = nn(NS.tree + 'member')
    const acknowledged = nn(NS.ret + 'acknowledged')
    // A short change log, so the first member it lets go is no longer kept (no storage here), which is announced.
    for (const [policy, n] of [['ChangeLogRetention', 4], ['UndoRetention', 2]] as const) {
      for (const q of h.store.match(nn(NS.beh + policy), nn(NS.ldes + 'amount'), null)) h.store.delete(q)
      h.store.add(f.quad(nn(NS.beh + policy), nn(NS.ldes + 'amount'), f.literal(String(n), nn(NS.xsd + 'integer'))))
    }
    const z = async () => {
      const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
      Object.assign(e, { key: 'z', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
      h.document.dispatchEvent(e)
      await new Promise((r) => setTimeout(r, 0))
      h.shell.flush()
    }
    const hosted = () => h.store.match(region, c('hosts'), null).map((q) => q.object.value).sort()
    const label = (toast: string) => h.store.match(nn(toast), c('label'), null)[0]?.object.value
    const el = (toast: string) => [...h.document.querySelectorAll('*')].find((x) => h.shell.keyOf(x) === toast + '/~root') as HTMLElement | undefined
    const dismiss = (toast: string) => {
      h.fire(el(toast)!.querySelector('.sem-close')!, 'click')
      h.shell.flush()
    }
    for (let i = 0; i < 6; i++) await z()
    const waiting = hosted().find((t) => label(t) === 'Older history is no longer kept')!
    expect(waiting).toBeDefined()
    const event = h.store.match(nn(waiting), nn(NS.ann + 'event'), null)[0]!.object as NamedNode
    // Many newer announcements later, and long after the log would have let its event go, it is still there:
    // the region's limit (3) counts only the others.
    for (let i = 0; i < 12; i++) await z()
    expect(hosted()).toContain(waiting)
    expect(hosted().filter((t) => t !== waiting)).toHaveLength(3)
    expect(el(waiting)?.hasAttribute('hidden')).toBe(false)
    expect(el(waiting)?.textContent).toContain('Older history is no longer kept')
    expect(h.store.match(log, member, event)).toHaveLength(1)
    expect(h.runtime.retention.get(log.value)!.retention.waiting().map((m) => m.iri)).toEqual([event.value])
    // Dismissing it acknowledges it: the region shows it no more, and the log lets its event go with the
    // dismissal's own append, taking the acknowledgement with it.
    const said: string[] = []
    const apply = h.runtime.apply.bind(h.runtime)
    h.runtime.apply = (d) => {
      for (const [w, qs] of [['+', d.add], ['-', d.remove]] as const) for (const q of qs) if (q.predicate.equals(acknowledged) && q.subject.equals(event)) said.push(w + q.object.value)
      return apply(d)
    }
    dismiss(waiting)
    h.runtime.apply = apply
    expect(said).toEqual(['+true', '-true'])
    expect(hosted()).not.toContain(waiting)
    expect(el(waiting)).toBeUndefined()
    expect(h.store.match(log, member, event)).toHaveLength(0)
    expect(h.store.match(event, acknowledged, null)).toHaveLength(0)
    expect(h.runtime.retention.get(log.value)!.retention.waiting()).toHaveLength(0)
    // The next dismissal in the region forgets its c:open false, as for any toast that is gone.
    dismiss(hosted().at(-1)!)
    expect(h.store.match(nn(waiting), c('open'), null)).toHaveLength(0)
  })

  it('a hosted toast leaves its region when dismissed', () => {
    const { runtime, store, root, click, shell } = showGroup('GroupFeedback')
    const f = store.factory
    const toast = f.namedNode(UI + 'fb-hosted')
    const region = f.namedNode(UI + 'fb-toast-region')
    const c = (p: string) => f.namedNode(NS.c + p)
    runtime.apply({
      remove: [],
      add: [
        f.quad(toast, f.namedNode(NS.rdf + 'type'), c('Toast')),
        f.quad(toast, c('label'), f.literal('From an announcement')),
        f.quad(region, c('hosts'), toast),
      ],
    })
    shell.flush()
    expect(root('fb-toast-region').contains(root('fb-hosted'))).toBe(true)
    click(root('fb-hosted').querySelector('.sem-close')!)
    expect(store.match(region, c('hosts'), toast)).toHaveLength(0)
    expect(root('fb-hosted')).toBeNull()
  })

  it('reacts the same through the function fallbacks (a store without SPARQL)', () => {
    const { root, fact, click } = showGroup('GroupFeedback', 'n3')
    click(root('fb-tag-rm-1').querySelector('.sem-remove')!)
    expect(fact('fb-tag-rm-1', 'removed')).toBe('true')
    click(root('fb-tag-sel-3').querySelector('.sem-tag-toggle')!)
    expect(fact('fb-tag-sel-3', 'checked')).toBe('true')
    click(root('fb-show-warning'))
    expect(root('fb-live-warning').hasAttribute('hidden')).toBe(false)
    click(root('fb-live-warning').querySelector('.sem-close')!)
    expect(fact('fb-live-warning', 'open')).toBe('false')
  })
})
