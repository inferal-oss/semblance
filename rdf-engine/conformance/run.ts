// W3C conformance runner: `npm run conformance -- [--target oxigraph] [--suite sparql12 ...] [--only <substring>] [-v]`
// Writes results/<target>.json (failures by test IRI) unless filtered with --only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { loadManifest, localPath, rdfFile, readText, ROOT, type Test } from './manifest.ts'
import { fromResultGraph, parseSrj, parseSrx } from './results.ts'
import type { Dataset, QueryResult, Target } from './target.ts'
import { oxigraph, oxParse } from './targets/oxigraph.ts'
import { isomorphic, key, type Row, rowKey } from './terms.ts'

export const SUITES: Record<string, string[]> = {
  sparql12: ['sparql/sparql12/manifest.ttl'],
  sparql11: ['sparql/sparql11/manifest-sparql11-query.ttl', 'sparql/sparql11/manifest-sparql11-update.ttl'],
  sparql10: ['sparql/sparql10/manifest-evaluation.ttl', 'sparql/sparql10/manifest-syntax.ttl'],
  rdf12: ['rdf/rdf12/rdf-turtle/manifest.ttl', 'rdf/rdf12/rdf-n-triples/manifest.ttl', 'rdf/rdf12/rdf-n-quads/manifest.ttl', 'rdf/rdf12/rdf-trig/manifest.ttl'],
}

const TARGETS: Record<string, () => Promise<Target>> = {
  oxigraph: async () => oxigraph,
  rust: async () => (await import('./targets/wasm.ts')).wasmTarget('rust'),
  wat: async () => (await import('./targets/wasm.ts')).wasmTarget('wat'),
}

type Outcome = { status: 'pass' } | { status: 'fail'; reason: string } | { status: 'skip'; reason: string }

const SKIPPED_APPROVALS = new Set(['Withdrawn', 'Rejected', 'NotApproved'])
const RDF_TEST = /^Test(Turtle|NTriples|NQuads|Trig|TriG)(PositiveSyntax|NegativeSyntax|Eval|NegativeEval)$/

const short = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 160)

function dataset(t: Test, query?: string): Dataset {
  const ds: Dataset = {
    default: t.data.map((d) => rdfFile(d)),
    named: t.graphData.map((g) => ({ name: g.name, file: rdfFile(g.file) })),
  }
  // FROM / FROM NAMED name files of the suite: provide them as named graphs.
  if (query) {
    for (const m of query.matchAll(/FROM\s+(?:NAMED\s+)?<([^>]*)>/gi)) {
      const name = new URL(m[1]!, t.query).href
      if (name.startsWith(ROOT) && existsSync(localPath(name)) && !ds.named.some((n) => n.name === name)) ds.named.push({ name, file: rdfFile(name) })
    }
  }
  return ds
}

function expected(file: string): QueryResult {
  if (file.endsWith('.srj')) return parseSrj(readText(file))
  if (file.endsWith('.srx')) return parseSrx(readText(file))
  const quads = oxParse(rdfFile(file))
  return fromResultGraph(quads) ?? { kind: 'graph', quads }
}

const triples = (rows: Row[]) => rows.map((r) => r.slice(0, 3))

/** `--show`: print actual and expected results of failing evaluation tests. */
let show = false
const render = (r: QueryResult) =>
  r.kind === 'boolean'
    ? String(r.value)
    : r.kind === 'graph'
      ? r.quads.map((q) => '  ' + rowKey(q.slice(0, 3))).join('\n')
      : r.rows.map((m) => '  ' + [...m].map(([k, v]) => `?${k}=${key(v)}`).join(' ')).join('\n')

function compare(actual: QueryResult, want: QueryResult, ordered: boolean): Outcome {
  if (actual.kind !== want.kind) return { status: 'fail', reason: `expected ${want.kind} result, got ${actual.kind}` }
  let same: boolean | undefined
  if (actual.kind === 'boolean') same = actual.value === (want as typeof actual).value
  else if (actual.kind === 'graph') same = isomorphic(triples(actual.quads), triples((want as typeof actual).quads), false)
  else {
    const w = want as typeof actual
    const vars = [...new Set([...actual.vars, ...w.vars, ...actual.rows.flatMap((r) => [...r.keys()]), ...w.rows.flatMap((r) => [...r.keys()])])].sort()
    const rows = (rs: Map<string, unknown>[]) => rs.map((r) => vars.map((v) => r.get(v))) as Row[]
    same = isomorphic(rows(actual.rows), rows(w.rows), ordered)
    if (same === false && ordered && isomorphic(rows(actual.rows), rows(w.rows), false)) return { status: 'fail', reason: 'wrong order' }
  }
  if (same === undefined) return { status: 'fail', reason: 'comparison too hard (blank nodes)' }
  return same ? { status: 'pass' } : { status: 'fail', reason: 'wrong result' }
}

function expectError(run: () => unknown): Outcome {
  try {
    run()
  } catch {
    return { status: 'pass' }
  }
  return { status: 'fail', reason: 'accepted invalid input' }
}

