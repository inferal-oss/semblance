import { describe, expect, it } from 'vitest'
import { shellSoak } from './soak-session.ts'

/**
 * A long session must not accumulate anything: once the change log is at its bound, the graph, the
 * store's terms and host caches, the engine's bookkeeping, the HTML index, the DOM renderer and the
 * host effects stay the same size however many more events arrive. The engine's WebAssembly memory
 * never shrinks: it may reach a high-water mark, and then it must stay there.
 */
describe('soak', () => {
  it('keeps every structure and the time per event bounded over 3,500 events', () => {
    // The site's store (Semblance's WAT engine), past the change log's bounds (200 events, and 60
    // undoable ones before them) in 3 periods, then 11 more.
    const { h, grew, early, late, wasmByPeriod } = shellSoak('wat', 'sparql', { warmUp: 3, measured: 11 })
    expect(grew).toEqual([])
    // The memory's high-water mark is reached within the first half of the measured periods.
    const half = wasmByPeriod.length >> 1
    expect(wasmByPeriod.slice(half).every((w) => w === wasmByPeriod[half - 1]), `${wasmByPeriod.map((w) => w >> 20).join(', ')} MiB`).toBe(true)
    // Generous, since timing is noisy; a cost that grows with history fails by far more.
    expect(late).toBeLessThan(early * 1.6 + 1)
    h.runtime.dispose()
  }, 600_000)
})
