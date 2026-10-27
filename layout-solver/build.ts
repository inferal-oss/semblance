// Build the layout solver's WASM twin into layout-solver/build/solver.wasm and report its size.
// `npx tsx layout-solver/build.ts`
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const here = fileURLToPath(new URL('.', import.meta.url))
mkdirSync(here + 'build', { recursive: true })
execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: here + 'rust', stdio: 'inherit' })
copyFileSync(here + 'rust/target/wasm32-unknown-unknown/release/semblance_layout.wasm', here + 'build/solver.wasm')
const bytes = readFileSync(here + 'build/solver.wasm')
const kb = (n: number) => (n / 1024).toFixed(1) + ' KiB'
console.log(`solver.wasm: ${kb(bytes.length)}, gzip ${kb(gzipSync(bytes, { level: 9 }).length)}, brotli ${kb(brotliCompressSync(bytes).length)}`)
