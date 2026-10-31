import { describe, expect, it } from 'vitest'
import type { Rule } from '../src/engine/rules.ts'
import { MOD, NS } from '../src/ns.ts'
import { toHTML } from '../src/render/serialize.ts'
import { setup, SCREEN_LAYERS } from './helpers.ts'

// Numbers in the viewer's locale (#7): on Semblance's engines the SPARQL rules write them with
// sx:formatNumber in the viewer's l10n:formatLocale, and render byte for byte what the function
// twins render, in every language, after every step.
const X = 'https://example.org/locale#'
const graph = `
  @prefix c: <${NS.c}> . @prefix x: <${X}> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
  x:eur a c:Money ; c:value "1249.00"^^xsd:decimal ; c:currency "EUR" .
  x:uah a c:Money ; c:value "-37.5"^^xsd:decimal ; c:currency "UAH" .
  x:plain a c:Money ; c:value "1234567.891"^^xsd:decimal .
  x:bad a c:Money ; c:value "3"^^xsd:decimal ; c:currency "EURO" .
`
const parts = ['eur', 'uah', 'plain', 'bad']
const LANGUAGES = [[], ['en'], ['de'], ['uk'], ['ar'], ['de-AT'], ['xx', 'uk']]
// The slots whose SPARQL rule needs sx:Locale: on wat that rule is the one chosen.
const SLOTS = ['MoneyTexts', 'FileItemTexts']

function mount(prefer: 'sparql' | 'function', languages: string[]) {
  const { store, runtime, screen } = setup('wat', { modality: MOD.Screen, layers: SCREEN_LAYERS, prefer, languages }, 1, [graph])
  const text = runtime.project({ modality: MOD.Text, prefer, languages, name: 'text' })
  const html = () => parts.map((p) => toHTML(screen.index, X + p) + '\n' + toHTML(text.index, X + p))
  return { store, runtime, screen, text, html }
}

describe('numbers in the viewer locale, SPARQL (sx:formatNumber) and function rules alike', () => {
  it('chooses the SPARQL rules on wat', () => {
    const { screen } = mount('sparql', ['de'])
    const rules = (screen.engine as unknown as { rules: Rule[] }).rules
    for (const slot of SLOTS) expect(rules.find((r) => r.slot === NS.c + slot)?.kind, slot).toBe('sparql')
  })

  for (const languages of LANGUAGES) {
    it(`renders the same (${languages.join(', ') || 'no preference'})`, () => {
      const [a, b] = (['sparql', 'function'] as const).map((prefer) => mount(prefer, languages).html())
      expect(a).toEqual(b)
      expect(a!.every((h) => h.includes('</'))).toBe(true)
    })
  }

  it('writes amounts as the locale does', () => {
    const de = mount('sparql', ['de']).html()
    expect(de[0]).toContain('1.249,00 €')
    expect(mount('sparql', ['uk']).html()[1]).toContain('₴')
    // A currency Intl does not know: the code and the plain amount.
    expect(de[3]).toContain('EURO 3')
  })

  it('stays the same as values and the language change', () => {
    const mounts = (['sparql', 'function'] as const).map((prefer) => mount(prefer, ['en']))
    const step = (change: (m: (typeof mounts)[number]) => void) => {
      for (const m of mounts) {
        change(m)
      }
      expect(mounts[0]!.html()).toEqual(mounts[1]!.html())
    }
    step((m) => {
      const f = m.store.factory
      const s = f.namedNode(X + 'eur')
      const p = f.namedNode(NS.c + 'value')
      m.runtime.apply({ remove: m.store.match(s, p, null), add: [f.quad(s, p, f.literal('98765.4', f.namedNode(NS.xsd + 'decimal')))] })
    })
    step((m) => {
      const f = m.store.factory
      const s = f.namedNode(X + 'plain')
      m.runtime.apply({ remove: [], add: [f.quad(s, f.namedNode(NS.c + 'currency'), f.literal('USD'))] })
    })
    step((m) => {
      m.screen.engine.reconfigure({ languages: ['ar'] })
      m.text.engine.reconfigure({ languages: ['ar'] })
    })
    expect(mounts[0]!.html()[0]).toContain('\u200f98,765.40')
  })
})
