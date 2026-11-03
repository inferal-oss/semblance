// SPARQL and Turtle coloring in SPARQL (#7): the tokenizer as whole words (src/sparql-tokens.ts), one
// pattern that sx:matches runs as JavaScript runs it, and the renderings that color text by it on both
// sides alike.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { engineStore } from '../rdf-engine/host/store.ts'
import { loadStore } from '../src/node/load.ts'
import { KEYWORDS, QUOTED_PATTERN, TOKEN_PATTERN, matchTokens, tokenizeCode, tokenizeSparql } from '../src/sparql-tokens.ts'
import { MOD, NS } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
import { mountShell, mountShellPrepared, mountSite } from './harness.ts'

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
    expect(store.match(lexicon, f.namedNode(C + 'quotedPattern'), null).map((q) => q.object.value)).toEqual([QUOTED_PATTERN])
    // Its long strings (group 2) are the token pattern's.
    for (const text of TRICKY) {
      const long = [...text.matchAll(new RegExp(QUOTED_PATTERN, 'g'))].filter((m) => m[2]).map((m) => `${m.index} ${m[0]}`)
      expect(long).toEqual([...text.matchAll(new RegExp(TOKEN_PATTERN, 'g'))].filter((m) => m[2]?.startsWith('"""')).map((m) => `${m.index} ${m[0]}`))
    }
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

