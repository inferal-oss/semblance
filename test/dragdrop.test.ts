// The drag and drop layer (ontology/layers/dragdrop.ttl), driven through pointer and keyboard
// events on the gallery's specimen: three sortable lists, one with a capacity, one that takes
// only bugs.
import { describe, expect, it } from 'vitest'
import { mountShell } from './harness.ts'
import { implementationGaps } from './implementations.ts'
import { fakeLayout } from './drag-layout.ts'

const UI = 'https://semblance.dev/demo#'
const DND = 'https://semblance.dev/ns/dragdrop#'
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#'

/** The Layers page, with a fake layout: the zones side by side, 200px apart, their items 30px rows from y = 100. */
function shelves(prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountShell(5, 'oxigraph', prefer)
  const f = h.store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  h.showPage('Components')
  h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupLayers'))] })
  h.shell.flush()
  const root = () => h.shell.nodeOf(UI + 'dndShelves/~root') as HTMLElement
  const zones = () => [...root().querySelectorAll('[data-sem-drop-zone]')] as HTMLElement[]
  const itemsIn = (zone: Element) => ([...zone.querySelectorAll('[data-sem-drag]')] as HTMLElement[]).filter((d) => d.parentElement!.closest('[data-sem-drop-zone]') === zone)
  const { rectOf, pointer } = fakeLayout(h, { width: 200, row: 30 })
  const list = (id: string) => h.shell.nodeOf(UI + id + '/~root') as HTMLElement
  const labels = (id: string) => itemsIn(list(id)).map((li) => li.textContent!.trim())
  const item = (label: string) => ([...root().querySelectorAll('[data-sem-drag]')] as HTMLElement[]).find((li) => li.textContent!.includes(label))!
  /** Press on an item, move to (x, y) in steps, and (unless `hold`) release there. */
  const drag = (label: string, x: number, y: number, hold = false) => {
    const el = item(label)
    const r = rectOf(el)
    pointer(el, 'pointerdown', r.left + 10, r.top + 10)
    pointer(h.document, 'pointermove', r.left + 20, r.top + 20)
    pointer(h.document, 'pointermove', x, y)
    if (!hold) pointer(h.document, 'pointerup', x, y)
    h.shell.flush()
  }
  const key = (el: Element, k: string) => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true })
    Object.assign(e, { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
    el.dispatchEvent(e)
    h.shell.flush()
  }
  const current = (p: string) => h.store.match(f.namedNode(DND + 'Current'), f.namedNode(DND + p), null).map((q) => q.object.value.replace(UI, ''))
  const log = () => h.bus.recent(50).map((m) => m.find((q) => q.predicate.value.endsWith('#type'))!.object.value.replace(/^.*#/, ''))
  const toasts = () => [...h.document.querySelectorAll('[data-sem-c=toast]')].map((t) => t.textContent).join(' | ')
  return { ...h, root, zones, list, labels, item, pointer, drag, key, current, log, toasts, rectOf }
}

const zoneOf = (s: ReturnType<typeof shelves>, id: string) => s.list(id)
const attr = (el: Element, name: string) => el.getAttribute(name)
const rank = (s: ReturnType<typeof shelves>, task: string) =>
  s.store.match(s.store.factory.namedNode(UI + task), s.store.factory.namedNode(UI + 'rank'), null).map((q) => `${q.object.value}^^${(q.object as { datatype: { value: string } }).datatype.value.replace(/^.*#/, '')}`)
/** Where the fake layout puts the slot before the i-th item of the z-th zone (its top half). */
const at = (z: number, i: number) => [z * 200 + 90, 100 + i * 30 + 5] as const

describe('drag and drop', () => {
  it('has SPARQL and function implementations', () => {
    expect(implementationGaps(['layers/dragdrop.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })

  it('marks the zones and the draggables, and does nothing until the pointer has moved a few pixels', () => {
    const s = shelves()
    expect(s.zones().map((z) => attr(z, 'data-sem-drop-zone'))).toEqual([UI + 'dndBacklog', UI + 'dndToday', UI + 'dndBugs'])
    const dark = s.item('Dark mode')
    expect([attr(dark, 'data-sem-gesture'), attr(dark, 'data-sem-drag'), attr(dark, 'aria-roledescription'), attr(dark, 'tabindex')]).toEqual(['drag', UI + 'task-dark', 'draggable', '0'])
    s.pointer(dark, 'pointerdown', 10, 140)
    s.pointer(s.document, 'pointermove', 12, 142)
    s.shell.flush()
    expect(s.current('carrying')).toEqual([])
    expect(dark.hasAttribute('data-sem-lifted')).toBe(false)
    s.pointer(s.document, 'pointerup', 12, 142)
  })

  it('picks up: every zone says whether it takes it, and why not - none of it recorded', () => {
    const s = shelves()
    const before = s.log().length
    s.drag('Dark mode', 20, 150, true)
    expect(s.current('carrying')).toEqual(['task-dark'])
    expect(s.current('from')).toEqual(['dndBacklog'])
    expect(s.current('by')).toEqual(['https://semblance.dev/ns/dragdrop#Pointer'])
    expect(s.item('Dark mode').hasAttribute('data-sem-lifted')).toBe(true)
    expect(s.zones().map((z) => [attr(z, 'data-sem-drop'), attr(z, 'data-sem-drop-reason')])).toEqual([
      ['accepts', null],
      ['refuses', 'Today holds two tasks at most.'],
      ['refuses', 'Only bugs go here.'],
    ])
    expect(s.document.querySelector('[data-sem-drag-live]')!.textContent).toBe('Dark mode for the editor: Backlog, before Bug: search drops accents.')
    expect(s.log().length).toBe(before)
  })

  it('moving over zones and positions changes the drag state only, and marks where it would land', () => {
    const s = shelves()
    const before = s.log().length
    s.drag('Dark mode', ...at(0, 0), true)
    expect([s.current('into'), s.current('after'), s.current('before'), s.current('rank')]).toEqual([['dndBacklog'], [], ['task-notes'], ['0']])
    expect(s.item('Release notes'.replace('Release', 'release')).hasAttribute('data-sem-drop-before')).toBe(true)
    expect(zoneOf(s, 'dndBacklog').hasAttribute('data-sem-drop-over')).toBe(true)
    s.pointer(s.document, 'pointermove', ...at(0, 3))
    s.shell.flush()
    expect([s.current('after'), s.current('before'), s.current('rank')]).toEqual([['task-search'], ['task-profile'], ['3.5']])
    expect(s.item('release notes').hasAttribute('data-sem-drop-before')).toBe(false)
    expect(s.item('Profile').hasAttribute('data-sem-drop-before')).toBe(true)
    // Past the last: after it.
    s.pointer(s.document, 'pointermove', 90, 100 + 4 * 30 + 10)
    s.shell.flush()
    expect([s.current('after'), s.current('before'), s.current('rank')]).toEqual([['task-profile'], [], ['5']])
    expect(s.item('Profile').hasAttribute('data-sem-drop-after')).toBe(true)
    // Over Today, which refuses: the reason is on the zone the pointer is over.
    s.pointer(s.document, 'pointermove', ...at(1, 1))
    s.shell.flush()
    expect(zoneOf(s, 'dndBacklog').hasAttribute('data-sem-drop-over')).toBe(false)
    expect(zoneOf(s, 'dndToday').hasAttribute('data-sem-drop-over')).toBe(true)
    expect(s.document.querySelector('[data-sem-drag-live]')!.textContent).toBe('Dark mode for the editor: Today refuses it: Today holds two tasks at most.')
    // Off every zone.
    s.pointer(s.document, 'pointermove', 900, 20)
    s.shell.flush()
    expect(s.current('into')).toEqual([])
    expect(s.root().querySelector('[data-sem-drop-over]')).toBeNull()
    expect(s.log().length).toBe(before)
  })

  it('drops into another list between two tasks: one recorded drop, a rank half way, nothing renumbered', () => {
    const s = shelves()
    s.drag('Review the shapes', ...at(0, 2))
    expect(s.labels('dndBacklog')).toEqual(['Write the release notes', 'Dark mode for the editor', 'Review the shapes guide', 'Bug: search drops accents', 'Profile the board'])
    expect(s.labels('dndToday')).toEqual(['Bug: login loops on Safari'])
    expect(rank(s, 'task-review')).toEqual(['2.5^^decimal'])
    expect(rank(s, 'task-search')).toEqual(['3^^integer'])
    expect(s.log()[0]).toBe('Drop')
    const drop = s.bus.recent(1)[0]!
    const about = (p: string) => drop.filter((q) => q.predicate.value === DND + p).map((q) => q.object.value.replace(UI, ''))
    expect([about('carrying'), about('from'), about('into'), about('after'), about('before'), about('rank'), about('effect')]).toEqual([
      ['task-review'], ['dndToday'], ['dndBacklog'], ['task-dark'], ['task-search'], ['2.5'], [DND + 'Move'],
    ])
    expect(s.toasts()).toContain('Task moved')
    // The drag is over: no state, no marks.
    expect(s.store.match(s.store.factory.namedNode(DND + 'Current'), null, null).map((q) => q.predicate.value).sort()).toEqual([RDF + 'type', RDFS + 'label'])
    expect(s.root().querySelector('[data-sem-drop], [data-sem-drop-over], [data-sem-lifted], [data-sem-drop-before]')).toBeNull()
  })

  it('reorders within a list the same way', () => {
    const s = shelves()
    s.drag('Profile the board', ...at(0, 1))
    expect(s.labels('dndBacklog')).toEqual(['Write the release notes', 'Profile the board', 'Dark mode for the editor', 'Bug: search drops accents'])
    expect(rank(s, 'task-profile')).toEqual(['1.5^^decimal'])
    s.drag('Profile the board', ...at(0, 1))
    // Dropped where it was: nothing happens, nothing is recorded.
    expect(s.log().filter((t) => t === 'Drop')).toHaveLength(1)
    s.drag('Write the release notes', 90, 100 + 4 * 30 + 10)
    expect(s.labels('dndBacklog').at(-1)).toBe('Write the release notes')
    expect(rank(s, 'task-notes')).toEqual(['4^^integer'])
  })

  it('refuses a drop by shape or capacity: never reaching the list, announced with the shape\'s message', () => {
    const s = shelves()
    s.drag('Dark mode', ...at(1, 1))
    expect(s.labels('dndToday')).toEqual(['Bug: login loops on Safari', 'Review the shapes guide'])
    expect(s.labels('dndBacklog')).toContain('Dark mode for the editor')
    expect(s.log()[0]).toBe('Refusal')
    expect(s.bus.recent(1)[0]!.some((q) => q.predicate.value.endsWith('handledBy') && q.object.value === UI + 'ShelfDrop')).toBe(false)
    expect(s.toasts()).toContain('Today holds two tasks at most.')
    expect(s.item('Dark mode').hasAttribute('data-sem-refused')).toBe(true)
    s.drag('Dark mode', ...at(2, 0))
    expect(s.labels('dndBugs')).toEqual(['Bug: crash on an empty query'])
    expect(s.toasts()).toContain('Only bugs go here.')
    // A bug conforms; and once Today has room it takes one.
    s.drag('search drops accents', ...at(2, 0))
    expect(s.labels('dndBugs')).toEqual(['Bug: search drops accents', 'Bug: crash on an empty query'])
    s.drag('Review the shapes', ...at(0, 0))
    s.drag('Dark mode', ...at(1, 1))
    expect(s.labels('dndToday')).toEqual(['Bug: login loops on Safari', 'Dark mode for the editor'])
    expect(s.item('Dark mode').hasAttribute('data-sem-refused')).toBe(false)
  })

  it('Escape, or letting go away from every list, puts it back', () => {
    const s = shelves()
    const before = s.log().length
    s.drag('Dark mode', ...at(1, 0), true)
    s.key(s.item('Dark mode'), 'Escape')
    expect(s.current('carrying')).toEqual([])
    expect(s.item('Dark mode').hasAttribute('data-sem-lifted')).toBe(false)
    expect(s.item('Dark mode').getAttribute('style')).toBeNull()
    s.pointer(s.document, 'pointerup', ...at(1, 0))
    s.shell.flush()
    s.drag('Dark mode', 900, 20)
    expect(s.labels('dndBacklog')).toHaveLength(4)
    expect(s.log().length).toBe(before)
  })

  it('drags by keyboard: Space lifts, arrows move between positions and lists, Enter drops, Escape cancels', () => {
    const s = shelves()
    const live = () => s.document.querySelector('[data-sem-drag-live]')!.textContent
    s.key(s.item('Dark mode'), ' ')
    expect(s.current('by')).toEqual(['https://semblance.dev/ns/dragdrop#Keyboard'])
    expect(live()).toBe('Dark mode for the editor: Backlog, before Bug: search drops accents.')
    s.key(s.item('Dark mode'), 'ArrowDown')
    expect(live()).toBe('Dark mode for the editor: Backlog, before Profile the board.')
    s.key(s.item('Dark mode'), 'ArrowDown')
    expect(live()).toBe('Dark mode for the editor: Backlog, after Profile the board.')
    s.key(s.item('Dark mode'), 'ArrowDown')
    expect(s.current('after')).toEqual(['task-profile'])
    s.key(s.item('Dark mode'), 'ArrowRight')
    expect(live()).toBe('Dark mode for the editor: Today refuses it: Today holds two tasks at most.')
    s.key(s.item('Dark mode'), 'ArrowRight')
    expect(s.current('into')).toEqual(['dndBugs'])
    s.key(s.item('Dark mode'), 'ArrowRight')
    expect(s.current('into')).toEqual(['dndBugs'])
    s.key(s.item('Dark mode'), 'ArrowLeft')
    s.key(s.item('Dark mode'), 'ArrowLeft')
    s.key(s.item('Dark mode'), 'ArrowUp')
    s.key(s.item('Dark mode'), 'ArrowUp')
    s.key(s.item('Dark mode'), 'ArrowUp')
    expect([s.current('into'), s.current('before')]).toEqual([['dndBacklog'], ['task-notes']])
    s.key(s.item('Dark mode'), 'Enter')
    expect(s.labels('dndBacklog')[0]).toBe('Dark mode for the editor')
    expect(rank(s, 'task-dark')).toEqual(['0^^integer'])
    expect(live()).toBe('')
    // The arrows are the board's again once nothing is held; Escape cancels a held one.
    s.key(s.item('Profile'), ' ')
    s.key(s.item('Profile'), 'ArrowRight')
    s.key(s.item('Profile'), 'Escape')
    expect(s.current('carrying')).toEqual([])
    expect(s.labels('dndBacklog')).toContain('Profile the board')
    // Space anywhere else is not a pickup.
    s.key(s.item('Profile').querySelector('input')!, ' ')
    expect(s.current('carrying')).toEqual([])
  })

  it('renders the same with SPARQL and with function rules, before, during and after a drag', () => {
    const [a, b] = (['sparql', 'function'] as const).map((prefer) => shelves(prefer))
    const html = (h: ReturnType<typeof shelves>) => h.root().outerHTML
    expect(html(b!)).toBe(html(a!))
    for (const h of [a!, b!]) h.drag('Dark mode', ...at(1, 1), true)
    expect(html(b!)).toBe(html(a!))
    for (const h of [a!, b!]) h.pointer(h.document, 'pointermove', ...at(0, 3)), h.shell.flush()
    expect(html(b!)).toBe(html(a!))
    for (const h of [a!, b!]) h.pointer(h.document, 'pointerup', ...at(0, 3)), h.shell.flush()
    expect(html(b!)).toBe(html(a!))
    for (const h of [a!, b!]) h.drag('Profile', ...at(2, 0))
    expect(html(b!)).toBe(html(a!))
    expect(html(a!)).toContain('data-sem-refused')
    for (const h of [a!, b!]) h.drag('Profile', ...at(1, 2))
    expect(rank(b!, 'task-profile')).toEqual(rank(a!, 'task-profile'))
    expect(html(b!)).toBe(html(a!))
  })

  it('a drag-over costs the same however long the list is, and a drop a few rule runs', () => {
    const s = shelves()
    const counters = { read: 0, sparqlRows: 0 }
    const { match, select, construct } = s.store
    s.store.match = (...args) => {
      const quads = match.apply(s.store, args)
      counters.read += quads.length
      return quads
    }
    s.store.select = (...args) => {
      const rows = select.apply(s.store, args)
      counters.sparqlRows += rows.length
      return rows
    }
    s.store.construct = (...args) => {
      const quads = construct.apply(s.store, args)
      counters.sparqlRows += quads.length
      return quads
    }
    const snapshot = () => ({
      ruleRuns: s.screen.engine.stats.ruleRuns,
      written: s.screen.engine.stats.derivedAdded + s.screen.engine.stats.derivedRemoved,
      read: counters.read,
      sparqlRows: counters.sparqlRows,
      domOps: s.shell.ops,
    })
    const measure = (action: () => void) => {
      const a = snapshot()
      action()
      const b = snapshot()
      return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v - a[k as keyof typeof a]]))
    }
    const move = (x: number, y: number) => (s.pointer(s.document, 'pointermove', x, y), s.shell.flush())
    const round = () => {
      s.drag('Dark mode', ...at(0, 0), true)
      // Two moves between positions in the same list (before the first task, before the fourth).
      const over = measure(() => (move(...at(0, 3)), move(...at(0, 0))))
      const across = measure(() => (move(...at(1, 0)), move(...at(0, 0))))
      move(...at(0, 3))
      const drop = measure(() => (s.pointer(s.document, 'pointerup', ...at(0, 3)), s.shell.flush()))
      // Back where it was, for the next round.
      s.drag('Dark mode', ...at(0, 1))
      return { over, across, drop }
    }
    const small = round()
    // 300 more tasks in the backlog, all after the ones the drag passes.
    const f = s.store.factory
    const add = []
    for (let i = 0; i < 300; i++) {
      const task = f.namedNode(UI + 'task-more-' + i)
      add.push(f.quad(task, f.namedNode(RDFS + 'label'), f.literal('More work ' + i)), f.quad(task, f.namedNode(UI + 'rank'), f.literal(String(10 + i), f.namedNode('http://www.w3.org/2001/XMLSchema#integer'))))
      add.push(f.quad(f.namedNode(UI + 'dndBacklog'), f.namedNode('https://semblance.dev/ns/component#item'), task))
    }
    s.runtime.apply({ add, remove: [] })
    s.shell.flush()
    expect(s.labels('dndBacklog')).toHaveLength(304)
    const big = round()
    expect(big.over).toEqual(small.over)
    expect(big.across).toEqual(small.across)
    // Per move: the hovered list's marks, the lifted task's status, and the tooltip layer re-reading what changed under them.
    expect(small.over.ruleRuns).toBeLessThanOrEqual(12)
    // A drop: the task's place and view, the toast, and every list's reception taken down (the
    // layers that read a list re-run once for it).
    expect(big.drop.ruleRuns).toBe(small.drop.ruleRuns)
    expect(small.drop.ruleRuns).toBeLessThanOrEqual(40)
    console.log('drag over (two moves):', small.over, '\nacross lists (two moves):', small.across, '\ndrop:', small.drop, '\ndrop, 300 more tasks:', big.drop)
  })
})
