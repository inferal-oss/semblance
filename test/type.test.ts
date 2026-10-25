import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore } from '../src/node/load.ts'
import { A11Y, MOD, SEM, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'

const UI = 'https://semblance.dev/demo#'
const STYLES = ['display', 'title', 'subtitle', 'body', 'caption', 'overline', 'mono']

/** One gallery page (demo/gallery/<page>.ttl), projected on its own into a DOM. */
function showPage(page: string, language = 'en') {
  const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const store = loadStore('oxigraph', readFileSync(new URL(`../demo/gallery/${page}.ttl`, import.meta.url), 'utf8'))
  const runtime = new Runtime(store)
  const root = UI + 'gallery-' + page
  const screen = runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer, SEM.SourceLayer], languages: [language], name: 'screen', roots: [root] }, (e) => {
    throw e
  })
  const dom = new DomRenderer(screen.index, document.getElementById('app')!, root)
  dom.flush()
  new EventBus(runtime, screen).attach(dom, () => dom.flush())
  const byKey = (key: string) => [...document.querySelectorAll('*')].find((e) => dom.keyOf(e) === key) as HTMLElement
  return {
    document,
    store,
    root: (id: string) => byKey(`${UI}${id}/~root`),
    setLanguage: (next: string) => { screen.engine.reconfigure({ languages: [next] }); dom.flush() },
  }
}

describe('sty:textStyle', () => {
  it('is a hookable axis whose values compile into the hooks layer', () => {
    const css = compileStyles(loadStore('n3'))
    const hooks = css.slice(css.indexOf('@layer sem.hooks {'), css.indexOf('@layer sem.components {'))
    for (const s of STYLES) expect(hooks, s).toContain(`[data-sem-text-style="${s}"] {`)
    expect(hooks).toMatch(/\[data-sem-text-style="display"\] \{[^}]*font-size: var\(--sem-text-3xl\);[^}]*line-height: var\(--sem-leading-tight\)/)
    expect(hooks).toMatch(/\[data-sem-text-style="mono"\] \{[^}]*font-family: var\(--sem-font-mono\)/)
    expect(hooks).toMatch(/\[data-sem-text-style="overline"\] \{[^}]*text-transform: uppercase/)
    // a tone colors text through --tone-text
    // (and its subclasses': a walkthrough's steps are running text too)
    expect(css).toMatch(/\[data-sem-c="text"\]\[data-sem-tone\](, [^{]+)? \{ color: var\(--tone-text\); \}/)
  })
})

describe('c:LinkCard', () => {
  it('makes the whole card one safe, accessible link', () => {
    const { root } = showPage('type')
    const internal = root('ty-link-card-internal')
    expect(internal.localName).toBe('a')
    expect(internal.getAttribute('href')).toBe('#components/type')
    expect(internal.getAttribute('aria-current')).toBe('page')
    expect(internal.hasAttribute('target')).toBe(false)
    expect(internal.querySelectorAll('a')).toHaveLength(0)
    expect(internal.textContent).toContain('Type gallery')
    expect(internal.textContent).toContain('The current component group')
    expect(internal.textContent).toContain('Current')

    const external = root('ty-link-card-external')
    expect(external.getAttribute('target')).toBe('_blank')
    expect(external.getAttribute('rel')).toBe('noopener noreferrer')
    expect(external.textContent).toContain('opens in a new tab')
  })

  it('renders a readable text projection and theme styling', () => {
    const store = loadStore('oxigraph', readFileSync(new URL('../demo/gallery/type.ttl', import.meta.url), 'utf8'))
    const root = UI + 'ty-link-card-internal'
    const text = new Runtime(store).project({ modality: MOD.Text, roots: [root] })
    expect(toText(text.index, root)).toContain('Type gallery [Current] — The current component group. (#components/type)')

    const css = compileStyles(store)
    expect(css).toContain('[data-sem-c="link-card"]')
    expect(css).toContain('[data-sem-c="link-card"]:focus-visible')
  })

  it('uses the viewer’s language for the external-link hint', () => {
    const { root, setLanguage } = showPage('type')
    setLanguage('ar')
    expect(root('ty-link-card-external').textContent).toContain('يفتح في علامة تبويب جديدة')
  })

  it('does not turn an unsafe address into a browser link', () => {
    const bad = UI + 'unsafe-link-card'
    const store = loadStore('oxigraph', `
      @prefix ui: <${UI}> .
      @prefix c: <https://semblance.dev/ns/component#> .
      ui:unsafe-link-card a c:LinkCard ; c:label "Unsafe" ; c:href "javascript:alert(1)" .
    `)
    const screen = new Runtime(store).project({ modality: MOD.Screen, roots: [bad] })
    expect(screen.index.rootOf(bad)).toBeUndefined()
  })
})

