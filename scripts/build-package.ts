// The packages' build (docs/RELEASING.md): JavaScript and declarations for every entry of
// @semblance-dev/rdf-engine-wat and @semblance-dev/rdf-engine-rust (packages/rdf-engine-*/lib/: the
// engine build, its kind and ABI), @semblance-dev/semblance (lib/) and @semblance-dev/semblance-react
// (packages/react/lib/), in that order: each package's declarations are what the next one imports.
//
//   npx tsx scripts/build-package.ts     (npm run build:package; npm pack runs it first)
//
// One list: each package's `exports` (and `bin`). Every `types` / `default` target there names its
// output; its source is the same path under the package's source root, with .ts for .js. The build
// compiles those sources and what they import, nothing else, and fails if an export names a file the
// build did not make. A new entry is a line in `exports`.
//
// lib/ mirrors the repository's layout (lib/src/…, lib/rdf-engine/host/…, lib/bin/…), and the files
// the code reads beside itself at run time are copied into it (lib/ontology/, the layout solver's .wasm),
// so the paths the sources use relative to their own module (`../../ontology/`) hold in the output.
// The repository itself runs from source: Vite, Vitest and tsx resolve the packages by name to src/
// (vite.config.ts, tsconfig.json `paths`), never to lib/.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { type Manifest, targets } from './package-exports.ts'

const repo = join(import.meta.dirname, '..')

