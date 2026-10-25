import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'

const ROOT = 'https://example.org/ui#layout'
const graph = `
@prefix ui: <https://example.org/ui#> .
@prefix c: <https://semblance.dev/ns/component#> .
ui:layout a c:Stack ; c:children ( ui:form ui:inspect ) .
ui:form a c:HostSlot ; c:slot "form" .
ui:inspect a c:ProjectionView ; c:slot "inspect" .
`

describe('c:HostSlot', () => {
  it('renders a neutral host-owned slot while ProjectionView keeps its inspection style', () => {
    const html: string[] = []
    for (const prefer of ['sparql', 'function'] as const) {
      const { document } = parseHTML('<!doctype html><html><body><main id="app"></main></body></html>')
      const store = loadStore('oxigraph', graph)
      const screen = new Runtime(store).project({ modality: MOD.Screen, layers: [STY.Layer], prefer, roots: [ROOT] })
      const renderer = new DomRenderer(screen.index, document.getElementById('app')!, ROOT)
      renderer.flush()

      const slot = renderer.slot('form')!
      expect(slot.getAttribute('data-sem-c')).toBe('host-slot')
      expect(renderer.slot('inspect')?.getAttribute('data-sem-c')).toBe('projection-view')
      const button = document.createElement('button')
      button.textContent = 'Save'
      slot.append(button)
      renderer.flush()
      expect(renderer.slot('form')?.textContent).toBe('Save')
      html.push(document.getElementById('app')!.innerHTML)
    }
    expect(html[0]).toBe(html[1])

    const css = compileStyles(loadStore('n3'))
    const inspectionRule = css.split('\n').find((line) => line.includes('[data-sem-c="projection-view"]') && line.includes('min-height: 200px'))
    expect(inspectionRule).toBeDefined()
    expect(inspectionRule).not.toContain('[data-sem-c="host-slot"]')
  })
})
