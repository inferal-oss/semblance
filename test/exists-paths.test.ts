import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { zeroStepsInExists } from './exists-paths.ts'

const root = new URL('..', import.meta.url).pathname
const files = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((f) => (statSync(join(root, dir, f)).isDirectory() ? files(join(dir, f)) : /\.(ttl|py)$/.test(f) ? [join(dir, f)] : []))

describe('zero-length path steps inside EXISTS (#446, #451)', () => {
  it('none in the ontology, the site, the examples or the generators: Oxigraph scans the store for each', () => {
    const found = ['ontology', 'demo', 'examples', 'scripts'].flatMap(files).flatMap((f) =>
      zeroStepsInExists(readFileSync(join(root, f), 'utf8')).map((z) => `${f}:${z.line} ${z.triple}`))
    expect(found).toEqual([])
  })

  it('finds a later step of a sequence, and a whole path between two variables of the EXISTS', () => {
    const triples = (q: string) => zeroStepsInExists(q).map((z) => z.triple)
    expect(triples('FILTER EXISTS { $this a/rdfs:subClassOf* ?k . ?k c:polar true }')).toEqual(['$this a/rdfs:subClassOf* ?k'])
    expect(triples('BIND(EXISTS { $this c:legend/rdf:rest*/rdf:first ?s } AS ?x)')).toEqual(['$this c:legend/rdf:rest*/rdf:first ?s'])
    expect(triples('FILTER NOT EXISTS { $this a/rdfs:subClassOf? ?k }')).toEqual(['$this a/rdfs:subClassOf? ?k'])
    expect(triples('FILTER EXISTS { $this c:legend ?l . ?l rdf:rest* ?s . ?s c:axis ?a }')).toEqual(['?l rdf:rest* ?s'])
    expect(triples('FILTER EXISTS { $this a ?c ; c:x ?y . ?c rdfs:subClassOf* ?k ; c:y ?y }')).toEqual(['?c rdfs:subClassOf* ?k'])
  })

  it('leaves the fast ones: the same path written (p|p/q+), a constant end, a start or end bound outside', () => {
    expect(zeroStepsInExists('FILTER EXISTS { $this (a|a/rdfs:subClassOf+) ?k . ?k c:polar true }')).toEqual([])
    expect(zeroStepsInExists('FILTER EXISTS { $this a/rdfs:subClassOf* c:SeriesChart }')).toEqual([])
    expect(zeroStepsInExists('SELECT * WHERE { ?d c:x ?y FILTER NOT EXISTS { ?d nav:parent* ?x . ?x nav:parent ?z } }')).toEqual([])
    expect(zeroStepsInExists('FILTER EXISTS { ?k rdfs:subClassOf* blk:Block ; c:x ?y }')).toEqual([])
    expect(zeroStepsInExists('?x a c:Table . OPTIONAL { ?x a/rdfs:subClassOf* ?k }')).toEqual([])
    // A triple belongs to its innermost EXISTS, where an outer EXISTS's variable is bound.
    expect(zeroStepsInExists('FILTER EXISTS { ?a c:x ?d FILTER NOT EXISTS { ?d nav:parent* ?x . ?x nav:parent ?z } }')).toEqual([])
  })
})
