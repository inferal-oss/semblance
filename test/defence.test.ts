// Defence in depth for authored content (#414): work budgets, the shadow-root mount, a content
// security policy with Trusted Types, and framework globals that named elements do not reach.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHTML } from 'linkedom'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { attributeProblem, cssProblem, declarationsProblem, readPolicy, Refused, type SafetyPolicy } from '../src/safety.ts'
import { completeSource } from '../src/sandbox.ts'
import { renderToString } from '../src/server/render.ts'
import { renderDocument } from '../src/server/document.ts'
import { contentSecurityPolicy, inlineScriptHashes, scriptHash } from '../src/server/csp.ts'
import { mount, type MountedApp } from '../src/web/mount.ts'

const ontology = loadStore('wat')
const policy = readPolicy(ontology)
afterAll(() => ontology.dispose?.())
const EX = 'https://example.org/grow#'

/**
 * An authored component that never stops: each ex:Grow renders a div holding the next two, which
 * it mints (`$this/~l`, `$this/~r`), so every evaluation asks for two more.
 */
const runaway = `@prefix ex: <${EX}> .
ex:Grow a owl:Class ; rdfs:subClassOf sem:Component ; sem:slug "ex-grow" .
ex:GrowRendering a sem:Rendering ; sem:targets ex:Grow ; sem:stratum 0 .
ex:GrowRendering-sparql a sem:Rule ; sem:implements ex:GrowRendering ; sem:construct """
PREFIX ex: <${EX}>
CONSTRUCT { ?root a rdfhtml:Div ; sem:renders $this ; rdfhtml:hasChild ?l , ?r . ?l a ex:Grow . ?r a ex:Grow . ?l ord:precedes ?r . }
WHERE { $this a ex:Grow . BIND(IRI(CONCAT(STR($this), "/~root")) AS ?root) BIND(IRI(CONCAT(STR($this), "/~l")) AS ?l) BIND(IRI(CONCAT(STR($this), "/~r")) AS ?r) }""" .
ex:it a ex:Grow .
`

async function ssr(pol: SafetyPolicy) {
  const store = loadStore('wat', completeSource(runaway))
  const refused: Error[] = []
  try {
    const r = await renderToString({ store, root: EX + 'it', policy: pol, trusted: ontology, onRefused: (e) => refused.push(e) })
    r.runtime.dispose()
    return { ...r, refused }
  } finally {
    store.dispose?.()
  }
}

describe('work budgets of an authored graph', () => {
  it('stop a runaway rule at its evaluation budget on the server, report it, and render as far as it got', async () => {
    const r = await ssr({ ...policy, budgetMs: Infinity, maxEvaluations: 300 })
    const over = r.refused.filter((e) => e instanceof Refused && e.kind === 'budget')
    expect(over).toHaveLength(1)
    expect(over[0]!.message).toMatch(/took more than 300 rule evaluations/)
    expect(r.exceeded).toBe(over[0]!.message)
    expect(r.html).toContain('data-sem-c="ex-grow"')
  })

  it('stop it at the output budget (derived triples)', async () => {
    const r = await ssr({ ...policy, budgetMs: Infinity, maxEvaluations: Infinity, maxDerived: 2000 })
    expect(r.exceeded).toMatch(/derived more than 2000 triples/)
  })

  it('stop it at the time budget', async () => {
    const r = await ssr({ ...policy, budgetMs: 50, maxEvaluations: Infinity })
    expect(r.exceeded).toMatch(/took longer than 50 ms/)
  })

  it('stop it under the framework’s own policy', async () => {
    const t0 = performance.now()
    const r = await ssr(policy)
    expect(r.exceeded).toMatch(/^Stopped: authored content /)
    expect(performance.now() - t0).toBeLessThan(15_000)
  }, 30_000)

  it('refuse a checked string longer than safe:maxLength unread', () => {
    expect(policy.maxLength).toBeGreaterThan(65_536)
    const short = { ...policy, maxLength: 16 }
    expect(attributeProblem(short, 'title', 'x'.repeat(16))).toBeUndefined()
    expect(attributeProblem(short, 'title', 'x'.repeat(17))?.reason).toMatch(/longer than 16 characters/)
    expect(declarationsProblem(short, 'color: red; '.repeat(2))).toMatch(/longer than 16/)
    expect(cssProblem(short, 'a'.repeat(17), 'value')).toMatch(/longer than 16/)
  })
})

