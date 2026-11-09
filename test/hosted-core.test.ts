import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EX, todoApp } from '../src/examples/todo.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import type { HtmlIndex } from '../src/render/html-index.ts'
import type { HostAdapter } from '../src/render/hosts.ts'
import { toHTML } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { readPolicy, type SafetyPolicy } from '../src/safety.ts'
import { DEFAULT_LAYERS } from '../src/web/mount.ts'

// Hosted components in the core (docs/HOSTED.md): the generic rule that states a hosted component's
// host component and props on its root (SPARQL and its function twin), and the renderer adapter the
// DOM patcher and the HTML serializer go through, with a stand-in adapter that writes a line of text
// per hosted subtree. The React adapter has its own test (test/hosted.test.ts).

const bindings = `
@prefix c: <${NS.c}> . @prefix ext: <${NS.ext}> . @prefix sty: <${NS.sty}> . @prefix pos: <${NS.pos}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
c:Stack rdfs:subClassOf ext:Hosted ; ext:component "Stack" ;
    ext:input [ ext:name "direction" ; ext:from pos:direction ] , [ ext:name "density" ; ext:from sty:density ] .
c:Button rdfs:subClassOf ext:Hosted ; ext:component "Button" ; ext:input [ ext:name "intent" ; ext:from sty:intent ] .
c:TextField rdfs:subClassOf ext:Hosted ; ext:component "Field" .
`

/** A stand-in library: each hosted subtree drawn as one element naming its component and props. */
function standIn(index: HtmlIndex, names = ['Stack', 'Button', 'Field']) {
  const calls = { mounts: 0, hydrations: 0, patches: 0, destroys: 0 }
  const drawn = new Map<string, Element>()
  const html = (k: string) => {
    const props = [...index.islandInputs(k)].map(([n, i]) => `${n}=${i.value.value}`).join(' ')
    return `<x-drawn data-key="${k}" data-component="${index.hostComponent(k)}" data-props="${props}"></x-drawn>`
  }
  const adapter: HostAdapter = {
    has: (name) => names.includes(name),
    mount(container, key, hydrate) {
      if (hydrate) calls.hydrations++
      else (calls.mounts++, (container.innerHTML = html(key)))
      drawn.set(key, container.firstElementChild!)
      return { destroy: () => void calls.destroys++ }
    },
    html,
    patch: () => void calls.patches++,
    keyOf: (node) => [...drawn].find(([, el]) => el === node)?.[0],
    nodeOf: (key) => drawn.get(key),
    dispose() {},
  }
  return { adapter, calls }
}

function project(opts: { kind?: 'wat' | 'oxigraph'; prefer?: 'sparql' | 'function'; extra?: string[]; policy?: SafetyPolicy } = {}) {
  const store = loadStore(opts.kind ?? 'wat', todoApp(5), bindings, ...(opts.extra ?? []))
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, prefer: opts.prefer ?? 'sparql', name: 'screen', roots: [EX + 'page'], policy: opts.policy }, (e) => {
    if (!opts.policy) throw e
  })
  return { store, runtime, screen, f: store.factory }
}

const derived = (index: HtmlIndex) =>
  [...index.nodes.keys()]
    .filter((k) => index.nodes.get(k)!.component !== undefined)
    .sort()
    .map((k) => `${k} ${index.nodes.get(k)!.component} ${JSON.stringify([...index.islandInputs(k)].map(([n, i]) => [n, i.value.value, i.value.termType, i.as]))}`)

