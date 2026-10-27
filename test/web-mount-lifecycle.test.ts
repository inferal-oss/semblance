import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type MountedApp } from '../src/web/mount.ts'
import { memoryBackend, Persistence } from '../src/persistence.ts'
import { NS } from '../src/ns.ts'

const root = 'https://example.org/ui#message'
const graph = `
@prefix ui: <https://example.org/ui#> .
@prefix c: <https://semblance.dev/ns/component#> .
ui:message a c:Text ; c:label "Hello" .
`
const apps: MountedApp[] = []

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function host() {
  const { document, window } = parseHTML('<!doctype html><html><body><main id="app"></main></body></html>')
  const original = { replaceSync() {} } as unknown as CSSStyleSheet
  document.adoptedStyleSheets = [original]
  class Sheet { replaceSync() {} }
  Object.defineProperty(window, 'CSSStyleSheet', { value: Sheet, configurable: true })
  Object.defineProperty(window, 'requestAnimationFrame', { value: () => 1, configurable: true })
  Object.defineProperty(window, 'cancelAnimationFrame', { value: () => {}, configurable: true })
  const idle: Array<(deadline: { timeRemaining(): number }) => void> = []
  vi.stubGlobal('requestIdleCallback', (callback: (deadline: { timeRemaining(): number }) => void) => idle.push(callback))
  vi.stubGlobal('fetch', async () => new Response(readFileSync(new URL('../rdf-engine/build/wat.wasm', import.meta.url)), {
    headers: { 'Content-Type': 'application/wasm' },
  }))
  return { document, element: document.getElementById('app')!, original, idle }
}

describe('web mount lifecycle', () => {
  it('releases its runtime and WASM store once, leaving host DOM and styles intact', async () => {
    const { document, element, original, idle } = host()
    const app = await mount(element, { root, graphs: [graph], store: 'wat', files: false, fullscreen: false })
    apps.push(app)
    const disposeRuntime = vi.spyOn(app.runtime, 'dispose')
    const disposeStore = vi.spyOn(app.store, 'dispose')
    const warm = vi.spyOn(app.runtime, 'warm')
    const content = element.innerHTML
    expect(content).toContain('Hello')
    expect(document.adoptedStyleSheets).toHaveLength(2)
    expect(idle).toHaveLength(1)

    app.unmount()
    app.unmount()
    expect(disposeRuntime).toHaveBeenCalledTimes(1)
    expect(disposeStore).toHaveBeenCalledTimes(1)
    expect(element.innerHTML).toBe(content)
    expect(document.adoptedStyleSheets).toEqual([original])
    // A browser may already have queued warmup when the host ends the mount.
    expect(() => idle[0]!({ timeRemaining: () => 20 })).not.toThrow()
    expect(warm).not.toHaveBeenCalled()
  })

  it('releases each store during repeated mounts even while the host retains returned apps', async () => {
    const { element } = host()
    const disposed = []
    for (let i = 0; i < 3; i++) {
      const app = await mount(element, { root, graphs: [graph], store: 'wat', files: false, fullscreen: false })
      apps.push(app)
      const dispose = vi.spyOn(app.store, 'dispose')
      disposed.push(dispose)
      expect(element.textContent).toContain('Hello')
      app.unmount()
    }
    expect(apps).toHaveLength(3)
    for (const dispose of disposed) expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('ends the effects that follow its runtime before the store is released', async () => {
    const { element } = host()
    const app = await mount(element, { root, graphs: [graph], store: 'wat', files: false, fullscreen: false })
    apps.push(app)
    const persistence = new Persistence(app.store, { [NS.per + 'Session']: memoryBackend() }, { delayMs: 60_000 })
    persistence.attach(app.runtime)
    const stop = vi.spyOn(persistence, 'stop')
    app.unmount()
    expect(app.runtime.ended).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    // A late answer (an upload, the host's full screen, a widget) is no event, and writes nothing.
    const match = vi.spyOn(app.store, 'match')
    expect(app.bus.emit(NS.beh + 'Activate', root).recorded).toBe(false)
    const f = app.store.factory
    const has = vi.spyOn(app.store, 'has')
    expect(app.runtime.apply({ add: [f.quad(f.namedNode(root), f.namedNode(NS.rdfs + 'label'), f.literal('late'))], remove: [] })).toEqual({ add: [], remove: [] })
    expect(has).not.toHaveBeenCalled()
    expect(match).not.toHaveBeenCalled()
  })
})