/** The source of an output file: `./lib/src/web/index.js` → `src/web/index.ts` (or `.tsx`; null when it is not built from a source). */
function sourceOf(target: string, lib: string): string | null {
  const path = target.replace(/^\.\//, '')
  if (!path.startsWith(lib + '/')) return null
  const rest = path.slice(lib.length + 1)
  if (rest.endsWith('.d.ts')) return rest.replace(/\.d\.ts$/, '.ts')
  if (rest.endsWith('.js')) return rest.replace(/\.js$/, '.ts')
  return null
}

function tsc(project: string): void {
  execFileSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', project], { cwd: repo, stdio: 'inherit' })
}

/** Compile `entries` (sources relative to `root`) into `out`, with the repository's compiler options. */
function compile(root: string, out: string, entries: string[], paths?: Record<string, string[]>): void {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const config = join(out, 'tsconfig.json')
  const rel = (p: string) => relative(out, p) || '.'
  writeFileSync(
    config,
    JSON.stringify(
      {
        extends: rel(join(repo, 'tsconfig.json')),
        compilerOptions: {
          noEmit: false,
          declaration: true,
          rewriteRelativeImportExtensions: true,
          sourceMap: false,
          rootDir: rel(root),
          outDir: '.',
          ...(paths ? { paths } : {}),
        },
        files: entries.map((e) => rel(join(root, e))),
        include: [],
      },
      null,
      2,
    ),
  )
  try {
    tsc(config)
  } finally {
    rmSync(config)
  }
  // The declarations keep the sources' relative specifiers (`./attributes.ts`); a consumer resolves
  // them as the JavaScript beside them.
  for (const file of globSync('**/*.d.ts', { cwd: out })) {
    const path = join(out, file)
    const text = readFileSync(path, 'utf8')
    const fixed = text.replace(/((?:from|import)\s*\(?\s*['"])(\.\.?\/[^'"]*?)\.tsx?(['"])/g, '$1$2.js$3')
    if (fixed !== text) writeFileSync(path, fixed)
  }
}

function sources(manifest: Manifest, lib: string, root: string): string[] {
  const entries = new Set<string>()
  for (const target of targets(manifest)) {
    const source = sourceOf(target, lib)
    const found = source && [source, source + 'x'].find((s) => existsSync(join(root, s)))
    if (found) entries.add(found)
  }
  return [...entries]
}

function verify(manifest: Manifest, packageDir: string): void {
  const missing = [...targets(manifest), ...Object.values(manifest.bin ?? {})].filter((t) => !existsSync(join(packageDir, t)))
  if (missing.length) throw new Error(`${manifest.name}: exports name files the build did not make: ${missing.join(', ')}`)
  for (const [key, value] of Object.entries(manifest.exports)) {
    if (typeof value !== 'string' && key !== './package.json' && !('types' in value)) throw new Error(`${manifest.name}: export ${key} has no types condition`)
  }
}

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Manifest
// npm packs a package's own licence files only.
const licences = (dir: string) => {
  for (const file of ['LICENSE-APACHE', 'LICENSE-MIT']) cpSync(join(repo, file), join(dir, file))
}

// --- @semblance-dev/rdf-engine-wat, @semblance-dev/rdf-engine-rust ------------------------------

// Each is its build's WebAssembly and a module naming it, its kind and the engine ABI it implements
// (the host's ABI_VERSION when it was built); the host that runs it is the core's (rdf-engine/host/).
// In the repository the same names come from packages/rdf-engine-*/src/index.ts, over rdf-engine/build/.
const abi = Number(readFileSync(join(repo, 'rdf-engine/host/engine.ts'), 'utf8').match(/export const ABI_VERSION = (\d+)/)?.[1])
if (!abi) throw new Error('No ABI_VERSION in rdf-engine/host/engine.ts')
const ENGINE_KINDS = ['wat', 'rust'] as const
const engineNames: string[] = []
for (const kind of ENGINE_KINDS) {
  const dir = join(repo, `packages/rdf-engine-${kind}`)
  const manifest = read(join(dir, 'package.json'))
  const wasm = join(repo, `rdf-engine/build/${kind}.wasm`)
  if (!existsSync(wasm)) throw new Error(`No ${kind} engine build at rdf-engine/build/${kind}.wasm (npm run engine:build)`)
  const out = join(dir, 'lib')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  cpSync(wasm, join(out, `${kind}.wasm`))
  writeFileSync(
    join(out, 'index.js'),
    `// ${manifest.name}: Semblance's ${kind} engine build (docs/RELEASING.md in the repository).

/** Which build this is: the store kind that runs it. */
export const kind = '${kind}'

/** The engine ABI it implements (rdf-engine/ABI.md); @semblance-dev/semblance checks it before it loads the build. */
export const abi = ${abi}

/** The build's WebAssembly, beside this module: a file: URL in Node, the asset's URL in a bundle. */
export const wasm = new URL('./${kind}.wasm', import.meta.url)
`,
  )
  writeFileSync(
    join(out, 'index.d.ts'),
    `/** Which build this is: the store kind that runs it. */
export declare const kind: '${kind}'

/** The engine ABI it implements (rdf-engine/ABI.md); @semblance-dev/semblance checks it before it loads the build. */
export declare const abi: number

/** The build's WebAssembly, beside this module: a file: URL in Node, the asset's URL in a bundle. */
export declare const wasm: URL
`,
  )
  writeFileSync(
    join(out, 'wasm.d.ts'),
    `/** The build's WebAssembly, as a platform that imports .wasm files hands it over (a Cloudflare Worker: a compiled module). */
declare const module: WebAssembly.Module
export default module
`,
  )
  licences(dir)
  verify(manifest, dir)
  engineNames.push(manifest.name)
}

// --- @semblance-dev/semblance -------------------------------------------------------------------

const core = read(join(repo, 'package.json'))
const lib = join(repo, 'lib')
const coreEntries = [...sources(core, 'lib', repo), ...Object.values(core.bin ?? {}).map((b) => b.replace(/^\.\//, '').replace(/\.mjs$/, '.ts')).filter((b) => existsSync(join(repo, b)))]
compile(repo, lib, coreEntries)
// The core meets the engine packages in src/store/engines/: in the repository their own modules, in
// the package imports of the packages (a dependency and an optional peer), not copies of them.
rmSync(join(lib, 'packages'), { recursive: true, force: true })
for (const kind of ENGINE_KINDS) {
  const name = `@semblance-dev/rdf-engine-${kind}`
  const seam = join(lib, `src/store/engines/${kind}`)
  if (!existsSync(seam + '.js')) throw new Error(`The core no longer imports ${name} through src/store/engines/${kind}.ts`)
  const text = `// ${name}, a package of its own (docs/RELEASING.md in the repository).\nexport * from '${name}';\n`
  writeFileSync(seam + '.js', text)
  writeFileSync(seam + '.d.ts', text)
}
// What the code reads beside itself at run time, and the declarations-only entry.
// ontology/vendor/ is read at build time only (scripts/gen-rdfhtml-vocab.ts).
cpSync(join(repo, 'ontology'), join(lib, 'ontology'), { recursive: true, filter: (from) => !from.startsWith(join(repo, 'ontology', 'vendor')) })
for (const file of globSync('layout-solver/build/*.wasm', { cwd: repo })) {
  mkdirSync(dirname(join(lib, file)), { recursive: true })
  cpSync(join(repo, file), join(lib, file))
}
for (const file of globSync('src/**/*.d.ts', { cwd: repo })) cpSync(join(repo, file), join(lib, file))
verify(core, repo)

// --- @semblance-dev/semblance-react -------------------------------------------------------------

// Its imports of @semblance-dev/semblance resolve to the declarations just built, so they stay imports
// of the package (a peer dependency) rather than copies of its sources.
const reactDir = join(repo, 'packages/react')
const react = read(join(reactDir, 'package.json'))
const coreTypes: Record<string, string[]> = {}
for (const [key, value] of Object.entries(core.exports)) {
  if (typeof value === 'string' || !value.types || key.includes('*')) continue
  coreTypes[core.name + key.slice(1)] = [relative(join(reactDir, 'lib'), join(repo, value.types))]
}
compile(join(reactDir, 'src'), join(reactDir, 'lib'), sources(react, 'lib', join(reactDir, 'src')), coreTypes)
licences(reactDir)
verify(react, reactDir)

console.log(`Built ${engineNames.join(', ')} (packages/rdf-engine-*/lib/, engine ABI ${abi}), ${core.name} (lib/) and ${react.name} (packages/react/lib/)`)
