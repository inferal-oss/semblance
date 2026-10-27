// The Reference page's search (demo/gallery/_reference.ttl): a c:Combobox over every term the
// term tree lists (c:optionsFrom), called by prefixed name (c:optionNames c:PrefixedNames), the
// best 20 matches as you type (c:optionLimit), focused with "/" (key:shortcut). Driven through
// DOM events as a person would, on Semblance's own WASM engine, under SPARQL and function
// preferences, asserting the DOM and the graph.
import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { mountNavigating, mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const C = NS.c
type Site = ReturnType<typeof mountSite>

/**
 * linkedom has no focus: a minimal model of it, as browsers have it. focus() moves it (focusout on
 * the element that had it, focusin on the new one), blur() drops it, activeElement reads it, and
 * select() is recorded, so a test can see what was selected.
 */
interface FocusState {
  window: Site['window']
  active: Element | null
  selected: Element | null
}
const focusStates = new WeakMap<object, FocusState>()
let focusPatched = false
function focusModel(h: Pick<Site, 'document' | 'window'>): FocusState {
  const doc = h.document
  const state: FocusState = { window: h.window, active: null, selected: null }
  focusStates.set(doc, state)
  Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => state.active ?? doc.body })
  if (focusPatched) return state
  focusPatched = true
  const move = (s: FocusState, to: Element | null) => {
    const from = s.active
    if (from === to) return
    s.active = to
    from?.dispatchEvent(new s.window.Event('focusout', { bubbles: true }))
    to?.dispatchEvent(new s.window.Event('focusin', { bubbles: true }))
  }
  // linkedom's element classes share their prototypes across documents: patch the one under
  // every HTML element (the class just above Element), once; each document has its own state.
  let base = Object.getPrototypeOf(doc.body) as object
  while (Object.getPrototypeOf(base) && Object.getPrototypeOf(base).constructor.name !== 'Element') base = Object.getPrototypeOf(base)
  Object.assign(base, {
    focus(this: Element) {
      const s = focusStates.get(this.ownerDocument)
      if (s) move(s, this)
    },
    blur(this: Element) {
      const s = focusStates.get(this.ownerDocument)
      if (s?.active === this) move(s, null)
    },
    select(this: Element) {
      const s = focusStates.get(this.ownerDocument)
      if (s) s.selected = this
    },
  })
  return state
}

/** The site on its Reference page, reached through the navigation, with a search field to drive. */
function reference(prefer: 'sparql' | 'function', extra: string[] = []) {
  const h = mountSite('wat', prefer, undefined, extra)
  const focus = focusModel(h)
  h.fire([...h.document.querySelectorAll('[data-sem-c=app-bar] button')].find((b) => b.textContent!.trim() === 'Reference')!, 'click')
  h.shell.flush()
  return drive(h, focus)
}

function drive<H extends Pick<Site, 'document' | 'window' | 'shell' | 'store' | 'fire'>>(h: H, focus: ReturnType<typeof focusModel>) {
  const root = () => h.shell.nodeOf(UI + 'referenceSearch/~root') as HTMLElement
  const field = () => root().querySelector('.sem-ta-field > input') as HTMLInputElement
  const tree = () => h.document.querySelector('[data-sem-c=term-tree]')!
  const popup = () => root().querySelector('.sem-ta-popup') as HTMLElement
  /** The rows the list shows (name, then detail; the highlighted one starred). */
  const shown = () =>
    [...popup().querySelectorAll('.sem-ta-list > li:not([hidden])')].map((li) => (li.getAttribute('aria-selected') === 'true' ? '*' : '') + li.textContent)
  const marks = () => [...popup().querySelectorAll('.sem-ta-list > li:not([hidden]) mark')].map((m) => m.textContent)
  const status = () => popup().querySelector('.sem-ta-status')?.textContent
  const type = (text: string) => {
    const f = field()
    f.value = text
    Object.assign(f, { selectionStart: text.length, selectionEnd: text.length })
    h.fire(f, 'input')
    h.shell.flush()
  }
  /** A key press on an element (the field by default); returns whether something used it. */
  const press = (key: string, on: Element = field()) => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
    on.dispatchEvent(e)
    h.shell.flush()
    return e.defaultPrevented
  }
  const subject = () => h.store.match(h.store.factory.namedNode(UI + 'app'), h.store.factory.namedNode(UI + 'referenceSubject'), null)[0]?.object.value
  const selectedInTree = () => [...tree().querySelectorAll('[aria-selected=true] > .sem-row > .sem-label')].map((l) => l.textContent)
  const heading = () => h.document.querySelector('[data-sem-c=term-overview] h2')?.textContent
  return { ...h, focus, root, field, tree, popup, shown, marks, status, type, press, subject, selectedInTree, heading }
}

