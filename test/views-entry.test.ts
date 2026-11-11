// Maintained views on their own (src/views/, docs/VIEWS.md): the @inferal-oss/semblance/views entry
// over every built-in store that has SPARQL, with no ontology loaded. Changes come in as deltas
// (apply, write, load, a transaction), each one tick; each view hears its own change, and only it.
import type { Quad, Term } from '@rdfjs/types'
import { describe, expect, it } from 'vitest'
import { createViews, ManualClock, openStore, openViews, type Row, type ViewDelta, type Views } from '../src/views/node.ts'

const EX = 'https://example.org/v#'
const XSD = 'http://www.w3.org/2001/XMLSchema#'
const P = `PREFIX ex: <${EX}>\n`
const DATA = `@prefix ex: <${EX}> .
ex:a a ex:Todo ; ex:label "Write" ; ex:n 3 .
ex:b a ex:Todo ; ex:label "Read" ; ex:n 1 ; ex:done true .
ex:c a ex:Todo ; ex:label "Ask" ; ex:n 2 .
`
const OPEN = P + `SELECT ?todo ?label WHERE { ?todo a ex:Todo ; ex:label ?label FILTER NOT EXISTS { ?todo ex:done true } } ORDER BY ?label`

const labels = (rows: Row[]) => rows.map((r) => r.get('label')!.value)
const change = (d: ViewDelta) =>
  [...d.rows!.entries()]
    .map(([, r, w]) => `${w > 0 ? '+' : '-'}${r.get('label')!.value}`)
    .sort()
    .join(' ')

function tools(views: Views) {
  const f = views.store.factory
  const nn = (s: string) => f.namedNode(EX + s)
  const t = (s: string, p: string, o: Term): Quad => f.quad(nn(s), nn(p), o)
  const yes = f.literal('true', f.namedNode(XSD + 'boolean'))
  return { f, nn, t, yes }
}

