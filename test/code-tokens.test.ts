// SPARQL and Turtle coloring in SPARQL (#7): the tokenizer as whole words (src/sparql-tokens.ts), one
// pattern that sx:matches runs as JavaScript runs it, and the renderings that color text by it on both
// sides alike.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { engineStore } from '../rdf-engine/host/store.ts'
import { loadStore } from '../src/node/load.ts'
import { KEYWORDS, TOKEN_PATTERN, matchTokens, tokenizeCode, tokenizeSparql } from '../src/sparql-tokens.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const C = 'https://semblance.dev/ns/component#'
const ROOT = new URL('..', import.meta.url).pathname

/** Every Turtle file of the ontology and the site. */
function turtleFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (f.endsWith('.ttl')) out.push(p)
    }
  }
  walk(join(ROOT, 'ontology'))
  walk(join(ROOT, 'demo'))
  return out
}

const TRICKY = [
  'SELECT ?x WHERE { ?x a ex:T ; ex:p "a\\"b" , """long\nstring""" , 120.0e0 , 1.5 , 1.5x , 12ab , ex:1 } GROUP BY ?x ORDER  BY ?y',
  '@prefix ex: <http://example.org/> . @prefixes @base <x> . _:b0 ex:p false: . http://example.org/x a:b MINUS: ',
  'group by GROUP\tBY GROUP BYE  ?  $ < <a b> " unterminated\n# comment ? x\n😀 ?é "😀" é:x x-AS STR-x',
  '',
]

describe('the SPARQL and Turtle lexicon', () => {
  it('in the graph (c:SparqlLexicon) is the tokenizer’s', () => {
    const store = loadStore('n3')
    const f = store.factory
    const lexicon = f.namedNode(C + 'SparqlLexicon')
    expect(store.match(lexicon, f.namedNode(C + 'tokenPattern'), null).map((q) => q.object.value)).toEqual([TOKEN_PATTERN])
    expect(store.match(lexicon, f.namedNode(C + 'keyword'), null).map((q) => q.object.value).sort()).toEqual([...KEYWORDS].sort())
  })

  it('covers every character, in order, and merges plain runs for the readers of tokens', () => {
    for (const text of [...TRICKY, ...turtleFiles().slice(0, 20).map((p) => readFileSync(p, 'utf8'))]) {
      expect(matchTokens(text).map((t) => t.text).join('')).toBe(text)
      expect(tokenizeSparql(text).map((t) => t.text).join('')).toBe(text)
      expect(tokenizeSparql(text).some((t, i, all) => t.kind === 'text' && all[i - 1]?.kind === 'text')).toBe(false)
    }
  })

  it('colors as before it was whole words', () => {
    const show = (s: string, language = 'sparql') => tokenizeCode(s, language)!.filter((t) => t.kind !== 'text').map((t) => `${t.kind}:${t.text}`)
    expect(show('SELECT ?x WHERE { ?x a ex:T } GROUP BY ?x ORDER  BY ?x LIMIT 10')).toEqual([
      'keyword:SELECT', 'var:?x', 'keyword:WHERE', 'var:?x', 'keyword:a', 'pname:ex:T', 'keyword:GROUP BY', 'var:?x', 'var:?x', 'keyword:LIMIT', 'number:10',
    ])
    // A double colors its digits up to the point; a number run into letters is text.
    expect(show('1.5 120.0e0 12ab x.5')).toEqual(['number:1.5', 'number:120', 'number:5'])
    // A keyword before a colon is that keyword; a scheme's "name:/" and a blank node are text.
    expect(show('false: MINUS: a:b http://x _:b0 ex:')).toEqual(['keyword:false', 'keyword:MINUS', 'keyword:a', 'pname:ex:'])
    expect(show('@prefix ex: <x> . @prefixes "s"@en', 'turtle')).toEqual(['keyword:@prefix', 'pname:ex:', 'iri:<x>', 'string:"s"'])
    expect(show('@prefix ex: <x> .')).toEqual(['pname:ex:', 'iri:<x>'])
    expect(show('"""a\n"b"\nc""" # x "y"\n"q\\"r"')).toEqual(['string:"""a\n"b"\nc"""', 'comment:# x "y"', 'string:"q\\"r"'])
  })

  const built = (['wat', 'rust'] as const).filter((k) => existsSync(join(ROOT, `rdf-engine/build/${k}.wasm`)))
  it.each(built)('splits text in the %s engine as JavaScript does (sx:matches)', (kind) => {
    const s = engineStore(new WebAssembly.Module(readFileSync(join(ROOT, `rdf-engine/build/${kind}.wasm`))), kind, { timeZone: 'UTC' })
    const lit = (x: string) => '"' + x.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'
    for (const text of [...TRICKY, ...turtleFiles().map((p) => readFileSync(p, 'utf8'))]) {
      const rows = s.select(
        `PREFIX sx: <https://semblance.dev/ns/sparql#> SELECT ?m ?at ?g1 ?g2 ?g3 ?g4 ?g5 ?g6 ?g7 ?g8 ?g9 { BIND(${lit(text)} AS ?t) BIND(${lit(TOKEN_PATTERN)} AS ?p) (?t ?p) sx:matches (?m ?at ?g1 ?g2 ?g3 ?g4 ?g5 ?g6 ?g7 ?g8 ?g9) } ORDER BY ?at`,
        [s.factory.defaultGraph()],
      )
      const got = rows.map((r) => `${r.get('at')!.value} ${[1, 2, 3, 4, 5, 6, 7, 8, 9].findIndex((i) => r.get('g' + i))} ${r.get('m')!.value}`)
      const want: string[] = []
      let at = 1
      let last = 0
      for (const m of text.matchAll(new RegExp(TOKEN_PATTERN, 'g'))) {
        for (const _ of text.slice(last, m.index)) at++
        last = m.index!
        want.push(`${at} ${m.slice(1).findIndex((x) => x !== undefined)} ${m[0]}`)
      }
      expect(got).toEqual(want)
    }
  })
})

