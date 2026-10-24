import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS, STY } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { mountShell, mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const c = NS.c

/** The shell on the Components page, showing the Windows gallery group. */
function showWindows(kind: 'oxigraph' | 'hybrid' | 'n3' = 'oxigraph') {
  // The site as first seen: the tools window is closed, so the desktop starts empty.
  const h = mountSite(kind)
  const f = h.store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  h.showPage('Components')
  h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupWindows'))] })
  h.shell.flush()
  const node = (iri: string) => ([...h.document.querySelectorAll('*')].find((el) => h.shell.keyOf(el) === iri) ?? null) as HTMLElement | null
  const root = (local: string) => node(`${UI}${local}/~root`)!
  const facts = (s: string, p: string) => h.store.match(f.namedNode(s.includes(':') ? s : UI + s), f.namedNode(p.includes(':') ? p : c + p), null).map((q) => q.object.value)
  const fact = (s: string, p: string) => facts(s, p)[0]
  const click = (el: Element) => h.fire(el, 'click')
  const control = (win: string, label: string) => root(win).querySelector(`.sem-window-bar [aria-label^="${label}"]`) as HTMLElement | null
  const move = (win: string, detail: Record<string, number>) =>
    root(win).querySelector('.sem-window-bar')!.dispatchEvent(new h.window.CustomEvent('sem-move', { bubbles: true, detail }))
  const taskbar = () => root('taskbar')
  const entry = (title: string) => [...taskbar().querySelectorAll('.sem-task')].find((b) => b.textContent!.includes(title)) as HTMLElement
  return { ...h, node, root, fact, facts, click, control, move, taskbar, entry }
}

describe('windows', () => {
  it('closed frames are not placed on the desktop, so neither they nor their content are evaluated', () => {
    const { root, document, taskbar, screen } = showWindows()
    expect(root('win-checklist')).toBeNull()
    expect(root('win-check-drag')).toBeNull()
    expect(screen.engine.stats.byRule.get(c + 'PaletteRendering-fn')?.runs ?? 0).toBe(0)
    expect(document.querySelector('[data-sem-c=desktop] > .sem-frames')).not.toBeNull()
    // the taskbar hides itself while no frame is open
    expect(taskbar().hasAttribute('hidden')).toBe(true)
    expect(taskbar().getAttribute('role')).toBe('toolbar')
  })

  it('opens from a c:opens button, in front, with the controls of its capabilities, and lists itself in the taskbar', () => {
    const { root, fact, click, control, taskbar, entry } = showWindows()
    click(root('wn-open-checklist'))
    expect(fact('win-checklist', 'open')).toBe('true')
    const win = root('win-checklist')
    expect(win.hasAttribute('hidden')).toBe(false)
    expect(win.getAttribute('role')).toBe('dialog')
    expect(win.getAttribute('aria-label')).toBe('Checklist')
    expect(win.getAttribute('data-sem-window-state')).toBe('normal')
    expect(win.parentElement!.classList.contains('sem-frames')).toBe(true)
    expect(win.getAttribute('style')).toContain('left: 140px; top: 140px; width: 380px; height: 330px;')
    expect([...win.querySelectorAll('.sem-window-control')].map((b) => b.getAttribute('aria-label'))).toEqual([
      'Minimize Checklist',
      'Maximize Checklist',
      'Close Checklist',
    ])
    expect(win.querySelector('.sem-window-bar')!.getAttribute('data-sem-gesture')).toBe('move')
    expect(win.querySelector('.sem-window-grip')).not.toBeNull()
    expect(root('win-check-drag')).not.toBeNull()
    // raised on open: the desktop's topmost, at the next stacking order
    expect(fact('desktop', 'topmost')).toBe(UI + 'win-checklist')
    expect(fact('win-checklist', 'z')).toBe('1')
    expect(win.getAttribute('style')).toContain('z-index: 1;')
    expect(taskbar().hasAttribute('hidden')).toBe(false)
    expect(entry('Checklist').getAttribute('aria-current')).toBe('true')
    // close is the overlay close (c:closes), not a dock
    click(control('win-checklist', 'Close')!)
    expect(fact('win-checklist', 'open')).toBe('false')
    expect(root('win-checklist')).toBeNull()
    expect(taskbar().hasAttribute('hidden')).toBe(true)
  })

  it('minimizes to the taskbar, which restores it, raises others, and minimizes the one in front', () => {
    const { root, fact, click, control, entry } = showWindows()
    click(root('wn-open-checklist'))
    click(control('win-checklist', 'Minimize')!)
    expect(fact('win-checklist', 'windowState')).toBe(c + 'Minimized')
    const win = root('win-checklist')
    expect(win.hasAttribute('hidden')).toBe(true)
    expect(win.getAttribute('data-sem-window-state')).toBe('minimized')
    expect(win.querySelector('.sem-window-body')).not.toBeNull() // parked, not dropped
    expect(entry('Checklist').getAttribute('data-state')).toBe('minimized')
    expect(entry('Checklist').hasAttribute('aria-current')).toBe(false)
    click(entry('Checklist'))
    expect(fact('win-checklist', 'windowState')).toBe(c + 'Normal')
    expect(root('win-checklist').hasAttribute('hidden')).toBe(false)
    // in front already: the entry minimizes it
    click(entry('Checklist'))
    expect(fact('win-checklist', 'windowState')).toBe(c + 'Minimized')
    // opening a minimized window restores it
    click(root('wn-open-checklist'))
    expect(fact('win-checklist', 'windowState')).toBe(c + 'Normal')
    // another window: the taskbar brings the checklist back to the front
    click(root('wn-open-log'))
    expect(fact('desktop', 'topmost')).toBe(UI + 'win-log')
    click(entry('Checklist'))
    expect(fact('desktop', 'topmost')).toBe(UI + 'win-checklist')
    expect(fact('win-checklist', 'windowState')).toBe(c + 'Normal')
    expect(Number(fact('win-checklist', 'z'))).toBeGreaterThan(Number(fact('win-log', 'z')))
  })

  it('maximizes and restores; maximized it has no geometry, no drag handle and no grip', () => {
    const { root, fact, click, control } = showWindows()
    click(root('wn-open-checklist'))
    click(control('win-checklist', 'Maximize')!)
    expect(fact('win-checklist', 'windowState')).toBe(c + 'Maximized')
    const win = root('win-checklist')
    expect(win.getAttribute('data-sem-window-state')).toBe('maximized')
    expect(win.getAttribute('style')).not.toContain('left')
    expect(win.querySelector('.sem-window-bar')!.hasAttribute('data-sem-gesture')).toBe(false)
    expect(win.querySelector('.sem-window-grip')).toBeNull()
    expect(control('win-checklist', 'Maximize')).toBeNull()
    click(control('win-checklist', 'Restore')!)
    expect(fact('win-checklist', 'windowState')).toBe(c + 'Normal')
    expect(root('win-checklist').getAttribute('style')).toContain('left: 140px')
  })

  it('moves, snaps to the edge it is dropped near, and floats again where it was', () => {
    const { root, fact, facts, click, control, move } = showWindows()
    click(root('wn-open-checklist'))
    move('win-checklist', { x: 300, y: 200, toStart: 400, toEnd: 500, toTop: 220, toBottom: 400 })
    expect([fact('win-checklist', 'x'), fact('win-checklist', 'y')]).toEqual(['300', '200'])
    expect(facts('win-checklist', 'attachedTo')).toEqual([])
    // released within c:snapDistance of the end edge: docked there, floating position kept
    move('win-checklist', { x: 900, y: 180, toStart: 1000, toEnd: 6, toTop: 200, toBottom: 500 })
    expect(fact('win-checklist', 'attachedTo')).toBe(c + 'EndEdge')
    expect([fact('win-checklist', 'x'), fact('win-checklist', 'y')]).toEqual(['300', '200'])
    const win = root('win-checklist')
    expect(win.getAttribute('data-sem-edge')).toBe('end')
    expect(win.getAttribute('style')).toMatch(/^width: 380px; z-index: \d+;$/)
    expect(win.querySelector('.sem-window-grip')).toBeNull()
    // maximize wins over the edge, and restoring returns to the edge
    click(control('win-checklist', 'Maximize')!)
    expect(root('win-checklist').getAttribute('style')).not.toContain('width')
    click(control('win-checklist', 'Restore')!)
    expect(fact('win-checklist', 'attachedTo')).toBe(c + 'EndEdge')
    // the nearest edge wins
    move('win-checklist', { x: 10, y: 0, toStart: 12, toEnd: 900, toTop: 3, toBottom: 700 })
    expect(fact('win-checklist', 'attachedTo')).toBe(c + 'TopEdge')
    expect(root('win-checklist').getAttribute('style')).toMatch(/^height: 330px;/)
    // ◳ floats it where it was
    click(control('win-checklist', 'Float')!)
    expect(facts('win-checklist', 'attachedTo')).toEqual([])
    expect(root('win-checklist').getAttribute('style')).toContain('left: 300px; top: 200px')
    // dragging away from every edge floats it too
    move('win-checklist', { x: 10, y: 10, toStart: 4, toEnd: 900, toTop: 300, toBottom: 300 })
    expect(fact('win-checklist', 'attachedTo')).toBe(c + 'StartEdge')
    move('win-checklist', { x: 420, y: 160, toStart: 500, toEnd: 500, toTop: 180, toBottom: 500 })
    expect(facts('win-checklist', 'attachedTo')).toEqual([])
    expect(fact('win-checklist', 'x')).toBe('420')
  })

  it('segmented controls set either axis: their options are the vocabulary’s individuals', () => {
    const { root, fact, click } = showWindows()
    click(root('wn-open-checklist'))
    const option = (control: string, label: string) =>
      [...root(control).querySelectorAll('button')].find((b) => b.textContent!.includes(label)) as HTMLElement
    expect([...root('wn-state-control').querySelectorAll('button')].map((b) => b.textContent)).toEqual(['▭Normal', '▁Minimized', '▣Maximized'])
    expect([...root('wn-dock-control').querySelectorAll('button')].map((b) => b.textContent)).toEqual(['◳Floating', '⇤Start', '⇥End', '⤒Top', '⤓Bottom'])
    click(option('wn-dock-control', 'Start'))
    expect(fact('win-checklist', 'attachedTo')).toBe(c + 'StartEdge')
    expect(root('win-checklist').getAttribute('data-sem-edge')).toBe('start')
    click(option('wn-state-control', 'Minimized'))
    expect(root('win-checklist').hasAttribute('hidden')).toBe(true)
    click(option('wn-state-control', 'Normal'))
    expect(root('win-checklist').getAttribute('data-sem-edge')).toBe('start') // still docked
    expect(option('wn-dock-control', 'Start').getAttribute('aria-pressed')).toBe('true')
  })

  it('a pointer pressed in a frame brings it to the front; pressing the front one changes nothing', () => {
    const { root, fact, click, fire, bus } = showWindows()
    click(root('wn-open-log'))
    click(root('wn-open-activity'))
    expect(fact('desktop', 'topmost')).toBe(UI + 'win-activity')
    const before = bus.recent(50).length
    fire(root('win-log').querySelector('.sem-window-body')!, 'pointerdown')
    expect(fact('desktop', 'topmost')).toBe(UI + 'win-log')
    expect(Number(fact('win-log', 'z'))).toBeGreaterThan(Number(fact('win-activity', 'z')))
    expect(root('win-log').getAttribute('style')).toContain(`z-index: ${fact('win-log', 'z')};`)
    fire(root('win-log').querySelector('.sem-window-bar')!, 'pointerdown')
    expect(bus.recent(50).length - before).toBe(1)
  })

  it('a palette has only the capabilities it is given', () => {
    const { root, click } = showWindows()
    click(root('wn-open-display'))
    const pal = root('win-display')
    expect(pal.getAttribute('data-sem-c')).toBe('palette')
    expect([...pal.querySelectorAll('.sem-window-control')].map((b) => b.getAttribute('aria-label'))).toEqual(['Close Display'])
    expect(pal.querySelector('.sem-window-grip')).not.toBeNull() // also c:Resizable
    expect(pal.getAttribute('style')).toBe('left: 760px; top: 160px; width: 260px; z-index: 1;')
    expect(pal.querySelector('[data-sem-c=theme-switcher]')).not.toBeNull()
  })

  it('a window detached from a tab is a full window: it minimizes to the taskbar on any page', () => {
    const { document, fire, showPage, store } = mountShell()
    fire(document.querySelector('[aria-label="Open Activity in a window"]')!, 'click')
    const win = () =>
      [...document.querySelectorAll('[data-sem-c=window]:not([hidden])')].find((w) => w.querySelector('.sem-window-bar strong')!.textContent === 'Activity') as HTMLElement
    const labels = [...win().querySelectorAll('.sem-window-control')].map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual(['Return to its tab: Activity', 'Minimize Activity', 'Maximize Activity', 'Close Activity'])
    fire(win().querySelector('[aria-label="Minimize Activity"]')!, 'click')
    expect(win()).toBeUndefined()
    showPage('Performance')
    // The taskbar lists every open frame, the docked tools too.
    const task = [...document.querySelectorAll('[data-sem-c=desktop] > [data-sem-c=taskbar] .sem-task')].find((t) => t.textContent!.includes('Activity')) as HTMLElement
    expect(task).toBeDefined()
    fire(task, 'click')
    expect(win().querySelector('[data-sem-c=stream-stats]')).not.toBeNull()
    expect(store.match(null, store.factory.namedNode(c + 'windowState'), store.factory.namedNode(c + 'Minimized')).length).toBe(0)
  })

  it('reacts the same through the function fallbacks (a store without SPARQL)', () => {
    const { root, fact, facts, click, control, move, entry, fire, window } = showWindows('n3')
    click(root('wn-open-checklist'))
    expect(fact('desktop', 'topmost')).toBe(UI + 'win-checklist')
    click(control('win-checklist', 'Minimize')!)
    expect(fact('win-checklist', 'windowState')).toBe(c + 'Minimized')
    click(entry('Checklist'))
    expect(fact('win-checklist', 'windowState')).toBe(c + 'Normal')
    move('win-checklist', { x: 300, y: 200, toStart: 400, toEnd: 500, toTop: 220, toBottom: 400 })
    move('win-checklist', { x: 0, y: 200, toStart: 2, toEnd: 900, toTop: 220, toBottom: 400 })
    expect(fact('win-checklist', 'attachedTo')).toBe(c + 'StartEdge')
    expect(fact('win-checklist', 'x')).toBe('300')
    click(control('win-checklist', 'Float')!)
    expect(facts('win-checklist', 'attachedTo')).toEqual([])
    click(control('win-checklist', 'Maximize')!)
    expect(fact('win-checklist', 'windowState')).toBe(c + 'Maximized')
    click(control('win-checklist', 'Restore')!)
    click(root('wn-open-log'))
    fire(root('win-checklist').querySelector('.sem-window-body')!, 'pointerdown')
    expect(fact('desktop', 'topmost')).toBe(UI + 'win-checklist')
    expect(fact('win-checklist', 'z')).toBe('3')
    root('win-checklist').querySelector('.sem-window-grip')!.dispatchEvent(new window.CustomEvent('sem-resize', { bubbles: true, detail: { width: 400, height: 300 } }))
    expect([fact('win-checklist', 'width'), fact('win-checklist', 'height')]).toEqual(['400', '300'])
  })
})

describe('frames in the text modality', () => {
  it('sketch their state, and the taskbar lists them', () => {
    const store = loadStore(
      'oxigraph',
      `@prefix c: <https://semblance.dev/ns/component#> . @prefix ex: <https://example.org/> .
       ex:d a c:Desktop ; c:hosts ex:a , ex:b , ex:m , ex:shut , ex:bar .
       ex:a a c:Window ; c:title "Notes" ; c:body ex:t .
       ex:t a c:Text ; c:label "Hello" .
       ex:b a c:Window ; c:title "Tools" ; c:attachedTo c:StartEdge .
       ex:m a c:Window ; c:title "Log" ; c:windowState c:Minimized .
       ex:shut a c:Window ; c:title "Closed" ; c:open false .
       ex:bar a c:Taskbar ; c:of ex:d ; c:topmost ex:a .
       ex:d c:topmost ex:a .`,
    )
    const text = new Runtime(store).project({ modality: MOD.Text, layers: [STY.Layer], name: 'text' })
    expect(toText(text.index, 'https://example.org/d')).toBe(
      // hosted in IRI order; the closed window is an empty hidden root
      ['┌ Notes ┐', 'Hello', '┌ Tools ⇤ ┐', '▤ Windows: [▭ Notes*] [⇤ Tools] [▁ Log]', '▁ Log'].join('\n'),
    )
  })
})
