import { appendFileSync } from 'node:fs'
import { Parser, Store } from 'n3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NS, RDF_TYPE } from '../src/ns.ts'
import { REFUSED_TAG } from '../src/render/html-index.ts'
import { appGraph, galleryFiles, mountSite } from './harness.ts'

// The site's pages clicked through as a visitor would (#427, #454): Home, every docs section, the
// reference, every gallery example and every component page. Each page renders with no error,
// warning or refusal; each button of its content is clicked (up to PER_PAGE), and a page whose
// clicks run reactions (members of the change log) must show at least one of them on screen. The
// docs pages' live examples, each in a sandbox of its own, are test/docs-live-clicks.test.ts.
// The pages are shared out over the site-clicks-*.test.ts files, each under a minute on the site's
// own store (WAT; on Oxigraph the Data page alone costs ~17 s to show, #465). SITE_CLICKS_LOG=<file>
// writes what each page clicked and which clicks ran a reaction.

const UI = 'https://semblance.dev/demo#'
const CLICKABLE = 'button, [role=button], [role=tab], [role=switch], [role=checkbox], [role=menuitem], [role=option], [role=radio]'
// The page shown: the shell's page switch keeps the pages shown before, hidden.
const PAGE = '#app > [data-sem-c=stack] > [data-sem-c=switch] > :not([hidden])'
// What opens over the page: dialogs, drawers, menus.
const DESKTOP = '#app > [data-sem-c=stack] > [data-sem-c=desktop]'
// Within it: navigation, the live examples (their own test), what is hidden, and what hands work
// to the host (a file picker, the clipboard, full screen, printing).
const CHROME = 'aside, nav, [data-sem-c=nav-list], [data-sem-c=live-example], [data-sem-c=theme-switcher], [hidden], [inert]'
const HOST = /upload|choose|browse|download|copy|full ?screen|print/i
// Enough to reach each page's reactions, few enough that the whole site stays a few minutes.
const PER_PAGE = 12

/** A page: the ui:page, and the dimension (ui:example, …) and value that pick what it shows. */
export type Page = { page: string; dimension?: string; value?: string }

/** The site's pages, from its own graph. */
export function sitePages(): Record<'home' | 'docs' | 'components' | 'examples', Page[]> {
  const graph = new Store()
  for (const text of [appGraph, ...Object.values(galleryFiles)]) graph.addQuads(new Parser().parse(text))
  const of = (cls: string) => graph.getSubjects(RDF_TYPE, UI + cls, null).map((t) => t.value).sort()
  return {
    home: [{ page: 'Home' }, { page: 'Reference' }],
    docs: of('DocSection').map((value) => ({ page: 'Docs', dimension: 'docSection', value })),
    components: of('GalleryGroup').map((value) => ({ page: 'Components', dimension: 'galleryGroup', value })),
    examples: of('Example').map((value) => ({ page: 'Examples', dimension: 'example', value })),
  }
}

/** The tests of some of the site's pages, on one mounted site. */
export function clickThroughPages(title: string, pages: Page[]) {
  let site: ReturnType<typeof mountSite>
  const said: string[] = []
  beforeAll(() => {
    site = mountSite('wat')
    // Whatever the engines, views or renderer report goes to the console.
    for (const level of ['error', 'warn'] as const) vi.spyOn(console, level).mockImplementation((...args) => void said.push(`${level}: ${args.map(String).join(' ')}`))
  })
  afterAll(() => {
    site.runtime.dispose()
    vi.restoreAllMocks()
  })

  const show = ({ page, dimension, value }: Page) => {
    const s = site.store
    const f = s.factory
    const app = f.namedNode(UI + 'app')
    const set = (p: string, o: string) => site.runtime.apply({ remove: s.match(app, f.namedNode(UI + p), null), add: [f.quad(app, f.namedNode(UI + p), f.namedNode(o))] })
    if (dimension && value) set(dimension, value)
    set('page', UI + page)
    site.shell.flush()
  }

  const shown = (p: Page) => {
    const app = site.store.factory.namedNode(UI + 'app')
    const at = (q: string) => site.store.match(app, site.store.factory.namedNode(UI + q), null)[0]?.object.value
    return at('page') === UI + p.page && (!p.dimension || at(p.dimension) === p.value)
  }

  const page = () => site.document.querySelector(PAGE)

  const clickThrough = (p: Page) => {
    show(p)
    const s = site.store
    const f = s.factory
    // The change log keeps its latest members only: a handled click is a member not seen before.
    const members = () => new Set(s.match(f.namedNode(NS.beh + 'ChangeLog'), f.namedNode(NS.tree + 'member'), null).map((q) => q.object.value))
    // What a click can show: the page and what opens over it (not the pages shown before, kept
    // hidden, which only make the comparison slower as the visit goes on; not announcements).
    const content = () =>
      [page(), ...site.document.querySelectorAll(DESKTOP)]
        .map((x) => {
          let html = x?.innerHTML ?? ''
          for (const y of x?.querySelectorAll('[role=status], [aria-live]') ?? []) html = html.replace(y.outerHTML, '')
          return html
        })
        .join('')
    const buttons = [...(page()?.querySelectorAll(CLICKABLE) ?? [])]
      .filter((b) => !b.closest(CHROME) && !HOST.test((b.textContent ?? '') + (b.getAttribute('aria-label') ?? '')) && !(b as HTMLButtonElement).disabled && b.getAttribute('aria-disabled') !== 'true')
      .slice(0, PER_PAGE)
    const handled: { label: string; shown: boolean }[] = []
    for (const b of buttons) {
      if (!b.isConnected) continue
      const before = content()
      const n = members()
      b.dispatchEvent(new site.window.Event('click', { bubbles: true }))
      site.shell.flush()
      if ([...members()].some((m) => !n.has(m))) handled.push({ label: (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().slice(0, 40), shown: content() !== before })
      // A click that took the visitor elsewhere: back to the page under test.
      if (!shown(p)) show(p)
    }
    return { buttons: buttons.map((b) => `${b.tagName}[${b.getAttribute('role') ?? ''}] ${(b.getAttribute('aria-label') ?? b.textContent ?? '').trim().slice(0, 30)}`), handled }
  }

  describe(title, () => {
    for (const p of pages) {
      it(p.value ? p.value.replace(UI, 'ui:') : p.page, () => {
        said.length = 0
        const refused = site.screen.index.refusals.size
        const { buttons, handled } = clickThrough(p)
        expect(shown(p)).toBe(true)
        expect(site.document.querySelectorAll(PAGE)).toHaveLength(1)
        expect(page()!.textContent?.trim()).toBeTruthy()
        // A page with buttons answers at least one (the docs' live examples are their own test).
        if (buttons.length) expect(handled, `${buttons.join(', ')}: no click ran a reaction`).not.toEqual([])
        if (handled.length) expect(handled.filter((c) => c.shown), `${handled.map((c) => c.label).join(', ')}: nothing changed on screen`).not.toEqual([])
        expect(said).toEqual([])
        expect(site.screen.index.refusals.size).toBe(refused)
        expect(site.document.querySelectorAll(REFUSED_TAG).length).toBe(0)
        if (process.env.SITE_CLICKS_LOG) appendFileSync(process.env.SITE_CLICKS_LOG, `${p.value ?? p.page} ${JSON.stringify({ buttons, handled })}\n`)
      }, 300_000)
    }
  })
}
