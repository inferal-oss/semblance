// Typeaheads (ontology/components/typeahead.ttl): the combobox and the tag input of the Inputs
// gallery page, driven through DOM events as a person would, on Oxigraph and on Semblance's own
// WASM engine (SPARQL rules and reactions either way).
import { describe, expect, it } from 'vitest'
import { fold } from '../src/components/typeahead.ts'
import { MOD, NS } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

function inputs(kind: 'oxigraph' | 'wat' = 'oxigraph') {
  const h = mountShell(5, kind, 'sparql')
  h.showPage('Components')
  const { store, runtime } = h
  const f = store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  runtime.apply({ remove: store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupInputs'))] })
  h.shell.flush()
  const root = (id: string) => h.shell.nodeOf(`${UI}${id}/~root`) as HTMLElement
  const input = (id: string) => root(id).querySelector('.sem-ta-field > input') as HTMLInputElement
  const type = (id: string, text: string) => {
    const field = input(id)
    field.value = text
    Object.assign(field, { selectionStart: text.length, selectionEnd: text.length })
    h.fire(field, 'input')
    h.shell.flush()
  }
  /** A key press in the field; returns whether something handled it (its default was prevented). */
  const press = (id: string, key: string) => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as KeyboardEvent
    Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
    input(id).dispatchEvent(e)
    h.shell.flush()
    return e.defaultPrevented
  }
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  const leave = (id: string) => (h.fire(input(id), 'focusout'), h.shell.flush())
  const popup = (id: string) => root(id).querySelector('.sem-ta-popup') as HTMLElement
  /** The rows the list shows (labels, the highlighted one starred), and its status line. */
  const shown = (id: string) =>
    [...popup(id).querySelectorAll('.sem-ta-list > li:not([hidden])')].map((li) => (li.getAttribute('aria-selected') === 'true' ? '*' : '') + li.textContent)
  const status = (id: string) => popup(id).querySelector('.sem-ta-status')?.textContent
  const marks = (id: string) => [...popup(id).querySelectorAll('.sem-ta-list > li:not([hidden]) mark')].map((m) => m.textContent)
  const values = (p: string, node = 'inputsDemo') => store.match(f.namedNode(UI + node), f.namedNode(UI + p), null).map((q) => q.object.value.replace(UI, ''))
  const state = (id: string, p: string) => store.match(f.namedNode(UI + id), f.namedNode(NS.c + p), null).map((q) => q.object.value.replace(UI, ''))
  const pills = (id: string) => [...root(id).querySelectorAll('.sem-ta-pills [data-sem-c=tag]')].map((t) => t.firstChild!.textContent)
  return { ...h, root, input, type, press, click, leave, popup, shown, status, marks, values, state, pills }
}

describe('fold', () => {
  it('drops case and diacritics, one character for each', () => {
    expect(fold('Curaçao')).toBe('curacao')
    expect(fold('São Tomé and Príncipe')).toBe('sao tome and principe')
    expect(fold('Åland')).toBe('aland')
    expect(fold('Straße')).toBe('straße')
    for (const s of ['Curaçao', 'İstanbul', 'ǅemal', 'Ελλάδα', '🙂 Smile']) expect([...fold(s)].length).toBe([...s].length)
  })
})

describe.each(['oxigraph', 'wat'] as const)('combobox (%s)', (kind) => {
  it('is a WAI-ARIA combobox over a listbox, showing the chosen option', () => {
    const { root, input, popup } = inputs(kind)
    const box = root('inp-combo-country')
    expect(box.getAttribute('data-sem-c')).toBe('combobox')
    const field = input('inp-combo-country')
    expect(box.querySelector('label')!.getAttribute('for')).toBe(field.id)
    expect(field.getAttribute('role')).toBe('combobox')
    expect(field.getAttribute('aria-autocomplete')).toBe('list')
    expect(field.getAttribute('aria-expanded')).toBe('false')
    expect(field.getAttribute('autocomplete')).toBe('off')
    const list = box.querySelector('[role=listbox]')!
    expect(field.getAttribute('aria-controls')).toBe(list.id)
    expect(field.getAttribute('aria-describedby')).toBe(box.querySelector('.sem-help')!.id)
    expect(field.value).toBe('Portugal')
    expect(popup('inp-combo-country').hidden).toBe(true)
  })

  it('filters case- and diacritic-insensitively and highlights the match', () => {
    const { type, input, shown, marks, popup } = inputs(kind)
    type('inp-combo-country', 'CURA')
    expect(input('inp-combo-country').getAttribute('aria-expanded')).toBe('true')
    expect(popup('inp-combo-country').hidden).toBe(false)
    expect(shown('inp-combo-country')).toEqual(['Curaçao'])
    expect(marks('inp-combo-country')).toEqual(['Cura'])
    type('inp-combo-country', 'reu')
    expect(shown('inp-combo-country')).toEqual(['Réunion'])
    expect(marks('inp-combo-country')).toEqual(['Réu'])
    type('inp-combo-country', 'tome')
    expect(marks('inp-combo-country')).toEqual(['Tomé'])
    type('inp-combo-country', 'u')
    expect(shown('inp-combo-country')).toEqual(['Austria', 'Curaçao', 'Portugal', 'Réunion', 'Türkiye', 'Ukraine', 'Uruguay'])
    // The chosen option is marked in the list.
    expect(popup('inp-combo-country').querySelector('li[data-chosen]')!.textContent).toBe('Portugal')
  })

  it('moves through the shown options with the arrow keys, wrapping, and picks with Enter', () => {
    const { type, press, input, shown, values, popup } = inputs(kind)
    type('inp-combo-country', 'ur')
    expect(shown('inp-combo-country')).toEqual(['Curaçao', 'Türkiye', 'Uruguay'])
    expect(press('inp-combo-country', 'ArrowDown')).toBe(true)
    expect(shown('inp-combo-country')).toEqual(['*Curaçao', 'Türkiye', 'Uruguay'])
    const field = input('inp-combo-country')
    const active = popup('inp-combo-country').querySelector('[aria-selected=true]')!
    expect(field.getAttribute('aria-activedescendant')).toBe(active.id)
    // The field shows the highlighted option; the list stays filtered by what was typed.
    expect(field.value).toBe('Curaçao')
    press('inp-combo-country', 'ArrowDown')
    press('inp-combo-country', 'ArrowDown')
    expect(shown('inp-combo-country')).toEqual(['Curaçao', 'Türkiye', '*Uruguay'])
    press('inp-combo-country', 'ArrowDown')
    expect(shown('inp-combo-country')).toEqual(['*Curaçao', 'Türkiye', 'Uruguay'])
    press('inp-combo-country', 'ArrowUp')
    expect(shown('inp-combo-country')).toEqual(['Curaçao', 'Türkiye', '*Uruguay'])
    expect(press('inp-combo-country', 'Enter')).toBe(true)
    expect(values('inp-country')).toEqual(['country-uy'])
    expect(field.value).toBe('Uruguay')
    expect(field.getAttribute('aria-expanded')).toBe('false')
    expect(field.hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('opens on Down before anything is typed, from the first option (or Up, the last)', () => {
    const { press, shown, state } = inputs(kind)
    press('inp-combo-country', 'ArrowDown')
    expect(state('inp-combo-country', 'expanded')).toEqual(['true'])
    expect(shown('inp-combo-country')[0]).toBe('*Åland Islands')
    press('inp-combo-country', 'ArrowUp')
    expect(shown('inp-combo-country').at(-1)).toBe('*Uruguay')
  })

  it('gives the typed text back on Escape, and clears it on a second Escape', () => {
    const { type, press, input, popup, state } = inputs(kind)
    type('inp-combo-country', 'ur')
    press('inp-combo-country', 'ArrowDown')
    expect(input('inp-combo-country').value).toBe('Curaçao')
    expect(press('inp-combo-country', 'Escape')).toBe(true)
    expect(input('inp-combo-country').value).toBe('ur')
    expect(popup('inp-combo-country').hidden).toBe(true)
    expect(state('inp-combo-country', 'activeOption')).toEqual([])
    expect(press('inp-combo-country', 'Escape')).toBe(true)
    expect(input('inp-combo-country').value).toBe('Portugal')
    // Nothing left to undo: the key is not used (a dialog around it could close).
    expect(press('inp-combo-country', 'Escape')).toBe(false)
  })

  it('picks the option the text names exactly, or the only one shown, and a clicked one', () => {
    const { type, press, click, values, popup } = inputs(kind)
    type('inp-combo-country', 'czechia')
    press('inp-combo-country', 'Enter')
    expect(values('inp-country')).toEqual(['country-cz'])
    type('inp-combo-country', 'TÜR')
    press('inp-combo-country', 'Enter')
    expect(values('inp-country')).toEqual(['country-tr'])
    type('inp-combo-country', 'a')
    click(popup('inp-combo-country').querySelector('li[role=option]:not([hidden]) mark')!)
    expect(values('inp-country')).toEqual(['country-ax'])
  })

  it('without custom values, says when nothing matches and commits nothing', () => {
    const { type, press, shown, status, values } = inputs(kind)
    type('inp-combo-country', 'Atlantis')
    expect(shown('inp-combo-country')).toEqual([])
    expect(status('inp-combo-country')).toBe('No matches')
    expect(press('inp-combo-country', 'Enter')).toBe(false)
    expect(values('inp-country')).toEqual(['country-pt'])
  })

  it('leaving the field closes the list and gives the chosen label back', () => {
    const { type, leave, input, state } = inputs(kind)
    type('inp-combo-country', 'ur')
    leave('inp-combo-country')
    expect(input('inp-combo-country').value).toBe('Portugal')
    expect(input('inp-combo-country').getAttribute('aria-expanded')).toBe('false')
    expect(state('inp-combo-country', 'value')).toEqual([])
    expect(state('inp-combo-country', 'caret')).toEqual([])
  })

  it('with custom values, creates a resource of the option class, labelled, if the shape allows', () => {
    const { type, press, shown, status, values, store, input, root } = inputs(kind)
    type('inp-combo-team', 'Quality Ops')
    expect(shown('inp-combo-team')).toEqual(['Create “Quality Ops”'])
    press('inp-combo-team', 'ArrowDown')
    expect(shown('inp-combo-team')).toEqual(['*Create “Quality Ops”'])
    // Highlighting the create row leaves the typed text in the field.
    expect(input('inp-combo-team').value).toBe('Quality Ops')
    press('inp-combo-team', 'Enter')
    expect(values('inp-team')).toEqual(['InpTeam/quality-ops'])
    const f = store.factory
    const team = f.namedNode(UI + 'InpTeam/quality-ops')
    expect(store.match(team, f.namedNode(NS.rdf + 'type'), null).map((q) => q.object.value)).toEqual([UI + 'InpTeam'])
    expect(store.match(team, f.namedNode(NS.rdfs + 'label'), null).map((q) => q.object.value)).toEqual(['Quality Ops'])
    expect(input('inp-combo-team').value).toBe('Quality Ops')
    // It is an option now, here and wherever the same class is offered.
    type('inp-combo-team', 'quality')
    expect(shown('inp-combo-team')).toEqual(['Quality Ops', 'Create “quality”'])
    type('inp-combo-team', 'quality ops')
    expect(shown('inp-combo-team')).toEqual(['Quality Ops'])
    // A name the shape refuses cannot be created; the shape's message says why.
    type('inp-combo-team', 'x1')
    expect(shown('inp-combo-team')).toEqual([])
    expect(status('inp-combo-team')).toBe('A team name is 2 to 24 letters.')
    expect(press('inp-combo-team', 'Enter')).toBe(false)
    expect(values('inp-team')).toEqual(['InpTeam/quality-ops'])
    // The text that is typed is not the field's value: it is not marked invalid.
    expect(root('inp-combo-team').querySelector('input')!.hasAttribute('aria-invalid')).toBe(false)
  })

  it('offers no create row for text that names an option', () => {
    const { type, shown } = inputs(kind)
    type('inp-combo-team', 'RESEARCH')
    expect(shown('inp-combo-team')).toEqual(['Research'])
  })

  it('does nothing while disabled', () => {
    const { input, press, root } = inputs(kind)
    expect(input('inp-combo-off').disabled).toBe(true)
    expect(press('inp-combo-off', 'ArrowDown')).toBe(false)
    expect(root('inp-combo-off').querySelector('.sem-ta-popup')!.hasAttribute('hidden')).toBe(true)
  })
})

describe.each(['oxigraph', 'wat'] as const)('tag input (%s)', (kind) => {
  it('shows its values as removable pills before the field', () => {
    const { root, pills, input } = inputs(kind)
    expect(root('inp-tags-labels').getAttribute('data-sem-c')).toBe('tag-input')
    expect(pills('inp-tags-labels')).toEqual(['a11y', 'design'])
    const removes = [...root('inp-tags-labels').querySelectorAll('.sem-ta-pills button.sem-remove')].map((b) => b.getAttribute('aria-label'))
    expect(removes).toEqual(['Remove a11y', 'Remove design'])
    expect(root('inp-tags-labels').querySelector('.sem-ta-pills')!.getAttribute('aria-label')).toBe('Labels')
    expect(input('inp-tags-labels').getAttribute('role')).toBe('combobox')
    // A disabled tag input's pills have no ✕.
    expect(root('inp-tags-off').querySelector('.sem-remove')).toBeNull()
  })

  it('suggests what is not added yet: options of a class, or values in use anywhere', () => {
    const { type, shown, press, values, pills } = inputs(kind)
    type('inp-tags-topics', 's')
    expect(shown('inp-tags-topics')).toEqual(['SPARQL', 'SHACL', 'Interfaces'])
    press('inp-tags-topics', 'ArrowDown')
    press('inp-tags-topics', 'ArrowDown')
    press('inp-tags-topics', 'Enter')
    expect(values('inp-topic').sort()).toEqual(['inp-topic-rdf', 'inp-topic-shacl'])
    expect(pills('inp-tags-topics')).toEqual(['RDF', 'SHACL'])
    type('inp-tags-labels', 'ER')
    expect(shown('inp-tags-labels')).toEqual(['performance', 'überblick'])
  })

  it('refuses a value it has', () => {
    const { type, press, shown, status, values } = inputs(kind)
    type('inp-tags-topics', 'rdf')
    expect(shown('inp-tags-topics')).toEqual([])
    expect(status('inp-tags-topics')).toBe('“rdf” is already added')
    expect(press('inp-tags-topics', 'Enter')).toBe(false)
    type('inp-tags-labels', 'Design')
    expect(status('inp-tags-labels')).toBe('“Design” is already added')
    expect(press('inp-tags-labels', 'Enter')).toBe(false)
    expect(press('inp-tags-labels', ',')).toBe(false)
    expect(values('inp-labels').sort()).toEqual(['a11y', 'design'])
  })

  it('without custom values, adds nothing that is not an option', () => {
    const { type, press, status, values } = inputs(kind)
    type('inp-tags-topics', 'graphs')
    expect(status('inp-tags-topics')).toBe('No matches')
    expect(press('inp-tags-topics', 'Enter')).toBe(false)
    expect(press('inp-tags-topics', ',')).toBe(false)
    expect(values('inp-topic')).toEqual(['inp-topic-rdf'])
  })

  it('creates a literal with Enter or a comma, if the shape allows it', () => {
    const { type, press, shown, status, values, pills, input } = inputs(kind)
    type('inp-tags-labels', 'rust')
    expect(shown('inp-tags-labels')).toEqual(['Create “rust”'])
    expect(press('inp-tags-labels', ',')).toBe(true)
    expect(values('inp-labels').sort()).toEqual(['a11y', 'design', 'rust'])
    expect(pills('inp-tags-labels')).toEqual(['a11y', 'design', 'rust'])
    expect(input('inp-tags-labels').value).toBe('')
    type('inp-tags-labels', 'Not OK')
    expect(status('inp-tags-labels')).toBe('Up to four labels, each a lower-case word (a-z, 0-9, dashes).')
    expect(press('inp-tags-labels', 'Enter')).toBe(false)
    expect(values('inp-labels')).toHaveLength(3)
  })

  it('stops at the shape’s sh:maxCount, saying so', () => {
    const { type, press, values, root, popup, input } = inputs(kind)
    type('inp-tags-labels', 'one')
    press('inp-tags-labels', 'Enter')
    expect(root('inp-tags-labels').querySelector('.sem-ta-note')).toBeNull()
    type('inp-tags-labels', 'two')
    press('inp-tags-labels', 'Enter')
    expect(values('inp-labels')).toHaveLength(4)
    const note = root('inp-tags-labels').querySelector('.sem-ta-note')!
    expect(note.textContent).toBe('Up to four labels, each a lower-case word (a-z, 0-9, dashes).')
    expect(note.getAttribute('role')).toBe('status')
    expect(input('inp-tags-labels').getAttribute('aria-describedby')!.split(' ')).toContain(note.id)
    type('inp-tags-labels', 'three')
    expect(popup('inp-tags-labels').hidden).toBe(true)
    expect(press('inp-tags-labels', 'Enter')).toBe(false)
    type('inp-tags-labels', 'perf')
    expect(press('inp-tags-labels', 'ArrowDown')).toBe(false)
    expect(press('inp-tags-labels', 'Enter')).toBe(false)
    expect(values('inp-labels')).toHaveLength(4)
  })

  it('removes the last pill on Backspace in the empty field, and any pill by its ✕', () => {
    const { type, press, values, pills, root, input, click, store } = inputs(kind)
    type('inp-tags-labels', 'x')
    expect(press('inp-tags-labels', 'Backspace')).toBe(false)
    expect(values('inp-labels')).toHaveLength(2)
    type('inp-tags-labels', '')
    expect(press('inp-tags-labels', 'Backspace')).toBe(true)
    expect(pills('inp-tags-labels')).toEqual(['a11y'])
    click(root('inp-tags-labels').querySelector('.sem-ta-pills button.sem-remove')!)
    expect(values('inp-labels')).toEqual([])
    // The ✕ was the tag input's to handle: no c:Tag was marked removed.
    expect(store.match(null, store.factory.namedNode(NS.c + 'removed'), null).filter((q) => q.subject.value.includes('inp-tags'))).toEqual([])
    expect(pills('inp-tags-labels')).toEqual([])
    // The focus goes back to the field (the event bus places it where data-sem-caret is).
    expect(input('inp-tags-labels').getAttribute('data-sem-caret')).toBe('0')
  })

  it('reads as one line of text', () => {
    const { runtime } = inputs(kind)
    const text = runtime.project({ modality: MOD.Text, name: 'text', roots: [UI + 'inp-tags-col', UI + 'inp-combo-col'] })
    expect(toText(text.index, UI + 'inp-tags-labels')).toBe('Labels: ‹a11y› ‹design› [_]')
    expect(toText(text.index, UI + 'inp-combo-country')).toBe('Country: [Portugal_] ▾')
  })
})

/**
 * What a keystroke costs, in the work counters of test/cost.test.ts. Typing re-runs the options
 * (member-wise, one bulk query) but writes and patches only what changed: options that do not
 * match before or after are left alone, however many there are. Moving the highlight touches
 * the typeahead's own rule only. Neither grows with the rest of the app or its history.
 */
describe('typeahead keystroke cost', () => {
  it('writes and patches only what changed, and moving the highlight is constant', () => {
    const h = inputs()
    const counters = { read: 0, sparqlRows: 0 }
    const { match, construct } = h.store
    h.store.match = (...args) => {
      const quads = match.apply(h.store, args)
      counters.read += quads.length
      return quads
    }
    h.store.construct = (...args) => {
      const quads = construct.apply(h.store, args)
      counters.sparqlRows += quads.length
      return quads
    }
    const snapshot = () => ({
      ruleRuns: h.screen.engine.stats.ruleRuns,
      written: h.screen.engine.stats.derivedAdded + h.screen.engine.stats.derivedRemoved,
      read: counters.read,
      sparqlRows: counters.sparqlRows,
      domOps: h.shell.ops,
    })
    const measure = (act: () => void) => {
      const a = snapshot()
      act()
      const b = snapshot()
      return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v - a[k as keyof typeof a]])) as ReturnType<typeof snapshot>
    }
    let n = 0
    const typing = () => h.type('inp-combo-country', n++ % 2 ? 'cu' : 'cur')
    const moving = () => {
      h.press('inp-combo-country', 'ArrowDown')
      h.press('inp-combo-country', 'ArrowUp')
    }
    const run = () => {
      typing(), typing(), moving(), moving() // warm: the options are rendered once the list is shown
      return { typing: measure(typing), moving: measure(moving) }
    }
    // Beyond the change log's bound, so retiring a member is part of every measurement.
    for (let i = 0; i < 210; i++) h.type('inp-tags-labels', 'x'.repeat((i % 5) + 1))
    const before = run()
    // Two hundred more options that never match.
    const f = h.store.factory
    const more = Array.from({ length: 200 }, (_, i) => f.namedNode(`${UI}country-zz${i}`))
    h.runtime.apply({
      remove: [],
      add: more.flatMap((c, i) => [
        f.quad(c, f.namedNode(NS.rdf + 'type'), f.namedNode(UI + 'InpCountry')),
        f.quad(c, f.namedNode(NS.rdfs + 'label'), f.literal(`Zzland ${i}`)),
      ]),
    })
    // The options follow new instances of their class when the controlled node changes (a pick).
    h.type('inp-combo-country', 'u')
    h.press('inp-combo-country', 'ArrowDown')
    h.press('inp-combo-country', 'Enter')
    expect(h.values('inp-country')).toEqual(['country-at'])
    h.type('inp-combo-country', 'zzland 1')
    h.press('inp-combo-country', 'Escape')
    expect(h.root('inp-combo-country').querySelectorAll('.sem-ta-list > li').length).toBeGreaterThan(200)
    const after = run()
    expect(after.moving).toEqual(before.moving)
    // Two presses: each re-runs the typeahead's rule and what decorates or logs it, not the options.
    expect(after.moving.ruleRuns).toBeLessThanOrEqual(8)
    expect(after.typing.written).toBe(before.typing.written)
    expect(after.typing.domOps).toBe(before.typing.domOps)
    // The options' re-evaluation is one bulk query however many there are.
    expect(after.typing.ruleRuns - before.typing.ruleRuns).toBe(200)
  }, 600_000)
})
