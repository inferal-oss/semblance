import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { DEFAULT_LAYERS } from '../src/web/mount.ts'

// examples/hello is what docs/GETTING-STARTED.md walks through: a component of our own with a
// SPARQL rule only, used beside built-in ones, and a reaction. These keep the guide honest.

const EX = 'https://example.org/hello#'
const read = (f: string) => readFileSync(new URL('../examples/hello/' + f, import.meta.url), 'utf8')
const tally = read('tally.ttl')
const app = read('app.ttl')

function mount(kind: 'wat' | 'oxigraph', appGraph = app) {
  const store = loadStore(kind, tally, appGraph)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, name: 'screen', roots: [EX + 'page'] }, (e) => {
    throw e
  })
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const renderer = new DomRenderer(screen.index, document.getElementById('app')!, EX + 'page')
  renderer.flush()
  new EventBus(runtime, screen).attach(renderer, () => renderer.flush())
  const click = (el: Element) => el.dispatchEvent(new window.Event('click', { bubbles: true }))
  const violations = (focus: string) => store.match(null, store.factory.namedNode(NS.sh + 'focusNode'), store.factory.namedNode(focus)).length
  return { store, screen, document, click, violations }
}

describe('the getting-started example', () => {
  for (const kind of ['wat', 'oxigraph'] as const) {
    it(`renders a component that has only a SPARQL rule, and its reaction counts (${kind})`, () => {
      const h = mount(kind)
      const tallyEl = h.document.querySelector('[data-sem-c=ex-tally]')!
      expect(tallyEl.querySelector('.ex-tally-label')!.textContent).toBe('Coffee today')
      expect(tallyEl.querySelector('strong')!.textContent).toBe('0 cups')
      const button = [...h.document.querySelectorAll('button')].find((b) => b.textContent === 'Have another')!
      h.click(button)
      h.click(button)
      expect(h.document.querySelector('[data-sem-c=ex-tally] strong')!.textContent).toBe('2 cups')
      expect(h.violations(EX + 'cups')).toBe(0)
    })
  }

  it('renders on the server the same way', () => {
    const h = mount('wat')
    expect(toHTML(h.screen.index, EX + 'page')).toContain('<strong>0 cups</strong>')
  })

  it("checks an instance against the component's shape", () => {
    const nameless = app.replace('c:label "Coffee today" ; ', '')
    expect(nameless).not.toBe(app)
    const h = mount('wat', nameless)
    expect(h.violations(EX + 'cups')).toBe(1)
  })
})