describe.each(['sparql', 'function'] as const)('the reference search (wat, %s rules)', (prefer) => {
  it('is a combobox above the tree, over every term the tree lists, showing the term, hinting "/"', () => {
    const h = reference(prefer)
    const root = h.root()
    expect(root.getAttribute('data-sem-c')).toBe('combobox')
    // Above the tree, in the page's side column.
    const side = [...root.parentElement!.children]
    expect(side.indexOf(root)).toBeLessThan(side.indexOf(h.tree()))
    expect(root.querySelector('label')!.textContent).toBe('Find a term')
    // It shows where we are: the term, by prefixed name.
    expect(h.field().value).toBe('c:Window')
    expect(h.field().getAttribute('role')).toBe('combobox')
    // The shortcut, for assistive technology and as a hint on the field box.
    expect(root.getAttribute('aria-keyshortcuts')).toBe('/')
    expect(root.querySelector('.sem-ta-field')!.getAttribute('data-sem-key-hint')).toBe('/')
    // Its options are what the tree lists: every branch and term of its sections, a text node each.
    const f = h.store.factory
    const listed = h.store.match(f.namedNode(UI + 'referenceTree'), f.namedNode(C + 'lists'), null).map((q) => q.object.value)
    expect(listed.length).toBeGreaterThan(1000)
    expect(listed).toContain(C + 'List') // a component class, in its group
    expect(listed).toContain(C + 'label') // a property, in its vocabulary
    expect(listed).toContain(NS.key + 'Layer') // a layer
    const offered = h.store.match(null, f.namedNode(C + 'offered'), null).filter((q) => q.subject.value.startsWith(UI + 'referenceSearch/~term-'))
    expect(offered.length).toBe(listed.length)
    // Options are built only while the list is open.
    expect(h.root().querySelectorAll('.sem-ta-list > li[role=option]').length).toBe(0)
    expect(h.store.match(null, f.namedNode(C + 'of'), f.namedNode(UI + 'referenceSearch')).length).toBe(0)
  })

  it('"/" focuses the field from anywhere on the page, its text selected, but not while typing elsewhere', () => {
    const h = reference(prefer)
    const term = h.tree().querySelector('.sem-section .sem-label') as HTMLElement
    term.focus()
    expect(h.press('/', term)).toBe(true)
    expect(h.document.activeElement).toBe(h.field())
    expect(h.focus.selected).toBe(h.field()) // typing replaces the term it shows
    // In another text field, "/" is typed, not the shortcut.
    const other = h.document.createElement('input')
    h.document.body.appendChild(other)
    other.focus()
    expect(h.press('/', other)).toBe(false)
    expect(h.document.activeElement).toBe(other)
    // In the field itself, it is typed too.
    h.field().focus()
    expect(h.press('/', h.field())).toBe(false)
  })

  it('filters as you type: prefixed names and labels, case and accents aside, the 20 best first', () => {
    const h = reference(prefer)
    h.press('/', h.document.body)
    h.type('l')
    expect(h.field().getAttribute('aria-expanded')).toBe('true')
    expect(h.shown()).toHaveLength(20)
    // The best match first: a name that starts with the text, the shorter first.
    h.type('LIST')
    expect(h.shown()[0]).toBe('c:List')
    expect(h.shown()).toContain('c:ListItem')
    expect(h.marks()[0]).toBe('List')
    h.type('lísť')
    expect(h.shown()[0]).toBe('c:List')
    // A label is a second name: key:Layer is the keyboard layer; the match is marked in it.
    h.type('keyboard')
    const layer = [...h.popup().querySelectorAll('.sem-ta-list > li:not([hidden])')].find((li) => li.querySelector('.sem-ta-label')!.textContent === 'key:Layer')!
    expect(layer.querySelector('.sem-ta-detail')!.textContent).toBe('keyboard')
    expect(layer.querySelector('.sem-ta-detail mark')!.textContent).toBe('keyboard')
    expect(layer.textContent).toBe('key:Layer keyboard')
    // A vocabulary, whose namespace has no prefix, by its label.
    expect(h.shown()).toContain('Semblance keyboard layer')
    h.type('zqxv')
    expect(h.shown()).toEqual([])
    expect(h.status()).toBe('No matches')
  })

  it('picks with Enter: the subject changes, and the tree and the overview follow', () => {
    const h = reference(prefer)
    h.press('/', h.document.body)
    h.type('list')
    expect(h.press('Enter')).toBe(true) // nothing highlighted: the best match
    expect(h.subject()).toBe(C + 'List')
    expect(h.field().value).toBe('c:List')
    expect(h.field().getAttribute('aria-expanded')).toBe('false')
    expect(h.selectedInTree()).toEqual(['List'])
    expect(h.heading()).toBe('c:List')
    // The arrows move through the matches; Enter takes the highlighted one.
    h.type('window')
    const [first, second, third] = h.shown()
    expect([first, second]).toEqual(['c:Window', 'c:windowTo']) // the shorter first
    expect(third!.startsWith('c:window')).toBe(true)
    h.press('ArrowDown')
    h.press('ArrowDown')
    h.press('ArrowDown')
    expect(h.shown().slice(0, 3)).toEqual([first, second, '*' + third])
    expect(h.field().value).toBe(third)
    h.press('Enter')
    expect(h.subject()).toBe(C + third!.slice(2))
    expect(h.heading()).toBe(third)
    // A prefixed name picks the term it names; a layer is selected as its branch.
    h.type('ann:layer')
    h.press('Enter')
    expect(h.subject()).toBe(NS.ann + 'Layer')
    expect(h.selectedInTree()).toEqual(['announcements'])
  })

  it('closes on Escape, gives the text back, clears it, then gives the focus back', () => {
    const h = reference(prefer)
    const term = h.tree().querySelector('.sem-section .sem-label') as HTMLElement
    term.focus()
    h.press('/', term)
    h.type('wind')
    h.press('ArrowDown')
    expect(h.field().value).toBe('c:Window')
    expect(h.press('Escape')).toBe(true) // closes the list: the typed text is back
    expect(h.popup().hidden).toBe(true)
    expect(h.field().value).toBe('wind')
    expect(h.press('Escape')).toBe(true) // clears it: the field shows the term again
    expect(h.field().value).toBe('c:Window')
    expect(h.subject()).toBe(C + 'Window')
    expect(h.press('Escape')).toBe(true) // leaves the field, to where "/" was pressed
    expect(h.document.activeElement).toBe(term)
    // Nothing was picked.
    expect(h.subject()).toBe(C + 'Window')
  })
})

