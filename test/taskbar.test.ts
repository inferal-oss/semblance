// The desktop's taskbar as a draggable, dockable component (ontology/components/window.ttl):
// moved by its grip or the arrow keys, docked to the edge it is dropped near or thrown at,
// floated again, remembered; and frames behind a maximized one, which are not shown.
import { describe, expect, it } from 'vitest'
import type { StoreKind } from '../src/node/load.ts'
import { NS } from '../src/ns.ts'
import { type Backend, memoryBackend } from '../src/persistence.ts'
import { mountRemembering, mountShell, mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const c = NS.c
const XSD = 'http://www.w3.org/2001/XMLSchema#'

type Mounted = ReturnType<typeof mountSite>

/** Helpers over a mounted shell whose desktop has the checklist window open (so the taskbar shows). */
function withTaskbar<T extends Mounted>(h: T) {
  const f = h.store.factory
  const open = (win: string) => {
    const w = f.namedNode(UI + win)
    h.runtime.apply({ remove: h.store.match(w, f.namedNode(c + 'open'), null), add: [f.quad(w, f.namedNode(c + 'open'), f.literal('true', f.namedNode(XSD + 'boolean')))] })
    h.shell.flush()
  }
  open('win-checklist')
  const node = (iri: string) => ([...h.document.querySelectorAll('*')].find((el) => h.shell.keyOf(el) === iri) ?? null) as HTMLElement | null
  const bar = () => node(UI + 'taskbar/~root')!
  const grip = () => bar().querySelector('.sem-grip') as HTMLElement
  const facts = (s: string, p: string) => h.store.match(f.namedNode(UI + s), f.namedNode(c + p), null).map((q) => q.object.value)
  const fact = (s: string, p: string) => facts(s, p)[0]
  /** A drag released: where the bar was let go, the pointer's distances to the edges, its velocity. */
  const move = (detail: Record<string, number>) => grip().dispatchEvent(new h.window.CustomEvent('sem-move', { bubbles: true, detail }))
  const far = { toStart: 400, toEnd: 400, toTop: 300, toBottom: 300 }
  /** The viewport (1280 × 800) and where the bar is in it: linkedom has no layout. */
  const layout = (rect: { left: number; top: number; width: number; height: number }) => {
    const root = h.document.documentElement as HTMLElement
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 1280 })
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 800 })
    bar().getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect }) as DOMRect
  }
  const key = (k: string, shiftKey = false) => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key: k, shiftKey, ctrlKey: false, metaKey: false, altKey: false })
    grip().dispatchEvent(e)
    return e
  }
  return { ...h, open, node, bar, grip, facts, fact, move, far, layout, key }
}

const cases: [StoreKind, 'sparql' | 'function'][] = [
  ['wat', 'sparql'],
  ['wat', 'function'],
  ['oxigraph', 'sparql'],
]

