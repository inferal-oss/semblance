import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { mountShell } from './harness.ts'
import { expectSameRendering, implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const NET = NS.net

/** The demo shell on the Components page, showing a gallery group (the toolbar is on Actions, the legend on Data, the live indicator and the count badge on Feedback). */
function gallery(page: string, kind: 'oxigraph' | 'n3' | 'wat' | 'rust', prefer: 'sparql' | 'function') {
  const shell = mountShell(5, kind, prefer)
  shell.showPage('Components')
  const { store, runtime } = shell
  const f = store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  runtime.apply({ remove: store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + page))] })
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
    expectSameRendering(['GroupActions', 'GroupData', 'GroupFeedback'])
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
    const { root } = gallery('GroupActions', kind, prefer)
    const bar = root('act-tb-bar')!
    expect(bar.getAttribute('data-sem-c')).toBe('toolbar')
    expect(bar.getAttribute('role')).toBe('toolbar')
    expect(bar.getAttribute('aria-label')).toBe('Filters')
    expect(bar.querySelector('input[type=search]')).not.toBeNull()
    expect(bar.querySelector('select')).not.toBeNull()
    expect(bar.querySelector('[role=switch]')).not.toBeNull()
  })

  it('a search field writes what is typed to the bound property, and removes it when emptied, cleared or escaped', () => {
    const { root, fire, values, press } = gallery('GroupActions', kind, prefer)
    const field = () => root('act-tb-search')!
    const input = () => field().querySelector('input')!
    expect(input().getAttribute('aria-label')).toBe('Filter entries')
    expect(input().getAttribute('placeholder')).toBe('Filter URL, event or correlation…')
    expect(field().querySelector('.sem-clear')).toBeNull()
    input().value = 'todos'
    fire(input(), 'input')
    expect(values('act-tb-filter', UI + 'act-tb-text')).toEqual(['todos'])
    expect(input().getAttribute('value')).toBe('todos')
    expect(field().querySelector('.sem-clear')!.getAttribute('aria-label')).toBe('Clear search')
    input().value = ''
    fire(input(), 'input')
    expect(values('act-tb-filter', UI + 'act-tb-text')).toEqual([])
    expect(field().querySelector('.sem-clear')).toBeNull()
    input().value = 'api'
    fire(input(), 'input')
    fire(field().querySelector('.sem-clear span')!, 'click')
    expect(values('act-tb-filter', UI + 'act-tb-text')).toEqual([])
    input().value = 'socket'
    fire(input(), 'input')
    expect(press(input(), 'Escape')).toBe(true)
    expect(values('act-tb-filter', UI + 'act-tb-text')).toEqual([])
    // With nothing to clear, Escape is left alone.
    expect(press(input(), 'Escape')).toBe(false)
  })

  it('keeps a disabled search field inert and enables it when the graph changes', () => {
    const { root, fire, values, press, runtime, shell, f } = gallery('GroupActions', kind, prefer)
    const field = () => root('act-tb-search')!
    const input = () => field().querySelector('input')!
    input().value = 'socket'
    fire(input(), 'input')
    expect(values('act-tb-filter', UI + 'act-tb-text')).toEqual(['socket'])

    const disabled = f.quad(f.namedNode(UI + 'act-tb-search'), f.namedNode(NS.c + 'disabled'),
      f.literal('true', f.namedNode('http://www.w3.org/2001/XMLSchema#boolean')))
    runtime.apply({ add: [disabled], remove: [] })
    shell.flush()
    expect(input().hasAttribute('disabled')).toBe(true)
    expect(field().querySelector('.sem-clear')!.hasAttribute('disabled')).toBe(true)
    input().value = 'changed'
    fire(input(), 'input')
    fire(field().querySelector('.sem-clear')!, 'click')
    press(input(), 'Escape')
    expect(values('act-tb-filter', UI + 'act-tb-text')).toEqual(['socket'])

    runtime.apply({ add: [], remove: [disabled] })
    shell.flush()
    expect(input().hasAttribute('disabled')).toBe(false)
    expect(field().querySelector('.sem-clear')!.hasAttribute('disabled')).toBe(false)
    fire(field().querySelector('.sem-clear')!, 'click')
    expect(values('act-tb-filter', UI + 'act-tb-text')).toEqual([])
  })

  it('a legend lists categories in order, each in its swatch color or tone', () => {
    const { root } = gallery('GroupData', kind, prefer)
    const kinds = root('dt-legend-kinds')!
    expect(kinds.getAttribute('role')).toBe('list')
    expect(kinds.getAttribute('aria-label')).toBe('Activity kinds')
    const items = [...kinds.querySelectorAll('li')]
    expect(items.map((li) => li.textContent)).toEqual(['HTTP', 'Socket lifetime', 'Sent / received', 'Event'])
    expect(items[0]!.querySelector('.sem-swatch')!.getAttribute('style')).toBe('--swatch: var(--sem-series-1)')
    expect(items[0]!.querySelector('.sem-swatch')!.getAttribute('aria-hidden')).toBe('true')
    const statuses = [...root('dt-legend-statuses')!.querySelectorAll('li')]
    expect(statuses.map((li) => li.textContent)).toEqual(['Pending', 'Complete', 'Failed', 'Open', 'Closed'])
    expect(statuses.map((li) => li.querySelector('.sem-swatch')!.getAttribute('data-sem-tone'))).toEqual(['warning', 'success', 'danger', 'info', 'neutral'])
  })

  it('a live indicator shows a boolean and flips it', () => {
    const { root, fire, values } = gallery('GroupFeedback', kind, prefer)
    const live = () => root('fb-live-capture')!
    expect(live().tagName).toBe('BUTTON')
    expect(live().getAttribute('aria-pressed')).toBe('true')
    expect(live().getAttribute('aria-label')).toBe('Recording')
    expect(live().textContent).toBe('Recording')
    fire(live().querySelector('.sem-state')!, 'click')
    expect(values('fb-live-recorder', UI + 'fb-live-recording')).toEqual(['false'])
    expect(live().getAttribute('aria-pressed')).toBe('false')
    expect(live().textContent).toBe('Paused')
    fire(live(), 'click')
    expect(values('fb-live-recorder', UI + 'fb-live-recording')).toEqual(['true'])
    // Its own state, with its own words.
    const own = () => root('fb-live-own')!
    expect(own().textContent).toBe('Live')
    fire(own(), 'click')
    expect(values('fb-live-own', NS.c + 'checked')).toEqual(['false'])
    expect(own().textContent).toBe('Frozen')
    expect(own().getAttribute('aria-label')).toBe('Live')
  })

  it('a count badge counts members, of a class too, and follows the collection', () => {
    const { root, fire, runtime, f, shell } = gallery('GroupFeedback', kind, prefer)
    expect(root('fb-count-all')!.textContent).toBe('3')
    expect(root('fb-count-all')!.getAttribute('aria-label')).toBe('3 entries')
    expect(root('fb-count-all')!.getAttribute('role')).toBe('img')
    expect(root('fb-count-http')!.textContent).toBe('2')
    // net:Capture holds the network example's sample entries (demo/gallery/_network.ttl).
    expect(root('fb-count-capture')!.textContent).toBe('18')
    // The demo's add button is a SPARQL-only reaction; N3 has no SPARQL, so add the member directly.
    if (kind === 'n3') {
      const m = f.namedNode(UI + 'fb-count-e4')
      runtime.apply({ remove: [], add: [f.quad(f.namedNode(UI + 'fb-count-stream'), f.namedNode(NS.tree + 'member'), m), f.quad(m, f.namedNode(NS.rdf + 'type'), f.namedNode(NET + 'Event'))] })
      shell.flush()
    } else fire(root('fb-count-add')!, 'click')
    expect(root('fb-count-all')!.textContent).toBe('4')
    expect(root('fb-count-http')!.textContent).toBe('2')
    const e = f.namedNode('urn:test:exchange')
    runtime.apply({
      remove: [],
      add: [f.quad(f.namedNode(NET + 'Capture'), f.namedNode(NS.tree + 'member'), e), f.quad(e, f.namedNode(NS.rdf + 'type'), f.namedNode(NET + 'Exchange'))],
    })
    shell.flush()
    expect(root('fb-count-capture')!.textContent).toBe('19')
  })
})
