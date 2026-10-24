import { describe, expect, it } from 'vitest'
import { compileStyles } from '../src/style/compile.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

function showLayers() {
  const h = mountShell()
  const f = h.store.factory
  const app = f.namedNode(UI + 'app')
  h.showPage('Components')
  const group = f.namedNode(UI + 'galleryGroup')
  h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupLayers'))] })
  h.shell.flush()
  const $ = (sel: string) => h.document.querySelector(sel) as HTMLElement
  const byId = (iri: string) => h.shell.nodeOf(iri) as HTMLElement
  return { ...h, $, byId }
}

describe('validation layer', () => {
  it('derives errors from SHACL shapes and gates the submit button', () => {
    const h = showLayers()
    const input = (field: string) => h.byId(`${UI}${field}/~input`) as HTMLInputElement
    const submit = h.byId(`${UI}signupSubmit/~root`) as HTMLButtonElement
    const type = (field: string, value: string) => {
      input(field).value = value
      h.fire(input(field), 'input')
    }
    // Pristine: invalid (required) but quiet, so the button is disabled and nothing is shown.
    expect(submit.hasAttribute('disabled')).toBe(true)
    expect(input('signupEmail').getAttribute('aria-invalid')).toBeNull()
    type('signupEmail', 'not an email')
    expect(input('signupEmail').getAttribute('aria-invalid')).toBe('true')
    expect(h.byId(`${UI}signupEmail/~root`).textContent).toContain('Enter an email address like you@example.org.')
    type('signupEmail', 'ada@example.org')
    expect(input('signupEmail').getAttribute('aria-invalid')).toBeNull()
    type('signupPassword', 'short')
    expect(h.byId(`${UI}signupPassword/~root`).textContent).toContain('at least 8 characters')
    type('signupPassword', 'longenough1')
    type('signupAge', '12')
    expect(h.byId(`${UI}signupAge/~root`).textContent).toContain('13 to 120')
    expect(submit.hasAttribute('disabled')).toBe(true)
    type('signupAge', '36')
    expect(submit.hasAttribute('disabled')).toBe(false)
  })
})

describe('keyboard layer', () => {
  it('exposes shortcuts and turns key presses into the component’s own events', () => {
    const h = showLayers()
    const button = h.byId(`${UI}increment/~root`)
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+I')
    expect(button.getAttribute('data-sem-shortcut-other')).toBe('Ctrl+I')
    const press = (key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => {
      const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
      Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
      h.document.dispatchEvent(e)
    }
    const counter = () => h.byId(`${UI}counter/~root`).textContent
    press('i', { ctrlKey: true })
    press('i', { ctrlKey: true })
    expect(counter()).toBe('2')
    press('I', { ctrlKey: true, shiftKey: true })
    expect(counter()).toBe('0')
    // The list is a view of every key:shortcut in the graph.
    expect(h.$('[data-sem-c=shortcut-list]').textContent).toContain('Increment')
  })
})

describe('keyboard layer: Escape', () => {
  it('dismisses the open dialog through its own close control', () => {
    const h = showLayers()
    const f = h.store.factory
    const app = f.namedNode(UI + 'app')
    const group = f.namedNode(UI + 'galleryGroup')
    h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupOverlays'))] })
    h.shell.flush()
    const open = () => h.store.match(f.namedNode(UI + 'ov-dialog'), f.namedNode('https://semblance.dev/ns/component#open'), null).map((q) => q.object.value)
    h.fire(h.byId(`${UI}ov-open-dialog/~root`), 'click')
    expect(open()).toEqual(['true'])
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
    h.document.dispatchEvent(e)
    expect(open()).toEqual(['false'])
  })
})

describe('status layer', () => {
  it('marks busy components aria-busy', () => {
    const h = showLayers()
    const target = () => h.byId(`${UI}busyTarget/~root`)
    expect(target().getAttribute('aria-busy')).toBeNull()
    h.fire(h.byId(`${UI}busyToggle/~root`), 'click')
    expect(target().getAttribute('aria-busy')).toBe('true')
    h.fire(h.byId(`${UI}busyToggle/~root`), 'click')
    expect(target().getAttribute('aria-busy')).toBeNull()
  })
})

describe('localization layer', () => {
  it('renders labels in the viewer’s language, through function and SPARQL rules alike', () => {
    const h = showLayers()
    const nav = () => h.$('[data-sem-c=nav-list]').textContent
    expect(nav()).toContain('Foundations')
    h.screen.engine.reconfigure({ languages: ['uk'] })
    h.shell.flush()
    expect(nav()).toContain('Основи')
    // c:Button renders through its SPARQL rule by default: it reads the derived l10n:label.
    expect(h.byId(`${UI}signupSubmit/~root`).textContent).toBe('Створити обліковий запис')
    // Untranslated text falls back to the source.
    expect(h.byId(`${UI}busyTarget/~root`).textContent).toContain('Figures are recomputed')
    h.screen.engine.reconfigure({ languages: ['en'] })
    h.shell.flush()
    expect(h.byId(`${UI}signupSubmit/~root`).textContent).toBe('Create account')
  })
})

describe('display axes', () => {
  it('hooks motion, contrast and density onto the shell and compiles their token overrides', () => {
    const h = showLayers()
    const shell = h.byId(`${UI}shell/~root`)
    expect(shell.getAttribute('data-sem-motion')).toBe('full')
    expect(shell.getAttribute('data-sem-contrast')).toBe('standard')
    const option = (text: string) => [...h.document.querySelectorAll('[data-sem-c=segmented] button')].find((b) => b.textContent!.includes(text))!
    h.fire(option('None'), 'click')
    h.fire(option('High'), 'click')
    expect(shell.getAttribute('data-sem-motion')).toBe('none')
    expect(shell.getAttribute('data-sem-contrast')).toBe('high')
    const css = compileStyles(h.store)
    expect(css).toMatch(/\[data-sem-motion="none"\] \{[^}]*--sem-duration: 0ms/)
    expect(css).toMatch(/\[data-sem-contrast="high"\] \{[^}]*--sem-text:/)
    expect(css).toContain('@keyframes sem-spin')
  })
})
