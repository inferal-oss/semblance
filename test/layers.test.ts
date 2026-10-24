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
    // Announcing reactions become toasts in the shell's region, newest last.
    const region = h.byId(`${UI}announcements/~root`)
    const toasts = [...region.querySelectorAll('[data-sem-c=toast]')].map((t) => t.textContent)
    expect(toasts.filter((t) => t!.includes('Counter'))).toHaveLength(3)
    expect(toasts.at(-1)).toContain('Counter reset')
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

describe('keyboard layer: commands', () => {
  it('pauses and resumes the inspector with Z, from anywhere, through the graph', () => {
    const h = mountShell()
    const mode = () => h.value(UI + 'inspectorMode')
    const press = (target: EventTarget) => {
      const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
      Object.assign(e, { key: 'z', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
      target.dispatchEvent(e)
    }
    press(h.document)
    expect(mode()).toBe(UI + 'Paused')
    // Typing a z into a field is just typing.
    const field = h.document.querySelector('[data-sem-c=text-field] input')!
    press(field)
    expect(mode()).toBe(UI + 'Paused')
    press(h.document)
    expect(mode()).toBe(UI + 'Live')
    // Shift+Z turns collection off (and clears what was inspected), and on again.
    const shiftZ = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(shiftZ, { key: 'Z', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })
    h.document.dispatchEvent(shiftZ)
    expect(mode()).toBe(UI + 'Off')
    const again = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(again, { key: 'Z', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })
    h.document.dispatchEvent(again)
    expect(mode()).toBe(UI + 'Live')
    press(h.document)
    press(h.document)
    // Each press is an event in the change log, handled by exactly one of the two reactions.
    const handled = h.bus.recent(2).map((quads) => quads.filter((q) => q.predicate.value.endsWith('#handledBy')).map((q) => q.object.value))
    expect(handled).toEqual([[UI + 'ResumeInspector'], [UI + 'PauseInspector']])
  })
})

describe('component shapes layer', () => {
  it('validates components against their classes’ SHACL shapes and reports the results', () => {
    const h = showLayers()
    const f = h.store.factory
    const SH = 'http://www.w3.org/ns/shacl#'
    const results = h.store.match(null, f.namedNode(SH + 'focusNode'), null).map((q) => q.object.value.replace(UI, ''))
    expect(new Set(results)).toEqual(new Set(['badLink', 'badProgress', 'badBadge']))
    // Standard SHACL results, in the derived graph.
    const link = h.store.match(null, f.namedNode(SH + 'focusNode'), f.namedNode(UI + 'badLink'))[0]!.subject
    expect(h.store.match(link, f.namedNode(SH + 'resultPath'), null)[0]!.object.value).toBe('https://semblance.dev/ns/component#href')
    expect(h.store.match(link, f.namedNode(SH + 'resultMessage'), null)[0]!.object.value).toContain('no javascript:')
    // Offenders are outlined and explained; the report lists every result.
    const progress = h.byId(`${UI}badProgress/~root`)
    expect(progress.getAttribute('data-sem-shape-invalid')).toBe('1')
    expect(progress.getAttribute('data-sem-tooltip')).toContain('exceed')
    expect(h.byId(`${UI}badBadge/~root`).getAttribute('data-sem-tooltip')).toContain('expected a Tone')
    expect(h.$('[data-sem-c=shape-report]').querySelectorAll('li')).toHaveLength(3)
    // Fixing the data fixes the report.
    h.runtime.apply({ remove: h.store.match(f.namedNode(UI + 'badBadge'), f.namedNode('https://semblance.dev/ns/style#tone'), null), add: [] })
    h.shell.flush()
    expect(h.$('[data-sem-c=shape-report]').querySelectorAll('li')).toHaveLength(2)
  })
})

describe('ontology docs layer', () => {
  it('shows, under each specimen, the ontology of the components it uses, once opened', () => {
    const h = showLayers()
    const f = h.store.factory
    const app = f.namedNode(UI + 'app')
    const group = f.namedNode(UI + 'galleryGroup')
    h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupFeedback'))] })
    h.shell.flush()
    const spec = h.byId(`${UI}fb-alerts-spec/~root`)
    const toggle = spec.querySelector('.sem-docs-toggle')!
    expect(toggle.textContent).toContain('c:Alert')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(spec.querySelector('[data-sem-c=class-doc]')).toBeNull() // not built until opened
    h.fire(toggle, 'click')
    const doc = spec.querySelector('[data-sem-c=class-doc]')!
    expect(doc.textContent).toContain('c:Alert')
    expect(doc.textContent).toContain('rdfs:subClassOf')
    expect(doc.textContent).toContain('sem:targets')
    // The section sits after the stage, inside the specimen.
    expect(spec.lastElementChild!.classList.contains('sem-docs')).toBe(true)
  })
})

describe('c:inputType', () => {
  it('masks the password and asks for an email address', () => {
    const h = showLayers()
    expect((h.byId(`${UI}signupPassword/~input`) as HTMLInputElement).getAttribute('type')).toBe('password')
    expect((h.byId(`${UI}signupEmail/~input`) as HTMLInputElement).getAttribute('type')).toBe('email')
  })
})

describe('privacy (concealment) layer', () => {
  it('masks concealed text fields, marks other components, and private mode adds the sensitive ones', () => {
    const h = showLayers()
    expect((h.byId(`${UI}apiKey/~input`) as HTMLInputElement).getAttribute('type')).toBe('password')
    expect(h.byId(`${UI}balance/~root`).hasAttribute('data-sem-concealed')).toBe(true)
    expect(h.byId(`${UI}income/~root`).hasAttribute('data-sem-sensitive')).toBe(true)
    const shell = h.byId(`${UI}shell/~root`)
    expect(shell.getAttribute('data-sem-privacy')).toBe('conceal')
    const press = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(press, { key: 'H', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })
    h.document.dispatchEvent(press)
    expect(shell.getAttribute('data-sem-privacy')).toBe('private')
    const css = compileStyles(h.store)
    expect(css).toContain('[data-sem-privacy=private] [data-sem-sensitive]')
  })
})