function host() {
  const { document, window } = parseHTML('<!doctype html><html><body><main id="app"></main></body></html>')
  document.adoptedStyleSheets = []
  class Sheet { text = ''; replaceSync(text: string) { this.text = text } }
  Object.defineProperty(window, 'CSSStyleSheet', { value: Sheet, configurable: true })
  Object.defineProperty(window, 'requestAnimationFrame', { value: () => 1, configurable: true })
  Object.defineProperty(window, 'cancelAnimationFrame', { value: () => {}, configurable: true })
  vi.stubGlobal('requestIdleCallback', () => 0)
  vi.stubGlobal('fetch', async () => new Response(readFileSync(new URL('../rdf-engine/build/wat.wasm', import.meta.url)), { headers: { 'Content-Type': 'application/wasm' } }))
  return { document, window, element: document.getElementById('app')! }
}

const apps: MountedApp[] = []
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('an authored mount', () => {
  it('stops a runaway rule at its budget and reports it', async () => {
    const { element } = host()
    const refused: Error[] = []
    const app = await mount(element, { root: EX + 'it', authored: [completeSource(runaway)], policy: { ...policy, budgetMs: Infinity, maxEvaluations: 300 }, store: 'wat', files: false, fullscreen: false, onRefused: (e) => refused.push(e) })
    apps.push(app)
    expect(refused.map((e) => e.message).join('\n')).toMatch(/took more than 300 rule evaluations/)
    expect(app.runtime.held).toBe(0)
    expect(element.innerHTML).toContain('data-sem-c="ex-grow"')
  })
})

const hello = ['app.ttl', 'tally.ttl'].map((f) => readFileSync(new URL(`../examples/hello/${f}`, import.meta.url), 'utf8'))
const HELLO = 'https://example.org/hello#'

describe('a mount isolated in a shadow root', () => {
  it('renders, styles and answers inside the shadow root, with nothing in the page’s document', async () => {
    const { document, window, element } = host()
    const app = await mount(element, { root: HELLO + 'page', authored: hello, isolate: 'shadow', store: 'wat', files: false, fullscreen: false })
    apps.push(app)
    const shadow = element.shadowRoot!
    expect(shadow).toBeTruthy()
    expect(element.children).toHaveLength(0)
    const box = shadow.firstElementChild as HTMLElement
    expect(box.getAttribute('data-sem-sandbox')).toMatch(/^authored-\d+$/)
    expect(box.textContent).toContain('0 cups')
    // Nothing of it is in the page's document: its elements, ids and names are the shadow root's.
    const button = box.querySelector('button')!
    expect(document.querySelector('[data-sem-c]')).toBeNull()
    expect(document.contains(button)).toBe(false)
    // The whole sheet is the shadow root's, every selector started at the box.
    expect(document.adoptedStyleSheets).toHaveLength(0)
    const [sheet] = shadow.adoptedStyleSheets as unknown as { text: string }[]
    const scope = `[data-sem-sandbox="${box.getAttribute('data-sem-sandbox')}"]`
    expect(sheet!.text).toContain(`${scope} [data-sem-c="ex-tally"]`)
    expect(sheet!.text).not.toMatch(/^\s*:root\b/m)
    button.dispatchEvent(new window.Event('click', { bubbles: true, composed: true }))
    expect(box.textContent).toContain('1 cups')
    app.unmount()
    expect(shadow.adoptedStyleSheets).toHaveLength(0)
  })

  it('works for trusted graphs too (a box of its own)', async () => {
    const { element } = host()
    const app = await mount(element, { root: HELLO + 'page', graphs: hello, isolate: 'shadow', store: 'wat', files: false, fullscreen: false })
    apps.push(app)
    const box = element.shadowRoot!.firstElementChild!
    expect(box.getAttribute('data-sem-sandbox')).toMatch(/^isolated-\d+$/)
    expect(box.textContent).toContain('0 cups')
  })
})