describe('the reference search and the address', () => {
  it('a pick changes the address (/reference/c:List/), as a step Back returns from', async () => {
    const entries = [new URL('https://semblance.test/reference/c:Window/')]
    let at = 0
    const history = {
      pushes: 0,
      pushState(_d: unknown, _u: string, url: string) {
        entries.splice(at + 1, Infinity, new URL(url, entries[at]))
        at++
        this.pushes++
      },
      replaceState(_d: unknown, _u: string, url: string) {
        entries[at] = new URL(url, entries[at])
      },
    }
    const location = {
      get pathname() {
        return entries[at]!.pathname
      },
      get search() {
        return entries[at]!.search
      },
      get hash() {
        return entries[at]!.hash
      },
    }
    const s = await mountNavigating({ location, history, events: new EventTarget() }, undefined, 'sparql', 'wat')
    const h = drive(s, focusModel(s))
    expect(h.subject()).toBe(C + 'Window')
    h.press('/', h.document.body)
    h.type('list')
    h.press('Enter')
    await new Promise((r) => setTimeout(r, 0))
    expect(h.subject()).toBe(C + 'List')
    expect(location.pathname + location.hash).toBe('/reference/c:List/')
    expect(history.pushes).toBe(1)
  })
})

describe('the reference search renders the same with SPARQL rules as with functions (wat)', () => {
  it('at every step', () => {
    const sites = [reference('sparql'), reference('function')]
    const both = (act: (h: ReturnType<typeof reference>) => void) => {
      for (const h of sites) act(h)
      const [a, b] = sites.map((h) => h.root().parentElement!.outerHTML)
      if (a !== b) {
        let i = 0
        while (i < a!.length && a![i] === b![i]) i++
        expect(a!.slice(Math.max(0, i - 300), i + 300)).toBe(b!.slice(Math.max(0, i - 300), i + 300))
      }
    }
    both(() => {})
    both((h) => h.press('/', h.document.body))
    both((h) => h.type('l'))
    both((h) => h.type('keyb'))
    both((h) => h.press('ArrowDown'))
    both((h) => h.press('Enter'))
    both((h) => h.type('list'))
    both((h) => h.press('Escape'))
  }, 240_000)
})

