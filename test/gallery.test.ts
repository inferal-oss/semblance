import { readdirSync, readFileSync } from 'node:fs'
import type { Term } from '@rdfjs/types'
import { describe, expect, it } from 'vitest'
import { readLocations, shows } from '../src/navigation.ts'
import { loadStore } from '../src/node/load.ts'
import { NS } from '../src/ns.ts'
import { expectSameRendering } from './implementations.ts'

// The Components page has a page per component group (ui:componentGroup on its ui:GalleryGroup),
// assembled by hand. Each specimen says which classes it demonstrates (c:demonstrates); these
// tests keep it on the page of their group (sem:group, ontology/components/groups.ttl), so a
// regrouping or a new specimen cannot leave one on another group's page.

const UI = 'https://semblance.dev/demo#'
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const galleryFiles = readdirSync(new URL('../demo/gallery/', import.meta.url)).filter((f) => f.endsWith('.ttl'))
const store = loadStore('n3', read('../demo/app.ttl'), ...galleryFiles.map((f) => read(`../demo/gallery/${f}`)))
const f = store.factory
const r = { f, match: (s: Term | null, p: string | null, o: Term | null) => store.match(s, p ? f.namedNode(p) : null, o) }
const objects = (s: Term, p: string) => store.match(s, f.namedNode(p), null).map((q) => q.object)
const name = (t: Term | undefined) => (t ? t.value.replace(NS.c, 'c:').replace(UI, 'ui:') : 'none')
const location = readLocations(r).find((l) => l.iri === UI + 'location')!

/** Every specimen, the gallery page that shows it (by the location's dimension), and that page's group. */
const specimens = store.match(null, f.namedNode(NS.rdf + 'type'), f.namedNode(NS.c + 'Specimen')).map(({ subject: spec }) => {
  const page = shows(r, location, spec)?.get(UI + 'atGalleryGroup')
  return { spec, page, group: page && objects(page, UI + 'componentGroup')[0], demonstrates: objects(spec, NS.c + 'demonstrates') }
})

describe('the gallery follows the ontology', () => {
  it('shows every specimen on a gallery page', () => {
    expect(specimens.length).toBeGreaterThan(80)
    expect(specimens.filter((s) => !s.page).map((s) => name(s.spec))).toEqual([])
  })

  it("has every specimen on a component group's page say which classes it demonstrates", () => {
    expect(specimens.filter((s) => s.group && !s.demonstrates.length).map((s) => name(s.spec))).toEqual([])
  })

  it('shows each specimen on the page of the group its classes are in', () => {
    const misplaced = specimens.flatMap((s) =>
      s.demonstrates
        .map((cls) => ({ cls, group: objects(cls, NS.sem + 'group')[0] }))
        .filter(({ group }) => !group || !s.group || !group.equals(s.group))
        .map(({ cls, group }) => `${name(s.spec)} is on ${name(s.page)}, but ${name(cls)} is in ${name(group)}`),
    )
    expect(misplaced).toEqual([])
  })

  it('has a page for every component group, each with specimens', () => {
    const groups = store.match(null, f.namedNode(NS.rdf + 'type'), f.namedNode(NS.sem + 'ComponentGroup')).map((q) => q.subject)
    const withPage = new Set(store.match(null, f.namedNode(UI + 'componentGroup'), null).map((q) => q.object.value))
    expect(groups.filter((g) => !withPage.has(g.value)).map(name)).toEqual([])
    const shown = new Set(specimens.map((s) => s.group?.value))
    expect(groups.filter((g) => !shown.has(g.value)).map(name)).toEqual([])
  })
})

describe('the Inspection page', () => {
  it('renders the same with SPARQL rules as with functions', () => {
    expectSameRendering(['GroupInspection'])
  })
})
