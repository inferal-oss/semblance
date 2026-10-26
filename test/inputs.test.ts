import { beforeEach, describe, expect, it } from 'vitest'
import { MOD, NS } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const C = NS.c

/** The demo shell on the Components page, showing the Inputs group. */
let kind: 'oxigraph' | 'n3' | 'wat' | 'rust' = 'oxigraph'
function inputs() {
  const shell = mountShell(5, kind)
  shell.showPage('Components')
  const { store, runtime } = shell
  const f = store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  runtime.apply({ remove: store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupInputs'))] })
  shell.shell.flush()
  /** The mounted root element of a component instance. */
  const root = (id: string) => {
    const el = shell.shell.nodeOf(`${UI}${id}/~root`) as HTMLElement | undefined
    return el && shell.document.contains(el) ? el : null
  }
  const value = (s: string, p: string) => store.match(f.namedNode(UI + s), f.namedNode(p), null).map((q) => q.object.value)
  return { ...shell, root, value }
}

// SPARQL reactions on Oxigraph; the function fallbacks (rules and reactions) on N3.
describe.each(['oxigraph', 'n3', 'wat', 'rust'] as const)('inputs components (%s)', (store) => {
  beforeEach(() => {
    kind = store
  })

  it('renders a labelled text area and writes c:value as you type', () => {
    const { root, fire, value } = inputs()
    const about = root('inp-ta-about')!
    expect(about.getAttribute('data-sem-c')).toBe('text-area')
    const ta = about.querySelector('textarea')!
    expect(about.querySelector('label')!.getAttribute('for')).toBe(ta.id)
    expect(ta.getAttribute('rows')).toBe('3')
    expect(ta.getAttribute('placeholder')).toBe('What is this project about?')
    const help = about.querySelector('.sem-help')!
    expect(ta.getAttribute('aria-describedby')).toBe(help.id)
    ta.value = 'A UI that is a graph.'
    fire(ta, 'input')
    expect(value('inp-ta-about', C + 'value')).toEqual(['A UI that is a graph.'])
    expect(ta.textContent).toBe('A UI that is a graph.')
    // an error is announced and marks the input invalid; typing clears it
    const bad = root('inp-ta-error')!
    const badInput = bad.querySelector('textarea')!
    expect(bad.querySelector('[role=alert]')!.textContent).toContain('full sentence')
    expect(badInput.getAttribute('aria-invalid')).toBe('true')
    badInput.value = 'Adds the Inputs group.'
    fire(badInput, 'input')
    expect(value('inp-ta-error', C + 'error')).toEqual([])
    expect(bad.querySelector('[role=alert]')).toBeNull()
    expect(badInput.hasAttribute('aria-invalid')).toBe(false)
    expect(root('inp-ta-off')!.querySelector('textarea')!.hasAttribute('disabled')).toBe(true)
  })

  it('checks and unchecks a checkbox through the change event', () => {
    const { root, fire, value } = inputs()
    const cb = root('inp-cb-usage')!
    const input = cb.querySelector('input')!
    expect(input.getAttribute('type')).toBe('checkbox')
    expect(cb.querySelector('label')!.getAttribute('for')).toBe(input.id)
    expect(input.hasAttribute('checked')).toBe(false)
    input.checked = true
    fire(input, 'change')
    expect(value('inp-cb-usage', C + 'checked')).toEqual(['true'])
    expect(input.hasAttribute('checked')).toBe(true)
    input.checked = false
    fire(input, 'change')
    expect(value('inp-cb-usage', C + 'checked')).toEqual(['false'])
    expect(input.hasAttribute('checked')).toBe(false)
    // the error line is announced and describes the input
    const terms = root('inp-cb-terms')!
    const t = terms.querySelector('input')!
    expect(t.getAttribute('aria-invalid')).toBe('true')
    expect(t.getAttribute('aria-describedby')).toBe(terms.querySelector('[role=alert]')!.id)
    expect(root('inp-cb-success')!.getAttribute('data-sem-tone')).toBe('success')
  })

  it('edits one triple from a radio group, and every editor of it follows', () => {
    const { root, fire, value } = inputs()
    const group = root('inp-rg-plan')!
    expect(group.getAttribute('role')).toBe('radiogroup')
    expect(group.getAttribute('aria-labelledby')).toBe(group.querySelector('.sem-caption')!.id)
    const radios = [...group.querySelectorAll('input[type=radio]')] as HTMLInputElement[]
    expect(radios.map((r) => r.value)).toEqual([UI + 'inp-plan-free', UI + 'inp-plan-pro', UI + 'inp-plan-team'])
    expect(radios.map((r) => r.hasAttribute('checked'))).toEqual([false, true, false])
    expect(new Set(radios.map((r) => r.name)).size).toBe(1)
    expect(group.querySelector('.sem-option-note')!.textContent).toBe('One project, community support.')
    // the row variant is labelled by the property
    expect(root('inp-rg-row')!.getAttribute('aria-label')).toBe('Plan')
    expect(root('inp-rg-row')!.getAttribute('data-sem-direction')).toBe('row')

    radios[2]!.checked = true
    fire(radios[2]!, 'change')
    expect(value('inputsDemo', UI + 'inp-plan')).toEqual([UI + 'inp-plan-team'])
    expect(radios.map((r) => r.hasAttribute('checked'))).toEqual([false, false, true])
    const row = [...root('inp-rg-row')!.querySelectorAll('input')] as HTMLInputElement[]
    expect(row.map((r) => !!r.checked)).toEqual([false, false, true])
    const seg = root('inp-rg-seg')!
    expect(seg.querySelector('[aria-pressed=true]')!.textContent).toBe('Team')
    const select = root('inp-rg-choice')!.querySelector('select')!
    expect(select.querySelector('[selected]')!.textContent).toBe('Team')
  })

  it('keeps a disabled choice inert and enables it when the graph changes', () => {
    const { root, fire, value, store, runtime, shell } = inputs()
    expect(root('inp-sel-choice-locked')!.querySelector('select')!.hasAttribute('disabled')).toBe(true)
    const f = store.factory
    const choice = f.namedNode(UI + 'inp-rg-choice')
    const disabled = f.quad(choice, f.namedNode(C + 'disabled'),
      f.literal('true', f.namedNode('http://www.w3.org/2001/XMLSchema#boolean')))
    runtime.apply({ add: [disabled], remove: [] })
    shell.flush()
    let select = root('inp-rg-choice')!.querySelector('select')!
    expect(select.hasAttribute('disabled')).toBe(true)
    Object.defineProperty(select, 'value', { value: UI + 'inp-plan-free', configurable: true })
    fire(select, 'change')
    expect(value('inputsDemo', UI + 'inp-plan')).toEqual([UI + 'inp-plan-pro'])

    runtime.apply({ add: [], remove: [disabled] })
    shell.flush()
    select = root('inp-rg-choice')!.querySelector('select')!
    expect(select.hasAttribute('disabled')).toBe(false)
    Object.defineProperty(select, 'value', { value: UI + 'inp-plan-free', configurable: true })
    fire(select, 'change')
    expect(value('inputsDemo', UI + 'inp-plan')).toEqual([UI + 'inp-plan-free'])
  })

  it('flips a switch: its own c:checked, or a property it controls (shared with c:Toggle)', () => {
    const { root, fire, value } = inputs()
    const wifi = root('inp-sw-wifi')!
    const button = wifi.querySelector('button')!
    expect(button.getAttribute('role')).toBe('switch')
    expect(button.getAttribute('aria-checked')).toBe('true')
    expect(button.textContent).toBe('Wi-Fi')
    fire(button, 'click')
    expect(value('inp-sw-wifi', C + 'checked')).toEqual(['false'])
    expect(button.getAttribute('aria-checked')).toBe('false')

    const notify = root('inp-sw-notify')!
    const sw = notify.querySelector('button')!
    expect(sw.textContent).toBe('Email notifications') // labelled by the property
    expect(sw.getAttribute('aria-describedby')).toBe(notify.querySelector('.sem-help')!.id)
    const toggle = root('inp-sw-toggle')!
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    // the help line is not the switch
    fire(notify.querySelector('.sem-help')!, 'click')
    expect(value('inputsDemo', UI + 'inp-notify')).toEqual(['true'])
    fire(sw.querySelector('.sem-thumb')!, 'click')
    expect(value('inputsDemo', UI + 'inp-notify')).toEqual(['false'])
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    // and the old c:Toggle still works on the same triple (it has no function fallback, so not on N3)
    if (kind === 'oxigraph') {
      fire(toggle, 'click')
      expect(sw.getAttribute('aria-checked')).toBe('true')
    }
    // disabled switches do not flip
    const off = root('inp-sw-off')!.querySelector('button')!
    expect(off.hasAttribute('disabled')).toBe(true)
    fire(off, 'click')
    expect(value('inp-sw-off', C + 'checked')).toEqual(['true'])
  })

  it('writes c:value from a slider and shows it', () => {
    const { root, fire, value } = inputs()
    const volume = root('inp-sl-volume')!
    const input = volume.querySelector('input')! as HTMLInputElement
    expect(input.getAttribute('type')).toBe('range')
    expect([input.getAttribute('min'), input.getAttribute('max'), input.getAttribute('step')]).toEqual(['0', '100', '1'])
    expect(volume.querySelector('label')!.getAttribute('for')).toBe(input.id)
    expect(volume.querySelector('.sem-value')!.textContent).toBe('40 %')
    expect(input.getAttribute('aria-valuetext')).toBe('40 %')
    expect(input.getAttribute('style')).toBe('--sem-fill: 40.00%')
    input.value = '75'
    fire(input, 'input')
    expect(value('inp-sl-volume', C + 'value')).toEqual(['75'])
    expect(volume.querySelector('.sem-value')!.textContent).toBe('75 %')
    expect(input.getAttribute('style')).toBe('--sem-fill: 75.00%')
    expect(root('inp-sl-opacity')!.querySelector('.sem-value')!.textContent).toBe('0.80')
  })

  it('labels and describes any control from a field', () => {
    const { root, fire, value } = inputs()
    const bio = root('inp-f-bio')!
    const ta = bio.querySelector('textarea')!
    const label = bio.querySelector('.sem-field-label')!
    expect(label.localName).toBe('label')
    expect(label.getAttribute('for')).toBe(ta.id) // the TextArea's c:labelPart
    expect(ta.getAttribute('aria-describedby')).toBe(bio.querySelector('.sem-help')!.id)
    ta.value = 'Hello'
    fire(ta, 'input')
    expect(value('inp-f-bio-input', C + 'value')).toEqual(['Hello'])

    // a group of options has no labelPart: it is labelled by the field's label
    const plan = root('inp-f-plan')!
    const group = root('inp-f-plan-input')!
    expect(plan.querySelector('.sem-field-label')!.localName).toBe('div')
    expect(group.getAttribute('aria-labelledby')).toBe(plan.querySelector('.sem-field-label')!.id)
    expect(group.getAttribute('aria-describedby')).toBe(plan.querySelector('.sem-help')!.id)

    // the field's error marks its control invalid
    const terms = root('inp-f-terms')!
    const box = terms.querySelector('input')!
    expect(box.getAttribute('aria-invalid')).toBe('true')
    expect(box.getAttribute('aria-describedby')).toBe(terms.querySelector('[role=alert]')!.id)
    expect(terms.querySelector('.sem-field-label')!.getAttribute('for')).toBe(box.id)

    const level = root('inp-f-level')!
    expect(level.querySelector('label.sem-field-label')!.getAttribute('for')).toBe(level.querySelector('input')!.id)
  })

  it('renders a text sketch of each component', () => {
    const { runtime } = inputs()
    const text = runtime.project({ modality: MOD.Text, name: 'text-inputs', roots: [UI + 'gallery-inputs'] })
    const t = (id: string) => toText(text.index, UI + id)
    expect(t('inp-cb-updates').split('\n')).toEqual(['[x] Email me about product updates', '  At most one email a month.'])
    expect(t('inp-rg-plan')).toBe('Plan: ( ) Free  (•) Pro  ( ) Team')
    expect(t('inp-sw-wifi')).toBe('[on ] Wi-Fi')
    expect(t('inp-sl-volume')).toBe('Volume: ━━━━━━━━●──────────── 40 %')
    expect(t('inp-ta-error').split('\n')).toEqual(['Release notes:', '  | tbd', '  ! Release notes need at least one full sentence.'])
    expect(t('inp-f-level').split('\n')[0]).toBe('Brightness:')
  })
})
