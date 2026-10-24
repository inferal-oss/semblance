// The core components (stack, heading, button, text field, list, controls, views,
// progress, stream stats, layout, type, disclosure) have both a SPARQL and a
// function implementation of every rendering, and the two render identical HTML.
import { describe, expect, it } from 'vitest'
import { mountShell } from './harness.ts'
import { expectSameRendering, implementationGaps } from './implementations.ts'

const FILES = [
  'components/stack.ttl',
  'components/heading.ttl',
  'components/button.ttl',
  'components/textfield.ttl',
  'components/list.ttl',
  'components/controls.ttl',
  'components/views.ttl',
  'components/progress.ttl',
  'components/stream-stats.ttl',
  'components/layout.ttl',
  'components/type.ttl',
  'components/disclosure.ttl',
]

describe('core components: SPARQL and function implementations', () => {
  it('every rendering has a SPARQL rule (or says why not) and a function rule', () => {
    expect(implementationGaps(FILES)).toEqual({ noSparql: [], noFunction: [] })
  })

  it('SPARQL and function rules render the same HTML', { timeout: 300_000 }, () => {
    expectSameRendering(['GroupFoundations', 'GroupLayout', 'GroupType', 'GroupDisclosure'], ['Playground', 'Performance'])
  })

  it('render the change-log statistics alike once there is history', { timeout: 120_000 }, () => {
    // One history, rendered with each implementation preferred in turn.
    const h = mountShell(5, 'oxigraph', 'sparql')
    for (let i = 0; i < 3; i++) {
      const box = h.document.querySelector('[data-sem-c=list-item] input') as HTMLInputElement
      box.checked = !box.checked
      h.fire(box, 'change')
    }
    const tab = [...h.document.querySelectorAll('[role=tab]')].find((t) => t.textContent!.trim() === 'Activity') as HTMLElement
    h.fire(tab, 'click')
    const stats = () => h.document.querySelector('[data-sem-c=stream-stats]')!.outerHTML
    const sparql = stats()
    h.screen.engine.reconfigure({ prefer: 'function' })
    h.shell.flush()
    expect(sparql).toContain('<li')
    expect(stats()).toBe(sparql)
  })
})
