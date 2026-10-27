// The command palette (ontology/components/palette.ttl): the site's own (⌘K, ui:palette in
// demo/app.ttl) and the Overlays gallery's, driven through DOM events as a person would, on
// Oxigraph and on Semblance's own WASM engine, asserting the DOM and the graph.
import { describe, expect, it } from 'vitest'
import { MOD, NS } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
import { memoryBackend } from '../src/persistence.ts'
import { mountNavigating, mountRemembering, mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const C = NS.c

/** A focus the DOM can say it has: linkedom keeps none, so focus() records it here. */
function trackFocus(window: Window & typeof globalThis, document: Document) {
  let current: Element | null = null
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => current ?? document.body })
  ;(window.HTMLElement.prototype as HTMLElement).focus = function (this: HTMLElement) {
    current = this
  }
}

type Shell = ReturnType<typeof mountShell>

function drive(h: Shell, palette = 'palette') {
  trackFocus(h.window, h.document)
  const f = h.store.factory
  const root = () => h.shell.nodeOf(`${UI}${palette}/~root`) as HTMLElement
  const input = () => root().querySelector('.sem-cp-search > input') as HTMLInputElement
  /** A key press (on the field, or the page); returns whether something handled it. */
  const press = (key: string, mods: Partial<KeyboardEvent> = {}, target: EventTarget = input() ?? h.document) => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
    target.dispatchEvent(e)
    h.shell.flush()
    return e.defaultPrevented
  }
  const open = () => press('k', { ctrlKey: true }, h.document.body)
  const type = (text: string) => {
    const field = input()
    field.value = text
    Object.assign(field, { selectionStart: text.length, selectionEnd: text.length })
    h.fire(field, 'input')
    h.shell.flush()
  }
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  /** The sections shown, each with its shown options (the highlighted one starred). */
  const sections = () =>
    [...root().querySelectorAll('[role=listbox] > [role=group]:not([hidden])')].map((g) => ({
      heading: g.querySelector('.sem-cp-heading')!.textContent,
      options: [...g.querySelectorAll('[role=option]:not([hidden])')].map((o) => (o.getAttribute('aria-selected') === 'true' ? '*' : '') + o.querySelector('.sem-ta-label')!.textContent),
    }))
  const option = (label: string) => [...root().querySelectorAll('[role=option]:not([hidden])')].find((o) => o.querySelector('.sem-ta-label')!.textContent === label) as HTMLElement
  const fact = (s: string, p: string) => h.store.match(f.namedNode(s.includes(':') ? s : UI + s), f.namedNode(p), null).map((q) => q.object.value)
  const isOpen = () => fact(palette, C + 'open')[0] === 'true'
  /** The change log's newest members, newest first: [event class, target]. */
  const log = (n = 3) => h.bus.recent(n).map((quads) => [quads.find((q) => q.predicate.value === NS.rdf + 'type')!.object.value, quads.find((q) => q.predicate.value === NS.beh + 'target')!.object.value])
  return { ...h, root, input, press, open, type, click, sections, option, fact, isOpen, log }
}