describe('the Type page', () => {
  it('shows the whole type scale and tones on text', () => {
    const { document, root } = showPage('type')
    const styles = new Set([...document.querySelectorAll('[data-sem-c=text][data-sem-text-style]')].map((e) => e.getAttribute('data-sem-text-style')))
    for (const s of STYLES) expect(styles, s).toContain(s)
    expect(root('ty-display').localName).toBe('p')
    expect(root('ty-display').textContent).toContain('interfaces as graphs')
    for (const tone of ['neutral', 'accent', 'info', 'success', 'warning', 'danger']) {
      expect(document.querySelector(`[data-sem-c=text][data-sem-tone=${tone}]`), tone).not.toBeNull()
    }
    expect(root('ty-tone-accent').localName).toBe('span') // c:inline
  })

  it('mixes strings and inline components in running text', () => {
    const { root } = showPage('type')
    const run = root('ty-run')
    expect(run.textContent).toMatch(/^A c:Text is a sequence of strings and components: press ⌘K to open the palette, or read the RDF\/HTML↗ \(opens in a new tab\) specification/)
    expect(run.querySelector('[data-sem-c=kbd]')).not.toBeNull()
    expect(run.querySelector('[data-sem-c=code]')!.localName).toBe('code')
  })

  it('opens external links in a new tab, safely and audibly', () => {
    const { root } = showPage('type')
    const ext = root('ty-link-external')
    expect(ext.localName).toBe('a')
    expect(ext.getAttribute('href')).toBe('https://ia2.dev/spec/rdf-html')
    expect(ext.getAttribute('target')).toBe('_blank')
    expect(ext.getAttribute('rel')).toContain('noopener')
    expect(ext.querySelector('.sem-external')!.getAttribute('aria-hidden')).toBe('true')
    expect(ext.querySelector('.sem-sr')!.textContent).toBe(' (opens in a new tab)')
    const internal = root('ty-link-internal')
    expect(internal.hasAttribute('target')).toBe(false)
    expect(internal.querySelector('.sem-external')).toBeNull()
    expect(root('ty-link-danger').getAttribute('data-sem-tone')).toBe('danger')
  })

  it('renders key combinations as nested kbd', () => {
    const { root } = showPage('type')
    const combo = root('ty-kbd-command')
    expect(combo.localName).toBe('kbd')
    expect([...combo.querySelectorAll(':scope > kbd')].map((k) => k.textContent)).toEqual(['⌘', '⇧', 'P'])
    expect(combo.getAttribute('title')).toBe('Command + Shift + P')
    expect(root('ty-kbd-esc').textContent).toBe('Esc')
  })

  it('colors code blocks with the SPARQL and Turtle tokenizers', () => {
    const { root } = showPage('type')
    const sparql = root('ty-code-sparql')
    expect(sparql.localName).toBe('pre')
    expect(sparql.querySelector(':scope > code')).not.toBeNull()
    expect(sparql.querySelector('.sem-language')!.textContent).toBe('sparql')
    const kinds = (el: Element) => new Set([...el.querySelectorAll('[class^=tok-]')].map((s) => s.className))
    expect([...kinds(sparql)]).toEqual(expect.arrayContaining(['tok-keyword', 'tok-var', 'tok-pname', 'tok-comment']))
    expect(sparql.querySelector('code')!.textContent).toContain('BIND(!COALESCE(?old, false) AS ?new)')
    const turtle = root('ty-code-turtle')
    expect([...turtle.querySelectorAll('.tok-keyword')].map((k) => k.textContent)).toContain('@prefix')
    expect([...kinds(turtle)]).toEqual(expect.arrayContaining(['tok-iri', 'tok-string', 'tok-pname']))
    expect(root('ty-code-inline-1').localName).toBe('code')
  })
})

describe('type components in the text modality', () => {
  it('sketch text, links, keys and code compactly', () => {
    const store = loadStore(
      'oxigraph',
      `@prefix c: <https://semblance.dev/ns/component#> . @prefix sty: <https://semblance.dev/ns/style#> . @prefix ex: <https://example.org/> .
       ex:page a c:Stack ; c:children ( ex:t ex:l ex:k ex:code ex:q ) .
       ex:t a c:Text ; sty:textStyle sty:Title ; c:label "Hello" .
       ex:l a c:Link ; c:label "Spec" ; c:href "https://ia2.dev/spec/rdf-html" .
       ex:k a c:Kbd ; c:keys ( "⌘" "K" ) .
       ex:code a c:Code ; c:block true ; c:label "SELECT * WHERE { ?s ?p ?o }" .
       ex:q a c:Blockquote ; c:label "Rules are data." ; c:attribution "README" .`,
    )
    const runtime = new Runtime(store)
    const text = runtime.project({ modality: MOD.Text, layers: [A11Y.Layer, STY.Layer], name: 'text' })
    expect(toText(text.index, 'https://example.org/page')).toBe(
      ['Hello', 'Spec <https://ia2.dev/spec/rdf-html> ↗ [⌘][K]', '    SELECT * WHERE { ?s ?p ?o }', '> Rules are data.\n> — README'].join('\n'),
    )
  })
})
