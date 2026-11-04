// What a changed triple reaches through a rule's or a view's body (src/view/deps.ts): the focus it
// joins to, or every focus when it cannot say. Narrower answers must not lose a solution, so each
// shape also has its case that stays global. And the audit of every rule of the app: how many treat a
// change on a node they do not reach as global (test/engine.test.ts has the cost of one that does not).
import type { Quad, Term } from '@rdfjs/types'
import { DataFactory as f } from 'n3'
import { describe, expect, it } from 'vitest'
import type { Factory } from '../src/store/types.ts'
import { Dependencies, type Lookup } from '../src/view/deps.ts'
import { parseQuery } from '../src/view/sparql.ts'
import { setup } from './helpers.ts'

const EX = 'urn:x:'
const n = (local: string) => f.namedNode(local.includes(':') ? local : EX + local)
const t = (s: string, p: string, o: string | Term) => f.quad(n(s), n(p), typeof o === 'string' ? n(o) : (o as never))
const prefixes = new Map([['ex', EX]])
const lookupOf =
  (quads: Quad[]): Lookup =>
  (s, p, o) =>
    quads.filter((q) => (!s || q.subject.equals(s)) && (!p || q.predicate.equals(p)) && (!o || q.object.equals(o)))

/** The foci a change reaches, sorted; or 'global'. Quads are the state with the change in it. */
function reach(where: string, change: Quad, state: Quad[] = [], rule = true): string[] | 'global' {
  const q = parseQuery(`PREFIX ex: <${EX}> SELECT * WHERE { ${where} }`, prefixes)
  const deps = new Dependencies(f as unknown as Factory, q.select.where, ['this'], [], rule ? { prefixes } : undefined, prefixes)
  expect(deps.problem).toBeUndefined()
  const lookup = lookupOf([...state, change])
  const out = new Set<string>()
  for (const p of deps.route(change)) {
    const keys = deps.probe(p, change, lookup)
    if (keys === 'global') return 'global'
    for (const k of keys) {
      if (!k[0]) return 'global'
      out.add(k[0].value.replace(EX, ''))
    }
  }
  return [...out].sort()
}

