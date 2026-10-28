// The WAT and Rust builds of Semblance's engine match one to one (#13): the same W3C failures,
// and the same results on Semblance's own queries over the site's graph, interpreted and compiled.
// Results are compared by term (blank nodes as one: they are fresh per run), never by id.
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import '../src/behaviour/events.ts'
import { SPARQL_PREFIXES } from '../src/ns.ts'
import { DEFAULT_GRAPH, Engine, EngineError, Form, Format, Kind, type Query } from '../rdf-engine/host/engine.ts'
import { semblanceQueries } from '../rdf-engine/host/parse-check.ts'
import { type EngineStore, engineStoreHooks } from '../rdf-engine/host/store.ts'
import { mountShell } from './harness.ts'

const KINDS = ['rust', 'wat'] as const
const wasm = (k: string) => new URL(`../rdf-engine/build/${k}.wasm`, import.meta.url)
const built = KINDS.every((k) => existsSync(wasm(k)))

describe('W3C conformance results', () => {
  const results = (k: string) => JSON.parse(readFileSync(new URL(`../rdf-engine/conformance/results/${k}.json`, import.meta.url), 'utf8'))
  const [rust, wat] = KINDS.map(results)

  it('list the same failing tests for both builds', () => {
    expect(Object.keys(wat.failing).sort()).toEqual(Object.keys(rust.failing).sort())
  })

  it('count the same per suite, against the same rdf-tests commit', () => {
    expect(wat.rdfTests).toBe(rust.rdfTests)
    expect(wat.summary).toEqual(rust.summary)
    expect([...wat.spelling].sort()).toEqual([...rust.spelling].sort())
  })
})

/** A term of `e` as text, the same in every build. */
function termText(e: Engine, id: number): string {
  if (!id) return '-'
  switch (e.kind(id)) {
    case Kind.Iri:
      return `<${e.value(id)}>`
    case Kind.BlankNode:
      return '_'
    case Kind.Literal: {
      const lang = e.lang(id)
      return JSON.stringify(e.value(id)) + (lang ? `@${lang}--${e.direction(id)}` : `^^${e.value(e.datatype(id))}`)
    }
    case Kind.Triple:
      return `<<${e.tripleParts(id).map((p) => termText(e, p)).join(' ')}>>`
    case Kind.DefaultGraph:
      return 'DEFAULT'
    default:
      return `?${e.kind(id)}`
  }
}

/** Term `id` of `from`, interned in `to` (blank nodes by label). */
function transfer(from: Engine, to: Engine, id: number, memo: Map<number, number>): number {
  let t = memo.get(id)
  if (t !== undefined) return t
  switch (from.kind(id)) {
    case Kind.Iri:
      t = to.iri(from.value(id))
      break
    case Kind.BlankNode:
      t = to.bnode(from.value(id))
      break
    case Kind.Literal: {
      const lang = from.lang(id)
      t = lang ? to.langLiteral(from.value(id), lang, from.direction(id)) : to.literal(from.value(id), transfer(from, to, from.datatype(id), memo))
      break
    }
    case Kind.Triple: {
      const [s, p, o] = from.tripleParts(id)
      t = to.triple(transfer(from, to, s, memo), transfer(from, to, p, memo), transfer(from, to, o, memo))
      break
    }
    default:
      t = DEFAULT_GRAPH
  }
  memo.set(id, t)
  return t
}

/** A run's results as sorted text rows; 'error: …' when it fails, undefined when it ran out of steps. */
function results(e: Engine, q: Query, graphs: number[], compiled: boolean, throwOnError = false): string | undefined {
  try {
    if (compiled && q.compile() !== null) return 'declined'
    const r = q.run(graphs)
    if (r.form === Form.Ask) return String(r.value)
    const width = r.form === Form.Select ? r.vars.length : 3
    const ids = r.form === Form.Select ? r.rows : r.triples
    const rows: string[] = []
    for (let i = 0; i < ids.length; i += width) rows.push(Array.from(ids.subarray(i, i + width), (id) => termText(e, id)).join(' '))
    rows.sort()
    // CONSTRUCT results are a set; SELECT keeps duplicates (and their count).
    return r.form === Form.Select ? `${r.vars.join(',')}: ${rows.join('\n')}` : [...new Set(rows)].join('\n')
  } catch (err) {
    if (throwOnError) throw err
    if (err instanceof EngineError && err.interrupted) return undefined
    return 'error'
  }
}

interface Call {
  text: string
  variable?: string
  values: string[]
  graphs: string[]
}

