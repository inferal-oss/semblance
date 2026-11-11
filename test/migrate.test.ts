// The migration tool (src/migrate/, #473): Turtle read and edited as written, renames, changes of
// shape, forward and back, what is reported, and the command.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { loadChanges } from '../src/migrate/changes.ts'
import { migrate, type SourceFile, verify } from '../src/migrate/migrate.ts'
import { createStore } from '../src/node/load.ts'
import { SPARQL_PREFIXES } from '../src/ns.ts'
import { applyEdit, lex, parseTurtle, type Term, tripleKey, UnsupportedTurtle } from '../src/migrate/turtle.ts'

const root = new URL('../', import.meta.url).pathname
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (f === 'node_modules' ? [] : statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
const repoTurtle = ['ontology', 'demo', 'examples'].flatMap((d) => walk(root + d)).filter((f) => f.endsWith('.ttl'))

const P = `@prefix c: <https://semblance.dev/ns/component#> .
@prefix sem: <https://semblance.dev/ns/core#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix sty: <https://semblance.dev/ns/style#> .
@prefix beh: <https://semblance.dev/ns/behaviour#> .
@prefix ex: <https://example.org/x#> .
`
const CHANGE = `@prefix chg: <https://semblance.dev/ns/change#> .
@prefix mig: <https://semblance.dev/ns/migration#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix change: <https://semblance.dev/change/> .
${P}
`
const body = `rdfs:label "L" ; chg:motivation "m" ; chg:substance "s" ; chg:forwardGuide "f" ; chg:backwardGuide "b" ; chg:affects c:Thing`
const renaming = (extra = '', slug = '') =>
  loadChanges([`${CHANGE}change:r a chg:Change ; ${body} ${extra} ; chg:migrations ( change:r1 ) .
change:r1 a mig:Migration ; mig:of c:Thing ; mig:from 1 ; mig:to 2 ; mig:renames [ mig:old c:value ; mig:new c:currentValue ] ${slug} .`])
const shaping = (forward: string, backward: string, name = 's') =>
  loadChanges([`${CHANGE}change:${name} a chg:Change ; ${body} ; chg:retires c:width, c:height ; chg:migrations ( change:${name}1 ) .
change:${name}1 a mig:Migration ; mig:of c:Frame ; mig:from 1 ; mig:to 2 ; mig:forward """${forward}""" ; mig:backward """${backward}""" .`])
const SPLIT = {
  f: `DELETE { ?f c:width ?w ; c:height ?h } INSERT { ?f c:size ?sz . ?sz c:w ?w ; c:h ?h } WHERE { ?f a c:Frame ; c:width ?w ; c:height ?h BIND(IRI(CONCAT(STR(?f), "/~size")) AS ?sz) }`,
  b: `DELETE { ?f c:size ?sz . ?sz c:w ?w ; c:h ?h } INSERT { ?f c:width ?w ; c:height ?h } WHERE { ?f a c:Frame ; c:size ?sz . ?sz c:w ?w ; c:h ?h }`,
}
const file = (text: string, path = 'a.ttl'): SourceFile => ({ path, text: P + text })
const stripP = (t: string) => t.slice(P.length)

describe('Turtle as written', () => {
  it('lexes every character, on every file in the repository', () => {
    for (const f of repoTurtle) {
      const t = readFileSync(f, 'utf8')
      expect(lex(t).map((x) => x.text).join(''), f).toBe(t)
    }
  })
  it('states the same triples as a Turtle parser, on every file in the repository', () => {
    const show = (t: Term | { termType: string; value: string; language?: string; datatype?: { value: string } }) => {
      if ('k' in t) return t.k === 'bnode' ? '_' : t.k === 'iri' ? `<${t.v}>` : JSON.stringify([t.value, t.lang ?? '', t.lang ? '' : (t.dt ?? 'http://www.w3.org/2001/XMLSchema#string')])
      return t.termType === 'BlankNode' ? '_' : t.termType === 'NamedNode' ? `<${t.value}>` : JSON.stringify([t.value, t.language ?? '', t.language ? '' : t.datatype!.value])
    }
    const unsupported: string[] = []
    for (const f of repoTurtle) {
      const text = readFileSync(f, 'utf8')
      let doc
      try {
        doc = parseTurtle(text)
      } catch (e) {
        if (e instanceof UnsupportedTurtle) {
          unsupported.push(f.slice(root.length))
          continue
        }
        throw e
      }
      const mine = doc.triples.map((t) => `${show(t.s)} ${t.p} ${show(t.o)}`).sort()
      const theirs = new Parser().parse(text).map((q) => `${show(q.subject as never)} ${q.predicate.value} ${show(q.object as never)}`).sort()
      expect(mine, f).toEqual(theirs)
    }
    // RDF 1.2 syntax stays rename-only: a handful of files, none an app's own markup.
    expect(unsupported.length, unsupported.join()).toBeLessThan(6)
  })
  it('edits only what changes', () => {
    const text = `${P}# before
ex:a a c:Button ; # the kind
    c:label "x" ,  "y" ;
    c:value 1 .

# after
ex:b c:label "z" .
`
    const doc = parseTurtle(text)
    const out = applyEdit(doc, { remove: doc.triples.filter((t) => t.o.k === 'lit' && t.o.value === 'y'), add: [] })
    expect(out).toBe(text.replace('"x" ,  "y"', '"x"'))
    const gone = applyEdit(doc, { remove: doc.triples.filter((t) => t.o.k === 'lit' && t.o.value === 'z'), add: [] })
    expect(gone).toBe(text.replace('ex:b c:label "z" .\n', ''))
    expect(parseTurtle(gone).triples.length).toBe(doc.triples.length - 1)
  })
})

describe('a rename', () => {
  const app = file(`# c:value in a comment stays
ex:a a c:TextField ; c:value "Ada" .
ex:copy c:controls ex:a ; c:property c:value ; rdfs:comment "reads c:value" .
ex:s sh:path c:value .
ex:Clear beh:deletes """CONSTRUCT { $this c:value ?old } WHERE { $this c:value ?old }""" ;
    beh:inserts """PREFIX k: <https://semblance.dev/ns/component#>
CONSTRUCT { $this k:value 1 } WHERE { $this <https://semblance.dev/ns/component#value> ?o ; c:valued ?v }""" .
ex:live c:original '''@prefix c: <https://semblance.dev/ns/component#> .
ex:x c:value 1 .''' .
`.replace('rdfs:comment', 'c:help'))
  it('reaches every position, keeps the file otherwise byte for byte, and lists what it left', async () => {
    const r = await migrate({ files: [app], changes: renaming() })
    const out = r.files[0]!.text
    expect(out.split('c:currentValue').length - 1).toBe(6)
    expect(out).toContain('k:currentValue 1')
    expect(out).toContain('<https://semblance.dev/ns/component#currentValue> ?o ; c:valued ?v')
    expect(out).toContain('# c:value in a comment stays')
    expect(out).toContain('c:help "reads c:value"')
    expect(r.findings.filter((f) => f.kind === 'prose').map((f) => f.line)).toHaveLength(2)
    expect(r.findings.filter((f) => f.kind === 'manual')).toEqual([])
    expect(out.replace(/currentValue/g, 'value')).toBe(app.text)
  })
  it('comes back byte for byte', async () => {
    const changes = renaming()
    const there = await migrate({ files: [app], changes })
    const back = await migrate({ files: there.files, changes, direction: 'backward', applied: there.changes })
    expect(back.files[0]!.text).toBe(app.text)
  })
  it('writes a name in full when the file has no prefix for it', async () => {
    const changes = loadChanges([`${CHANGE}change:r a chg:Change ; ${body} ; chg:migrations ( change:r1 ) .
change:r1 a mig:Migration ; mig:of c:Thing ; mig:from 1 ; mig:to 2 ; mig:renames [ mig:old c:value ; mig:new <https://example.com/other#v> ] .`])
    const r = await migrate({ files: [file('ex:a c:value 1 .')], changes })
    expect(stripP(r.files[0]!.text)).toBe('ex:a <https://example.com/other#v> 1 .')
  })
  it('renames a slug, where it is stated and in CSS held in the graph', async () => {
    const changes = renaming('', `; mig:renames [ mig:old "query-editor" ; mig:new "code-editor" ]`)
    const app2 = file(`ex:C sem:slug "query-editor" .
ex:r sty:state ":not([data-sem-c=query-editor] *)" ; sty:part "[data-sem-c=\\"query-editor\\"] .x" ; c:label "query-editor" .`)
    const r = await migrate({ files: [app2], changes })
    const out = stripP(r.files[0]!.text)
    expect(out).toContain('sem:slug "code-editor"')
    expect(out).toContain(':not([data-sem-c=code-editor] *)')
    expect(out).toContain('[data-sem-c=\\"code-editor\\"]')
    expect(out).toContain('c:label "query-editor"')
  })
  it('does not rewrite a name that only starts with the old one', async () => {
    const r = await migrate({ files: [file('ex:a c:valueOf 1 ; c:value 2 .')], changes: renaming() })
    expect(stripP(r.files[0]!.text)).toBe('ex:a c:valueOf 1 ; c:currentValue 2 .')
  })
  it('reports what it cannot reach in code', async () => {
    const r = await migrate({ files: [file('ex:a c:value 1 .'), { path: 'x.ts', text: `const a = 'c:value'\nconst b = "https://semblance.dev/ns/component#value"\n` }], changes: renaming() })
    expect(r.findings.filter((f) => f.kind === 'manual').map((f) => [f.file, f.line])).toEqual([['x.ts', 2], ['x.ts', 1]])
  })
})

describe('a change of shape', () => {
  const text = `# the frame
ex:f a c:Frame ; # kept
    c:width 10 ;
    c:height 20 ;
    c:label "x" .
ex:other a c:Frame ; c:width 5 .
`
  it('edits only the statements it changes, and adds what it minted', async () => {
    const r = await migrate({ files: [file(text)], changes: shaping(SPLIT.f, SPLIT.b) })
    const out = r.files[0]!.text
    expect(out).toContain('# the frame')
    expect(out).toContain('# kept')
    expect(out).toContain('c:label "x"')
    expect(out).toContain('c:size <https://example.org/x#f/~size>')
    expect(out).toContain('<https://example.org/x#f/~size> c:w 10 ;\n    c:h 20 .')
    expect(out).toContain('ex:other a c:Frame ; c:width 5 .')
    expect(() => new Parser().parse(out)).not.toThrow()
  })
  it('comes back to the same graph', async () => {
    const changes = shaping(SPLIT.f, SPLIT.b)
    const there = await migrate({ files: [file(text)], changes })
    const back = await migrate({ files: there.files, changes, direction: 'backward', applied: there.changes })
    const triples = (t: string) => parseTurtle(t).triples.map(tripleKey).sort()
    expect(triples(back.files[0]!.text)).toEqual(triples(P + text))
  })
  it('works across files', async () => {
    const files = [file('ex:f a c:Frame .', 'a.ttl'), file('ex:f c:width 1 ; c:height 2 .', 'b.ttl')]
    const r = await migrate({ files, changes: shaping(SPLIT.f, SPLIT.b) })
    expect(stripP(r.files[0]!.text)).toBe('ex:f a c:Frame .')
    expect(r.files[1]!.text).toContain('c:size')
  })
  it('leaves files alone when nothing matches, byte for byte, even over the whole site', async () => {
    const files = readdirSync(root + 'demo/gallery').filter((f) => f.endsWith('.ttl')).map((f) => ({ path: f, text: readFileSync(root + 'demo/gallery/' + f, 'utf8') }))
    const changes = shaping('DELETE { ?a <urn:no> ?b } INSERT { ?a <urn:yes> ?b } WHERE { ?a <urn:no> ?b }', 'DELETE { ?a <urn:yes> ?b } INSERT { ?a <urn:no> ?b } WHERE { ?a <urn:yes> ?b }')
    const r = await migrate({ files, changes, from: '0' })
    expect(r.files.map((f) => f.text)).toEqual(files.map((f) => f.text))
    expect(r.findings.filter((f) => f.kind === 'migrated')).toEqual([])
  })
  it('converges with a discriminator, and comes back', async () => {
    const f = `DELETE { ?x a c:Radio } INSERT { ?x a c:Choice ; c:variant "radio" } WHERE { ?x a c:Radio } ; DELETE { ?x a c:Segmented } INSERT { ?x a c:Choice ; c:variant "segmented" } WHERE { ?x a c:Segmented }`
    const b = `DELETE { ?x a c:Choice ; c:variant "radio" } INSERT { ?x a c:Radio } WHERE { ?x a c:Choice ; c:variant "radio" } ; DELETE { ?x a c:Choice ; c:variant "segmented" } INSERT { ?x a c:Segmented } WHERE { ?x a c:Choice ; c:variant "segmented" }`
    const changes = shaping(f, b)
    const app2 = file('ex:r a c:Radio ; c:label "a" .\nex:s a c:Segmented .\n')
    const there = await migrate({ files: [app2], changes, from: '0' })
    expect(there.files[0]!.text).toContain('c:variant "radio"')
    const back = await migrate({ files: there.files, changes, direction: 'backward', applied: there.changes })
    const triples = (t: string) => parseTurtle(t).triples.map(tripleKey).sort()
    expect(triples(back.files[0]!.text)).toEqual(triples(app2.text))
  })
  it('going back says what does not come back', async () => {
    const changes = loadChanges([`${CHANGE}change:l a chg:Change ; ${body} ; chg:retires c:delay ; chg:migrations ( change:l1 ) .
change:l1 a mig:Migration ; mig:of c:Thing ; mig:from 1 ; mig:to 2 ; mig:forward "DELETE { ?x c:delay ?d } WHERE { ?x c:delay ?d }" ; mig:loses "the delay" .`])
    const there = await migrate({ files: [file('ex:a c:delay 3 ; c:label "x" .')], changes })
    expect(stripP(there.files[0]!.text)).toBe('ex:a c:label "x" .')
    const back = await migrate({ files: there.files, changes, direction: 'backward', applied: there.changes })
    expect(back.findings.filter((x) => x.kind === 'review').map((x) => x.message)).toEqual(['does not come back: the delay'])
  })
})

describe('which changes apply', () => {
  const app = file('ex:a c:value 1 .')
  it('undeclared: those whose retired terms occur', async () => {
    expect((await migrate({ files: [app], changes: renaming() })).changes).toHaveLength(1)
    expect((await migrate({ files: [file('ex:a c:label 1 .')], changes: renaming() })).changes).toHaveLength(0)
  })
  it('declared: everything after the release', async () => {
    const changes = renaming('; chg:release "0.2.0"')
    expect((await migrate({ files: [app], changes, from: '0.1.0' })).changes).toHaveLength(1)
    expect((await migrate({ files: [app], changes, from: '0.2.0' })).changes).toHaveLength(0)
  })
  it('never applies a change twice', async () => {
    const changes = renaming()
    expect((await migrate({ files: [app], changes, applied: [changes[0]!.iri] })).changes).toHaveLength(0)
  })
  it('lists a change of meaning, which leaves no trace in the source', async () => {
    const changes = loadChanges([`${CHANGE}change:m a chg:Change ; ${body} .`])
    const r = await migrate({ files: [app], changes })
    expect(r.findings.map((f) => f.kind)).toEqual(['meaning'])
    expect(r.changes).toEqual([])
  })
  it('orders a change after the one it follows', () => {
    const cs = loadChanges([`${CHANGE}change:a a chg:Change ; ${body} ; chg:after change:b . change:b a chg:Change ; ${body} .`])
    expect(cs.map((c) => c.iri.slice(-1))).toEqual(['b', 'a'])
  })
})

describe('verify', () => {
  const VAL = 'https://semblance.dev/ns/component#value'
  it('finds a retired term left behind, and a file that does not parse', async () => {
    const r = await verify({ files: [file('ex:a c:value 1 .'), { path: 'b.ttl', text: 'not turtle' }], changes: [], retired: [VAL] })
    expect(r.map((f) => f.message)).toEqual([expect.stringContaining('retired'), expect.stringContaining('does not parse')])
  })
  it('passes a finished move, round trip included', async () => {
    const changes = renaming()
    const there = await migrate({ files: [file('ex:a c:value 1 .')], changes })
    expect(await verify({ files: there.files, changes, retired: [VAL], applied: there.changes })).toEqual([])
  })
  it('catches a migration that does not come back', async () => {
    const changes = shaping(SPLIT.f, 'DELETE { ?f c:size ?sz } WHERE { ?f c:size ?sz }')
    const there = await migrate({ files: [file('ex:f a c:Frame ; c:width 1 ; c:height 2 .')], changes })
    const r = await verify({ files: there.files, changes, retired: [], applied: there.changes })
    expect(r.map((f) => f.message)).toEqual([expect.stringContaining('going back and forward again')])
  })
})

describe('the command', () => {
  it('checks, writes, records, verifies and goes back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'semblance-migrate-'))
    mkdirSync(join(dir, 'changes'))
    writeFileSync(join(dir, 'changes/r.ttl'), `${CHANGE}change:r a chg:Change ; ${body} ; chg:migrations ( change:r1 ) .
change:r1 a mig:Migration ; mig:of c:Thing ; mig:from 1 ; mig:to 2 ; mig:renames [ mig:old c:value ; mig:new c:currentValue ] .`)
    writeFileSync(join(dir, 'app.ttl'), P + 'ex:a c:value 1 .\n')
    const cli = (...args: string[]) => spawnSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'bin/semblance.ts'), ...args, '--changes', 'changes', 'app.ttl'], { cwd: dir, encoding: 'utf8' })
    const check = cli('migrate', '--check')
    expect(check.status, check.stderr).toBe(1)
    expect(check.stdout).toContain('migrated')
    expect(readFileSync(join(dir, 'app.ttl'), 'utf8')).toContain('c:value 1')
    expect(cli('migrate').status).toBe(0)
    expect(readFileSync(join(dir, 'app.ttl'), 'utf8')).toContain('c:currentValue 1')
    expect(existsSync(join(dir, 'semblance.lock.ttl'))).toBe(true)
    const lock = readFileSync(join(dir, 'semblance.lock.ttl'), 'utf8')
    expect(lock).toContain('chg:applied change:r')
    expect(() => new Parser().parse(lock)).not.toThrow()
    expect(cli('migrate', '--check').status).toBe(0)
    const verified = cli('migrate', '--verify')
    expect(verified.status, verified.stdout + verified.stderr).toBe(0)
    expect(JSON.parse(cli('migrate', '--check', '--json').stdout).changes).toEqual([])
    expect(cli('migrate', '--to', '0.0.0').status).toBe(0)
    expect(readFileSync(join(dir, 'app.ttl'), 'utf8')).toContain('c:value 1')
  }, 60_000)
})

