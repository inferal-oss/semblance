import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { EX, todoApp, todoReactions } from '../src/examples/todo.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import type { HostContext, HostRenderer } from '../src/render/hosts.ts'
import { toHTML } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'
import { DEFAULT_LAYERS } from '../src/web/mount.ts'
import { type ReactHosts, reactHosts } from '../packages/react/src/server.ts'
import { components } from '../examples/react/design-system.tsx'
import { createElement } from 'react'

// Hosted components (docs/HOSTED.md): the todo app's graph, unchanged, drawn by the example's design
// system (examples/react) through @inferal-oss/semblance-react. Driven through DOM events on what
// React drew, as a person would; the graph and the DOM are both checked.

const read = (f: string) => readFileSync(new URL('../examples/react/' + f, import.meta.url), 'utf8')
const bindings = read('bindings.ttl')
const T = 'https://example.org/hosted-test#'

/** A hosted component of the test's own that only reports through a callback (ext:output). */
const stars = `
@prefix sem: <${NS.sem}> . @prefix c: <${NS.c}> . @prefix ext: <${NS.ext}> . @prefix beh: <${NS.beh}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix t: <${T}> .
t:Stars a owl:Class ; rdfs:subClassOf sem:Component , ext:Hosted ; sem:slug "t-stars" ; ext:component "Stars" ;
    ext:input [ ext:name "value" ; ext:from c:value ] ;
    ext:output [ ext:on "onPick" ; ext:emits t:Picked ; ext:path "value" ] .
t:Picked rdfs:subClassOf ext:Output .
t:StarsRendering a sem:Rendering ; sem:targets t:Stars ; sem:stratum 0 .
t:StarsRendering-sparql a sem:Rule ; sem:implements t:StarsRendering ; sem:construct """
CONSTRUCT { ?root a rdfhtml:Div ; sem:renders $this . } WHERE { BIND(IRI(CONCAT(STR($this), "/~root")) AS ?root) }""" .
t:Pick a beh:Reaction ; beh:when t:Picked ; beh:sourceClass t:Stars ;
    beh:deletes """CONSTRUCT { $this c:value ?old } WHERE { $this c:value ?old }""" ;
    beh:inserts """CONSTRUCT { $this c:value ?n } WHERE { $event beh:value ?raw BIND(xsd:integer(?raw) AS ?n) }""" .
t:rating a t:Stars ; c:value 2 .
`

function Stars({ root, value, onPick }: { root: object; value?: number; onPick?: (p: { value: number }) => void }) {
  return createElement(
    'div',
    { ...root, className: 't-stars' },
    [1, 2, 3, 4, 5].map((n) => createElement('button', { key: n, type: 'button', 'aria-pressed': n <= (value ?? 0), onClick: () => onPick?.({ value: n }) }, '★')),
  )
}

