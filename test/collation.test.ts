import { describe, expect, it } from 'vitest'
import type { Rule } from '../src/engine/rules.ts'
import { MOD, NS } from '../src/ns.ts'
import { toHTML } from '../src/render/serialize.ts'
import { mountShell } from './harness.ts'
import { setup, SCREEN_LAYERS } from './helpers.ts'

// Lists in the viewer's collation (#7): on Semblance's engines the SPARQL rules place their rows
// by an order key from sx:sortKey (case folded, accents stripped), as the function twins do, and
// render byte for byte the same in every language, after every step.
const X = 'https://example.org/collation#'
const KEY = 'https://semblance.dev/ns/keyboard#'
const graph = `
  @prefix c: <${NS.c}> . @prefix x: <${X}> . @prefix key: <${KEY}> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix sem: <https://semblance.dev/ns/core#> .
  x:list a c:ShortcutList .
  x:save a c:Button ; c:label "Save" , "Зберегти"@uk , "Speichern"@de , "حفظ"@ar ; key:shortcut "Mod+S" .
  x:open a c:Button ; c:label "Open" , "Відкрити"@uk , "Öffnen"@de , "فتح"@ar ; key:shortcut "mod + o" .
  x:undo a c:Button ; c:label "Undo" , "Скасувати"@uk , "Rückgängig"@de , "تراجع"@ar ; key:shortcut "Shift+Mod+z" .
  x:edit a c:Button ; c:label "édit" ; key:shortcut "Alt+e" .
  x:help a c:Button ; key:shortcut "F1" .
  x:coffee x:origin "Ethiopia" ; x:weight 1234.5 ; x:notes "Jasmine" , "Bergamot" , "Lemon"@en ; x:roaster x:acme .
  x:acme rdfs:label "Acme" , "Акме"@uk .
  x:origin rdfs:label "Origin" , "Походження"@uk . x:weight rdfs:label "Weight" ; c:unit "g" . x:notes rdfs:label "Notes" .
  x:fields a c:DescriptionList ; c:of x:coffee ; c:fields ( x:origin x:weight x:missing x:notes x:roaster ) .
  x:items a c:DescriptionList ; c:items ( x:i1 x:i2 x:i3 ) .
  x:i1 c:label "Status" , "Стан"@uk ; c:value "open" .
  x:i2 c:label "Body" ; c:content x:body .
  x:i3 c:label "Summary" ; c:value 42 ; c:content x:body2 .
  x:body a c:Text ; c:label "A body." . x:body2 a c:Text ; c:label "Another body." .
  x:exchange x:header x:h1 , x:h2 , x:h3 , x:h4 .
  x:h1 x:name "Content-Type" ; x:value "text/html" ; sem:order 2 .
  x:h2 x:name "Accept" ; x:value "*/*" ; sem:order 1 .
  x:h3 x:name "éTag" ; x:value "abc" .
  x:h4 x:name "date" ; x:value "today" .
  x:entries a c:DescriptionList ; c:of x:exchange ; c:entryProperty x:header ; c:keyProperty x:name ; c:valueProperty x:value .
  x:nothing a c:DescriptionList ; c:of x:coffee ; c:fields ( x:missing ) ; c:emptyText "Nothing here." , "Тут нічого."@uk .
`
const parts = ['list', 'fields', 'items', 'entries', 'nothing']
const LANGUAGES = [[], ['en'], ['de'], ['uk'], ['ar']]
const SLOTS = ['ShortcutListRendering', 'ShapeReportRendering', 'DescriptionPairs']

function mount(prefer: 'sparql' | 'function', languages: string[]) {
  const { store, runtime, screen } = setup('wat', { modality: MOD.Screen, layers: SCREEN_LAYERS, prefer, languages }, 1, [graph])
  const text = runtime.project({ modality: MOD.Text, prefer, languages, name: 'text' })
  const html = () => parts.map((p) => toHTML(screen.index, X + p) + '\n' + toHTML(text.index, X + p))
  return { store, runtime, screen, text, html }
}

