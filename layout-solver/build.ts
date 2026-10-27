// Build the layout solver's WASM twins into layout-solver/build/<name>.wasm and report their sizes:
// rust (layout-solver/rust, needs cargo) and wat (layout-solver/wat, needs only Node).
// `npx tsx layout-solver/build.ts [rust|wat]`
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const here = fileURLToPath(new URL('.', import.meta.url))
const out = here + 'build/'
mkdirSync(out, { recursive: true })

const hasCargo = (() => {
  try {
    execFileSync('cargo', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const TWINS: Record<string, () => void> = {
  rust() {
    execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: here + 'rust', stdio: 'inherit' })
    copyFileSync(here + 'rust/target/wasm32-unknown-unknown/release/semblance_layout.wasm', out + 'rust.wasm')
  },
  wat() {
    execFileSync('npx', ['tsx', here + 'wat/build.ts', out + 'wat.wasm'], { stdio: 'inherit' })
  },
}

const wanted = process.argv.slice(2)
const kb = (n: number) => (n / 1024).toFixed(1) + ' KiB'
for (const [name, build] of Object.entries(TWINS)) {
  if (wanted.length && !wanted.includes(name)) continue
  if (name === 'wat' && !existsSync(here + 'wat/build.ts')) continue
  if (name === 'rust' && !hasCargo) {
    console.warn('layout-solver: no cargo on PATH, so no Rust build')
    continue
  }
  build()
  const bytes = readFileSync(out + name + '.wasm')
  console.log(`${name}.wasm: ${kb(bytes.length)}, gzip ${kb(gzipSync(bytes, { level: 9 }).length)}, brotli ${kb(brotliCompressSync(bytes).length)}`)
}
