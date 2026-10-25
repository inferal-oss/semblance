import { readdirSync, readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { Parser, Store } from 'n3'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore } from '../src/node/load.ts'
import { DEFAULT_LAYERS, MOD, NS } from '../src/ns.ts'
import { memoryBackend, Persistence } from '../src/persistence.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import { buildSandbox, completeSource, Sandboxes, type SandboxSource } from '../src/sandbox.ts'
import type { GraphStore } from '../src/store/types.ts'
import { implementationGaps } from './implementations.ts'

// Live examples (ontology/components/live.ttl, src/sandbox.ts): the site's Docs page (demo/gallery/
// _docs.ttl) as the host, each example in a sandbox of its own, driven through events.

const UI = 'https://semblance.dev/demo#'
const C = NS.c
const docs = readFileSync(new URL('../demo/gallery/_docs.ttl', import.meta.url), 'utf8')
const HELLO = 'https://example.org/hello#'

// A host's sandboxes stop with its test: a rebuild still waiting for typing to pause must not run
// against a site store test/setup.ts has already released.
const hosts: Sandboxes[] = []
afterEach(() => {
  for (const s of hosts.splice(0)) s.dispose()
})

function host(opts: { root?: string; prefer?: 'sparql' | 'function'; section?: string; store?: GraphStore; maxMounted?: number } = {}) {
  const store = opts.store ?? loadStore('wat', docs)
  const f = store.factory
  const nn = (iri: string) => f.namedNode(iri)
  if (opts.section) store.add(f.quad(nn(UI + 'app'), nn(UI + 'docSection'), nn(UI + opts.section)))
  const root = opts.root ?? UI + 'doc-start'
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, prefer: opts.prefer, name: 'screen', roots: [root] }, (e) => {
    throw e
  })
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const renderer = new DomRenderer(screen.index, document.getElementById('app')!, root)
  const copied: string[] = []
  const sandboxes = new Sandboxes(runtime, screen, {
    renderer,
    shown: (c) => screen.index.isShown(c, new Set([root])),
    flush: () => flush(),
    load: (...t) => loadStore('wat', ...t),
    prefer: opts.prefer,
    copy: (t) => void copied.push(t),
    copiedMs: 0,
    maxMounted: opts.maxMounted,
  })
  const flush = () => {
    renderer.flush()
    sandboxes.sync()
  }
  new EventBus(runtime, screen, { prefer: opts.prefer }).attach(renderer, () => flush())
  sandboxes.attach()
  hosts.push(sandboxes)
  flush()
  const fire = (el: Element, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true }))
  const example = (name: string) => document.getElementById(`${UI}${name}/~tab-0`)!.closest('[data-sem-c=live-example]')!
  const preview = (name: string) => example(name).querySelector('.sem-live-screen')!
  const type = (editor: string, text: string) => {
    const ta = document.getElementById(`${UI}${editor}/~input`) as HTMLTextAreaElement
    ta.value = text
    Object.assign(ta, { selectionStart: text.length, selectionEnd: text.length })
    fire(ta, 'input')
  }
  const button = (name: string, label: string) => [...example(name).querySelectorAll('.sem-live-actions button')].find((b) => b.textContent === label) as HTMLButtonElement
  const value = (s: string, p: string) => store.match(nn(s), nn(p), null)[0]?.object.value
  return { store, runtime, screen, document, window, renderer, sandboxes, fire, example, preview, type, button, value, copied, flush }
}

/** Every live example of the site: its sources as written and what it shows. */
function siteExamples() {
  const st = new Store()
  const dir = new URL('../demo/gallery/', import.meta.url)
  for (const file of readdirSync(dir).filter((x) => x.endsWith('.ttl'))) st.addQuads(new Parser().parse(readFileSync(new URL(file, dir), 'utf8')))
  const one = (s: Parameters<Store['getObjects']>[0], p: string) => st.getObjects(s, p, null)[0]
  return st.getSubjects(NS.rdf + 'type', C + 'LiveExample', null).map((ex) => {
    const sources: SandboxSource[] = []
    for (let cell = one(ex, C + 'sources'); cell && cell.value !== NS.rdf + 'nil'; cell = one(cell, NS.rdf + 'rest')) {
      const editor = one(cell, NS.rdf + 'first')!
      sources.push({ editor: editor.value, name: one(editor, C + 'label')!.value, text: one(editor, C + 'original')!.value })
    }
    return { iri: ex.value, root: one(ex, C + 'exampleRoot')!.value, withText: one(ex, C + 'textPreview')?.value === 'true', sources }
  })
}

