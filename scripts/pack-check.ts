// The packages as a consumer gets them (docs/RELEASING.md): pack @semblance-dev/rdf-engine-wat,
// @semblance-dev/rdf-engine-rust, @semblance-dev/semblance and @semblance-dev/semblance-react, check
// what the tarballs carry and that their versions agree, install them into an empty project and build
// and render examples/hello from them; then the core without the optional rust engine, in another.
//
//   npx tsx scripts/pack-check.ts [--no-build] [--keep]     (npm run pack:check)
//
// --no-build packs the lib/ already built (npm run build:package); --keep leaves the project in
// place and prints where. Installing fetches the packages' own dependencies (npm's cache first).
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const bare = join(work, 'without-rust')
const abi = Number(readFileSync(join(repo, 'rdf-engine/host/engine.ts'), 'utf8').match(/export const ABI_VERSION = (\d+)/)?.[1])

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
// In the order they are published: each one's dependencies first (docs/RELEASING.md).
const packages = [
  { dir: join(repo, 'packages/rdf-engine-wat'), engine: 'wat', allowed: [/^lib\//] },
  { dir: join(repo, 'packages/rdf-engine-rust'), engine: 'rust', allowed: [/^lib\//] },
  { dir: repo, allowed: [/^lib\//, /^bin\/semblance\.mjs$/] },
  { dir: join(repo, 'packages/react'), allowed: [/^lib\//] },
]
const files: Record<string, string> = {}
const manifests: Record<string, { name: string; version: string; private?: boolean; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>; publishConfig?: { access?: string } }> = {}
for (const { dir, allowed, engine } of packages) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  manifests[manifest.name] = manifest
  const packed = pack(dir)
  files[manifest.name] = join(tarballs, packed.filename)
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
  check(manifest.publishConfig?.access === 'public', `${manifest.name}: publishConfig.access is public`)
  if (engine) {
    // The engine build as it is in the checkout, and the ABI its module states is the host's.
    const wasm = packed.files.find((f) => f.path === `lib/${engine}.wasm`) as { path: string; size?: number } | undefined
    check(!!wasm && wasm.size === statSync(join(repo, `rdf-engine/build/${engine}.wasm`)).size, `${manifest.name}: lib/${engine}.wasm is rdf-engine/build/${engine}.wasm`)
    const module = readFileSync(join(dir, 'lib/index.js'), 'utf8')
    check(module.includes(`export const abi = ${abi}\n`) && module.includes(`export const kind = '${engine}'`), `${manifest.name}: kind ${engine}, engine ABI ${abi} (the host's ABI_VERSION)`)
  }
  if (dir === repo) {
    // The layout solver's WebAssembly (when built) and the ontology; the engines' builds are theirs.
    const wasm = globSync('layout-solver/build/*.wasm', { cwd: repo }).map((f) => 'lib/' + f)
    for (const f of [...wasm, 'lib/ontology/core.ttl']) check(paths.includes(f), `${manifest.name}: ${f}`)
    check(!paths.some((p) => p.startsWith('lib/ontology/vendor/')), `${manifest.name}: not the build-time vocabularies (ontology/vendor)`)
    check(!paths.some((p) => p.startsWith('lib/rdf-engine/build/')), `${manifest.name}: not the engine builds (their packages carry them)`)
  }
}

// --- one version, the engines pinned to it -----------------------------------------------------

const wat = '@semblance-dev/rdf-engine-wat'
const rust = '@semblance-dev/rdf-engine-rust'
const coreName = '@semblance-dev/semblance'
const reactName = '@semblance-dev/semblance-react'
const version = manifests[coreName]!.version
const versions = Object.values(manifests).map((m) => `${m.name}@${m.version}`)
check(Object.values(manifests).every((m) => m.version === version), `one version for the four packages (${versions.join(', ')})`)
const core = manifests[coreName]!
check(core.dependencies?.[wat] === version, `${coreName}: depends on ${wat} at exactly its own version (${core.dependencies?.[wat]})`)
check(core.peerDependencies?.[rust] === version && core.peerDependenciesMeta?.[rust]?.optional === true, `${coreName}: ${rust} an optional peer at exactly its own version (${core.peerDependencies?.[rust]})`)
const minor = version.split('.').slice(0, 2).join('.')
check(manifests[reactName]!.peerDependencies?.[coreName] === `^${minor}.0`, `${reactName}: its peer range on the core is ^${minor}.0 (${manifests[reactName]!.peerDependencies?.[coreName]})`)

// --- an empty project with examples/hello, the packages installed from the tarballs ------------

const hello = join(repo, 'examples/hello')
cpSync(hello, app, { recursive: true, filter: (f) => !/[/\\](dist|node_modules|vite\.config\.ts|server\.ts)$/.test(f) })
const root = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const dev = (name: string) => `${name}@${root.devDependencies[name] as string}`
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'hello', private: true, type: 'module' }, null, 2))
// The configuration docs/GETTING-STARTED.md gives an app that installed the package.
writeFileSync(
  join(app, 'vite.config.ts'),
  `import { defineConfig } from 'vite'
import { semblance } from '@semblance-dev/semblance/node'

export default defineConfig({
  optimizeDeps: {
    exclude: ['@semblance-dev/semblance', '@semblance-dev/rdf-engine-wat', '@semblance-dev/rdf-engine-rust', 'oxigraph'],
    include: ['@semblance-dev/semblance > n3'],
  },
  plugins: [semblance({ config: 'semblance.config.ts' })],
})
`,
)
writeFileSync(
  join(app, 'env.d.ts'),
  `/// <reference types="vite/client" />
/// <reference types="@semblance-dev/semblance/virtual" />
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
import { loadStore } from '@semblance-dev/semblance/node'
import { renderToString } from '@semblance-dev/semblance/server'

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8')
const out = {}
for (const kind of ['wat', 'rust']) {
  const store = loadStore(kind, read('tally.ttl'), read('app.ttl'))
  const { html, css, status } = await renderToString({ store, root: 'https://example.org/hello#page' })
  out[kind] = { html, css: css?.length ?? 0, status }
}
console.log(JSON.stringify(out))
`,
)
// The engine packages' declarations against the core's: the optional rust build added to a page, and
// a build's WebAssembly as a Worker imports it.
writeFileSync(
  join(app, 'engines.ts'),
  `import { addEngine, type EngineBuild } from '@semblance-dev/semblance/web'
import * as wat from '@semblance-dev/rdf-engine-wat'
import watModule from '@semblance-dev/rdf-engine-wat/wasm'

addEngine('rust', () => import('@semblance-dev/rdf-engine-rust'))
export const build: EngineBuild = wat
export const module: WebAssembly.Module = watModule
`,
)
// The React package's declarations, against the core's (a peer dependency).
writeFileSync(
  join(app, 'hosts.ts'),
  `import type { HostRenderer } from '@semblance-dev/semblance'
import { reactHosts } from '@semblance-dev/semblance-react'
import { reactHosts as serverHosts } from '@semblance-dev/semblance-react/server'

export const client: HostRenderer = reactHosts({ components: {} })
export const server: HostRenderer = serverHosts({ components: {} })
`,
)
writeFileSync(
  join(app, 'react.mjs'),
  `const react = await import('@semblance-dev/semblance-react')
const server = await import('@semblance-dev/semblance-react/server')
console.log(JSON.stringify({ react: typeof react.reactHosts, server: Object.keys(server).length }))
`,
)

try {
  const install = (dir: string, specs: string[]) => run(npm, ['install', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=error', ...specs], { cwd: dir, stdio: 'inherit' })
  install(app, [...Object.values(files), ...['vite', 'typescript', '@types/node', 'react', 'react-dom', '@types/react', '@types/react-dom'].map(dev)])
  check(true, 'installed from the tarballs')

  // The browser build: Vite resolves the package's lib/ (its import.meta.glob of the ontology and the
  // engines), and the plugin renders the page beforehand.
  run(join(app, 'node_modules/.bin/vite'), ['build'], { cwd: app, stdio: 'inherit' })
  const page = readFileSync(join(app, 'dist/index.html'), 'utf8')
  check(page.includes('Hello, Semblance') && page.includes('0 cups'), 'vite build: the page rendered beforehand (dist/index.html)')
  const assets = readdirSync(join(app, 'dist/assets'))
  check(assets.some((a) => /^wat-[\w-]+\.wasm$/.test(a)), 'vite build: the wat engine build among the assets (from its package)')
  check(assets.some((a) => a.endsWith('.js')), 'vite build: the client bundle')

  const rendered = JSON.parse(run(process.execPath, ['render.mjs'], { cwd: app })) as Record<string, { html: string; css: number; status: number }>
  for (const [kind, r] of Object.entries(rendered)) check(r.status === 200 && r.html.includes('Hello, Semblance') && r.html.includes('Coffee today') && r.css > 0, `renderToString in Node (the ${kind} store, from its package)`)
  check(rendered.wat?.html === rendered.rust?.html, 'the wat and rust stores render the same page')

  const cli = run(join(app, 'node_modules/.bin/semblance'), ['render', '/'], { cwd: app })
  check(cli.includes('Hello, Semblance'), 'semblance render / (the CLI, from lib/)')

  const react = JSON.parse(run(process.execPath, ['react.mjs'], { cwd: app })) as { react: string; server: number }
  check(react.react === 'function' && react.server > 0, '@semblance-dev/semblance-react and /server import in Node')

  run(join(app, 'node_modules/.bin/tsc'), ['-p', '.'], { cwd: app, stdio: 'inherit' })
  check(true, 'tsc: the app type-checks against the declarations')

  // The core and its dependencies alone: npm leaves the optional rust engine out, the other stores
  // work, and asking for the rust one says what to install.
  mkdirSync(bare)
  writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'without-rust', private: true, type: 'module' }, null, 2))
  writeFileSync(
    join(bare, 'stores.mjs'),
    `import { createStore } from '@semblance-dev/semblance/node'

const out = {}
for (const kind of ['wat', 'n3', 'oxigraph', 'rust']) {
  try {
    const store = createStore(kind)
    store.loadTurtle('<urn:a> <urn:b> <urn:c> .')
    out[kind] = store.match().length === 1 ? 'ok' : 'no result'
  } catch (e) {
    out[kind] = e.message
  }
}
console.log(JSON.stringify(out))
`,
  )
  install(bare, [files[wat]!, files[coreName]!])
  check(!existsSync(join(bare, 'node_modules', rust)), `npm install ${coreName} leaves the optional ${rust} out`)
  const stores = JSON.parse(run(process.execPath, ['stores.mjs'], { cwd: bare })) as Record<string, string>
  check(stores.wat === 'ok' && stores.n3 === 'ok' && stores.oxigraph === 'ok', `without ${rust}: the wat, n3 and oxigraph stores work (${JSON.stringify(stores)})`)
  check(stores.rust?.includes(`npm install ${rust}`) ?? false, `without ${rust}: the rust store says to install it`)
} catch (e) {
  check(false, `${(e as Error).message.split('\n')[0]}`)
}

// For the release notes (docs/RELEASING.md).
console.log(`Version: ${version}; engine ABI: ${abi}`)
if (values.keep) console.log(`The projects: ${app}, ${bare}`)
else rmSync(work, { recursive: true, force: true })
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nThe four packed packages install, build and render examples/hello')