describe.each(cases)('the taskbar, draggable and dockable (%s store, %s preferred)', (kind, prefer) => {
  const site = () => withTaskbar(mountSite(kind, prefer))

  it('has a grip only where it is c:Draggable, and stays where the theme puts it until moved', () => {
    const { bar, grip, node, facts } = site()
    expect(bar().hasAttribute('hidden')).toBe(false)
    expect(grip().getAttribute('data-sem-gesture')).toBe('move')
    expect(grip().getAttribute('data-sem-move-size')).toBe('content')
    expect(grip().getAttribute('tabindex')).toBe('0')
    expect(grip().getAttribute('aria-label')).toBe('Move Windows')
    expect(grip().getAttribute('aria-keyshortcuts')).toBe('ArrowUp ArrowDown ArrowLeft ArrowRight')
    // unplaced: no position, no edge, the theme's place
    expect(bar().hasAttribute('style')).toBe(false)
    expect(bar().hasAttribute('data-sem-edge')).toBe(false)
    expect([facts('taskbar', 'x'), facts('taskbar', 'attachedTo')]).toEqual([[], []])
    // the gallery's second taskbar is neither: no grip (it is on the Components page, not shown here)
    expect(node(UI + 'wn-taskbar-inline/~root')?.querySelector('.sem-grip') ?? null).toBeNull()
  })

  it('floats where it is dropped, kept on screen', () => {
    const { bar, move, far, fact } = site()
    move({ x: 420, y: 300, ...far })
    expect([fact('taskbar', 'x'), fact('taskbar', 'y')]).toEqual(['420', '300'])
    expect(bar().getAttribute('data-sem-edge')).toBe('none')
    expect(bar().getAttribute('style')).toBe('left: clamp(0px, 420px, calc(100vw - 56px)); top: clamp(0px, 300px, calc(100dvh - 48px));')
  })

  it('docks to each edge it is dropped near, lying along the top and bottom and upright at the sides', () => {
    const { bar, move, far, fact, facts } = site()
    move({ x: 420, y: 300, ...far })
    const edges = [
      ['toTop', 'TopEdge', 'top', null],
      ['toBottom', 'BottomEdge', 'bottom', null],
      ['toStart', 'StartEdge', 'start', 'vertical'],
      ['toEnd', 'EndEdge', 'end', 'vertical'],
    ] as const
    for (const [distance, edge, slug, orientation] of edges) {
      move({ x: 10, y: 10, ...far, [distance]: 6 })
      expect(fact('taskbar', 'attachedTo')).toBe(c + edge)
      expect(bar().getAttribute('data-sem-edge')).toBe(slug)
      expect(bar().getAttribute('aria-orientation')).toBe(orientation)
      expect(bar().hasAttribute('style')).toBe(false)
      // docking keeps where it floated
      expect([fact('taskbar', 'x'), fact('taskbar', 'y')]).toEqual(['420', '300'])
    }
    // the nearest edge wins
    move({ x: 0, y: 0, toStart: 12, toEnd: 900, toTop: 3, toBottom: 700 })
    expect(facts('taskbar', 'attachedTo')).toEqual([c + 'TopEdge'])
  })

  it('docks where it is thrown: a release counts where its momentum carries it (c:throwTime)', () => {
    const { move, far, fact, facts } = site()
    // 200 px from the bottom, let go at rest: it floats there
    move({ x: 500, y: 560, ...far, toBottom: 200, blockVelocity: 0 })
    expect(facts('taskbar', 'attachedTo')).toEqual([])
    expect(fact('taskbar', 'y')).toBe('560')
    // the same release at 2,000 px/s downwards lands 320 px further: past the bottom edge
    move({ x: 500, y: 560, ...far, toBottom: 200, blockVelocity: 2000 })
    expect(fact('taskbar', 'attachedTo')).toBe(c + 'BottomEdge')
    expect(fact('taskbar', 'y')).toBe('560')
    // thrown towards the start (in the writing direction) from the middle of the screen
    move({ x: 300, y: 300, ...far, toStart: 300, inlineVelocity: -2500 })
    expect(fact('taskbar', 'attachedTo')).toBe(c + 'StartEdge')
    // released near an edge but flung away from it: it floats where it lands
    move({ x: 300, y: 300, ...far, toTop: 10, blockVelocity: 1500 })
    expect(facts('taskbar', 'attachedTo')).toEqual([])
    expect([fact('taskbar', 'x'), fact('taskbar', 'y')]).toEqual(['300', '300'])
  })

  it('floats again when dragged away from its edge, and a move with no position floats it where it was', () => {
    const { bar, move, far, fact, facts } = site()
    move({ x: 420, y: 300, ...far })
    move({ x: 0, y: 760, ...far, toBottom: 4 })
    expect(fact('taskbar', 'attachedTo')).toBe(c + 'BottomEdge')
    move({ x: 600, y: 200, ...far })
    expect(facts('taskbar', 'attachedTo')).toEqual([])
    expect([fact('taskbar', 'x'), fact('taskbar', 'y')]).toEqual(['600', '200'])
    move({ x: 0, y: 0, ...far, toEnd: 0 })
    expect(bar().getAttribute('data-sem-edge')).toBe('end')
    move({})
    expect(facts('taskbar', 'attachedTo')).toEqual([])
    expect([fact('taskbar', 'x'), fact('taskbar', 'y')]).toEqual(['600', '200'])
    expect(bar().getAttribute('style')).toContain('left: clamp(0px, 600px,')
  })

  it('moves with the arrow keys from its grip, docks at the edge it reaches, and leaves it by the opposite arrow', () => {
    const { bar, layout, key, fact, facts } = site()
    layout({ left: 500, top: 300, width: 160, height: 38 })
    expect(key('ArrowLeft').defaultPrevented).toBe(true)
    expect([fact('taskbar', 'x'), fact('taskbar', 'y')]).toEqual(['484', '300'])
    key('ArrowDown', true) // Shift: 64 px
    expect([fact('taskbar', 'x'), fact('taskbar', 'y')]).toEqual(['500', '364'])
    expect(facts('taskbar', 'attachedTo')).toEqual([])
    // 20 px from the start edge: one more press brings it within reach (c:snapDistance), and it docks
    layout({ left: 36, top: 300, width: 160, height: 38 })
    key('ArrowLeft')
    expect(fact('taskbar', 'attachedTo')).toBe(c + 'StartEdge')
    expect([fact('taskbar', 'x'), fact('taskbar', 'y')]).toEqual(['500', '364'])
    // never off screen: at the bottom it clamps, which is the edge itself
    layout({ left: 300, top: 752, width: 160, height: 38 })
    bar().setAttribute('data-sem-edge', 'none')
    key('ArrowDown', true)
    expect(fact('taskbar', 'attachedTo')).toBe(c + 'BottomEdge')
    // docked: the arrows into or along its edge do nothing; the one away from it floats it
    layout({ left: 0, top: 762, width: 1280, height: 38 })
    expect(bar().getAttribute('data-sem-edge')).toBe('bottom')
    key('ArrowDown')
    key('ArrowLeft')
    expect(fact('taskbar', 'attachedTo')).toBe(c + 'BottomEdge')
    key('ArrowUp')
    expect(facts('taskbar', 'attachedTo')).toEqual([])
    expect([fact('taskbar', 'x'), fact('taskbar', 'y')]).toEqual(['500', '364'])
  })
})