describe('the SPARQL apps write', () => {
  const changes = shaping(SPLIT.f, SPLIT.b)
  const held = (q: string) => file(`ex:r sem:construct """${q}""" .`)
  const run = async (q: string, c = changes) => {
    const there = await migrate({ files: [held(q)], changes: c, from: '0' })
    const parsed = parseTurtle(there.files[0]!.text).triples.find((t) => t.p.endsWith('construct'))!
    return { there, query: (parsed.o as { value: string }).value, findings: there.findings.filter((f) => f.kind === 'review' || f.kind === 'manual').map((f) => f.message) }
  }

  it('rewrites a template and moves the mint into the WHERE', async () => {
    const r = await run(`CONSTRUCT { ?f a c:Frame ; c:width ?w ; c:height ?h } WHERE { ?f ex:w ?w ; ex:h ?h }`)
    expect(r.query).toContain('c:size')
    expect(r.query).toContain('BIND(IRI(CONCAT(STR(?f), "/~size")) AS ?sz)')
    expect(r.query).not.toContain('c:width')
    expect(r.findings).toEqual([])
  })
  it('rewrites a read, which keeps its meaning', async () => {
    const r = await run(`CONSTRUCT { $this c:shown ?v } WHERE { $this c:of ?f . ?f a c:Frame ; c:width ?v ; c:height ?h }`)
    expect(r.query).toContain('c:size')
    expect(r.query).toContain('c:w ?v')
    expect(r.query).toContain('$this c:shown ?v')
    expect(r.query).not.toContain('BIND')
    expect(r.findings).toEqual([])
  })
  it('reaches patterns inside OPTIONAL and EXISTS', async () => {
    const r = await run(`CONSTRUCT { $this c:shown ?v } WHERE { $this c:of ?f OPTIONAL { ?f a c:Frame ; c:width ?v ; c:height ?h } FILTER EXISTS { ?g a c:Frame ; c:width ?a ; c:height ?b } }`)
    expect(r.query).not.toContain('c:width')
    expect(r.query.split('c:size').length - 1).toBe(2)
  })
  it('reports a template that writes only part of what moves', async () => {
    const r = await run(`CONSTRUCT { ?f a c:Frame ; c:width ?w } WHERE { ?f ex:w ?w }`)
    expect(r.findings.join()).toContain('part of what this migration moves')
    expect(r.query).toContain('c:width')
  })
  it('reports a template whose subject has no stated class', async () => {
    const r = await run(`CONSTRUCT { ?f c:width ?w ; c:height ?h } WHERE { ?f ex:w ?w ; ex:h ?h }`)
    expect(r.findings.join()).toContain("doesn't state the class")
  })
  it('knows the class from what holds the query', async () => {
    const app = file(`ex:R sem:targets c:Frame .
ex:r sem:implements ex:R ; sem:construct """CONSTRUCT { $this c:width ?w ; c:height ?h } WHERE { $this ex:w ?w ; ex:h ?h }""" .`)
    const there = await migrate({ files: [app], changes, from: '0' })
    expect(there.files[0]!.text).toContain('c:size')
    expect(there.findings.filter((f) => f.kind === 'review')).toEqual([])
  })
  it('comes back: the same template and WHERE', async () => {
    const q = `CONSTRUCT { ?f a c:Frame ; c:width ?w ; c:height ?h } WHERE { ?f ex:w ?w ; ex:h ?h }`
    const { there } = await run(q)
    const back = await migrate({ files: there.files, changes, direction: 'backward', applied: there.changes })
    const parsed = parseTurtle(back.files[0]!.text).triples.find((t) => t.p.endsWith('construct'))!
    const text = (parsed.o as { value: string }).value
    expect(text).toContain('c:width ?w')
    expect(text).not.toContain('BIND')
    expect(text).not.toContain('c:size')
  })

  describe('a value mapping', () => {
    const f = `DELETE { ?x c:align ?old } INSERT { ?x c:justify ?new } WHERE { ?x c:align ?old . VALUES (?old ?new) { ("left" "start") ("right" "end") } }`
    const b = `DELETE { ?x c:justify ?new } INSERT { ?x c:align ?old } WHERE { ?x c:justify ?new . VALUES (?old ?new) { ("left" "start") ("right" "end") } }`
    const values = loadChanges([`${CHANGE}change:v a chg:Change ; ${body} ; chg:retires c:align ; chg:migrations ( change:v1 ) .
change:v1 a mig:Migration ; mig:of c:Thing ; mig:from 1 ; mig:to 2 ; mig:forward """${f}""" ; mig:backward """${b}""" .`])
    it('takes a constant through the table', async () => {
      expect((await run(`CONSTRUCT { ?b c:align "left" } WHERE { ?b ex:s 1 }`, values)).query).toContain('c:justify "start"')
    })
    it('leaves a constant outside the table', async () => {
      expect((await run(`CONSTRUCT { ?b c:align "center" } WHERE { ?b ex:s 1 }`, values)).query).toContain('c:align "center"')
    })
    it('composes a value known only at run time, and restores it going back', async () => {
      const q = `CONSTRUCT { ?b c:align ?a } WHERE { ?b ex:side ?a }`
      const { there, query } = await run(q, values)
      expect(query).toContain('IF(?a = "left", "start"')
      expect(query).toContain('c:align ?keep')
      expect(query.startsWith('# semblance migrate:')).toBe(true)
      const back = await migrate({ files: there.files, changes: values, direction: 'backward', applied: there.changes })
      expect(back.files[0]!.text).toContain(q)
    })
    it('reads through the table, and the values that did not move', async () => {
      const { query } = await run(`SELECT ?b ?a WHERE { ?b c:align ?a }`.replace('SELECT ?b ?a', 'CONSTRUCT { ?b ex:a ?a }'), values)
      expect(query).toContain('UNION')
      expect(query).toContain('VALUES')
    })
    it('gives the same results before and after, in the engine', async () => {
      const q = `CONSTRUCT { ?b ex:a ?a } WHERE { ?b c:align ?a }`
      const { query } = await run(q, values)
      const data = `${P}ex:p c:align "left" . ex:q c:align "center" .`
      const moved = await migrate({ files: [{ path: 'd.ttl', text: data }], changes: values, from: '0' })
      const show = (s: { construct: (q: string, g: never[]) => { subject: { value: string }; object: { value: string } }[] }, text: string) =>
        s.construct(`${SPARQL_PREFIXES}\nPREFIX ex: <https://example.org/x#>\n${text.replace(/^# .*\n/, '')}`, []).map((x) => `${x.subject.value} ${x.object.value}`).sort()
      const [before, after] = [createStore('wat'), createStore('wat')]
      before.loadTurtle(data)
      after.loadTurtle(moved.files[0]!.text)
      expect(show(after as never, query)).toEqual(show(before as never, q))
    })
  })

  describe('a convergence', () => {
    const f = `DELETE { ?x a c:Radio } INSERT { ?x a c:Choice ; c:variant "radio" } WHERE { ?x a c:Radio }`
    const b = `DELETE { ?x a c:Choice ; c:variant "radio" } INSERT { ?x a c:Radio } WHERE { ?x a c:Choice ; c:variant "radio" }`
    const conv = loadChanges([`${CHANGE}change:c a chg:Change ; ${body} ; chg:retires c:Radio ; chg:migrations ( change:c1 ) .
change:c1 a mig:Migration ; mig:of c:Radio ; mig:from 1 ; mig:to 2 ; mig:forward """${f}""" ; mig:backward """${b}""" ; mig:discriminator c:variant .`])
    it('keeps a read of the old class to what it was', async () => {
      const { query } = await run(`CONSTRUCT { ?x ex:y 1 } WHERE { ?x a c:Radio }`, conv)
      expect(query).toContain('c:Choice')
      expect(query).toContain('c:variant "radio"')
    })
    it("moves a rule's class with its query, and back", async () => {
      const app = file(`ex:R sem:targets c:Radio .
ex:r sem:implements ex:R ; sem:construct """CONSTRUCT { ?root sem:renders $this } WHERE { $this c:label ?l }""" .`)
      const there = await migrate({ files: [app], changes: conv, from: '0' })
      expect(there.files[0]!.text).toContain('sem:targets c:Choice')
      expect(there.files[0]!.text).toContain('$this c:variant "radio"')
      expect(there.findings.filter((x) => x.kind === 'manual')).toEqual([])
      const back = await migrate({ files: there.files, changes: conv, direction: 'backward', applied: there.changes })
      expect(back.files[0]!.text).toContain('sem:targets c:Radio')
      expect(back.files[0]!.text).not.toContain('c:variant')
    })
  })

  it('leaves every query on the site byte for byte when nothing matches', async () => {
    const files = readdirSync(root + 'demo/gallery').filter((x) => x.endsWith('.ttl')).map((x) => ({ path: x, text: readFileSync(root + 'demo/gallery/' + x, 'utf8') }))
    const none = shaping(`DELETE { ?a c:gone ?b } INSERT { ?a c:nowhere ?b } WHERE { ?a c:gone ?b }`, `DELETE { ?a c:nowhere ?b } INSERT { ?a c:gone ?b } WHERE { ?a c:nowhere ?b }`)
    const r = await migrate({ files, changes: none, from: '0' })
    expect(r.files.map((x) => x.text)).toEqual(files.map((x) => x.text))
  }, 60_000)
})