describe('exact dependencies: from a change to the focus', () => {
  describe('a BIND in a view', () => {
    const where = 'OPTIONAL { ?this ex:via ?hop } BIND(COALESCE(IF(ex:v = ex:none, ?this, ?hop), ex:none) AS ?s) OPTIONAL { ?s ex:l ?v }'
    const state = [t('F', 'via', 'h')]

    // (The changed node itself may be a key too: the runtime's anchors say whether it has rows.)
    it('reads the constants of its expressions: every value of it is known', () => {
      expect(reach(where, t('h', 'l', 'x'), state, false)).toEqual(['F', 'h'])
      expect(reach(where, t('F', 'l', 'x'), state, false)).toEqual(['F'])
      expect(reach(where, t('zzz', 'l', 'x'), state, false)).toEqual(['zzz'])
    })

    it('is global for its constant, and when it can be left unbound', () => {
      expect(reach(where, t('none', 'l', 'x'), state, false)).toEqual('global')
      const unbound = 'OPTIONAL { ?this ex:via ?hop } BIND(IF(ex:v = ex:none, ?this, ?hop) AS ?s) OPTIONAL { ?s ex:l ?v }'
      expect(reach(unbound, t('h', 'l', 'x'), state, false)).toEqual('global')
    })
  })

  describe('a subquery', () => {
    const body = '{ SELECT ?x WHERE { ?this ex:p ?x . ?x ex:q ?y } }'
    const state = [t('F', 'p', 'a'), t('G', 'p', 'b')]

    it('holds a rule’s focus, which the text substitutes whether it projects it or not', () => {
      expect(reach(body, t('a', 'q', 'v'), state)).toEqual(['F'])
      expect(reach(body, t('zzz', 'q', 'v'), state)).toEqual([])
    })

    it('keeps a view’s key private when it does not project it', () => {
      expect(reach(`${body} ?this ex:r ?z`, t('a', 'q', 'v'), [...state, t('F', 'r', 'z')], false)).toEqual('global')
    })

    it('is walked through from outside it', () => {
      const change = t('a', 'r', 'v')
      expect(reach('{ SELECT ?x WHERE { ?this ex:p ?x } } ?x ex:r ?v', change, state)).toEqual(['F'])
    })
  })

  describe('LIMIT', () => {
    const state = [t('F', 'p', 'a'), t('G', 'p', 'b')]

    it('moves one focus’s window when the change joins the focus inside it', () => {
      expect(reach('{ SELECT ?x WHERE { ?this ex:p ?x . ?x ex:q ?y } ORDER BY ?y LIMIT 1 }', t('a', 'q', 'v'), state)).toEqual(['F'])
    })

    it('moves every focus’s window when the subquery does not hold the focus', () => {
      expect(reach('?this ex:p ?x { SELECT ?x WHERE { ?x ex:q ?y } ORDER BY ?y LIMIT 1 }', t('a', 'q', 'v'), state)).toEqual('global')
    })

    it('moves every focus’s window when the change joins the focus only outside it', () => {
      // A new row for ?x is a cross product with the focus's ?a, and can push out another's.
      const where = '?this ex:r ?x { SELECT ?x WHERE { ?this ex:p ?a . ?x ex:q ?y } ORDER BY ?y LIMIT 1 }'
      expect(reach(where, t('a', 'q', 'v'), [...state, t('F', 'r', 'a')])).toEqual('global')
    })
  })

  describe('a required UNION', () => {
    const union = '{ ?this ex:p ?s } UNION { ?this ex:q ?s }'
    const state = [t('F', 'p', 'a'), t('G', 'q', 'a'), t('H', 'q', 'b')]

    it('is followed through every branch: a solution is in one of them', () => {
      expect(reach(`${union} ?s ex:l ?v`, t('a', 'l', 'v'), state)).toEqual(['F', 'G'])
      expect(reach(`${union} ?s ex:l ?v`, t('zzz', 'l', 'v'), state)).toEqual([])
    })

    it('leads nowhere when a branch does not reach the focus', () => {
      expect(reach(`{ ?this ex:p ?s } UNION { ?other ex:q ?s } ?s ex:l ?v`, t('a', 'l', 'v'), state)).toEqual('global')
    })

    it('leads nowhere when a branch may leave the variable unbound', () => {
      expect(reach(`{ ?this ex:p ?s } UNION { ?this ex:q ?y } ?s ex:l ?v`, t('a', 'l', 'v'), state)).toEqual('global')
    })

    it('is not a way out of the branch the change is in: another branch is another solution', () => {
      const where = '{ ?this ex:p ?s . ?s ex:l ?v } UNION { ?this ex:q ?s }'
      expect(reach(where, t('a', 'l', 'v'), state)).toEqual(['F'])
    })
  })

  describe('LATERAL', () => {
    const state = [t('F', 'p', 'a')]

    it('binds what its left side bound, so a walk leaves its subquery through that', () => {
      const where = '?this ex:p ?s LATERAL { OPTIONAL { SELECT ?s ?c WHERE { OPTIONAL { ?s ex:l ?c } } } }'
      expect(reach(where, t('a', 'l', 'v'), state)).toEqual(['F'])
    })

    it('does not change a nested group without it: a new match can stop outer rows being compatible', () => {
      const where = '?this ex:p ?s OPTIONAL { ?this ex:k ?w OPTIONAL { ?s ex:l ?c } }'
      expect(reach(where, t('a', 'l', 'v'), [...state, t('F', 'k', 'w')])).toEqual('global')
    })
  })

  describe('a BIND', () => {
    const state = [t('F', 'p', 'a'), t('F', 'k', 'w')]

    it('of a minted IRI leads back to the node it starts with', () => {
      const where = 'BIND(IRI(CONCAT(STR(?this), "/~l10n-caption")) AS ?n) OPTIONAL { ?n ex:l ?v }'
      expect(reach(where, f.quad(n('F/~l10n-caption'), n('l'), f.literal('x')))).toEqual(['F'])
      expect(reach(where, t('elsewhere', 'l', 'v'))).toEqual([])
    })

    it('of a minted IRI finds the head wherever the separator is', () => {
      const where = '?this ex:p ?h . ?h ex:s ?kind . BIND(IRI(CONCAT(STR(?h), "/~", STR(?kind))) AS ?n) OPTIONAL { ?n ex:l ?v }'
      const s = [t('F', 'p', 'a/~b'), t('a/~b', 's', 'k')]
      expect(reach(where, t('a/~b/~k', 'l', 'v'), s)).toEqual(['F'])
    })

    it('of a minted IRI does not take what stands before a separator for a node unless it can be one', () => {
      const where = '?this ex:p ?h . ?h ex:s ?kind . BIND(IRI(CONCAT(STR(?h), "-", STR(?kind))) AS ?n) OPTIONAL { ?n ex:l ?v }'
      const head = f.namedNode('a b-c')
      expect(reach(where, f.quad(head, n('l'), f.literal('x')))).toEqual([])
    })

    it('of a STR() does not take a string for a node unless it can be one', () => {
      const where = '?this ex:p ?h . ?h ex:s ?kind . BIND(STR(?h) AS ?text) OPTIONAL { ?other ex:l ?text }'
      expect(reach(where, f.quad(n('o'), n('l'), f.literal('a b')))).toEqual([])
      expect(reach(where, f.quad(n('o'), n('l'), f.literal(EX + 'a')), [t('F', 'p', 'a'), t('a', 's', 'k')])).toEqual(['F'])
    })

    it('of a minted IRI whose head may be a literal cannot walk from it', () => {
      const where = '?this ex:p ?h . BIND(IRI(CONCAT(STR(?h), "/~x")) AS ?n) OPTIONAL { ?n ex:l ?v }'
      expect(reach(where, t('a/~x', 'l', 'v'), state)).toEqual('global')
      expect(reach(where, t('elsewhere', 'l', 'v'), state)).toEqual([])
    })

    it('of a constant fallback: every focus without a source reads the constant', () => {
      const where = 'OPTIONAL { ?this ex:p ?s } BIND(COALESCE(?s, ex:none) AS ?n) OPTIONAL { ?n ex:l ?v }'
      expect(reach(where, t('a', 'l', 'v'), state)).toEqual(['F'])
      expect(reach(where, t('zzz', 'l', 'v'), state)).toEqual([])
      expect(reach(where, t('none', 'l', 'v'), state)).toEqual('global')
    })

    it('reads an OPTIONAL as a source only if it comes before the BIND', () => {
      const where = 'BIND(COALESCE(?s, ex:none) AS ?n) OPTIONAL { ?this ex:p ?s } OPTIONAL { ?n ex:l ?v }'
      expect(reach(where, t('a', 'l', 'v'), state)).toEqual('global')
    })

    it('of two sources follows both: the focus it names, and the one that names it', () => {
      const where = 'OPTIONAL { ?this ex:p ?s } BIND(COALESCE(?s, ?this) AS ?n) OPTIONAL { ?n ex:l ?v }'
      expect(reach(where, t('a', 'l', 'v'), state)).toEqual(['F', 'a'])
    })

    it('that can fail leaves its variable unbound, to match any node: no narrowing', () => {
      const where = '?this ex:k ?w . BIND(IF(?w = ex:w, ?nothing, ex:other) AS ?n) OPTIONAL { ?n ex:l ?v }'
      expect(reach(where, t('zzz', 'l', 'v'), state)).toEqual('global')
      const ordered = '?this ex:k ?w . BIND(IF(?w < 3, ex:a, ex:b) AS ?n) OPTIONAL { ?n ex:l ?v }'
      expect(reach(ordered, t('zzz', 'l', 'v'), state)).toEqual('global')
    })

    it('of constants only keeps every other node out, and is global for its own', () => {
      const where = '?this ex:k ?w . BIND(IF(BOUND(?w), ex:a, ex:b) AS ?n) OPTIONAL { ?n ex:l ?v }'
      expect(reach(where, t('zzz', 'l', 'v'), state)).toEqual([])
      expect(reach(where, t('a', 'l', 'v'), state)).toEqual('global')
    })

    it('in each branch of a UNION counts as binding it', () => {
      const where = '{ ?this ex:p ?s BIND(?this AS ?o) } UNION { ?this ex:q ?s BIND(?this AS ?o) } BIND(IRI(CONCAT(STR(?o), "/~x")) AS ?n) OPTIONAL { ?n ex:l ?v }'
      expect(reach(where, t('F/~x', 'l', 'v'), state)).toEqual(['F'])
    })
  })

  it('reads a node’s every triple only when nothing cheaper has said no', () => {
    const q = parseQuery(`PREFIX ex: <${EX}> SELECT * WHERE { ?this ex:k ?f . ?f ?bp ?s . ?s ex:c ?c . ?this ex:d ?c . ?t ?via ?s }`, prefixes)
    const deps = new Dependencies(f as unknown as Factory, q.select.where, ['this'], [], { prefixes })
    const change = t('new', 'via', 'popular')
    const state = lookupOf([change, ...Array.from({ length: 50 }, (_, i) => t(`n${i}`, 'x', 'popular'))])
    let everyTriple = 0
    const lookup: Lookup = (s, p, o, g) => {
      if (!p) everyTriple++
      return state(s, p, o, g)
    }
    const pattern = deps.route(change).find((x) => 'v' in x.s && x.s.v === 't')!
    expect(deps.probe(pattern, change, lookup)).toEqual([])
    expect(everyTriple).toBe(0)
  })

  describe('VALUES', () => {
    const where = 'VALUES ?k { ex:a ex:b } ?this ex:p ?x . OPTIONAL { ?k ex:l ?v }'

    it('keeps out a node it does not list, and is global for one it does', () => {
      expect(reach(where, t('zzz', 'l', 'v'), [t('F', 'p', 'x')])).toEqual([])
      expect(reach(where, t('a', 'l', 'v'), [t('F', 'p', 'x')])).toEqual('global')
    })

    it('says nothing of a variable with UNDEF', () => {
      const undef = 'VALUES ?k { ex:a UNDEF } ?this ex:p ?x . OPTIONAL { ?k ex:l ?v }'
      expect(reach(undef, t('zzz', 'l', 'v'), [t('F', 'p', 'x')])).toEqual('global')
    })
  })
})

