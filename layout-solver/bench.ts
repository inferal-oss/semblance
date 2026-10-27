// Benchmarks: the solver twins (TypeScript, Rust → WASM) on form pages of growing size, a full
// solve and incremental re-solves; the checker twins and the SPARQL checker over a page of boxes.
// Run through the queue: scripts/test-queue.sh npx tsx layout-solver/bench.ts [--quick]
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { checkPacked, packBoxes, packInvariants } from '../src/layout/check.ts'
import { checkSparql, instantiate, readDeclarations, toTurtle } from '../src/layout/invariants.ts'
import type { MeasuredNode, MeasuredPage } from '../src/layout/measure.ts'
import { Solver } from '../src/layout/solver.ts'
import { loadStore } from '../src/node/load.ts'
import { WasmLayout } from './host.ts'
import { formPage, random, type SolverLike } from './scenarios.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const quick = process.argv.includes('--quick')
const wasmBytes = readFileSync(here + 'build/solver.wasm')
const wasm = await WasmLayout.load(wasmBytes)

/** Median of `runs` timings of `f` (ms), after one warm-up (unless `warm` is false). */
function time(f: () => void, runs = quick ? 3 : 7, warm = true): number {
  if (warm) f()
  const ts: number[] = []
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    f()
    ts.push(performance.now() - t)
  }
  return ts.sort((a, b) => a - b)[runs >> 1]
}

const fmt = (ms: number) => (ms < 0.1 ? (ms * 1000).toFixed(1) + ' µs' : ms.toFixed(2) + ' ms')
const kb = (n: number) => (n / 1024).toFixed(1) + ' KiB'

// --- solver -------------------------------------------------------------------------------------

const SIZES: [string, number, number, number][] = [
  ['small (10 fields)', 2, 5, 2],
  ['form (30 fields)', 3, 10, 4],
  ['medium (100 fields)', 10, 10, 10],
  ...(quick ? [] : ([['large (500 fields)', 25, 20, 30]] as [string, number, number, number][])),
]
// A full solve grows about cubically here (every pivot substitutes into every row, kiwi's way): the
// large page is solved once, cold.

const twins: [string, () => SolverLike][] = [
  ['ts', () => new Solver()],
  ['wasm', () => (wasm.reset(), wasm)],
]

console.log('\n### Solver: form pages (one label column across fieldsets, equal buttons across toolbars)\n')
console.log('| page | constraints | twin | full solve | resize (1 edit) | one label | all labels (language) | pivots/resize |')
console.log('|---|---:|---|---:|---:|---:|---:|---:|')
for (const [name, f, r, t] of SIZES) {
  for (const [twin, make] of twins) {
    let constraints = 0
    const big = f * r > 100
    const full = time(() => {
      constraints = formPage(make(), f, r, t).constraints
    }, big || quick ? 1 : 3, !big)
    const s = make()
    const p = formPage(s, f, r, t)
    const widths = [320, 375, 768, 1280, 1024, 641]
    let k = 0
    const p0 = s.pivots
    const resize = time(() => s.suggestValue(p.viewport, widths[k++ % widths.length]), 30)
    const pivots = (s.pivots - p0) / 31
    const rnd = random(5)
    const one = time(() => s.suggestValue(p.labels[Math.floor(rnd() * p.labels.length)], 40 + Math.round(rnd() * 200)), 30)
    const all = time(() => {
      for (const l of p.labels) s.suggestValue(l, 40 + Math.round(rnd() * 200))
    }, quick ? 1 : 3)
    s.values()
    console.log(`| ${name} | ${constraints} | ${twin} | ${fmt(full)} | ${fmt(resize)} | ${fmt(one)} | ${fmt(all)} | ${pivots.toFixed(1)} |`)
  }
}

// --- checker ------------------------------------------------------------------------------------

