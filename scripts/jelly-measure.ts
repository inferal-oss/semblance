// Numbers for #433: the bytes (raw, gzip, brotli) and load time of the shipped Turtle (minified,
// as the Vite plugin ships it), N-Triples and Jelly, for the whole ontology, the subset an app
// uses (examples/hello, #383) and the site's own graphs. Not a test; times depend on the machine.
//   npx tsx scripts/jelly-measure.ts [--rounds N] [--markdown]
import { readdirSync, readFileSync } from 'node:fs'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import type { Quad } from '@rdfjs/types'
import { DataFactory, Parser, Writer } from 'n3'
import { Engine, Format } from '../rdf-engine/host/engine.ts'
import { frames, JellyReader } from '../src/jelly/decode.ts'
import { writeJelly } from '../src/jelly/encode.ts'
import { appOntology, ontologySources } from '../src/node/load.ts'
import { minifyTurtle } from '../src/node/turtle-min.ts'

const rounds = Number(process.argv[process.argv.indexOf('--rounds') + 1]) || 7
const kib = (n: number) => (n / 1024).toFixed(1) + ' KiB'
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!
const time = (f: () => void): number => {
  const ts: number[] = []
  for (let i = 0; i <= rounds; i++) {
    const t0 = performance.now()
    f()
    if (i) ts.push(performance.now() - t0)
  }
  return median(ts)
}
const gz = (b: Uint8Array) => gzipSync(b, { level: 9 }).length
const br = (b: Uint8Array) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length
const utf8 = (s: string) => new TextEncoder().encode(s)

const root = new URL('../', import.meta.url)
const read = (p: string) => readFileSync(new URL(p, root), 'utf8')
const hello = [read('examples/hello/tally.ttl'), read('examples/hello/app.ttl')]
const site = [read('demo/app.ttl'), ...readdirSync(new URL('demo/gallery/', root)).filter((f) => f.endsWith('.ttl')).map((f) => read('demo/gallery/' + f))]

const corpora: [string, string[]][] = [
  ['ontology, whole', ontologySources()],
  ['ontology, subset (examples/hello)', [appOntology(hello).turtle]],
  ['site graphs (demo/app.ttl, demo/gallery)', site],
]

const engines = Object.fromEntries(['wat', 'rust'].map((k) => [k, new WebAssembly.Module(readFileSync(new URL(`rdf-engine/build/${k}.wasm`, root)))]))

const rows: string[][] = []
for (const [name, docs] of corpora) {
  const quads: Quad[] = []
  // Each document's blank nodes are its own (one parser per document).
  for (const d of docs) quads.push(...new Parser().parse(d))
  const turtle = docs.map(minifyTurtle)
  const nt = new Writer({ format: 'N-Triples' }).quadsToString(quads)
  const jelly = writeJelly(quads, { physical: 1 })
  const ttlBytes = utf8(turtle.join('\n'))
  const ntBytes = utf8(nt)
  // Load times: into a fresh engine store (the shipped path), and N3.js parsing / the TypeScript Jelly reader alone.
  const load: Record<string, string> = {}
  for (const [k, m] of Object.entries(engines)) {
    load[`${k} Turtle`] = time(() => {
      const e = new Engine(m)
      for (const d of turtle) e.load(Format.Turtle, d)
      e.dispose()
    }).toFixed(1)
    load[`${k} N-Triples`] = time(() => {
      const e = new Engine(m)
      e.load(Format.NTriples, nt)
      e.dispose()
    }).toFixed(1)
  }
  load['N3.js Turtle'] = time(() => {
    for (const d of turtle) new Parser().parse(d)
  }).toFixed(1)
  load['TS Jelly reader'] = time(() => {
    const r = new JellyReader(DataFactory)
    const sink = { quad() {} }
    for (const f of frames(jelly)) r.frame(f, sink)
  }).toFixed(1)
  // Check the round trip while here.
  {
    const r = new JellyReader(DataFactory)
    let n = 0
    for (const f of frames(jelly)) n += r.frame(f, { quad() {} })
    if (n !== quads.length) throw new Error(`${name}: Jelly round trip read ${n} of ${quads.length} statements`)
  }
  console.log(`\n${name}: ${quads.length} statements`)
  for (const [fmt, b] of [
    ['Turtle (minified, shipped)', ttlBytes],
    ['N-Triples', ntBytes],
    ['Jelly 1.2', jelly],
  ] as const) {
    console.log(`  ${fmt.padEnd(28)} ${kib(b.length).padStart(11)} ${kib(gz(b)).padStart(11)} gzip ${kib(br(b)).padStart(11)} brotli`)
    rows.push([name, fmt, kib(b.length), kib(gz(b)), kib(br(b))])
  }
  console.log('  load, ms (median of ' + rounds + '): ' + Object.entries(load).map(([k, v]) => `${k} ${v}`).join(', '))
}
if (process.argv.includes('--markdown')) {
  console.log('\n| graphs | format | raw | gzip | brotli |\n|---|---|---:|---:|---:|')
  for (const r of rows) console.log(`| ${r.join(' | ')} |`)
}
