// The part of the ontology an app uses (src/subset.ts, docs/SUBSET.md): an app rendered from its
// subset is the app rendered from the whole ontology, byte for byte, with a stylesheet that keeps
// every rule for what is shown. Checked for examples/hello, every page of the gallery (with and
// without the site's shell) and every live example, and through an interaction.
import { readdirSync, readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { createStore, loadStore, loadStoreWithOntology, ontologySources } from '../src/node/load.ts'
import { MOD, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { buildSandbox, exampleSpec } from '../src/sandbox.ts'
import { renderToString } from '../src/server/render.ts'
import { compileStyles } from '../src/style/compile.ts'
import { ontologySubset } from '../src/subset.ts'
import { DEFAULT_LAYERS } from '../src/web/mount.ts'
import { cssRules, lostRules } from './css-pairs.ts'

const UI = 'https://semblance.dev/demo#'
const HELLO = 'https://example.org/hello#'
const read = (f: string) => readFileSync(new URL('../' + f, import.meta.url), 'utf8')
const ontology = ontologySources()
const hello = [read('examples/hello/tally.ttl'), read('examples/hello/app.ttl')]
const appTtl = read('demo/app.ttl')
const gallery = readdirSync(new URL('../demo/gallery/', import.meta.url))
  .filter((f) => f.endsWith('.ttl'))
  .sort()
  .map((f) => ({ name: f.replace(/^_/, '').replace(/\.ttl$/, ''), text: read('demo/gallery/' + f) }))

/** Render `root` from the whole ontology and from the subset `graphs` use; what differs. */
async function compare(graphs: string[], root: string) {
  const subset = ontologySubset(ontology, graphs)
  const whole = await renderToString({ store: loadStore('wat', ...graphs), root })
  const part = await renderToString({ store: loadStoreWithOntology('wat', subset.turtle, ...graphs), root })
  const { document } = parseHTML(`<!doctype html><html><body>${whole.html}</body></html>`)
  const wholeCss = cssRules(whole.css!)
  const partCss = cssRules(part.css!)
  const out = {
    subset,
    same: whole.html === part.html,
    lost: lostRules(wholeCss, partCss, document),
    extra: [...partCss].filter((r) => !wholeCss.has(r)),
    css: [whole.css!.length, part.css!.length],
  }
  whole.runtime.dispose()
  part.runtime.dispose()
  whole.runtime.store.dispose?.()
  part.runtime.store.dispose?.()
  return out
}

describe('an app from the part of the ontology it uses', () => {
  it('examples/hello renders the same, from about a fifth of the ontology and a tenth of the stylesheet', async () => {
    const r = await compare(hello, HELLO + 'page')
    expect(r.same).toBe(true)
    expect(r.lost).toEqual([])
    expect(r.extra).toEqual([])
    expect(r.subset.whole).toBe(false)
    expect(r.subset.kept / r.subset.total).toBeLessThan(0.3)
    expect(r.css[1]! / r.css[0]!).toBeLessThan(0.15)
    for (const c of ['Stack', 'Heading', 'Button']) expect(r.subset.classes).toContain(NS.c + c)
    expect(r.subset.classes).toContain(HELLO + 'Tally')
    // What it does not use is left out.
    for (const c of ['Window', 'Sheet', 'Calendar', 'BlockEditor']) expect(r.subset.classes).not.toContain(NS.c + c)
  })

  it('examples/hello responds to a click as from the whole ontology', () => {
    const subset = ontologySubset(ontology, hello)
    const run = (store: ReturnType<typeof createStore>) => {
      const runtime = new Runtime(store)
      const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, name: 'screen', roots: [HELLO + 'page'] }, (e) => {
        throw e
      })
      const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
      const renderer = new DomRenderer(screen.index, document.getElementById('app')!, HELLO + 'page')
      renderer.flush()
      new EventBus(runtime, screen).attach(renderer, () => renderer.flush())
      const button = document.querySelector('[data-sem-c=button]')!
      for (let i = 0; i < 3; i++) button.dispatchEvent(new window.Event('click', { bubbles: true }))
      const html = toHTML(screen.index, HELLO + 'page')
      runtime.dispose()
      return html
    }
    const whole = run(loadStore('wat', ...hello))
    expect(whole).toContain('3 cups')
    expect(run(loadStoreWithOntology('wat', subset.turtle, ...hello))).toBe(whole)
  })

  // Every gallery file whose page is a node of its own (the examples, the home page, the docs), on its own and in the site's shell.
  const pages = gallery.filter((g) => g.text.includes(`ui:${g.name} a `))
  it.each(pages.map((g) => g.name))('the gallery page %s renders the same', async (name) => {
    const g = pages.find((p) => p.name === name)!
    // On its own when it renders on its own (some name the site's prefixes, which its shell declares).
    const alone = await renderToString({ store: loadStore('wat', g.text), root: UI + name }).then(
      (r) => (r.runtime.dispose(), true),
      () => false,
    )
    for (const graphs of [[appTtl, g.text], ...(alone ? [[g.text]] : [])]) {
      const r = await compare(graphs, UI + name)
      expect(r.same, name).toBe(true)
      expect(r.lost, name).toEqual([])
      expect(r.extra, name).toEqual([])
    }
  })

  it('every live example builds the same in a sandbox over its subset', () => {
    const store = loadStore('wat', appTtl, ...gallery.map((g) => g.text))
    const f = store.factory
    const examples = store.match(null, f.namedNode(NS.rdf + 'type'), f.namedNode(NS.c + 'LiveExample')).map((q) => q.subject.value)
    expect(examples.length).toBeGreaterThan(10)
    const preamble = Object.entries(NS).map(([p, ns]) => `@prefix ${p}: <${ns}> .`).join(' ') + '\n'
    for (const example of examples) {
      const spec = exampleSpec(store, example)
      if (!spec.root) continue
      const subset = ontologySubset(ontology, spec.sources.map((s) => preamble + s.text))
      expect(subset.kept / subset.total, example).toBeLessThan(0.4)
      const build = (load: (...t: string[]) => ReturnType<typeof createStore>) => {
        const b = buildSandbox(spec.sources, spec.root!, { load, withText: spec.withText })
        const html = b.sandbox ? toHTML(b.sandbox.screen.index, spec.root!) + (b.sandbox.text ? toHTML(b.sandbox.text.index, spec.root!) : '') : ''
        const css = b.sandbox ? compileStyles(b.sandbox.store) : ''
        b.sandbox?.runtime.dispose()
        return { html, css, problems: b.problems }
      }
      const whole = build((...t) => loadStore('wat', ...t))
      const part = build((...t) => loadStoreWithOntology('wat', subset.turtle, ...t))
      expect(whole.html, example).not.toBe('')
      expect(part.html, example).toBe(whole.html)
      expect(part.problems, example).toEqual(whole.problems)
      const { document } = parseHTML(`<!doctype html><html><body>${whole.html}</body></html>`)
      expect(lostRules(cssRules(whole.css), cssRules(part.css), document), example).toEqual([])
    }
    store.dispose?.()
  })

  it('a class that reads the whole ontology keeps all of it', () => {
    const subset = ontologySubset(ontology, [read('demo/gallery/_reference.ttl')])
    expect(subset.whole).toBe(true)
    expect(subset.kept).toBe(subset.total)
  })
})
