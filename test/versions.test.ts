// Per-component versions and the term list (src/migrate/versions.ts, AGENTS.md "When a component
// changes"): the records match the ontology, and every way of leaving them behind is caught.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bump, CHANGE_BASE, type Change, check, definitions, type Problem, readChanges, readTerms, readVersions, type State, writeTerms, writeVersions } from '../src/migrate/versions.ts'
import { ONTOLOGY_FILES } from '../src/ontology.ts'

const read = (f: string) => readFileSync(new URL('../ontology/' + f, import.meta.url), 'utf8')
const changeShape = read('layers/change.ttl')
const P = `@prefix sem: <https://semblance.dev/ns/core#> .
@prefix c: <https://semblance.dev/ns/component#> .
@prefix sty: <https://semblance.dev/ns/style#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix chg: <https://semblance.dev/ns/change#> .
@prefix mig: <https://semblance.dev/ns/migration#> .
@prefix change: <${CHANGE_BASE}> .
`
const C = 'https://semblance.dev/ns/component#'
const BASE = `c:Thing a owl:Class ; rdfs:subClassOf sem:Component .
c:label a owl:DatatypeProperty .
c:ThingR a sem:Rendering ; sem:targets c:Thing .
c:ThingR-sparql a sem:Rule ; sem:implements c:ThingR ; sem:construct "one" .
[] a sty:StyleRule ; sty:appliesTo c:Thing ; sty:value "red" .
`
const done = `rdfs:label "l" ; chg:motivation "m" ; chg:substance "s" ; chg:forwardGuide "f" ; chg:backwardGuide "b"`
const change = (rest: string): Change[] => readChanges([P + `change:x a chg:Change ; ${done} ; ${rest} .`], changeShape)

/** A state whose records are up to date with `from`, with the ontology then replaced by `to`. */
function moved(from: string, to: string, changes: Change[] = []): State {
  const first = definitions([P + from])
  const up = bump({ definitions: first, versions: new Map(), terms: { current: new Set(), retired: new Set() }, changes: [] }, {})
  return { definitions: definitions([P + to]), versions: up.versions, terms: up.terms, changes }
}
const kinds = (ps: Problem[]) => ps.map((p) => p.kind)

describe('the records', () => {
  it('match the ontology (npm run versions -- --bump, AGENTS.md)', () => {
    const dir = new URL('../ontology/changes/', import.meta.url)
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.ttl')) : []
    const problems = check({
      definitions: definitions(ONTOLOGY_FILES.map(read)),
      versions: readVersions(read('versions.ttl')),
      terms: readTerms(read('terms.ttl')),
      changes: readChanges(files.map((f) => read('changes/' + f)), changeShape),
    })
    expect(problems).toEqual([])
  })

  it('round-trip through their files', () => {
    const up = moved(BASE, BASE)
    expect(readVersions(writeVersions(up.versions))).toEqual(up.versions)
    expect(readTerms(writeTerms(up.terms))).toEqual(up.terms)
  })
})

describe('a closure', () => {
  const hash = (ttl: string, iri = C + 'Thing') => definitions([P + ttl]).closures.get(iri)
  it('does not depend on file order or blank node labels', () => {
    const [a, b] = [`c:Thing a owl:Class ; rdfs:subClassOf sem:Component .\n`, `_:x a sty:StyleRule ; sty:appliesTo c:Thing ; sty:value "red" .\n`]
    expect(hash(b + a)).toBe(hash(a + b.replace('_:x', '_:other')))
  })
  it('follows its rules through the rendering they implement, and its styles', () => {
    expect(hash(BASE.replace('"one"', '"two"'))).not.toBe(hash(BASE))
    expect(hash(BASE.replace('"red"', '"blue"'))).not.toBe(hash(BASE))
  })
  it('leaves what is not about it alone', () => {
    expect(hash(BASE + 'c:Other a owl:Class ; rdfs:subClassOf sem:Component ; rdfs:comment "x" .')).toBe(hash(BASE))
  })
})

