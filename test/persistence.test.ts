import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { type Backend, memoryBackend } from '../src/persistence.ts'
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
    const win = a.document.querySelector('[data-sem-c=window]')!
    win.querySelector('.sem-window-bar')!.dispatchEvent(new a.window.CustomEvent('sem-move', { bubbles: true, detail: { x: 333, y: 222 } }))
    await a.persistence.flush()
    expect(await storage[PER + 'Session']!.get('semblance:' + UI + 'rememberInspector')).toBeTruthy()
    expect(await storage[PER + 'Device']!.get('semblance:' + UI + 'rememberInspector')).toBeUndefined() // session-scoped

    // "Reload": a new shell over the same storage.
    const b = await mountRemembering(storage)
    expect(b.value(UI + 'inspectorMode')).toBe(UI + 'Paused')
    const restored = b.document.querySelector('[data-sem-c=window]')!
    expect(restored.querySelector('.sem-window-bar strong')!.textContent).toBe('Inspector')
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
})