/** A fresh "browser": session, device and database storage that outlive one mount. */
function browser(): Record<string, Backend> {
  return { [NS.per + 'Session']: memoryBackend(), [NS.per + 'Device']: memoryBackend(), [NS.per + 'Database']: memoryBackend() }
}

describe('the taskbar is remembered', () => {
  it('where it floats and the edge it is docked to, for this tab (per:Session)', async () => {
    const storage = browser()
    const a = withTaskbar(await mountRemembering(storage))
    a.move({ x: 222, y: 333, ...a.far })
    a.move({ x: 0, y: 0, ...a.far, toStart: 2 })
    await a.persistence.flush()
    expect(await storage[NS.per + 'Session']!.get('semblance:' + UI + 'rememberTaskbar')).toBeTruthy()
    expect(await storage[NS.per + 'Device']!.get('semblance:' + UI + 'rememberTaskbar')).toBeUndefined()
    // "Reload": docked at the start, and floating again returns to where it was
    const b = withTaskbar(await mountRemembering(storage))
    expect(b.fact('taskbar', 'attachedTo')).toBe(c + 'StartEdge')
    expect(b.bar().getAttribute('data-sem-edge')).toBe('start')
    b.move({})
    expect(b.bar().getAttribute('style')).toContain('left: clamp(0px, 222px,')
    expect(b.bar().getAttribute('style')).toContain('top: clamp(0px, 333px,')
  })
})

describe('frames behind a maximized frame', () => {
  it('are not shown (so what they hold is parked), until they come in front or it is restored', () => {
    const h = withTaskbar(mountSite('wat'))
    h.open('win-log')
    const root = (win: string) => h.node(UI + win + '/~root')!
    const control = (win: string, label: string) => root(win).querySelector(`.sem-window-bar [aria-label^="${label}"]`) as HTMLElement
    const entry = (title: string) => [...h.bar().querySelectorAll('.sem-task')].find((b) => b.textContent!.includes(title)) as HTMLElement
    // raise the log, then maximize the checklist from behind it: it comes to the front maximized
    h.fire(root('win-log').querySelector('.sem-window-body')!, 'pointerdown')
    h.fire(root('win-checklist').querySelector('.sem-window-body')!, 'pointerdown')
    h.fire(control('win-checklist', 'Maximize'), 'click')
    expect(root('win-checklist').getAttribute('data-sem-window-state')).toBe('maximized')
    expect(root('win-log').hasAttribute('hidden')).toBe(true)
    expect(h.fact('win-log', 'windowState')).not.toBe(c + 'Minimized') // not minimized: covered
    // brought to the front from the taskbar, it is shown over the maximized one
    h.fire(entry('Change log'), 'click')
    expect(root('win-log').hasAttribute('hidden')).toBe(false)
    // and maximized again from the back, restoring shows the other
    h.fire(root('win-checklist').querySelector('.sem-window-body')!, 'pointerdown')
    expect(root('win-log').hasAttribute('hidden')).toBe(true)
    h.fire(control('win-checklist', 'Restore'), 'click')
    expect(root('win-log').hasAttribute('hidden')).toBe(false)
  })

  it('take the inspector’s mark with them: it is shown only while a highlight is', () => {
    const h = mountShell()
    const label = h.document.querySelector('[data-sem-c=list-item] label')!
    h.fire(label, 'mouseover')
    expect(label.getAttribute('data-sem-highlighted')).toBe('true')
    // the highlight renders a hidden root of its own; the theme shows the mark while it is shown
    const marker = () => h.document.querySelector('[data-sem-c=highlight]')
    expect(marker()!.hasAttribute('hidden')).toBe(true)
    expect(marker()!.parentElement!.closest('[hidden]')).toBeNull()
    // the tools behind a maximized window: hidden, and the marker with them
    h.fire(h.document.querySelector('[aria-label="Open Query in a window"]')!, 'click')
    const query = [...h.document.querySelectorAll('[data-sem-c=window]')].find((w) => w.getAttribute('aria-label') === 'Query')!
    h.fire(query.querySelector('[aria-label="Maximize Query"]')!, 'click')
    const tools = [...h.document.querySelectorAll('[data-sem-c=window]')].find((w) => w.getAttribute('aria-label') === 'Tools')!
    expect(tools.hasAttribute('hidden')).toBe(true)
    expect(marker()!.parentElement!.closest('[hidden]')).not.toBeNull()
  })
})