// Every example's source, and texts that stress the lines: long strings over lines (with blank lines,
// two on one line, one closed and another opened on the same line), unclosed ones, empty texts.
describe('source views, SPARQL and function rules alike (wat)', () => {
  const STRESS = [
    'ex:a ex:q """SELECT ?x\n\nWHERE { ?x a "y" }\n""" ; ex:r """a""" , """b\nc""" . ex:b ex:q """one\n""" , """two\nthree""" .\n# end',
    '"""never closed\nex:a a ex:B .\n"x" """\n',
    'ex:a ex:p "😀 é" , <http://e/x y> , 1.5 , 120.0e0 .\r\n@prefix ex: <x> .\n\n\n   \n',
    '',
    '\n\n',
  ]
  const sites = () =>
    (['sparql', 'function'] as const).map((prefer) => {
      const h = mountSite('wat', prefer)
      const visible = (el: Element) => !el.closest('[hidden]')
      h.fire([...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Examples' && visible(b))!, 'click')
      return { ...h, visible, prefer }
    })
  type H = ReturnType<typeof sites>[number]
  const views = (h: H) => [...h.document.querySelectorAll('[data-sem-c=source-view]')].filter(h.visible)
  const textOf = (h: H, iri: string) => toText(h.runtime.project({ modality: MOD.Text, prefer: h.prefer, name: 'text-source-' + Math.random(), roots: [iri] }).index, iri)

  it('shows every example’s source the same, on screen and as text', () => {
    const hs = sites()
    const names = [...hs[0]!.document.querySelectorAll('[data-sem-c=nav-list] button')].filter(hs[0]!.visible).map((b) => b.textContent!.trim())
    expect(names.length).toBeGreaterThan(5)
    let seen = 0
    for (const name of names) {
      for (const h of hs) h.fire([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === name && h.visible(b))!, 'click')
      const [a, b] = hs.map((h) => views(h).map((v) => v.outerHTML))
      expect(a, name).toEqual(b)
      seen += a!.length
    }
    expect(seen).toBeGreaterThan(5)
  })

  it('shows any text the same, and the lines as the text has them', () => {
    const hs = sites()
    const view = UI + 'exs-signin'
    const source = 'urn:semblance:source:demo/gallery/_ex-signin.ttl'
    for (const h of hs) h.fire([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === 'Sign in with a code' && h.visible(b))!, 'click')
    for (const text of STRESS) {
      for (const h of hs) {
        const f = h.store.factory
        const s = f.namedNode(source)
        h.runtime.apply({ remove: h.store.match(s, f.namedNode(C + 'text'), null), add: [f.quad(s, f.namedNode(C + 'text'), f.literal(text))] })
        h.shell.flush()
      }
      const [a, b] = hs.map((h) => views(h)[0]!.outerHTML)
      expect(a!.split('<span class="sem-line"'), JSON.stringify(text)).toEqual(b!.split('<span class="sem-line"'))
      expect(a, JSON.stringify(text)).toBe(b)
      const [ta, tb] = hs.map((h) => textOf(h, view))
      expect(ta, JSON.stringify(text)).toBe(tb)
      const rows = [...views(hs[0]!)[0]!.querySelectorAll('.sem-line')]
      expect(rows.map((r) => r.textContent!.replace(/\n$/, ''))).toEqual(text.replace(/[ \t\n\r]+$/, '').split('\n'))
    }
    for (const h of hs) {
      const f = h.store.factory
      h.runtime.apply({ remove: h.store.match(f.namedNode(view), f.namedNode(C + 'of'), null), add: [] })
      h.shell.flush()
    }
    const [a, b] = hs.map((h) => [...h.document.querySelectorAll('*')].find((e) => h.shell.keyOf(e) === `${view}/~root`)?.outerHTML)
    expect(a).toContain('sem-empty')
    expect(a).toBe(b)
  })
})

// The workbench names each sample's form past its prologue (comments, PREFIX, BASE) by the lexicon.
describe('the workbench, SPARQL and function rules alike (wat)', () => {
  const FORMS = [
    '# a comment\nPREFIX ex: <http://e/>\nBASE <http://b/>\nconstruct { ?s ?p ?o } WHERE { ?s ?p ?o }',
    'prefix a: <x> describe <x>',
    '  ASK { ?s a ex:T }',
    '"lit" SELECT',
    'ex:pname SELECT * {}',
    '?x SELECT',
    '# only a comment',
    '',
    'PREFIX false: <x> SELECT * {}',
    '<http://x#SELECT> ASK {}',
  ]
  const sites = () =>
    (['sparql', 'function'] as const).map((prefer) => {
      const h = mountShell(5, 'wat', prefer)
      h.fire([...h.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Query')!, 'click')
      return { ...h, prefer }
    })
  type H = ReturnType<typeof sites>[number]
  const bench = UI + 'workbench'
  const html = (h: H) => {
    const el = [...h.document.querySelectorAll('*')].find((e) => h.shell.keyOf(e) === `${bench}/~root`)!
    // Not the panes it holds (the editor, the results: their own renderings).
    const copy = el.cloneNode(true) as Element
    for (const inner of copy.querySelectorAll('[data-sem-c=query-editor], [data-sem-c=tabs]')) inner.replaceChildren()
    return copy.outerHTML
  }
  const text = (h: H) => toText(h.runtime.project({ modality: MOD.Text, prefer: h.prefer, name: 'text-bench-' + Math.random(), roots: [bench] }).index, bench)
  const same = (hs: H[], what: string) => {
    const [a, b] = hs.map(html)
    expect(a, what).toBe(b)
    const [ta, tb] = hs.map(text)
    expect(ta, what).toBe(tb)
  }

  it('chooses the SPARQL rule on wat', () => {
    const rules = (sites()[0]!.screen.engine as unknown as { rules: { slot: string; kind: string }[] }).rules
    expect(rules.find((r) => r.slot === C + 'QueryWorkbenchRendering')?.kind).toBe('sparql')
  })

  it('is not rendered again by typing in the editor', () => {
    const h = sites()[0]!
    const runs = () => h.screen.engine.stats.byRule.get(C + 'QueryWorkbenchRendering-sparql-screen')?.runs ?? 0
    const before = runs()
    expect(before).toBeGreaterThan(0)
    const ta = h.document.querySelector('[data-sem-c=query-editor] textarea') as HTMLTextAreaElement
    for (const q of ['S', 'SE', 'SELECT * { ?s ?p ?o }']) {
      ta.value = q
      h.fire(ta, 'input')
    }
    expect(runs()).toBe(before)
  })

  it('renders the same as samples load, queries run and updates are followed', () => {
    const hs = sites()
    same(hs, 'at start')
    const labels = [...hs[0]!.document.querySelectorAll('.sem-sample .sem-sample-label')].map((l) => l.textContent!)
    expect(labels.length).toBeGreaterThan(10)
    for (const label of labels.slice(0, 4)) {
      for (const h of hs) h.fire([...h.document.querySelectorAll('.sem-sample')].find((b) => b.querySelector('.sem-sample-label')!.textContent === label)!, 'click')
      same(hs, 'sample ' + label)
    }
    for (const h of hs) {
      const ta = h.document.querySelector('[data-sem-c=query-editor] textarea') as HTMLTextAreaElement
      ta.value = 'SELECT ?s WHERE { ?s a c:Tab }'
      h.fire(ta, 'input')
      h.fire(h.document.querySelector('[data-sem-c=query-workbench] .sem-toolbar button')!, 'click')
    }
    same(hs, 'a query of its own')
    for (const h of hs) h.fire(h.document.querySelector('[data-sem-c=query-workbench] [role=switch]')!, 'click')
    same(hs, 'following updates')
    const f = hs[0]!.store.factory
    for (const [i, query] of FORMS.entries()) {
      for (const h of hs) {
        const s = f.namedNode(UI + 'sampleReactions')
        h.runtime.apply({ remove: h.store.match(s, f.namedNode(NS.sem + 'select'), null), add: [f.quad(s, f.namedNode(NS.sem + 'select'), f.literal(query))] })
        h.shell.flush()
      }
      same(hs, `form ${i}: ${JSON.stringify(query)}`)
    }
    for (const h of hs) h.fire([...h.document.querySelectorAll('.sem-sample')].find((b) => b.querySelector('.sem-sample-label')!.textContent === labels[1])!, 'click')
    same(hs, 'a rewritten sample run')
  })
})

// The back of a card: the queries and rules that made its front, each rule's text colored.
// Every other rendering is SPARQL on both sides (the back lists the rules that made the front): only the
// back's own implementation differs, the function one where its SPARQL rule asks for a group no store has.
describe('card backs, SPARQL and function rules alike (wat)', () => {
  const sites = () =>
    [false, true].map((twin) =>
      mountShellPrepared((store) => {
        const f = store.factory
        if (twin) store.add(f.quad(f.namedNode(C + 'SourceBackRendering-sparql'), f.namedNode(NS.sem + 'needsExtension'), f.namedNode(NS.sx + 'Absent')))
      }, 'sparql', 'wat'),
    )
  type H = ReturnType<typeof sites>[number]
  const backs = (h: H) => [...h.document.querySelectorAll('[data-sem-c=source-back]')].map((b) => b.outerHTML)

  it('chooses the SPARQL rule on wat', () => {
    const kinds = sites().map((h) => (h.screen.engine as unknown as { rules: { slot: string; kind: string }[] }).rules.find((r) => r.slot === C + 'SourceBackRendering')?.kind)
    expect(kinds).toEqual(['sparql', 'function'])
  })

  it('shows the same back of every card turned over', () => {
    const hs = sites()
    let seen = 0
    const turnAll = (what: string) => {
      const count = hs[0]!.document.querySelectorAll('[data-sem-c=flippable] .sem-face-bar .sem-flip').length
      for (let i = 0; i < count; i++) {
        for (const h of hs) {
          const flip = [...h.document.querySelectorAll('[data-sem-c=flippable] > .sem-faces > .sem-front > .sem-face-bar .sem-flip')][i]
          if (flip) h.fire(flip, 'click')
        }
      }
      const [a, b] = hs.map(backs)
      expect(a!.length, what).toBe(b!.length)
      for (let i = 0; i < a!.length; i++) expect(a![i]!.split('<section'), `${what}: back ${i}`).toEqual(b![i]!.split('<section'))
      seen += a!.length
    }
    turnAll('the playground')
    for (const h of hs) h.fire([...h.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Query')!, 'click')
    turnAll('the tools')
    for (const group of ['GroupType', 'GroupData']) {
      for (const h of hs) {
        const f = h.store.factory
        const app = f.namedNode(UI + 'app')
        const p = f.namedNode(UI + 'galleryGroup')
        h.showPage('Components')
        h.runtime.apply({ remove: h.store.match(app, p, null), add: [f.quad(app, p, f.namedNode(UI + group))] })
        h.shell.flush()
      }
      turnAll(group)
    }
    expect(seen).toBeGreaterThan(5)
    // Something on every back, and rules colored.
    expect(backs(hs[0]!).join('')).toContain('tok-keyword')
  })
})
