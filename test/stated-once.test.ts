// A value stated twice (#343): a merge can leave a text with two values in one language, and an
// instance with two values of a property that has one. Both are legal RDF, and nothing renders
// wrong in a way a test of the page would see until the rules disagree. So: the Turtle in this
// repository states each once; the shape layer reports it in an app (sh:uniqueLang); and when it
// happens anyway, SPARQL and function rules take the same value, whatever order it is stated in.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import { Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS, SEM, VAL } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { setup, SCREEN_LAYERS } from './helpers.ts'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf'
const SH = 'http://www.w3.org/ns/shacl#'
const X = 'https://example.org/once#'

const root = new URL('..', import.meta.url).pathname
const turtle = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? turtle(p) : p.endsWith('.ttl') ? [p] : []
  })

describe('the repository states a value once', () => {
  const quads = ['ontology', 'demo', 'examples'].flatMap((d) => turtle(join(root, d))).flatMap((f) => new Parser().parse(readFileSync(f, 'utf8')))
  const objects = new Map<string, typeof quads>()
  for (const q of quads) objects.set(`${q.subject.value} ${q.predicate.value}`, [...(objects.get(`${q.subject.value} ${q.predicate.value}`) ?? []), q])
  const of = (s: string, p: string) => objects.get(`${s} ${p}`)?.map((q) => q.object) ?? []

  it('has at most one value per language of every text property', () => {
    const texts = new Set(quads.filter((q) => q.predicate.value === NS.l10n + 'pickedAs').map((q) => q.subject.value))
    expect(texts.size).toBeGreaterThan(20)
    const seen = new Map<string, Set<string>>()
    for (const q of quads) {
      if (!texts.has(q.predicate.value) || q.object.termType !== 'Literal') continue
      const key = `${q.subject.value} ${q.predicate.value} @${q.object.language.toLowerCase()}`
      seen.set(key, (seen.get(key) ?? new Set()).add(q.object.value))
    }
    expect([...seen].filter(([, values]) => values.size > 1).map(([key]) => key)).toEqual([])
  })

  it('has no instance over a shape’s sh:maxCount 1', () => {
    const subclasses = new Map<string, string[]>()
    for (const q of quads) if (q.predicate.value === RDFS_SUBCLASS) subclasses.set(q.object.value, [...(subclasses.get(q.object.value) ?? []), q.subject.value])
    const below = (cls: string, seen = new Set<string>()): Set<string> => {
      if (!seen.has(cls)) {
        seen.add(cls)
        for (const sub of subclasses.get(cls) ?? []) below(sub, seen)
      }
      return seen
    }
    const typed = new Map<string, string[]>()
    for (const q of quads) if (q.predicate.value === RDF_TYPE) typed.set(q.object.value, [...(typed.get(q.object.value) ?? []), q.subject.value])
    const over: string[] = []
    for (const target of quads.filter((q) => q.predicate.value === SH + 'targetClass')) {
      const instances = [...below(target.object.value)].flatMap((c) => typed.get(c) ?? [])
      for (const ps of of(target.subject.value, SH + 'property')) {
        if (of(ps.value, SH + 'maxCount')[0]?.value !== '1') continue
        const path = of(ps.value, SH + 'path')[0]
        if (path?.termType !== 'NamedNode') continue
        for (const instance of instances) if (new Set(of(instance, path.value).map((o) => `${o.termType} ${o.value}`)).size > 1) over.push(`${instance} ${path.value}`)
      }
    }
    expect([...new Set(over)]).toEqual([])
  })
})

