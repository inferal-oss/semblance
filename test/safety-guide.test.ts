import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { renderToString } from '../src/server/render.ts'
import { authoredPolicy, readPolicy, Refused, type SafetyPolicy } from '../src/safety.ts'
import { mount, type MountedApp } from '../src/web/mount.ts'

// The worked examples of docs/SAFETY.md, as the guide shows them: an app that mounts a graph it
// does not trust, a policy extended by the app's own Turtle, a stricter policy, and a server render.

const UI = 'https://example.org/ui#'
const prefixes = `@prefix ui: <${UI}> .\n@prefix c: <https://semblance.dev/ns/component#> .\n@prefix safe: <https://semblance.dev/ns/safety#> .\n`
/** The app's own page: a stack that shows what the author wrote (ui:theirs) under its own link. */
const app = prefixes + `ui:page a c:Stack ; c:children ( ui:own ui:theirs ) .\nui:own a c:Link ; c:label "Ours" ; c:href "javascript:void 0" .\n`
const link = (href: string) => prefixes + `ui:theirs a c:Link ; c:label "Theirs" ; c:href ${JSON.stringify(href)} .\n`

const apps: MountedApp[] = []
afterEach(() => {
  for (const a of apps.splice(0)) a.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A document to mount into, with what mount needs of a browser (as test/web-mount-lifecycle.test.ts). */
function host() {
  const { document, window } = parseHTML('<!doctype html><html><body><main id="app"></main></body></html>')
  document.adoptedStyleSheets = []
  class Sheet { replaceSync() {} }
  Object.defineProperty(window, 'CSSStyleSheet', { value: Sheet, configurable: true })
  Object.defineProperty(window, 'requestAnimationFrame', { value: () => 1, configurable: true })
  Object.defineProperty(window, 'cancelAnimationFrame', { value: () => {}, configurable: true })
  vi.stubGlobal('requestIdleCallback', () => 1)
  vi.stubGlobal('fetch', async () => new Response(readFileSync(new URL('../rdf-engine/build/wat.wasm', import.meta.url)), { headers: { 'Content-Type': 'application/wasm' } }))
  return document.getElementById('app')!
}

async function mounted(opts: { graphs?: string[]; authored?: string[]; policy?: SafetyPolicy }) {
  const element = host()
  const refused: Refused[] = []
  const a = await mount(element, { root: UI + 'page', store: 'wat', files: false, fullscreen: false, navigation: false, ...opts, onRefused: (e) => refused.push(e as Refused) })
  apps.push(a)
  const links = [...element.querySelectorAll('a')].map((el) => [el.textContent?.replace(/↗.*/, '').trim(), el.getAttribute('href')])
  return { element, refused, links }
}

describe('docs/SAFETY.md, worked examples', () => {
  it('mount({ authored, onRefused }): a javascript: link renders without its address, and is reported', async () => {
    const { refused, links } = await mounted({ graphs: [app], authored: [link('javascript:alert(1)')] })
    expect(links).toEqual([['Ours', null], ['Theirs', null]])
    // The whole projection is authored: the app's own link is checked too.
    expect(refused.map((e) => [e.kind, e.at.slice(UI.length)])).toEqual([['url', 'own/~root'], ['url', 'theirs/~root']])
    expect(refused[1]!.message).toBe(`Refused on <${UI}theirs/~root>: href: authored content may not have a javascript: URL here.`)
  })

  it('without authored, the same graphs render as written', async () => {
    const { refused, links } = await mounted({ graphs: [app, link('javascript:alert(1)')] })
    expect(links).toEqual([['Ours', 'javascript:void 0'], ['Theirs', 'javascript:alert(1)']])
    expect(refused).toEqual([])
  })

  it('a trusted graph extends safe:Authored; the same triple in the authored graph does not', async () => {
    const sms = 'sms:+15550100'
    const extended = await mounted({ graphs: [app, prefixes + 'safe:Authored safe:scheme "sms:" .'], authored: [link(sms)] })
    expect(extended.links).toContainEqual(['Theirs', sms])
    const smuggled = await mounted({ graphs: [app], authored: [link(sms) + 'safe:Authored safe:scheme "sms:" .'] })
    expect(smuggled.links).toContainEqual(['Theirs', null])
    expect(smuggled.refused.map((e) => e.message)).toContain(`Refused on <${UI}theirs/~root>: href: authored content may not have a sms: URL here.`)
  })

  it('a stricter policy: safe:Authored with https: links only', async () => {
    const trusted = loadStore('wat', app)
    const strict: SafetyPolicy = { ...authoredPolicy(trusted), schemes: new Set(['https:']), resourceSchemes: [] }
    trusted.dispose?.()
    const ok = await mounted({ graphs: [app], authored: [link('https://example.org/')], policy: strict })
    expect(ok.links).toContainEqual(['Theirs', 'https://example.org/'])
    const mail = await mounted({ graphs: [app], authored: [link('mailto:someone@example.org')], policy: strict })
    expect(mail.links).toContainEqual(['Theirs', null])
    expect(mail.refused.map((e) => e.message)).toContain(`Refused on <${UI}theirs/~root>: href: authored content may not have a mailto: URL here.`)
  })

  it('a policy of its own, in Turtle, read with readPolicy', () => {
    const trusted = loadStore('wat', prefixes + `@prefix rdfhtml: <https://ia2.dev/spec/rdf-html#> .
ui:Plain a safe:Policy ; safe:element rdfhtml:Div , rdfhtml:Span , rdfhtml:P ; safe:attribute "class" , "lang" , "dir" ; safe:attributePrefix "data-" , "aria-" .`)
    try {
      const plain = readPolicy(trusted, UI + 'Plain')
      expect([...plain.elements].sort()).toEqual(['Div', 'P', 'Span'])
      expect(plain.schemes.size).toBe(0)
      expect(() => readPolicy(trusted, UI + 'Nothing')).toThrow(/is not a safe:Policy/)
    } finally {
      trusted.dispose?.()
    }
  })

  it('renderToString({ policy }): the same answer on the server, its refusals in the projection’s index', async () => {
    const trusted = loadStore('wat', app)
    const policy = authoredPolicy(trusted)
    const store = loadStore('wat', app, link('javascript:alert(1)'))
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = await renderToString({ store, root: UI + 'page', policy, styles: false })
      expect(r.html).not.toContain('href="javascript')
      expect(r.html).toContain('>Theirs<')
      expect([...r.projection.index.refusals.keys()].sort()).toEqual([UI + 'own/~root', UI + 'theirs/~root'])
      // Without onRefused, as mount: on the console, as warnings.
      expect(warnings.mock.calls.some(([tag, message]) => tag === '[semblance]' && /javascript: URL/.test(String(message)))).toBe(true)
      r.runtime.dispose()
      // With it, each refusal is a Refused.
      const refused: Error[] = []
      const again = await renderToString({ store: loadStore('wat', app, link('javascript:alert(1)')), root: UI + 'page', policy, styles: false, onRefused: (e) => refused.push(e) })
      expect(refused.length).toBeGreaterThan(0)
      expect(refused.every((e) => e instanceof Refused && e.kind === 'url')).toBe(true)
      again.runtime.dispose()
    } finally {
      store.dispose?.()
      trusted.dispose?.()
    }
  })
})
