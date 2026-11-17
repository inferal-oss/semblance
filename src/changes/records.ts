// The framework's change log as a graph (chg:Log, ontology/layers/change.ttl): what the change files
// say (ontology/changes/*.ttl) and what git knows about them. When each change was recorded and by
// which commit (the commit that added its file), which release it shipped in (the change's own
// chg:release, else the earliest v<version> tag whose history holds that commit, else none yet),
// the releases themselves (the tags, by version), and every version step of every component (the
// history of ontology/versions.ttl). The site shows it (c:ChangeLog), as a page and as Markdown;
// nothing in it is written by hand. Node only: it runs git. A checkout without history (a shallow
// clone) would place every change in no release, so in CI that is an error.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NS } from '../ns.ts'
import { loadChanges, type LoadedChange } from '../migrate/changes.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const REPO = 'https://github.com/inferal-oss/semblance'
/** The framework's change log. */
export const CHANGE_LOG = 'https://semblance.dev/changes'
const CHANGE = 'https://semblance.dev/change/'
const STEP = CHANGE_LOG + '/step/'
const RELEASE = 'https://semblance.dev/release/'
const UNRELEASED = CHANGE_LOG + '/unreleased'

/** A release tag: its version, the commit it points at and its date. */
export interface ReleaseTag {
  version: string
  commit: string
  date: string
}

export interface RecordsOptions {
  /** The repository (default: this checkout). */
  root?: string
  /** The release tags; default: the repository's v<version> tags. */
  tags?: ReleaseTag[]
  /** More change files' Turtle, as if they were in ontology/changes/ (no commit: unreleased unless they state a release). */
  extra?: string[]
}

/** Versions compared as semantic versions (0.10.0 after 0.9.0; a pre-release before its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('-', 2) as [string, string | undefined]
    return { nums: core.split('.').map(Number), pre }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
  if (x.pre === y.pre) return 0
  return x.pre === undefined ? 1 : y.pre === undefined ? -1 : x.pre < y.pre ? -1 : 1
}

/** The lines of a diff from one text to another, by their longest common subsequence: removals before additions. */
export function lineDiff(before: string, after: string): { kind: 'context' | 'removed' | 'added'; text: string }[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: { kind: 'context' | 'removed' | 'added'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i]! })
      i++
      j++
    } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ kind: 'removed', text: a[i++]! })
    else out.push({ kind: 'added', text: b[j++]! })
  }
  return out
}

