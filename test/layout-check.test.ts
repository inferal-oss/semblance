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

/**
 * What each recording must show: the invariants broken there, and nothing else. Labels are the
 * commit before a fix (before), after it (after), main when recorded (57-main, today).
 */
const EXPECTED: [RegExp, string[]][] = [
  // #34: a select and a date input taller than the text inputs of the shape form, in every theme
  [/^34-before_/, ['formControlsShareHeight']],
  [/^34-after_/, []],
  // #53: with one long label, every nav item runs out of the list (nowrap); the gallery has no
  // label that long, so both checkouts are measured with one lengthened (scripts/layout-check.ts)
  [/^53-before-longlabel_components-navigation_375_semblance/, ['navItemsFit']],
  [/^53-before-longlabel_.*_1280_|^53-before-longlabel_.*_classic/, []],
  [/^53-after-longlabel_/, []],
  // 71686f3: at 320px the dock panel (and the page) are wider than the screen
  [/^320-before_components-inspection/, ['contentStaysInCards', 'pageFits']],
  [/^320-after_components-inspection/, ['contentStaysInCards']], // a button, gone on main since
  [/^320-.*_components-feedback/, []],
  // a5fc6b7: gallery pages 443-1038px wide at 375px
  [/^375-before_/, ['contentStaysInCards', 'pageFits']],
  [/^375-after_components-(data|type)/, []],
  [/^375-after_components-themes/, ['contentStaysInCards']], // c:Progress's 260px minimum, fixed by 71686f3
  // #57: the checkout's code and phone fields (open on main; PR #125 fixes it); on a phone they wrap
  [/^57-main_.*_1280_/, ['fieldRowControlsShareTops']],
  [/^57-main_.*_375_/, []],
  [/^57-after_/, []],
  // main at 320px: only the themes page (a c:Window specimen wider than its card)
  [/^today_components-themes_320/, ['contentStaysInCards', 'pageFits']],
  [/^today_components-(inspection|navigation|feedback)_320/, []],
]

describe('layout checker over recorded pages', () => {
  it('has an expectation for every recording', () => {
    expect(fixtures.length).toBeGreaterThan(30)
    expect(fixtures.filter((f) => !EXPECTED.some(([re]) => re.test(f)))).toEqual([])
  })

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
