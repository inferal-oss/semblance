// What the ontology says has gone (ontology/layers/retired.ttl, src/retired.ts, #473).
import { DataFactory, Parser } from 'n3'
import { describe, expect, it, vi } from 'vitest'
import { MOD, NS } from '../src/ns.ts'
import { loadChanges } from '../src/migrate/changes.ts'
import { migrate, updateScript } from '../src/migrate/migrate.ts'
import { readChanges, readTerms, writeRetired } from '../src/migrate/versions.ts'
import { createStore, loadStore } from '../src/node/load.ts'
import { migrateAuthored, migrateQuads, type Retired, readRetired } from '../src/retired.ts'
import { Runtime } from '../src/runtime.ts'

const C = NS.c
const retired: Retired = { terms: new Set([C + 'old', C + 'gone']), renames: new Map([[C + 'old', C + 'now']]) }
const P = `@prefix c: <${C}> .\n@prefix sem: <${NS.sem}> .\n@prefix ex: <https://example.org/x#> .\n@prefix mig: <${NS.mig}> .\n`
const R = `c:old a sem:RetiredTerm ; mig:renamedTo c:now .\nc:gone a sem:RetiredTerm .\n`

describe('an authored graph', () => {
  it('reads what was renamed under its new name, and says what went', () => {
    const r = migrateAuthored(`${P}ex:a c:old 1 ; c:gone 2 ; c:kept 3 .\nex:r sem:construct """CONSTRUCT { ?a c:old 1 } WHERE { ?a c:now 2 }""" .`, retired)
    expect(r.text).toContain('ex:a c:now 1 ; c:gone 2 ; c:kept 3')
    expect(r.text).toContain('CONSTRUCT { ?a c:now 1 }')
    expect(r.moved).toEqual([C + 'old'])
    expect(r.gone).toEqual([C + 'gone'])
  })
  it('costs nothing while nothing has gone', () => {
    const text = `${P}ex:a c:old 1 .`
    expect(migrateAuthored(text, { terms: new Set(), renames: new Map() }).text).toBe(text)
  })
})

describe('remembered state', () => {
  const f = DataFactory
  const q = (p: string) => f.quad(f.namedNode('https://example.org/x#a'), f.namedNode(C + p), f.literal('1'))
  const out = (p: string) => migrateQuads([q(p) as never], retired, f as never)
  it('is carried across a rename', () => expect(out('old')![0]!.predicate.value).toBe(C + 'now'))
  it('is dropped when it names what went', () => expect(out('gone')).toBeUndefined())
  it('is left alone otherwise', () => expect(out('kept')![0]!.predicate.value).toBe(C + 'kept'))
})

describe('rules that still produce a retired term', () => {
  const app = (extra: string) => `${P}@prefix rdfs: <${NS.rdfs}> .
@prefix owl: <${NS.owl}> .
ex:T a owl:Class ; rdfs:subClassOf sem:Component ; sem:slug "ex-t" .
ex:TR a sem:Rendering ; sem:targets ex:T ; sem:stratum 0 .
ex:TR-sparql a sem:Rule ; sem:implements ex:TR ; sem:construct """CONSTRUCT { $this c:old 1 } WHERE { $this a <https://example.org/x#T> }""" .
ex:a a ex:T .
ex:b a ex:T .
${extra}`
  const run = (extra: string) => {
    const store = loadStore('wat', app(extra))
    const runtime = new Runtime(store)
    const reads = vi.spyOn(store, 'match')
    const screen = runtime.project({ modality: MOD.Screen, name: 'screen', roots: ['https://example.org/x#a', 'https://example.org/x#b'] }, (e) => {
      throw e
    })
    return { store, screen, reads }
  }
  it('are reported once a term, and left as they are', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, screen } = run(R)
    const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(C + 'old'))
    expect(said).toHaveLength(1)
    expect(said[0]).toContain(C + 'now')
    expect(store.match(null, store.factory.namedNode(C + 'old'), null, screen.engine.graph).length).toBe(2)
    warn.mockRestore()
  })
  it('are not reported when nothing has retired', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    run('')
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('has gone'))).toEqual([])
    warn.mockRestore()
  })
  it('cost the same as rules that do not: the list is read once, then a lookup per triple', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const count = (r: ReturnType<typeof run>) => r.reads.mock.calls.filter((c) => c[2]?.value === NS.sem + 'RetiredTerm').length
    const [without, withRetired] = [run(''), run(R)]
    expect(count(withRetired)).toBe(1)
    expect(count(without)).toBe(1)
    expect(withRetired.screen.engine.stats.ruleRuns).toBe(without.screen.engine.stats.ruleRuns)
    // Reading the renames is the one read more.
    expect(withRetired.reads.mock.calls.length).toBe(without.reads.mock.calls.length + 1)
    warn.mockRestore()
  })
})

describe('the generated list', () => {
  const CHANGE = `${P}@prefix chg: <${NS.chg}> .\n@prefix change: <https://semblance.dev/change/> .\n@prefix rdfs: <${NS.rdfs}> .\n`
  const body = `rdfs:label "L" ; chg:motivation "m" ; chg:substance "s" ; chg:forwardGuide "f" ; chg:backwardGuide "b" ; chg:affects c:T`
  const text = `${CHANGE}change:a a chg:Change ; ${body} ; chg:migrations ( change:a1 ) . change:a1 a mig:Migration ; mig:of c:T ; mig:from 1 ; mig:to 2 ; mig:renames [ mig:old c:one ; mig:new c:two ] .
change:b a chg:Change ; ${body} ; chg:migrations ( change:b1 ) . change:b1 a mig:Migration ; mig:of c:T ; mig:from 2 ; mig:to 3 ; mig:renames [ mig:old c:two ; mig:new c:three ] .`
  it('follows a chain of renames to the name of today, and a page reads it', () => {
    const changes = readChanges([text], '')
    const out = writeRetired(readTerms(`${P}c:one a sem:RetiredTerm .\nc:two a sem:RetiredTerm .\nc:dead a sem:RetiredTerm .\n`), changes)
    expect(() => new Parser().parse(out)).not.toThrow()
    const store = createStore('wat')
    store.loadTurtle(out)
    const r = readRetired(store)
    expect(r.renames.get(C + 'one')).toBe(C + 'three')
    expect(r.renames.get(C + 'two')).toBe(C + 'three')
    expect(r.terms.has(C + 'dead')).toBe(true)
  })
  it('--update takes a store across the same changes as the files', async () => {
    const changes = loadChanges([text])
    const data = `${P}ex:a c:one 1 . ex:b ex:p c:one .`
    const moved = await migrate({ files: [{ path: 'd.ttl', text: data }], changes, from: '0' })
    const dump = (s: ReturnType<typeof createStore>) => s.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', [s.factory.defaultGraph()]).map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`).sort()
    const [viaFiles, viaUpdate] = [createStore('wat'), createStore('wat')]
    viaFiles.loadTurtle(moved.files[0]!.text)
    viaUpdate.loadTurtle(data)
    await viaUpdate.update!(updateScript(changes))
    expect(dump(viaUpdate)).toEqual(dump(viaFiles))
  })
})