/** The todo app's page with `n` todos, drawn by the design system (or by nothing: `hosts: false`). */
function mount(opts: { n?: number; kind?: 'wat' | 'oxigraph'; prefer?: 'sparql' | 'function'; hosts?: HostRenderer | false; extra?: string[]; html?: string } = {}) {
  // The test's own hosted component (stars) goes at the end of the page.
  const app = todoApp(opts.n ?? 5)
  const page = opts.extra?.includes(stars) ? app.replace('c:children ( ex:title ex:newTodo ex:actions ex:todos )', `c:children ( ex:title ex:newTodo ex:actions ex:todos <${T}rating> )`) : app
  const store = loadStore(opts.kind ?? 'wat', page, bindings, ...(opts.extra ?? []))
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, prefer: opts.prefer ?? 'sparql', name: 'screen', roots: [EX + 'page'] }, (e) => {
    throw e
  })
  const { document, window } = parseHTML(`<!doctype html><html><head></head><body><div id="app">${opts.html ?? ''}</div></body></html>`)
  // React DOM reads the global window (the current event's priority): the document's, as in a browser.
  Object.assign(globalThis, { window })
  const make = opts.hosts === false ? undefined : (opts.hosts ?? reactHosts({ components: { ...components, Stars } }))
  const ctx: HostContext = { runtime, projection: screen }
  const hosts = make?.(screen.index, ctx)
  const renderer = new DomRenderer(screen.index, document.getElementById('app')!, EX + 'page', hosts)
  const adopted = opts.html !== undefined ? renderer.adopt() : undefined
  renderer.flush()
  const bus = new EventBus(runtime, screen, { functions: todoReactions })
  ctx.bus = bus
  ctx.onHandled = () => renderer.flush()
  bus.attach(renderer, () => renderer.flush())
  const f = store.factory
  const value = (s: string, p: string) => store.match(f.namedNode(s), f.namedNode(p), null, f.defaultGraph()).map((q) => q.object.value)
  const fire = (el: Element, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true }))
  const $ = (sel: string) => document.querySelector(sel) as HTMLElement
  const $$ = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[]
  return { store, runtime, screen, document, window, renderer, bus, hosts: hosts as ReactHosts | undefined, value, fire, $, $$, adopted, f }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('hosted components (React)', () => {
  it('draws the projected components with the design system, children inside, in one host element', () => {
    const h = mount()
    expect(h.$$('sem-host')).toHaveLength(1)
    const page = h.$('sem-host > .ds-stack')
    expect(page.getAttribute('data-sem-c')).toBe('stack')
    expect(h.renderer.keyOf(page)).toBe(EX + 'page/~root')
    expect(h.$('.ds-heading').tagName.toLowerCase()).toBe('h1')
    expect(h.$('.ds-heading').textContent).toBe('Todos')
    const add = h.$$('.ds-button').find((b) => b.textContent === 'Add')!
    expect(add.className).toContain('ds-button--primary')
    // Projected children inside a hosted component, and plain elements React drew for them.
    expect(h.$$('.ds-list > li')).toHaveLength(5)
    expect(h.$('.ds-field input').getAttribute('placeholder')).toBe('What needs doing?')
    expect(h.renderer.keyOf(h.$('.ds-field input'))).toBe(EX + 'newTodo/~input')
  })

  for (const kind of ['wat', 'oxigraph'] as const) {
    it(`the SPARQL rule and its function twin state the same on every root (${kind})`, () => {
      const sparql = mount({ kind, extra: [stars] })
      const fn = mount({ kind, prefer: 'function', extra: [stars] })
      const derived = (h: ReturnType<typeof mount>) => {
        const index = h.screen.index
        return [...index.nodes.keys()]
          .filter((k) => index.nodes.get(k)!.component !== undefined)
          .sort()
          .map((k) => `${k} ${index.nodes.get(k)!.component} ${JSON.stringify([...index.islandInputs(k)].map(([n, i]) => [n, i.value.value, i.as]))}`)
      }
      expect(derived(sparql).length).toBeGreaterThan(5)
      expect(derived(fn)).toEqual(derived(sparql))
      expect(toHTML(fn.screen.index, EX + 'page', { hosts: fn.hosts })).toBe(toHTML(sparql.screen.index, EX + 'page', { hosts: sparql.hosts }))
      // Props arrive typed, an IRI by its slug.
      expect(sparql.screen.index.islandInputs(EX + 'add/~root').get('intent')?.value.value).toBe('primary')
    })
  }

  it('events on what React drew are the components’ events: type, add, tick', () => {
    const h = mount()
    const input = h.$('.ds-field input') as HTMLInputElement
    input.value = 'Write the guide'
    h.fire(input, 'input')
    expect(h.value(EX + 'newTodo', NS.c + 'value')).toEqual(['Write the guide'])
    const add = h.$$('.ds-button').find((b) => b.textContent === 'Add')!
    h.fire(add, 'click')
    expect(h.$$('.ds-list > li')).toHaveLength(6)
    expect(h.$$('.ds-list label').map((l) => l.textContent)).toContain('Write the guide')
    // The field was emptied by the reaction, and shows it.
    expect(h.value(EX + 'newTodo', NS.c + 'value')).toEqual([])
    expect((h.$('.ds-field input') as HTMLInputElement).value).toBe('')
    // The same button element: React updated it, nothing was created again.
    expect(h.$$('.ds-button').find((b) => b.textContent === 'Add')).toBe(add)
    const t2 = () => h.$$('.ds-list > li').find((li) => li.textContent === 'Sketch the style layer')!.querySelector('input') as HTMLInputElement
    const box = t2()
    expect(box.checked).toBe(false)
    box.checked = true
    h.fire(box, 'change')
    expect(h.value(EX + 't2', EX + 'done')).toEqual(['true'])
    expect(t2()).toBe(box)
    expect(box.checked).toBe(true)
  })

  it('an empty add is refused by the app’s reaction, and the design system shows the error', () => {
    const h = mount()
    h.fire(h.$$('.ds-button').find((b) => b.textContent === 'Add')!, 'click')
    expect(h.value(EX + 'newTodo', NS.c + 'error')).toHaveLength(1)
    expect(h.$('.ds-field').className).toContain('ds-field--invalid')
  })

  it('nested hosted components are one React tree: a stack’s density reaches the buttons through context', () => {
    const h = mount()
    const buttons = () => h.$$('.ds-button')
    expect(buttons().every((b) => !b.className.includes('ds-button--small'))).toBe(true)
    h.fire(buttons().find((b) => b.textContent === 'Toggle density')!, 'click')
    expect(h.value(EX + 'page', STY.density)).toEqual([NS.sty + 'Compact'])
    expect(buttons().every((b) => b.className.includes('ds-button--small'))).toBe(true)
    expect(h.$$('sem-host')).toHaveLength(1)
  })

  it('a callback output becomes the component’s event, and its new value comes back as a prop', () => {
    const h = mount({ extra: [stars] })
    const star = (i: number) => h.$$('.t-stars button')[i]!
    expect(star(1).getAttribute('aria-pressed')).toBe('true')
    expect(star(3).getAttribute('aria-pressed')).toBe('false')
    h.fire(star(3), 'click')
    expect(h.value(T + 'rating', NS.c + 'value')).toEqual(['4'])
    expect(star(3).getAttribute('aria-pressed')).toBe('true')
    expect(h.hosts!.counts.outputs).toBe(1)
  })

  it('a change re-renders what it changed, however many todos there are', () => {
    const cost = (n: number) => {
      const h = mount({ n })
      const before = h.hosts!.counts.renders
      const box = h.$$('.ds-list input[type=checkbox]')[1] as HTMLInputElement
      box.checked = !box.checked
      h.fire(box, 'change')
      return h.hosts!.counts.renders - before
    }
    const small = cost(5)
    expect(small).toBeGreaterThan(0)
    expect(small).toBeLessThan(10)
    expect(cost(40)).toBe(small)
  })

  it('server rendering writes the design system’s markup, and the client hydrates it in place', async () => {
    const server = mount({ hosts: reactHosts({ components: { ...components, Stars } }) })
    const html = toHTML(server.screen.index, EX + 'page', { hosts: server.hosts })
    expect(html.startsWith('<sem-host><div data-sem-c="stack"')).toBe(true)
    expect(html).toContain('class="ds-button ds-button--primary">Add</button>')
    const client = mount({ html })
    expect(client.adopted!.mismatches).toBe(0)
    await settle()
    expect(client.hosts!.counts.hydrations).toBe(1)
    expect(client.hosts!.counts.mounts).toBe(0)
    // The server's elements are React's now: a click on the server's button works.
    const input = client.$('.ds-field input') as HTMLInputElement
    input.value = 'Hydrated'
    client.fire(input, 'input')
    client.fire(client.$$('.ds-button').find((b) => b.textContent === 'Add')!, 'click')
    expect(client.$$('.ds-list label').map((l) => l.textContent)).toContain('Hydrated')
  })

  it('every theme reaches the design system: the theme hook on its root, every token it reads defined', () => {
    const h = mount()
    const css = read('design-system.css')
    const read_ = [...new Set([...css.matchAll(/var\(--sem-([a-z0-9-]+)/g)].map((m) => m[1]!))]
    const compiled = compileStyles(h.store)
    for (const token of read_) expect(compiled, token).toContain(`--sem-${token}:`)
    const themes = h.store.match(null, h.f.namedNode(NS.rdf + 'type'), h.f.namedNode(NS.sty + 'Theme'), h.f.defaultGraph()).map((q) => q.subject.value)
    expect(themes.length).toBeGreaterThanOrEqual(10)
    const page = h.f.namedNode(EX + 'page')
    for (const theme of themes) {
      const slug = h.store.match(h.f.namedNode(theme), h.f.namedNode(NS.sem + 'slug'), null, h.f.defaultGraph())[0]!.object.value
      h.runtime.apply({ remove: h.store.match(page, h.f.namedNode(NS.sty + 'theme'), null, h.f.defaultGraph()), add: [h.f.quad(page, h.f.namedNode(NS.sty + 'theme'), h.f.namedNode(theme))] })
      h.renderer.flush()
      expect(h.$('sem-host > .ds-stack').getAttribute('data-sem-theme'), theme).toBe(slug)
    }
  })

  it('a name the adapter does not have, or a policy refuses, renders as the projection', () => {
    const h = mount({ hosts: reactHosts({ components: { Stack: components.Stack } }) })
    expect(h.$('h1:not(.ds-heading)')?.textContent).toBe('Todos')
    expect(h.$$('.ds-button')).toHaveLength(0)

  })
})
