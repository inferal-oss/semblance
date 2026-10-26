import { describe, expect, it } from 'vitest'
import { MOD, NS } from '../src/ns.ts'
import { toHTML } from '../src/render/serialize.ts'
import { setup, SCREEN_LAYERS } from './helpers.ts'

// Labels that are only translations (no untagged source text): SPARQL rules pick one in the
// viewer's language, then English, then any, as util.text does for the function rules - with
// the viewer's languages read from the graph (l10n:Viewer, l10n:prefers).
const X = 'https://example.org/l10n#'
const graph = `
  @prefix c: <${NS.c}> . @prefix x: <${X}> .
  x:heading a c:Heading ; c:label "Willkommen"@de , "Welcome"@en , "Ласкаво просимо"@uk .
  x:only a c:Heading ; c:label "Nur Deutsch"@de .
  x:button a c:Button ; c:label "Speichern"@de , "Save"@en .
  x:field a c:TextField ; c:label "Name"@en , "Ім'я"@uk .
  x:badge a c:Badge ; c:label "Neu"@de , "New"@en-GB .
`
const parts = ['heading', 'only', 'button', 'field', 'badge']

describe('labels in the viewer language, SPARQL and function rules alike', () => {
  for (const languages of [[], ['de'], ['uk'], ['uk', 'de'], ['en']]) {
    it(`renders translated-only labels the same (${languages.join(', ') || 'no preference'})`, () => {
      const html = (['sparql', 'function'] as const).map((prefer) => {
        const { screen, runtime } = setup('oxigraph', { modality: MOD.Screen, layers: SCREEN_LAYERS, prefer, languages }, 1, [graph])
        const text = runtime.project({ modality: MOD.Text, prefer, languages, name: 'text' })
        return parts.map((p) => toHTML(screen.index, X + p) + '\n' + toHTML(text.index, X + p))
      })
      expect(html[0]).toEqual(html[1])
      expect(html[0]!.every((h) => h.includes('</'))).toBe(true)
    })
  }

  it('re-picks when the viewer changes language', () => {
    const html = (['sparql', 'function'] as const).map((prefer) => {
      const { screen } = setup('oxigraph', { modality: MOD.Screen, layers: SCREEN_LAYERS, prefer, languages: ['de'] }, 1, [graph])
      screen.engine.reconfigure({ languages: ['uk'] })
      return parts.map((p) => toHTML(screen.index, X + p))
    })
    expect(html[0]).toEqual(html[1])
    expect(html[0]![0]).toContain('Ласкаво просимо')
  })
})
