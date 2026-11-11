// The packages as a consumer gets them (docs/RELEASING.md): pack @inferal-oss/semblance and
// @inferal-oss/semblance-react, check what the tarballs carry, install them into an empty project
// and build and render examples/hello from them.
//
//   npx tsx scripts/pack-check.ts [--no-build] [--keep]     (npm run pack:check)
//
// --no-build packs the lib/ already built (npm run build:package); --keep leaves the project in
// place and prints where. Installing fetches the packages' own dependencies (npm's cache first).
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { cpSync, globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { targets } from './package-exports.ts'

const { values } = parseArgs({ options: { 'no-build': { type: 'boolean', default: false }, keep: { type: 'boolean', default: false } } })
const repo = join(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (cmd: string, args: string[], opts: ExecFileSyncOptions = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts }) as string
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

if (!values['no-build']) run(npm, ['run', 'build:package'], { cwd: repo, stdio: 'inherit' })

const work = mkdtempSync(join(tmpdir(), 'semblance-pack-'))
const tarballs = join(work, 'tarballs')
const app = join(work, 'app')

// --- the tarballs ------------------------------------------------------------------------------

interface Packed {
  filename: string
  files: { path: string }[]
}
function pack(dir: string): Packed {
  // The build ran above; the packages' prepack would run it again.
  const [packed] = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs], { cwd: dir })) as Packed[]
  return packed!
}
mkdirSync(tarballs)
const packages = [
  { dir: repo, allowed: [/^lib\//, /^bin\/semblance\.mjs$/] },
  { dir: join(repo, 'packages/react'), allowed: [/^lib\//] },
]
const files: string[] = []
for (const { dir, allowed } of packages) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const packed = pack(dir)
  files.push(join(tarballs, packed.filename))
  const paths = packed.files.map((f) => f.path)
  const always = [/^package\.json$/, /^README\.md$/, /^LICENSE-(APACHE|MIT)$/]
  const stray = paths.filter((p) => ![...always, ...allowed].some((r) => r.test(p)))
  check(stray.length === 0, `${manifest.name}: carries only run-time files${stray.length ? ` (also: ${stray.slice(0, 10).join(', ')})` : ''}`)
  const sources = paths.filter((p) => /\.tsx?$/.test(p) && !p.endsWith('.d.ts'))
  check(sources.length === 0, `${manifest.name}: no TypeScript sources${sources.length ? ` (${sources.slice(0, 5).join(', ')})` : ''}`)
  const wanted = [...targets(manifest), ...Object.values((manifest.bin ?? {}) as Record<string, string>)].map((t) => t.replace(/^\.\//, ''))
  const missing = wanted.filter((t) => !paths.includes(t))
  check(missing.length === 0, `${manifest.name}: every export and bin is in the tarball${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`)
  check(paths.includes('LICENSE-MIT') && paths.includes('LICENSE-APACHE'), `${manifest.name}: both licence texts`)
  if (dir === repo) {
    // Every WebAssembly build in the checkout (the engines; the layout solver's, when built).
    const wasm = globSync(['rdf-engine/build/*.wasm', 'layout-solver/build/*.wasm'], { cwd: repo }).map((f) => 'lib/' + f)
    for (const f of [...wasm, 'lib/ontology/core.ttl']) check(paths.includes(f), `${manifest.name}: ${f}`)
    check(!paths.some((p) => p.startsWith('lib/ontology/vendor/')), `${manifest.name}: not the build-time vocabularies (ontology/vendor)`)
  }
}

// --- an empty project with examples/hello, the packages installed from the tarballs ------------

const hello = join(repo, 'examples/hello')
cpSync(hello, app, { recursive: true, filter: (f) => !/[/\\](dist|node_modules|vite\.config\.ts|server\.ts)$/.test(f) })
const root = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const version = (name: string) => root.devDependencies[name] as string
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'hello', private: true, type: 'module' }, null, 2))
// The configuration docs/GETTING-STARTED.md gives an app that installed the package.
writeFileSync(
  join(app, 'vite.config.ts'),
  `import { defineConfig } from 'vite'
import { semblance } from '@inferal-oss/semblance/node'

export default defineConfig({
  optimizeDeps: {
    exclude: ['@inferal-oss/semblance', 'oxigraph'],
    include: ['@inferal-oss/semblance > n3'],
  },
  plugins: [semblance({ config: 'semblance.config.ts' })],
})
`,
)
writeFileSync(
  join(app, 'env.d.ts'),
  `/// <reference types="vite/client" />
/// <reference types="@inferal-oss/semblance/virtual" />
`,
)
writeFileSync(
  join(app, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: { target: 'ES2023', module: 'ESNext', moduleResolution: 'bundler', lib: ['ES2023', 'DOM', 'DOM.Iterable'], types: ['node'], strict: true, noEmit: true, skipLibCheck: false },
      include: ['*.ts'],
    },
    null,
    2,
  ),
)
// renderToString in Node, from the package's own JavaScript (no TypeScript loader).
writeFileSync(
  join(app, 'render.mjs'),
  `import { readFileSync } from 'node:fs'
import { loadStore } from '@inferal-oss/semblance/node'
import { renderToString } from '@inferal-oss/semblance/server'

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8')
const store = loadStore('wat', read('tally.ttl'), read('app.ttl'))
const { html, css, status } = await renderToString({ store, root: 'https://example.org/hello#page' })
console.log(JSON.stringify({ html, css: css?.length ?? 0, status }))
`,
)
// The React package's declarations, against the core's (a peer dependency).
writeFileSync(
  join(app, 'hosts.ts'),
  `import type { HostRenderer } from '@inferal-oss/semblance'
import { reactHosts } from '@inferal-oss/semblance-react'
import { reactHosts as serverHosts } from '@inferal-oss/semblance-react/server'

export const client: HostRenderer = reactHosts({ components: {} })
export const server: HostRenderer = serverHosts({ components: {} })
`,
)
writeFileSync(
  join(app, 'react.mjs'),
  `const react = await import('@inferal-oss/semblance-react')
const server = await import('@inferal-oss/semblance-react/server')
console.log(JSON.stringify({ react: typeof react.reactHosts, server: Object.keys(server).length }))
`,
)

try {
  run(npm, ['install', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=error', ...files, `vite@${version('vite')}`, `typescript@${version('typescript')}`, `@types/node@${version('@types/node')}`, `react@${version('react')}`, `react-dom@${version('react-dom')}`, `@types/react@${version('@types/react')}`, `@types/react-dom@${version('@types/react-dom')}`], { cwd: app, stdio: 'inherit' })
  check(true, 'installed from the tarballs')

  // The browser build: Vite resolves the package's lib/ (its import.meta.glob of the ontology and the
  // engines), and the plugin renders the page beforehand.
  run(join(app, 'node_modules/.bin/vite'), ['build'], { cwd: app, stdio: 'inherit' })
  const page = readFileSync(join(app, 'dist/index.html'), 'utf8')
  check(page.includes('Hello, Semblance') && page.includes('0 cups'), 'vite build: the page rendered beforehand (dist/index.html)')
  const assets = readdirSync(join(app, 'dist/assets'))
  check(assets.some((a) => a.endsWith('.wasm')), 'vite build: an engine build among the assets')
  check(assets.some((a) => a.endsWith('.js')), 'vite build: the client bundle')

  const rendered = JSON.parse(run(process.execPath, ['render.mjs'], { cwd: app })) as { html: string; css: number; status: number }
  check(rendered.status === 200 && rendered.html.includes('Hello, Semblance') && rendered.html.includes('Coffee today') && rendered.css > 0, 'renderToString in Node')

  const cli = run(join(app, 'node_modules/.bin/semblance'), ['render', '/'], { cwd: app })
  check(cli.includes('Hello, Semblance'), 'semblance render / (the CLI, from lib/)')

  const react = JSON.parse(run(process.execPath, ['react.mjs'], { cwd: app })) as { react: string; server: number }
  check(react.react === 'function' && react.server > 0, '@inferal-oss/semblance-react and /server import in Node')

  run(join(app, 'node_modules/.bin/tsc'), ['-p', '.'], { cwd: app, stdio: 'inherit' })
  check(true, 'tsc: the app type-checks against the declarations')
} catch (e) {
  check(false, `${(e as Error).message.split('\n')[0]}`)
}

// For the release notes (docs/RELEASING.md).
const abi = readFileSync(join(repo, 'rdf-engine/host/engine.ts'), 'utf8').match(/export const ABI_VERSION = (\d+)/)?.[1]
console.log(`Engine ABI: ${abi}`)
if (values.keep) console.log(`The project: ${app}`)
else rmSync(work, { recursive: true, force: true })
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nThe packed packages install, build and render examples/hello')
