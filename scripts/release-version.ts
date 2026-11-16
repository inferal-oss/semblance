// One version for the four packages (docs/RELEASING.md): sets it in each package.json, pins the core's
// engines to it exactly (the wat build a dependency, the rust build an optional peer), raises the React
// package's peer range on the core to its minor, and updates package-lock.json.
//
//   npx tsx scripts/release-version.ts <version>     (npm run release:version -- <version>)
//   npx tsx scripts/release-version.ts --check [<version>]
//
// --check changes nothing: it fails unless the four agree (and are <version>, given one, as the Release
// workflow does with the tag's) and none is private.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..')
const WAT = '@semblance-dev/rdf-engine-wat'
const RUST = '@semblance-dev/rdf-engine-rust'
const CORE = '@semblance-dev/semblance'

/** The packages, in the order they are published: each one's dependencies first. */
export const PACKAGE_DIRS = ['packages/rdf-engine-wat', 'packages/rdf-engine-rust', '.', 'packages/react']

interface Manifest {
  name: string
  version: string
  private?: boolean
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const file = (dir: string) => join(repo, dir, 'package.json')
const read = (dir: string) => JSON.parse(readFileSync(file(dir), 'utf8')) as Manifest
const peerRange = (version: string) => `^${version.split('.').slice(0, 2).join('.')}.0`

/** What is wrong with the four manifests for a release of `version` (none: ready). */
export function problems(version?: string): string[] {
  const out: string[] = []
  const manifests = PACKAGE_DIRS.map(read)
  const want = version ?? manifests.find((m) => m.name === CORE)!.version
  for (const m of manifests) {
    if (m.version !== want) out.push(`${m.name} is ${m.version}, not ${want}`)
    if (m.private) out.push(`${m.name} is private ("private": true): dropping it is part of the first release`)
  }
  const core = manifests.find((m) => m.name === CORE)!
  if (core.dependencies?.[WAT] !== want) out.push(`${CORE} depends on ${WAT}@${core.dependencies?.[WAT]}, not ${want}`)
  if (core.peerDependencies?.[RUST] !== want) out.push(`${CORE} takes ${RUST}@${core.peerDependencies?.[RUST]} as a peer, not ${want}`)
  const react = manifests.find((m) => m.name === '@semblance-dev/semblance-react')!
  if (react.peerDependencies?.[CORE] !== peerRange(want)) out.push(`${react.name} takes ${CORE}@${react.peerDependencies?.[CORE]}, not ${peerRange(want)}`)
  return out
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === '--check') {
    const found = problems(args[1])
    for (const p of found) console.error(p)
    if (found.length) process.exit(1)
    console.log(`The four packages are ${args[1] ?? read('.').version}, ready to publish`)
  } else {
    const version = args[0]
    if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
      console.error('usage: release-version.ts <version> | --check [<version>]')
      process.exit(2)
    }
    for (const dir of PACKAGE_DIRS) {
      const text = readFileSync(file(dir), 'utf8')
      const m = JSON.parse(text) as Manifest
      m.version = version
      if (m.name === CORE) {
        m.dependencies![WAT] = version
        m.peerDependencies![RUST] = version
      }
      if (m.peerDependencies?.[CORE]) m.peerDependencies[CORE] = peerRange(version)
      writeFileSync(file(dir), JSON.stringify(m, null, 2) + '\n')
    }
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--package-lock-only', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: repo, stdio: 'inherit' })
    console.log(`The four packages are ${version}`)
  }
}
