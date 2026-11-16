// Going forward and back returns what was there (#473, docs/MIGRATIONS.md): every migration's
// examples in both directions, and every change over the site, the examples and the ontology. A
// change that does not come back has to say so with mig:loses.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { frameworkChanges, loadChanges, type LoadedChange, roundTrip, exampleProblems, type SourceFile } from '../src/migrate/index.ts'

const root = new URL('../', import.meta.url).pathname
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (f === 'node_modules' ? [] : statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
/** Everything a change reaches. The records in ontology/ are left alone by the tool. */
const project: SourceFile[] = ['demo', 'examples', 'ontology'].flatMap((d) => walk(root + d)).filter((f) => f.endsWith('.ttl') && !f.includes('/vendor/')).map((path) => ({ path, text: readFileSync(path, 'utf8') }))

const HEAD = `@prefix chg: <https://semblance.dev/ns/change#> .
@prefix mig: <https://semblance.dev/ns/migration#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix change: <https://semblance.dev/change/> .
@prefix c: <https://semblance.dev/ns/component#> .
`
const body = `rdfs:label "L" ; chg:motivation "m" ; chg:substance "s" ; chg:forwardGuide "f" ; chg:backwardGuide "b" ; chg:affects c:T`
const change = (migration: string): LoadedChange[] => loadChanges([`${HEAD}change:x a chg:Change ; ${body} ; chg:migrations ( change:x1 ) .\nchange:x1 a mig:Migration ; mig:of c:T ; mig:from 1 ; mig:to 2 ; ${migration} .`])
const SPLIT_F = `DELETE { ?f c:width ?w ; c:height ?h } INSERT { ?f c:size ?sz . ?sz c:w ?w ; c:h ?h } WHERE { ?f a c:Frame ; c:width ?w ; c:height ?h BIND(IRI(CONCAT(STR(?f), "/~size")) AS ?sz) }`
const SPLIT_B = `DELETE { ?f c:size ?sz . ?sz c:w ?w ; c:h ?h } INSERT { ?f c:width ?w ; c:height ?h } WHERE { ?f a c:Frame ; c:size ?sz . ?sz c:w ?w ; c:h ?h }`
const EX = `mig:example [ mig:before """ex:f a c:Frame ; c:width 1 ; c:height 2 .""" ; mig:after """ex:f a c:Frame ; c:size <https://example.org/x#f/~size> . <https://example.org/x#f/~size> c:w 1 ; c:h 2 .""" ]`
const PREFIXED = EX.replaceAll('ex:f', '<https://example.org/x#f>')

describe('every change the framework ships', () => {
  const changes = frameworkChanges()
  it.each(changes.map((c) => [c.iri, c] as const))('%s comes back in its examples', async (_iri, c) => {
    expect(await exampleProblems(c)).toEqual([])
  })
  it('comes back over the site, the examples and the ontology', async () => {
    expect(await roundTrip(project, changes)).toEqual([])
  }, 120_000)
})

describe('the check itself', () => {
  it('runs an example in both directions', async () => {
    expect(await exampleProblems(change(`mig:forward """${SPLIT_F}""" ; mig:backward """${SPLIT_B}""" ; ${PREFIXED}`)[0]!)).toEqual([])
  })
  it('catches an example the migration does not produce', async () => {
    const wrong = PREFIXED.replace('c:w 1', 'c:w 9')
    const out = await exampleProblems(change(`mig:forward """${SPLIT_F}""" ; mig:backward """${SPLIT_B}""" ; ${wrong}`)[0]!)
    expect(out.some((d) => d.includes('forward') && d.includes('"9"'))).toBe(true)
  })
  it('catches a migration that does not come back', async () => {
    const out = await exampleProblems(change(`mig:forward """${SPLIT_F}""" ; mig:backward "DELETE { ?f c:size ?s } WHERE { ?f c:size ?s }" ; ${PREFIXED}`)[0]!)
    expect(out.some((d) => d.includes('backward') && d.includes('lost'))).toBe(true)
  })
  it('accepts what a migration says it loses', async () => {
    const lossy = `mig:forward "DELETE { ?x c:delay ?d } WHERE { ?x c:delay ?d }" ; mig:loses "the delay" ; mig:example [ mig:before "<urn:a> c:delay 3 ; c:label 1 ." ; mig:after "<urn:a> c:label 1 ." ]`
    expect(await exampleProblems(change(lossy)[0]!)).toEqual([])
  })
  it('takes a rename over the whole project and back, byte for byte', async () => {
    const rename = change('mig:renames [ mig:old c:itemChecked ; mig:new c:itemCheckedProperty ]')
    expect(await roundTrip(project, rename)).toEqual([])
  }, 120_000)
  it('catches a change of shape that loses data over the project', async () => {
    const files: SourceFile[] = [{ path: 'a.ttl', text: `${HEAD}<urn:f> a c:Frame ; c:width 1 ; c:height 2 .\n` }]
    const out = await roundTrip(files, change(`mig:forward """${SPLIT_F}""" ; mig:backward "DELETE { ?f c:size ?s } WHERE { ?f c:size ?s }"`))
    expect(out.length).toBeGreaterThan(0)
  })
  it('leaves a change that states its loss out of the round trip', async () => {
    const files: SourceFile[] = [{ path: 'a.ttl', text: `${HEAD}<urn:a> c:delay 3 .\n` }]
    expect(await roundTrip(files, change('mig:forward "DELETE { ?x c:delay ?d } WHERE { ?x c:delay ?d }" ; mig:loses "the delay"'))).toEqual([])
  })
})
