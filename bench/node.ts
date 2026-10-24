// Usage: npm run bench [-- 100,1000,10000]
// Each (config, size) pair runs in its own Node process.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as ox from 'oxigraph'
import { oxigraphStore } from '../src/store/oxigraph.ts'
import { judge, observationsTurtle } from './observations.ts'
import type { MicroRow } from './micro.ts'
import { CONFIGS, type Row, toMarkdown } from './scenarios.ts'

const sizes = (process.argv[2] ?? '100,1000,10000').split(',').map(Number)
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')

function child<T>(...args: string[]): T {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'bench/node-one.ts', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  })
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT:'))
  if (r.status !== 0 || !line) throw new Error(`bench child ${args.join(' ')} failed (${r.status})`)
  return JSON.parse(line.slice('RESULT:'.length)) as T
}

const micro = child<MicroRow[]>('micro')
console.table(micro.map((m) => ({ op: m.op, 'µs/op': Number(m.us.toFixed(2)) })))

const rows: Row[] = []
for (const size of sizes) for (const config of CONFIGS) rows.push(...child<Row[]>('run', config.id, String(size)))

// Results as RDF observations, judged by the SPARQL in ontology/perf/perf.ttl.
const observations = observationsTurtle(rows)
const store = oxigraphStore(ox)
store.loadTurtle(readFileSync('ontology/perf/perf.ttl', 'utf8'))
store.loadTurtle(observations)
const { judgements, findings } = judge(store)
const verdictIcon = { good: '✓', concern: '!', insight: '·' }

const md = [
  `## Node ${process.version} (${process.platform}/${process.arch}), ${new Date().toISOString().slice(0, 10)}`,
  '',
  'Engine time per operation (mean of 15 updates; initial render is a single run). Each cell runs in a fresh process.',
  '',
  '### Primitives',
  '',
  '| operation | µs/op |',
  '|---|---:|',
  ...micro.map((m) => `| ${m.op} | ${m.us.toFixed(2)} |`),
  '',
  toMarkdown(rows),
  '### Findings (SPARQL judgements over the observations)',
  '',
  ...judgements.flatMap((j) => {
    const fs = findings.filter((f) => f.judgement === j.iri)
    return fs.length ? [`**${j.label}**`, '', ...fs.map((f) => `- ${verdictIcon[f.verdict]} ${f.text}`), ''] : []
  }),
].join('\n')
console.log('\n' + md)

mkdirSync('bench/results', { recursive: true })
writeFileSync(`bench/results/node-${stamp}.json`, JSON.stringify({ micro, rows }, null, 2))
writeFileSync(`bench/results/node-${stamp}.md`, md + '\n')
writeFileSync(`bench/results/node-${stamp}.ttl`, observations)
console.log(`\nwrote bench/results/node-${stamp}.{md,json,ttl}`)
