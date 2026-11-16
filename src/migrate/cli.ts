// `semblance migrate` and `semblance changes` (#473).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { frameworkChanges, LOCK_FILE, readLock, readSources, retiredTerms, writeLock } from './index.ts'
import { compareVersions, type Finding, migrate, type MigrateResult, updateScript, verify } from './migrate.ts'

/** The framework's own version: its package.json is two levels up in the repository, three in the package (lib/src/migrate/). */
function frameworkVersion(): string {
  for (const up of ['../../', '../../../']) {
    const path = fileURLToPath(new URL(up + 'package.json', import.meta.url))
    if (existsSync(path)) return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
  }
  throw new Error('no package.json for the framework')
}

function print(findings: Finding[], json: boolean, extra: Record<string, unknown> = {}) {
  if (json) {
    console.log(JSON.stringify({ findings, ...extra }, null, 2))
    return
  }
  const order: Finding['kind'][] = ['migrated', 'meaning', 'review', 'manual', 'prose']
  for (const kind of order) {
    for (const f of findings.filter((x) => x.kind === kind)) {
      const place = f.file ? `${f.file}${f.line ? ':' + f.line : ''}: ` : ''
      console.log(`${kind.padEnd(8)} ${place}${f.message}${f.change ? `  [${f.change.replace('https://semblance.dev/change/', 'change:')}]` : ''}`)
    }
  }
}

export async function run(command: string, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      check: { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      from: { type: 'string' },
      to: { type: 'string' },
      since: { type: 'string' },
      'accept-loss': { type: 'boolean', default: false },
      changes: { type: 'string' },
      update: { type: 'boolean', default: false },
    },
  })
  const changes = frameworkChanges(values.changes && resolve(values.changes))
  if (command === 'changes') {
    const since = values.since
    const listed = changes.filter((c) => since === undefined || c.release === undefined || compareVersions(c.release, since) > 0)
    if (values.json) console.log(JSON.stringify(listed, null, 2))
    else for (const c of listed) console.log(`${c.iri.replace('https://semblance.dev/change/', 'change:')}${c.release ? ` (${c.release})` : ' (unreleased)'}\n  ${c.label}\n\n  Why: ${c.motivation}\n\n  What: ${c.substance}\n\n  Forward: ${c.forwardGuide}\n\n  Back: ${c.backwardGuide}\n`)
    return 0
  }
  const lockPath = resolve(LOCK_FILE)
  const lock = readLock(lockPath)
  if (values.update) {
    process.stdout.write(updateScript(changes, values.from ?? lock.writtenAgainst, lock.applied))
    return 0
  }
  const files = readSources(positionals.length ? positionals.map((p) => resolve(p)) : [resolve('.')])
  if (values.verify) {
    const findings = await verify({ files, changes, retired: [...retiredTerms(), ...changes.flatMap((c) => c.retires)], applied: changes.filter((c) => lock.applied.includes(c.iri) || c.release !== undefined).map((c) => c.iri) })
    print(findings, values.json, { ok: findings.length === 0 })
    if (!values.json) console.log(findings.length ? `${findings.length} problem(s).` : 'Verified: no retired term left, every file and query parses, round trips hold.')
    return findings.length ? 1 : 0
  }
  const back = values.to !== undefined
  const result: MigrateResult = await migrate({
    files,
    changes,
    direction: back ? 'backward' : 'forward',
    from: values.from ?? lock.writtenAgainst,
    to: values.to,
    applied: lock.applied,
  })
  const pending = result.findings.filter((f) => f.kind === 'review' || f.kind === 'manual')
  const moved = result.files.filter((f, i) => f.text !== files[i]!.text)
  print(result.findings, values.json, { changes: result.changes, wouldChange: moved.map((f) => f.path) })
  if (back && !values['accept-loss'] && result.findings.some((f) => f.kind === 'review' && f.message.startsWith('does not come back'))) {
    console.error('Some of this does not come back; nothing was written. Read the above, then add --accept-loss.')
    return 1
  }
  if (values.check) return moved.length || pending.length ? 1 : 0
  for (const f of moved) writeFileSync(f.path, f.text)
  const unreleased = new Set(changes.filter((c) => c.release === undefined).map((c) => c.iri))
  const applied = back ? lock.applied.filter((a) => !result.changes.includes(a)) : [...new Set([...lock.applied, ...result.changes])].filter((a) => unreleased.has(a))
  writeLock(lockPath, { writtenAgainst: back ? values.to : frameworkVersion(), applied })
  if (!values.json) console.log(`${moved.length} file(s) written; ${result.changes.length} change(s). ${pending.length ? `${pending.length} left to settle.` : ''}`)
  return pending.length ? 1 : 0
}
