import { describe, expect, it } from 'vitest'
import { mountShell } from './harness.ts'

/**
 * A long session must not accumulate anything: once the change log is at its
 * bound, the graph, the engine's bookkeeping, the HTML index and the DOM
 * renderer stay the same size however many more events arrive.
 */
describe('soak', () => {
  it('keeps every structure and the time per event bounded over 3,500 events', () => {
    // The site's store (Semblance's WAT engine), with an idle slice between
    // interactions as a browser would give it.
    const h = mountShell(5, 'wat')
    const { document, fire } = h
    const button = (text: string) => {
      const all = [...document.querySelectorAll('button, [role=tab]')]
      return (all.find((b) => b.textContent!.trim() === text) ?? all.find((b) => b.textContent!.trim().endsWith(text))) as HTMLElement
    }
    const field = () => document.querySelector('[data-sem-c=text-field] input') as HTMLInputElement
    // Each step is chosen by its turn k (no randomness), so the session repeats every PERIOD
    // events: the field's 7 lengths, 3 labels, 3 tabs and the toggles' 2 states, 6 steps a turn.
    // Measured at the same phase, the app and the change log's window are in the same state, and
    // any difference is something kept per event.
    const PERIOD = 6 * 42
    let k = 0
    const steps: (() => void)[] = [
      () => {
        const box = document.querySelector('[data-sem-c=list-item] input') as HTMLInputElement
        box.checked = !box.checked
        fire(box, 'change')
      },
      () => {
        field().value = field().value.length > 6 ? 'a' : field().value + 'a'
        fire(field(), 'input')
      },
      () => fire(document.querySelectorAll('[data-sem-c=list-item] label')[k % 3]!, 'mouseover'),
      () => fire(button(['Activity', 'Change log', 'Inspector'][k % 3]!), 'click'),
      () => fire(button('Toggle density'), 'click'),
      () => fire(document.querySelector('[data-sem-c=flippable] .sem-flip')!, 'click'),
    ]
    const times: number[] = []
    const session = (n: number) => {
      for (let i = 0; i < n; i++) {
        const t = performance.now()
        steps[i % steps.length]!()
        if (i % steps.length === steps.length - 1) k++
        times.push(performance.now() - t)
        h.runtime.warm(8)
      }
      // End in the same visible state, so sizes are comparable.
      fire(button('Inspector'), 'click')
      const flipped = document.querySelector('[data-sem-c=flippable] [data-flipped=true]')
      if (flipped) fire(document.querySelector('[data-sem-c=flippable] .sem-back .sem-flip')!, 'click')
    }
    const footprint = () => ({
      triples: h.store.match(null, null, null).length,
      ...Object.fromEntries(Object.entries(h.screen.engine.footprint()).map(([k, v]) => ['engine.' + k, v])),
      ...Object.fromEntries(Object.entries(h.screen.index.footprint()).map(([k, v]) => ['index.' + k, v])),
      ...Object.fromEntries(Object.entries(h.shell.footprint()).map(([k, v]) => ['dom.' + k, v])),
      ...Object.fromEntries(Object.entries(h.runtime.views.footprint()).map(([k, v]) => ['views.' + k, v])),
      log: h.bus.recent(10_000).length,
    })
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!
    session(3 * PERIOD) // past the change log's bound (200 events)
    const warm = footprint()
    const early = median(times.slice(-300))
    session(11 * PERIOD)
    const after = footprint()
    const late = median(times.slice(-300))
    const grew = Object.entries(after).filter(([k, v]) => v > warm[k as keyof typeof warm] * 1.02 + 4).map(([k, v]) => `${k}: ${warm[k as keyof typeof warm]} -> ${v}`)
    expect(grew).toEqual([])
    // Generous, since timing is noisy; a cost that grows with history fails by far more.
    expect(late).toBeLessThan(early * 1.6 + 1)
  }, 600_000)
})
