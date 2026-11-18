// What on the page Semblance did not make (src/web/unmanaged.ts, ontology/layers/unmanaged.ttl): the
// finder's categories, and the Inspector's "Not made by Semblance" view driven as a person would,
// with its findings, counts and marks in the graph and the DOM, in both rule implementations.
import { describe, expect, it } from 'vitest'
import { DomRenderer } from '../src/render/dom.ts'
import { attachUnmanaged, exceptionFor, readAllowed, surveyUnmanaged, unexcused } from '../src/web/unmanaged.ts'
import { mountShell, notMadeBySemblance } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const UM = 'https://semblance.dev/ns/unmanaged#'

function shellWithSurvey(prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountShell(5, 'oxigraph', prefer)
  const stop = attachUnmanaged(h.runtime, { renderers: () => [h.shell], onWrite: () => h.shell.flush(), every: 0 })
  const f = h.store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const set = (s: string, p: string, o: string) => {
    h.runtime.apply({ remove: h.store.match(nn(s), nn(p), null), add: [f.quad(nn(s), nn(p), nn(o))] })
    h.shell.flush()
  }
  const click = (el: Element) => {
    h.fire(el, 'click')
    h.shell.flush()
  }
  const byText = (selector: string, text: string) => [...h.document.querySelectorAll(selector)].find((e) => e.textContent?.trim() === text)
  /** What the effect does next: a request (a microtask), a survey while shown (a timer). */
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0))
      h.shell.flush()
    }
  }
  const find = async () => {
    click(byText('button', 'Refresh')!)
    await settle()
  }
  const found = (s: string) => Number(h.store.match(nn(s), nn(UM + 'found'), null)[0]?.object.value ?? 0)
  const rows = () => [...h.document.querySelectorAll('[data-sem-c=grid-row]')].filter((r) => r.closest('[data-sem-c=data-grid]')?.textContent?.includes('Why'))
  return { ...h, stop, set, click, find, settle, found, rows, nn }
}

describe('the finder', () => {
  it('finds nothing on a page Semblance made', () => {
    const h = mountShell()
    expect(notMadeBySemblance(h.document)).toEqual([])
    const s = surveyUnmanaged(h.document)
    expect(s.visible).toBeGreaterThan(100)
    expect(s.managed).toBe(s.visible)
  })

  it('names what host code, extensions and embedded media put on the page', () => {
    const h = mountShell()
    const doc = h.document
    const rendered = doc.querySelector('#app [data-sem-c=window]') ?? doc.querySelector('#app [data-sem-c]')!
    const stray = doc.createElement('div')
    stray.innerHTML = '<b>stray</b><i>banner</i>'
    doc.body.prepend(stray)
    const chip = doc.createElement('span')
    chip.className = 'legacy-chip'
    rendered.append(chip)
    const tip = doc.createElement('div')
    tip.setAttribute('data-sem-anchor', '')
    doc.body.append(tip)
    const ext = doc.createElement('helper-ext-widget')
    doc.documentElement.append(ext)
    const frame = doc.createElement('iframe')
    rendered.append(frame)
    const hidden = doc.createElement('div')
    hidden.setAttribute('hidden', '')
    doc.body.append(hidden)
    const s = surveyUnmanaged(doc)
    const by = (el: Element) => s.findings.find((f) => f.element === el)
    expect(by(stray)).toMatchObject({ category: 'unknown', elements: 3, path: 'body > div' })
    expect(by(chip)).toMatchObject({ category: 'host-code', reason: 'inside a rendered element' })
    expect(by(chip)!.near?.element).toBe(rendered)
    expect(by(chip)!.near?.key).toBe(h.shell.keyOf(rendered))
    expect(by(tip)).toMatchObject({ category: 'host-code', reason: 'data-sem-anchor' })
    expect(by(ext)).toMatchObject({ category: 'third-party' })
    expect(by(frame)).toMatchObject({ category: 'sanctioned', reason: 'embedded media' })
    expect(by(hidden)).toBeUndefined()
    expect(s.unmanaged).toBe(3 + 1 + 1 + 1 + 1)
    expect(s.visible).toBe(s.managed + s.unmanaged)
    expect(surveyUnmanaged(doc, { categories: ['third-party'] }).findings.map((f) => f.element)).toEqual([ext])
  })

  it('follows a renderer inside another one, and counts an island or a named custom element as Semblance\'s', () => {
    const h = mountShell()
    const doc = h.document
    // A slot the host owns (as a live example's): a renderer of its own inside it, in a box of the host's.
    const slot = h.shell.slot('text') ?? doc.querySelector('#app [data-sem-c]')!
    const box = doc.createElement('div')
    slot.append(box)
    const inner = new DomRenderer(h.screen.index, box, UI + 'appBar')
    inner.flush()
    expect(box.children.length).toBeGreaterThan(0)
    const s = surveyUnmanaged(doc)
    expect(s.findings.filter((f) => box.contains(f.element) || f.element === box)).toEqual([])
    // Anything else in that slot is the host's.
    const own = doc.createElement('p')
    slot.append(own)
    expect(surveyUnmanaged(doc).findings.find((f) => f.element === own)?.category).toBe('host-code')
    inner.dispose()
    // Once let go, its elements are no one's.
    expect(surveyUnmanaged(doc).findings.some((f) => f.element === box)).toBe(true)
  })
})

