// nav:Follow in SPARQL (#7): the reaction pair that reads an address into the graph (sx:decodeURI,
// sx:matches) gives the same change as its function twin (followDelta, readAddress), for every page
// of the site, targets, addresses from before paths, the query, and text it does not know; and a tab
// driven through the same addresses shows the same page either way.
import type { Quad } from '@rdfjs/types'
import { describe, expect, it } from 'vitest'
import { followDelta, readLocations, routesOf } from '../src/navigation.ts'
import { loadStore } from '../src/node/load.ts'
import { NS } from '../src/ns.ts'
import { prefixesFor } from '../src/prefixes.ts'
import type { GraphStore } from '../src/store/types.ts'
import { mountNavigating } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const NAV = NS.nav

const reader = (store: GraphStore) => {
  const f = store.factory
  return { f, match: (a: never, p: string | null, o: never) => store.match(a, p ? f.namedNode(p) : null, o, f.defaultGraph()) }
}

/** The change the SPARQL pair makes for an address (the event's beh:value), over the reaction's graphs. */
function sparqlFollow(store: GraphStore, location: string, graphs: Quad['graph'][]) {
  const f = store.factory
  const pair = (p: string) => store.match(f.namedNode(NAV + 'Follow'), f.namedNode(NS.beh + p), null)[0]!.object.value
  const event = f.namedNode('urn:test:navigate')
  return (address: string) => {
    const value = f.quad(event, f.namedNode(NS.beh + 'value'), f.literal(address))
    store.add(value)
    try {
      const run = (q: string) => store.construct((prefixesFor(store) + '\n' + q).replaceAll('$event', `<${event.value}>`).replaceAll('$this', `<${location}>`), graphs)
      return { remove: run(pair('deletes')), add: run(pair('inserts')) }
    } finally {
      store.delete(value)
    }
  }
}

const key = (q: Quad) => `${q.subject.value} ${q.predicate.value} ${q.object.termType}:${q.object.value}${q.object.termType === 'Literal' ? '^^' + q.object.datatype.value : ''}`
const set = (qs: Quad[]) => [...new Set(qs.map(key))].sort()

/** The addresses on which the function and the SPARQL pair disagree, with both changes. */
function disagreements(store: GraphStore, location: string, graphs: Quad['graph'][], addresses: string[]) {
  const r = reader(store)
  const loc = readLocations(r).find((l) => l.iri === location)!
  const sparql = sparqlFollow(store, location, graphs)
  const bad: string[] = []
  for (const address of addresses) {
    const fn = followDelta(r, loc, address)
    const sq = sparql(address)
    const a = JSON.stringify({ add: set(fn.add), remove: set(fn.remove) })
    const b = JSON.stringify({ add: set(sq.add), remove: set(sq.remove) })
    if (a !== b) bad.push(`${address}\n  function ${a}\n  sparql   ${b}`)
  }
  return bad
}

function tab(start = '/') {
  let url = new URL(start, 'https://semblance.test/')
  const events = new EventTarget()
  const location = {
    get pathname() {
      return url.pathname
    },
    get search() {
      return url.search
    },
    get hash() {
      return url.hash
    },
  }
  const history = {
    pushState(_d: unknown, _u: string, to: string) {
      url = new URL(to, url)
    },
    replaceState(_d: unknown, _u: string, to: string) {
      url = new URL(to, url)
    },
  }
  return { location, history, events, visit: (to: string) => ((url = new URL(to, url)), events.dispatchEvent(new Event('popstate'))) }
}

