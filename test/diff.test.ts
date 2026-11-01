import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'
import { implementationGaps } from './implementations.ts'

const base = 'https://example.org/diff#'
const graph = `@prefix ex: <${base}> .
@prefix c: <https://semblance.dev/ns/component#> .
ex:view a c:DiffView ; c:label "Changes to sample.txt" ; c:items ( ex:before ex:removed ex:added ex:after ) .
ex:before a c:DiffLine ; c:value "one" .
ex:removed a c:DiffLine ; c:value "old" ; c:diffKind c:DiffRemoved .
ex:added a c:DiffLine ; c:value "new" ; c:diffKind c:DiffAdded .
ex:after a c:DiffLine ; c:value "<escaped>" ; c:diffKind c:DiffContext .`

function show(prefer: 'sparql' | 'function', languages?: string[]) {
  const store = loadStore('oxigraph', graph)
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, name: `diff-${prefer}`, roots: [base + 'view'] }, error => { throw error })
  screen.engine.reconfigure({ prefer, languages })
  const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const dom = new DomRenderer(screen.index, document.getElementById('app')!, base + 'view')
  dom.flush()
  const text = runtime.project({ modality: MOD.Text, name: `diff-text-${prefer}`, roots: [base + 'view'] }, error => { throw error })
  text.engine.reconfigure({ prefer, languages })
  return { document, text: toText(text.index, base + 'view') }
}

describe('c:DiffView', () => {
  it('has both SPARQL and function renderings', () => {
    expect(implementationGaps(['components/diff.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })

  it('renders lines in order, escapes text, and gives each change an accessible name', () => {
    const [sparql, fn] = [show('sparql'), show('function')]
    const rows = (result: ReturnType<typeof show>) => [...result.document.querySelectorAll('[role=listitem]')]
    expect(sparql.document.getElementById('app')!.innerHTML).toBe(fn.document.getElementById('app')!.innerHTML)
    expect(sparql.document.querySelector('[role=list]')?.getAttribute('aria-label')).toBe('Changes to sample.txt')
    expect(rows(sparql).map(row => row.textContent)).toEqual([' one', '-old', '+new', ' <escaped>'])
    expect(rows(sparql).map(row => row.getAttribute('data-sem-change'))).toEqual(['context', 'removed', 'added', 'context'])
    expect(rows(sparql)[1]?.getAttribute('aria-label')).toBe('Removed: old')
    expect(rows(sparql)[2]?.getAttribute('aria-label')).toBe('Added: new')
    expect(sparql.document.querySelector('code')?.innerHTML).toBe('one')
    expect(rows(sparql)[3]?.querySelector('code')?.innerHTML).toBe('&lt;escaped&gt;')
    expect(sparql.text).toBe(fn.text)
    expect(sparql.text).toContain(' one\n-old\n+new\n <escaped>')
  })

  it('uses theme tokens for the diff surface and change colors', () => {
    const css = compileStyles(loadStore('n3'))
    expect(css).toContain('[data-sem-c="diff-view"]')
    expect(css).toContain('var(--sem-surface-sunken)')
    expect(css).toContain('width: 100%')
    expect(css).toContain('[data-sem-change=added]')
    expect(css).toContain('[data-sem-change=removed]')
    expect(css).toContain('var(--sem-success)')
    expect(css).toContain('var(--sem-danger)')
    expect(css).toMatch(/\[data-sem-c="diff-line"\] > code[^}]*background: transparent/)
  })

  it('speaks change names in the viewer language', () => {
    for (const prefer of ['sparql', 'function'] as const) {
      const result = show(prefer, ['ar'])
      const names = [...result.document.querySelectorAll('[role=listitem]')].map(row => row.getAttribute('aria-label'))
      expect(names).toEqual(['دون تغيير: one', 'محذوف: old', 'مضاف: new', 'دون تغيير: <escaped>'])
    }
  })
})
