// The form-from-a-shape example (demo/gallery/_ex-shapes.ttl) and its components (c:ShapeForm,
// c:ShapeField), driven only through events.
import { describe, expect, it } from 'vitest'
import { mountSite } from './harness.ts'
import { implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const PF = 'https://semblance.dev/demo/profile#'
const XSD = 'http://www.w3.org/2001/XMLSchema#'

type Shell = ReturnType<typeof mountSite>

function open(h: Shell) {
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const button = (text: string) => [...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === text && visible(b))!
  const fire = (el: Element, type: string) => {
    h.fire(el, type)
    h.shell.flush()
  }
  fire(button('Examples'), 'click')
  fire([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === 'A form from a shape' && visible(b))!, 'click')
  const form = () => h.shell.nodeOf(UI + 'ex-shapes-form/~root') as HTMLElement
  const field = (local: string) => h.shell.nodeOf(`${UI}ex-shapes-form/~f-${local}/~root`) as HTMLElement | undefined
  const control = (local: string) => field(local)!.querySelector('input, select, textarea') as HTMLInputElement
  const error = (local: string) => field(local)?.querySelector('[role=alert]')?.textContent
  const fields = () => [...form().querySelectorAll('[data-sem-c=shape-field] label')].map((l) => l.textContent)
  const sections = () => [...form().querySelectorAll('legend')].map((l) => l.textContent)
  const type = (local: string, text: string) => {
    const el = control(local)
    el.value = text
    fire(el, 'input')
  }
  const f = h.store.factory
  const value = (p: string) => h.store.match(f.namedNode(PF + 'ada'), f.namedNode(PF + p), null).map((q) => q.object)
  return { ...h, button, fire, form, field, control, error, fields, sections, type, value }
}

describe('a form derived from a SHACL shape', () => {
  it.each(['sparql', 'function'] as const)('has a section per group and a field per property shape, each as its shape says (%s)', (prefer) => {
    const s = open(mountSite('oxigraph', prefer))
    expect(s.sections()).toEqual(['Identity', 'Work', 'Preferences'])
    expect(s.fields()).toEqual(['Full name', 'Email', 'Born', 'Role', 'Years of experience', 'Bio', 'Monthly newsletter'])
    const kind = (local: string) => {
      const c = s.control(local)
      return c.localName + (c.getAttribute('type') ? ':' + c.getAttribute('type') : '')
    }
    expect(['name', 'email', 'born', 'role', 'experience', 'bio', 'newsletter'].map(kind)).toEqual(['input:text', 'input:text', 'input:date', 'select', 'input:number', 'textarea', 'input:checkbox'])
    // Values from the record; bounds and choices from the shape.
    expect(s.control('name').getAttribute('value')).toBe('Ada Lovelace')
    expect([s.control('experience').getAttribute('min'), s.control('experience').getAttribute('max'), s.control('experience').getAttribute('step')]).toEqual(['0', '60', '1'])
    expect([...s.control('role').querySelectorAll('option')].map((o) => [o.textContent, o.hasAttribute('selected')])).toEqual([
      ['Engineer', true],
      ['Designer', false],
      ['Researcher', false],
    ])
    expect(s.control('newsletter').hasAttribute('checked')).toBe(true)
    expect(s.field('bio')!.querySelector('.sem-help')!.textContent).toBe('Up to 200 characters, shown on your profile.')
    // Labels belong to their controls.
    expect(s.field('name')!.querySelector('label')!.getAttribute('for')).toBe(s.control('name').id)
  })

  it.each(['sparql', 'function'] as const)('writes what is typed onto the record as the datatype says, and judges it by the shape (%s)', (prefer) => {
    const s = open(mountSite('oxigraph', prefer))
    s.type('experience', '14')
    expect(s.value('experience').map((t) => [t.value, t.termType === 'Literal' && t.datatype.value])).toEqual([['14', XSD + 'integer']])
    s.type('experience', '75')
    expect(s.error('experience')).toBe('At most 60.')
    expect(s.control('experience').getAttribute('aria-invalid')).toBe('true')
    s.type('email', 'not an address')
    expect(s.error('email')).toBe('An email address, like ada@example.org.') // the shape's own sh:message
    expect(s.control('email').getAttribute('aria-describedby')).toBe(s.field('email')!.querySelector('[role=alert]')!.id)
    s.type('name', '')
    expect(s.value('name')).toEqual([])
    expect(s.error('name')).toBe('Required.')
    s.type('name', 'Ada')
    expect(s.error('name')).toBeUndefined()
    // A list and a check box are changes.
    const role = s.control('role') as unknown as HTMLSelectElement
    Object.defineProperty(role, 'value', { value: PF + 'Researcher', configurable: true })
    s.fire(role, 'change')
    expect(s.value('role').map((t) => t.value)).toEqual([PF + 'Researcher'])
    const box = s.control('newsletter')
    box.checked = false
    s.fire(box, 'change')
    expect(s.value('newsletter').map((t) => t.value)).toEqual(['false'])
    expect(s.control('newsletter').hasAttribute('checked')).toBe(false)
  })

  it.each(['sparql', 'function'] as const)('changes when the shape changes (%s)', (prefer) => {
    const s = open(mountSite('oxigraph', prefer))
    s.fire(s.button('Add or remove a phone number'), 'click')
    expect(s.fields()).toEqual(['Full name', 'Email', 'Born', 'Phone', 'Role', 'Years of experience', 'Bio', 'Monthly newsletter'])
    s.fire(s.button('Experience: a number or text'), 'click')
    expect(s.control('experience').getAttribute('type')).toBe('text')
    expect(s.control('experience').hasAttribute('min')).toBe(false)
    s.fire(s.button('Bio: required or optional'), 'click')
    s.type('bio', '')
    expect(s.error('bio')).toBe('Required.')
    s.fire(s.button('Add or remove a phone number'), 'click')
    expect(s.fields()).not.toContain('Phone')
  })

  it('renders the same with SPARQL rules and reactions as with functions', () => {
    expect(implementationGaps(['components/forms.ttl'])).toEqual({ noSparql: [], noFunction: [] })
    const [a, b] = (['sparql', 'function'] as const).map((prefer) => {
      const s = open(mountSite('oxigraph', prefer))
      const html = [s.form().outerHTML]
      s.type('experience', 'seventy')
      s.type('email', 'x@y')
      s.fire(s.button('Add or remove a phone number'), 'click')
      s.type('phone', '12')
      html.push(s.form().outerHTML)
      return html
    })
    a!.forEach((html, i) => expect(html, `state ${i}`).toBe(b![i]))
  })

  it('re-renders only the field typed in: the form is derived once from the shape', () => {
    const s = open(mountSite('oxigraph', 'function'))
    const runs = (name: string) => [...s.screen.engine.stats.byRule].filter(([k]) => k.includes(name)).reduce((n, [, v]) => n + v.runs, 0)
    const before = { form: runs('ShapeFormRendering'), field: runs('ShapeFieldRendering') }
    s.type('name', 'Ada K.')
    s.type('name', 'Ada King')
    expect(runs('ShapeFormRendering') - before.form).toBe(0)
    expect(runs('ShapeFieldRendering') - before.field).toBe(2)
    // A datatype changed: one field again, not the form.
    s.fire(s.button('Experience: a number or text'), 'click')
    expect(runs('ShapeFormRendering') - before.form).toBe(0)
    expect(runs('ShapeFieldRendering') - before.field).toBe(3)
    // A property added to the node shape: the form, and the new field.
    s.fire(s.button('Add or remove a phone number'), 'click')
    expect(runs('ShapeFormRendering') - before.form).toBe(1)
  })
})
