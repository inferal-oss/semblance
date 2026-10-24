// Assembles the hand-written engine: `npx tsx rdf-engine/wat/build.ts <out.wasm>`.
//
// The sources are plain WAT bodies concatenated into one module, in the order of
// FILES. The macro layer is four textual expansions, nothing more:
//
//   (@define NAME n)  a named constant; (i32.const NAME) then stands for (i32.const n)
//   (i32.const 'c')   a character literal: the code of one ASCII character
//   (@str "text")     a static string: expands to (i32.const ptr) (i32.const len)
//                     and lands, deduplicated, in one data segment
//   $HEAP             (a global defined here) the first byte after static data
//
// Set WAT_DUMP=<path> to also write the expanded source.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const FILES = ['alloc.wat', 'terms.wat', 'store.wat', 'lex.wat', 'iri.wat', 'ntriples.wat', 'turtle.wat', 'load.wat', 'exports.wat']
// Static data starts after the allocator's free-list heads (see alloc.wat).
const DATA = 272

const here = new URL('.', import.meta.url)
const out = process.argv[2]
if (!out) throw new Error('usage: build.ts <output.wasm>')

let src = FILES.map((f) => `;; ---- ${f}\n` + readFileSync(new URL(f, here), 'utf8')).join('\n')

const defines = new Map<string, string>()
src = src.replace(/\(@define ([A-Z_][A-Z0-9_]*) (-?\w+)\)/g, (_, name: string, value: string) => (defines.set(name, value), ''))
src = src.replace(/\(i32\.const ([A-Z_][A-Z0-9_]*)\)/g, (m, name: string) => {
  if (!defines.has(name)) throw new Error('undefined constant ' + name)
  return `(i32.const ${defines.get(name)})`
})

src = src.replace(/\(i32\.const '(\\.|[^'\\])'\)/g, (_, c: string) => {
  const ch = c.length === 2 ? ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[c[1]!] ?? c[1]! : c
  return `(i32.const ${ch.charCodeAt(0)})`
})

const strings = new Map<string, number>()
const data: number[] = []
src = src.replace(/\(@str "([^"\\]*)"\)/g, (_, s: string) => {
  const bytes = Buffer.from(s, 'utf8')
  let at = strings.get(s)
  if (at === undefined) {
    strings.set(s, (at = DATA + data.length))
    data.push(...bytes)
  }
  return `(i32.const ${at}) (i32.const ${bytes.length})`
})
if (/@str|i32\.const '/.test(src)) throw new Error('unexpanded macro: ' + src.match(/.*(@str|i32\.const ').*/)![0])

const heap = (DATA + data.length + 7) & ~7
const escaped = data.map((b) => (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c ? String.fromCharCode(b) : '\\' + b.toString(16).padStart(2, '0'))).join('')
src = `(module\n${src}\n(global $HEAP i32 (i32.const ${heap}))\n(data (i32.const ${DATA}) "${escaped}")\n)\n`
if (process.env.WAT_DUMP) writeFileSync(process.env.WAT_DUMP, src)

const wabt = await createRequire(import.meta.url)('wabt')()
const features = { mutable_globals: true, sign_extension: true, bulk_memory: true, sat_float_to_int: true, multi_value: false, reference_types: false }
const mod = wabt.parseWat('engine.wat', src, features)
mod.validate()
writeFileSync(out, mod.toBinary({}).buffer)
mod.destroy()
