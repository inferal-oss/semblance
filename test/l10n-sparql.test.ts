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

  // #52: a regional viewer (en-US) reads a text tagged with its language (en), and a component
  // whose labels are all tagged still renders, on both rule kinds.
  const tagged = `
    @prefix c: <${NS.c}> . @prefix x: <${X}> .
    x:t-heading a c:Heading ; c:label "Welcome"@en , "Ласкаво просимо"@uk , "Willkommen"@de , "أهلاً"@ar .
    x:t-button a c:Button ; c:label "Save"@en , "Зберегти"@uk , "Speichern"@de , "حفظ"@ar .
    x:t-text a c:Text ; c:label "Hello"@en , "Привіт"@uk , "Hallo"@de , "مرحبا"@ar .
    x:t-field a c:TextField ; c:label "Name"@en , "Ім'я"@uk , "Name"@de , "الاسم"@ar ;
      c:placeholder "Ada"@en , "Олена"@uk , "Erika"@de , "ليلى"@ar .
  `
  const expected: Record<string, string[]> = {
    'en-US': ['Welcome', 'Save', 'Hello', 'Ada'],
    'uk-UA': ['Ласкаво просимо', 'Зберегти', 'Привіт', 'Олена'],
    'de-AT': ['Willkommen', 'Speichern', 'Hallo', 'Erika'],
    'ar-EG': ['أهلاً', 'حفظ', 'مرحبا', 'ليلى'],
  }
  for (const [viewer, words] of Object.entries(expected)) {
    it(`a ${viewer} viewer reads the ${viewer.slice(0, 2)} texts of all-tagged components`, () => {
      const html = (['sparql', 'function'] as const).map((prefer) => {
        const { screen } = setup('oxigraph', { modality: MOD.Screen, layers: SCREEN_LAYERS, prefer, languages: [viewer] }, 1, [tagged])
        return ['t-heading', 't-button', 't-text', 't-field'].map((p) => toHTML(screen.index, X + p))
      })
      expect(html[0]).toEqual(html[1])
      html[0]!.forEach((h, i) => expect(h, `${viewer}: ${words[i]}`).toContain(words[i]!))
    })
  }
})
