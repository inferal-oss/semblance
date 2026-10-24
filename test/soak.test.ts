import { describe, expect, it } from 'vitest'
import { mountShell } from './harness.ts'

/**
 * A long session must not accumulate anything: once the change log is at its
 * bound, the graph, the engine's bookkeeping, the HTML index and the DOM
 * renderer stay the same size however many more events arrive.
 */
describe('soak', () => {
  it('keeps every structure and the time per event bounded over 3,000 events', () => {
    // The app's store (Oxigraph for SPARQL, N3 for matching), with an idle slice
    // between interactions as a browser would give it.
    const h = mountShell(5, 'hybrid')
    const { document, fire } = h
    const button = (text: string) => {
      const all = [...document.querySelectorAll('button, [role=tab]')]
      return (all.find((b) => b.textContent!.trim() === text) ?? all.find((b) => b.textContent!.trim().endsWith(text))) as HTMLElement
    }
    const field = () => document.querySelector('[data-sem-c=text-field] input') as HTMLInputElement
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
      () => fire(document.querySelectorAll('[data-sem-c=list-item] label')[Math.floor(Math.random() * 3)]!, 'mouseover'),
      () => fire(button(['Activity', 'Change log', 'Inspector'][Math.floor(Math.random() * 3)]!), 'click'),
      () => fire(button('Toggle density'), 'click'),
      () => fire(document.querySelector('[data-sem-c=flippable] .sem-flip')!, 'click'),
    ]
    const times: number[] = []
    const session = (n: number) => {
      for (let i = 0; i < n; i++) {
        const t = performance.now()
        steps[i % steps.length]!()
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
      log: h.bus.recent(10_000).length,
    })
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!
    session(600) // past the change log's bound
    const warm = footprint()
    const early = median(times.slice(-300))
    session(3_000)
    const after = footprint()
    const late = median(times.slice(-300))
    const grew = Object.entries(after).filter(([k, v]) => v > warm[k as keyof typeof warm] * 1.02 + 4).map(([k, v]) => `${k}: ${warm[k as keyof typeof warm]} -> ${v}`)
    expect(grew).toEqual([])
    // Generous, since timing is noisy; a cost that grows with history fails by far more.
    expect(late).toBeLessThan(early * 1.6 + 1)
  }, 600_000)
})