describe.skipIf(!built)('Semblance queries on both builds', () => {
  // The shell's graph after a visit to every page, on WAT, and every query it ran (with its foci).
  const calls: Call[] = []
  let recording: EngineStore | undefined
  engineStoreHooks.created = (store) => {
    recording = store
    const text = (ts: unknown[]) => (ts as Parameters<EngineStore['idOf']>[0][]).map((t) => store.idOf(t)).filter((x) => x).map((id) => termText(store.engine, id))
    const { construct, constructFor, select } = store
    store.construct = (q, graphs) => (calls.push({ text: q, values: [], graphs: text(graphs) }), construct(q, graphs))
    store.select = (q, graphs) => (calls.push({ text: q, values: [], graphs: text(graphs) }), select(q, graphs))
    store.constructFor = (q, variable, values, graphs) => (calls.push({ text: q, variable, values: text(values), graphs: text(graphs) }), constructFor!(q, variable, values, graphs))
  }
  const shell = mountShell(5, 'wat', 'sparql')
  for (const page of ['Home', 'Docs', 'Components', 'Examples', 'Playground'] as const) shell.showPage(page)
  engineStoreHooks.created = undefined
  const source = recording!.engine

  // The same graph in a fresh engine of each build.
  const engines = Object.fromEntries(
    KINDS.map((k) => {
      const e = new Engine(new WebAssembly.Module(readFileSync(wasm(k))))
      const memo = new Map<number, number>()
      const quads = source.match()
      for (let i = 0; i < quads.length; i += 4) e.add(...([0, 1, 2, 3].map((j) => transfer(source, e, quads[i + j]!, memo)) as [number, number, number, number]))
      return [k, { e, ids: new Map([...memo].map(([from, to]) => [termText(source, from), to])) }]
    }),
  ) as Record<(typeof KINDS)[number], { e: Engine; ids: Map<string, number> }>
  // A term by its text in an engine (those the calls name are in the graph or were interned while recording).
  const idOf = (k: (typeof KINDS)[number], text: string) => engines[k].ids.get(text) ?? 0

  const FUEL = 20_000_000

  it('hold the same graph', () => {
    expect(engines.wat.e.quadCount()).toBe(source.quadCount())
    expect(engines.rust.e.quadCount()).toBe(source.quadCount())
  })

  it('give the same results for every query the shell ran, interpreted and compiled', () => {
    const seen = new Set<string>()
    const mismatches: string[] = []
    let compared = 0
    for (const c of calls) {
      const key = JSON.stringify(c)
      if (seen.has(key)) continue
      seen.add(key)
      for (const compiled of [false, true]) {
        const out = KINDS.map((k) => {
          const { e } = engines[k]
          e.setFuel(FUEL)
          const q = e.prepare(c.text)
          try {
            if (c.variable) q.bindValues(c.variable, c.values.map((v) => idOf(k, v)).filter((x) => x))
            return results(e, q, c.graphs.map((g) => idOf(k, g)), compiled)
          } finally {
            q.release()
            e.setFuel()
          }
        })
        if (out.includes(undefined) || out.includes('declined')) continue
        compared++
        if (out[0] !== out[1]) mismatches.push(`${compiled ? 'compiled' : 'interpreted'}: ${c.text.split('\n').filter((l) => !/^PREFIX/i.test(l)).join(' ').slice(0, 300)}\n  rust ${out[0]!.slice(0, 300)}\n  wat  ${out[1]!.slice(0, 300)}`)
      }
    }
    expect(mismatches).toEqual([])
    expect(compared).toBeGreaterThan(500)
  }, 300_000)

  it('renders a populated Calendar through both genuine compiled paths', () => {
    const raw = semblanceQueries().find(q => q.includes('rdfhtml:class "sem-cal-grid"'))
    expect(raw).toBeDefined()
    const text = SPARQL_PREFIXES + '\n' + raw!
    const outputs: string[] = []
    for (const compiled of [false, true]) for (const kind of KINDS) {
      const { e } = engines[kind]
      const q = e.prepare(text)
      try {
        q.bind('this', e.iri('https://semblance.dev/demo#ex-calendar-week'))
        e.setFuel(FUEL)
        const before = { ...e.stats }
        let output: string | undefined
        try { output = results(e, q, [], compiled, true) }
        catch (cause) { throw new Error(`${kind} ${compiled ? 'compiled' : 'interpreted'} populated Calendar failed`, { cause }) }
        expect(output).toBeDefined()
        expect(output).not.toBe('')
        expect(output).not.toBe('error')
        expect(output).not.toBe('declined')
        if (compiled) {
          expect(q.isCompiled).toBe(true)
          expect(e.stats.compiledRuns - before.compiledRuns).toBe(1)
          expect(e.stats.fallbacks - before.fallbacks).toBe(0)
        }
        outputs.push(output!)
      } finally { q.release(); e.setFuel() }
    }
    for (const output of outputs) expect(output).toBe(outputs[0])
  }, 300_000)

  it('prepare the same corpus queries, and give the same results for them run on their own', () => {
    const prefixed = (q: string) => SPARQL_PREFIXES + '\nPREFIX ui: <https://semblance.dev/demo#>\nPREFIX ex: <https://example.org/todo#>\nPREFIX perf: <https://semblance.dev/ns/perf#>\n' + q
    const mismatches: string[] = []
    let compared = 0
    const corpus = semblanceQueries()
    for (const raw of corpus) {
      const text = prefixed(raw.replace(/\b(LIMIT|OFFSET)\s+\$\w+/g, '$1 1'))
      const params = [...new Set([...raw.matchAll(/\$(\w+)/g)].map((m) => m[1]!))]
      for (const compiled of [false, true]) {
        const out = KINDS.map((k) => {
          const { e } = engines[k]
          let q: Query
          try {
            q = e.prepare(text)
          } catch {
            return 'unprepared'
          }
          e.setFuel(FUEL)
          try {
            // Parameters bound to the app's node, the way a rule's $this is bound to a focus.
            for (const p of params) q.bind(p, e.iri('https://semblance.dev/demo#app'))
            return results(e, q, [], compiled)
          } finally {
            q.release()
            e.setFuel()
          }
        })
        if (out.includes(undefined) || out.includes('declined')) continue
        compared++
        if (out[0] !== out[1]) mismatches.push(`${compiled ? 'compiled' : 'interpreted'}: ${raw.split('\n').filter((l) => !/^PREFIX/i.test(l)).join(' ').slice(0, 300)}\n  rust ${out[0]!.slice(0, 300)}\n  wat  ${out[1]!.slice(0, 300)}`)
      }
    }
    expect(mismatches).toEqual([])
    expect(compared).toBeGreaterThan(corpus.length)
  }, 300_000)

  it('give the same results for the calendar rules on a calendar, within the budget (#190)', () => {
    // A UNION of branches joined with the calendar's row: one branch's subquery projects ?dayP,
    // which must not stop the others from being passed it (Rust ran them for every property's
    // range, out of its budget interpreted and out of memory compiled).
    const data = `@prefix c: <https://semblance.dev/ns/component#> . @prefix ex: <https://example.org/cal#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix sem: <https://semblance.dev/ns/core#> . @prefix sh: <http://www.w3.org/ns/shacl#> .
      ex:cal a c:Calendar ; c:dayProperty ex:day ; c:startProperty ex:start ; c:durationProperty ex:dur ; c:entryTitle rdfs:label ;
        c:entry ex:m1 , ex:m2 , ex:m3 ; c:label "Rooms" ; c:fromHour 9 .
      ex:day rdfs:range ex:Day . ex:mon a ex:Day ; sem:order 1 ; rdfs:label "Mon" . ex:tue a ex:Day ; sem:order 2 ; rdfs:label "Tue" .
      ex:m1 a ex:Meeting ; ex:day ex:mon ; ex:start 10 ; ex:dur 1.5 ; rdfs:label "Standup" ; ex:room ex:r1 .
      ex:m2 a ex:Meeting ; ex:day ex:mon ; ex:start 10.5 ; ex:room ex:r1 . ex:m3 a ex:Meeting ; ex:day ex:tue ; ex:start 14 ; ex:room ex:r2 .
      ex:shape c:exclusiveBy ex:room ; sh:targetClass ex:Meeting .`
    const rules = semblanceQueries().filter((q) => /CONSTRUCT[^]*\$this a\/rdfs:subClassOf\* c:Calendar/.test(q))
    expect(rules.length).toBeGreaterThan(1)
    for (const k of KINDS) engines[k].e.load(Format.Turtle, data)
    for (const raw of rules)
      for (const compiled of [false, true]) {
        const out = KINDS.map((k) => {
          const { e } = engines[k]
          const q = e.prepare(SPARQL_PREFIXES + '\n' + raw)
          e.setFuel(FUEL)
          try {
            q.bind('this', e.iri('https://example.org/cal#cal'))
            return results(e, q, [], compiled)
          } finally {
            q.release()
            e.setFuel()
          }
        })
        expect(out[0], `${compiled ? 'compiled' : 'interpreted'}: ${raw.slice(0, 120)}`).toBe(out[1])
        expect(out[0]?.split('\n').length).toBeGreaterThan(10)
      }
  }, 300_000)
})
