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
  // #57: the checkout's code and phone fields (before PR #125: 57-main; after it, on main: 57-after);
  // on a phone they wrap. Doodle's 1280 px recording is of layout boxes, before its card's tilt (#192, #256)
  [/^57-main_.*_1280_/, ['fieldRowControlsShareTops']],
  [/^57-main_.*_375_/, []],
  [/^57-after_/, []],
  // main at 320px; the themes page's frame specimens fit since #195 (a frame's minimum width is capped at its container)
  [/^today_components-(themes|inspection|navigation|feedback)_320/, []],
  // #233: a card's header actions in a row that does not wrap (the windows page, the dashboard), and a
  // source view's path pushing its toggles out (the windows page)
  [/^233-before_components-windows_320/, ['contentStaysInCards', 'pageFits']],
  [/^233-before_examples-dashboard_320/, ['contentStaysInCards', 'pageFits']],
  [/^today_(components-windows|examples-dashboard)_320/, []],
  // #246: on the layout page a ledger's columns and a dock panel's header wider than the card left
  // inside four nested 24px insets; on a phone each container takes one step less, the header wraps
  [/^today_components-layout_320/, []],
  // parts the components name themselves (lc:role, #193): the shape form's controls are one height in
  // every theme, an inline choice's pill is its control where wide; nav items fit, in German and Arabic
  [/^today_examples-shape-form_/, []],
  [/^today_components-navigation_(1280|375)_/, []],
  // #299: in a short window, scrolled, the sticky section menu runs over the settings after it in the
  // side column; the column sticks as one since, in every theme and right to left
  [/^299-before_/, ['stackChildrenApart']],
  [/^299-after_/, []],
  // #518: the budget sheet's tags, beside labelled amounts in rows of a list (pos:Subgrid), centred on
  // each field's whole box, label and input; after, on the input, in every theme, on a phone, in Arabic
  [/^518-before_/, ['besideFieldOnItsControl']],
  [/^518-after_/, []],
  // #522: on a phone a row of fields wraps; an item that is not a field, placed as it came over a line's
  // label and control tracks, landed under another in a field's help tracks (Kanban's Undo/Redo, the
  // performance page's Clear) or, taller than the input, sat off its middle (Doodle's Add). After, each
  // is in a cell of its own, beside the control of its line: 375px in three themes and Arabic, 320, 1280
  [/^522-before_/, ['besideFieldOnItsControl']],
  [/^522-after_/, []],
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
    const key = (inv: string, scope: number, member: number) => `${local(inv)} ${scope} ${member}`
    // a group's finding names the group; a Fits finding also the box that sticks out
    const fits = (r: unknown) => r === Rel.FitsInline || r === Rel.FitsWithin || r === Rel.NoOverlap
    const fn = checkMeasured(p, decl).map((x) => [key(x.instance.declaration.iri, x.instance.scope, fits(x.instance.declaration.relation) ? x.member : -1), x.by] as const)
    const sparql = checkSparql(store).map((x) => [key(x.invariant, x.scope, x.member), x.by] as const)
    store.dispose?.()
    const order = (a: readonly [string, number], b: readonly [string, number]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])
    fn.sort(order)
    sparql.sort(order)
    expect(sparql.map(([k]) => k)).toEqual(fn.map(([k]) => k))
    // by as much, to a hundredth of a px: the SPARQL side is decimal, the function side floating point,
    // so a middle (y + height / 2) of x.xx5 px may print either way at the last digit
    sparql.forEach(([k, by], i) => expect([k, Math.abs(by - fn[i]![1]) < 0.006]).toEqual([k, true]))
  })
})
