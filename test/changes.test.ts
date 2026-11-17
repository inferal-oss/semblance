// Changes as a page (ontology/components/changes.ttl, src/components/changes.ts) over the change log
// (src/changes/records.ts): the releases from the tags, the unreleased first; a change with its
// migrations (a rename, a change of shape with its example as a diff, a lossy step); a component's
// versions. Every rendering's SPARQL rule and its function twin render the same, on screen and as
// text, in English and in Arabic.
import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { afterEach, describe, expect, it } from 'vitest'
import { changeRecords, compareVersions, lineDiff } from '../src/changes/records.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { DEFAULT_LAYERS, MOD, NS } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML, toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'

const UI = 'https://example.org/changes-test#'
const fixture = readFileSync(new URL('./fixtures/changes.ttl', import.meta.url), 'utf8')
// Releases at commits on main: v0.1.0 holds the first change file (charts-on-shared-parts, #384), v0.3.0
// the RDF editor's entry pages; what came after is unreleased. The example changes state no release.
const TAGS = [
  { version: '0.1.0', commit: '0b050bb', date: '2026-11-11' },
  { version: '0.2.0', commit: '7b19fcf', date: '2026-11-16' },
  { version: '0.3.0', commit: '312868c', date: '2026-11-16' },
]
const records = changeRecords({ tags: TAGS, extra: [fixture] })
const graph = `@prefix ui: <${UI}> . @prefix c: <${NS.c}> . @prefix change: <https://semblance.dev/change/> .
ui:root a c:Stack ; c:children ( ui:log ui:rename ui:shape ui:converge ui:meaning ui:field ui:window ui:none ) .
ui:log a c:ChangeLog ; c:of <https://semblance.dev/changes> .
ui:location a <https://semblance.dev/ns/navigation#Location> ; <https://semblance.dev/ns/navigation#root> ui:root ;
  <https://semblance.dev/ns/navigation#dimensions> ( ui:atChange ui:atTerm ) .
ui:atTerm a <https://semblance.dev/ns/navigation#Dimension> ; <https://semblance.dev/ns/navigation#subject> ui:app ;
  <https://semblance.dev/ns/navigation#property> ui:term ; <https://semblance.dev/ns/navigation#carriedBy> <https://semblance.dev/ns/navigation#Path> ;
  <https://semblance.dev/ns/navigation#spelling> <https://semblance.dev/ns/navigation#PrefixedName> ; <https://semblance.dev/ns/navigation#showsTerms> true .
ui:atChange a <https://semblance.dev/ns/navigation#Dimension> ; <https://semblance.dev/ns/navigation#subject> ui:app ;
  <https://semblance.dev/ns/navigation#property> ui:change ; <https://semblance.dev/ns/navigation#carriedBy> <https://semblance.dev/ns/navigation#Path> .
ui:change <http://www.w3.org/2000/01/rdf-schema#range> <https://semblance.dev/ns/change#Change> .
ui:rename a c:ChangeEntry ; c:of change:example-label-hidden .
ui:shape a c:ChangeEntry ; c:of change:example-window-size .
ui:converge a c:ChangeEntry ; c:of change:example-radio-into-choice .
ui:meaning a c:ChangeEntry ; c:of change:palette-keywords .
ui:field a c:ComponentHistory ; c:of c:Field .
ui:window a c:ComponentHistory ; c:of c:Window .
ui:none a c:ComponentHistory ; c:of <https://example.org/nothing> .`

const live: Runtime[] = []
afterEach(() => {
  for (const r of live.splice(0)) r.dispose()
})

function mount(kind: StoreKind, prefer: 'function' | 'sparql', language?: string) {
  const { document } = parseHTML('<!doctype html><html><body><main></main></body></html>')
  const store = loadStore(kind, graph, records)
  const runtime = new Runtime(store)
  live.push(runtime)
  const languages = language ? [language] : []
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, roots: [UI + 'root'], prefer, languages })
  const text = runtime.project({ modality: MOD.Text, layers: DEFAULT_LAYERS, roots: [UI + 'root'], prefer, languages, name: 'text' })
  const renderer = new DomRenderer(screen.index, document.querySelector('main')!, UI + 'root')
  renderer.flush()
  return { document, html: () => toHTML(screen.index, UI + 'root'), text: () => toText(text.index, UI + 'root') }
}

