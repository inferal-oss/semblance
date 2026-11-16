import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { setup } from './helpers.ts'

// #259: the localization layers that put a component's texts under it (<focus>/~l10n-...) for
// its SPARQL rules (c:ChoiceTexts, c:SegmentedTexts, c:ChipsTexts, c:LinkTexts) write them only
// while the viewer has a language preference, on both rule kinds, whichever way the language
// changes. The function twins used to return early on no language without recording a read of
// it, so a language set later never re-ran them.
const X = 'https://example.org/l10n-texts#'
const graph = `
  @prefix c: <${NS.c}> . @prefix x: <${X}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  x:plan a rdfs:Class ; rdfs:label "Plan"@en , "План"@uk .
  x:tier rdfs:range x:plan ; rdfs:label "Tier"@en , "Рівень"@uk .
  x:basic a x:plan ; rdfs:label "Basic"@en , "Базовий"@uk .
  x:pro a x:plan ; rdfs:label "Pro"@en , "Профі"@uk .
  x:account x:tier x:basic .
  x:choice a c:Choice ; c:controls x:account ; c:property x:tier .
  x:segmented a c:Segmented ; c:controls x:account ; c:property x:tier .
  x:chips a c:Chips ; c:controls x:account ; c:property x:tier ; c:options ( x:basic x:pro ) .
  x:link a c:Link ; c:label "Docs" ; c:href "https://example.org/" ; c:countLabel "pages"@en , "сторінок"@uk .
`
const L10N_LABEL = NS.l10n + 'label'

for (const store of ['wat', 'oxigraph'] as const) {
  describe(`texts for SPARQL rules across a language change (${store})`, () => {
    for (const steps of [
      [[], ['uk'], []],
      [['uk'], [], ['uk']],
      [['en'], ['uk'], ['de']],
    ]) {
      it(`derives the same texts, ${steps.map((s) => s.join(',') || 'none').join(' → ')}`, () => {
        const texts = (['sparql', 'function'] as const).map((prefer) => {
          const { store: graphStore, screen } = setup(store, { prefer, languages: steps[0] }, 1, [graph])
          const seen: string[][] = []
          const read = () =>
            graphStore
              .match(null, graphStore.factory.namedNode(L10N_LABEL), null, screen.engine.graph)
              .filter((q) => q.subject.value.startsWith(X) && q.subject.value.includes('/~l10n-'))
              .map((q) => `${q.subject.value.slice(X.length)} ${q.object.value}`)
              .sort()
          seen.push(read())
          for (const languages of steps.slice(1)) {
            screen.engine.reconfigure({ languages })
            seen.push(read())
          }
          return seen
        })
        expect(texts[1]).toEqual(texts[0])
        steps.forEach((languages, i) => {
          if (!languages.length) expect(texts[0]![i], `step ${i}`).toEqual([])
          else expect(texts[0]![i], `step ${i}`).toContain('choice/~l10n-caption ' + (languages[0] === 'uk' ? 'Рівень' : 'Tier'))
        })
      })
    }
  })
}
