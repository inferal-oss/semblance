import { describe, expect, it } from 'vitest'
import type { Rule } from '../src/engine/rules.ts'
import { MOD, NS } from '../src/ns.ts'
import { toHTML } from '../src/render/serialize.ts'
import { setup, SCREEN_LAYERS } from './helpers.ts'

// Lists in the viewer's collation (#7): on Semblance's engines the SPARQL rules place their rows
// by an order key from sx:sortKey (case folded, accents stripped), as the function twins do, and
// render byte for byte the same in every language, after every step.
const X = 'https://example.org/collation#'
const KEY = 'https://semblance.dev/ns/keyboard#'
const graph = `
  @prefix c: <${NS.c}> . @prefix x: <${X}> . @prefix key: <${KEY}> .
  x:list a c:ShortcutList .
  x:save a c:Button ; c:label "Save" , "Зберегти"@uk , "Speichern"@de , "حفظ"@ar ; key:shortcut "Mod+S" .
  x:open a c:Button ; c:label "Open" , "Відкрити"@uk , "Öffnen"@de , "فتح"@ar ; key:shortcut "mod + o" .
  x:undo a c:Button ; c:label "Undo" , "Скасувати"@uk , "Rückgängig"@de , "تراجع"@ar ; key:shortcut "Shift+Mod+z" .
  x:edit a c:Button ; c:label "édit" ; key:shortcut "Alt+e" .
  x:help a c:Button ; key:shortcut "F1" .
`
const parts = ['list']
const LANGUAGES = [[], ['en'], ['de'], ['uk'], ['ar']]
const SLOTS = ['ShortcutListRendering']

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
      m.screen.engine.reconfigure({ languages: ['de'] })
      m.text.engine.reconfigure({ languages: ['de'] })
    })
  })
})
