import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { mountShell } from './harness.ts'

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
