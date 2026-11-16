// Component migrations (#473, docs/MIGRATIONS.md): moving an app's Turtle across framework versions.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NS } from '../ns.ts'
import { type LoadedChange, loadChanges } from './changes.ts'
import { type SourceFile } from './migrate.ts'

export { loadChanges, type LoadedChange, type MigrationStep, type Rename } from './changes.ts'
export { exampleProblems, type Finding, type FindingKind, migrate, type MigrateOptions, type MigrateResult, roundTrip, type SourceFile, updateScript, verify } from './migrate.ts'

/** What a project says it was written against. */
export const LOCK_FILE = 'semblance.lock.ttl'
const ontologyDir = fileURLToPath(new URL('../../ontology/', import.meta.url))
const CHANGE_NS = 'https://semblance.dev/change/'

/** The framework's changes, and those of a directory of a project's own. */
export function frameworkChanges(extra?: string): LoadedChange[] {
  const dirs = [join(ontologyDir, 'changes'), ...(extra ? [extra] : [])]
  return loadChanges(dirs.filter(existsSync).flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.ttl')).sort().map((f) => readFileSync(join(d, f), 'utf8'))))
}

/** Every retired term of the framework. */
export function retiredTerms(): string[] {
  const out: string[] = []
  const prefixes = new Map<string, string>(Object.entries(NS))
  for (const m of readFileSync(join(ontologyDir, 'terms.ttl'), 'utf8').matchAll(/^([a-z][\w]*):([^\s]+) a sem:RetiredTerm \.$/gm)) out.push(prefixes.get(m[1]!)! + m[2]!)
  return out
}

const SKIP = new Set(['node_modules', 'dist', 'lib', '.git', '.test-full', 'target', 'build'])
const SOURCE = /\.(ttl|ts|tsx|js|jsx|mjs)$/

/** The Turtle and code under some paths: Turtle is rewritten, code is only read for terms left behind. */
export function readSources(paths: string[]): SourceFile[] {
  const out: SourceFile[] = []
  const add = (p: string) => {
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) if (!SKIP.has(f)) add(join(p, f))
    } else if (SOURCE.test(p) && !p.endsWith('.d.ts') && !p.endsWith(LOCK_FILE)) out.push({ path: p, text: readFileSync(p, 'utf8') })
  }
  for (const p of paths) add(p)
  return out
}

export interface Lock {
  writtenAgainst?: string
  applied: string[]
}

export function readLock(path: string): Lock {
  if (!existsSync(path)) return { applied: [] }
  const text = readFileSync(path, 'utf8')
  return {
    writtenAgainst: /sem:writtenAgainst\s+"([^"]+)"/.exec(text)?.[1],
    applied: [...text.matchAll(/change:([a-z][a-z0-9-]*)/g)].map((m) => CHANGE_NS + m[1]),
  }
}

export function writeLock(path: string, lock: Lock) {
  const applied = lock.applied.length ? ` ;\n    chg:applied ${lock.applied.map((a) => 'change:' + a.slice(CHANGE_NS.length)).join(' , ')}` : ''
  writeFileSync(path, `# Written by \`semblance migrate\`: what this project's Turtle is written against.
@prefix sem: <${NS.sem}> .
@prefix chg: <${NS.chg}> .
@prefix change: <${CHANGE_NS}> .

<#project> sem:writtenAgainst "${lock.writtenAgainst ?? '0.0.0'}"${applied} .
`)
}