describe('nav:Follow in SPARQL', () => {
  it('changes what its function twin changes, for every page of the site and odd addresses', async () => {
    const t = tab()
    const s = await mountNavigating({ location: t.location, history: t.history, events: t.events }, undefined, 'sparql', 'wat')
    const f = s.store.factory
    const loc = readLocations(reader(s.store)).find((l) => l.iri === UI + 'location')!
    // Every page, a sample of the reference's terms (they are read alike), and each with a target.
    const routes = routesOf(reader(s.store), loc).filter((p, i) => !p.includes('/reference/') || i % 25 === 0)
    expect(routes.length).toBeGreaterThan(20)
    const addresses = [
      ...routes,
      ...routes.map((p) => p + '#inp-codes-spec'),
      ...['/', '#', '', '/#docs/rules', '/#nowhere/at/all', '/nowhere/at/all/', '/docs/nonsense/', '/docs/rules/extra/segments/', '/docs/%E0%A4%A/'],
      ...['/#docs/rules/extra/segments', '/home/rules/', '#examples/no-such-example', '/examples/kanban/?store=n3&prefer=function', '/#inp-codes-spec'],
      ...['/components/inputs/#inp-codes-spec', '#workbench', '/uk/docs/rules/', '/de/reference/c:Window/', '/reference/c:List/', '/reference/nope:Nope/'],
      ...['/index.html', '/uk/index.html', '/docs/rules/index.html', '/docs/rules/?x=1#inp-text-spec', '/uk/uk/docs/', '/docs/docs/rules/', '/%64ocs/rules/'],
      ...['/docs/rules/#c:Window', '/#uk/docs', '/components/#nothing-here', '/components/inputs/#no%20such', 'docs/rules/', '/docs//rules//'],
    ]
    const bad = disagreements(s.store, UI + 'location', [f.defaultGraph(), f.namedNode('urn:semblance:events'), s.screen.engine.graph], addresses)
    expect(bad.slice(0, 5).join('\n'), `${bad.length} of ${addresses.length} addresses`).toBe('')
  }, 120_000)

  it('reads the query, typed literals and a fragment-only location as its function twin does', () => {
    const store = loadStore(
      'wat',
      `@prefix ex: <https://example.org/nav#> . @prefix nav: <${NAV}> . @prefix per: <${NS.per}> . @prefix sem: <${NS.sem}> .
@prefix xsd: <${NS.xsd}> . @prefix rdfs: <${NS.rdfs}> .
ex:app ex:view ex:List ; ex:panel ex:Closed ; ex:zoom 1 ; ex:dense false ; ex:note "hi" .
ex:view rdfs:range ex:View . ex:List a ex:View ; sem:slug "list" . ex:Board a ex:View ; sem:slug "board" .
ex:panel rdfs:range ex:Panel . ex:Closed a ex:Panel ; sem:slug "closed" . ex:Open a ex:Panel ; sem:slug "open" .
ex:zoom rdfs:range xsd:integer . ex:dense rdfs:range xsd:boolean .
ex:here a nav:Location ; nav:dimensions ( ex:atView ex:atZoom ex:atPanel ex:atDense ex:atNote ) .
ex:atView a nav:Dimension ; nav:subject ex:app ; nav:property ex:view ; nav:carriedBy nav:Fragment .
ex:atZoom a nav:Dimension ; nav:subject ex:app ; nav:property ex:zoom ; nav:carriedBy nav:Query ; nav:history nav:NoHistory ;
    nav:parent ex:atView ; nav:when ex:Board .
ex:atPanel a nav:Dimension ; nav:subject ex:app ; nav:property ex:panel ; nav:carriedBy per:Session .
ex:atDense a nav:Dimension ; nav:subject ex:app ; nav:property ex:dense ; nav:key "d" ; nav:carriedBy nav:Query , per:Device .
ex:atNote a nav:Dimension ; nav:subject ex:app ; nav:property ex:note ; nav:carriedBy nav:Query .`,
    )
    const addresses = ['/?zoom=3&d=true#board', '/?zoom=4&d=true#list', '/?zoom=big&d=maybe#list', '#board', '?d=false', '?zoom=2&zoom=5#board']
    const more = ['?note=a+b%20c', '?note=%E0%A4%A&d=true', '?d&note=x', '?=1&note=', '#open', '#board/list', '?x=1&note=%26#board']
    expect(disagreements(store, 'https://example.org/nav#here', [store.factory.defaultGraph()], [...addresses, ...more]).join('\n')).toBe('')
  })

  it('shows the same pages, step by step, as the function does', async () => {
    const steps = ['/docs/rules/', '/uk/docs/layers/', '#examples/no-such-example', '/components/inputs/#inp-codes-spec', '/de/reference/c:Window/', '#workbench', '/nowhere/', '/examples/kanban/']
    const mounts = await Promise.all(
      (['sparql', 'function'] as const).map(async (prefer) => {
        const t = tab()
        const s = await mountNavigating({ location: t.location, history: t.history, events: t.events }, undefined, prefer, 'wat')
        // The SPARQL side has no function to fall back to.
        if (prefer === 'sparql') s.runtime.apply({ add: [], remove: s.store.match(s.store.factory.namedNode(NAV + 'Follow'), s.store.factory.namedNode(NS.sem + 'function'), null) })
        return { t, s }
      }),
    )
    const pages = new Set<string>()
    const dims = ['page', 'docSection', 'example', 'galleryGroup', 'referenceSubject'].map((p) => UI + p).concat(NS.l10n + 'language', NAV + 'target')
    for (const step of steps) {
      const seen = mounts.map(({ t, s }) => {
        t.visit(step)
        s.shell.flush()
        return { values: dims.map((p) => s.store.match(s.store.factory.namedNode(UI + 'app'), s.store.factory.namedNode(p), null).map((q) => q.object.value).join(' ')), html: s.document.getElementById('app')!.innerHTML }
      })
      expect(seen[0]!.values, step).toEqual(seen[1]!.values)
      pages.add(seen[0]!.values.join('|'))
      expect(seen[0]!.html === seen[1]!.html, step).toBe(true)
    }
    expect(pages.size).toBe(steps.length)
  }, 300_000)
})