export function runTest(target: Target, t: Test): Outcome {
  if (t.approval && SKIPPED_APPROVALS.has(t.approval)) return { status: 'skip', reason: `approval: ${t.approval}` }
  try {
    switch (t.type) {
      case 'PositiveSyntaxTest':
      case 'PositiveSyntaxTest11':
        target.parseQuery(readText(t.action!), t.action!)
        return { status: 'pass' }
      case 'NegativeSyntaxTest':
      case 'NegativeSyntaxTest11':
        return expectError(() => target.parseQuery(readText(t.action!), t.action!))
      case 'PositiveUpdateSyntaxTest':
      case 'PositiveUpdateSyntaxTest11':
        target.parseUpdate(readText(t.action!), t.action!)
        return { status: 'pass' }
      case 'NegativeUpdateSyntaxTest':
      case 'NegativeUpdateSyntaxTest11':
        return expectError(() => target.parseUpdate(readText(t.action!), t.action!))
      case 'QueryEvaluationTest': {
        const query = readText(t.query!)
        if (typeof t.result !== 'string') return { status: 'skip', reason: 'no expected result' }
        if (/\.(csv|tsv)$/.test(t.result)) return { status: 'skip', reason: 'CSV/TSV results' }
        const actual = target.query(dataset(t, query), query, t.query!)
        const want = expected(t.result)
        const o = compare(actual, want, /ORDER\s+BY/i.test(query))
        if (show && o.status === 'fail') console.log(`${t.id}\n${query}\nACTUAL\n${render(actual)}\nEXPECTED\n${render(want)}\n`)
        return o
      }
      case 'UpdateEvaluationTest': {
        const after = target.update(dataset(t), readText(t.request!), t.request!)
        const r = t.result as { data: string[]; graphData: { name: string; file: string }[] }
        const want: Row[] = [
          ...r.data.flatMap((d) => oxParse(rdfFile(d))),
          ...r.graphData.flatMap((g) => oxParse(rdfFile(g.file)).map((q) => [q[0], q[1], q[2], { t: 'iri', v: g.name }] as Row)),
        ]
        const same = isomorphic(after, want, false)
        return same ? { status: 'pass' } : { status: 'fail', reason: same === undefined ? 'comparison too hard (blank nodes)' : 'wrong dataset' }
      }
    }
    const rdf = RDF_TEST.exec(t.type)
    if (rdf) {
      const file = rdfFile(t.action!)
      switch (rdf[2]) {
        case 'PositiveSyntax':
          target.parse(file)
          return { status: 'pass' }
        case 'NegativeSyntax':
        case 'NegativeEval':
          return expectError(() => target.parse(file))
        case 'Eval': {
          const same = isomorphic(target.parse(file), oxParse(rdfFile(t.result as string)), false)
          return same ? { status: 'pass' } : { status: 'fail', reason: 'wrong quads' }
        }
      }
    }
    return { status: 'skip', reason: `test type ${t.type}` }
  } catch (e) {
    return { status: 'fail', reason: 'error: ' + short(e) }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (name: string) => {
    const out: string[] = []
    for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1]) out.push(args[++i]!)
    return out
  }
  const targetName = opt('--target')[0] ?? 'oxigraph'
  const suites = opt('--suite').length ? opt('--suite') : Object.keys(SUITES)
  const only = opt('--only')[0]
  const verbose = args.includes('-v')
  show = args.includes('--show')
  const target = await TARGETS[targetName]!()

  const summary: Record<string, { pass: number; fail: number; skip: number }> = {}
  const failing: Record<string, string> = {}
  for (const suite of suites) {
    const s = (summary[suite] = { pass: 0, fail: 0, skip: 0 })
    const seen = new Set<string>()
    for (const t of SUITES[suite]!.flatMap((m) => loadManifest(m, seen))) {
      if (only && !t.id.includes(only)) continue
      const o = runTest(target, t)
      s[o.status]++
      if (o.status === 'fail') {
        failing[t.id.startsWith(ROOT) ? t.id.slice(ROOT.length) : t.id] = o.reason
        if (verbose) console.log(`FAIL ${t.id}\n     ${t.name}: ${o.reason}`)
      }
    }
  }

  console.log(`\n${target.name}\n\n| suite | pass | fail | skip |\n|---|---:|---:|---:|`)
  for (const [suite, s] of Object.entries(summary)) console.log(`| ${suite} | ${s.pass} | ${s.fail} | ${s.skip} |`)
  if (only) return
  const dir = new URL('./results/', import.meta.url)
  mkdirSync(dir, { recursive: true })
  const commit = readFileSync(new URL('./fetch.sh', import.meta.url), 'utf8').match(/COMMIT=(\w+)/)![1]
  const sorted = Object.fromEntries(Object.entries(failing).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(new URL(`${target.name}.json`, dir), JSON.stringify({ target: target.name, rdfTests: commit, summary, failing: sorted }, null, 2) + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