/** The change log of the framework as Turtle: the change files and what git says about them. */
export function changeRecords(options: RecordsOptions = {}): string {
  const root = options.root ?? ROOT
  const git = (...args: string[]): string | undefined => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).trim()
    } catch {
      return undefined
    }
  }
  if (process.env.CI && git('rev-parse', '--is-shallow-repository') === 'true')
    throw new Error('changes: a shallow clone has no history to date changes or place them in releases (check out with fetch-depth: 0 and the tags)')

  // --- the releases: the v<version> tags, the latest first ---------------------------------------
  const tags = (
    options.tags ??
    (git('for-each-ref', 'refs/tags/v*', '--format=%(refname:short) %(*objectname) %(objectname) %(creatordate:short)') ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(' ')
        // An annotated tag names its commit (*objectname); a lightweight one is the commit.
        const [name, deref, object, date] = parts.length === 4 ? parts : [parts[0], '', parts[1], parts[2]]
        return { version: name!.slice(1), commit: deref || object!, date: date! }
      })
  )
    .filter((t) => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(t.version))
    .sort((a, b) => compareVersions(b.version, a.version))
  const ancestry = new Map<string, string | undefined>()
  /** The earliest release whose history holds a commit (none: unreleased). */
  const releaseOf = (commit: string | undefined): string | undefined => {
    if (!commit) return undefined
    if (!ancestry.has(commit)) {
      let found: string | undefined
      for (const t of [...tags].reverse())
        if (git('merge-base', '--is-ancestor', commit, t.commit) !== undefined) {
          found = t.version
          break
        }
      ancestry.set(commit, found)
    }
    return ancestry.get(commit)
  }

  // --- the changes ------------------------------------------------------------------------------
  const dir = join(root, 'ontology/changes')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.ttl')).sort() : []
  interface Recorded {
    change: LoadedChange
    text: string
    commit?: string
    date?: string
    release?: string
  }
  const recorded: Recorded[] = []
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8')
    const change = loadChanges([text])[0]
    if (!change) continue
    const added = git('log', '--diff-filter=A', '--format=%H %as', '--', 'ontology/changes/' + f)?.split('\n').filter(Boolean).pop()
    const [commit, date] = added ? added.split(' ') : []
    recorded.push({ change, text, commit, date, release: change.release ?? releaseOf(commit) })
  }
  // Extra files: each file's text once, with its first change (the others' facts follow theirs).
  for (const text of options.extra ?? [])
    loadChanges([text]).forEach((change, i) => recorded.push({ change, text: i === 0 ? text : '', release: change.release, date: /chg:recorded "([\d-]+)"/.exec(text)?.[1] }))

  // --- the version steps: the first commit that recorded each (component, version) ------------
  const prefixes = new Map<string, string>()
  const versionsText = existsSync(join(root, 'ontology/versions.ttl')) ? readFileSync(join(root, 'ontology/versions.ttl'), 'utf8') : ''
  for (const m of versionsText.matchAll(/^@prefix (\w+): <([^>]+)> \.$/gm)) prefixes.set(m[1]!, m[2]!)
  const line = /^\+([a-z][\w]*):([A-Za-z][\w-]*) sem:version (\d+) ; sem:closure "[0-9a-f]+" ; (?:sem:changedBy change:([\w-]+)|sem:internal "((?:[^"\\]|\\.)*)") \.$/
  interface Step {
    component: string
    version: number
    commit?: string
    date?: string
    changedBy?: string
    internal?: string
  }
  const steps = new Map<string, Step>()
  let commit = ''
  let date = ''
  for (const l of (git('log', '--reverse', '--format=%x01 %H %as', '-p', '--no-renames', '--', 'ontology/versions.ttl') ?? '').split('\n')) {
    if (l.startsWith('\x01 ')) {
      ;[, commit, date] = l.split(' ') as [string, string, string]
      continue
    }
    const m = line.exec(l)
    if (!m || !prefixes.has(m[1]!)) continue
    const component = prefixes.get(m[1]!)! + m[2]!
    const key = component + ' ' + m[3]
    if (!steps.has(key)) steps.set(key, { component, version: Number(m[3]), commit, date, changedBy: m[4] ? CHANGE + m[4] : undefined, internal: m[5]?.replace(/\\(.)/g, '$1') })
  }
  // A step a change's migration states that the history does not have yet (a change not merged).
  for (const r of recorded)
    for (const m of r.change.migrations)
      if (m.of && m.to !== undefined && !steps.has(m.of + ' ' + m.to)) steps.set(m.of + ' ' + m.to, { component: m.of, version: m.to, date: r.date, changedBy: r.change.iri })

  // --- the graph ------------------------------------------------------------------------------
  const lit = (s: string) => JSON.stringify(s)
  const date_ = (d: string) => `${lit(d)}^^xsd:date`
  const releaseIri = (v: string | undefined) => `<${v ? RELEASE + v : UNRELEASED}>`
  const commitIri = (c: string) => `<${REPO}/commit/${c}>`
  const out: string[] = [
    `@prefix chg: <${NS.chg}> .`,
    `@prefix mig: <${NS.mig}> .`,
    `@prefix sem: <${NS.sem}> .`,
    `@prefix c: <${NS.c}> .`,
    `@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .`,
    `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`,
    '',
    '# Generated by src/changes/records.ts from ontology/changes/, the history of ontology/versions.ttl and the release tags.',
    `<${CHANGE_LOG}> a chg:Log .`,
    `${releaseIri(undefined)} a chg:Release ; chg:log <${CHANGE_LOG}> ; chg:unreleased true ; sem:order 0${tags[0] ? ` ; chg:previous ${releaseIri(tags[0].version)}` : ''} .`,
    ...tags.map(
      (t, i) =>
        `${releaseIri(t.version)} a chg:Release ; chg:log <${CHANGE_LOG}> ; chg:version ${lit(t.version)} ; chg:tag ${lit('v' + t.version)} ; chg:date ${date_(t.date)} ; chg:commit ${commitIri(t.commit)} ; sem:order ${i + 1}${tags[i + 1] ? ` ; chg:previous ${releaseIri(tags[i + 1]!.version)}` : ''} .`,
    ),
  ]
  // Each release's changes, newest first (then by name): sem:order within it.
  const byRelease = new Map<string, Recorded[]>()
  for (const r of recorded) byRelease.set(r.release ?? '', [...(byRelease.get(r.release ?? '') ?? []), r])
  for (const list of byRelease.values()) list.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.change.label.localeCompare(b.change.label))
  for (const list of byRelease.values())
    list.forEach((r, i) => {
      const slug = r.change.iri.startsWith(CHANGE) ? r.change.iri.slice(CHANGE.length) : r.change.iri.replace(/^.*[#/]/, '')
      out.push('', r.text, `<${r.change.iri}> sem:slug ${lit(slug)} ; sem:order ${i} ; chg:releasedIn ${releaseIri(r.release)}${r.date ? ` ; chg:recorded ${date_(r.date)}` : ''}${r.commit ? ` ; chg:commit ${commitIri(r.commit)}` : ''} .`)
      for (const m of r.change.migrations)
        m.examples.forEach((ex, n) => {
          const diff = `${m.iri}/~example-${n}`
          const lines = lineDiff(ex.before, ex.after)
          out.push(`<${m.iri}> mig:exampleDiff <${diff}> .`, `<${diff}> sem:order ${n} ; mig:lines ( ${lines.map((_, k) => `<${diff}/~line-${k}>`).join(' ')} ) .`)
          lines.forEach((l, k) => out.push(`<${diff}/~line-${k}> a c:DiffLine ; c:value ${lit(l.text)} ; c:diffKind c:Diff${l.kind === 'context' ? 'Context' : l.kind === 'added' ? 'Added' : 'Removed'} .`))
        })
    })
  out.push('')
  for (const s of steps.values()) {
    const release = s.commit ? releaseOf(s.commit) : s.changedBy ? recorded.find((r) => r.change.iri === s.changedBy)?.release : undefined
    out.push(
      `<${STEP}${encodeURIComponent(s.component)}/${s.version}> a chg:Step ; chg:of <${s.component}> ; sem:version ${s.version} ; chg:releasedIn ${releaseIri(release)}` +
        (s.changedBy ? ` ; sem:changedBy <${s.changedBy}>` : '') +
        (s.internal !== undefined ? ` ; sem:internal ${lit(s.internal)}` : '') +
        (s.date ? ` ; chg:recorded ${date_(s.date)}` : '') +
        (s.commit ? ` ; chg:commit ${commitIri(s.commit)}` : '') +
        ' .',
    )
  }
  return out.join('\n') + '\n'
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(changeRecords())