/** A synthetic page like the site's: cards of field rows and nav lists, n components. */
function syntheticPage(cards: number): MeasuredPage {
  const nodes: MeasuredNode[] = []
  const rnd = random(11)
  const add = (n: MeasuredNode) => nodes.push(n) - 1
  const root = add({ slug: 'stack', parent: -1, x: 0, y: 0, width: 1280, height: 100000 })
  const nav = add({ slug: 'nav-list', parent: root, x: 0, y: 0, width: 240, height: 800 })
  for (let i = 0; i < 20; i++) add({ slug: 'nav-list', part: 'NavItem', parent: nav, x: 8, y: i * 32, width: 224 + (rnd() < 0.05 ? 30 : 0), height: 30 })
  for (let c = 0; c < cards; c++) {
    const card = add({ slug: 'card', parent: root, x: 260, y: c * 400, width: 1000, height: 390 })
    for (let r = 0; r < 4; r++) {
      const row = add({ slug: 'stack', direction: 'row', parent: card, x: 280, y: c * 400 + r * 90, width: 960, height: 80 })
      for (let f = 0; f < 3; f++) {
        const off = rnd() < 0.03 ? 27.5 : 0
        const field = add({ slug: 'text-field', parent: row, x: 280 + f * 320, y: c * 400 + r * 90, width: 300, height: 66 })
        add({ slug: 'text-field', part: 'FieldLabel', parent: field, x: 280 + f * 320, y: c * 400 + r * 90, width: 300, height: 20 })
        add({ slug: 'text-field', part: 'SingleLineControl', parent: field, x: 280 + f * 320, y: c * 400 + r * 90 + 28 + off, width: 300 + (rnd() < 0.02 ? 80 : 0), height: 38 })
      }
    }
  }
  return { url: 'synthetic#page', width: 1280, height: 900, theme: '', dir: 'ltr', scrollWidth: 1280, nodes }
}

console.log('\n### Checker: a whole page of boxes (cards of field rows, a nav list)\n')
console.log('| page | boxes | invariants | findings | ts | wasm (with copy in) | sparql (wat store) |')
console.log('|---|---:|---:|---:|---:|---:|---:|')
const store = loadStore('wat')
const decl = readDeclarations(store)
for (const cards of quick ? [10, 100] : [10, 100, 500]) {
  const page = syntheticPage(cards)
  const { boxes, invariants } = instantiate(page, decl)
  const b = packBoxes(boxes)
  const prog = packInvariants(invariants)
  const findings = checkPacked(b, prog).length
  const ts = time(() => checkPacked(b, prog))
  const w = time(() => wasm.check(b, prog))
  if (wasm.check(b, prog).length !== findings) throw new Error('checker twins disagree')
  let sparql = NaN
  if (cards <= 100) {
    const s = loadStore('wat')
    s.loadTurtle(toTurtle(page, decl))
    sparql = time(() => checkSparql(s), quick ? 1 : 3)
    s.dispose?.()
  }
  console.log(`| ${cards} cards | ${boxes.length} | ${invariants.length} | ${findings} | ${fmt(ts)} | ${fmt(w)} | ${Number.isNaN(sparql) ? '-' : fmt(sparql)} |`)
}

// --- size ---------------------------------------------------------------------------------------

const out = await build({ stdin: { contents: `export * from './src/layout/solver.ts'; export * from './src/layout/check.ts'`, resolveDir: here + '..', loader: 'ts' }, bundle: true, minify: true, format: 'esm', write: false, logLevel: 'error' })
const tsBytes = Buffer.from(out.outputFiles[0].contents)
console.log('\n### Size\n')
console.log('| twin | raw | gzip | brotli | source lines |')
console.log('|---|---:|---:|---:|---:|')
const lines = (...f: string[]) => f.map((p) => readFileSync(here + p, 'utf8').split('\n').length).reduce((a, b) => a + b)
console.log(`| ts (minified) | ${kb(tsBytes.length)} | ${kb(gzipSync(tsBytes, { level: 9 }).length)} | ${kb(brotliCompressSync(tsBytes).length)} | ${lines('../src/layout/solver.ts', '../src/layout/check.ts')} |`)
console.log(`| wasm (Rust, opt-level 3) | ${kb(wasmBytes.length)} | ${kb(gzipSync(wasmBytes, { level: 9 }).length)} | ${kb(brotliCompressSync(wasmBytes).length)} | ${lines('rust/src/solver.rs', 'rust/src/check.rs', 'rust/src/lib.rs')} |`)