describe('what a site allows', () => {
  it('allows foreign content by kind and host code by an exception that says why, in the graph', () => {
    const h = mountShell()
    const doc = h.document
    const allowed = readAllowed(h.store)
    expect([...allowed.categories].sort()).toEqual(['island', 'sanctioned'])
    const surface = allowed.exceptions.find((x) => x.iri === UI + 'allowAnchoredSurface')!
    expect(surface).toMatchObject({ category: 'host-code', selector: '.sem-tooltip[data-sem-anchor]', issue: 'https://github.com/inferal-oss/semblance/issues/584' })
    expect(surface.because).toBeTruthy()
    for (const x of allowed.exceptions) expect(x.because, x.iri).toBeTruthy()
    const tip = doc.createElement('div')
    tip.className = 'sem-tooltip'
    tip.setAttribute('data-sem-anchor', '')
    doc.body.append(tip)
    const frame = doc.createElement('iframe')
    doc.querySelector('#app [data-sem-c]')!.append(frame)
    const hack = doc.createElement('div')
    hack.className = 'promo-banner'
    doc.querySelector('#app [data-sem-c]')!.append(hack)
    const s = surveyUnmanaged(doc)
    const of = (el: Element) => s.findings.find((f) => f.element === el)!
    expect(exceptionFor(of(tip), allowed.exceptions)?.iri).toBe(UI + 'allowAnchoredSurface')
    expect(exceptionFor(of(hack), allowed.exceptions)).toBeUndefined()
    expect(exceptionFor(of(frame), allowed.exceptions)).toBeUndefined()
    // The guard fails on the hack alone: the media is allowed by kind, the surface by its exception.
    expect(unexcused(s, allowed).map((f) => f.element)).toEqual([hack])
    // A category the exception does not name is not allowed by it.
    expect(exceptionFor({ ...of(tip), category: 'unknown' }, allowed.exceptions)).toBeUndefined()
  })
})

describe.each(['sparql', 'function'] as const)('the Inspector: not made by Semblance (%s)', (prefer) => {
  it('finds on request, counts by category, filters, and marks the selected finding and its nearest Semblance element', async () => {
    const h = shellWithSurvey(prefer)
    const doc = h.document
    const rendered = [...doc.querySelectorAll('#app [data-sem-c]')].find((e) => !e.closest('[data-sem-c=window]'))!
    const chip = doc.createElement('span')
    chip.className = 'legacy-chip'
    rendered.append(chip)
    const ext = doc.createElement('helper-ext-widget')
    doc.documentElement.append(ext)
    // Nothing is walked while the view is not shown.
    await h.settle()
    expect(h.store.match(h.nn(UI + 'unmanaged'), h.nn('https://w3id.org/tree#member'), null)).toHaveLength(0)
    // Shown, it surveys by itself.
    h.set(UI + 'app', UI + 'inspects', UI + 'unmanaged')
    await h.settle()
    expect(h.store.match(h.nn(UI + 'unmanaged'), h.nn('https://w3id.org/tree#member'), null)).toHaveLength(2)
    expect(h.found(UI + 'unmanaged')).toBe(2)
    expect(h.found(UM + 'HostCode')).toBe(1)
    expect(h.found(UM + 'ThirdParty')).toBe(1)
    expect(h.rows()).toHaveLength(2)
    // Neither is allowed: no row says by what.
    expect(h.store.match(null, h.nn(UM + 'exceptedBy'), null)).toHaveLength(0)
    // The count beside the view and beside each category.
    const segmented = (has: string) => [...doc.querySelectorAll('[data-sem-c=segmented]')].find((e) => e.textContent?.includes(has))!
    const views = segmented('Not made by Semblance')
    expect(views.textContent).toMatch(/Not made by Semblance\s*2/)
    const categories = segmented('Third party')
    expect(categories.textContent).toMatch(/Host code\s*1/)
    expect(categories.textContent).toMatch(/Third party\s*1/)
    const option = (text: string) => [...categories.querySelectorAll('*')].find((e) => e.textContent?.trim().startsWith(text) && e.matches('button, [role=radio], label'))!
    // The details take room only once a finding is selected (master-detail).
    const split = doc.querySelector('[data-sem-c=split-view] [data-sem-c=data-grid]')!.closest('[data-sem-c=split-view]')!
    expect(split.querySelector('.sem-secondary')!.hasAttribute('hidden')).toBe(true)
    // Each category says what it holds, on hover and to assistive technology.
    expect(option('Third party').closest('button')?.getAttribute('data-sem-tooltip') ?? option('Third party').getAttribute('data-sem-tooltip')).toMatch(/extension/)
    // Third party only.
    h.click(option('Third party'))
    expect(h.rows()).toHaveLength(1)
    expect(h.rows()[0]!.textContent).toContain('helper-ext-widget')
    h.click(option('All'))
    expect(h.rows()).toHaveLength(2)
    // Selecting the host-code finding: the element marked, the nearest element Semblance made highlighted.
    h.click(h.rows().find((r) => r.textContent?.includes('legacy-chip'))!)
    await Promise.resolve()
    expect(split.querySelector('.sem-secondary')!.hasAttribute('hidden')).toBe(false)
    expect(chip.getAttribute('data-sem-unmanaged')).toBe('host-code')
    expect(rendered.getAttribute('data-sem-highlighted')).toBe('true')
    expect(ext.hasAttribute('data-sem-unmanaged')).toBe(false)
    // Another one moves the mark.
    h.click(h.rows().find((r) => r.textContent?.includes('helper-ext-widget'))!)
    await Promise.resolve()
    expect(chip.hasAttribute('data-sem-unmanaged')).toBe(false)
    expect(ext.getAttribute('data-sem-unmanaged')).toBe('third-party')
    // Found again once it is gone: one fewer, and the same element keeps its finding.
    const kept = h.store.match(null, h.nn(UM + 'path'), null).find((q) => q.object.value.includes('legacy-chip'))!.subject.value
    ext.remove()
    await h.find()
    expect(h.found(UI + 'unmanaged')).toBe(1)
    expect(h.store.match(null, h.nn(UM + 'path'), null).map((q) => q.subject.value)).toEqual([kept])
    h.stop()
  })
})

