// Per-component versions and changes (#473; AGENTS.md, "When a component changes").
//   npm run versions -- --check [--against <ref>]   fail, saying what to do, when the records do not match
//   npm run versions -- --bump --change <slug>      step the components that change explains
//   npm run versions -- --bump --internal "<why>"   step the rest: nothing a consumer would notice
//   npm run change -- new <slug> --affects c:A,c:B  a change file to fill in
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ONTOLOGY_FILES } from '../src/ontology.ts'
import { bump, CHANGE_BASE, changeTemplate, check, definitions, type Base, type Problem, readChanges, readTerms, readVersions, shortName, type State, writeTerms, writeVersions } from '../src/migrate/versions.ts'

const root = resolve(import.meta.dirname, '..')
const ontology = join(root, 'ontology')
const VERSIONS = join(ontology, 'versions.ttl')
const TERMS = join(ontology, 'terms.ttl')
const CHANGES = join(ontology, 'changes')
const read = (f: string) => readFileSync(f, 'utf8')

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    check: { type: 'boolean', default: false },
    bump: { type: 'boolean', default: false },
    against: { type: 'string' },
    change: { type: 'string' },
    internal: { type: 'string' },
    affects: { type: 'string' },
  },
})

function loadState(): State {
  const changeFiles = existsSync(CHANGES) ? readdirSync(CHANGES).filter((f) => f.endsWith('.ttl')).sort() : []
  return {
    definitions: definitions(ONTOLOGY_FILES.map((f) => read(join(ontology, f)))),
    versions: existsSync(VERSIONS) ? readVersions(read(VERSIONS)) : new Map(),
    terms: existsSync(TERMS) ? readTerms(read(TERMS)) : { current: new Set(), retired: new Set() },
    changes: readChanges(changeFiles.map((f) => read(join(CHANGES, f))), read(join(ontology, 'layers/change.ttl'))),
  }
}

function baseAt(ref: string): Base | undefined {
  const show = (p: string) => {
    try {
      return execFileSync('git', ['-C', root, 'show', `${ref}:${p}`], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }).toString()
    } catch {
      return undefined
    }
  }
  const versions = show('ontology/versions.ttl')
  const terms = show('ontology/terms.ttl')
  return versions && terms ? { versions: readVersions(versions), terms: readTerms(terms) } : undefined
}

function report(problems: Problem[]) {
  const names = (kind: Problem['kind']) => problems.filter((p) => p.kind === kind).map((p) => shortName(p.iri))
  const list = (title: string, items: string[]) => {
    if (items.length) console.error(`${title}\n${items.map((i) => '  ' + i).join('\n')}\n`)
  }
  list('Definition changed, no version step:', names('changed'))
  list('New, not recorded yet:', names('new'))
  list('Recorded, no longer defined:', names('gone'))
  list('Step not accounted for (a sem:changedBy whose change does not affect it, or neither it nor sem:internal):', names('unaccounted'))
  list('New term, not listed yet:', names('term-new'))
  list('Term gone, retired by a change, not yet marked:', names('term-gone'))
  list('Term gone and NO change retires it:', names('term-unexplained'))
  list('Retired term defined again (a name is never reused):', names('term-reused'))
  list('Dropped from the term list:', names('term-dropped'))
  list('Closure differs from the base branch at the same version:', names('no-step'))
  list('Version went down from the base branch:', names('version-down'))
  list('Renames that land on one term, losing which it was (use mig:forward with a mig:discriminator, or state mig:loses):', problems.flatMap((p) => (p.kind === 'converges' ? [`${shortName(p.iri)} to ${shortName(p.term)}`] : [])))
  list('Changes that are not finished:', problems.flatMap((p) => (p.kind === 'change-invalid' ? [`${shortName(p.iri)}: ${p.problem}`] : [])))
  console.error(`What to do (AGENTS.md, "When a component changes"):

  Would a person or an app notice? A term moved or went, a rendering's output or a term's meaning changed:
    npm run change -- new <slug> --affects ${names('changed')[0] ?? 'c:Thing'}
    # fill in ontology/changes/<slug>.ttl, then
    npm run versions -- --bump --change <slug>

  Nothing a consumer would notice (a refactor, a comment, a label):
    npm run versions -- --bump --internal "why"

  A removed or renamed term always needs a change. Commit ontology/versions.ttl, ontology/terms.ttl and the change file.`)
}

if (positionals[0] === 'new') {
  const slug = positionals[1]
  if (!slug || !/^[a-z][a-z0-9-]*$/.test(slug)) throw new Error('npm run change -- new <slug> --affects c:A,c:B (a slug is lower-case-with-dashes)')
  mkdirSync(CHANGES, { recursive: true })
  const file = join(CHANGES, slug + '.ttl')
  if (existsSync(file)) throw new Error(`${file} exists`)
  writeFileSync(file, changeTemplate(slug, (values.affects ?? '').split(',').filter(Boolean)))
  console.log(`Wrote ${file}. Fill it in, then: npm run versions -- --bump --change ${slug}`)
} else if (values.bump) {
  const state = loadState()
  const change = values.change ? CHANGE_BASE + values.change : undefined
  if (change && !state.changes.some((c) => c.iri === change)) throw new Error(`no change ${values.change} in ontology/changes/`)
  const out = bump(state, { change, internal: values.internal })
  if (out.undecided.length || out.unexplained.length) {
    if (out.undecided.length) console.error(`These changed, and neither --change (its chg:affects) nor --internal covers them:\n${out.undecided.map((i) => '  ' + shortName(i)).join('\n')}\n`)
    if (out.unexplained.length) console.error(`These terms are gone and no change retires them (a change's chg:retires, or a mig:renames):\n${out.unexplained.map((i) => '  ' + shortName(i)).join('\n')}\n`)
    console.error('Nothing was written.')
    process.exit(1)
  }
  writeFileSync(VERSIONS, writeVersions(out.versions))
  writeFileSync(TERMS, writeTerms(out.terms))
  console.log(`Stepped ${out.stepped.length} component(s).`)
} else {
  const state = loadState()
  const base = values.against ? baseAt(values.against) : undefined
  const problems = check(state, base)
  if (problems.length) {
    report(problems)
    process.exit(1)
  }
  console.log(`Versions and terms match: ${state.versions.size} components, ${state.terms.current.size} terms, ${state.changes.length} changes.`)
}