/**
 * What a keystroke costs, in the work counters of test/cost.test.ts, with every term of the
 * ontology and with two thousand more: the same rule runs, writes and DOM operations. The list is
 * the 20 best matches; finding them is one query however many terms there are.
 */
describe('a keystroke over every term', () => {
  it('costs the same with two thousand more terms', () => {
    const more = (n: number) =>
      [
        '@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
        '<https://example.org/big> a owl:Ontology ; rdfs:label "Zz big vocabulary" .',
        ...Array.from({ length: n }, (_, i) => `<https://example.org/big#Zz${i}> a owl:Class ; rdfs:label "Zz term ${i}" .`),
      ].join('\n')
    const measure = (extra: string[]) => {
      const h = reference('sparql', extra)
      const counters = { sparqlRows: 0 }
      const { construct, constructFor } = h.store
      h.store.construct = (...args) => {
        const quads = construct.apply(h.store, args)
        counters.sparqlRows += quads.length
        return quads
      }
      if (constructFor)
        h.store.constructFor = (...args) => {
          const quads = constructFor.apply(h.store, args)
          counters.sparqlRows += quads.length
          return quads
        }
      const snapshot = () => ({
        ruleRuns: h.screen.engine.stats.ruleRuns,
        written: h.screen.engine.stats.derivedAdded + h.screen.engine.stats.derivedRemoved,
        sparqlRows: counters.sparqlRows,
        domOps: h.shell.ops,
      })
      const delta = (act: () => void) => {
        const a = snapshot()
        const t = performance.now()
        act()
        const ms = performance.now() - t
        const b = snapshot()
        return { ...(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v - a[k as keyof typeof a]])) as ReturnType<typeof snapshot>), ms }
      }
      h.press('/', h.document.body)
      let n = 0
      const typing = () => h.type(n++ % 2 ? 'windo' : 'window')
      const moving = () => (h.press('ArrowDown'), h.press('ArrowUp'))
      typing(), typing(), moving(), moving() // warm: the rows are rendered once the list is shown
      const terms = h.store.match(h.store.factory.namedNode(UI + 'referenceTree'), h.store.factory.namedNode(C + 'lists'), null).length
      return { terms, typing: delta(typing), moving: delta(moving) }
    }
    const before = measure([])
    const after = measure([more(2000)])
    expect(after.terms - before.terms).toBe(2001)
    const { ms: typedMs, ...typed } = after.typing
    const { ms: typedBeforeMs, ...typedBefore } = before.typing
    expect(typed).toEqual(typedBefore)
    const { ms: movedMs, ...moved } = after.moving
    const { ms: movedBeforeMs, ...movedBefore } = before.moving
    expect(moved).toEqual(movedBefore)
    // A keystroke re-runs the typeahead's rules and its shown rows' (at most 20), not the options.
    expect(typed.ruleRuns).toBeLessThanOrEqual(40)
    console.log(
      `reference search keystroke: ${typed.ruleRuns} rule runs, ${typed.written} writes, ${typed.domOps} DOM ops; ` +
        `${typedBeforeMs.toFixed(1)} ms over ${before.terms} terms, ${typedMs.toFixed(1)} ms over ${after.terms}; moving ${movedBeforeMs.toFixed(1)} / ${movedMs.toFixed(1)} ms`,
    )
  }, 600_000)
})
