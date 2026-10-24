import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { addressOf, Navigation, opening, readLocations, shows } from '../src/navigation.ts'
import { MOD, NS } from '../src/ns.ts'
import { type Backend, memoryBackend, Persistence } from '../src/persistence.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import type { GraphStore } from '../src/store/types.ts'
import { mountNavigating } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const NAV = NS.nav
const PER = NS.per

/** A browser tab's address and history: entries, an index, popstate on Back and Forward, hashchange on a followed link. */
function tab(start = '/') {
  const entries = [new URL(start, 'https://semblance.test/')]
  let at = 0
  const events = new EventTarget()
  const location = {
    get pathname() {
      return entries[at]!.pathname
    },
    get search() {
      return entries[at]!.search
    },
    get hash() {
      return entries[at]!.hash
    },
  }
  const history = {
    pushes: 0,
    replaces: 0,
    pushState(_d: unknown, _u: string, url: string) {
      entries.splice(at + 1, Infinity, new URL(url, entries[at]))
      at++
      this.pushes++
    },
    replaceState(_d: unknown, _u: string, url: string) {
      entries[at] = new URL(url, entries[at])
      this.replaces++
    },
  }
  return {
    location,
    history,
    events,
    get address() {
      return location.search + location.hash
    },
    get length() {
      return entries.length
    },
    back() {
      at--
      events.dispatchEvent(new Event('popstate'))
    },
    forward() {
      at++
      events.dispatchEvent(new Event('popstate'))
    },
    /** Follow a link or type an address: a new entry, then hashchange (as browsers do). */
    visit(url: string) {
      entries.splice(at + 1, Infinity, new URL(url, entries[at]))
      at++
      events.dispatchEvent(new Event('hashchange'))
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const storage = (): Record<string, Backend> => ({ [PER + 'Session']: memoryBackend(), [PER + 'Device']: memoryBackend(), [PER + 'Database']: memoryBackend() })

async function site(start = '/', backends?: Record<string, Backend>, extra: Partial<ConstructorParameters<typeof Navigation>[1]> = {}) {
  const t = tab(start)
  const h = await mountNavigating({ location: t.location, history: t.history, events: t.events, ...extra }, backends)
  const set = (p: string, o: string) => {
    const f = h.store.factory
    h.runtime.apply({ remove: h.store.match(f.namedNode(UI + 'app'), f.namedNode(p), null), add: [f.quad(f.namedNode(UI + 'app'), f.namedNode(p), f.namedNode(o))] })
    h.shell.flush()
  }
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  return { ...h, tab: t, set, visible }
}

describe('navigation: where we are, in the address', () => {
  it('reads the fragment into the graph before the first projection, and keeps a canonical one', async () => {
    const s = await site('/#docs/rules')
    expect(s.value(UI + 'page')).toBe(UI + 'Docs')
    expect(s.value(UI + 'docSection')).toBe(UI + 'DocRules')
    expect(s.tab.address).toBe('#docs/rules')
    expect(s.tab.history.pushes).toBe(0)
  })

  it('writes the graph to the fragment, nested dimensions after their parent and only in scope', async () => {
    const s = await site('/')
    expect(s.tab.address).toBe('#home') // no section: the docs section applies only on the docs
    s.set(UI + 'page', UI + 'Docs')
    await tick()
    expect(s.tab.address).toBe('#docs/overview')
    s.set(UI + 'docSection', UI + 'DocLayers')
    await tick()
    expect(s.tab.address).toBe('#docs/layers')
    s.set(UI + 'page', UI + 'Components')
    await tick()
    expect(s.tab.address).toBe('#components/foundations')
    s.set(UI + 'page', UI + 'Reference')
    await tick()
    expect(s.tab.address).toBe('#reference/c:Window') // a term, as a prefixed name
  })

  it('makes one step per interaction, through the graph; Back and Forward walk it', async () => {
    const s = await site('/')
    const nav = [...s.document.querySelectorAll('[data-sem-c=app-bar] button')]
    s.fire(nav.find((b) => b.textContent!.trim() === 'Docs')!, 'click')
    await tick()
    s.fire([...s.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === 'Performance' && s.visible(b))!, 'click')
    await tick()
    expect(s.tab.address).toBe('#docs/performance')
    expect(s.tab.history.pushes).toBe(2)
    expect(s.tab.length).toBe(3)

    s.tab.back()
    expect(s.value(UI + 'docSection')).toBe(UI + 'DocOverview')
    expect(s.tab.address).toBe('#docs/overview')
    s.tab.back()
    expect(s.value(UI + 'page')).toBe(UI + 'Home')
    s.tab.forward()
    s.tab.forward()
    expect(s.value(UI + 'page')).toBe(UI + 'Docs')
    expect(s.value(UI + 'docSection')).toBe(UI + 'DocPerformance')
    expect(s.tab.history.pushes).toBe(2) // following the address made no steps of its own
    // Each was a nav:Navigate event in the change log, handled by nav:Follow.
    const f = s.store.factory
    const navigations = s.store.match(null, f.namedNode(NS.rdf + 'type'), f.namedNode(NAV + 'Navigate'))
    expect(navigations.length).toBe(4)
    expect(s.store.match(navigations[0]!.subject, f.namedNode(NS.beh + 'handledBy'), f.namedNode(NAV + 'Follow')).length).toBe(1)
  })

  it('opens deep links where they point', async () => {
    const perf = await site('/#docs/performance')
    expect([...perf.document.querySelectorAll('[data-sem-c=bar-chart]')].some(perf.visible)).toBe(true)
    const signin = await site('/#examples/signin')
    expect(signin.value(UI + 'example')).toBe(UI + 'ExSignin')
    expect([...signin.document.querySelectorAll('[data-sem-c=code-input]')].some(signin.visible)).toBe(true)
    const group = await site('/#components/inputs')
    expect(group.value(UI + 'galleryGroup')).toBe(UI + 'GroupInputs')
  })

  it('ignores what it does not know, safely', async () => {
    for (const [start, page, address] of [
      ['/#nowhere/at/all', UI + 'Home', '#home'],
      ['/#docs/nonsense', UI + 'Docs', '#docs/overview'],
      ['/#docs/rules/extra/segments', UI + 'Docs', '#docs/rules'],
      ['/#docs/%E0%A4%A', UI + 'Docs', '#docs/overview'],
      ['/#home/rules', UI + 'Home', '#home'], // the docs section does not apply on the home page
    ] as const) {
      const s = await site(start)
      expect(s.value(UI + 'page'), start).toBe(page)
      expect(s.tab.address, start).toBe(address)
    }
    const s = await site('/')
    s.tab.visit('#examples/no-such-example')
    expect(s.value(UI + 'page')).toBe(UI + 'Examples')
    expect(s.value(UI + 'example')).toBe(UI + 'ExTodo')
  })

  it('keeps other query parameters (the host’s own) as they are', async () => {
    const s = await site('/?store=n3&prefer=function#examples/kanban')
    expect(s.value(UI + 'example')).toBe(UI + 'ExKanban')
    s.set(UI + 'page', UI + 'Home')
    await tick()
    expect(s.tab.address).toBe('?store=n3&prefer=function#home')
  })

  it('takes the address over storage, and storage over the default (nav:rank)', async () => {
    const backends = storage()
    const a = await site('/#docs/rules', backends)
    await a.persistence!.flush()
    expect(await backends[PER + 'Session']!.get('semblance:' + UI + 'atDocSection')).toContain('DocRules')
    // Remembered once, by the location: the settings policy no longer covers it.
    expect(await backends[PER + 'Session']!.get('semblance:' + UI + 'rememberSettings')).toBeUndefined()

    expect((await site('/#docs/layers', backends)).value(UI + 'docSection')).toBe(UI + 'DocLayers') // the address
    expect((await site('/#docs', backends)).value(UI + 'docSection')).toBe(UI + 'DocRules') // storage
    expect((await site('/#docs', storage())).value(UI + 'docSection')).toBe(UI + 'DocOverview') // the default
    const back = await site('/#home', backends)
    back.set(UI + 'page', UI + 'Docs')
    await tick()
    expect(back.tab.address).toBe('#docs/rules') // the page is found where it was left
  })
})

// --- a location of its own: carriers, scope, history ---------------------------------------------

const TINY = `
@prefix ex: <https://example.org/nav#> . @prefix nav: <${NAV}> . @prefix per: <${PER}> . @prefix sem: <${NS.sem}> .
@prefix xsd: <${NS.xsd}> . @prefix rdfs: <${NS.rdfs}> .
ex:app ex:view ex:List ; ex:panel ex:Closed ; ex:zoom 1 ; ex:dense false .
ex:view rdfs:range ex:View . ex:List a ex:View ; sem:slug "list" . ex:Board a ex:View ; sem:slug "board" .
ex:panel rdfs:range ex:Panel . ex:Closed a ex:Panel ; sem:slug "closed" . ex:Open a ex:Panel ; sem:slug "open" .
ex:zoom rdfs:range xsd:integer . ex:dense rdfs:range xsd:boolean .
ex:here a nav:Location ; nav:dimensions ( ex:atView ex:atZoom ex:atPanel ex:atDense ) .
ex:atView a nav:Dimension ; nav:subject ex:app ; nav:property ex:view ; nav:carriedBy nav:Fragment .
ex:atZoom a nav:Dimension ; nav:subject ex:app ; nav:property ex:zoom ; nav:carriedBy nav:Query ; nav:history nav:NoHistory ;
    nav:parent ex:atView ; nav:when ex:Board .
ex:atPanel a nav:Dimension ; nav:subject ex:app ; nav:property ex:panel ; nav:carriedBy per:Session .
ex:atDense a nav:Dimension ; nav:subject ex:app ; nav:property ex:dense ; nav:key "d" ; nav:carriedBy nav:Query , per:Device .
`
async function tiny(start: string, backends = storage()) {
  const t = tab(start)
  const store = loadStore('oxigraph', TINY)
  const persistence = new Persistence(store, backends, { delayMs: 60_000 })
  await persistence.restore()
  const navigation = new Navigation(store, { location: t.location, history: t.history, events: t.events, persistence })
  await navigation.restore()
  const runtime = new Runtime(store)
  persistence.attach(runtime)
  navigation.attach(runtime)
  const f = store.factory
  const ex = (l: string) => f.namedNode('https://example.org/nav#' + l)
  const value = (p: string) => store.match(ex('app'), ex(p), null)[0]?.object.value
  const set = (p: string, o: Parameters<typeof f.quad>[2]) => runtime.apply({ remove: store.match(ex('app'), ex(p), null), add: [f.quad(ex('app'), ex(p), o)] })
  return { tab: t, store, runtime, persistence, navigation, ex, value, set, f, backends }
}

describe('navigation: carriers, scope and history, declared', () => {
  it('carries a query parameter only in scope, literals typed by their range, without history when it says so', async () => {
    const t = await tiny('/?zoom=3&d=true#board')
    expect(t.value('view')).toBe('https://example.org/nav#Board')
    expect(t.value('zoom')).toBe('3')
    expect(t.value('dense')).toBe('true')
    t.set('zoom', t.f.literal('4', t.f.namedNode(NS.xsd + 'integer')))
    await tick()
    expect(t.tab.address).toBe('?zoom=4&d=true#board')
    expect(t.tab.history.pushes).toBe(0) // nav:NoHistory: in place
    t.set('view', t.ex('List'))
    await tick()
    expect(t.tab.address).toBe('?d=true#list') // zoom applies only to the board
    expect(t.tab.history.pushes).toBe(1)
    const bad = await tiny('/?zoom=big&d=maybe#list')
    expect(bad.value('zoom')).toBe('1')
    expect(bad.value('dense')).toBe('false')
  })

  it('keeps a dimension carried only by storage out of the address, and restores it from there', async () => {
    const a = await tiny('/#list')
    a.set('panel', a.ex('Open'))
    await tick()
    expect(a.tab.address).toBe('?d=false#list')
    expect(a.tab.history.pushes).toBe(0)
    await a.persistence.flush()
    const b = await tiny('/#list', a.backends)
    expect(b.value('panel')).toBe('https://example.org/nav#Open')
    expect(b.store.match(null, b.f.namedNode(NS.rdf + 'type'), b.f.namedNode(PER + 'Restore')).length).toBeGreaterThan(0)
  })

  it('reads ranks from the graph: storage can outrank the address', async () => {
    const a = await tiny('/?d=true#list')
    await a.persistence.flush()
    const store = loadStore('oxigraph', TINY)
    const f = store.factory
    // Make this device's storage win over the query for every dimension it carries.
    for (const q of store.match(f.namedNode(PER + 'Device'), f.namedNode(NAV + 'rank'), null)) store.delete(q)
    store.add(f.quad(f.namedNode(PER + 'Device'), f.namedNode(NAV + 'rank'), f.literal('0', f.namedNode(NS.xsd + 'integer'))))
    const persistence = new Persistence(store, a.backends)
    await persistence.restore()
    const t = tab('/?d=false#list')
    await new Navigation(store, { location: t.location, history: t.history, events: t.events, persistence }).restore()
    expect(store.match(f.namedNode('https://example.org/nav#app'), f.namedNode('https://example.org/nav#dense'), null)[0]!.object.value).toBe('true')
  })
})

// --- links to resources, and bringing them into view ----------------------------------------------

describe('navigation: links to resources', () => {
  it('finds where a resource is shown: the page and the group of a gallery specimen', async () => {
    const s = await site('/')
    const r = { f: s.store.factory, match: (a: never, p: string | null, o: never) => s.store.match(a, p ? s.store.factory.namedNode(p) : null, o) }
    const loc = readLocations(r).find((l) => l.iri === UI + 'location')!
    const needs = shows(r, loc, s.store.factory.namedNode(UI + 'inp-codes-spec'))!
    expect(Object.fromEntries([...needs].map(([d, v]) => [d.slice(UI.length), v.value.slice(UI.length)]))).toEqual({ atPage: 'Components', atGalleryGroup: 'GroupInputs' })
    expect(addressOf(r, s.store.factory.namedNode(UI + 'inp-codes-spec'))).toBe('#components/inputs/inp-codes-spec')
    expect(addressOf(r, s.store.factory.namedNode(UI + 'DocRules'))).toBe(undefined) // not a component anywhere
  })

  it.each(['sparql', 'function'] as const)('renders a link to a resource with the address that shows it (%s)', (prefer) => {
    const ttl = `
@prefix ui: <${UI}> . @prefix c: <${NS.c}> . @prefix nav: <${NAV}> .
ui:app ui:page ui:A .
ui:A ui:key "a" . ui:B ui:key "b" .
ui:here a nav:Location ; nav:root ui:root ; nav:dimensions ( ui:atPage ui:atTarget ) .
ui:atPage a nav:Dimension ; nav:subject ui:app ; nav:property ui:page ; nav:keyProperty ui:key ; nav:carriedBy nav:Fragment .
ui:atTarget a nav:TargetDimension ; nav:subject ui:app ; nav:property nav:target ; nav:carriedBy nav:Fragment .
ui:root a c:Switch ; c:controls ui:app ; c:property ui:page ; c:cases ( ui:caseA ui:caseB ) .
ui:caseA c:when ui:A ; c:content ui:pageA . ui:caseB c:when ui:B ; c:content ui:pageB .
ui:pageA a c:Stack ; c:children ( ui:go ui:plain ) .
ui:go a c:Link ; c:label "See the field" ; c:to ui:field .
ui:plain a c:Link ; c:label "Fallback" ; c:to ui:nowhere ; c:href "#b" .
ui:pageB a c:Stack ; c:children ( ui:card ) .
ui:card a c:Flippable ; c:front ui:field .
ui:field a c:TextField ; c:label "Field" ; nav:anchor "the-field" .
`
    const store = loadStore('oxigraph', ttl)
    const runtime = new Runtime(store)
    const screen = runtime.project({ modality: MOD.Screen, prefer, name: 'screen', roots: [UI + 'root'] }, (e) => {
      throw e
    })
    const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    new DomRenderer(screen.index, document.getElementById('app')!, UI + 'root').flush()
    const links = [...document.querySelectorAll('a')]
    expect(links.find((a) => a.textContent === 'See the field')!.getAttribute('href')).toBe('#b/the-field')
    expect(links.find((a) => a.textContent === 'Fallback')!.getAttribute('href')).toBe('#b')
  })

  it('follows a link: the dimensions that show it, the target, and the target brought into view once rendered', async () => {
    const revealed: { iri: string; smooth: boolean }[] = []
    const frames: (() => void)[] = []
    let rendered = false
    const s = await site('/', undefined, {
      reveal: (iri, { smooth }) => (rendered ? (revealed.push({ iri, smooth }), true) : false),
      frame: (run) => frames.push(run),
    })
    s.tab.visit('#components/inputs/inp-codes-spec')
    expect(s.value(UI + 'page')).toBe(UI + 'Components')
    expect(s.value(UI + 'galleryGroup')).toBe(UI + 'GroupInputs')
    expect(s.value(NAV + 'target')).toBe(UI + 'inp-codes-spec')
    expect(s.tab.address).toBe('#components/inputs/inp-codes-spec')
    expect(s.shell.nodeOf(UI + 'inp-codes-spec/~root')).toBeDefined()
    // It waits for the target to be rendered.
    expect(revealed).toEqual([])
    rendered = true
    frames.shift()!()
    expect(revealed).toEqual([{ iri: UI + 'inp-codes-spec', smooth: true }])

    // Moving elsewhere leaves the target; Back comes to it again.
    s.set(UI + 'galleryGroup', UI + 'GroupLayout')
    await tick()
    expect(s.value(NAV + 'target')).toBeUndefined()
    expect(s.tab.address).toBe('#components/layout')
    s.tab.back()
    expect(s.value(NAV + 'target')).toBe(UI + 'inp-codes-spec')
    expect(revealed.length).toBe(2)
  })

  it('opens what hides the target: the tools window and the tab it is in, as part of the same step', async () => {
    const s = await site('/#docs/rules')
    const f = s.store.factory
    const o = (subject: string, p: string) => s.store.match(f.namedNode(subject), f.namedNode(p), null)[0]?.object.value
    expect(o(UI + 'tools', NS.c + 'open')).toBe('false')
    expect(o(UI + 'views', NS.c + 'selected')).toBe(UI + 'inspectorTab')
    s.tab.visit('#workbench')
    expect(o(UI + 'tools', NS.c + 'open')).toBe('true')
    expect(o(UI + 'views', NS.c + 'selected')).toBe(UI + 'queryTab')
    expect(s.value(UI + 'page')).toBe(UI + 'Docs') // the tools are on every page: where we are stays
    expect(s.tab.address).toBe('#docs/rules/workbench')
    expect(s.shell.nodeOf(UI + 'workbench/~root')).toBeDefined()
    // One navigation event did it all.
    const navigations = s.store.match(null, f.namedNode(NS.rdf + 'type'), f.namedNode(NAV + 'Navigate'))
    expect(navigations.length).toBe(1)
    // On load, too.
    const fresh = await site('/#workbench')
    expect(fresh.store.match(f.namedNode(UI + 'views'), f.namedNode(NS.c + 'selected'), null)[0]!.object.value).toBe(UI + 'queryTab')
  })

  it('expands an accordion item, selects a tab and turns a card over, declared per class (nav:reveal)', () => {
    const store = loadStore('oxigraph', `
@prefix ui: <${UI}> . @prefix c: <${NS.c}> . @prefix nav: <${NAV}> .
ui:here a nav:Location ; nav:root ui:root ; nav:dimensions ( ui:atTarget ) .
ui:atTarget a nav:TargetDimension ; nav:subject ui:app ; nav:property nav:target ; nav:carriedBy nav:Fragment .
ui:root a c:Stack ; c:children ( ui:acc ) .
ui:acc a c:Accordion ; c:items ( ui:one ui:two ) .
ui:one a c:AccordionItem ; c:content ui:tabs . ui:two a c:AccordionItem ; c:expanded true .
ui:tabs a c:Tabs ; c:tabs ( ui:t1 ui:t2 ) ; c:selected ui:t1 .
ui:t2 a c:Tab ; c:content ui:card .
ui:card a c:Flippable ; c:front ui:face ; c:back ui:deep .
ui:deep a c:Text .`)
    const f = store.factory
    const r = { f, match: (a: never, p: string | null, o: never) => store.match(a, p ? f.namedNode(p) : null, o) }
    const loc = readLocations(r)[0]!
    const d = opening(r, loc, f.namedNode(UI + 'deep'))
    const said = Object.fromEntries(d.add.map((q) => [q.subject.value.slice(UI.length) + ' ' + q.predicate.value.slice(NS.c.length), q.object.value.replace(UI, '')]))
    expect(said).toEqual({ 'one expanded': 'true', 'tabs selected': 't2', 'card flipped': 'true' })
    expect(d.remove.map((q) => q.object.value)).toEqual([UI + 't1'])
  })

  it('goes straight to a target from its anchor alone, on load, without motion when the shell asks for less', async () => {
    const revealed: { iri: string; smooth: boolean }[] = []
    const s = await site('/#inp-codes-spec', undefined, { reveal: (iri, { smooth }) => (revealed.push({ iri, smooth }), true) })
    expect(s.value(UI + 'page')).toBe(UI + 'Components')
    expect(s.tab.address).toBe('#components/inputs/inp-codes-spec')
    expect(revealed).toEqual([{ iri: UI + 'inp-codes-spec', smooth: true }])
    const f = s.store.factory
    s.runtime.apply({ remove: s.store.match(f.namedNode(UI + 'shell'), f.namedNode(NS.mot + 'preference'), null), add: [f.quad(f.namedNode(UI + 'shell'), f.namedNode(NS.mot + 'preference'), f.namedNode(NS.mot + 'Reduced'))] })
    s.tab.visit('#components/inputs/inp-text-spec')
    expect(revealed.at(-1)).toEqual({ iri: UI + 'inp-text-spec', smooth: false })
  })
})