it('renders the same Inspector with SPARQL rules and their function twins', async () => {
  const html = async (prefer: 'sparql' | 'function') => {
    const h = shellWithSurvey(prefer)
    h.set(UI + 'app', UI + 'inspects', UI + 'unmanaged')
    const chip = h.document.createElement('span')
    chip.className = 'legacy-chip'
    h.document.querySelector('#app [data-sem-c]')!.append(chip)
    await h.settle()
    h.click(h.rows()[0]!)
    const panel = [...h.document.querySelectorAll('[data-sem-c=stack]')].find((e) => e.querySelector('[data-sem-c=data-grid]') && e.textContent?.includes('Refresh'))!
    h.stop()
    // When the survey ran is the clock's.
    return panel.outerHTML.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z|\d\d:\d\d(:\d\d)?/g, 'T')
  }
  expect(await html('function')).toBe(await html('sparql'))
})

// examples/foreign: a custom element (<star-rating>) and a vanilla widget (the spark chart), as islands.
describe('islands', () => {
  it('lists what each island mounts as an island finding, made by Semblance and allowed', async () => {
    const { readFileSync } = await import('node:fs')
    const { parseHTML } = await import('linkedom')
    const { Islands } = await import('../src/foreign.ts')
    const { loadStore } = await import('../src/node/load.ts')
    const { EventBus } = await import('../src/behaviour/events.ts')
    const { Runtime } = await import('../src/runtime.ts')
    const { DEFAULT_LAYERS } = await import('../src/web/mount.ts')
    const { MOD } = await import('../src/ns.ts')
    const { foreignExampleFunctions } = await import('../examples/foreign/functions.ts')
    const { spark } = await import('../examples/foreign/spark.ts')
    const { defineStarRating } = await import('../examples/foreign/star-rating.ts')
    const read = (f: string) => readFileSync(new URL('../examples/foreign/' + f, import.meta.url), 'utf8')
    const EX = 'https://example.org/foreign#'
    const store = loadStore('oxigraph', read('foreign.ttl'), read('app.ttl'), readFileSync(new URL('../ontology/layers/unmanaged.ttl', import.meta.url), 'utf8'))
    const runtime = new Runtime(store)
    const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, prefer: 'sparql', functions: foreignExampleFunctions, name: 'screen', roots: [EX + 'page'] }, (e) => {
      throw e
    })
    const win = parseHTML('<!doctype html><html><head></head><body><div id="app"></div></body></html>')
    defineStarRating(win as never)
    const renderer = new DomRenderer(screen.index, win.document.getElementById('app')!, EX + 'page')
    renderer.flush()
    const bus = new EventBus(runtime, screen)
    bus.attach(renderer, () => renderer.flush())
    const islands = new Islands(bus, renderer, { widgets: { spark }, onHandled: () => renderer.flush(), onError: (e) => { throw e } })
    islands.attach()
    await islands.settled()
    const s = surveyUnmanaged(win.document)
    const found = s.findings.filter((f) => f.category === 'island')
    expect(found.map((f) => f.reason)).toEqual(expect.arrayContaining(['island star-rating', 'island week']))
    for (const f of found) {
      expect(f.elements).toBeGreaterThan(0)
      expect(f.near && renderer.keyOf(f.near.element)).toBe(f.near?.key)
    }
    // Made by Semblance: in the managed figure, not the unmanaged one; allowed by kind.
    expect(s.unmanaged).toBe(0)
    expect(s.managed).toBe(s.visible)
    expect(unexcused(s, readAllowed(store))).toEqual([])
    expect(readAllowed(store).categories.has('island')).toBe(true)
  })
})
