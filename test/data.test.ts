import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { hueOf, initials } from '../src/components/data.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { A11Y, MOD, NS, SEM, STY } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'

/**
 * One gallery page (demo/gallery/<file>.ttl) over the framework ontology, projected on its
 * own into a DOM with the shell's layers and driven only through DOM events.
 */
export function galleryPage(file: string, root: string, kind: StoreKind = 'oxigraph', prefer?: 'sparql' | 'function') {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const store = loadStore(kind, readFileSync(new URL(`../demo/gallery/${file}.ttl`, import.meta.url), 'utf8'))
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer, SEM.SourceLayer, SEM.TooltipLayer], provenance: true, name: 'screen', roots: [UI + root] }, (e) => {
    throw e
  })
  const dom = new DomRenderer(screen.index, document.getElementById('app')!, UI + root)
  dom.flush()
  const bus = new EventBus(runtime, screen, { prefer })
  bus.attach(dom, () => dom.flush())
  const f = store.factory
  const byId = (id: string) => [...document.querySelectorAll('*')].find((e) => dom.keyOf(e) === `${UI}${id}/~root`) as HTMLElement
  const click = (el: Element) => el.dispatchEvent(new window.Event('click', { bubbles: true }))
  const objects = (s: string, p: string) => store.match(f.namedNode(s), f.namedNode(p), null).map((q) => q.object.value)
  return { document, store, runtime, screen, dom, bus, root: byId, click, objects }
}

const gallery = (kind: StoreKind = 'oxigraph', prefer?: 'sparql' | 'function') => galleryPage('data', 'gallery-data', kind, prefer)

describe('c:GanttChart', () => {
  it("shows the gallery's plan: a region that scrolls, a task a row, its dates in words", () => {
    const { root } = gallery()
    const chart = root('dt-gantt-chart')
    expect(chart.getAttribute('data-sem-c')).toBe('gantt-chart')
    const region = chart.querySelector('.sem-gantt-scroll')!
    expect([region.getAttribute('role'), region.getAttribute('tabindex'), region.getAttribute('aria-label')]).toEqual(['region', '0', 'Release plan'])
    expect([...chart.querySelectorAll('.sem-gantt-label')].map((l) => l.textContent)).toEqual(['Sketch the interface', 'Build the component', 'Write the docs', 'Review'])
    expect(chart.querySelectorAll('.sem-gantt-bar')).toHaveLength(3)
    expect(chart.querySelectorAll('.sem-gantt-milestone')).toHaveLength(1)
    expect(chart.querySelector('.sem-gantt-track')!.getAttribute('aria-hidden')).toBe('true')
    expect(chart.querySelectorAll('li')[3]!.querySelector('.sem-visually-hidden')!.textContent).toBe('2026-11-17 · Milestone · After Build the component · After Write the docs')
  })
})