describe('a live example (c:LiveExample)', () => {
  it('renders its source in a sandbox mounted in its slot, beside the editor', () => {
    const h = host()
    const ex = h.example('gs-page')
    expect(ex.getAttribute('data-sem-state')).toBe('live')
    expect(ex.querySelector('[role=tab]')!.textContent).toBe('app.ttl')
    expect(ex.querySelector('[data-sem-c=code-editor] textarea')!.getAttribute('aria-label')).toBe('app.ttl')
    expect(ex.querySelector('[data-sem-c=code-editor] .tok-keyword')!.textContent).toBe('@prefix')
    expect(h.preview('gs-page').querySelector('h1')!.textContent).toBe('Hello, Semblance')
    expect(ex.querySelector('.sem-live-time')!.textContent).toMatch(/^\d+ ms$/)
    // Its state is the site's graph data; its rendering is not: that is the sandbox's own graph.
    expect(h.value(UI + 'gs-page', C + 'sandboxState')).toBe(C + 'SandboxLive')
    expect(h.store.match(h.store.factory.namedNode(HELLO + 'title'), null, null)).toHaveLength(0)
    expect(h.sandboxes.sandboxOf(UI + 'gs-page')!.store.match(h.store.factory.namedNode(HELLO + 'title'), null, null).length).toBeGreaterThan(0)
    // Reset is enabled only once a source is edited.
    expect(h.button('gs-page', 'Reset').disabled).toBe(true)
  })

  it('re-renders an edit once typing pauses, and only then', () => {
    const h = host()
    const builds = h.sandboxes.builds
    const original = h.value(UI + 'gs-page-app', C + 'original')!
    h.type('gs-page-app', original.replace('Hello, Semblance', 'Hello, sandbox'))
    h.type('gs-page-app', original.replace('Hello, Semblance', 'Hello, sandboxes'))
    expect(h.sandboxes.builds).toBe(builds)
    expect(h.preview('gs-page').querySelector('h1')!.textContent).toBe('Hello, Semblance')
    h.sandboxes.settle()
    expect(h.sandboxes.builds).toBe(builds + 1)
    expect(h.preview('gs-page').querySelector('h1')!.textContent).toBe('Hello, sandboxes')
    expect(h.button('gs-page', 'Reset').disabled).toBe(false)
  })

  it('shows an edit that does not parse, with its line, and keeps the last rendering that worked', () => {
    const h = host()
    const original = h.value(UI + 'gs-page-app', C + 'original')!
    h.type('gs-page-app', original.replace('c:level 1 ;', 'c:level ;'))
    h.sandboxes.settle()
    const ex = h.example('gs-page')
    expect(ex.getAttribute('data-sem-state')).toBe('stale')
    expect(ex.querySelector('.sem-live-summary')!.textContent).toBe('The source has an error, so this is the last rendering that worked.')
    const problem = ex.querySelector('.sem-live-problem')!
    expect(problem.getAttribute('data-sem-tone')).toBe('danger')
    expect(problem.querySelector('.sem-live-where')!.textContent).toBe('app.ttl, line 5')
    expect(problem.querySelector('.sem-live-message')!.textContent).toMatch(/^Expected/)
    expect(h.preview('gs-page').querySelector('h1')!.textContent).toBe('Hello, Semblance')
    // A rule that fails is a problem too, not an exception in the site.
    const rule = h.value(UI + 'gs-tally-def', C + 'original')!
    h.type('gs-tally-def', rule.replace('?figureText a rdfhtml:Text', '?figureText a rdfhtml:Text (('))
    h.sandboxes.settle()
    expect(h.example('gs-tally').getAttribute('data-sem-state')).toBe('stale')
    expect(h.example('gs-tally').querySelector('.sem-live-message')!.textContent).toMatch(/^SPARQL rule <https:\/\/example\.org\/hello#TallyRendering-sparql> failed/)
    expect(h.preview('gs-tally').querySelector('strong')!.textContent).toBe('0 cups')
    // Nothing to show is a problem as well.
    h.type('gs-page-app', original.replace('ex:page a c:Stack', 'ex:pages a c:Stack'))
    h.sandboxes.settle()
    expect(h.example('gs-page').querySelector('.sem-live-message')!.textContent).toBe('Nothing to show: ex:page is not described in the source.')
    // Fixed, it is live again and the problems are gone.
    h.type('gs-page-app', original)
    h.sandboxes.settle()
    expect(h.example('gs-page').getAttribute('data-sem-state')).toBe('live')
    expect(h.example('gs-page').querySelector('.sem-live-status')).toBeNull()
  })

  it('resets the sources as written, and the sandbox with them', () => {
    const h = host()
    const original = h.value(UI + 'gs-page-app', C + 'original')!
    h.type('gs-page-app', original.replace('Have another', 'Not now'))
    h.sandboxes.settle()
    expect(h.preview('gs-page').querySelector('button')!.textContent).toBe('Not now')
    h.fire(h.button('gs-page', 'Reset'), 'click')
    expect(h.value(UI + 'gs-page-app', C + 'value')).toBeUndefined()
    expect((h.document.getElementById(`${UI}gs-page-app/~input`) as HTMLTextAreaElement).value).toBe(original)
    h.sandboxes.settle()
    expect(h.preview('gs-page').querySelector('button')!.textContent).toBe('Have another')
    expect(h.button('gs-page', 'Reset').disabled).toBe(true)
  })

  it('runs the example’s reactions in its own graph, out of sight of the site', () => {
    const h = host()
    const events = () => h.store.match(null, h.store.factory.namedNode(NS.rdf + 'type'), null, h.store.factory.namedNode('urn:semblance:events')).length
    const before = events()
    const drink = [...h.preview('gs-react').querySelectorAll('button')].find((b) => b.textContent === 'Have another')!
    h.fire(drink, 'click')
    h.fire(drink, 'click')
    expect(h.preview('gs-react').querySelector('[data-sem-c=ex-tally] strong')!.textContent).toBe('2 cups')
    expect(events()).toBe(before)
    // The other examples' graphs are their own too.
    expect(h.preview('gs-tally').querySelector('[data-sem-c=ex-tally] strong')!.textContent).toBe('0 cups')
    // An edit restarts the example from its source.
    h.type('gs-react-app', h.value(UI + 'gs-react-app', C + 'original')!.replace('c:value 0', 'c:value 10'))
    h.sandboxes.settle()
    expect(h.preview('gs-react').querySelector('[data-sem-c=ex-tally] strong')!.textContent).toBe('10 cups')
  })

  it('reports a reaction that fails instead of throwing it into the site', () => {
    const h = host()
    const app = h.value(UI + 'gs-react-app', C + 'original')!
    h.type('gs-react-app', app.replace('BIND(?n + 1 AS ?next)', 'BIND(?n + 1 AS ?next) FILTER(nosuchfunction(?n))'))
    h.sandboxes.settle()
    const drink = [...h.preview('gs-react').querySelectorAll('button')].find((b) => b.textContent === 'Have another')!
    expect(() => h.fire(drink, 'click')).not.toThrow()
    expect(h.example('gs-react').querySelector('.sem-live-message')!.textContent).toMatch(/Drink/)
  })

  it('switches between its sources with tabs, and copies the one shown with the prefixes it uses', async () => {
    const h = host()
    const ex = h.example('gs-tally')
    const tabs = [...ex.querySelectorAll('[role=tab]')]
    expect(tabs.map((t) => t.textContent)).toEqual(['tally.ttl', 'app.ttl'])
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false'])
    expect([...ex.querySelectorAll('[role=tabpanel]')].map((p) => p.hasAttribute('hidden'))).toEqual([false, true])
    h.fire(tabs[1]!, 'click')
    expect(h.value(UI + 'gs-tally', C + 'selectedSource')).toBe(UI + 'gs-tally-app')
    expect([...h.example('gs-tally').querySelectorAll('[role=tabpanel]')].map((p) => p.hasAttribute('hidden'))).toEqual([true, false])
    h.fire(h.button('gs-tally', 'Copy'), 'click')
    expect(h.button('gs-tally', 'Copied')).toBeDefined()
    await new Promise((r) => setTimeout(r, 5))
    expect(h.copied).toHaveLength(1)
    expect(h.copied[0]).toMatch(/^@prefix /)
    expect(h.copied[0]).toContain('@prefix c: <https://semblance.dev/ns/component#> .')
    expect(h.copied[0]).toContain('@prefix sty: ')
    expect(h.copied[0]).not.toContain('@prefix sh: ')
    expect(h.copied[0]).toContain('ex:cups a ex:Tally')
    expect(h.button('gs-tally', 'Copy')).toBeDefined()
    // What Copy gives parses as it is, with no prefixes declared for it.
    expect(() => new Parser().parse(h.copied[0]!)).not.toThrow()
  })

  it('remembers edits for the session (per:Policy)', async () => {
    const session = memoryBackend()
    const backends = { [NS.per + 'Session']: session }
    const h = host()
    const persistence = new Persistence(h.store, backends, { delayMs: 60_000 })
    persistence.attach(h.runtime)
    const edited = h.value(UI + 'gs-page-app', C + 'original')!.replace('Have another', 'Remembered')
    h.type('gs-page-app', edited)
    await persistence.flush()
    const store = loadStore('wat', docs)
    await new Persistence(store, backends).restore()
    const again = host({ store })
    again.sandboxes.settle()
    expect(again.value(UI + 'gs-page-app', C + 'value')).toBe(edited)
    expect(again.preview('gs-page').querySelector('button')!.textContent).toBe('Remembered')
    expect(again.button('gs-page', 'Reset').disabled).toBe(false)
  })

  it('also shows the example in the Text modality, when asked', () => {
    const h = host({ root: UI + 'doc-recipes' })
    const ex = h.example('rc-text')
    expect(ex.querySelector('.sem-live-modality')!.textContent).toBe('As text')
    expect(ex.querySelector('.sem-live-text')!.textContent).toContain('Volume  ###.......  3/10')
    h.fire([...h.preview('rc-text').querySelectorAll('button')].find((b) => b.textContent === 'Louder')!, 'click')
    expect(h.example('rc-text').querySelector('.sem-live-text')!.textContent).toContain('Volume  ####......  4/10')
    expect(h.preview('rc-text').querySelector('.ex-meter-bar')!.getAttribute('style')).toBe('--level: 40%')
  })
})

describe('the cost of a live example', () => {
  it('builds nothing for examples that are not shown', () => {
    const h = host({ root: UI + 'docs', section: 'DocIntegrate' })
    expect(h.sandboxes.builds).toBe(0)
    const f = h.store.factory
    const app = f.namedNode(UI + 'app')
    const p = f.namedNode(UI + 'docSection')
    h.runtime.apply({ remove: h.store.match(app, p, null), add: [f.quad(app, p, f.namedNode(UI + 'DocStart'))] })
    h.flush()
    expect(h.sandboxes.builds).toBe(3)
    // Showing it again, or anything else, builds nothing more.
    h.runtime.apply({ remove: h.store.match(app, p, null), add: [f.quad(app, p, f.namedNode(UI + 'DocIntegrate'))] })
    h.flush()
    h.runtime.apply({ remove: h.store.match(app, p, null), add: [f.quad(app, p, f.namedNode(UI + 'DocStart'))] })
    h.flush()
    expect(h.sandboxes.builds).toBe(3)
    // Another section's examples are built when it is shown, its own only.
    h.runtime.apply({ remove: h.store.match(app, p, null), add: [f.quad(app, p, f.namedNode(UI + 'DocRecipes'))] })
    h.flush()
    expect(h.sandboxes.builds).toBe(9)
  })

  it('lets go of the sandboxes hidden longest past a bound, and builds them again when shown', () => {
    const h = host({ root: UI + 'docs', section: 'DocStart', maxMounted: 3 })
    const f = h.store.factory
    const show = (section: string) => {
      const app = f.namedNode(UI + 'app')
      const p = f.namedNode(UI + 'docSection')
      h.runtime.apply({ remove: h.store.match(app, p, null), add: [f.quad(app, p, f.namedNode(UI + section))] })
      h.flush()
    }
    expect([h.sandboxes.builds, h.sandboxes.size]).toEqual([3, 3])
    show('DocRecipes')
    expect([h.sandboxes.builds, h.sandboxes.size]).toEqual([9, 6])
    show('DocStart')
    expect([h.sandboxes.builds, h.sandboxes.size]).toEqual([12, 3])
    expect(h.preview('gs-react').querySelector('[data-sem-c=ex-tally] strong')!.textContent).toBe('0 cups')
  })

  it('costs a keystroke the editor alone, the same in a long source as in a short one, and one build when typing pauses', () => {
    const h = host()
    const keystroke = (editor: string) => {
      const original = h.value(UI + editor, C + 'original')!
      h.type(editor, original + ' ')
      h.sandboxes.settle()
      const runs = h.screen.engine.stats.ruleRuns
      const ops = h.renderer.ops
      const builds = h.sandboxes.builds
      h.type(editor, original + '  ')
      const cost = { lines: original.split('\n').length, runs: h.screen.engine.stats.ruleRuns - runs, ops: h.renderer.ops - ops }
      expect(h.sandboxes.builds).toBe(builds)
      h.sandboxes.settle()
      expect(h.sandboxes.builds).toBe(builds + 1)
      return cost
    }
    const short = keystroke('gs-page-app')
    const long = keystroke('gs-tally-def')
    expect(long.lines).toBeGreaterThan(5 * short.lines)
    // The editor re-renders (and the layers over what changed in it); no example does.
    for (const c of [short, long]) expect(c.runs).toBeLessThanOrEqual(6)
    expect(long.ops).toBeLessThanOrEqual(short.ops + 10)
    expect(long.ops).toBeLessThan(80)
  })
})

describe('the live examples of the site', () => {
  const examples = siteExamples()
  it('has them', () => expect(examples.length).toBeGreaterThanOrEqual(10))
  for (const ex of examples) {
    it(`${ex.iri.replace(UI, 'ui:')} parses and renders, with no problems, on Semblance WASM with SPARQL`, () => {
      const b = buildSandbox(ex.sources, ex.root, { load: (...t) => loadStore('wat', ...t), prefer: 'sparql', withText: ex.withText, languages: ['en'] })
      expect(b.problems).toEqual([])
      expect(b.sandbox!.screen.index.resolve(ex.root)).toBeDefined()
      for (const s of ex.sources) expect(() => new Parser().parse(completeSource(s.text))).not.toThrow()
    })
  }

  it("ends Getting started with examples/hello itself (less the prefixes Semblance declares)", () => {
    const strip = (t: string) => t.split('\n').filter((l) => !/^@prefix (?!ex:)/.test(l)).join('\n').replace(/\n+$/, '')
    const file = (f: string) => strip(readFileSync(new URL('../examples/hello/' + f, import.meta.url), 'utf8'))
    const react = examples.find((e) => e.iri === UI + 'gs-react')!
    expect(react.sources.map((s) => s.name)).toEqual(['tally.ttl', 'app.ttl'])
    expect(react.sources[0]!.text).toBe(file('tally.ttl'))
    expect(react.sources[1]!.text).toBe(file('app.ttl'))
    expect(examples.find((e) => e.iri === UI + 'gs-tally')!.sources[0]!.text).toBe(file('tally.ttl'))
  })
})

describe('the live example, as rules', () => {
  it('has SPARQL and function implementations of its rendering', () => {
    expect(implementationGaps(['components/live.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })

  it('renders the same with SPARQL rules as with functions, in every state', () => {
    // The host's writes, fixed (no timings): one example stale with two problems, one live with
    // a time, a text slot and an edited source.
    const status = `
@prefix c: <${C}> . @prefix ui: <${UI}> . @prefix sty: <${NS.sty}> . @prefix sem: <${NS.sem}> .
ui:gs-tally c:sandboxState c:SandboxStale ; c:problem ui:p0 , ui:p1 ; c:edited true .
ui:p0 a c:SandboxProblem ; sem:order 0 ; c:message "Expected entity" ; c:inSource ui:gs-tally-def ; c:sourceLine 3 ; sty:tone sty:Danger .
ui:p1 a c:SandboxProblem ; sem:order 1 ; c:message "ex:cups: A tally needs a label" ; sty:tone sty:Warning .
ui:gs-page c:sandboxState c:SandboxLive ; c:renderTime 12 ; c:textPreview true ; c:copied ui:gs-page-app .
ui:gs-react c:sandboxState c:SandboxBroken ; c:problem ui:p2 . ui:p2 a c:SandboxProblem ; sem:order 0 ; c:message "Nothing to show" .`
    const render = (prefer: 'sparql' | 'function') => {
      const store = loadStore('wat', docs, status)
      const runtime = new Runtime(store)
      const html: string[] = []
      for (const modality of [MOD.Screen, MOD.Text]) {
        const p = runtime.project({ modality, layers: DEFAULT_LAYERS, prefer, roots: [UI + 'doc-start'] })
        const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
        const r = new DomRenderer(p.index, document.getElementById('app')!, UI + 'doc-start')
        r.flush()
        html.push(document.getElementById('app')!.innerHTML)
      }
      return html
    }
    const [a, b] = [render('sparql'), render('function')]
    for (const i of [0, 1]) {
      if (a[i] === b[i]) continue
      let k = 0
      while (k < a[i]!.length && a[i]![k] === b[i]![k]) k++
      expect(a[i]!.slice(Math.max(0, k - 300), k + 300)).toBe(b[i]!.slice(Math.max(0, k - 300), k + 300))
    }
    expect(a[0]).toContain('tally.ttl, line 3')
    expect(a[0]).toContain('Copied')
    expect(a[1]).toContain('[Live example: A page]')
  })
})