describe('a text stated twice in one language', () => {
  // The same statements in both orders: the store's order must not decide.
  const orders = [
    `x:twice a c:Text ; c:label "Older" , "Newer" , "Älter"@de , "Neuer"@de , "Старий"@uk , "Новий"@uk .
     x:regional a c:Text ; c:label "Colour"@en-GB , "Color"@en-US , "Farbe"@de-AT , "Farbe!"@de-DE .
     x:exact a c:Text ; c:label "Zzz"@de , "Aaa"@de-AT .
     x:only a c:Text ; c:label "Tak"@pl , "Da"@ro .
     x:term rdfs:label "Older" , "Newer" , "Älter"@de , "Neuer"@de .
     x:with-term a c:Badge ; c:label "Older" , "Newer" .`,
    `x:only a c:Text ; c:label "Da"@ro , "Tak"@pl .
     x:exact a c:Text ; c:label "Aaa"@de-AT , "Zzz"@de .
     x:regional a c:Text ; c:label "Color"@en-US , "Colour"@en-GB , "Farbe!"@de-DE , "Farbe"@de-AT .
     x:twice a c:Text ; c:label "Новий"@uk , "Старий"@uk , "Neuer"@de , "Älter"@de , "Newer" , "Older" .
     x:term rdfs:label "Neuer"@de , "Älter"@de , "Newer" , "Older" .
     x:with-term a c:Badge ; c:label "Newer" , "Older" .`,
  ]
  const graph = (body: string) => `@prefix c: <${NS.c}> . @prefix x: <${X}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n${body}`
  const parts = ['twice', 'regional', 'exact', 'only', 'with-term']
  const stores = ['oxigraph', 'wat'] as const

  for (const kind of stores)
    for (const languages of [[], ['de'], ['uk'], ['uk', 'de'], ['en'], ['fr']]) {
      it(`takes the least value, on both rule kinds and in either order (${kind}, ${languages.join(', ') || 'no preference'})`, () => {
        const rendered = orders.flatMap((body) =>
          (['sparql', 'function'] as const).map((prefer) => {
            const { screen } = setup(kind, { modality: MOD.Screen, layers: SCREEN_LAYERS, prefer, languages }, 1, [graph(body)])
            return parts.map((p) => toHTML(screen.index, X + p))
          }),
        )
        for (const other of rendered.slice(1)) expect(other).toEqual(rendered[0])
        const least = languages[0] === 'de' ? 'Neuer' : languages[0] === 'uk' ? 'Новий' : 'Newer'
        expect(rendered[0]![0]).toContain(`>${least}<`)
        expect(rendered[0]![2]).toContain(languages.includes('de') ? '>Zzz<' : '>Aaa<')
        expect(rendered[0]![3]).toContain('>Da<')
      })
    }

  it('derives one twin for a term (l10n:Terms) and one l10n:label for a component', () => {
    for (const body of orders) {
      const { store } = setup('oxigraph', { modality: MOD.Screen, layers: SCREEN_LAYERS, prefer: 'sparql', languages: ['de'] }, 1, [graph(body)])
      const f = store.factory
      const twins = store.match(null, f.namedNode(NS.l10n + 'of'), f.namedNode(X + 'term')).flatMap((q) => store.match(q.subject, f.namedNode(NS.l10n + 'name'), null))
      expect(twins.map((q) => q.object.value)).toEqual(['Neuer'])
      expect(store.match(f.namedNode(X + 'twice'), f.namedNode(NS.l10n + 'label'), null).map((q) => q.object.value)).toEqual(['Neuer'])
    }
  })
})

describe('sh:uniqueLang in the shape layer', () => {
  const graph = `
    @prefix c: <${NS.c}> . @prefix x: <${X}> .
    x:root a c:Stack ; c:children ( x:twice x:once x:plain ) .
    x:twice a c:Text ; c:label "One"@en , "Two"@en , "Ein"@de , "Zwei"@de-AT , "Drei"@DE , "Один"@uk .
    x:once a c:Text ; c:label "One"@en , "Ein"@de , "Один"@uk .
    x:plain a c:Text ; c:label "One" , "Two" .
  `
  const validate = (kind: 'oxigraph' | 'wat', prefer: 'sparql' | 'function') => {
    const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    const store = loadStore(kind, graph)
    const screen = new Runtime(store).project({ modality: MOD.Screen, layers: [VAL.ShapesLayer, SEM.TooltipLayer], prefer, name: 'screen', roots: [X + 'root'] }, (e) => {
      throw e
    })
    new DomRenderer(screen.index, document.getElementById('app')!, X + 'root').flush()
    const f = store.factory
    return (id: string) =>
      store
        .match(null, f.namedNode(SH + 'focusNode'), f.namedNode(X + id))
        .map((q) => `${q.subject.value} ${store.match(q.subject, f.namedNode(SH + 'resultMessage'), null)[0]?.object.value}`)
        .sort()
  }

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`reports each language with two values, as both rule kinds do (${kind})`, () => {
      const [sparql, fn] = [validate(kind, 'sparql'), validate(kind, 'function')]
      expect(sparql('twice').map((r) => r.replace(/^\S+ /, '')).sort()).toEqual(['label: more than one value in "de"', 'label: more than one value in "en"'])
      expect(sparql('twice')).toEqual(fn('twice'))
      // One value per language, and untagged values, which are in no language (SHACL's sh:uniqueLang).
      for (const clean of ['once', 'plain']) {
        expect(sparql(clean)).toEqual([])
        expect(fn(clean)).toEqual([])
      }
    })
  }
})
