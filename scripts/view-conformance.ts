// Incremental W3C conformance for maintained views (docs/IVM.md §24, phase 5): every SPARQL query
// evaluation test of the W3C suites (rdf-engine/conformance; fetch them with
// `sh rdf-engine/conformance/fetch.sh`) whose query is a SELECT or CONSTRUCT becomes a view over an
// empty store; the test's data then arrives a few triples at a time in a seeded random order, some
// withdrawn and restored, then all withdrawn, and after every step the view must equal a
// from-scratch run of its query. A query the compiler cannot maintain is a fallback, listed with
// its reason.
//
//   npx tsx scripts/view-conformance.ts [--store oxigraph,wat] [--only <substring>] [-v] [--write]
//
// --write updates docs/IVM-CONFORMANCE.md. Blank nodes in the data are skolemized (a partition key
// is bound by VALUES, which cannot hold a blank node); the view and the oracle read the same data.
import type { Quad, Term } from '@rdfjs/types'
import { writeFileSync } from 'node:fs'
import * as ox from 'oxigraph'
import { loadManifest, readText, rdfFile, type Test } from '../rdf-engine/conformance/manifest.ts'
import { MIME } from '../rdf-engine/conformance/targets/oxigraph.ts'
import { createStore } from '../src/node/load.ts'
import { NS } from '../src/ns.ts'
import { IV, type MaintainedView, ManualClock, ViewRuntime } from '../src/view/runtime.ts'

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const kinds = (opt('--store') ?? 'oxigraph,wat').split(',') as ('oxigraph' | 'wat')[]
let kind = kinds[0]!
const only = opt('--only')
const MANIFESTS = ['sparql/sparql10/manifest-evaluation.ttl', 'sparql/sparql11/manifest-sparql11-query.ttl', 'sparql/sparql12/manifest.ttl']
/** Where the view's own definition lives: a graph no query reads. */
const DEFS = 'urn:semblance:view-definitions'
const VIEW = 'urn:semblance:conformance-view'
const SHORT = (id: string) =>
  id.replace('https://w3c.github.io/rdf-tests/sparql/', '').replace('http://www.w3.org/2009/sparql/docs/tests/data-sparql11/', 'sparql11/').replace('http://www.w3.org/2001/sw/DataAccess/tests/data-r2/', 'sparql10/').replace('/manifest#', '#')

type Outcome = { status: 'incremental' | 'fallback' | 'mismatch' | 'error' | 'skip'; reason?: string; steps?: number }

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function parse(file: string, graph?: string): Quad[] {
  const f = rdfFile(file)
  return ox.parse(f.text, { format: MIME[f.format], base_iri: f.base, to_graph_name: graph ? ox.namedNode(graph) : ox.defaultGraph() }) as unknown as Quad[]
}

const message = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 160)

function run(t: Test, seed: number): Outcome {
  if (t.type !== 'QueryEvaluationTest' || !t.query) return { status: 'skip', reason: t.type }
  // Relative IRIs in a test's query are relative to its file.
  const query = `BASE <${t.query}>\n` + readText(t.query)
  const bare = query.replace(/"[^"\n]*"|'[^'\n]*'|<[^>\s]*>|#[^\n]*/g, '')
  const form = /\b(SELECT|CONSTRUCT|ASK|DESCRIBE)\b/i.exec(bare)?.[1]?.toUpperCase()
  if (form !== 'SELECT' && form !== 'CONSTRUCT') return { status: 'skip', reason: form ? `${form} query` : 'no query form' }
  if (/\bFROM\b/i.test(bare)) return { status: 'skip', reason: 'FROM / FROM NAMED (a view reads its own graphs)' }
  let data: Quad[]
  const store = createStore(kind)
  const f = store.factory
  try {
    const skolem = (x: Term): Term => (x.termType === 'BlankNode' ? f.namedNode('urn:skolem:' + x.value) : x)
    data = [...t.data.flatMap((d) => parse(d)), ...t.graphData.flatMap((g) => parse(g.file, g.name))].map((q) =>
      f.quad(skolem(q.subject) as never, q.predicate, skolem(q.object) as never, q.graph.termType === 'DefaultGraph' ? f.defaultGraph() : f.namedNode(q.graph.value)),
    )
  } catch (e) {
    return { status: 'skip', reason: 'data: ' + message(e) }
  }
  // A query the store itself cannot run is not the views' to maintain.
  try {
    const probe = createStore(kind)
    if (form === 'SELECT') probe.select(query, [probe.factory.defaultGraph()] as never)
    else probe.construct(query, [probe.factory.defaultGraph()] as never)
  } catch (e) {
    return { status: 'skip', reason: 'the store refuses it: ' + message(e) }
  }
  const v = f.namedNode(VIEW)
  const defs = f.namedNode(DEFS)
  store.add(f.quad(v, f.namedNode(NS.rdf + 'type'), f.namedNode(IV + 'View'), defs))
  store.add(f.quad(v, f.namedNode(form === 'SELECT' ? NS.sem + 'select' : NS.sem + 'construct'), f.literal(query), defs))
  const clock = new ManualClock()
  const views = new ViewRuntime(store, { graphs: t.graphData.map((g) => g.name), clock })
  try {
    views.start('sparql')
  } catch (e) {
    return { status: 'error', reason: 'start: ' + message(e) }
  }
  const view = views.view(VIEW) as MaintainedView | undefined
  if (!view) return { status: 'error', reason: 'no view' }
  if (view.strategy !== 'incremental') return { status: 'fallback', reason: view.fallback }
  const r = rng(seed)
  const order = data.map((q) => [r(), q] as const).sort((a, b) => a[0] - b[0]).map(([, q]) => q)
  let steps = 0
  const step = (add: Quad[], remove: Quad[]) => {
    const delta = { add: add.filter((q) => !store.has(q)), remove: remove.filter((q) => store.has(q)) }
    for (const q of delta.remove) store.delete(q)
    for (const q of delta.add) store.add(q)
    views.tick(delta)
    steps++
    const problem = view.compare(clock.now())
    if (problem) throw Object.assign(new Error(problem), { mismatch: true })
  }
  try {
    for (let i = 0; i < order.length; ) {
      const n = 1 + Math.floor(r() * 3)
      step(order.slice(i, i + n), [])
      i += n
      if (r() < 0.2 && i > 2) {
        const at = Math.floor(r() * i)
        const back = order.slice(at, at + 2)
        step([], back)
        step(back, [])
      }
    }
    for (let i = 0; i < order.length; i += 4) step([], order.slice(i, i + 4))
  } catch (e) {
    return { status: (e as { mismatch?: boolean }).mismatch ? 'mismatch' : 'error', reason: message(e), steps }
  }
  return { status: 'incremental', steps }
}

