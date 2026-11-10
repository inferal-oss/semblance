import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { Parser, Store } from 'n3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore } from '../src/node/load.ts'
import { DEFAULT_LAYERS, MOD, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import { buildSandbox, Sandboxes } from '../src/sandbox.ts'

// Each docs page's live example (demo/gallery/_docs.ttl), clicked through as a person would: every
// button in its preview, and what a click that is handled as an event changes on screen (#427).

const UI = 'https://semblance.dev/demo#'
const VX = 'https://example.org/views#'
const docs = readFileSync(new URL('../demo/gallery/_docs.ttl', import.meta.url), 'utf8')
const site = new Store(new Parser().parse(docs))
const examples = site.getSubjects(NS.rdf + 'type', NS.c + 'LiveExample', null).map((s) => s.value)

afterEach(() => vi.restoreAllMocks())

/** The example alone as the host's root, its sandbox mounted. */
function host(example: string) {
  const store = loadStore('wat', docs)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, name: 'screen', roots: [example] }, (e) => {
    throw e
  })
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const renderer = new DomRenderer(screen.index, document.getElementById('app')!, example)
  const sandboxes = new Sandboxes(runtime, screen, {
    renderer,
    shown: (c) => screen.index.isShown(c, new Set([example])),
    flush: () => flush(),
    load: (...t) => loadStore('wat', ...t),
    copy: () => {},
    copiedMs: 0,
  })
  const flush = () => {
    renderer.flush()
    sandboxes.sync()
  }
  new EventBus(runtime, screen, {}).attach(renderer, () => flush())
  sandboxes.attach()
  flush()
  const sandbox = sandboxes.sandboxOf(example)!
  const preview = document.querySelector('.sem-live-screen')!
  const sf = sandbox.store.factory
  const events = () => sandbox.store.match(sf.namedNode(NS.beh + 'ChangeLog'), sf.namedNode(NS.tree + 'member'), null).length
  const click = (el: Element) => {
    el.dispatchEvent(new window.Event('click', { bubbles: true }))
    flush()
  }
  const dispose = () => {
    sandboxes.dispose()
    store.dispose?.()
  }
  return { document, preview, sandbox, events, click, dispose }
}

describe("each docs page's live example, clicked through", () => {
  it('has them', () => expect(examples.length).toBeGreaterThanOrEqual(10))

  for (const example of examples) {
    it(`${example.replace(UI, 'ui:')}: every button it shows; the clicks it handles show on screen`, () => {
      const h = host(example)
      try {
        expect(h.preview.closest('[data-sem-c=live-example]')!.getAttribute('data-sem-state')).toBe('live')
        const handled: { label: string; shown: boolean }[] = []
        const dead: string[] = []
        for (const button of [...h.preview.querySelectorAll('button')]) {
          if (!button.isConnected || button.disabled) continue
          const before = h.preview.innerHTML
          const n = h.events()
          h.click(button)
          // Handled: a reaction ran, a member of its change log.
          if (h.events() > n) handled.push({ label: button.textContent ?? '', shown: h.preview.innerHTML !== before })
          else if (h.preview.innerHTML === before) dead.push(button.textContent ?? '')
        }
        // Getting started builds one app step by step: a step shows a button only with what it does
        // (elsewhere a button may be a specimen of a style or a language, or wait for input).
        if (example.startsWith(UI + 'gs-')) expect(dead, `${dead.join(', ')}: clicked, nothing handles it`).toEqual([])
        // A click may change what is out of sight (a third drink's votes below a top two), but an
        // example whose handled clicks change nothing it shows does nothing for whoever tries it.
        if (handled.length) expect(handled.filter((c) => c.shown), `${handled.map((c) => c.label).join(', ')}: nothing changed on screen`).not.toEqual([])
      } finally {
        h.dispose()
      }
    })
  }

  it('Maintained views: each like is an event, and both figures follow it', () => {
    const h = host(UI + 'iv-live')
    try {
      const stats = () => [...h.preview.querySelectorAll('[data-sem-c=stat] .sem-value')].map((s) => s.textContent)
      const value = (s: string, p: string) => h.sandbox.store.match(h.sandbox.store.factory.namedNode(s), h.sandbox.store.factory.namedNode(p), null)[0]?.object.value
      expect(stats()).toEqual(['0', '0'])
      const like = [...h.preview.querySelectorAll('button')].find((b) => b.textContent === 'Like')!
      h.click(like)
      h.click(like)
      expect(value(VX + 'post', VX + 'likes')).toBe('2')
      expect(value(VX + 'log', VX + 'events')).toBe('2')
      // Each like removes one triple and adds one.
      expect(stats()).toEqual(['2', '4'])
    } finally {
      h.dispose()
    }
  })
})

describe('a formula that cannot show its value says why', () => {
  const source = site.getObjects(site.getObjects(site.getObjects(UI + 'iv-live', NS.c + 'sources', null)[0]!, NS.rdf + 'first', null)[0]!, NS.c + 'original', null)[0]!.value
  const build = (text: string) => buildSandbox([{ editor: UI + 'iv-live-app', name: 'app.ttl', text }], VX + 'page', { load: (...t) => loadStore('wat', ...t) })

  it('a c:valueQuery that is not a maintained view breaks a shape', () => {
    const b = build(source.replace('ex:qEvents a sem:View , iv:View ; iv:materialize iv:Graph ; iv:reads ex:Totals ;', 'ex:qEvents a sem:View ;'))
    expect(b.problems.map((p) => p.message)).toContain('ex:events: c:valueQuery names a maintained view: an iv:View with iv:materialize iv:Graph.')
    b.sandbox?.runtime.dispose()
  })

  it("a view over another view's output without iv:reads is warned about", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = build(source.replace(' iv:reads ex:Totals ;', ''))
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(`[semblance] <${VX}qEvents> reads <${VX}events>, which the view <${VX}Totals> writes: it sees that only with iv:reads <${VX}Totals>`)
    b.sandbox?.runtime.dispose()
  })
})