describe('c:Table', () => {
  it('keeps host-owned cells and their controls when rows sort', () => {
    const { document, window } = parseHTML('<!doctype html><html><body><main id="app"></main></body></html>')
    const store = loadStore('oxigraph', `@prefix c: <${NS.c}> . @prefix sem: <${NS.sem}> . @prefix ex: <https://example.org/> .
      ex:q a sem:View ; sem:select "SELECT ?name ?id WHERE { VALUES (?name ?id) { (\\"Zulu\\" \\"z\\") (\\"Alpha\\" \\"a\\") } }" .
      ex:name a c:Column ; c:variable "name" ; c:label "Name" ; c:slotPrefix "name-" ; c:slotVariable "id" .
      ex:action a c:Column ; c:variable "id" ; c:label "Actions" ; c:slotPrefix "action-" ; c:sortable false .
      ex:t a c:Table ; c:label "Members" ; c:query ex:q ; c:tableColumns ( ex:name ex:action ) .`)
    const runtime = new Runtime(store)
    const screen = runtime.project({ modality: MOD.Screen, layers: [A11Y.Layer, STY.Layer], roots: ['https://example.org/t'] })
    const dom = new DomRenderer(screen.index, document.getElementById('app')!, 'https://example.org/t')
    dom.flush()
    const bus = new EventBus(runtime, screen)
    bus.attach(dom, () => dom.flush())
    const slot = dom.slot('action-z')!
    const zuluName = dom.slot('name-z')!
    zuluName.textContent = 'Zulu'
    dom.slot('name-a')!.textContent = 'Alpha'
    const button = document.createElement('button')
    button.textContent = 'Edit Zulu'
    slot.append(button)
    expect(dom.slot('action-a')?.localName).toBe('td')
    expect(slot.textContent).toBe('Edit Zulu')
    const headers = [...document.querySelectorAll('thead th')]
    expect(headers[0]?.querySelector('button')).not.toBeNull()
    expect(headers[1]?.querySelector('button')).toBeNull()
    expect(headers[1]?.querySelector('.sem-head-label')).not.toBeNull()
    expect(headers[1]?.textContent).toBe('Actions')
    headers[0]!.querySelector('button')!.dispatchEvent(new window.Event('click', { bubbles: true }))
    expect([...document.querySelectorAll('tbody th')].map((th) => th.textContent)).toEqual(['Alpha', 'Zulu'])
    expect(dom.slot('action-z')).toBe(slot)
    expect(dom.slot('name-z')).toBe(zuluName)
    expect(slot.querySelector('button')).toBe(button)
    const plain = toText(runtime.project({ modality: MOD.Text, name: 'text' }).index, 'https://example.org/t')
    expect(plain).toContain('Members')
    expect(plain).not.toContain('Edit Zulu')
  })

  it('leaves a cell empty when its slot key is unbound', () => {
    const { document } = parseHTML('<!doctype html><html><body><main id="app"></main></body></html>')
    const store = loadStore('oxigraph', `@prefix c: <${NS.c}> . @prefix sem: <${NS.sem}> . @prefix ex: <https://example.org/> .
      ex:q a sem:View ; sem:select "SELECT ?name ?id WHERE { VALUES (?name ?id) { (\\"Known\\" \\"k\\") (\\"Missing\\" UNDEF) } }" .
      ex:name a c:Column ; c:variable "name" ; c:label "Name" .
      ex:action a c:Column ; c:variable "name" ; c:label "Actions" ; c:slotPrefix "action-" ; c:slotVariable "id" ; c:sortable false .
      ex:t a c:Table ; c:query ex:q ; c:tableColumns ( ex:name ex:action ) .`)
    const screen = new Runtime(store).project({ modality: MOD.Screen, roots: ['https://example.org/t'] })
    const dom = new DomRenderer(screen.index, document.getElementById('app')!, 'https://example.org/t')
    dom.flush()
    expect(dom.slot('action-k')?.localName).toBe('td')
    expect(dom.slot('action-Missing')).toBeUndefined()
    const missing = [...document.querySelectorAll('tbody tr')].find((row) => row.querySelector('th')?.textContent === 'Missing')!
    expect(missing.querySelector('td')?.textContent).toBe('')
  })

  it('keeps distinct slot cells for rows with the same displayed value', () => {
    const { document, window } = parseHTML('<!doctype html><html><body><main id="app"></main></body></html>')
    const store = loadStore('oxigraph', `@prefix c: <${NS.c}> . @prefix sem: <${NS.sem}> . @prefix ex: <https://example.org/> .
      ex:q a sem:View ; sem:select "SELECT ?name ?id ?rank WHERE { VALUES (?name ?id ?rank) { (\\"Same\\" \\"first\\" 2) (\\"Same\\" \\"second\\" 1) } } ORDER BY DESC(?rank)" .
      ex:name a c:Column ; c:variable "name" ; c:label "Name" ; c:slotPrefix "name-" ; c:slotVariable "id" .
      ex:rank a c:Column ; c:variable "rank" ; c:label "Rank" .
      ex:t a c:Table ; c:query ex:q ; c:tableColumns ( ex:name ex:rank ) .`)
    const runtime = new Runtime(store)
    const screen = runtime.project({ modality: MOD.Screen, roots: ['https://example.org/t'] })
    const dom = new DomRenderer(screen.index, document.getElementById('app')!, 'https://example.org/t')
    dom.flush()
    const bus = new EventBus(runtime, screen)
    bus.attach(dom, () => dom.flush())
    const first = dom.slot('name-first')!
    const second = dom.slot('name-second')!
    first.textContent = 'First'
    second.textContent = 'Second'
    expect(first).not.toBe(second)
    expect([...document.querySelectorAll('tbody th')].map((cell) => cell.textContent)).toEqual(['First', 'Second'])
    document.querySelectorAll('thead th button')[1]!.dispatchEvent(new window.Event('click', { bubbles: true }))
    expect([...document.querySelectorAll('tbody th')].map((cell) => cell.textContent)).toEqual(['Second', 'First'])
    expect(dom.slot('name-first')).toBe(first)
    expect(dom.slot('name-second')).toBe(second)
  })

  it('renders the rows of its SELECT with table semantics and a sticky, sortable header', () => {
    const { root, document } = gallery()
    const t = root('dt-table-component')
    expect(t.getAttribute('data-sem-c')).toBe('table')
    expect(t.getAttribute('role')).toBe('region')
    const table = t.querySelector('table')!
    expect(table.getAttribute('aria-label')).toBe('Component classes')
    const headers = [...table.querySelectorAll('thead th')]
    expect(headers.map((h) => h.textContent!.replace(/[↑↓↕]/g, ''))).toEqual(['Component', 'Slug', 'Extends', 'Renderings', 'Reactions'])
    expect(headers.every((h) => h.getAttribute('scope') === 'col' && h.querySelector('button'))).toBe(true)
    // sorted by renderings, descending (graph state in the gallery)
    expect(headers[3]!.getAttribute('aria-sort')).toBe('descending')
    expect(headers.filter((h) => h.hasAttribute('aria-sort'))).toHaveLength(1)
    const rows = [...table.querySelectorAll('tbody tr')]
    // every component class in the project is a row, including this one
    const names = rows.map((r) => r.querySelector('th')!.textContent)
    expect(names).toContain('Table')
    expect(names).toContain('Tree')
    expect(rows.length).toBeGreaterThan(30)
    const counts = rows.map((r) => Number(r.querySelectorAll('td')[2]!.textContent))
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
    expect(rows[0]!.querySelectorAll('td')[2]!.className).toBe('sem-end')
    const slug = rows.find((r) => r.querySelector('th')!.textContent === 'Table')!.querySelector('code')!
    expect(slug.textContent).toBe('table')
    expect(document.querySelector('[data-sem-c=table] .sem-sort-icon')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('sorts by a clicked header, reverses on a second click, and moves rows rather than re-rendering them', () => {
    const { root, click, objects, bus } = gallery()
    const t = () => root('dt-table-component')
    const header = (i: number) => t().querySelectorAll('thead th')[i] as HTMLElement
    const names = () => [...t().querySelectorAll('tbody th')].map((th) => th.textContent!)
    const before = t().querySelector('tbody tr')!
    const beforeName = before.querySelector('th')!.textContent
    click(header(0).querySelector('span')!) // the label inside the button
    expect(objects(UI + 'dt-table-component', NS.c + 'sortColumn')).toEqual([UI + 'dt-col-class'])
    expect(objects(UI + 'dt-table-component', NS.c + 'sortDescending')).toEqual(['false'])
    expect(header(0).getAttribute('aria-sort')).toBe('ascending')
    expect(header(3).hasAttribute('aria-sort')).toBe(false)
    const asc = names()
    expect(asc).toEqual([...asc].sort((a, b) => a.localeCompare(b, 'en-US', { numeric: true, sensitivity: 'base' })))
    click(header(0).querySelector('button')!)
    expect(header(0).getAttribute('aria-sort')).toBe('descending')
    expect(names()).toEqual([...asc].reverse())
    // the same row element, moved
    const same = [...t().querySelectorAll('tbody tr')].find((r) => r.querySelector('th')!.textContent === beforeName)
    expect(same).toBe(before)
    // clicking a cell is not a sort
    const n = bus.recent(50).length
    click(t().querySelector('tbody td')!)
    expect(bus.recent(50).length).toBe(n)
  })

  it('sorts and toggles the same through the function reactions', () => {
    const { root, click, objects } = gallery('oxigraph', 'function')
    const header = () => root('dt-table-component').querySelectorAll('thead th')[3] as HTMLElement
    click(header().querySelector('button')!) // the sorted column, descending: now ascending
    expect(objects(UI + 'dt-table-component', NS.c + 'sortDescending')).toEqual(['false'])
    expect(header().getAttribute('aria-sort')).toBe('ascending')
    click(header().querySelector('button')!)
    expect(header().getAttribute('aria-sort')).toBe('descending')
    const twisty = root('dt-tree-classes').querySelector('[aria-expanded=false] .sem-twisty')!
    click(twisty)
    expect(objects(UI + 'dt-tree-classes', NS.c + 'expandedNode')).toHaveLength(3)
  })

  it('needs SPARQL, and says so on a store without it', () => {
    const { root } = gallery('n3')
    expect(root('dt-table-component').textContent).toMatch(/SPARQL/)
  })

  it('lists its query on the back of its card', () => {
    const { root, click } = gallery()
    const card = root('dt-table')
    click(card.querySelector('.sem-flip')!)
    const back = card.querySelector('.sem-back')!
    expect(back.textContent).toContain('component classes')
    expect(back.textContent).toContain('GROUP BY ?class ?slug')
  })

  it('sketches its rows as aligned text', () => {
    const store = loadStore(
      'oxigraph',
      `@prefix c: <${NS.c}> . @prefix sem: <${NS.sem}> . @prefix ex: <https://example.org/> .
       ex:q a sem:View ; sem:select "SELECT ?name ?n WHERE { VALUES (?name ?n) { (\\"alpha\\" 3) (\\"beta\\" 12) } }" .
       ex:name a c:Column ; c:variable "name" ; c:label "Name" .
       ex:n a c:Column ; c:variable "n" ; c:label "N" ; c:align "end" .
       ex:t a c:Table ; c:query ex:q ; c:tableColumns ( ex:name ex:n ) ; c:sortColumn ex:n ; c:sortDescending true .`,
    )
    const text = new Runtime(store).project({ modality: MOD.Text, name: 'text' })
    expect(toText(text.index, 'https://example.org/t')).toBe('Name   N ↓\n─────  ───\nbeta    12\nalpha    3')
  })
})

describe('c:DescriptionList, c:Stat and c:Avatar', () => {
  it('renders key / value pairs as a dl, from a node or from explicit items', () => {
    const { root } = gallery()
    const dl = root('dt-dl-class')
    expect(dl.localName).toBe('dl')
    const pairs = [...dl.querySelectorAll('.sem-pair')].map((p) => [p.querySelector('dt')!.textContent, p.querySelector('dd')!.textContent])
    expect(pairs[0]).toEqual(['slug', 'table'])
    // c:Table is a sem:Component and a c:Sortable, and (ontology/alignments.ttl) a schema:Table.
    expect(pairs[1]).toEqual(['subClassOf', 'Table, Sortable, Component'])
    expect(pairs[2]![1]).toMatch(/^Rows of a SPARQL SELECT/)
    expect([...root('dt-dl-explicit').querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Store', 'Strata', 'Change log', 'Identity'])
  })

  it('shows a stat with its unit and a toned trend', () => {
    const { root } = gallery()
    const toggle = root('dt-stat-toggle')
    expect(toggle.querySelector('.sem-value')!.textContent).toBe('0.48')
    expect(toggle.querySelector('.sem-unit')!.textContent).toBe('ms')
    const delta = toggle.querySelector('.sem-delta')!
    expect(delta.textContent).toBe('↓−12%')
    expect(delta.getAttribute('aria-label')).toBe('down 12%')
    expect(delta.className).toContain('sem-good') // lower is better
    expect(root('dt-stat-bundle').querySelector('.sem-delta')!.className).toContain('sem-bad')
    expect(root('dt-stat-runs').querySelector('.sem-delta')!.getAttribute('data-trend')).toBe('flat')
    expect(root('dt-stat-members').querySelector('.sem-delta')).toBeNull()
  })

  it('draws avatars from initials and a label-derived hue, and groups them past c:max', () => {
    expect(initials('Tim Berners-Lee')).toBe('TL')
    expect(initials('ada')).toBe('AD')
    expect(hueOf('Grace Hopper')).toBe(hueOf('Grace Hopper'))
    const { root } = gallery()
    const tim = root('dt-av-tim')
    expect(tim.getAttribute('role')).toBe('img')
    expect(tim.getAttribute('aria-label')).toBe('Tim Berners-Lee')
    expect(tim.textContent).toBe('TL')
    expect(tim.getAttribute('style')).toBe(`--avatar-hue: ${hueOf('Tim Berners-Lee')}`)
    expect(tim.getAttribute('data-sem-size')).toBe('md')
    expect(root('dt-av-image').querySelector('img')!.getAttribute('alt')).toBe('')
    const group = root('dt-av-group')
    expect(group.getAttribute('role')).toBe('group')
    expect(group.querySelectorAll('[data-sem-c=avatar]')).toHaveLength(4)
    expect(group.querySelector('.sem-more')!.textContent).toBe('+3')
    expect(group.querySelector('.sem-more')!.getAttribute('aria-label')).toBe('3 more')
  })
})

describe('c:Timeline', () => {
  it('lists the newest change-log events, newest first, each rendered once', () => {
    const { root, click, screen } = gallery()
    const runs = () => screen.engine.stats.byRule.get(NS.c + 'TimelineItemRendering-fn')?.runs ?? 0
    const items = () => [...root('dt-timeline-log').querySelectorAll('[data-sem-c=timeline-item]')]
    // the gallery-group switch was applied directly, so the log may start empty
    const header = () => root('dt-table-component').querySelector('thead th button')!
    click(header())
    expect(items()[0]!.querySelector('strong')!.textContent).toBe('Click')
    expect(items()[0]!.querySelector('.sem-target')!.textContent).toBe('Component classes')
    expect(items()[0]!.querySelector('time')!.getAttribute('datetime')).toMatch(/^\d{4}-\d\d-\d\dT/)
    const before = runs()
    click(header())
    click(header())
    expect(items().length).toBeGreaterThanOrEqual(3)
    // one new item per event; the earlier items are not rendered again
    expect(runs() - before).toBe(2)
    for (let i = 0; i < 6; i++) click(header())
    expect(items()).toHaveLength(6) // c:limit
  })
})

describe('c:Tree', () => {
  it('shows the component class hierarchy with tree roles', () => {
    const { root } = gallery()
    const tree = root('dt-tree-classes')
    expect(tree.getAttribute('role')).toBe('tree')
    expect(tree.getAttribute('aria-label')).toBe('Component classes')
    const top = tree.querySelector('[role=treeitem]')!
    expect(top.querySelector('.sem-label')!.textContent).toBe('Component')
    expect(top.getAttribute('aria-level')).toBe('1')
    expect(top.getAttribute('aria-expanded')).toBe('true')
    const level2 = [...top.querySelector('[role=group]')!.children]
    expect(level2.every((li) => li.getAttribute('role') === 'treeitem' && li.getAttribute('aria-level') === '2')).toBe(true)
    const labels = level2.map((li) => li.querySelector('.sem-label')!.textContent)
    expect(labels).toContain('Table')
    expect(labels).toContain('Tree')
    expect(labels).toContain('Segmented')
    // sorted by label
    expect(labels).toEqual([...labels].sort((a, b) => a!.localeCompare(b!)))
    // Segmented is open (c:expandedNode), and NavList is selected
    const segmented = level2.find((li) => li.querySelector('.sem-label')!.textContent === 'Segmented')!
    expect(segmented.getAttribute('aria-expanded')).toBe('true')
    const navList = [...segmented.querySelectorAll('[role=treeitem]')].find((li) => li.querySelector('.sem-label')!.textContent === 'NavList')!
    expect(navList.getAttribute('aria-selected')).toBe('true')
    expect(navList.querySelector('.sem-detail')!.textContent).toBe('nav-list')
  })

  it('expands and collapses a node from its twisty', () => {
    const { root, click, objects } = gallery()
    const item = (label: string) =>
      [...root('dt-tree-classes').querySelectorAll('[role=treeitem]')].find((li) => li.querySelector(':scope > .sem-row > .sem-label')!.textContent === label) as HTMLElement
    const chart = item('Chart')
    expect(chart.getAttribute('aria-expanded')).toBe('false')
    expect(chart.querySelector('[role=group]')).toBeNull()
    const twisty = chart.querySelector('.sem-twisty')!
    expect(twisty.getAttribute('aria-label')).toBe('Expand Chart')
    click(twisty)
    expect(objects(UI + 'dt-tree-classes', NS.c + 'expandedNode')).toContain(NS.c + 'Chart')
    expect(item('Chart').getAttribute('aria-expanded')).toBe('true')
    expect([...item('Chart').querySelectorAll(':scope > [role=group] > li > .sem-row > .sem-label')].map((l) => l.textContent)).toEqual(['BarChart', 'Gantt chart', 'Heatmap', 'LineChart'])
    expect(item('BarChart').getAttribute('aria-level')).toBe('3')
    click(item('Chart').querySelector('.sem-twisty')!)
    expect(item('Chart').getAttribute('aria-expanded')).toBe('false')
    expect(item('BarChart')).toBeUndefined()
  })

  it('selects a node from its label, and the breadcrumbs follow and navigate back up', () => {
    const { root, click, objects } = gallery()
    const crumbs = () => [...root('dt-tree-crumbs').querySelectorAll('li')].map((li) => li.textContent!.replace('/', ''))
    expect(crumbs()).toEqual(['Component', 'Segmented', 'NavList'])
    const label = [...root('dt-tree-classes').querySelectorAll('.sem-label')].find((l) => l.textContent === 'Table')!
    click(label)
    expect(objects(UI + 'dt-browse', UI + 'browsing')).toEqual([NS.c + 'Table'])
    expect(crumbs()).toEqual(['Component', 'Table'])
    const selected = root('dt-tree-classes').querySelector('[aria-selected=true]')!
    expect(selected.querySelector('.sem-label')!.textContent).toBe('Table')
    click(root('dt-tree-crumbs').querySelector('button')!)
    expect(objects(UI + 'dt-browse', UI + 'browsing')).toEqual([NS.sem + 'Component'])
    expect(crumbs()).toEqual(['Component'])
  })

  it('sketches open nodes as an indented outline', () => {
    const store = loadStore(
      'oxigraph',
      `@prefix c: <${NS.c}> . @prefix rdfs: <${NS.rdfs}> . @prefix ex: <https://example.org/> .
       ex:b rdfs:subClassOf ex:a . ex:c rdfs:subClassOf ex:a . ex:d rdfs:subClassOf ex:b .
       ex:t a c:Tree ; c:of ex:a ; c:parentProperty rdfs:subClassOf ; c:expandedNode ex:a .`,
    )
    const text = new Runtime(store).project({ modality: MOD.Text, name: 'text' })
    expect(toText(text.index, 'https://example.org/t')).toBe('▾ a\n  ▸ b\n    c')
  })
})

describe('in the demo shell', () => {
  it('shows the group on the Components page', () => {
    const { document, store, runtime, shell, showPage } = mountShell()
    const f = store.factory
    showPage('Components')
    const app = f.namedNode(UI + 'app')
    const p = f.namedNode(UI + 'galleryGroup')
    runtime.apply({ remove: store.match(app, p, null), add: [f.quad(app, p, f.namedNode(UI + 'GroupData'))] })
    shell.flush()
    const kinds = new Set([...document.querySelectorAll('[data-sem-c]')].map((e) => e.getAttribute('data-sem-c')))
    for (const k of ['table', 'stat', 'tree', 'description-list', 'avatar', 'avatar-group', 'timeline']) expect(kinds, k).toContain(k)
  })
})
