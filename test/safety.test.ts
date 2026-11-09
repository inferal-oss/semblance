import { readdirSync, readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { Parser, Store } from 'n3'
import { afterAll, describe, expect, it } from 'vitest'
import { uploadRefused } from '../src/files.ts'
import { loadStore } from '../src/node/load.ts'
import { NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML, toText } from '../src/render/serialize.ts'
import { authoredPolicy, cssProblem, declarationsProblem, readPolicy, urlProblem } from '../src/safety.ts'
import { buildSandbox, type Sandbox, type SandboxSource } from '../src/sandbox.ts'
import { compileStyles } from '../src/style/compile.ts'

// Safe authoring (ontology/layers/safety.ttl, src/safety.ts, docs/SAFETY.md): a graph from an
// untrusted author renders without running code or loading a resource from elsewhere. Each vector
// is checked as a live example's sandbox renders it, in the DOM and in the HTML a server writes.

const ontology = loadStore('wat')
const policy = readPolicy(ontology)
afterAll(() => ontology.dispose?.())
const load = (...t: string[]) => loadStore('wat', ...t)
const EX = 'https://example.org/evil#'

/** An authored source with a component whose SPARQL rule renders `markup` (CONSTRUCT triples about ?root). */
function evil(markup: string, where = '', extra = '') {
  return `@prefix ex: <${EX}> .
ex:Evil a owl:Class ; rdfs:subClassOf sem:Component ; sem:slug "ex-evil" .
ex:EvilRendering a sem:Rendering ; sem:targets ex:Evil ; sem:stratum 0 .
ex:EvilRendering-sparql a sem:Rule ; sem:implements ex:EvilRendering ; sem:construct """
PREFIX ex: <${EX}>
CONSTRUCT { ?root a rdfhtml:Div ; sem:renders $this ; rdfhtml:hasChild ?x . ${markup} }
WHERE { $this a ex:Evil . BIND(IRI(CONCAT(STR($this), "/~root")) AS ?root) BIND(IRI(CONCAT(STR($this), "/~x")) AS ?x) BIND(IRI(CONCAT(STR($this), "/~t")) AS ?t) BIND(IRI(CONCAT(STR($this), "/~a")) AS ?a) ${where} }""" .
ex:it a ex:Evil .
${extra}`
}

/** Build the source in a sandbox (authored), and render it as the browser does and as a server does. */
function render(text: string) {
  const sources: SandboxSource[] = [{ name: 'evil.ttl', text }]
  const built = buildSandbox(sources, EX + 'it', { load, withText: true })
  const sandbox = built.sandbox as Sandbox
  expect(sandbox, built.problems.map((p) => p.message).join('\n')).toBeDefined()
  const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const host = document.getElementById('app')!
  new DomRenderer(sandbox.screen.index, host, sandbox.root).flush()
  const html = toHTML(sandbox.screen.index, sandbox.root)
  const text_ = toText(sandbox.text!.index, sandbox.root)
  const warnings = built.problems.filter((p) => p.severity === 'warning').map((p) => p.message)
  const out = { dom: host.innerHTML, html, text: text_, warnings, css: sandbox.css ?? '', document: host }
  sandbox.runtime.dispose()
  return out
}

describe('an authored graph (a live example) cannot', () => {
  it('render a script element: it is an empty sem-refused, and reported', () => {
    const r = render(evil('?x a rdfhtml:Script ; rdfhtml:hasChild ?t . ?t a rdfhtml:Text ; rdfhtml:data "window.pwned = 1" .'))
    for (const out of [r.dom, r.html]) {
      expect(out).not.toMatch(/<script/i)
      expect(out).not.toContain('pwned')
      expect(out).toContain('<sem-refused data-sem-refused="script"></sem-refused>')
    }
    expect(r.text).not.toContain('pwned')
    expect(r.warnings.join('\n')).toMatch(/Refused on <[^>]+~x>: authored content may not have a script element/)
  })

  it('render an iframe, object, embed, base, link, meta or style element', () => {
    for (const cls of ['Iframe', 'Object', 'Embed', 'Base', 'Link', 'Meta', 'Style', 'Noscript', 'Template']) {
      const r = render(evil(`?x a rdfhtml:${cls} ; rdfhtml:src "https://evil.example/" ; rdfhtml:href "https://evil.example/" .`))
      for (const out of [r.dom, r.html]) {
        expect(out).toContain(`<sem-refused data-sem-refused="${cls.toLowerCase()}"></sem-refused>`)
        expect(out).not.toContain('evil.example')
      }
      expect(r.warnings.some((w) => w.includes(`may not have a ${cls.toLowerCase()} element`))).toBe(true)
    }
  })

  it('set an event handler attribute (on…), by property or by attribute node', () => {
    const r = render(
      evil('?x a rdfhtml:Button ; rdfhtml:attribute ?a ; rdfhtml:title "kept" . ?a a rdfhtml:Attribute ; rdfhtml:attributeName "onclick" ; rdfhtml:attributeValue "window.pwned = 1" .'),
    )
    for (const out of [r.dom, r.html]) {
      expect(out).not.toMatch(/onclick/i)
      expect(out).toContain('<button title="kept"></button>')
    }
    expect(r.warnings.join('\n')).toMatch(/onclick: authored content may not have the attribute onclick/)
  })

  it('link to a javascript: URL, however it is spelled', () => {
    for (const url of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', '\u0001javascript:alert(1)', 'vbscript:x', 'data:text/html,<script>alert(1)</script>']) {
      const r = render(evil(`?x a rdfhtml:A ; rdfhtml:href ${JSON.stringify(url)} ; rdfhtml:hasChild ?t . ?t a rdfhtml:Text ; rdfhtml:data "link" .`))
      for (const out of [r.dom, r.html]) {
        expect(out).toContain('<a>link</a>')
        expect(out).not.toMatch(/script:|data:/i)
      }
      expect(r.warnings.join('\n')).toMatch(/href: authored content may not have a [a-z]+: URL here/)
    }
  })

  it('submit a form to a javascript: URL (action, formaction)', () => {
    const r = render(evil('?x a rdfhtml:Form ; rdfhtml:action "javascript:alert(1)" ; rdfhtml:hasChild ?a . ?a a rdfhtml:Button ; rdfhtml:formAction "javascript:alert(2)" .'))
    for (const out of [r.dom, r.html]) expect(out).not.toMatch(/javascript/i)
    expect(r.warnings.filter((w) => w.includes('javascript: URL'))).toHaveLength(2)
  })

  it('give srcdoc, or an image a data: URL that is not an image', () => {
    const r = render(evil('?x a rdfhtml:Img ; rdfhtml:srcdoc "<script>alert(1)</script>" ; rdfhtml:src "data:text/html,x" ; rdfhtml:alt "a" .'))
    for (const out of [r.dom, r.html]) {
      expect(out).toContain('<img alt="a">')
      expect(out).not.toMatch(/srcdoc|data:/)
    }
    expect(r.warnings.join('\n')).toMatch(/srcdoc: authored content may not have the attribute srcdoc/)
  })

  it('load a script through SVG: no SVG script, foreignObject or animation exists, an href attribute on SVG is not one', () => {
    const r = render(
      evil('?x a svg:Svg ; rdfhtml:hasChild ?t . ?t a svg:Path ; rdfhtml:attribute ?a ; rdfhtml:style "fill: url(https://evil.example/x.svg#p)" . ?a a rdfhtml:Attribute ; rdfhtml:attributeName "onload" ; rdfhtml:attributeValue "alert(1)" .'),
    )
    for (const out of [r.dom, r.html]) {
      expect(out).toMatch(/<svg><path( \/)?>(<\/path>)?<\/svg>/)
      expect(out).not.toMatch(/onload|evil\.example/)
    }
    expect(r.warnings.join('\n')).toMatch(/style: authored styles may not load a resource \(url\(\)\)/)
  })

  it('load a resource from its styles: url(), image-set(), @import, or a rule broken out of its block', () => {
    const extra = `
[] a sty:StyleRule ; sty:appliesTo ex:Evil ; sty:declares [ sty:property "background" ; sty:raw "url(https://evil.example/track.png)" ] .
[] a sty:StyleRule ; sty:appliesTo ex:Evil ; sty:declares [ sty:property "background-image" ; sty:raw "image-set('https://evil.example/a.png' 1x)" ] .
[] a sty:StyleRule ; sty:appliesTo ex:Evil ; sty:declares [ sty:property "color" ; sty:raw "red } @import url(https://evil.example/x.css); body { color: red" ] .
[] a sty:StyleRule ; sty:appliesTo ex:Evil ; sty:declares [ sty:property "color" ; sty:raw "u\\\\72l(https://evil.example/escaped)" ] .
[] a sty:StyleRule ; sty:appliesTo ex:Evil ; sty:part "a } body { background: url(https://evil.example/p)" ; sty:declares [ sty:property "color" ; sty:raw "red" ] .
[] a sty:StyleRule ; sty:appliesTo ex:Evil ; sty:declares [ sty:property "-moz-binding" ; sty:raw "none" ] .
ex:evil-token a sty:Token ; sem:slug "evil" ; sty:value "url(https://evil.example/token)" .
[] a sty:StyleRule ; sty:appliesTo ex:Evil ; sty:declares [ sty:property "color" ; sty:raw "rebeccapurple" ] ,
    [ sty:property "background-image" ; sty:raw "url(\\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E\\")" ] .`
    const r = render(evil('?x a rdfhtml:Span .', '', extra))
    expect(r.css).not.toMatch(/evil\.example|@import|binding/)
    // What passes stays: a plain value, and an image that loads nothing from elsewhere.
    expect(r.css).toContain('color: rebeccapurple;')
    expect(r.css).toContain("url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E\")")
    const refused = r.warnings.filter((w) => w.startsWith('Refused a style'))
    expect(refused.length).toBeGreaterThanOrEqual(6)
    expect(refused.join('\n')).toMatch(/may not load a resource \(url\(\)\)/)
    expect(refused.join('\n')).toMatch(/may not load a resource \(image-set\(\)\)/)
    expect(refused.join('\n')).toMatch(/may not hold "}" here/)
    expect(refused.join('\n')).toMatch(/may not escape characters outside a string/)
    expect(refused.join('\n')).toMatch(/may not set -moz-binding/)
  })

  it('use a refused element to smuggle what it holds: a refused element is empty in every modality', () => {
    const r = render(evil('?x a rdfhtml:Noscript ; rdfhtml:hasChild ?t . ?t a rdfhtml:Img ; rdfhtml:src "x" ; rdfhtml:alt "secret" .'))
    expect(r.dom).not.toContain('secret')
    expect(r.html).not.toContain('secret')
  })
})

describe('an authored graph can still', () => {
  it('link to http(s), mailto: and tel: addresses, relative ones and fragments, and show data: images', () => {
    const r = render(
      evil(
        '?x a rdfhtml:A ; rdfhtml:href "https://example.org/" ; rdfhtml:hasChild ?t . ?t a rdfhtml:Img ; rdfhtml:src "data:image/png;base64,AAAA" ; rdfhtml:alt "" ; rdfhtml:style "color: red; --x: var(--sem-accent)" ; rdfhtml:attribute ?a . ?a a rdfhtml:Attribute ; rdfhtml:attributeName "data-ex-thing" ; rdfhtml:attributeValue "1" .',
      ),
    )
    for (const out of [r.dom, r.html]) {
      expect(out).toContain('href="https://example.org/"')
      expect(out).toContain('src="data:image/png;base64,AAAA"')
      expect(out).toContain('data-ex-thing="1"')
      expect(out).toMatch(/style="color: red; --x: var\(--sem-accent\)"/)
    }
    expect(r.warnings.filter((w) => w.startsWith('Refused'))).toEqual([])
  })
})

describe('the policy', () => {
  it('is read from a trusted store: what an authored graph adds to it does not count', () => {
    const r = render(evil('?x a rdfhtml:Script .', '', 'safe:Authored safe:element rdfhtml:Script ; safe:attribute "onclick" .'))
    expect(r.dom).toContain('sem-refused')
  })

  it('checks URLs as a browser reads them', () => {
    expect(urlProblem(policy, 'photos/a.jpg')).toBeUndefined()
    expect(urlProblem(policy, '/docs/')).toBeUndefined()
    expect(urlProblem(policy, '#top')).toBeUndefined()
    expect(urlProblem(policy, '?q=1')).toBeUndefined()
    expect(urlProblem(policy, 'mailto:a@example.org')).toBeUndefined()
    expect(urlProblem(policy, 'jav\nascript:x')).toBeDefined()
    expect(urlProblem(policy, '  javascript:x')).toBeDefined()
    expect(urlProblem(policy, 'data:image/png;base64,AA')).toBeDefined()
    expect(urlProblem(policy, 'data:image/png;base64,AA', true)).toBeUndefined()
    expect(urlProblem(policy, 'blob:https://x/1', true)).toBeUndefined()
  })

  it('reads CSS far enough to know it stays a value', () => {
    expect(cssProblem(policy, 'calc(100% - var(--sem-space-2))', 'value')).toBeUndefined()
    expect(cssProblem(policy, '"\\2022"', 'value')).toBeUndefined()
    expect(cssProblem(policy, 'url(#gradient)', 'value')).toBeUndefined()
    expect(cssProblem(policy, "'unclosed", 'value')).toBeDefined()
    expect(cssProblem(policy, 'calc(1px', 'value')).toBeDefined()
    expect(cssProblem(policy, 'red; color: blue', 'value')).toBeDefined()
    expect(cssProblem(policy, ':is(.a, .b) > [data-x="a,b"]', 'selector')).toBeUndefined()
    expect(cssProblem(policy, 'a{}', 'selector')).toBeDefined()
    expect(declarationsProblem(policy, 'color: red; background: url(//evil.example/x)')).toBeDefined()
    expect(declarationsProblem(policy, 'content: "a;b"; color: red')).toBeUndefined()
  })

  it('lets uploads go to the page’s own origin and the origins the host allows, nowhere else', () => {
    expect(uploadRefused('/upload')).toBeUndefined()
    expect(uploadRefused('https://evil.example/upload')).toMatch(/not uploaded to https:\/\/evil\.example/)
    expect(uploadRefused('https://uploads.example.com/f', ['https://uploads.example.com'])).toBeUndefined()
    expect(uploadRefused('javascript:alert(1)')).toMatch(/javascript:/)
    expect(uploadRefused('https://evil.example/upload', ['*'])).toBeUndefined()
  })
})

describe('what the framework itself emits', () => {
  it('compiles every style of the site with nothing refused', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    const gallery = readdirSync(new URL('../demo/gallery/', import.meta.url)).filter((f) => f.endsWith('.ttl'))
    const site = loadStore('wat', read('../demo/app.ttl'), ...gallery.map((f) => read(`../demo/gallery/${f}`)))
    try {
      const refused: string[] = []
      const css = compileStyles(site, { policy: authoredPolicy(site), onRefused: (e) => refused.push(e.message) })
      expect(refused).toEqual([])
      expect(css).toBe(compileStyles(site))
    } finally {
      site.dispose?.()
    }
  })

  it('renders every live example of the site with nothing refused', () => {
    const st = new Store()
    const dir = new URL('../demo/gallery/', import.meta.url)
    for (const file of readdirSync(dir).filter((x) => x.endsWith('.ttl'))) st.addQuads(new Parser().parse(readFileSync(new URL(file, dir), 'utf8')))
    const one = (s: Parameters<Store['getObjects']>[0], p: string) => st.getObjects(s, p, null)[0]
    const refused: string[] = []
    let built = 0
    for (const ex of st.getSubjects(NS.rdf + 'type', NS.c + 'LiveExample', null)) {
      const sources: SandboxSource[] = []
      for (let cell = one(ex, NS.c + 'sources'); cell && cell.value !== NS.rdf + 'nil'; cell = one(cell, NS.rdf + 'rest')) {
        const editor = one(cell, NS.rdf + 'first')!
        sources.push({ editor: editor.value, name: one(editor, NS.c + 'label')!.value, text: one(editor, NS.c + 'original')!.value })
      }
      const b = buildSandbox(sources, one(ex, NS.c + 'exampleRoot')!.value, { load, policy, withText: one(ex, NS.c + 'textPreview')?.value === 'true' })
      if (b.sandbox) {
        built++
        // Every node it renders, not only the first screen: the whole HTML, as a server writes it.
        toHTML(b.sandbox.screen.index, b.sandbox.root)
        refused.push(...[...b.sandbox.screen.index.refusals].flatMap(([k, rs]) => [...rs].map((r) => `${ex.value}: <${k}> ${r}`)))
        b.sandbox.runtime.dispose()
      }
      refused.push(...b.problems.filter((p) => p.message.startsWith('Refused')).map((p) => `${ex.value}: ${p.message}`))
    }
    expect(built).toBeGreaterThan(10)
    expect([...new Set(refused)]).toEqual([])
  })
})
