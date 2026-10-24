import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { type Backend, memoryBackend } from '../src/persistence.ts'
import { mountRemembering, mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const SET = 'https://semblance.dev/demo/settings#'
const PER = NS.per

type Shell = ReturnType<typeof mountSite>

/** The settings example, reached the way a visitor gets there, driven only through events. */
function open(h: Shell) {
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const navItem = (text: string) => [...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const click = (el: Element) => h.fire(el, 'click')
  click(button('Examples'))
  click(navItem('Settings'))
  const byId = (iri: string) => h.shell.nodeOf(iri + '/~root') as HTMLElement
  const root = (local: string) => byId(UI + local)
  const input = (local: string) => root(local).querySelector('input, textarea') as HTMLInputElement
  const type = (local: string, text: string) => {
    const el = input(local)
    el.value = text
    h.fire(el, 'input')
  }
  const status = () => root('set-status').textContent!.trim()
  const tone = () => root('set-status').getAttribute('data-sem-tone')
  const save = () => root('set-save').closest('button') ?? (root('set-save').querySelector('button') as HTMLButtonElement)
  const sw = (local: string) => root(local).querySelector('[role=switch]') as HTMLElement
  const f = h.store.factory
  const value = (node: string, p: string) => h.store.match(f.namedNode(UI + node), f.namedNode(SET + p), null).map((q) => q.object.value)
  return { ...h, visible, button, click, root, input, type, status, tone, save, sw, value }
}

describe('the settings example', () => {
  it('edits a draft, counts the changes, saves and discards', () => {
    const s = open(mountSite())
    expect(s.root('ex-settings').textContent).toContain('draft and a saved copy')
    expect(s.status()).toContain('All changes saved')
    expect(s.tone()).toBe('success')
    expect(s.save().hasAttribute('disabled')).toBe(true) // nothing to save

    s.type('set-name', 'Ada King')
    expect(s.value('set-draft', 'displayName')).toEqual(['Ada King'])
    expect(s.value('set-saved', 'displayName')).toEqual(['Ada Lovelace'])
    expect(s.status()).toContain('1 unsaved change')
    expect(s.tone()).toBe('warning')
    s.click(s.sw('set-digest'))
    expect(s.value('set-draft', 'digest')).toEqual(['true'])
    expect(s.status()).toContain('2 unsaved changes')
    // Typing the old name back is no change.
    s.type('set-name', 'Ada Lovelace')
    expect(s.status()).toContain('1 unsaved change')
    s.type('set-name', 'Ada King')

    // Discard puts the saved values back into the draft and the field.
    s.click(s.button('Discard'))
    expect(s.input('set-name').value).toBe('Ada Lovelace')
    expect(s.value('set-draft', 'digest')).toEqual(['false'])
    expect(s.sw('set-digest').getAttribute('aria-checked')).toBe('false')
    expect(s.status()).toContain('All changes saved')

    // Save copies the draft to the saved node, and says so.
    s.type('set-bio', 'Poet of numbers.')
    expect(s.save().hasAttribute('disabled')).toBe(false)
    s.click(s.save())
    expect(s.value('set-saved', 'bio')).toEqual(['Poet of numbers.'])
    expect(s.value('set-saved', 'savedAt')).toHaveLength(1)
    expect(s.status()).toContain('All changes saved')
    const toasts = [...s.document.querySelectorAll('[data-sem-c=toast]')].map((t) => t.textContent)
    expect(toasts.some((t) => t!.includes('Settings saved'))).toBe(true)
  })

  it('validates the email and keeps Save disabled while it is wrong', () => {
    const s = open(mountSite())
    s.type('set-email', 'ada-at-example')
    expect(s.root('set-email').querySelector('[role=alert]')?.textContent).toContain('Enter an email address')
    expect(s.input('set-email').getAttribute('aria-invalid')).toBe('true')
    expect(s.status()).toContain('1 unsaved change')
    expect(s.save().hasAttribute('disabled')).toBe(true)
    s.click(s.save()) // the reaction checks too
    expect(s.value('set-saved', 'email')).toEqual(['ada@example.org'])
    s.type('set-email', 'ada@analytical.engine')
    expect(s.root('set-email').querySelector('[role=alert]')).toBeNull()
    expect(s.save().hasAttribute('disabled')).toBe(false)
    s.click(s.save())
    expect(s.value('set-saved', 'email')).toEqual(['ada@analytical.engine'])
  })

  it('previews the chosen theme on the sample card', () => {
    const s = open(mountSite())
    const preview = s.root('set-preview')
    expect(preview.getAttribute('data-sem-theme')).toBe('semblance')
    const select = s.root('set-theme').querySelector('select')!
    const paper = [...select.querySelectorAll('option')].find((o) => o.textContent === 'Paper')!
    Object.defineProperty(select, 'value', { value: paper.getAttribute('value'), configurable: true })
    s.fire(select, 'change')
    expect(s.value('set-draft', 'theme')).toEqual([NS.sty + 'Paper'])
    expect(s.root('set-preview').getAttribute('data-sem-theme')).toBe('paper')
    expect(s.status()).toContain('1 unsaved change')
  })

  it('remembers what was saved on this device across a reload', async () => {
    const storage: Record<string, Backend> = { [PER + 'Session']: memoryBackend(), [PER + 'Device']: memoryBackend(), [PER + 'Database']: memoryBackend() }
    const a = await mountRemembering(storage)
    const s = open(a)
    s.type('set-name', 'Augusta Ada King')
    s.click(s.sw('set-public'))
    s.click(s.save())
    s.type('set-bio', 'Not saved.') // a draft that is not saved is not remembered
    await a.persistence.flush()
    expect(await storage[PER + 'Device']!.get('semblance:' + UI + 'rememberExampleSettings')).toBeTruthy()

    const b = await mountRemembering(storage)
    const t = open(b)
    expect(t.input('set-name').value).toBe('Augusta Ada King')
    expect(t.input('set-bio').value).toBe('Writes about analytical engines and the poetry of numbers.')
    expect(t.sw('set-public').getAttribute('aria-checked')).toBe('false')
    expect(t.value('set-draft', 'publicProfile')).toEqual(['false'])
    expect(t.status()).toContain('All changes saved')
  })

  it('renders the same with SPARQL and function rules, and a keystroke costs a few rules', () => {
    const [x, y] = (['sparql', 'function'] as const).map((prefer) => open(mountSite('oxigraph', prefer)))
    const html = (s: typeof x) => s.root('ex-settings').outerHTML
    expect(html(x!)).toBe(html(y!))
    for (const s of [x!, y!]) {
      s.type('set-name', 'Ada K')
      s.click(s.sw('set-mentions'))
    }
    expect(html(x!)).toBe(html(y!))
    expect(x!.status()).toContain('2 unsaved changes')

    const measure = (s: typeof x, act: () => void) => {
      const e = s.screen.engine.stats
      const before = { runs: e.ruleRuns, written: e.derivedAdded + e.derivedRemoved, dom: s.shell.ops }
      const byRule = new Map([...e.byRule].map(([r, v]) => [r, v.runs]))
      act()
      const rules = [...e.byRule].filter(([r, v]) => v.runs !== (byRule.get(r) ?? 0)).map(([r, v]) => `${r.replace(/^.*[#/]/, '')}×${v.runs - (byRule.get(r) ?? 0)}`)
      return { ruleRuns: e.ruleRuns - before.runs, written: e.derivedAdded + e.derivedRemoved - before.written, domOps: s.shell.ops - before.dom, rules }
    }
    for (const s of [x!, y!]) {
      const keystroke = measure(s, () => s.type('set-name', 'Ada Ki'))
      const save = measure(s, () => s.click(s.save()))
      console.log(`settings cost (${s === x ? 'sparql' : 'function'}): keystroke`, keystroke, 'save', save)
      // Bounded by the controls on the draft (under SPARQL each re-runs and finds its output unchanged), not by the page.
      expect(keystroke.ruleRuns).toBeLessThanOrEqual(16)
      expect(keystroke.domOps).toBeLessThanOrEqual(2)
    }
  })
})
