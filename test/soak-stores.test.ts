import { describe, expect, it } from 'vitest'
import { shellSoak, withoutSparqlOnly } from './soak-session.ts'

/**
 * The shell soak (test/soak.test.ts) on the stores without Semblance's engines: N3 (function rules
 * only) and the hybrid (Oxigraph for SPARQL, an N3 mirror for matching, function rules preferred).
 * Neither has WebAssembly memory of its own to measure: the graph, N3's dictionary (store.terms) and
 * every other structure stay the same size once the change log is at its bound.
 */
describe('soak on other stores', () => {
  it('N3: every structure stays bounded over 3,500 events', () => {
    // N3 has no SPARQL: the site's reactions written in SPARQL only (the inspector's hover) are left out.
    const { h, grew, early, late } = shellSoak('n3', 'function', { warmUp: 3, measured: 11, prepare: withoutSparqlOnly })
    expect(grew).toEqual([])
    expect(late).toBeLessThan(early * 1.6 + 1)
    h.runtime.dispose()
  }, 600_000)

  it('hybrid: every structure stays bounded over 2,500 events', () => {
    // Fewer periods: every event writes to both copies, and the copies are rebuilt in idle time.
    const { h, grew, early, late } = shellSoak('hybrid', 'function', { warmUp: 3, measured: 7 })
    expect(grew).toEqual([])
    expect(late).toBeLessThan(early * 1.6 + 1)
    h.runtime.dispose()
  }, 600_000)
})
