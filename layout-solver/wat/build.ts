// Assembles the hand-written WAT twin of the layout solver and checker:
// `npx tsx layout-solver/wat/build.ts <out.wasm>` (layout-solver/build.ts calls it).
//
// The sources are plain WAT bodies concatenated into one module, in the order of FILES (the
// pattern of rdf-engine/wat/build.ts, kept separate from it). The macro layer is two textual
// expansions:
//
//   (@define NAME n)  a named constant; (i32.const NAME) and offset=NAME then stand for n
//
// Set WAT_DUMP=<path> to also write the expanded source, WAT_NAMES=1 to keep function names.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const FILES = ['alloc.wat', 'row.wat', 'solver.wat', 'check.wat', 'exports.wat']

const here = new URL('.', import.meta.url)
const out = process.argv[2]
if (!out) throw new Error('usage: build.ts <output.wasm>')

let src = FILES.map((f) => `;; ---- ${f}\n` + readFileSync(new URL(f, here), 'utf8')).join('\n')

const defines = new Map<string, string>()
src = src.replace(/\(@define ([A-Z_][A-Z0-9_]*) (-?\w+)\)/g, (_, name: string, value: string) => {
  if (defines.has(name)) throw new Error('constant defined twice: ' + name)
  return defines.set(name, value), ''
})
const lookup = (name: string) => {
  if (!defines.has(name)) throw new Error('undefined constant ' + name)
  return defines.get(name)!
}
src = src.replace(/\(i32\.const ([A-Z_][A-Z0-9_]*)\)/g, (_, name: string) => `(i32.const ${lookup(name)})`)
src = src.replace(/offset=([A-Z_][A-Z0-9_]*)/g, (_, name: string) => `offset=${lookup(name)}`)
if (/@define/.test(src)) throw new Error('unexpanded macro')

src = `(module\n${src}\n)\n`
if (process.env.WAT_DUMP) writeFileSync(process.env.WAT_DUMP, src)

const wabt = await createRequire(import.meta.url)('wabt')()
const features = { mutable_globals: true, sign_extension: true, bulk_memory: true, sat_float_to_int: true, multi_value: false, reference_types: false }
const mod = wabt.parseWat('layout.wat', src, features)
mod.validate()
writeFileSync(out, mod.toBinary({ write_debug_names: !!process.env.WAT_NAMES }).buffer)
mod.destroy()
