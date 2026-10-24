// The data and navigation components and the layers: every rendering has a SPARQL
// and a function implementation (or says why it is function-only), and both render
// the same HTML.
import { describe, expect, it } from 'vitest'
import { expectSameRendering, implementationGaps } from './implementations.ts'

const FILES = [
  'components/data.ttl',
  'components/navigation.ttl',
  'components/charts.ttl',
  'layers/keyboard.ttl',
  'layers/status.ttl',
  'layers/l10n.ttl',
  'layers/announce.ttl',
  'layers/validation.ttl',
  'layers/shapes.ttl',
  'layers/tooltip.ttl',
  'layers/a11y.ttl',
  'layers/provenance.ttl',
]

describe('data, navigation, charts and layers', () => {
  it('have SPARQL and function implementations', () => {
    expect(implementationGaps(FILES)).toEqual({ noSparql: [], noFunction: [] })
  })

  it('render the same with SPARQL and with functions', { timeout: 300_000 }, () => {
    expectSameRendering(['GroupData', 'GroupNavigation', 'GroupLayers'], ['Performance'])
  })
})
