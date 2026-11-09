import { readdirSync, readFileSync, statSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { Parser, Store } from 'n3'
import { afterAll, describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { uploadRefused } from '../src/files.ts'
import { Islands, type IslandAdapter, type Widget } from '../src/foreign.ts'
import { HtmlIndex } from '../src/render/html-index.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import type { HostAdapter } from '../src/render/hosts.ts'
import { toHTML, toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { attributeProblem, authoredPolicy, cssProblem, declarationsProblem, idReferences, readPolicy, type SafetyPolicy, urlProblem } from '../src/safety.ts'
import { DEFAULT_LAYERS } from '../src/web/mount.ts'
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

/** BINDs of more minted nodes for evil's markup (`$this/~<name>`). */
const bind = (...vars: string[]) => vars.map((v) => `BIND(IRI(CONCAT(STR($this), "/~${v.slice(1)}")) AS ${v})`).join(' ')

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

  it('have a component drawn by a host component or created as a custom element the policy does not list', () => {
    const hosted = evil('', '', `ex:Evil rdfs:subClassOf ext:Hosted ; ext:component "Evil" ; ext:tag "x-evil" .`)
    const built = buildSandbox([{ name: 'evil.ttl', text: hosted }], EX + 'it', { load, withText: true })
    const sandbox = built.sandbox as Sandbox
    const index = sandbox.screen.index
    // A host that has the component: it is not asked to draw it.
    const drawn: string[] = []
    const hosts: HostAdapter = {
      has: () => true,
      mount: (_c, key) => (drawn.push(key), { destroy() {} }),
      html: () => '<x-drawn></x-drawn>',
      patch() {},
      keyOf: () => undefined,
      nodeOf: () => undefined,
      dispose() {},
    }
    const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    const host = document.getElementById('app')!
    new DomRenderer(index, host, sandbox.root, hosts).flush()
    const html = toHTML(index, sandbox.root, { hosts })
    expect(drawn).toEqual([])
    for (const out of [host.innerHTML, html]) {
      expect(out).not.toContain('sem-host')
      expect(out).not.toContain('<x-evil')
      expect(out).toContain('<div data-sem-c="ex-evil">')
    }
    const reasons = [...(index.refusals.get(EX + 'it/~root') ?? [])].join('\n')
    expect(reasons).toContain('host component Evil is not allowed in authored content; rendered as its element')
    expect(reasons).toContain('custom element x-evil is not allowed in authored content; rendered as its element')
    sandbox.runtime.dispose()
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

  it('refer by id to an element it does not render (the page it is shown in has others)', () => {
    const attr = (v: string, name: string, value: string) => `${v} rdfhtml:attribute ${v}A . ${v}A a rdfhtml:Attribute ; rdfhtml:attributeName "${name}" ; rdfhtml:attributeValue "${value}" .`
    const r = render(
      evil(`?x a rdfhtml:Button ; rdfhtml:form "elsewhere" ; rdfhtml:commandfor "elsewhere" ; rdfhtml:popovertarget "elsewhere" ; rdfhtml:hasChild ?t . ?t a rdfhtml:Text ; rdfhtml:data "Go" .
            ?root rdfhtml:hasChild ?a . ?a a rdfhtml:A ; rdfhtml:href "#elsewhere" .
            ${attr('?a', 'aria-describedby', 'elsewhere')}
            ${attr('?x', 'data-sem-anchor', 'elsewhere')}`, bind('?aA', '?xA')),
    )
    for (const out of [r.dom, r.html]) {
      expect(out).not.toContain('elsewhere')
      expect(out).toMatch(/<button[^>]*>Go<\/button>/)
    }
    const why = r.warnings.join('\n')
    for (const name of ['form', 'commandfor', 'popovertarget', 'href', 'aria-describedby', 'data-sem-anchor']) expect(why).toContain(`${name}: authored content may refer only to its own ids`)
  })

  it('keep the opener of a page it opens, set a referrer policy, or set the hooks the host sets', () => {
    const r = render(
      evil(`?x a rdfhtml:A ; rdfhtml:href "https://example.org/" ; rdfhtml:target "_blank" ; rdfhtml:rel "noreferrer Opener" .
            ?root rdfhtml:hasChild ?a . ?a a rdfhtml:Img ; rdfhtml:src "a.png" ; rdfhtml:alt "" ; rdfhtml:attribute ?p, ?h .
            ?p a rdfhtml:Attribute ; rdfhtml:attributeName "referrerpolicy" ; rdfhtml:attributeValue "no-referrer" .
            ?h a rdfhtml:Attribute ; rdfhtml:attributeName "data-sem-ssr" ; rdfhtml:attributeValue "" .`,
        bind('?p', '?h'),
      ),
    )
    for (const out of [r.dom, r.html]) {
      expect(out).not.toMatch(/ rel=/)
      expect(out).not.toContain('referrerpolicy')
      expect(out).not.toContain('data-sem-ssr')
      expect(out).toContain('target="_blank"')
    }
    expect(attributeProblem(policy, 'rel', 'noopener noreferrer')).toBeUndefined()
    expect(attributeProblem(policy, 'rel', 'next\topener')?.reason).toMatch(/link type opener/)
    expect(attributeProblem(policy, 'DATA-SEM-SANDBOX', '1')).toBeDefined()
    expect(attributeProblem(policy, 'data-sem-c', 'ex-thing')).toBeUndefined()
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

const PFX = `@prefix ex: <${EX}> .\n` + Object.entries(NS).filter(([k]) => /^[a-z]+$/.test(k)).map(([k, v]) => `@prefix ${k}: <${v}> .`).join('\n') + '\n'

/**
 * An authored graph as mount({ graphs, authored }) renders it (src/web/mount.ts): a screen projection
 * with the policy, a DOM renderer, the event bus and the islands effect with the host's widgets,
 * modules and adapters. `withPolicy`: the effect is given the policy as mount gives it; otherwise it
 * reads the index's.
 */
function mounted(authored: string, pol: SafetyPolicy = policy, opts: { widgets?: Record<string, Widget>; modules?: Record<string, () => Promise<unknown>>; adapters?: Record<string, IslandAdapter>; withPolicy?: boolean } = {}) {
  const store = load(PFX + authored)
  const runtime = new Runtime(store)
  const refused: string[] = []
  const projection = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, prefer: 'sparql', name: 'screen', roots: [EX + 'it'], policy: pol }, (e) => refused.push(e.message))
  const { document } = parseHTML('<!doctype html><html><head></head><body><div id="app"></div></body></html>')
  const host = document.getElementById('app')!
  const renderer = new DomRenderer(projection.index, host, EX + 'it')
  renderer.flush()
  const bus = new EventBus(runtime, projection)
  bus.attach(renderer, () => renderer.flush())
  const errors: string[] = []
  const islands = new Islands(bus, renderer, { ...opts, policy: opts.withPolicy === false ? undefined : pol, onHandled: () => renderer.flush(), onError: (e) => errors.push(e.message) })
  islands.attach()
  const html = () => toHTML(projection.index, EX + 'it')
  return { store, runtime, host, renderer, islands, refused, errors, html, dispose: () => runtime.dispose() }
}

describe('an authored island', () => {
  it('cannot name a custom element the policy does not list: nothing is created, in the DOM, by the islands effect or in server HTML, and it is reported', async () => {
    for (const withPolicy of [true, false]) {
      const m = mounted(`ex:W a owl:Class ; rdfs:subClassOf ext:Island ; ext:tag "x-unlisted" ;
  ext:input [ ext:name "title" ; ext:from ex:p ; ext:as ext:Attribute ] .
ex:it a ex:W ; ex:p "hello" .`, policy, { withPolicy })
      await m.islands.settled()
      expect(m.host.querySelector('x-unlisted')).toBeNull()
      expect(m.html()).not.toContain('x-unlisted>')
      expect(m.html()).not.toContain('<x-unlisted')
      expect(m.islands.size).toBe(0)
      expect(m.refused.join('\n')).toMatch(/custom element x-unlisted is not allowed in authored content/)
      m.dispose()
    }
  })

  it('cannot mount a widget, a module or an adapter the policy does not list, though the host registered it', async () => {
    let widgetMounts = 0
    let loads = 0
    let adapted = 0
    const widget: Widget = { mount: () => (widgetMounts++, { update() {}, destroy() {} }) }
    const opts = {
      widgets: { w: widget },
      modules: { m: async () => void loads++ },
      adapters: { [EX + 'Adapter']: (() => (adapted++, { update() {}, destroy() {} })) as IslandAdapter },
    }
    const sources = [
      `ex:it a ext:Island ; ext:widget "w" .`,
      `ex:it a ext:Island ; ext:widget "w" ; ext:module "m" .`,
      `ex:it a ext:Island ; ext:adapter ex:Adapter .`,
    ]
    for (const src of sources) {
      const m = mounted(src, policy, opts)
      await m.islands.settled()
      expect(m.islands.counts.mounts).toBe(0)
      expect(m.refused.join('\n')).toMatch(/is not allowed in authored content; rendered as its element/)
      m.dispose()
    }
    expect([widgetMounts, loads, adapted]).toEqual([0, 0, 0])
    // Listed, each mounts.
    const listed: SafetyPolicy = { ...policy, widgets: new Set(['w']), modules: new Set(['m']), adapters: new Set([EX + 'Adapter']) }
    for (const src of sources) {
      const m = mounted(src, listed, opts)
      await m.islands.settled()
      expect(m.errors).toEqual([])
      m.dispose()
    }
    expect([widgetMounts, loads, adapted]).toEqual([2, 1, 1])
  })

  it('sets only the inputs the policy allows on a custom element it lists: attributes pass the attribute check, properties must be listed, and none takes markup or a handler', async () => {
    const listed: SafetyPolicy = { ...policy, customElements: new Set(['x-ok']), properties: new Set(['value', 'innerHTML', 'onclick']) }
    const inputs = `ext:input [ ext:name "value" ; ext:from ex:v ] , [ ext:name "label" ; ext:from ex:v ] , [ ext:name "innerHTML" ; ext:from ex:v ] ,
    [ ext:name "onclick" ; ext:from ex:v ] , [ ext:name "title" ; ext:from ex:v ; ext:as ext:Attribute ] ,
    [ ext:name "onfocus" ; ext:from ex:v ; ext:as ext:Attribute ] , [ ext:name "href" ; ext:from ex:u ; ext:as ext:Attribute ]`
    // An island in its slot, and a hosted component created as the custom element (its props set by the DOM renderer).
    const island = `ex:W a owl:Class ; rdfs:subClassOf ext:Island ; ext:tag "x-ok" ;\n  ${inputs} .\nex:it a ex:W ; ex:v "<b>v</b>" ; ex:u "javascript:void 0" .`
    const hosted = `ex:W a owl:Class ; rdfs:subClassOf ext:Hosted , sem:Component ; sem:slug "ex-ok" ; ext:tag "x-ok" ;\n  ${inputs} .
ex:WRendering a sem:Rendering ; sem:targets ex:W ; sem:stratum 0 .
ex:WRendering-sparql a sem:Rule ; sem:implements ex:WRendering ; sem:construct """
PREFIX ex: <${EX}>
CONSTRUCT { ?root a rdfhtml:Div ; sem:renders $this . } WHERE { $this a ex:W . BIND(IRI(CONCAT(STR($this), "/~root")) AS ?root) }""" .
ex:it a ex:W ; ex:v "<b>v</b>" ; ex:u "javascript:void 0" .`
    for (const src of [island, hosted]) {
      const m = mounted(src, listed)
      await m.islands.settled()
      const el = m.host.querySelector('x-ok') as (Element & Record<string, unknown>) | null
      expect(el, m.host.innerHTML + '\n' + m.errors.join('\n')).not.toBeNull()
      expect(el!.value).toBe('<b>v</b>')
      expect(el!.getAttribute('title')).toBe('<b>v</b>')
      expect(el!.label).toBeUndefined()
      expect(el!.children.length).toBe(0)
      expect(typeof el!.onclick === 'string').toBe(false)
      for (const name of ['onfocus', 'href', 'onclick']) expect(el!.hasAttribute(name)).toBe(false)
      if (src === island) {
        const html = m.html()
        expect(html).toContain('<x-ok title="&lt;b&gt;v&lt;/b&gt;"></x-ok>')
        expect(html).not.toMatch(/onfocus|javascript:/)
      }
      const reasons = m.refused.join('\n')
      for (const name of ['label', 'innerHTML', 'onclick']) expect(reasons).toContain(`${name}: authored content may not set the property ${name}`)
      expect(reasons).toContain('onfocus: authored content may not have the attribute onfocus')
      expect(reasons).toMatch(/href: authored content may not have a javascript: URL/)
      m.dispose()
    }
  })
})

describe('an island input', () => {
  it('whose name is not an attribute name is never written, trusted or not', () => {
    for (const pol of [undefined, { ...policy, customElements: new Set(['x-ok']) }]) {
      const store = load(PFX + `ex:it a ext:Island ; ext:tag "x-ok" ; ext:input [ ext:name "a b" ; ext:from ex:v ; ext:as ext:Attribute ] , [ ext:name "c>d" ; ext:from ex:v ; ext:as ext:Attribute ] , [ ext:name "data-ok" ; ext:from ex:v ; ext:as ext:Attribute ] ; ex:v "1" .`)
      const runtime = new Runtime(store)
      const errors: string[] = []
      const projection = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, prefer: 'sparql', name: 'screen', roots: [EX + 'it'], policy: pol }, (e) => errors.push(e.message))
      expect(projection.index).toBeInstanceOf(HtmlIndex)
      const html = toHTML(projection.index, EX + 'it')
      expect(html).toContain('<x-ok data-ok="1"></x-ok>')
      expect(html).not.toMatch(/a b|c>d|c&gt;d/)
      expect(errors.join('\n')).toContain('"c>d" is not an input name')
      runtime.dispose()
    }
  })
})

describe('an authored graph can still refer to its own elements by id', () => {
  it('as the framework’s components do (labels, ARIA relationships, fragments)', () => {
    const r = render(
      evil(`?x a rdfhtml:Label ; rdfhtml:for "ex-name" ; rdfhtml:hasChild ?t . ?t a rdfhtml:Text ; rdfhtml:data "Name" .
            ?root rdfhtml:hasChild ?a . ?a a rdfhtml:Input ; rdfhtml:id "ex-name" ; rdfhtml:attribute ?d . ?d a rdfhtml:Attribute ; rdfhtml:attributeName "aria-describedby" ; rdfhtml:attributeValue " ex-name  ex-name " .
            ?x rdfhtml:attribute ?l . ?l a rdfhtml:Attribute ; rdfhtml:attributeName "aria-labelledby" ; rdfhtml:attributeValue "ex-name" .`, bind('?d', '?l')),
    )
    for (const out of [r.dom, r.html]) {
      expect(out).toContain('for="ex-name"')
      expect(out).toContain('aria-labelledby="ex-name"')
      expect(out).toMatch(/<input[^>]*aria-describedby=" ex-name  ex-name "/)
    }
    expect(r.warnings.filter((w) => w.startsWith('Refused'))).toEqual([])
  })

  it('whichever comes first, the reference or the id, and not once the id is gone', () => {
    const parse = (t: string) => new Parser().parse(`@prefix h: <https://ia2.dev/spec/rdf-html#> . @prefix ui: <https://example.org/ui#> . ${t}`)
    const refused: string[] = []
    const index = new HtmlIndex((e) => refused.push(e.message), undefined, policy)
    const read = () => toHTML(index, 'https://example.org/ui#root')
    index.apply({ add: parse('ui:root a h:Div ; h:hasChild ui:label, ui:field . ui:label a h:Label ; h:for "f" . ui:field a h:Input .'), remove: [] })
    expect(read()).not.toContain('for=')
    index.apply({ add: parse('ui:field h:id "f" .'), remove: [] })
    expect(read()).toContain('<label for="f">')
    index.apply({ add: [], remove: parse('ui:field h:id "f" .') })
    expect(read()).not.toContain('for=')
    expect(refused.length).toBeGreaterThan(0)
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

  it('trims a URL in time linear in its length', () => {
    const spaced = 'a' + ' '.repeat(1_000_000) + 'b'
    const start = performance.now()
    expect(urlProblem(policy, spaced)).toBeUndefined()
    expect(performance.now() - start).toBeLessThan(500)
  })

  it('reads id references: one id, a list of them, or a URL that is a fragment', () => {
    expect(idReferences(policy, 'for', 'a b')).toEqual(['a b'])
    expect(idReferences(policy, 'aria-labelledby', ' a\tb ')).toEqual(['a', 'b'])
    expect(idReferences(policy, 'href', ' #top')).toEqual(['top'])
    expect(idReferences(policy, 'href', '#')).toEqual([])
    expect(idReferences(policy, 'href', 'page#top')).toBeUndefined()
    expect(idReferences(policy, 'title', 'a')).toBeUndefined()
  })

  it('allows every hook of the framework its components render, and no other data-sem- one', () => {
    // A data-sem- name the ontology renders is a string literal of its own there (an attribute
    // node's name, a hook attribute, a keyboard binding's attribute).
    const names = new Set<string>()
    const walk = (dir: URL) => {
      for (const f of readdirSync(dir)) {
        const at = new URL(f, dir)
        if (statSync(at).isDirectory()) walk(new URL(f + '/', dir))
        else if (f.endsWith('.ttl') && f !== 'safety.ttl') for (const m of readFileSync(at, 'utf8').matchAll(/"(data-sem-[a-z0-9-]+)"/g)) names.add(m[1]!)
      }
    }
    walk(new URL('../ontology/', import.meta.url))
    expect(names.size).toBeGreaterThan(50)
    expect([...names].filter((n) => attributeProblem(policy, n, '') !== undefined)).toEqual([])
    expect(attributeProblem(policy, 'data-sem-sandbox', '1')).toBeDefined()
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