const tests = MANIFESTS.flatMap((m) => loadManifest(m)).filter((t) => !only || t.id.includes(only))
const sections: string[] = []
const warn = console.warn
for (const k of kinds) {
  kind = k
  const results: { t: Test; o: Outcome }[] = []
  console.warn = () => {}
  for (const [i, t] of tests.entries()) {
    let o: Outcome
    try {
      o = run(t, i + 1)
    } catch (e) {
      o = { status: 'error', reason: message(e) }
    }
    results.push({ t, o })
    if (args.includes('-v') || o.status === 'mismatch' || o.status === 'error') process.stdout.write(`${kind} ${o.status.padEnd(11)} ${SHORT(t.id)} ${o.reason ?? ''}\n`)
  }
  console.warn = warn
  const count = (s: Outcome['status']) => results.filter((x) => x.o.status === s).length
  const summary = `${count('incremental')} maintained, ${count('fallback')} fallbacks, ${count('mismatch')} mismatches, ${count('error')} errors (${count('skip')} skipped: not SELECT / CONSTRUCT, FROM, unreadable data, or a query the store refuses)`
  console.log(`${kind}: ${summary}`)
  const byReason = new Map<string, string[]>()
  for (const { t, o } of results) {
    if (o.status !== 'fallback' && o.status !== 'error' && o.status !== 'mismatch') continue
    const key = `${o.status}: ${o.reason}`
    byReason.set(key, [...(byReason.get(key) ?? []), SHORT(t.id)])
  }
  sections.push(
    `## ${kind === 'wat' ? 'WAT (Semblance’s engine)' : 'Oxigraph'}`,
    '',
    `**${summary}.**`,
    '',
    '| outcome: reason | tests |',
    '|---|---|',
    ...[...byReason].sort((a, b) => b[1].length - a[1].length).map(([reason, ids]) => `| ${reason.replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${ids.length}: ${ids.slice(0, 5).map((x) => '`' + x + '`').join(', ')}${ids.length > 5 ? ', …' : ''} |`),
    '',
  )
}

if (args.includes('--write')) {
  const lines = [
    '# Maintained views: incremental W3C conformance',
    '',
    'Generated by `npx tsx scripts/view-conformance.ts --write` (docs/IVM.md §24; fetch the suites first with',
    '`sh rdf-engine/conformance/fetch.sh`). Every SPARQL 1.0 / 1.1 / 1.2 query evaluation test whose query is a',
    "SELECT or CONSTRUCT is a view over an empty store; the test's data arrives a few triples at a time in a",
    'seeded random order (some withdrawn and restored, then all withdrawn), and after every step the view must',
    'equal a from-scratch run of its query on the same store. Blank nodes in the data are skolemized. A mismatch',
    'here is an engine evaluating the same query two ways differently (reported on #9).',
    '',
    ...sections,
  ]
  writeFileSync(new URL('../docs/IVM-CONFORMANCE.md', import.meta.url), lines.join('\n'))
}