describe('exact dependencies: the rules of the app', () => {
  // Rules that answer `global` for some predicate they name, on a subject they do not reach. What is
  // left (docs/IVM.md §25): settings and listings that read any node, and nested groups and BINDs whose
  // unbound case can reach any row. A fix lowers this; a rule that raises it re-runs for every label.
  const MOST_GLOBAL = 40

  it('do not treat a change on an unrelated node as global', () => {
    const { store, screen } = setup('oxigraph', { prefer: 'sparql', exactDependencies: true }, 20)
    const engine = screen.engine as unknown as { exact: { deps: Map<{ iri: string }, Dependencies> }; exactLookup(): Lookup }
    const factory = store.factory
    const lookup = engine.exactLookup()
    const global: string[] = []
    for (const [rule, deps] of engine.exact.deps) {
      const hit = deps.predicates().iris.some((iri) =>
        [factory.literal('x'), factory.namedNode('urn:audit:other')].some((o) => {
          const q = factory.quad(factory.namedNode('urn:audit:unrelated'), factory.namedNode(iri), o)
          return deps.route(q).some((p) => deps.probe(p, q, lookup) === 'global')
        }),
      )
      if (hit) global.push(rule.iri)
    }
    expect(global.length, global.sort().join('\n')).toBeLessThanOrEqual(MOST_GLOBAL)
  })
})