describe.each(['wat', 'rust', 'oxigraph', 'hybrid'] as const)('views on their own, %s store', (kind) => {
  it('loads nothing but the data, and keeps a SELECT and a CONSTRUCT up to date', async () => {
    const views = await openViews({ kind, strict: true })
    expect(views.store.size?.() ?? views.store.match().length).toBe(0)
    views.load(DATA)
    const open = views.select(EX + 'open', OPEN)
    const labelsOf = views.construct(EX + 'labels', P + 'CONSTRUCT { ?t rdfs:label ?l } WHERE { ?t a ex:Todo ; ex:label ?l }')
    expect(open.strategy).toBe('incremental')
    expect(labels(open.orderedRows())).toEqual(['Ask', 'Write'])
    expect(labelsOf.quads().map((q) => q.object.value).sort()).toEqual(['Ask', 'Read', 'Write'])

    const heard: string[] = []
    const heardQuads: number[] = []
    open.subscribe((d) => heard.push(change(d)))
    labelsOf.subscribe((d) => heardQuads.push(d.quads!.size))
    const { t, yes, f } = tools(views)
    const tick = views.tick
    const applied = views.apply({ add: [t('a', 'done', yes)], remove: [] })
    expect(applied.add).toHaveLength(1)
    expect(views.tick).toBe(tick + 1)
    expect(labels(open.orderedRows())).toEqual(['Ask'])
    expect(heard).toEqual(['-Write'])
    // The CONSTRUCT did not change: it heard nothing.
    expect(heardQuads).toEqual([])

    // What the store already holds is no change: no tick, nothing heard.
    expect(views.apply({ add: [t('a', 'done', yes)], remove: [] }).add).toHaveLength(0)
    expect(views.tick).toBe(tick + 1)

    views.apply({ add: [t('d', 'label', f.literal('Zed')), f.quad(tools(views).nn('d'), f.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), tools(views).nn('Todo'))], remove: [] })
    expect(labels(open.orderedRows())).toEqual(['Ask', 'Zed'])
    expect(heard).toEqual(['-Write', '+Zed'])
    expect(heardQuads).toEqual([1])
    views.dispose(true)
  })

  it('takes a transaction in as one tick, consolidated', async () => {
    const views = await openViews({ kind, strict: true })
    views.load(DATA)
    const open = views.select(EX + 'open', OPEN)
    const heard: string[] = []
    open.subscribe((d) => heard.push(change(d)))
    const { t, yes, f } = tools(views)
    const tick = views.tick
    views.transaction(() => {
      views.apply({ add: [t('a', 'done', yes)], remove: [] })
      views.apply({ add: [t('c', 'label', f.literal('Ask again'))], remove: [t('c', 'label', f.literal('Ask'))] })
      // Added and removed again inside it: no change at all.
      views.apply({ add: [t('c', 'done', yes)], remove: [] })
      views.apply({ add: [], remove: [t('c', 'done', yes)] })
      // The store changes at once: the transaction reads its own writes.
      expect(views.store.has(f.quad(tools(views).nn('a'), tools(views).nn('done'), yes))).toBe(true)
    })
    expect(views.tick).toBe(tick + 1)
    expect(heard).toEqual(['+Ask again -Ask -Write'])
    expect(labels(open.orderedRows())).toEqual(['Ask again'])
    views.dispose(true)
  })

  it('reads the named graphs it is given, and since(tick) brings a reader up to date', async () => {
    const LOCAL = EX + 'local'
    const views = await openViews({ kind, graphs: [LOCAL], strict: true })
    views.load(DATA)
    const starred = views.select(EX + 'starred', P + `SELECT ?label WHERE { GRAPH <${LOCAL}> { ?todo ex:starred true } ?todo ex:label ?label }`)
    starred.keepHistory(10)
    const from = views.tick
    const { t, yes } = tools(views)
    views.write(LOCAL, { add: [t('a', 'starred', yes)], remove: [] })
    views.write(LOCAL, { add: [t('c', 'starred', yes)], remove: [] })
    views.write(LOCAL, { add: [], remove: [t('a', 'starred', yes)] })
    expect(labels(starred.orderedRows())).toEqual(['Ask'])
    const since = starred.since(from)!
    expect(since.tick).toBe(views.tick)
    expect([...since.rows.entries()].map(([, r, w]) => `${w}:${r.get('label')!.value}`)).toEqual(['1:Ask'])
    // A graph the views are not given is not read.
    views.write(EX + 'elsewhere', { add: [t('b', 'starred', yes)], remove: [] })
    expect(labels(starred.orderedRows())).toEqual(['Ask'])
    views.dispose(true)
  })

  it('keeps ORDER BY, LIMIT and GROUP BY in order as rows come and go', async () => {
    const views = await openViews({ kind, strict: true })
    views.load(DATA)
    const top = views.select(EX + 'top', P + 'SELECT ?label ?n WHERE { ?t ex:label ?label ; ex:n ?n } ORDER BY DESC(?n) LIMIT 2')
    const total = views.select(EX + 'total', P + 'SELECT (SUM(?n) AS ?sum) (COUNT(?t) AS ?count) WHERE { ?t ex:n ?n }')
    expect(labels(top.orderedRows())).toEqual(['Write', 'Ask'])
    const { t, f } = tools(views)
    const int = (n: number) => f.literal(String(n), f.namedNode(XSD + 'integer'))
    views.load(`@prefix ex: <${EX}> . ex:e ex:label "Eat" ; ex:n 5 .`)
    expect(labels(top.orderedRows())).toEqual(['Eat', 'Write'])
    views.apply({ add: [t('c', 'n', int(9))], remove: [t('c', 'n', int(2))] })
    expect(labels(top.orderedRows())).toEqual(['Ask', 'Eat'])
    expect(total.rows().map((r) => `${r.get('sum')!.value}/${r.get('count')!.value}`)).toEqual(['18/4'])
    views.dispose(true)
  })

  it('replaces a view hosted again under its IRI, and stops one unhosted', async () => {
    const views = await openViews({ kind })
    views.load(DATA)
    const first = views.select(EX + 'v', OPEN)
    let heard = 0
    first.subscribe(() => heard++)
    const second = views.select(EX + 'v', P + 'SELECT ?label WHERE { ?t ex:label ?label }')
    expect(views.view(EX + 'v')).toBe(second)
    expect(second.rows()).toHaveLength(3)
    views.unhost(EX + 'v')
    expect(views.view(EX + 'v')).toBeUndefined()
    const before = heard
    views.load(`@prefix ex: <${EX}> . ex:z a ex:Todo ; ex:label "New" .`)
    expect(heard).toBe(before)
    views.dispose(true)
  })
})

describe('views on their own', () => {
  it('refuses a store with no SPARQL (N3), saying which have it', async () => {
    const views = createViews(await openStore('n3'))
    expect(() => views.select(EX + 'open', OPEN)).toThrow(/no SPARQL.*wat, rust, oxigraph, hybrid/)
  })

  it('takes its clock, and advance() is a tick with no input', async () => {
    const clock = new ManualClock(Date.parse('2026-11-10T12:00:00Z'))
    const views = await openViews({ kind: 'wat', clock })
    expect(views.runtime.clock).toBe(clock)
    views.load(DATA)
    const open = views.select(EX + 'open', OPEN)
    let heard = 0
    open.subscribe(() => heard++)
    const tick = views.tick
    views.advance()
    expect(views.tick).toBe(tick + 1)
    expect(heard).toBe(0)
    views.dispose(true)
  })

  it('stops taking changes in once disposed', async () => {
    const views = await openViews({ kind: 'wat' })
    views.load(DATA)
    const open = views.select(EX + 'open', OPEN)
    views.dispose()
    const { t, yes } = tools(views)
    expect(views.apply({ add: [t('a', 'done', yes)], remove: [] }).add).toHaveLength(0)
    expect(labels(open.orderedRows())).toEqual(['Ask', 'Write'])
    views.store.dispose?.()
  })
})
