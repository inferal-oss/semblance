import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { mountShell } from './harness.ts'
import { expectSameRendering, implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const NET = NS.net

/** The demo shell on the Components page, showing the Inspection group. */
function inspection(kind: 'oxigraph' | 'n3' | 'wat' | 'rust', prefer: 'sparql' | 'function') {
  const shell = mountShell(5, kind, prefer)
  shell.showPage('Components')
  const { store, runtime } = shell
  const f = store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  runtime.apply({ remove: store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupInspection'))] })
  shell.shell.flush()
  const root = (id: string) => {
    const el = shell.shell.nodeOf(`${UI}${id}/~root`) as HTMLElement | undefined
    return el && shell.document.contains(el) ? el : null
  }
  const values = (s: string, p: string) => store.match(f.namedNode(UI + s), f.namedNode(p), null).map((q) => q.object.value)
  const press = (el: Element, key: string) => {
    const e = new shell.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
    el.dispatchEvent(e)
    return e.defaultPrevented
  }
  return { ...shell, root, values, press, f }
}

describe('toolbar components: implementations', () => {
  it('has a SPARQL and a function rule for every rendering', () => {
    expect(implementationGaps(['components/toolbar.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })
  it('renders the same with SPARQL and with function rules', () => {
    expectSameRendering(['GroupInspection'])
  })
})

// SPARQL rules and reactions on Oxigraph; the function rules and reactions with functions preferred and on N3.
describe.each([
  ['oxigraph', 'sparql'],
  ['oxigraph', 'function'],
  ['n3', 'function'],
  ['wat', 'sparql'],
  ['rust', 'sparql'],
] as const)('toolbar components (%s, %s)', (kind, prefer) => {
  it('a toolbar is a named row of its children', () => {
    const { root } = inspection(kind, prefer)
    const bar = root('in-tb-bar')!
    expect(bar.getAttribute('data-sem-c')).toBe('toolbar')
    expect(bar.getAttribute('role')).toBe('toolbar')
    expect(bar.getAttribute('aria-label')).toBe('Filters')
    expect(bar.querySelector('input[type=search]')).not.toBeNull()
    expect(bar.querySelector('select')).not.toBeNull()
    expect(bar.querySelector('[role=switch]')).not.toBeNull()
  })

  it('a search field writes what is typed to the bound property, and removes it when emptied, cleared or escaped', () => {
    const { root, fire, values, press } = inspection(kind, prefer)
    const field = () => root('in-tb-search')!
    const input = () => field().querySelector('input')!
    expect(input().getAttribute('aria-label')).toBe('Filter entries')
    expect(input().getAttribute('placeholder')).toBe('Filter URL, event or correlation…')
    expect(field().querySelector('.sem-clear')).toBeNull()
    input().value = 'todos'
    fire(input(), 'input')
    expect(values('in-tb-filter', UI + 'in-tb-text')).toEqual(['todos'])
    expect(input().getAttribute('value')).toBe('todos')
    expect(field().querySelector('.sem-clear')!.getAttribute('aria-label')).toBe('Clear search')
    input().value = ''
    fire(input(), 'input')
    expect(values('in-tb-filter', UI + 'in-tb-text')).toEqual([])
    expect(field().querySelector('.sem-clear')).toBeNull()
    input().value = 'api'
    fire(input(), 'input')
    fire(field().querySelector('.sem-clear span')!, 'click')
    expect(values('in-tb-filter', UI + 'in-tb-text')).toEqual([])
    input().value = 'socket'
    fire(input(), 'input')
    expect(press(input(), 'Escape')).toBe(true)
    expect(values('in-tb-filter', UI + 'in-tb-text')).toEqual([])
    // With nothing to clear, Escape is left alone.
    expect(press(input(), 'Escape')).toBe(false)
  })

  it('a legend lists categories in order, each in its swatch color or tone', () => {
    const { root } = inspection(kind, prefer)
    const kinds = root('in-tb-kinds')!
    expect(kinds.getAttribute('role')).toBe('list')
    expect(kinds.getAttribute('aria-label')).toBe('Activity kinds')
    const items = [...kinds.querySelectorAll('li')]
    expect(items.map((li) => li.textContent)).toEqual(['HTTP', 'Socket lifetime', 'Sent / received', 'Event'])
    expect(items[0]!.querySelector('.sem-swatch')!.getAttribute('style')).toBe('--swatch: var(--sem-series-1)')
    expect(items[0]!.querySelector('.sem-swatch')!.getAttribute('aria-hidden')).toBe('true')
    const statuses = [...root('in-tb-statuses')!.querySelectorAll('li')]
    expect(statuses.map((li) => li.textContent)).toEqual(['Pending', 'Complete', 'Failed', 'Open', 'Closed'])
    expect(statuses.map((li) => li.querySelector('.sem-swatch')!.getAttribute('data-sem-tone'))).toEqual(['warning', 'success', 'danger', 'info', 'neutral'])
  })

  it('a live indicator shows a boolean and flips it', () => {
    const { root, fire, values } = inspection(kind, prefer)
    const live = () => root('in-tb-live-capture')!
    expect(live().tagName).toBe('BUTTON')
    expect(live().getAttribute('aria-pressed')).toBe('true')
    expect(live().getAttribute('aria-label')).toBe('Recording')
    expect(live().textContent).toBe('Recording')
    fire(live().querySelector('.sem-state')!, 'click')
    expect(values('in-tb-recorder', UI + 'in-tb-recording')).toEqual(['false'])
    expect(live().getAttribute('aria-pressed')).toBe('false')
    expect(live().textContent).toBe('Paused')
    fire(live(), 'click')
    expect(values('in-tb-recorder', UI + 'in-tb-recording')).toEqual(['true'])
    // Its own state, with its own words.
    const own = () => root('in-tb-live-own')!
    expect(own().textContent).toBe('Live')
    fire(own(), 'click')
    expect(values('in-tb-live-own', NS.c + 'checked')).toEqual(['false'])
    expect(own().textContent).toBe('Frozen')
    expect(own().getAttribute('aria-label')).toBe('Live')
  })

  it('a count badge counts members, of a class too, and follows the collection', () => {
    const { root, fire, runtime, f, shell } = inspection(kind, prefer)
    expect(root('in-tb-count-all')!.textContent).toBe('3')
    expect(root('in-tb-count-all')!.getAttribute('aria-label')).toBe('3 entries')
    expect(root('in-tb-count-all')!.getAttribute('role')).toBe('img')
    expect(root('in-tb-count-http')!.textContent).toBe('2')
    // net:Capture holds the network example's sample entries (demo/gallery/_network.ttl).
    expect(root('in-tb-count-capture')!.textContent).toBe('18')
    // The demo's add button is a SPARQL-only reaction; N3 has no SPARQL, so add the member directly.
    if (kind === 'n3') {
      const m = f.namedNode(UI + 'in-tb-e4')
      runtime.apply({ remove: [], add: [f.quad(f.namedNode(UI + 'in-tb-stream'), f.namedNode(NS.tree + 'member'), m), f.quad(m, f.namedNode(NS.rdf + 'type'), f.namedNode(NET + 'Event'))] })
      shell.flush()
    } else fire(root('in-tb-add')!, 'click')
    expect(root('in-tb-count-all')!.textContent).toBe('4')
    expect(root('in-tb-count-http')!.textContent).toBe('2')
    const e = f.namedNode('urn:test:exchange')
    runtime.apply({
      remove: [],
      add: [f.quad(f.namedNode(NET + 'Capture'), f.namedNode(NS.tree + 'member'), e), f.quad(e, f.namedNode(NS.rdf + 'type'), f.namedNode(NET + 'Exchange'))],
    })
    shell.flush()
    expect(root('in-tb-count-capture')!.textContent).toBe('19')
  })
})