describe('a changed component', () => {
  const changed = BASE.replace('"one"', '"two"')
  it('fails the check until it is stepped', () => {
    expect(kinds(check(moved(BASE, changed)))).toEqual(['changed'])
  })
  it('needs a decision: a bump with neither reason nor change writes nothing', () => {
    const out = bump(moved(BASE, changed), {})
    expect(out.undecided).toEqual([C + 'Thing'])
  })
  it('steps with a stated reason', () => {
    const s = moved(BASE, changed)
    const out = bump(s, { internal: 'a refactor' })
    expect(out.versions.get(C + 'Thing')).toMatchObject({ version: 2, internal: 'a refactor' })
    expect(check({ ...s, versions: out.versions, terms: out.terms })).toEqual([])
  })
  it('steps with a change only where that change says it affects it', () => {
    const iri = CHANGE_BASE + 'x'
    const yes = moved(BASE, changed, change('chg:affects c:Thing'))
    expect(bump(yes, { change: iri }).versions.get(C + 'Thing')).toMatchObject({ version: 2, changedBy: iri })
    const no = moved(BASE, changed, change('chg:affects c:Other'))
    expect(bump(no, { change: iri }).undecided).toEqual([C + 'Thing'])
  })
  it('is caught against the base branch when its record was changed without a step', () => {
    const s = moved(BASE, changed)
    const base = { versions: s.versions, terms: s.terms }
    const edited = new Map(s.versions).set(C + 'Thing', { ...s.versions.get(C + 'Thing')!, closure: definitions([P + changed]).closures.get(C + 'Thing')! })
    expect(kinds(check({ ...s, versions: edited }, base))).toEqual(['no-step'])
  })
})

describe('terms', () => {
  const gone = BASE.replace('c:label a owl:DatatypeProperty .\n', '')
  it('a new term must be listed', () => {
    expect(kinds(check(moved(BASE, BASE + 'c:more a owl:DatatypeProperty .')))).toEqual(['term-new'])
  })
  it('a term cannot go without a change, even with a reason', () => {
    const s = moved(BASE, gone)
    expect(kinds(check(s))).toEqual(['term-unexplained'])
    expect(bump(s, { internal: 'tidying' }).unexplained).toEqual([C + 'label'])
  })
  it('a term a change retires becomes retired, and a rename retires its old name', () => {
    for (const rest of ['chg:affects c:Thing ; chg:retires c:label', `chg:affects c:Thing ; chg:migrations ( change:m ) . change:m a mig:Migration ; mig:of c:Thing ; mig:from 1 ; mig:to 2 ; mig:renames [ mig:old c:label ; mig:new c:name ]`]) {
      const out = bump(moved(BASE, gone, change(rest)), {})
      expect(out.unexplained).toEqual([])
      expect(out.terms.retired.has(C + 'label')).toBe(true)
    }
  })
  it('a retired name is never reused', () => {
    const s = moved(BASE, BASE)
    s.terms.current.delete(C + 'label')
    s.terms.retired.add(C + 'label')
    expect(kinds(check(s))).toEqual(['term-reused'])
  })
})

describe('a change', () => {
  const problems = (rest: string) => change(rest)[0]!.problems
  it('says what the shape asks for', () => {
    expect(readChanges([P + 'change:x a chg:Change ; chg:affects c:Thing .'], changeShape)[0]!.problems.length).toBe(5)
    expect(problems('chg:affects c:Thing')).toEqual([])
  })
  it('is not finished while it has TODO in it', () => {
    expect(problems('chg:affects c:Thing ; rdfs:comment "TODO"')).toEqual(['still has TODO in its text'])
  })
  it('comes back, or says what is lost', () => {
    const m = (rest: string) => `chg:affects c:Thing ; chg:migrations ( change:m ) . change:m a mig:Migration ; mig:of c:Thing ; mig:from 1 ; mig:to 2 ; ${rest}`
    const ex = 'mig:example [ mig:before "a" ; mig:after "b" ]'
    expect(problems(m(`mig:forward "DELETE" ; ${ex}`))).toEqual(['change:m: mig:forward with neither mig:backward nor mig:loses'])
    expect(problems(m(`mig:forward "DELETE" ; mig:backward "INSERT" ; ${ex}`))).toEqual([])
    expect(problems(m(`mig:forward "DELETE" ; mig:loses "the delay" ; ${ex}`))).toEqual([])
    expect(problems(m('mig:forward "DELETE" ; mig:backward "INSERT"'))).toEqual(['change:m: mig:forward with no mig:example'])
  })
  it('does not turn a convergence into plain renames', () => {
    const m = (a: string, loses = '') => `change:${a} a mig:Migration ; mig:of c:${a} ; mig:from 1 ; mig:to 2 ; mig:renames [ mig:old c:${a} ; mig:new c:Choice ] ${loses}`
    const conv = (l: string) => change(`chg:affects c:a, c:b ; chg:migrations ( change:a change:b ) . ${m('a', l)} . ${m('b', l)}`)
    const state = (cs: Change[]): State => ({ ...moved(BASE, BASE), changes: cs })
    expect(kinds(check(state(conv(''))))).toEqual(['converges', 'converges'])
    expect(kinds(check(state(conv('; mig:loses "which it was"'))))).toEqual([])
  })
})
