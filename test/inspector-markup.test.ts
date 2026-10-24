import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

describe('the inspector, as HTML', () => {
  it.each(['sparql', 'function'] as const)('shows the hovered element without its RDF/HTML encoding when asked (%s)', (prefer) => {
    const { document, fire, store } = mountShell(5, 'oxigraph', prefer)
    const view = () => document.querySelector('[data-sem-c=query-view]')!.textContent!
    const markup = () => document.querySelector('[data-sem-c=element-markup]')!
    fire(document.querySelector('[data-sem-c=list-item] label')!, 'mouseover')
    expect(view()).toContain('# rendered element (RDF/HTML)')
    expect(markup().hasAttribute('hidden')).toBe(true)

    const box = [...document.querySelectorAll('[data-sem-c=checkbox]')].find((c) => c.textContent!.includes('Without RDF/HTML'))!.querySelector('input')!
    box.checked = true
    fire(box, 'change')
    const f = store.factory
    expect(store.match(f.namedNode(UI + 'inspectorMarkup'), f.namedNode(NS.c + 'active'), null)[0]!.object.value).toBe('true')
    const html = markup().textContent!
    // Straight to the component that rendered it (the list), as Turtle...
    expect(html).toContain('# the component')
    expect(html).toMatch(/ex:todos\s+a c:List/)
    // ...and the element as the HTML it becomes, colored like Turtle.
    expect(html).toContain('# the element as HTML')
    expect([...markup().querySelectorAll('.ttl-keyword')].map((s) => s.textContent)).toContain('label')
    expect([...markup().querySelectorAll('.ttl-pname')].map((s) => s.textContent)).toContain('for')
    expect(html).toMatch(/<label [^>]*for="[^"]+"/)
    expect(html).not.toContain('data-sem-highlighted') // the inspector's own mark is not part of it
    expect(html).not.toContain('rdfhtml:')
    // The RDF/HTML section steps aside; provenance stays.
    expect(view()).not.toContain('# rendered element (RDF/HTML)')
    expect(view()).toContain('# provenance')

    // It follows the hover: a component's root shows its whole subtree, nested components resolved.
    fire(document.querySelector('[data-sem-c=list-item]')!, 'mouseover')
    expect(markup().textContent!.split('\n').length).toBeGreaterThan(6)
    expect(markup().textContent!).toContain('<input')

    box.checked = false
    fire(box, 'change')
    expect(markup().hasAttribute('hidden')).toBe(true)
    expect(view()).toContain('# rendered element (RDF/HTML)')
  })

  it('a check box can drive a property of another node: the box follows the graph', () => {
    const { document, store, runtime, shell } = mountShell()
    const f = store.factory
    const box = () => [...document.querySelectorAll('[data-sem-c=checkbox]')].find((c) => c.textContent!.includes('Without RDF/HTML'))!.querySelector('input')!
    expect(box().hasAttribute('checked')).toBe(false)
    const node = f.namedNode(UI + 'inspectorMarkup')
    const active = f.namedNode(NS.c + 'active')
    runtime.apply({ remove: store.match(node, active, null), add: [f.quad(node, active, f.literal('true', f.namedNode(NS.xsd + 'boolean')))] })
    shell.flush()
    expect(box().hasAttribute('checked')).toBe(true)
  })
})
