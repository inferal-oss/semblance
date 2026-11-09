// Jelly read and write speed on one build (#433): the whole ontology, written as a Jelly stream
// and read back frame by frame into a fresh store, best of `rounds`. Prints JSON for speed-check.ts.
//   npx tsx rdf-engine/host/jelly-bench.ts <rust|wat> [rounds]
import { readFileSync } from 'node:fs'
import { ontologySources } from '../../src/node/load.ts'
import { frames } from '../../src/jelly/decode.ts'
import { Engine, Format } from './engine.ts'

const kind = process.argv[2] ?? 'wat'
const rounds = Number(process.argv[3] ?? 7)
const module = new WebAssembly.Module(readFileSync(new URL(`../build/${kind}.wasm`, import.meta.url)))
const source = new Engine(module)
for (const t of ontologySources()) source.load(Format.Turtle, t)
const ids = source.match()
let bytes = new Uint8Array(0)
const best = (f: () => void) => {
  let min = Infinity
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now()
    f()
    min = Math.min(min, performance.now() - t0)
  }
  return min
}
const writeMs = best(() => {
  const w = source.jellyWriter({ physical: 2 })
  const a = w.write(ids)
  const b = w.flush()
  w.release()
  bytes = new Uint8Array(a.length + b.length)
  bytes.set(a)
  bytes.set(b, a.length)
})
const list = [...frames(bytes)]
const readMs = best(() => {
  const e = new Engine(module)
  const r = e.jellyReader()
  for (const f of list) r.add(f)
  e.dispose()
})
const turtleMs = best(() => {
  const e = new Engine(module)
  for (const t of ontologySources()) e.load(Format.Turtle, t)
  e.dispose()
})
console.log(JSON.stringify({ kind, quads: ids.length / 4, bytes: bytes.length, writeMs, readMs, turtleMs }))
