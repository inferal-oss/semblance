import { describe, expect, it, vi } from 'vitest'
import { MOD, NS } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
import { type Backend, memoryBackend, Persistence } from '../src/persistence.ts'
import { mountRemembering } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const PER = NS.per

/** A fresh "browser": session, device and database storage that outlive one mount. */
function browser(): Record<string, Backend> {
  return { [PER + 'Session']: memoryBackend(), [PER + 'Device']: memoryBackend(), [PER + 'Database']: memoryBackend() }
}

const pressZ = (h: Awaited<ReturnType<typeof mountRemembering>>) => {
  const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
  Object.assign(e, { key: 'z', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
  h.document.dispatchEvent(e)
}

describe('persistence (per:Policy)', () => {
  it('remembers every choice about the inspector for this tab', async () => {
    const storage = browser()
    const a = await mountRemembering(storage)
    pressZ(a) // paused
    a.fire(a.document.querySelector('[aria-label="Open Inspector in a window"]')!, 'click')
    const inspector = (d: Document) => [...d.querySelectorAll('[data-sem-c=window]')].find((w) => w.querySelector('.sem-window-bar strong')!.textContent === 'Inspector')!
    const win = inspector(a.document)
    win.querySelector('.sem-window-bar')!.dispatchEvent(new a.window.CustomEvent('sem-move', { bubbles: true, detail: { x: 333, y: 222 } }))
    await a.persistence.flush()
    expect(await storage[PER + 'Session']!.get('semblance:' + UI + 'rememberInspector')).toBeTruthy()
    expect(await storage[PER + 'Device']!.get('semblance:' + UI + 'rememberInspector')).toBeUndefined() // session-scoped

    // "Reload": a new shell over the same storage.
    const b = await mountRemembering(storage)
    expect(b.value(UI + 'inspectorMode')).toBe(UI + 'Paused')
    const restored = inspector(b.document)
    expect(restored.getAttribute('style')).toContain('left: 333px; top: 222px')
    // The restore is in the state log, and the list says so.
    const restores = b.store.match(null, b.store.factory.namedNode(NS.rdf + 'type'), b.store.factory.namedNode(PER + 'Restore'))
    expect(restores.length).toBeGreaterThan(0)
  })

  it('keeps the change log only when switched on, and continues its sequence', async () => {
    const storage = browser()
    const a = await mountRemembering(storage)
    const field = () => a.document.querySelector('[data-sem-c=text-field] input') as HTMLInputElement
    const type = (v: string) => {
      field().value = v
      a.fire(field(), 'input')
    }
    type('one')
    await a.persistence.flush()
    expect(await storage[PER + 'Session']!.get('semblance:' + UI + 'rememberChangeLog')).toBeUndefined() // opt-in
    // The switch in the Change log tab turns it on; the switch itself is remembered on the device.
    a.fire([...a.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Change log')!, 'click')
    a.fire(a.document.querySelector('[data-sem-c=toggle-switch] [role=switch], [data-sem-c=toggle-switch][role=switch]')!, 'click')
    type('two')
    await a.persistence.flush()
    const members = (h: typeof a) => h.store.match(h.store.factory.namedNode(NS.beh + 'ChangeLog'), h.store.factory.namedNode(NS.tree + 'member'), null).length
    const before = members(a)

    const b = await mountRemembering(storage)
    expect(members(b)).toBe(before)
    const seq = (h: typeof a) => Math.max(...h.store.match(null, h.store.factory.namedNode(NS.beh + 'sequence'), null).map((q) => Number(q.object.value)))
    const last = seq(b)
    b.fire(b.document.querySelector('[data-sem-c=text-field] input')!, 'input')
    expect(seq(b)).toBe(last + 1)
  })

  it('forgets on request, and when a policy is turned off', async () => {
    const storage = browser()
    const a = await mountRemembering(storage)
    pressZ(a)
    await a.persistence.flush()
    const key = 'semblance:' + UI + 'rememberInspector'
    expect(await storage[PER + 'Session']!.get(key)).toBeTruthy()
    const f = a.store.factory
    a.runtime.apply({ remove: [], add: [f.quad(f.namedNode(UI + 'rememberInspector'), f.namedNode(PER + 'request'), f.literal('forget'))] })
    await new Promise((r) => setTimeout(r, 0))
    expect(await storage[PER + 'Session']!.get(key)).toBeUndefined()
    expect(a.store.match(f.namedNode(UI + 'rememberInspector'), f.namedNode(PER + 'request'), null)).toHaveLength(0)
  })

  it('restores a remembered subject that is not an IRI (a blank node)', async () => {
    const storage = browser()
    const nt = `_:run <${NS.c}recentOf> <${UI}palette> .\n_:run <${NS.rdfs}label> "Blank" .\n<${UI}knownRun> <${NS.c}recentOf> <${UI}palette> .\n`
    await storage[PER + 'Device']!.set('semblance:' + UI + 'rememberPalette', JSON.stringify({ version: '1', savedAt: Date.now(), nt }))
    const a = await mountRemembering(storage)
    const f = a.store.factory
    expect(a.persistence.restored(UI + 'rememberPalette')).toBe(true)
    expect(a.store.match(f.namedNode(UI + 'knownRun'), f.namedNode(NS.c + 'recentOf'), f.namedNode(UI + 'palette'))).toHaveLength(1)
    expect(a.store.match(null, f.namedNode(NS.rdfs + 'label'), f.literal('Blank'))).toHaveLength(1)
  })

  it('stopped, it drops a write waiting for its delay: none runs against a store released since', async () => {
    const storage = browser()
    const a = await mountRemembering(storage)
    a.persistence.stop()
    // A persistence of its own over the same shell, with a short delay.
    const p = new Persistence(a.store, storage, { delayMs: 20 })
    const stop = p.attach(a.runtime)
    pressZ(a) // a remembered choice changes: a write is waiting
    stop()
    a.store.dispose?.()
    await new Promise((r) => setTimeout(r, 60))
    expect(await storage[PER + 'Session']!.get('semblance:' + UI + 'rememberInspector')).toBeUndefined()
  })
})

// The list of policies (#7): in the viewer's collation, sizes by sx:formatNumber and the last write's clock
// time by sx:formatDateTime, its status in the viewer's language, the same from the SPARQL rules as from
// their function twin, on screen and as text; on wat (Oxigraph has no sx: functions, so it runs the twin).
describe('the list of policies, SPARQL and function rules alike (wat)', () => {
  it('renders the same as policies are written, switched off and forgotten, in every language', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-24T13:05:09Z'))
    try {
      const sites = await Promise.all((['sparql', 'function'] as const).map(async (prefer) => {
        const h = await mountRemembering(browser(), undefined, [], 'wat', prefer)
        const f = h.store.factory
        const app = f.namedNode(UI + 'app')
        const group = f.namedNode(UI + 'galleryGroup')
        h.showPage('Components')
        h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupLayers'))] })
        h.shell.flush()
        return { ...h, text: h.runtime.project({ modality: MOD.Text, prefer, name: 'text-policies', roots: [UI + 'policies'] }) }
      }))
      const rules = (sites[0]!.screen.engine as unknown as { rules: { slot: string; kind: string }[] }).rules
      expect(rules.find((r) => r.slot === NS.c + 'PolicyListRendering')?.kind).toBe('sparql')
      const list = (h: (typeof sites)[number]) => h.document.querySelector('[data-sem-c=policy-list]')!
      const same = (what: string) => {
        const [a, b] = sites.map((h) => list(h).outerHTML)
        expect(a, what).toBe(b)
        const [ta, tb] = sites.map((h) => toText(h.text.index, UI + 'policies'))
        expect(ta, what).toBe(tb)
      }
      same('at start')
      expect(list(sites[0]!).querySelectorAll('li').length).toBeGreaterThan(3)
      for (const h of sites) pressZ(h)
      for (const h of sites) await h.persistence.flush()
      for (const h of sites) h.shell.flush()
      same('written')
      expect(list(sites[0]!).textContent).toContain('saved')
      for (const languages of [['uk'], ['de'], ['ar'], ['en']]) {
        for (const h of sites) for (const p of [h.screen, h.text]) p.engine.reconfigure({ languages })
        for (const h of sites) h.shell.flush()
        same(languages.join())
      }
      for (const act of ['[role=switch][aria-checked=true]', '.sem-forget:not([disabled])']) {
        for (const h of sites) h.fire(list(h).querySelector(act)!, 'click')
        for (const h of sites) await h.persistence.flush()
        for (const h of sites) h.shell.flush()
        same(act)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