describe('the change log, from the records', () => {
  it('places releases by tag and changes in the earliest release that holds them', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
    expect(records).toContain('<https://semblance.dev/release/0.3.0> a chg:Release')
    expect(records).toMatch(/<https:\/\/semblance\.dev\/changes\/unreleased> a chg:Release ; [^\n]*chg:previous <https:\/\/semblance\.dev\/release\/0\.3\.0>/)
    expect(records).toMatch(/<https:\/\/semblance\.dev\/change\/charts-on-shared-parts> sem:slug "charts-on-shared-parts" ; sem:order 0 ; chg:releasedIn <https:\/\/semblance\.dev\/release\/0\.1\.0>/)
    expect(records).toMatch(/<https:\/\/semblance\.dev\/change\/example-window-size> [^\n]*chg:releasedIn <https:\/\/semblance\.dev\/changes\/unreleased>/)
    // A version step from the history of ontology/versions.ttl, and one an unmerged change's migration states.
    expect(records).toMatch(/a chg:Step ; chg:of <https:\/\/semblance\.dev\/ns\/component#Field> ; sem:version 1 ; chg:releasedIn <https:\/\/semblance\.dev\/release\/0\.1\.0> ; sem:internal "new"/)
    expect(records).toMatch(/a chg:Step ; chg:of <https:\/\/semblance\.dev\/ns\/component#Window> ; sem:version 2 ; chg:releasedIn <https:\/\/semblance\.dev\/changes\/unreleased> ; sem:changedBy <https:\/\/semblance\.dev\/change\/example-window-size>/)
  })

  it('diffs an example line by line, removals before additions', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'context', text: 'c' },
    ])
  })
})

for (const kind of ['wat', 'oxigraph'] as const)
  describe(`changes as a page (${kind})`, () => {
    it('renders the same by SPARQL and by function, on screen and as text', () => {
      const fn = mount(kind, 'function')
      const sparql = mount(kind, 'sparql')
      expect(sparql.html()).toBe(fn.html())
      expect(sparql.text()).toBe(fn.text())
    })

    it('renders the same in Arabic', () => {
      const fn = mount(kind, 'function', 'ar')
      const sparql = mount(kind, 'sparql', 'ar')
      expect(sparql.html()).toBe(fn.html())
      expect(fn.html()).toContain('غير منشور')
    })
  })

describe('changes as a page: what it shows', () => {
  const kind = 'wat'
  it('shows the unreleased first, then the releases from the latest to the earliest', () => {
    const { document } = mount(kind, 'sparql')
    const log = document.querySelector('[data-sem-c=change-log]')!
    const headings = [...log.querySelectorAll(':scope > div > section > h2, :scope > section > h2')].map((h) => h.textContent)
    expect(headings.slice(0, 4)).toEqual(['Unreleased', '0.3.0', '0.2.0', '0.1.0'])
    expect(log.textContent).toContain('Since 0.3.0')
    expect(log.textContent).toContain('Released 2026-11-11, tag v0.1.0 · 1 change')
    expect(log.querySelectorAll('a[href]').length).toBeGreaterThan(3)
  })

  it('shows a change with its migrations: renames, a diff, the SPARQL and what going back loses', () => {
    const { document } = mount(kind, 'sparql')
    const entries = [...document.querySelectorAll('[data-sem-c=change-entry]')]
    const [rename, shape, converge, meaning] = entries
    expect(rename!.querySelector('h1')!.textContent).toBe('c:hideLabel is now c:labelHidden')
    expect([...rename!.querySelector('[data-sem-c=migration-view]')!.querySelectorAll('.sem-renames tbody tr')].map((r) => r.textContent)).toEqual(['"hide-label""label-hidden"', 'c:hideLabelc:labelHidden'])
    expect(rename!.textContent).toContain('semblance migrate --from 0.3.0')
    expect(rename!.textContent).toContain('c:Field 2 → 3')
    expect(shape!.querySelectorAll('[data-sem-c=diff-line]').length).toBeGreaterThan(4)
    expect(shape!.textContent).toContain('DELETE { ?f c:width ?w ; c:height ?h }')
    expect(converge!.textContent).toContain('Going back loses this')
    expect(converge!.textContent).toContain('Which one each instance was is kept in c:variant.')
    expect(converge!.textContent).toContain('semblance migrate --to 0.3.0 --accept-loss')
    expect(converge!.querySelector('[data-sem-c=tag]')!.textContent).toContain('c:columns')
    expect(meaning!.textContent).toContain('nothing in your files to rewrite')
    expect(meaning!.querySelector('[data-sem-c=migration-view]')).toBeNull()
  })

  it("shows a component's versions, newest first", () => {
    const { document } = mount(kind, 'sparql')
    const [field, window, none] = [...document.querySelectorAll('[data-sem-c=component-history]')]
    const versions = [...field!.querySelectorAll('[data-sem-c=card] h2, [data-sem-c=card] h3')].map((h) => h.textContent)
    expect(versions[0]).toBe('Version 3')
    expect(versions.at(-1)).toBe('Version 1')
    expect(field!.textContent).toContain('New.')
    expect(window!.textContent).toContain('a window')
    expect(none!.textContent).toBe('No recorded versions.')
  })
})
