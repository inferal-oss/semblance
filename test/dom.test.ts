import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { EX, todoReactions } from '../src/examples/todo.ts'
import { BEH, C, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML } from '../src/render/serialize.ts'
import { setup, todo } from './helpers.ts'

function mount(n = 5) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="host"></div></body></html>')
  const env = setup('oxigraph', {}, n)
  const host = document.getElementById('host')!
  const dom = new DomRenderer(env.screen.index, host, EX + 'page')
  dom.flush()
  return { ...env, document, window, host, dom, t: todo(env.store) }
}

/** Attribute order is insertion order in the DOM; compare markup with attributes sorted. */
const normalize = (html: string) =>
  html.replace(/<([a-z]+)((?:\s[a-z-]+(?:="[^"]*")?)*)>/g, (_, tag: string, attrs: string) => {
    const list = attrs.match(/\s[a-z-]+(?:="[^"]*")?/g) ?? []
    return `<${tag}${list.sort().join('')}>`
  })

const labels = (host: Element) => [...host.querySelectorAll('li label')].map((l) => l.textContent)

describe('DOM renderer', () => {
  it('mounts the same markup the serializer produces', () => {
    const { host, screen } = mount()
    expect(normalize(host.innerHTML)).toBe(normalize(toHTML(screen.index, EX + 'page')))
  })

  it('patches in place and keeps node identity', () => {
    const { host, runtime, dom, t } = mount(50)
    const li = host.querySelectorAll('li')[3]!
    const checkbox = li.querySelector('input')!
    const ops = dom.ops
    runtime.apply(t.set('t4', 'done', true))
    dom.flush()
    expect(host.querySelectorAll('li')[3]).toBe(li)
    expect(li.querySelector('input')).toBe(checkbox)
    expect(dom.ops - ops).toBeLessThanOrEqual(2)
  })

  it('moves a single node when one item is reordered', () => {
    const { host, runtime, dom, t } = mount(50)
    const first = host.querySelector('li')!
    const before = labels(host)
    const ops = dom.ops
    runtime.apply(t.set('t1', 'priority', 10_000))
    dom.flush()
    expect(host.querySelector('ul')!.lastElementChild).toBe(first)
    expect(labels(host)).toEqual([...before.slice(1), before[0]])
    expect(dom.ops - ops).toBe(1)
  })

  it('adds and removes items', () => {
    const { host, runtime, dom, t } = mount()
    runtime.apply(t.addItem('fresh', 'Fresh item', -1))
    dom.flush()
    expect(labels(host)[0]).toBe('Fresh item')
    runtime.apply(t.removeItem('fresh'))
    dom.flush()
    expect(labels(host)).not.toContain('Fresh item')
  })
})

describe('behaviour layer', () => {
  for (const prefer of ['sparql', 'function'] as const) {
    it(`records interactions as RDF events whose reactions change state (${prefer} reactions)`, () => {
      const { host, runtime, screen, dom, window, store, t } = mount()
      const bus = new EventBus(runtime, screen, { functions: todoReactions, prefer })
      const handled: string[][] = []
      bus.attach(dom, (h) => {
        handled.push(h.reactions.map((r) => r.split('#')[1]!))
        dom.flush()
      })
      const value = () => store.match(t.nn('newTodo'), t.nn(C.value), null, store.factory.defaultGraph())[0]?.object.value
      const fire = (el: Element, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true }))

      // Adding with an empty field sets an error, which the a11y layer announces.
      // AddTodo matched too but changed nothing, so only RequireText handled it.
      fire(host.querySelector('button')!, 'click')
      expect(handled.at(-1)).toEqual(['RequireText'])
      const input = host.querySelector('input[type=text]') as HTMLInputElement
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(host.querySelector('[role=alert]')!.textContent).toBe('Please describe the todo first.')

      // Typing is an RDF event; the TextField's own reaction stores the value and clears the error.
      input.value = 'Ship the spike'
      fire(input, 'input')
      expect(handled.at(-1)).toEqual(['TypeText'])
      expect(value()).toBe('Ship the spike')
      expect(input.hasAttribute('aria-invalid')).toBe(false)

      fire(host.querySelector('button')!, 'click')
      expect(handled.at(-1)).toEqual(['AddTodo'])
      expect(labels(host)).toContain('Ship the spike')
      expect(value()).toBeUndefined()

      // The checkbox's change is addressed to the ListItem, whose reaction writes ex:done.
      const box = host.querySelector('li input') as HTMLInputElement
      const done = () => store.match(t.nn('t1'), t.nn('done'), null, store.factory.defaultGraph())[0]?.object.value
      expect(done()).toBe('true')
      box.checked = false
      fire(box, 'change')
      expect(handled.at(-1)).toEqual(['ListItemChange'])
      expect(done()).toBe('false')

      // Density is one triple; the style layer re-hooks the page root.
      fire(host.querySelectorAll('button')[1]!, 'click')
      expect(host.querySelector('[data-sem-c=stack]')!.getAttribute('data-sem-density')).toBe('compact')

      // Clicks nobody reacts to are not recorded; the log holds what happened.
      fire(host.querySelector('h1')!, 'click')
      const log = bus.recent(10)
      expect(log).toHaveLength(5)
      const latest = log[0]!
      expect(latest.find((q) => q.predicate.value === BEH.target)?.object.value).toBe(EX + 'density')
      expect(latest.find((q) => q.predicate.value === BEH.handledBy)?.object.value).toBe(EX + 'ToggleDensity')
    })
  }
})
