import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { memoryBackend } from '../src/persistence.ts'
import { mountRemembering, mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const c = NS.c
const PER = NS.per

/** Where things are on screen: linkedom lays nothing out, so a test says where the boxes are. */
type Box = { left: number; top: number; right: number; bottom: number }
const at = (el: Element, b: Box) => {
  ;(el as HTMLElement).getBoundingClientRect = () => ({ ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON: () => b }) as DOMRect
}

/** The tools (ui:views: detachable tabs, windows on ui:desktop), driven by pointer, key and gesture events. */
function tools(prefer: 'sparql' | 'function') {
  const h = mountShell(5, 'wat', prefer)
  const { document, window, store } = h
  Object.assign(window, { innerWidth: 1280, innerHeight: 800 })
  const f = store.factory
  const tab = (name: string) => [...document.querySelectorAll('[role=tab]')].find((t) => t.textContent === name) as HTMLElement | undefined
  const list = () => document.querySelector('[role=tablist][data-sem-tear-distance]') as HTMLElement
  const frame = (title: string) =>
    [...document.querySelectorAll('[data-sem-c=window]:not([data-sem-ghost])')].find((w) => w.querySelector('.sem-window-bar strong')?.textContent === title) as HTMLElement | undefined
  const ghost = () => document.querySelector('[data-sem-ghost]') as HTMLElement | null
  // The tab list along the top of the tools, a tab in it at 120-220.
  const lay = () => {
    at(list(), { left: 100, right: 600, top: 400, bottom: 432 })
    for (const t of list().querySelectorAll('[role=tab]')) at(t, { left: 120, right: 220, top: 404, bottom: 428 })
  }
  lay()
  const pointer = (target: EventTarget, type: string, x: number, y: number, init: object = {}) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true })
    Object.assign(e, { button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, ...init })
    target.dispatchEvent(e)
    return e
  }
  /** Press on `el` at the first point, move through the rest, let go at the last. */
  const drag = (el: Element, path: [number, number][], init: object = {}, moveOn: EventTarget = document) => {
    pointer(el, 'pointerdown', ...path[0]!, init)
    for (const p of path.slice(1)) pointer(moveOn, 'pointermove', ...p, init)
    pointer(moveOn, 'pointerup', ...path.at(-1)!, init)
  }
  const facts = (s: string, p: string) => store.match(f.namedNode(s.includes(':') ? s : UI + s), f.namedNode(p.includes(':') ? p : c + p), null).map((q) => q.object.value)
  const fact = (s: string, p: string) => facts(s, p)[0]
  const win = (tabName: string) => `${UI}views/~window-${encodeURIComponent(UI + tabName)}`
  const detached = () => store.match(null, f.namedNode(c + 'detached'), null).map((q) => q.subject.value)
  const selected = () => document.querySelector('[role=tab][aria-selected=true]')?.textContent
  /** Events recorded since: the classes of the change log's newer members (a press in the tools raises them first). */
  const recorded = () => h.bus.recent(200).length
  const since = (n: number) => h.bus.recent(200).slice(0, h.bus.recent(200).length - n).map((m) => m.find((q) => q.predicate.value === NS.rdf + 'type')!.object.value.replace(/.*[#/]/, ''))
  const key = (el: Element, k: string, init: object = {}) => {
    const e = new window.Event('keydown', { bubbles: true, cancelable: true })
    Object.assign(e, { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init })
    el.dispatchEvent(e)
    return e
  }
  return { ...h, tab, list, frame, ghost, lay, pointer, drag, facts, fact, win, detached, selected, recorded, since, key }
}

describe.each(['sparql', 'function'] as const)('tearing a tab off into a window (wat, %s)', (prefer) => {
  it('a detachable tab says it tears off; the list says how far and what letting go does', () => {
    const { tab, list } = tools(prefer)
    expect(tab('Activity')!.getAttribute('data-sem-gesture')).toBe('tear')
    expect(tab('Activity')!.getAttribute('aria-keyshortcuts')).toBe('Shift+Enter')
    expect(list().getAttribute('data-sem-tear-distance')).toBe('24')
    expect(list().getAttribute('data-sem-tear-cue')).toBe('Release to open in a window')
    expect(list().getAttribute('data-sem-tear-back-cue')).toBe('Release to keep it a tab')
    // The ⧉ control is still there, and still the accessible path.
    expect(list().querySelector('[aria-label="Open Activity in a window"]')).not.toBeNull()
  })

  it('dragged out past the threshold, the tab becomes a window where it was let go', () => {
    const { tab, frame, ghost, drag, pointer, document, fact, win, detached, list } = tools(prefer)
    pointer(tab('Activity')!, 'pointerdown', 150, 416)
    // Out of the list, but not by 24px yet: nothing shows.
    pointer(document, 'pointermove', 150, 450)
    expect(ghost()).toBeNull()
    // Past it: a ghost of the window follows the pointer, held where the tab was.
    pointer(document, 'pointermove', 300, 520)
    expect(ghost()).not.toBeNull()
    expect(ghost()!.getAttribute('data-sem-tear')).toBe('out')
    expect(ghost()!.querySelector('.sem-window-bar strong')!.textContent).toBe('Activity')
    expect(ghost()!.textContent).toContain('Release to open in a window')
    expect(ghost()!.getAttribute('style')).toMatch(/left: ?270px; ?top: ?508px/)
    expect(ghost()!.getAttribute('aria-hidden')).toBe('true')
    expect(tab('Activity')!.hasAttribute('data-sem-tearing')).toBe(true)
    expect(document.documentElement.hasAttribute('data-sem-dragging')).toBe(true)
    expect(list().hasAttribute('data-sem-gathering')).toBe(false)
    pointer(document, 'pointerup', 320, 540)
    expect(ghost()).toBeNull()
    expect(document.documentElement.hasAttribute('data-sem-dragging')).toBe(false)
    expect(detached()).toEqual([UI + 'activityTab'])
    expect([fact(win('activityTab'), 'x'), fact(win('activityTab'), 'y')]).toEqual(['290', '528'])
    // Placed there, floating, and in front of the desktop it lives on.
    const w = frame('Activity')!
    expect(w.getAttribute('style')).toContain('left: 290px; top: 528px')
    expect(fact('desktop', 'topmost')).toBe(win('activityTab'))
    expect(w.getAttribute('style')).toContain(`z-index: ${fact(win('activityTab'), 'z')};`)
    expect(tab('Activity')).toBeUndefined()
    void drag
  })

  it('let go within the threshold, it was a click: the tab is selected and nothing tears', () => {
    const { tab, ghost, drag, fire, detached, selected, recorded, since } = tools(prefer)
    const before = recorded()
    drag(tab('Activity')!, [
      [150, 416],
      [170, 440],
      [180, 445],
    ])
    expect(ghost()).toBeNull()
    fire(tab('Activity')!, 'click')
    expect(selected()).toBe('Activity')
    expect(detached()).toEqual([])
    expect(since(before).filter((k) => k !== 'PointerDown')).toEqual(['Click']) // the selection, nothing else
  })

  it('brought back over the list before letting go, it stays a tab', () => {
    const { tab, list, ghost, pointer, document, detached, recorded, selected, since } = tools(prefer)
    const before = recorded()
    const was = selected()
    pointer(tab('Activity')!, 'pointerdown', 150, 416)
    pointer(document, 'pointermove', 300, 600)
    expect(ghost()!.getAttribute('data-sem-tear')).toBe('out')
    pointer(document, 'pointermove', 400, 420)
    expect(ghost()!.getAttribute('data-sem-tear')).toBe('back')
    expect(ghost()!.textContent).toContain('Release to keep it a tab')
    expect(list().hasAttribute('data-sem-gathering')).toBe(true)
    pointer(document, 'pointerup', 400, 420)
    expect(ghost()).toBeNull()
    expect(list().hasAttribute('data-sem-gathering')).toBe(false)
    // Neither torn off nor selected by the release (whose click a browser would swallow).
    expect(detached()).toEqual([])
    expect(selected()).toBe(was)
    expect(since(before).filter((k) => k !== 'PointerDown')).toEqual([])
  })

  it('Escape puts it back', () => {
    const { tab, ghost, pointer, document, key, detached } = tools(prefer)
    pointer(tab('Activity')!, 'pointerdown', 150, 416)
    pointer(document, 'pointermove', 300, 600)
    expect(ghost()).not.toBeNull()
    key(document.body, 'Escape')
    expect(ghost()).toBeNull()
    pointer(document, 'pointerup', 300, 600)
    expect(detached()).toEqual([])
  })

  it('a touch tears only after a long press; moving first is a scroll', async () => {
    const { tab, ghost, pointer, document, detached } = tools(prefer)
    const touch = { pointerType: 'touch' }
    pointer(tab('Activity')!, 'pointerdown', 150, 416, touch)
    pointer(document, 'pointermove', 150, 600, touch)
    expect(ghost()).toBeNull()
    pointer(document, 'pointerup', 150, 600, touch)
    expect(detached()).toEqual([])
    pointer(tab('Activity')!, 'pointerdown', 150, 416, touch)
    await new Promise((r) => setTimeout(r, 400))
    expect(tab('Activity')!.hasAttribute('data-sem-tear-armed')).toBe(true)
    pointer(document, 'pointermove', 300, 600, touch)
    expect(ghost()).not.toBeNull()
    pointer(document, 'pointerup', 300, 600, touch)
    expect(detached()).toEqual([UI + 'activityTab'])
  })

  it('tabs that are not detachable never tear off', () => {
    const { tab, ghost, pointer, document, fire, store, recorded, since } = tools(prefer)
    fire(tab('Query')!, 'click')
    const results = tab('Graph')!
    expect(results.hasAttribute('data-sem-gesture')).toBe(false)
    expect(results.closest('[role=tablist]')!.hasAttribute('data-sem-tear-distance')).toBe(false)
    const before = recorded()
    pointer(results, 'pointerdown', 150, 416)
    pointer(document, 'pointermove', 400, 700)
    expect(ghost()).toBeNull()
    pointer(document, 'pointerup', 400, 700)
    // Nor does an event that says it did.
    results.dispatchEvent(new (document.defaultView!.CustomEvent)('sem-tear-off', { bubbles: true, detail: { x: 10, y: 10 } }))
    expect(store.match(null, store.factory.namedNode(c + 'detached'), null)).toHaveLength(0)
    expect(since(before).filter((k) => k !== 'PointerDown')).toEqual([])
  })

  it('Shift+Enter on a focused tab opens it in a window, as its ⧉ control does', () => {
    const { tab, key, frame, detached } = tools(prefer)
    const e = key(tab('Activity')!, 'Enter', { shiftKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(detached()).toEqual([UI + 'activityTab'])
    expect(frame('Activity')).toBeDefined()
    // Enter alone is still the tab's own (no detaching).
    key(tab('Engine')!, 'Enter')
    expect(detached()).toEqual([UI + 'activityTab'])
  })

  it('a torn-off window let go over its tab list returns to its tab', () => {
    const { tab, list, frame, pointer, drag, document, lay, fact, facts, win, detached, selected } = tools(prefer)
    drag(tab('Activity')!, [
      [150, 416],
      [300, 520],
    ])
    expect(detached()).toEqual([UI + 'activityTab'])
    expect(list().getAttribute('data-sem-return-cue')).toBe('Release to return it to its tab')
    const gathers = facts(list().id || `${UI}views/~tablist`, 'gathers')
    expect(gathers).toEqual([win('activityTab')])
    lay()
    // Moved by its title bar, away from the list: an ordinary move.
    const bar = () => frame('Activity')!.querySelector('.sem-window-bar')!
    drag(bar(), [
      [300, 520],
      [700, 300],
    ], {}, bar())
    expect(detached()).toEqual([UI + 'activityTab'])
    // Over the list: it says what letting go would do...
    pointer(bar(), 'pointerdown', 300, 300)
    pointer(bar(), 'pointermove', 400, 416)
    expect(list().hasAttribute('data-sem-gathering')).toBe(true)
    expect(frame('Activity')!.hasAttribute('data-sem-returning')).toBe(true)
    expect(frame('Activity')!.getAttribute('data-sem-return-cue')).toBe('Release to return it to its tab')
    pointer(bar(), 'pointermove', 400, 200)
    expect(list().hasAttribute('data-sem-gathering')).toBe(false)
    expect(frame('Activity')!.hasAttribute('data-sem-returning')).toBe(false)
    pointer(bar(), 'pointermove', 400, 416)
    // ...and letting go there docks it: back in its tab, selected, its window's place kept.
    const x = fact(win('activityTab'), 'x')
    pointer(bar(), 'pointerup', 400, 416)
    expect(detached()).toEqual([])
    expect(frame('Activity')).toBeUndefined()
    expect(selected()).toBe('Activity')
    expect(list().hasAttribute('data-sem-gathering')).toBe(false)
    expect(fact(win('activityTab'), 'x')).toBe(x)
    expect(document.querySelector('[data-sem-returning]')).toBeNull()
  })
})

describe('tearing off, SPARQL and functions alike', () => {
  it('the same tabs, windows and changes after every step', () => {
    const [a, b] = [tools('sparql'), tools('function')]
    const steps: ((t: ReturnType<typeof tools>) => void)[] = [
      (t) => t.drag(t.tab('Activity')!, [[150, 416], [300, 520]]),
      (t) => t.drag(t.tab('Inspector')!, [[150, 416], [500, 120]]),
      (t) => t.key(t.tab('Change log')!, 'Enter', { shiftKey: true }),
      (t) => {
        t.lay()
        const bar = t.frame('Activity')!.querySelector('.sem-window-bar')!
        t.drag(bar, [[300, 520], [400, 416]], {}, bar)
      },
      (t) => t.drag(t.tab('Activity')!, [[150, 416], [900, 700]]),
    ]
    const view = (t: ReturnType<typeof tools>) => ({
      list: t.list().outerHTML,
      windows: ['Activity', 'Inspector', 'Change log'].map((n) => {
        const w = t.frame(n)
        return w && [w.getAttribute('style'), w.querySelector('.sem-window-bar')!.outerHTML]
      }),
      state: ['activityTab', 'inspectorTab', 'logTab'].flatMap((n) => [t.facts(n, 'detached'), ...['x', 'y', 'z', 'windowState', 'attachedTo'].map((p) => t.facts(t.win(n), p))]),
      front: t.facts('desktop', 'topmost'),
      // Each event's effect, as the change log records it.
      log: t.bus.recent(10).map((m) => m.filter((q) => q.predicate.value === NS.beh + 'added' || q.predicate.value === NS.beh + 'removed').map((q) => q.predicate.value + q.object.value).sort()),
    })
    for (const step of steps) {
      step(a)
      step(b)
      expect(view(b)).toEqual(view(a))
    }
    expect(a.detached().sort()).toEqual([UI + 'activityTab', UI + 'inspectorTab', UI + 'logTab'])
  })
})

describe('a torn-off window is remembered', () => {
  it('where it was let go, across a reload', async () => {
    const storage = { [PER + 'Session']: memoryBackend(), [PER + 'Device']: memoryBackend(), [PER + 'Database']: memoryBackend() }
    const a = await mountRemembering(storage)
    const tab = [...a.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Inspector')!
    tab.dispatchEvent(new a.window.CustomEvent('sem-tear-off', { bubbles: true, detail: { x: 333, y: 222 } }))
    await a.persistence.flush()
    const b = await mountRemembering(storage)
    const inspector = [...b.document.querySelectorAll('[data-sem-c=window]')].find((w) => w.querySelector('.sem-window-bar strong')!.textContent === 'Inspector')!
    expect(inspector).toBeDefined()
    expect(inspector.getAttribute('style')).toContain('left: 333px; top: 222px')
  })
})