// On wat (Oxigraph has no sx: relations, so it runs the twins either way).
describe('colored code, SPARQL and function rules alike (wat)', () => {
  const sites = (group: string) =>
    (['sparql', 'function'] as const).map((prefer) => {
      const h = mountShell(5, 'wat', prefer)
      const f = h.store.factory
      const app = f.namedNode(UI + 'app')
      const p = f.namedNode(UI + 'galleryGroup')
      h.showPage('Components')
      h.runtime.apply({ remove: h.store.match(app, p, null), add: [f.quad(app, p, f.namedNode(UI + group))] })
      h.shell.flush()
      return h
    })
  type H = ReturnType<typeof sites>[number]
  const html = (h: H, id: string) => [...h.document.querySelectorAll('*')].find((e) => h.shell.keyOf(e) === `${UI}${id}/~root`)?.outerHTML
  const same = (hs: H[], id: string, what: string) => {
    const [a, b] = hs.map((h) => html(h, id))
    expect(a, what).toBeDefined()
    expect(a, what).toBe(b)
  }
  const set = (hs: H[], id: string, p: string, value?: string) => {
    for (const h of hs) {
      const f = h.store.factory
      const s = f.namedNode(UI + id)
      h.runtime.apply({ remove: h.store.match(s, f.namedNode(p), null), add: value === undefined ? [] : [f.quad(s, f.namedNode(p), f.literal(value))] })
      h.shell.flush()
    }
  }

  it('chooses the SPARQL rule on wat', () => {
    const rules = (sites('GroupType')[0]!.screen.engine as unknown as { rules: { slot: string; kind: string }[] }).rules
    expect(rules.find((r) => r.slot === C + 'CodeColoredRendering')?.kind).toBe('sparql')
  })

  it('colors the same samples, inline and as blocks, as they change', () => {
    const hs = sites('GroupType')
    for (const id of ['ty-code-inline-2', 'ty-code-sparql', 'ty-code-turtle']) same(hs, id, id)
    for (const id of ['ty-code-inline-2', 'ty-code-sparql', 'ty-code-turtle']) {
      for (const text of TRICKY) {
        set(hs, id, C + 'label', text)
        same(hs, id, `${id}: ${JSON.stringify(text.slice(0, 30))}`)
      }
      set(hs, id, C + 'language', 'Turtle')
      same(hs, id, `${id} as Turtle`)
      set(hs, id, C + 'language', 'text')
      same(hs, id, `${id} as plain text`)
      set(hs, id, C + 'language', 'sparql')
      set(hs, id, C + 'label', '\n\n  SELECT * { ?s ?p ?o }  \n\t\n')
      same(hs, id, `${id} trimmed`)
    }
  })
})