describe('the framework’s globals', () => {
  it('adopt the stylesheet past an element named adoptedStyleSheets', async () => {
    const { document, element } = host()
    // As a browser shows a named element: an own property of the document over its prototype's accessor.
    const adopted = new WeakMap<object, unknown[]>()
    const proto = Object.getPrototypeOf(document)
    Object.defineProperty(proto, 'adoptedStyleSheets', { configurable: true, get() { return adopted.get(this) ?? [] }, set(v: unknown[]) { adopted.set(this, v) } })
    try {
      delete (document as unknown as Record<string, unknown>).adoptedStyleSheets
      const img = document.createElement('img')
      Object.defineProperty(document, 'adoptedStyleSheets', { value: img, configurable: true })
      const app = await mount(element, { root: HELLO + 'page', authored: hello, store: 'wat', files: false, fullscreen: false })
      apps.push(app)
      expect(adopted.get(document)).toHaveLength(1)
      app.unmount()
      expect(adopted.get(document)).toHaveLength(0)
    } finally {
      delete proto.adoptedStyleSheets
    }
  })

  it('read the kept events only as a script set them, never an element of that id', async () => {
    const { replayKept } = await import('../src/web/takeover.ts')
    const { element } = host()
    const proto = Object.getPrototypeOf(globalThis)
    Object.defineProperty(proto, '__semblanceKept', { configurable: true, get: () => element })
    try {
      expect(() => replayKept(element)).not.toThrow()
      expect(replayKept(element)).toBe(0)
    } finally {
      delete proto.__semblanceKept
    }
  })
})

describe('the recommended Content-Security-Policy', () => {
  const template = '<!doctype html><html><head><meta charset="utf-8"><title>t</title><script type="module" src="/main.js"></script></head><body><div id="app"></div><script>console.log(1)</script></body></html>'
  const rendered = { html: '<p>hi</p>', css: 'p{}', lang: 'en', dir: 'ltr' as const }

  it('is the first thing after the charset, and allows the document’s inline scripts by hash and no others', () => {
    const page = renderDocument(template, rendered, { csp: { img: ['https://images.example'] } })
    const meta = /<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(page)
    expect(meta).not.toBeNull()
    const csp = meta![1]!.replace(/&#39;|&apos;/g, "'")
    const directive = (name: string) => csp.split('; ').find((d) => d.startsWith(name + ' '))
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    expect(scripts.length).toBeGreaterThanOrEqual(3) // the platform's, the capture's, the template's own
    for (const s of scripts) expect(directive('script-src')).toContain(`'sha256-${createHash('sha256').update(s).digest('base64')}'`)
    expect(inlineScriptHashes(page)).toHaveLength(scripts.length)
    expect(directive('script-src')).not.toMatch(/'unsafe-inline'|'unsafe-eval'/)
    expect(directive('script-src')).toContain("'wasm-unsafe-eval'")
    expect(directive('img-src')).toBe("img-src 'self' https://images.example data: blob:")
    // The stylesheet inline in the document is allowed by its hash; style attributes need inline (#157).
    expect(directive('style-src')).toBe(`style-src 'self' 'sha256-${createHash('sha256').update('p{}').digest('base64')}'`)
    expect(directive('style-src-attr')).toBe("style-src-attr 'unsafe-inline'")
    expect(directive('require-trusted-types-for')).toBe("require-trusted-types-for 'script'")
    expect(directive('trusted-types')).toBe('trusted-types semblance')
    for (const d of ["object-src 'none'", "base-uri 'none'", "form-action 'self'"]) expect(csp).toContain(d)
    // A meta cannot carry frame-ancestors; a header can.
    expect(csp).not.toContain('frame-ancestors')
    expect(contentSecurityPolicy()).toContain("frame-ancestors 'self'")
  })

  it('is left out unless asked for', () => {
    expect(renderDocument(template, rendered)).not.toContain('Content-Security-Policy')
  })

  it('hashes as SHA-256 does', () => {
    for (const s of ['', 'abc', 'x'.repeat(55), 'x'.repeat(64), 'héllo ✓ '.repeat(500)]) expect(scriptHash(s)).toBe(`'sha256-${createHash('sha256').update(s).digest('base64')}'`)
  })

  it('needs nothing of Semblance but its own policy: the framework never writes HTML or script from a string', () => {
    const sinks = /\.(?:innerHTML|outerHTML|srcdoc)\s*=(?!=)|insertAdjacentHTML\(|document\.write|\bnew Function\(|\beval\(|createContextualFragment\(|setHTMLUnsafe\(|parseHTMLUnsafe\(|new DOMParser\(/
    const found: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name)
        if (e.isDirectory()) walk(path)
        else if (/\.tsx?$/.test(e.name)) readFileSync(path, 'utf8').split('\n').forEach((line, i) => sinks.test(line) && !/^\s*(\/\/|\*)/.test(line) && found.push(`${path}:${i + 1}`))
      }
    }
    walk(fileURLToPath(new URL('../src/', import.meta.url)))
    expect(found).toEqual([])
  })
})
