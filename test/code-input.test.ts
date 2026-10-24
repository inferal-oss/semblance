import { describe, expect, it } from 'vitest'
import { MOD, NS } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const C = NS.c

/** The demo shell on the Components page, showing the Inputs group. */
function inputs(kind: 'oxigraph' | 'n3', prefer: 'sparql' | 'function' = 'sparql') {
  const shell = mountShell(5, kind, prefer)
  shell.showPage('Components')
  const { store, runtime } = shell
  const f = store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  runtime.apply({ remove: store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupInputs'))] })
  shell.shell.flush()
  const root = (id: string) => {
    const el = shell.shell.nodeOf(`${UI}${id}/~root`) as HTMLElement | undefined
    return el && shell.document.contains(el) ? el : null
  }
  const value = (s: string) => store.match(f.namedNode(UI + s), f.namedNode(C + 'value'), null).map((q) => q.object.value)
  /** Type into a code input's field as a person (or a paste) would. */
  const type = (id: string, text: string) => {
    const input = root(id)!.querySelector('input')!
    input.value = text
    shell.fire(input, 'input')
    return input
  }
  const cells = (id: string) => [...root(id)!.querySelectorAll('.sem-code-cell')].map((c) => `${c.getAttribute('data-state')}:${c.textContent}`)
  return { ...shell, root, value, type, cells }
}

// SPARQL rules and reactions on Oxigraph; the function ones on N3.
describe.each(['oxigraph', 'n3'] as const)('code input (%s)', (kind) => {
  it('renders one labelled field over a cell per character', () => {
    const { root, cells } = inputs(kind)
    const signin = root('inp-code-signin')!
    expect(signin.getAttribute('data-sem-c')).toBe('code-input')
    const input = signin.querySelector('input')!
    expect(signin.querySelector('label')!.getAttribute('for')).toBe(input.id)
    expect(input.getAttribute('autocomplete')).toBe('one-time-code')
    expect(input.getAttribute('inputmode')).toBe('numeric')
    expect(input.getAttribute('aria-describedby')).toBe(signin.querySelector('.sem-help')!.id)
    expect(signin.querySelector('.sem-code-cells')!.getAttribute('aria-hidden')).toBe('true')
    expect(cells('inp-code-signin')).toEqual(['active:', 'empty:', 'empty:', 'empty:', 'empty:', 'empty:'])
    expect(signin.hasAttribute('data-complete')).toBe(false)
  })

  it('keeps only what the charset allows, up to its length, and resets the field', () => {
    const { type, value, cells, root } = inputs(kind)
    const input = type('inp-code-signin', '12a3')
    expect(value('inp-code-signin')).toEqual(['123'])
    expect(input.value).toBe('123')
    expect(cells('inp-code-signin')).toEqual(['filled:1', 'filled:2', 'filled:3', 'active:', 'empty:', 'empty:'])
    // A rejected character changes nothing in the graph; the field still shows the code.
    type('inp-code-signin', '123x')
    expect(input.value).toBe('123')
    // A pasted code with separators and extra characters.
    type('inp-code-signin', '482-913-77')
    expect(value('inp-code-signin')).toEqual(['482913'])
    expect(root('inp-code-signin')!.getAttribute('data-complete')).toBe('true')
    expect(cells('inp-code-signin').every((c) => c.startsWith('filled:'))).toBe(true)
  })

  it('applies the case and a charset defined in the app', () => {
    const { type, value } = inputs(kind)
    // ui:Unambiguous has no 0, 1, I, L or O.
    type('inp-code-pair', 'a1b-0oc2l9x')
    expect(value('inp-code-pair')).toEqual(['ABC29X'])
    type('inp-code-key', 'DEAD-beef-G00D')
    expect(value('inp-code-key')).toEqual(['deadbeef00d'])
  })

  it('groups cells, masks them, and shows the error and disabled states', () => {
    const { root, type, cells } = inputs(kind)
    const recovery = root('inp-code-recovery')!
    expect(recovery.getAttribute('data-sem-cells')).toBe('joined')
    const parts = [...recovery.querySelector('.sem-code-cells')!.children].map((c) => c.className)
    expect(parts).toEqual([...Array(4).fill('sem-code-cell'), 'sem-code-sep', ...Array(4).fill('sem-code-cell')])
    const pin = type('inp-code-pin', '2580')
    expect(pin.getAttribute('type')).toBe('password')
    expect(cells('inp-code-pin')).toEqual(['filled:•', 'filled:•', 'filled:•', 'filled:•'])
    expect(root('inp-code-pin')!.getAttribute('data-sem-cells')).toBe('underlined')
    const expired = root('inp-code-expired')!
    expect(expired.querySelector('input')!.getAttribute('aria-invalid')).toBe('true')
    expect(expired.querySelector('[role=alert]')!.textContent).toContain('expired')
    // Typing clears the stale error.
    type('inp-code-expired', '48291')
    expect(root('inp-code-expired')!.querySelector('[role=alert]')).toBeNull()
    expect(root('inp-code-off')!.querySelector('input')!.hasAttribute('disabled')).toBe(true)
  })

  it('renders a text sketch', () => {
    const { runtime, type } = inputs(kind)
    type('inp-code-recovery', 'ab12')
    const text = runtime.project({ modality: MOD.Text, name: 'text-codes', roots: [UI + 'gallery-inputs'] })
    const t = (id: string) => toText(text.index, UI + id)
    expect(t('inp-code-recovery')).toBe('Recovery code: [AB12 ____]')
    expect(t('inp-code-signin').split('\n')[0]).toBe('Sign-in code: [______]')
    expect(t('inp-code-expired').split('\n')).toEqual(['Expired code: [482913]', '  ! That code has expired. Ask for a new one.'])
  })
})

describe('code input implementations', () => {
  it('render the same with SPARQL and with functions', () => {
    const html = (prefer: 'sparql' | 'function') => {
      const { root, type } = inputs('oxigraph', prefer)
      type('inp-code-recovery', 'ab12')
      type('inp-code-pin', '25')
      return ['inp-code-signin', 'inp-code-recovery', 'inp-code-pair', 'inp-code-pin', 'inp-code-key', 'inp-code-expired', 'inp-code-off'].map((id) => root(id)!.outerHTML)
    }
    expect(html('sparql')).toEqual(html('function'))
  })
})
