import type { Quad } from '@rdfjs/types'
import { parseHTML } from 'linkedom'
import { beforeAll, describe, expect, it } from 'vitest'
import { languageChain } from '../src/engine/context.ts'
import { loadStore, loadStoreOf, ontologyFiles } from '../src/node/load.ts'
import { loadSite, namedGraphs, pageGraphs, renderSite } from '../src/node/site.ts'
import { Navigation, setBase } from '../src/navigation.ts'
import { C, MOD, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { parseTurtle, Runtime } from '../src/runtime.ts'
import { renderDocument } from '../src/server/document.ts'
import type { Site } from '../src/server/site.ts'
import { graphLanguages } from '../src/server/render.ts'
import { sliceAddition } from '../src/slices.ts'
import { sourceQuads } from '../src/sources.ts'
import { takeOver } from '../src/web/takeover.ts'
import { prepareSite, ROOT, siteLayers, siteSources, UI } from '../demo/site.ts'

// A page rendered beforehand loads the graphs it needs first and the rest in slices, in idle time
// (#209). Until the last slice, what is shown, or prepared, or reached meanwhile must read its texts
// in the viewer's language: a text with translations never shows one in another language while one
// in the viewer's exists (#589: the Tools window's sample queries showed in Arabic for seconds, its
// texts' translations arriving before the twin that picks among them). Checked after every step of
// the arrival, in each of the site's languages, with the Tools window open on its Query tab (as
// remembered state opens it), on the server's HTML and on the client's.

const TEMPLATE = '<!doctype html><html lang="en"><head><title>t</title></head><body><div id="app"></div></body></html>'
const config = new URL('../semblance.config.ts', import.meta.url).pathname
const RDFS_LABEL = NS.rdfs + 'label'
const L10N_PICKED_AS = NS.l10n + 'pickedAs'

/** Every text of the site, by node and predicate, for the predicates that have translations (l10n:pickedAs). */
function translated(quads: Quad[]): Map<string, { value: string; language: string }[]> {
  const marked = new Set(quads.filter((q) => q.predicate.value === L10N_PICKED_AS).map((q) => q.subject.value))
  marked.add(C.label).add(RDFS_LABEL)
  const texts = new Map<string, { value: string; language: string }[]>()
  for (const q of quads) {
    if (!marked.has(q.predicate.value) || q.object.termType !== 'Literal' || q.subject.termType !== 'NamedNode') continue
    const k = q.subject.value + ' ' + q.predicate.value
    const v = { value: q.object.value, language: q.object.language.toLowerCase() }
    const all = texts.get(k) ?? []
    if (!all.some((x) => x.value === v.value && x.language === v.language)) texts.set(k, [...all, v])
  }
  return texts
}

/** The value util.text picks for a viewer reading `languages`: theirs by rank, else untagged, else English, else the least. */
function pick(values: { value: string; language: string }[], languages: string[]): string {
  const least = (vs: typeof values) => vs.map((v) => v.value).sort()[0]
  const tagged = (want: string) => least(values.filter((v) => v.language === want)) ?? least(values.filter((v) => v.language.startsWith(want + '-')))
  for (const want of languageChain(languages)) {
    const hit = tagged(want)
    if (hit !== undefined) return hit
  }
  return least(values.filter((v) => v.language === '')) ?? tagged('en') ?? least(values)!
}

/**
 * The strings a viewer reading `language` must never see: the values of a translated text other than
 * the one picked for them, that are no text they may see elsewhere (a picked one, an untagged one,
 * one in their language, of any predicate).
 */
function foreignTo(language: string, quads: Quad[]): Set<string> {
  const allowed = new Set<string>()
  for (const q of quads) if (q.object.termType === 'Literal' && (q.object.language === '' || languageChain([language]).includes(q.object.language.toLowerCase()))) allowed.add(q.object.value.trim())
  const foreign = new Set<string>()
  for (const values of translated(quads).values()) {
    if (values.length < 2) continue
    const picked = pick(values, [language])
    allowed.add(picked.trim())
    for (const v of values) if (v.value !== picked) foreign.add(v.value.trim())
  }
  for (const s of allowed) foreign.delete(s)
  foreign.delete('')
  return foreign
}

/** The attributes a person reads (or hears). */
const READ = new Set(['aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'aria-placeholder', 'title', 'placeholder', 'alt', 'label', 'value'])

/** Each text and readable attribute value under a root that is one of `foreign`. */
function shownForeign(root: Element, foreign: Set<string>): string[] {
  const found: string[] = []
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      const t = n.textContent?.trim()
      if (t && foreign.has(t)) found.push(`"${t}" in <${(n.parentNode as Element).tagName?.toLowerCase()}>`)
      return
    }
    if (n.nodeType !== 1) return
    const el = n as Element
    for (const a of el.attributes ?? []) if (READ.has(a.name) && foreign.has(a.value.trim())) found.push(`"${a.value.trim()}" in ${a.name} of <${el.tagName.toLowerCase()}>`)
    for (const c of el.childNodes) walk(c)
  }
  walk(root)
  return found
}

/** The Tools window open on its Query tab, as remembered state has it before the first projection. */
function toolsOnQuery(store: ReturnType<typeof loadStore>) {
  const f = store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const dg = f.defaultGraph()
  const set = (s: string, p: string, o: Parameters<typeof f.quad>[2]) => {
    for (const q of store.match(nn(s), nn(p), null, dg)) store.delete(q)
    store.add(f.quad(nn(s), nn(p), o, dg))
  }
  set(UI + 'tools', NS.c + 'open', f.literal('true', nn(NS.xsd + 'boolean')))
  set(UI + 'views', NS.c + 'selected', nn(UI + 'queryTab'))
}

describe('a page whose graphs arrive late shows its texts in the viewer language at every step (#589)', () => {
  let site: Site
  let named: Record<string, string>
  let everything: Quad[]

  beforeAll(async () => {
    site = await loadSite(config)
    named = { ...ontologyFiles(), ...(await namedGraphs(site)) }
    const store = loadStore('wat')
    everything = Object.values(named).flatMap((t) => parseTurtle(t, store.factory))
    store.dispose?.()
  }, 120_000)

  it.each([
    ['en', '/'],
    ['uk', '/uk/'],
    ['de', '/de/'],
    ['ar', '/ar/'],
  ])('%s (%s)', async (language, url) => {
    const foreign = foreignTo(language, everything)
    expect(foreign.size).toBeGreaterThan(100)
    const steps: string[] = []
    const check = (step: string, root: Element) => {
      const found = shownForeign(root, foreign)
      if (found.length) steps.push(`${step}: ${[...new Set(found)].slice(0, 5).join('; ')}`)
    }

    // The server's page, and the graphs it names.
    const server = await renderSite(site, url)
    const only = await pageGraphs(site, url, server.html, { base: '/' })
    expect(only).toBeDefined()
    const page = renderDocument(TEMPLATE, server)
    server.runtime.dispose()
    const { document } = parseHTML(page)
    const host = document.getElementById('app')!
    check('server', host)

    // Its client, with those graphs and the Tools window remembered open on Query.
    const store = loadStoreOf('wat', only!, ...Object.entries(named).filter(([n]) => only!.includes(n) && !n.startsWith('ontology/')).map(([, t]) => t))
    site.setup?.(store, { single: false, graphs: new Set(only) })
    setBase(store, '/')
    const u = new URL(url, 'https://semblance.test/')
    await new Navigation(store, { root: ROOT, location: { pathname: u.pathname, search: u.search, hash: u.hash }, history: { pushState() {}, replaceState() {} }, events: new EventTarget(), links: new EventTarget() }).restore()
    prepareSite(store, { kind: 'wat', prefer: 'sparql', compile: 'off' })
    toolsOnQuery(store)
    const runtime = new Runtime(store)
    const errors: string[] = []
    const languages = graphLanguages(store, ROOT)
    if (language !== 'en') expect(languages).toEqual([language])
    const screen = runtime.project({ modality: MOD.Screen, layers: siteLayers(store), prefer: 'sparql', provenance: 'onDemand', languages, name: 'screen', roots: [ROOT] }, (e) => errors.push(e.message))
    for (const area of host.querySelectorAll('textarea')) area.textContent = area.textContent!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    const renderer = new DomRenderer(screen.index, host, ROOT)
    takeOver(renderer)
    renderer.flush()
    check('first render', host)

    // The rest, as the client takes it in (demo/main.ts loadRest): what defines rules, then slices.
    const rest = Object.keys(named).filter((n) => !only!.includes(n))
    const quads = rest.flatMap((n) => [...parseTurtle(named[n]!, store.factory), ...sourceQuads(store.factory, siteSources(n.startsWith('demo/gallery/') ? { [n]: named[n]! } : {}))])
    const slices = sliceAddition(quads, 1500)
    runtime.arriving(true)
    runtime.apply({ add: slices.rules, remove: [] })
    renderer.flush()
    check('rules', host)
    slices.rest.forEach((slice, i) => {
      runtime.apply({ add: slice, remove: [] })
      renderer.flush()
      check(`slice ${i + 1} of ${slices.rest.length}`, host)
    })
    runtime.arriving(false)
    renderer.flush()
    check('arrived', host)
    while (runtime.warm(20));
    renderer.flush()
    check('idle', host)
    // The Query tab's samples are shown, in the viewer's language.
    expect(host.querySelectorAll('.sem-sample-label').length).toBeGreaterThan(5)
    expect(steps).toEqual([])
    expect(errors).toEqual([])
    runtime.dispose()
  }, 300_000)
})
