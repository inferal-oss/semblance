// The layout checker over real geometry: box trees recorded in Chromium (scripts/layout-check.ts)
// from the commits before and after past layout fixes. The checker must find each bug before its fix
// and not after, and its SPARQL side (lc:Checker over rnd: triples) must find exactly what the
// function side finds.
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { Rel } from '../src/layout/check.ts'
import { checkMeasured, checkSparql, readDeclarations, toTurtle, type Declarations } from '../src/layout/invariants.ts'
import type { MeasuredPage } from '../src/layout/measure.ts'
import { createStore, loadStore } from '../src/node/load.ts'

const DIR = new URL('./fixtures/layout/', import.meta.url)
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
const page = (f: string): MeasuredPage => JSON.parse(readFileSync(new URL(f, DIR), 'utf8'))
const constraintsTtl = readFileSync(new URL('../ontology/layers/constraints.ttl', import.meta.url), 'utf8')

let decl: Declarations
let hierarchy: string
beforeAll(() => {
  const store = loadStore('wat')
  decl = readDeclarations(store)
  // the class hierarchy the SPARQL side walks (a/rdfs:subClassOf*), for a small store per page
  const lines: string[] = []
  for (const ups of decl.typesOf.values()) for (const up of ups) for (const cls of decl.directTypes.values()) for (const c of cls) if (ups.has(c) && c !== up) lines.push(`<${c}> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${up}> .`)
  hierarchy = [...new Set(lines)].join('\n')
  store.dispose?.()
})

const local = (iri: string) => iri.slice(iri.lastIndexOf('#') + 1)
const found = (f: string) => [...new Set(checkMeasured(page(f), decl).map((x) => local(x.instance.declaration.iri)))].sort()

/** What each recording must show: the invariants broken there (and nothing else). */
const EXPECTED: [RegExp, string[]][] = [
  [/^34-before_.*_(semblance|classic|cupertino)/, ['formControlsShareHeight']],
  [/^34-after_/, []],
  [/^53-before_components-navigation_375/, ['navItemsFit']],
  [/^53-after_/, []],
  [/^320-before_components-inspection/, ['pageFits']],
  [/^320-after_/, []],
  [/^375-before_components-themes/, ['pageFits']],
  [/^375-after_/, []],
  [/^57-main_.*_1280/, ['fieldRowControlsShareTops']],
  [/^57-after_/, []],
]

describe('layout checker over recorded pages', () => {
  it('has recordings', () => expect(fixtures.length).toBeGreaterThan(10))

  it.each(EXPECTED.map(([re, want]) => [String(re), re, want] as const))('%s', (_, re, want) => {
    const matching = fixtures.filter((f) => re.test(f))
    expect(matching.length).toBeGreaterThan(0)
    for (const f of matching) expect([f, found(f)]).toEqual([f, want])
  })

  it.each(fixtures)('SPARQL finds what the function finds: %s', (f) => {
    const p = page(f)
    const store = createStore('wat')
    store.loadTurtle(constraintsTtl)
    store.loadTurtle(hierarchy)
    store.loadTurtle(toTurtle(p, decl))
    const key = (inv: string, scope: number, member: number, by: number) => `${local(inv)} ${scope} ${member} ${by.toFixed(2)}`
    // a group's finding names the group; a Fits finding also the box that sticks out
    const fits = (r: unknown) => r === Rel.FitsInline || r === Rel.FitsWithin
    const fn = checkMeasured(p, decl).map((x) => key(x.instance.declaration.iri, x.instance.scope, fits(x.instance.declaration.relation) ? x.member : -1, x.by))
    const sparql = checkSparql(store).map((x) => key(x.invariant, x.scope, x.member, x.by))
    store.dispose?.()
    expect(sparql.sort()).toEqual(fn.sort())
  })
})