describe('lists in the viewer collation, SPARQL (sx:sortKey) and function rules alike', () => {
  it('chooses the SPARQL rules on wat', () => {
    const { screen } = mount('sparql', ['de'])
    const rules = (screen.engine as unknown as { rules: Rule[] }).rules
    for (const slot of SLOTS) expect(rules.find((r) => r.slot === NS.c + slot)?.kind, slot).toBe('sparql')
  })

  for (const languages of LANGUAGES) {
    it(`renders the same (${languages.join(', ') || 'no preference'})`, () => {
      const [a, b] = (['sparql', 'function'] as const).map((prefer) => mount(prefer, languages).html())
      expect(a).toEqual(b)
    })
  }

  it('lists shortcuts in collation order, accents and case folded', () => {
    const [screen] = mount('sparql', ['en']).html()
    const order = ['édit', 'help', 'Open', 'Save', 'Undo'].map((label) => screen!.indexOf(`<dt>${label}</dt>`))
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true)
    expect(screen).toContain('<kbd class="sem-apple">⌘⇧Z</kbd><kbd class="sem-other">Ctrl+Shift+Z</kbd>')
  })

  it('describes fields, items and entries', () => {
    const [, fields, items, entries, nothing] = mount('sparql', ['en']).html()
    expect(fields).toContain('<dt>Weight</dt><dd>1,234.5 g</dd>')
    expect(fields).not.toContain('missing')
    expect(fields!.match(/<dt>Notes<\/dt><dd>([^<]*)<\/dd>/)![1]!.split(', ').sort()).toEqual(['Bergamot', 'Jasmine', 'Lemon'])
    expect(fields).toContain('<dt>roaster</dt><dd>Acme</dd>')
    expect(items).toContain('<dt>Status</dt><dd>open</dd>')
    expect(items).toContain('A body.')
    expect(items).toContain('Summary  42')
    expect(entries!.indexOf('Accept')).toBeLessThan(entries!.indexOf('Content-Type'))
    expect(entries!.indexOf('Content-Type')).toBeLessThan(entries!.indexOf('date'))
    expect(entries!.indexOf('date')).toBeLessThan(entries!.indexOf('éTag'))
    expect(nothing).toContain('Nothing here.')
  })

  it('stays the same as shortcuts and labels change anywhere in the graph', () => {
    const mounts = (['sparql', 'function'] as const).map((prefer) => mount(prefer, ['uk']))
    const step = (change: (m: (typeof mounts)[number]) => void) => {
      for (const m of mounts) change(m)
      expect(mounts[0]!.html()).toEqual(mounts[1]!.html())
    }
    step((m) => {
      const f = m.store.factory
      m.runtime.apply({ remove: [], add: [f.quad(f.namedNode(X + 'find'), f.namedNode(KEY + 'shortcut'), f.literal('Mod+F')), f.quad(f.namedNode(X + 'find'), f.namedNode(NS.c + 'label'), f.literal('Знайти'))] })
    })
    expect(mounts[0]!.html()[0]).toContain('Знайти')
    step((m) => {
      const f = m.store.factory
      m.runtime.apply({ remove: m.store.match(f.namedNode(X + 'open'), f.namedNode(KEY + 'shortcut'), null), add: [] })
    })
    expect(mounts[0]!.html()[0]).not.toContain('Відкрити')
    step((m) => {
      const f = m.store.factory
      const coffee = f.namedNode(X + 'coffee')
      m.runtime.apply({ remove: m.store.match(coffee, f.namedNode(X + 'weight'), null), add: [f.quad(coffee, f.namedNode(X + 'weight'), f.literal('250')), f.quad(coffee, f.namedNode(X + 'notes'), f.literal('Cocoa'))] })
    })
    expect(mounts[0]!.html()[1]).toContain('Cocoa')
    step((m) => {
      m.screen.engine.reconfigure({ languages: ['de'] })
      m.text.engine.reconfigure({ languages: ['de'] })
    })
  })
})

describe('the Layers gallery group (shortcuts, shape results), on wat', () => {
  const UI = 'https://semblance.dev/demo#'
  it('renders the same with SPARQL and with function rules, as a result goes away and the language changes', { timeout: 300_000 }, () => {
    const shells = (['sparql', 'function'] as const).map((prefer) => {
      const h = mountShell(5, 'wat', prefer)
      const f = h.store.factory
      const app = f.namedNode(UI + 'app')
      const group = f.namedNode(UI + 'galleryGroup')
      h.showPage('Components')
      h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupLayers'))] })
      h.shell.flush()
      return h
    })
    const html = (id: string) => shells.map((h) => (h.shell.nodeOf(`${UI}${id}/~root`) as Element).outerHTML)
    const same = () => {
      for (const id of ['shapeReport', 'shortcuts']) {
        const [a, b] = html(id)
        expect(a, id).toBe(b)
      }
    }
    same()
    expect(html('shapeReport')[0]!.match(/<li/g)).toHaveLength(3)
    for (const h of shells) {
      const f = h.store.factory
      h.runtime.apply({ remove: h.store.match(f.namedNode(UI + 'badBadge'), f.namedNode('https://semblance.dev/ns/style#tone'), null), add: [] })
      h.shell.flush()
    }
    same()
    expect(html('shapeReport')[0]!.match(/<li/g)).toHaveLength(2)
    for (const h of shells) h.screen.engine.reconfigure({ languages: ['uk'] }), h.shell.flush()
    same()
  })
})

describe('a specimen ontology section (the docs layer), on wat', () => {
  const UI = 'https://semblance.dev/demo#'
  it('renders the same with SPARQL and with function rules, closed, opened and in another language', { timeout: 300_000 }, () => {
    const shells = (['sparql', 'function'] as const).map((prefer) => {
      const h = mountShell(5, 'wat', prefer)
      const f = h.store.factory
      const app = f.namedNode(UI + 'app')
      const group = f.namedNode(UI + 'galleryGroup')
      h.showPage('Components')
      h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupFeedback'))] })
      h.shell.flush()
      return h
    })
    const spec = (h: (typeof shells)[number]) => h.shell.nodeOf(`${UI}fb-alerts-spec/~root`) as Element
    const same = () => {
      const [a, b] = shells.map((h) => h.document.getElementById('app')!.innerHTML)
      if (a !== b) {
        let i = 0
        while (i < a!.length && a![i] === b![i]) i++
        expect(a!.slice(Math.max(0, i - 300), i + 300)).toBe(b!.slice(Math.max(0, i - 300), i + 300))
      }
    }
    const rules = (shells[0]!.screen.engine as unknown as { rules: Rule[] }).rules
    expect(rules.find((r) => r.slot === NS.sem + 'SpecimenOntology')?.kind).toBe('sparql')
    same()
    expect(spec(shells[0]!).querySelector('.sem-docs-toggle')!.textContent).toContain('c:Alert')
    for (const h of shells) h.fire(spec(h).querySelector('.sem-docs-toggle')!, 'click'), h.shell.flush()
    same()
    expect(spec(shells[0]!).querySelector('[data-sem-c=class-doc]')).not.toBeNull()
    for (const h of shells) h.screen.engine.reconfigure({ languages: ['de'] }), h.shell.flush()
    same()
  })
})