describe.each(['oxigraph', 'wat'] as const)('command palette (%s)', (kind) => {
  it('closed, renders an empty hidden root on the desktop and mints nothing', () => {
    const p = drive(mountShell(5, kind))
    expect(p.root().getAttribute('data-sem-c')).toBe('command-palette')
    expect(p.root().hidden).toBe(true)
    expect(p.root().children).toHaveLength(0)
    expect(p.document.querySelector('[data-sem-c=desktop]')!.contains(p.root())).toBe(true)
    const f = p.store.factory
    const options = p.store.match(null, f.namedNode(C + 'of'), f.namedNode(UI + 'palette'))
    expect(options).toHaveLength(0)
  })

  it('opens with mod+k as a WAI-ARIA combobox over a grouped listbox in a modal dialog, the focus in its field', () => {
    const p = drive(mountShell(5, kind))
    const before = p.document.querySelector('[data-sem-c=app-bar] button') as HTMLElement
    before.focus()
    expect(p.open()).toBe(true)
    expect(p.isOpen()).toBe(true)
    expect(p.log(1)).toEqual([[NS.key + 'Press', UI + 'openPalette']])
    const panel = p.root().querySelector('.sem-panel')!
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(panel.getAttribute('aria-label')).toBe('Command palette')
    const field = p.input()
    expect(field.getAttribute('role')).toBe('combobox')
    expect(field.getAttribute('aria-expanded')).toBe('true')
    expect(field.getAttribute('aria-autocomplete')).toBe('list')
    expect(field.getAttribute('placeholder')).toBe('Type a command or search…')
    const list = p.root().querySelector('[role=listbox]')!
    expect(field.getAttribute('aria-controls')).toBe(list.id)
    expect(p.document.activeElement).toBe(field)
    // Sections, in order, each a group labelled by its heading.
    const sections = p.sections()
    expect(sections.map((s) => s.heading)).toEqual(['Commands', 'Actions', 'Go to', 'Overlays page'])
    for (const g of list.querySelectorAll('[role=group]')) expect(p.document.getElementById(g.getAttribute('aria-labelledby')!)!.textContent).toBeTruthy()
    // Every keyboard command but the palette's own; the first one shown is highlighted.
    expect(sections[0]!.options).toEqual(['*Inspect what is under the pointer', 'Pause or resume the inspector', 'Private mode on or off', 'Turn the inspector off or on'])
    const active = list.querySelector('[aria-selected=true]')!
    expect(field.getAttribute('aria-activedescendant')).toBe(active.id)
    // Components with a shortcut, told apart by where they are, with their keys beside them.
    expect(sections[1]!.options).toContain('Tools')
    const save = [...list.querySelectorAll('[role=option]')].filter((o) => o.querySelector('.sem-ta-label')!.textContent === 'Save')
    expect(save.map((o) => o.querySelector('.sem-ta-help')!.textContent).sort()).toEqual(['Settings', 'Shared agenda'])
    const tools = p.option('Tools')
    expect(tools.getAttribute('aria-keyshortcuts')).toBe('Control+.')
    expect([...tools.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['⌘.', 'Ctrl+.'])
    // Every place of the location: the pages, and their sections under them.
    expect(sections[2]!.options.slice(0, 3)).toEqual(['Home', 'Docs', 'Overview'])
    expect(p.option('Overview').querySelector('.sem-ta-help')!.textContent).toBe('Docs')
  })

  it('filters as one types, highlighting the match, hiding empty sections, and says when nothing matches', () => {
    const p = drive(mountShell(5, kind))
    p.open()
    p.type('INSP')
    expect(p.sections()).toEqual([
      { heading: 'Commands', options: ['*Inspect what is under the pointer', 'Pause or resume the inspector', 'Turn the inspector off or on'] },
      { heading: 'Go to', options: ['Inspection', 'Network inspector'] },
    ])
    expect([...p.root().querySelectorAll('[role=option]:not([hidden]) mark')].map((m) => m.textContent)).toEqual(['Insp', 'insp', 'insp', 'Insp', 'insp'])
    expect(p.root().querySelector('.sem-cp-status')!.textContent).toBe('')
    p.type('zzzz')
    expect(p.sections()).toEqual([])
    expect(p.root().querySelector('.sem-cp-status')!.textContent).toBe('No matches')
    expect(p.input().hasAttribute('aria-activedescendant')).toBe(false)
    expect(p.press('Enter')).toBe(false)
    expect(p.isOpen()).toBe(true)
  })

  it('moves through what is shown with the arrow keys, wrapping', () => {
    const p = drive(mountShell(5, kind))
    p.open()
    p.type('insp')
    expect(p.press('ArrowDown')).toBe(true)
    expect(p.sections()[0]!.options).toEqual(['Inspect what is under the pointer', '*Pause or resume the inspector', 'Turn the inspector off or on'])
    p.press('ArrowDown')
    p.press('ArrowDown')
    expect(p.sections()[1]!.options).toEqual(['*Inspection', 'Network inspector'])
    p.press('ArrowDown')
    p.press('ArrowDown')
    expect(p.sections()[0]!.options[0]).toBe('*Inspect what is under the pointer')
    p.press('ArrowUp')
    expect(p.sections()[1]!.options).toEqual(['Inspection', '*Network inspector'])
    expect(p.input().getAttribute('aria-activedescendant')).toBe(p.option('Network inspector').id)
    // Typing again starts from the first shown.
    p.type('insp')
    expect(p.sections()[0]!.options[0]).toBe('*Inspect what is under the pointer')
  })

  it('runs a command with Enter: it closes, the command gets its key press, and the focus goes back', () => {
    const p = drive(mountShell(5, kind))
    const before = p.document.querySelector('[data-sem-c=app-bar] button') as HTMLElement
    before.focus()
    p.open()
    p.type('private')
    expect(p.press('Enter')).toBe(true)
    expect(p.isOpen()).toBe(false)
    expect(p.root().hidden).toBe(true)
    expect(p.fact('palette', C + 'value')).toEqual([])
    // What the command's own reaction does, recorded as its own event, raised by the palette's.
    expect(p.fact('shell', NS.prv + 'privacy')).toEqual([NS.prv + 'Private'])
    expect(p.log(2)).toEqual([
      [NS.key + 'Press', UI + 'togglePrivate'],
      [C + 'TypeaheadKey', UI + 'palette'],
    ])
    const [press, run] = p.bus.recent(2)
    expect(press!.find((q) => q.predicate.value === NS.beh + 'raisedBy')!.object.value).toBe(run![0]!.subject.value)
    expect(p.document.activeElement).toBe(before)
  })

  it('remembers what was run, first in a Recent section while nothing is typed', () => {
    const p = drive(mountShell(5, kind))
    p.open()
    p.type('private')
    p.press('Enter')
    p.open()
    p.type('pause')
    p.press('Enter')
    p.open()
    expect(p.sections()[0]).toEqual({ heading: 'Recent', options: ['*Pause or resume the inspector', 'Private mode on or off'] })
    const f = p.store.factory
    const ranks = p.store
      .match(null, f.namedNode(C + 'recentRank'), null)
      .map((q) => [p.fact(q.subject.value, C + 'entryFor')[0]!.replace(UI, ''), q.object.value])
      .sort()
    expect(ranks).toEqual([
      ['pauseInspector', '0'],
      ['togglePrivate', '1'],
    ])
    // Typing searches everything once; the recent ones are not shown twice.
    p.type('pri')
    expect(p.sections().map((s) => s.heading)).toEqual(['Commands'])
    // Running a recent one again makes it the latest.
    p.type('')
    p.press('ArrowDown')
    p.press('Enter')
    p.open()
    expect(p.sections()[0]!.options).toEqual(['*Private mode on or off', 'Pause or resume the inspector'])
  })

  it('runs a component by clicking it: its own click reactions handle the raised click', () => {
    const p = drive(mountShell(5, kind))
    expect(p.fact('tools', C + 'open')).toEqual(['true'])
    p.open()
    p.type('tools')
    p.click(p.option('Tools').querySelector('.sem-ta-label')!)
    expect(p.isOpen()).toBe(false)
    expect(p.fact('tools', C + 'open')).toEqual(['false'])
    expect(p.log(1)).toEqual([[NS.beh + 'Click', UI + 'toolsToggle']])
  })

  it('closes on Escape, and on its ✕ and scrim, forgetting what was typed', () => {
    const p = drive(mountShell(5, kind))
    const before = p.document.querySelector('[data-sem-c=app-bar] button') as HTMLElement
    before.focus()
    p.open()
    p.type('docs')
    expect(p.press('Escape')).toBe(true)
    expect(p.isOpen()).toBe(false)
    expect(p.fact('palette', C + 'value')).toEqual([])
    expect(p.document.activeElement).toBe(before)
    p.open()
    expect(p.input().value).toBe('')
    p.type('docs')
    p.click(p.root().querySelector('.sem-close')!)
    expect(p.isOpen()).toBe(false)
    p.open()
    p.click(p.root().querySelector('.sem-scrim')!)
    expect(p.isOpen()).toBe(false)
    expect(p.fact('palette', C + 'value')).toEqual([])
  })

  it('keeps Tab inside while open', () => {
    const p = drive(mountShell(5, kind))
    p.open()
    const close = p.root().querySelector('.sem-close') as HTMLElement
    expect(p.press('Tab', {}, p.input())).toBe(false)
    close.focus()
    expect(p.press('Tab', {}, close)).toBe(true)
    expect(p.document.activeElement).toBe(p.input())
    expect(p.press('Tab', { shiftKey: true }, p.input())).toBe(true)
    expect(p.document.activeElement).toBe(close)
  })

  it('opens from the app bar button, which shows the key that opens it without binding it', () => {
    const p = drive(mountShell(5, kind))
    const button = p.shell.nodeOf(UI + 'paletteButton/~root') as HTMLElement
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+K')
    expect(button.getAttribute('data-sem-key-hint')).toBe('Ctrl+K')
    expect(button.getAttribute('data-sem-key-hint-apple')).toBe('⌘K')
    expect(button.hasAttribute('data-sem-shortcut')).toBe(false)
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    p.click(button)
    expect(p.isOpen()).toBe(true)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    // Neither the button nor the command that open it are among its options.
    p.type('palette')
    expect(p.sections()).toEqual([])
    p.type('search')
    expect(p.sections()).toEqual([])
  })

  it('is described in the text modality while open', () => {
    const p = drive(mountShell(5, kind))
    const text = () => toText(p.runtime.project({ modality: MOD.Text, name: 'text-' + Math.random(), roots: [UI + 'palette'] }).index, UI + 'palette')
    expect(text()).toBe('')
    p.open()
    p.type('ru')
    expect(text()).toBe('⌘ Command palette: [ru_]')
  })
})

describe('the command palette goes to places', () => {
  /** A browser tab's address and history (as test/location.test.ts has it). */
  function tab() {
    const entries = [new URL('/', 'https://semblance.test/')]
    let at = 0
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
    return { location, history, events: new EventTarget() }
  }

  it('runs a place as a link to it: a step in the history, then followed', async () => {
    const t = tab()
    const h = await mountNavigating({ ...t, schedule: (run) => queueMicrotask(run), frame: () => {} })
    const p = drive(h as unknown as Shell)
    p.open()
    p.type('rules')
    expect(p.sections()).toEqual([{ heading: 'Go to', options: ['*Rules and the engine'] }])
    p.press('Enter')
    await new Promise((r) => setTimeout(r, 0))
    h.shell.flush()
    expect(t.location.hash).toBe('#docs/rules')
    expect(t.history.pushes).toBe(1)
    expect(p.fact('app', UI + 'page')).toEqual([UI + 'Docs'])
    expect(p.fact('app', UI + 'docSection')).toEqual([UI + 'DocRules'])
    // The request is spent; the step was a nav:Navigate event.
    expect(p.fact('palette', NS.nav + 'goTo')).toEqual([])
    expect(p.log(1)).toEqual([[NS.nav + 'Navigate', UI + 'location']])
  })
})

describe('the gallery palette', () => {
  it('lists what its app gives it in a section of its own, and each entry does what it is for', () => {
    const h = mountShell(5)
    h.showPage('Components')
    const f = h.store.factory
    h.runtime.apply({ remove: h.store.match(f.namedNode(UI + 'app'), f.namedNode(UI + 'galleryGroup'), null), add: [f.quad(f.namedNode(UI + 'app'), f.namedNode(UI + 'galleryGroup'), f.namedNode(UI + 'GroupOverlays'))] })
    h.shell.flush()
    const p = drive(h, 'ov-palette')
    p.click(h.shell.nodeOf(UI + 'ov-open-palette/~root') as HTMLElement)
    expect(p.isOpen()).toBe(true)
    expect(p.root().querySelector('.sem-panel')!.getAttribute('aria-label')).toBe('Gallery palette')
    expect(p.input().getAttribute('placeholder')).toBe('Run something on this page…')
    const sections = p.sections()
    expect(sections.map((s) => s.heading)).toEqual(['Commands', 'Overlays page'])
    expect(sections[1]!.options).toEqual(['Wave hello', 'Open dialog', 'Open end drawer', 'The combobox specimen'])
    expect(p.option('Wave hello').querySelector('.sem-ta-help')!.textContent).toBe('Changes the badge on the card')
    // A command: its reaction changes the badge and is announced.
    p.click(p.option('Wave hello'))
    expect(p.fact('ov-pal-badge', C + 'label')).toEqual(['Waved from the palette'])
    expect(p.document.querySelector('[data-sem-c=toast-region]')!.textContent).toContain('Hello from the palette')
    // A button of the page: running it clicks it, so the dialog opens.
    p.click(h.shell.nodeOf(UI + 'ov-open-palette/~root') as HTMLElement)
    p.type('dialog')
    p.press('Enter')
    expect(p.fact('ov-dialog', C + 'open')).toEqual(['true'])
  })
})

describe('the command palette renders the same with SPARQL rules as with functions', () => {
  it('after every step', () => {
    const shells = (['sparql', 'function'] as const).map((prefer) => drive(mountShell(5, 'oxigraph', prefer)))
    const same = (step: string) => {
      const [a, b] = shells.map((p) => p.document.getElementById('app')!.innerHTML)
      expect(a, `after ${step}: SPARQL and function renderings differ`).toBe(b)
    }
    const all = (act: (p: (typeof shells)[number]) => void, step: string) => {
      for (const p of shells) act(p)
      same(step)
    }
    same('mount')
    all((p) => p.open(), 'opening')
    all((p) => p.type('o'), 'typing o')
    all((p) => p.press('ArrowDown'), 'Down')
    all((p) => p.type('insp'), 'typing insp')
    all((p) => p.type('zzz'), 'typing zzz')
    all((p) => p.type('private'), 'typing private')
    all((p) => p.press('Enter'), 'Enter')
    all((p) => p.open(), 'reopening, with a recent run')
    all((p) => p.press('ArrowUp'), 'Up')
    all((p) => p.press('Escape'), 'Escape')
  })
})

describe('the recent runs', () => {
  it('are remembered on this device (ui:rememberPalette, a per:Policy)', async () => {
    const PER = NS.per
    const storage = { [PER + 'Session']: memoryBackend(), [PER + 'Device']: memoryBackend(), [PER + 'Database']: memoryBackend() }
    const a = await mountRemembering(storage)
    try {
      const p = drive(a as unknown as Shell)
      p.open()
      p.type('private')
      p.press('Enter')
      await a.persistence.flush()
      expect(await storage[PER + 'Device']!.get('semblance:' + UI + 'rememberPalette')).toBeTruthy()
      // A reload: a new shell over the same storage.
      const b = await mountRemembering(storage)
      try {
        const q = drive(b as unknown as Shell)
        q.open()
        expect(q.sections()[0]).toEqual({ heading: 'Recent', options: ['*Private mode on or off'] })
      } finally {
        // Drain scheduled writes before test/setup.ts releases the store.
        await b.persistence.flush()
      }
    } finally {
      await a.persistence.flush()
    }
  })
})

describe('the command palette shape', () => {
  it('flags nothing on the site and its gallery palette, and says what is wrong with a malformed one', () => {
    const h = mountShell(5)
    const p = drive(h)
    p.open()
    p.type('private')
    p.press('Enter')
    const f = h.store.factory
    const SH = 'http://www.w3.org/ns/shacl#'
    const flagged = () => h.store.match(null, f.namedNode(SH + 'focusNode'), null).map((q) => q.object.value).filter((v) => v.includes('palette') || v.includes('recent'))
    expect(flagged()).toEqual([])
    h.runtime.apply({ remove: [], add: [f.quad(f.namedNode(UI + 'palette'), f.namedNode(C + 'recentLimit'), f.literal('-1', f.namedNode(NS.xsd + 'integer')))] })
    h.shell.flush()
    expect(flagged()).toEqual([UI + 'palette'])
    const messages = h.store.match(null, f.namedNode(SH + 'resultMessage'), null).map((q) => q.object.value)
    expect(messages).toContain('How many recent runs a palette keeps is a number, 0 or more (c:recentLimit).')
  })
})

/** Search metadata is input on an entry, separate from its displayed name. */
function metadata(p: ReturnType<typeof drive>, value?: string) {
  const f = p.store.factory, subject = f.namedNode(UI + 'toolsToggle'), predicate = f.namedNode(C + 'keywords')
  p.runtime.apply({ remove: p.store.match(subject, predicate, null, f.defaultGraph()), add: value === undefined ? [] : [f.quad(subject, predicate, f.literal(value))] })
  p.shell.flush()
}

function disabled(p: ReturnType<typeof drive>, value?: boolean) {
  const f = p.store.factory, subject = f.namedNode(UI + 'toolsToggle'), predicate = f.namedNode(C + 'disabled')
  p.runtime.apply({ remove: p.store.match(subject, predicate, null, f.defaultGraph()), add: value === undefined ? [] : [f.quad(subject, predicate, f.literal(String(value), f.namedNode(NS.xsd + 'boolean')))] })
  p.shell.flush()
}

describe.each(['wat', 'oxigraph'] as const)('palette search metadata (%s)', (kind) => {
  it('matches metadata only without displaying or falsely highlighting it, and follows updates/removal', () => {
    const p = drive(mountShell(5, kind))
    metadata(p, 'Complete-ID-abc123 Café compiler')
    p.open()
    const textRuns = () => p.screen.engine.stats.byRule.get(C + 'PaletteTexts-fn')?.runs ?? 0
    const beforeTyping = textRuns()
    p.type('cafe compiler')
    expect(textRuns()).toBe(beforeTyping)
    expect(p.sections()).toEqual([{ heading: 'Actions', options: ['*Tools'] }])
    expect(p.option('Tools').querySelector('mark')).toBe(null)
    expect(p.option('Tools').textContent).not.toContain('abc123')
    expect(p.input().getAttribute('aria-activedescendant')).toBe(p.option('Tools').id)
    const before = p.fact('palette', C + 'entries')
    metadata(p, 'Replacement-identifier')
    expect(textRuns()).toBeGreaterThan(beforeTyping)
    expect(p.sections()).toEqual([])
    p.type('replacement-identifier')
    expect(p.sections()).toEqual([{ heading: 'Actions', options: ['*Tools'] }])
    expect(p.fact('palette', C + 'entries')).toEqual(before)
    metadata(p)
    expect(p.sections()).toEqual([])
    p.type('tools')
    // The site also has a place named Tools; removing metadata preserves both
    // ordinary label matches, with the action still highlighted first.
    expect(p.sections()).toContainEqual({ heading: 'Actions', options: ['*Tools'] })
    expect(p.option('Tools').querySelector('mark')?.textContent).toBe('Tools')
  })

  it('excludes disabled entries and restores them when re-enabled without replaying a selection', () => {
    const p = drive(mountShell(5, kind))
    metadata(p, 'Exact-host-identity')
    p.open()
    p.type('exact-host')
    disabled(p, true)
    expect(p.sections()).toEqual([])
    expect(p.press('Enter')).toBe(false)
    expect(p.fact('tools', C + 'open')).toEqual(['true'])
    disabled(p, false)
    expect(p.sections()).toEqual([{ heading: 'Actions', options: ['*Tools'] }])
    // Removing an entry's metadata does not select it or perform its effect.
    metadata(p)
    expect(p.fact('tools', C + 'open')).toEqual(['true'])
    expect(p.sections()).toEqual([])
  })

  it('uses the same Unicode code-point bound for indexed metadata and validation', () => {
    const p = drive(mountShell(5, kind)), f = p.store.factory
    const subject = f.namedNode(UI + 'toolsToggle'), keywords = f.namedNode(C + 'keywords')
    const keywordViolations = () => p.store.match(null, f.namedNode(NS.sh + 'focusNode'), subject)
      .filter(q => p.store.match(q.subject, f.namedNode(NS.sh + 'resultPath'), keywords).length > 0)
    const exact = '😀'.repeat(32768)
    metadata(p, exact)
    p.open()
    expect(keywordViolations()).toHaveLength(0)
    p.type('😀')
    expect(p.sections()).toEqual([{ heading: 'Actions', options: ['*Tools'] }])
    expect(p.option('Tools').textContent).not.toContain('😀')
    metadata(p, exact + 'suffix-outside-bound')
    expect(keywordViolations().length).toBeGreaterThan(0)
    p.type('suffix-outside-bound')
    expect(p.sections()).toEqual([])
    expect(p.store.match(null, f.namedNode(C + 'searchKey'), null).some(q => q.object.value === 'tools\n' + exact)).toBe(true)
  })

  it('bounds indexed metadata and declares its size/type validation shape', () => {
    const p = drive(mountShell(5, kind))
    metadata(p, 'a'.repeat(32768) + 'suffix-outside-bound')
    p.open()
    p.type('suffix-outside-bound')
    expect(p.sections()).toEqual([])
    const f = p.store.factory
    const keys = p.store.match(null, f.namedNode(C + 'searchKey'), null).map(q => q.object.value)
    expect(keys.some(value => value === 'tools\n' + 'a'.repeat(32768))).toBe(true)
    expect(keys.some(value => value.includes('suffix-outside-bound'))).toBe(false)
    expect(p.store.match(null, f.namedNode(NS.sh + 'focusNode'), f.namedNode(UI + 'toolsToggle')).length).toBeGreaterThan(0)
    const subject = f.namedNode(UI + 'toolsToggle'), predicate = f.namedNode(C + 'keywords')
    p.runtime.apply({ remove: p.store.match(subject, predicate, null, f.defaultGraph()), add: [f.quad(subject, predicate, f.namedNode(UI + 'not-a-literal'))] })
    p.shell.flush()
    p.type('not-a-literal')
    expect(p.sections()).toEqual([])
    expect(p.store.match(null, f.namedNode(NS.sh + 'focusNode'), subject).length).toBeGreaterThan(0)
  })
})

it('keeps search metadata matching and updates byte-identical across projection implementations', () => {
  const shells = (['sparql', 'function'] as const).map(prefer => drive(mountShell(5, 'oxigraph', prefer)))
  const all = (act: (p: (typeof shells)[number]) => void) => {
    for (const p of shells) act(p)
    expect(shells[0]!.document.getElementById('app')!.innerHTML).toBe(shells[1]!.document.getElementById('app')!.innerHTML)
  }
  all(p => metadata(p, 'Hidden-ID-123'))
  all(p => { p.open(); p.type('hidden-id') })
  all(p => metadata(p, 'Changed-ID-456'))
  all(p => p.type('changed-id'))
  all(p => disabled(p, true))
  all(p => disabled(p, false))
  all(p => metadata(p))
})