describe('hosted components (core)', () => {
  for (const kind of ['wat', 'oxigraph'] as const) {
    it(`the SPARQL rule and its function twin state the same component and props on every hosted root (${kind})`, () => {
      const sparql = project({ kind })
      const fn = project({ kind, prefer: 'function' })
      const roots = derived(sparql.screen.index)
      expect(roots.map((r) => r.split(' ')[0])).toEqual([EX + 'actions/~root', EX + 'add/~root', EX + 'density/~root', EX + 'newTodo/~root', EX + 'page/~root'])
      expect(derived(fn.screen.index)).toEqual(roots)
      // An IRI with a slug arrives as its slug.
      expect(sparql.screen.index.islandInputs(EX + 'page/~root').get('density')?.value.value).toBe('comfortable')
      expect(sparql.screen.index.islandInputs(EX + 'add/~root').get('intent')?.value.value).toBe('primary')
    })
  }

  it('without an adapter (or one that lacks the name) the projection renders as it always has', () => {
    const bound = project()
    const unbound = project({ extra: [] })
    const plain = (() => {
      const store = loadStore('wat', todoApp(5))
      return toHTML(new Runtime(store).project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, prefer: 'sparql', name: 'screen', roots: [EX + 'page'] }).index, EX + 'page')
    })()
    expect(toHTML(bound.screen.index, EX + 'page')).toBe(plain)
    expect(toHTML(unbound.screen.index, EX + 'page', { hosts: standIn(unbound.screen.index, []).adapter })).toBe(plain)
  })

  it('the serializer writes the first hosted node on each path in a <sem-host>, drawn by the adapter', () => {
    const p = project()
    const html = toHTML(p.screen.index, EX + 'page', { hosts: standIn(p.screen.index).adapter })
    expect(html).toBe(`<sem-host><x-drawn data-key="${EX}page/~root" data-component="Stack" data-props="direction=column density=comfortable"></x-drawn></sem-host>`)
    // A name the adapter does not draw: its node is Semblance's element, and hosted nodes under it are drawn.
    const partial = toHTML(p.screen.index, EX + 'page', { hosts: standIn(p.screen.index, ['Button']).adapter })
    expect(partial.match(/<sem-host>/g)).toHaveLength(2)
    expect(partial).toContain('data-component="Button" data-props="intent=primary"')
    // An authored projection (#380) has drawn only what its policy lists (none by default).
    const policy = readPolicy(loadStore('wat'))
    const authored = project({ policy })
    expect(toHTML(authored.screen.index, EX + 'page', { hosts: standIn(authored.screen.index).adapter })).not.toContain('<sem-host>')
    const listed = project({ policy: { ...policy, hostComponents: new Set(['Button']) } })
    expect(toHTML(listed.screen.index, EX + 'page', { hosts: standIn(listed.screen.index).adapter }).match(/<sem-host>/g)).toHaveLength(2)
  })

  it('the patcher hands a hosted subtree to the adapter, asks it after each patch, and finds its nodes', () => {
    const p = project()
    const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    const { adapter, calls } = standIn(p.screen.index, ['Button'])
    const renderer = new DomRenderer(p.screen.index, document.getElementById('app')!, EX + 'page', adapter)
    renderer.flush()
    expect(calls.mounts).toBe(2)
    const hosts = [...document.querySelectorAll('sem-host')]
    expect(hosts).toHaveLength(2)
    const drawn = hosts[0]!.firstElementChild!
    expect(renderer.keyOf(drawn)).toBe(EX + 'add/~root')
    expect(renderer.nodeOf(EX + 'add/~root')).toBe(drawn)
    expect(renderer.keyOf(hosts[0]!)).toBe(EX + 'add/~root')
    const patches = calls.patches
    // A change to the button's props: the adapter is asked; the patcher writes nothing on its element.
    const add = p.f.namedNode(EX + 'add')
    const intent = p.f.namedNode(NS.sty + 'intent')
    p.runtime.apply({ remove: p.store.match(add, intent, null, p.f.defaultGraph()), add: [p.f.quad(add, intent, p.f.namedNode(NS.sty + 'Danger'))] })
    renderer.flush()
    expect(calls.patches).toBe(patches + 1)
    expect(hosts[0]!.attributes.length).toBe(0)
    expect(p.screen.index.islandInputs(EX + 'add/~root').get('intent')?.value.value).toBe('danger')
    // Bound otherwise: the element is made anew (the adapter's drawing destroyed), as Semblance's own.
    p.runtime.apply({ remove: [], add: [p.f.quad(add, p.f.namedNode(NS.ext + 'component'), p.f.literal('Other'))] })
    p.runtime.apply({ remove: p.store.match(p.f.namedNode(NS.c + 'Button'), p.f.namedNode(NS.ext + 'component'), null, p.f.defaultGraph()), add: [] })
    renderer.flush()
    expect(calls.destroys).toBe(1)
    expect(document.querySelectorAll('sem-host')).toHaveLength(1)
    expect(document.querySelector('button[data-sem-c=button]')?.textContent).toBe('Add')
  })

  it('take-over adopts a <sem-host> and lets the adapter hydrate it', () => {
    const p = project()
    const html = toHTML(p.screen.index, EX + 'page', { hosts: standIn(p.screen.index, ['Button']).adapter })
    const { document } = parseHTML(`<!doctype html><html><body><div id="app">${html}</div></body></html>`)
    const { adapter, calls } = standIn(p.screen.index, ['Button'])
    const renderer = new DomRenderer(p.screen.index, document.getElementById('app')!, EX + 'page', adapter)
    const before = document.querySelector('sem-host')
    const adopted = renderer.adopt()
    renderer.flush()
    expect(adopted.mismatches).toBe(0)
    expect(calls).toMatchObject({ hydrations: 2, mounts: 0 })
    expect(document.querySelector('sem-host')).toBe(before)
  })

  it('a custom element as the root (ext:tag): created, serialized, adopted and given its props by the patcher', () => {
    const tagged = `@prefix c: <${NS.c}> . @prefix ext: <${NS.ext}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      c:Heading rdfs:subClassOf ext:Hosted ; ext:tag "ds-title" ; ext:input [ ext:name "level" ; ext:from c:level ] .`
    for (const prefer of ['sparql', 'function'] as const) {
      const p = project({ extra: [tagged], prefer })
      const html = toHTML(p.screen.index, EX + 'page')
      expect(html).toContain('<ds-title data-sem-c="heading">Todos</ds-title>')
      const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
      new DomRenderer(p.screen.index, document.getElementById('app')!, EX + 'page').flush()
      const el = document.querySelector('ds-title') as HTMLElement & { level?: number }
      expect(el.textContent).toBe('Todos')
      expect(el.level).toBe(1)
      // Server-rendered, it is adopted as it is.
      const ssr = parseHTML(`<!doctype html><html><body><div id="app">${html}</div></body></html>`).document
      expect(new DomRenderer(p.screen.index, ssr.getElementById('app')!, EX + 'page').adopt().mismatches).toBe(0)
    }
    // Authored: only a custom element the policy lists.
    const policy = readPolicy(loadStore('wat'))
    expect(toHTML(project({ extra: [tagged], policy }).screen.index, EX + 'page')).not.toContain('<ds-title')
    expect(toHTML(project({ extra: [tagged], policy: { ...policy, customElements: new Set(['ds-title']) } }).screen.index, EX + 'page')).toContain('<ds-title')
    // A tag that is not a custom element's name is not taken.
    const bad = project({ extra: [`@prefix c: <${NS.c}> . @prefix ext: <${NS.ext}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . c:Heading rdfs:subClassOf ext:Hosted ; ext:tag "script" .`] })
    const html = toHTML(bad.screen.index, EX + 'page')
    expect(html).not.toContain('<script')
    expect(html).toContain('<h1 data-sem-c="heading">Todos</h1>')
  })
})
