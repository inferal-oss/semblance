// Exact dependencies of a partitioned view (docs/IVM.md §6.2, §6.4, §9.3): which partitions a
// changed triple can touch. Every triple pattern of the view's body - in OPTIONAL, UNION, MINUS,
// EXISTS / NOT EXISTS, subqueries, property paths - is a dependency. A changed triple is routed
// to the patterns whose constant positions it matches; for each, a delta query binds the pattern
// to the triple and probes the store's own indexes through the patterns that occur with it in a
// solution (its group and the groups around it) until it reaches the partition key: those are
// the partitions to evaluate again. Probes read the store with this tick's removed triples put
// back (the union of the old and the new state), so a solution that existed before the change,
// or exists after it, is found either way. A required UNION or subquery is walked through, every
// branch of it: a solution is in one of them. A pattern that cannot reach the key (a setting that
// gates every row; anything under LIMIT) is global: a change to it re-evaluates the view once.
// An aggregate subquery maintained as a part of its own (a derived input) contributes no patterns:
// a change of its rows binds the variables it projects, and probes from there.
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import { termKey } from '../rdf.ts'
import type { Factory } from '../store/types.ts'
import { certainVars, type Expr, type Group, type Node, type Path, projectedVars, type Select } from './sparql.ts'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

/** A position of a pattern: a variable, or a constant term. */
export type Pos = { v: string } | { t: Term }

interface Scope {
  parent?: Scope
  /** Changes here can affect rows they do not connect to (under LIMIT / OFFSET). */
  global: boolean
  pats: Pat[]
  aliases: Alias[]
  /** Required UNIONs and subqueries in it: every solution here is in one branch of each. */
  joins: Scope[][]
  /** Its OPTIONALs: a variable only they bind, when it has a value, comes from one of them. */
  optionals: Scope[]
  /** When it was read, among its siblings and BINDs. */
  order: number
  /** VALUES in it, per variable with a value in each row: what the variable can be. */
  values: { v: string; terms: Term[] }[]
  /**
   * The variables its group certainly binds (OPTIONAL, MINUS, a UNION branch, a subquery): only
   * through these does a walk leave it - one it may leave unbound is compatible with any value
   * outside. Undefined: any (the body; EXISTS, which sees its outer row bound).
   */
  certain?: Set<string>
}

export interface Pat {
  id: number
  s: Pos
  /** A plain predicate (or a variable), or a path. */
  p: Pos | { path: Path }
  o: Pos
  /** Inside GRAPH: the graph (a variable or a named graph); else the union default graph. */
  g?: Pos
  /**
   * p* or p?, whose zero-length solutions are a node of the graph with itself: any triple bringing
   * a node in is its input - unless another pattern of the solution already holds that node.
   */
  zero?: boolean
  scope: Scope
}

/** A required UNION or subquery walked through: from a variable to `to`, by a plan per branch. */
interface JoinStep {
  plans: WalkPlan[]
  to: string[]
}

/** A BIND walked back: from its value to `to`, by a plan per source it can have come from. */
interface SourceStep {
  plans: Map<string, WalkPlan>
  to: string[]
}

/** A step of a walk: through a pattern, an alias (out: its value to its sources; in: the reverse) or a join, from a bound variable. */
type Edge = { pat?: Pat; alias?: Alias; dir?: 'out' | 'in'; sources?: SourceStep; join?: JoinStep; from: string }

/** A walk planned for a pattern (or a derived row's scope) and the variables bound at its start. */
interface WalkPlan {
  id: string
  /** The variables it is after: the keys, or inside a join what the walk needs of it. */
  goal: string[]
  /** The start's variables the walk reads (the rest only ride along). */
  reads: string[]
  /** Every goal bound at the start. */
  bound: boolean
  /** No key reachable: a change that joins anything around it touches every partition. */
  unreachable: boolean
  needed: Edge[]
  reached: Set<string>
  /** The patterns that prune rows, and their variables a row's binding of does not constrain them. */
  checks: { x: Pat; blocked: string[] }[]
  /** What the variables around can be, whatever else holds: VALUES, and a BIND of nothing from the data. */
  domains: { v: string; admits: (t: Term) => boolean }[]
}

/** An IRI a BIND mints: CONCAT(<head>, "sep", …), its head a variable (or a constant string, `head` undefined). */
interface Mint {
  head?: string
  /** The head was read through STR(): a node, whose IRI starts the minted one (else already a string). */
  str: boolean
  sep: string
  /** Nothing follows the separator. */
  last: boolean
}

/** What a BIND's expression can evaluate to. */
interface Value {
  /** Variables it can be the value of. */
  from: string[]
  /** Variables it can be the STR() of. */
  strs: string[]
  constants: Term[]
  mints: Mint[]
  /** Something else: its values are not known. */
  opaque: boolean
  /** It cannot fail: ?to is certainly bound to one of the above, not left to match anything. */
  total: boolean
}

/** BIND(?from AS ?to), BIND(COALESCE(?a, c:none) AS ?to), BIND(IF(…, ?a, ?b) AS ?to), BIND(IRI(CONCAT(STR(?a), "/~x")) AS ?to). */
interface Alias extends Value {
  to: string
  /** Whether the first source, when bound, is the value (COALESCE, a plain alias). */
  first: boolean
  scope: Scope
  /** When it was read: an OPTIONAL after it is no source of it. */
  order: number
}

/**
 * A triple lookup over the view's dataset (and the tick's removed triples): the union default
 * graph, or with `g` the view's named graphs (`g` one, null any), quads with their graph.
 */
export type Lookup = (s: Term | null, p: Term | null, o: Term | null, g?: Term | null) => Quad[]

export class Dependencies {
  readonly patterns: Pat[] = []
  private byPredicate = new Map<string, Pat[]>()
  private anyPredicate: Pat[] = []
  private fresh = 0
  private readonly nn = (iri: string) => this.f.namedNode(iri)
  /** What could not be analysed (the view is then recomputed). */
  problem?: string
  /** While collecting: the graph of the GRAPH pattern being read. */
  private graph?: Pos
  /** Derived subqueries, in the order given: the scope they sit in, and their variables as named there. */
  private derivedAt: { scope: Scope; vars: Map<string, string> }[] = []

  constructor(
    private readonly f: Factory,
    where: Group,
    readonly keys: string[],
    private readonly derived: readonly Select[] = [],
    /**
     * A rule's body rather than a view's. Prune also by patterns only partly bound (some triple must
     * agree with what is bound), and when the change binds the key itself: fewer partitions (foci),
     * at a lookup per check. And the keys ($this, $member) are substituted into the query's text: a
     * constant in every group and subquery, whether it projects them or not, and never unbound (a
     * view's key is an ordinary variable, private to a subquery that does not project it). `prefixes`
     * read the constants of its expressions.
     */
    private readonly rule?: { prefixes: Map<string, string> },
  ) {
    const root: Scope = this.scope()
    try {
      this.group(where, root, (v) => v)
    } catch (e) {
      this.problem = (e as Error).message
    }
    for (const p of this.patterns) {
      if (!('path' in p.p) || p.p.path.k !== 'mod' || p.p.path.mod === '+') continue
      const held = (x: Pos) => {
        if ('t' in x) return false
        for (let sc: Scope | undefined = p.scope; sc; sc = sc.parent) if (sc.pats.some((y) => y !== p && !('path' in y.p) && [y.s, y.p as Pos, y.o].some((z) => 'v' in z && z.v === x.v))) return true
        return false
      }
      p.zero = !held(p.s) && !held(p.o)
    }
    for (const p of this.patterns) {
      const iris = 'path' in p.p ? pathIris(p.p.path) : 't' in p.p ? [p.p.t.value] : undefined
      if (!iris || zeroLength(p)) this.anyPredicate.push(p)
      else for (const iri of iris) this.byPredicate.set(iri, [...(this.byPredicate.get(iri) ?? []), p])
    }
  }

  /** The predicates a changed triple must have to reach a pattern, and whether some pattern takes any predicate. */
  predicates(): { iris: string[]; any: boolean } {
    return { iris: [...this.byPredicate.keys()], any: this.anyPredicate.length > 0 }
  }

  /** Root patterns over the key alone (and constants): a new key must match them to have rows. */
  anchors(): Pat[] {
    return this.patterns.filter((p) => !p.scope.parent && !p.g && !('path' in p.p) && [p.s, p.p as Pos, p.o].every((x) => 't' in x || this.keys.includes(x.v)))
  }

  /** Patterns a changed triple matches (by their constant positions). */
  route(q: Quad): Pat[] {
    const out: Pat[] = []
    const named = this.byPredicate.get(q.predicate.value)
    for (const p of named ? (this.anyPredicate.length ? [...named, ...this.anyPredicate] : named) : this.anyPredicate) {
      if ('t' in p.s && !same(p.s.t, q.subject)) {
        if (!('path' in p.p)) continue
      }
      if ('t' in p.o && !same(p.o.t, q.object)) {
        if (!('path' in p.p)) continue
      }
      if ('path' in p.p && p.p.path.k === 'nps' && npsSides(p.p.path).every((side) => side.exclude.has(q.predicate.value))) continue
      if (p.g && (q.graph.termType !== 'NamedNode' || ('t' in p.g && !p.g.t.equals(q.graph)))) continue
      out.push(p)
    }
    return out
  }

  /**
   * The partition keys a changed triple (matching `p`) may touch, or 'global' when the change may
   * touch any partition. A key the probe reaches only in part (a setting of every row of one
   * configuration, in a cross product) has `undefined` where any value goes: a slice of the
   * partitions. Probes `lookup` (old and new state together).
   */
  probe(p: Pat, q: Quad, lookup: Lookup): (Term | undefined)[][] | 'global' {
    const limited = this.limitedBy(p.scope)
    if (limited && !this.rule) return 'global'
    const starts = this.bind(p, q, lookup)
    if (starts === 'global') return 'global'
    return this.keysOf(starts.map((start) => this.walk(p.scope, p, start, lookup, limited)))
  }

  /**
   * The partition keys a row of derived subquery `i` (appearing or going) may touch: its
   * variables bound as the row binds them, joined toward the key through the patterns around it.
   */
  probeDerived(i: number, row: ReadonlyMap<string, Term>, lookup: Lookup): (Term | undefined)[][] | 'global' {
    const d = this.derivedAt[i]!
    if (this.inGlobal(d.scope)) return 'global'
    const start = new Map<string, Term>()
    for (const [inner, outer] of d.vars) {
      const t = row.get(inner)
      if (t) start.set(outer, t)
    }
    return this.keysOf([this.walk(d.scope, undefined, start, lookup)])
  }

  private keysOf(walks: (Map<string, Term>[] | 'global')[]): (Term | undefined)[][] | 'global' {
    const out = new Map<string, (Term | undefined)[]>()
    for (const rows of walks) {
      if (rows === 'global') return 'global'
      for (const r of rows) {
        const key = this.keys.map((k) => r.get(k))
        out.set(key.map((t) => (t ? termKey(t) : '')).join(' '), key)
      }
    }
    return [...out.values()]
  }

  private inGlobal(s: Scope | undefined): boolean {
    return !!this.limitedBy(s)
  }

  /** The innermost scope around `s` (or `s`) under LIMIT / OFFSET. */
  private limitedBy(s: Scope | undefined): Scope | undefined {
    for (; s; s = s.parent) if (s.global) return s
    return undefined
  }

  /** Initial bindings of a pattern to a changed triple (several for closures). */
  private bind(p: Pat, q: Quad, lookup: Lookup): Map<string, Term>[] | 'global' {
    const row = new Map<string, Term>()
    const put = (pos: Pos, t: Term) => {
      if ('t' in pos) return same(pos.t, t)
      const had = row.get(pos.v)
      if (had) return had.equals(t)
      row.set(pos.v, t)
      return true
    }
    if (p.g && !put(p.g, q.graph)) return []
    if (!('path' in p.p)) return put(p.s, q.subject) && put(p.p, q.predicate) && put(p.o, q.object) ? [row] : []
    // p* and p? also hold of every node of the graph with itself: a triple's nodes (a constant end, once it is one).
    const zero: Map<string, Term>[] = []
    if (zeroLength(p))
      for (const n of [q.subject, q.object]) {
        const r = new Map(row)
        if ([p.s, p.o].every((x) => ('t' in x ? same(x.t, n) : (r.set(x.v, n), true)))) zero.push(r)
      }
    const steps = this.steps(p, q, lookup, row)
    return steps === 'global' ? steps : [...zero, ...steps]
  }

  /** Bindings of a path pattern to a changed triple that is a step of it. */
  private steps(p: Pat, q: Quad, lookup: Lookup, row: Map<string, Term>): Map<string, Term>[] | 'global' {
    const put = (pos: Pos, t: Term) => {
      if ('t' in pos) return same(pos.t, t)
      const had = row.get(pos.v)
      if (had) return had.equals(t)
      row.set(pos.v, t)
      return true
    }
    const path = (p.p as { path: Path }).path
    // A path inside GRAPH walks that graph.
    if (p.g) lookup = inGraph(lookup, q.graph)
    // A link, an alternative of links, a negated set: the triple is one step.
    const direct = linkSteps(path)
    if (direct) {
      const out: Map<string, Term>[] = []
      for (const { iri, inv, exclude } of direct) {
        if (iri !== undefined && iri !== q.predicate.value) continue
        if (exclude?.has(q.predicate.value)) continue
        row.clear()
        if (p.g) put(p.g, q.graph)
        if (inv ? put(p.s, q.object) && put(p.o, q.subject) : put(p.s, q.subject) && put(p.o, q.object)) out.push(new Map(row))
      }
      return out
    }
    // A closure (p*, p+, p?) of a link or an alternative of links: the triple is one step of a
    // walk; the walk's start reaches its subject backwards, its end is reached from its object.
    if (path.k === 'mod') {
      // p*, p+, p? of a step or of a sequence of steps: the triple is one step, somewhere in it.
      const segments = path.p.k === 'seq' ? path.p.ps : [path.p]
      const out: Map<string, Term>[] = []
      const many = (nodes: Term[], back: boolean) => {
        if (path.mod === '?') return nodes
        const all = new Map<string, Term>()
        for (const n of nodes) for (const m of this.closure(path.p, n, back, lookup)) all.set(termKey(m), m)
        return [...all.values()]
      }
      const through = (nodes: Term[], segs: Path[], back: boolean) => {
        for (const seg of back ? [...segs].reverse() : segs) {
          const next = new Map<string, Term>()
          for (const n of nodes) for (const m of walkPath(this.nn, seg, n, back, lookup)) next.set(termKey(m), m)
          nodes = [...next.values()]
        }
        return nodes
      }
      for (let i = 0; i < segments.length; i++) {
        const steps = linkSteps(segments[i]!)
        if (!steps) return 'global'
        // The triple is a step from its subject to its object, or (an inverse step) back.
        for (const inv of new Set(steps.filter((x) => (x.iri === q.predicate.value || x.iri === undefined) && !x.exclude?.has(q.predicate.value)).map((x) => x.inv))) {
          const [from, to] = inv ? [q.object, q.subject] : [q.subject, q.object]
          const starts = many(through([from], segments.slice(0, i), true), true).filter((n) => !('t' in p.s) || same(p.s.t, n))
          const ends = many(through([to], segments.slice(i + 1), false), false).filter((n) => !('t' in p.o) || same(p.o.t, n))
          if (!starts.length || !ends.length) continue
          // A solution through this step has its start among the starts and its end among the ends:
          // both bound (while there are few pairs), else each end on its own.
          if ('v' in p.s && 'v' in p.o && starts.length * ends.length <= 2000) {
            for (const a of starts) for (const b of ends) out.push(new Map([[p.s.v, a], [p.o.v, b]]))
            continue
          }
          if ('v' in p.s) for (const n of starts) out.push(new Map([[p.s.v, n]]))
          if ('v' in p.o) for (const n of ends) out.push(new Map([[p.o.v, n]]))
          if ('t' in p.s && 't' in p.o) out.push(new Map())
        }
      }
      if (p.g && 'v' in p.g) for (const r of out) r.set(p.g.v, q.graph)
      return out
    }
    return 'global'
  }

  /** Nodes reached from `from` (or reaching it, `back`) by zero or more steps of a path. */
  private closure(path: Path, from: Term, back: boolean, lookup: Lookup): Term[] {
    const seen = new Map<string, Term>([[termKey(from), from]])
    const todo = [from]
    while (todo.length) {
      const n = todo.pop()!
      for (const m of walkPath(this.nn, path, n, back, lookup)) {
        const k = termKey(m)
        if (seen.has(k)) continue
        if (seen.size > 10_000) return [...seen.values()]
        seen.set(k, m)
        todo.push(m)
      }
    }
    return [...seen.values()]
  }

  /** From bindings in a scope (a pattern bound to a triple, or a derived row), join through the patterns around them until the keys are bound. */
  private walk(scope: Scope, p: Pat | undefined, start: Map<string, Term>, lookup: Lookup, limited?: Scope): Map<string, Term>[] | 'global' {
    const plan = this.plan(scope, p, start.keys(), this.keys, limited)
    // Under LIMIT, a change can move rows it does not join: a focus among the subquery's own patterns has
    // every row of it to itself, so it is that focus's window that moved. Otherwise any partition's.
    if (limited && !plan.reached.has(this.keys[0]!)) return 'global'
    return this.walkOnce(plan, start, lookup)
  }

  private walkOnce(plan: WalkPlan, start: Map<string, Term>, lookup: Lookup): Map<string, Term>[] | 'global' {
    // The same walk again (another change binding the same variables the walk reads, as a value's
    // removal and its replacement do) is answered once per lookup (while the store holds still).
    let memo = this.walks.get(lookup)
    if (!memo) this.walks.set(lookup, (memo = new Map()))
    let key = plan.id
    for (const v of plan.reads) {
      const t = start.get(v)
      key += '\u0001' + (t ? termKey(t) : '')
    }
    let out = memo.get(key)
    if (!out) memo.set(key, (out = this.walkPlanned(plan, start, lookup)))
    return out
  }

  /** Walks answered per lookup, by plan and the values of the variables it reads. */
  private walks = new WeakMap<Lookup, Map<string, Map<string, Term>[] | 'global'>>()

  private walkPlanned(plan: WalkPlan, start: Map<string, Term>, lookup: Lookup): Map<string, Term>[] | 'global' {
    // Bound already: the key is the change's own (with semiJoin, if the patterns around it hold).
    if (plan.bound) return !this.rule || this.holds(plan, start, lookup) ? [start] : []
    if (!this.holds(plan, start, lookup)) return []
    let rows = [start]
    for (const e of plan.needed) {
      const next: Map<string, Term>[] = []
      for (const r of rows) {
        if (e.pat) {
          for (const x of this.extend(e.pat, r, lookup)) next.push(x)
        } else if (e.join) {
          const t = r.get(e.from)
          if (!t) continue
          for (const branch of e.join.plans) {
            const found = this.walkOnce(branch, new Map([[e.from, t]]), lookup)
            if (found === 'global') return 'global'
            for (const x of found) {
              const row = mergeInto(r, x, e.join.to)
              if (row) next.push(row)
            }
          }
        } else if (e.sources) {
          const t = r.get(e.from)
          if (!t) continue
          const sources = this.sourcesOf(e.alias!, t, e.sources)
          if (sources === 'global') return 'global'
          for (const [w, v] of sources) {
            const found = this.walkOnce(e.sources.plans.get(w)!, new Map([[w, v]]), lookup)
            if (found === 'global') return 'global'
            for (const x of found) {
              const row = mergeInto(r, x, e.sources.to)
              if (row) next.push(row)
            }
          }
        } else {
          const a = e.alias!
          const t = r.get(a.from[0]!)
          if (t && !r.has(a.to)) next.push(new Map(r).set(a.to, t))
          else next.push(r)
        }
        if (next.length > 50_000) return 'global'
      }
      rows = []
      for (const r of next.length > 1 ? dedupe(next) : next) if (this.holds(plan, r, lookup)) rows.push(r)
      if (!rows.length) return []
    }
    if (plan.unreachable) return rows.length ? 'global' : []
    return rows.filter((r) => plan.goal.every((k) => r.has(k) || !plan.reached.has(k)))
  }

  /**
   * The variables a BIND's value can have come from, and what each is then; 'global' when it is
   * a constant of the expression (every row without a source reads that node), or comes from
   * something the walk cannot follow.
   */
  private sourcesOf(a: Alias, t: Term, step: SourceStep): [string, Term][] | 'global' {
    if (a.constants.some((c) => same(c, t))) return 'global'
    const out: [string, Term][] = a.from.map((w) => [w, t])
    if (t.termType === 'Literal' && ABSOLUTE_IRI.test(t.value)) for (const w of a.strs) out.push([w, this.nn(t.value)])
    if (t.termType === 'NamedNode')
      for (const m of a.mints) {
        const heads = mintHeads(m, t.value)
        if (!heads.length) continue
        if (m.head === undefined) return 'global'
        for (const h of heads) {
          if (!m.str) out.push([m.head, this.f.literal(h)])
          else if (ABSOLUTE_IRI.test(h)) out.push([m.head, this.nn(h)])
        }
      }
    return out.some(([w]) => !step.plans.has(w)) ? 'global' : out
  }

  /**
   * Patterns that hold in every solution p takes part in (its scope and those around it; not
   * paths) prune the rows once they bind all of a pattern's variables: a semi-join, so a probe
   * reaches the partitions that hold the change, not every one its first edge leads to.
   */
  private holds(plan: WalkPlan, r: Map<string, Term>, lookup: Lookup): boolean {
    for (const { v, admits } of plan.domains) {
      const t = r.get(v)
      if (t && !admits(t)) return false
    }
    next: for (const { x, blocked } of plan.checks) {
      // (Only with what may leave its scope for x's: a variable an inner group may leave unbound is no constraint.)
      for (const v of blocked) if (r.has(v)) continue next
      const s = 't' in x.s ? x.s.t : r.get(x.s.v)
      const pp = 't' in (x.p as Pos) ? (x.p as { t: Term }).t : r.get((x.p as { v: string }).v)
      const o = 't' in x.o ? x.o.t : r.get(x.o.v)
      // No triple has a literal subject (and the store would refuse to look).
      if (s && s.termType === 'Literal') return false
      if (!s || !pp || !o) {
        // With a part unbound, it still needs some triple that agrees with what is bound (a
        // semi-join): unless nothing of it is bound by the row, which would say nothing about the row.
        if (!this.rule) continue
        // (Only through an index of a bound node: a predicate alone would read all of it.)
        if ((!s && !o) || !patVars(x).some((v) => r.has(v))) continue
        if (pp && pp.termType !== 'NamedNode') continue
      }
      const found = x.g ? lookup(s ?? null, pp ?? null, o ?? null, ('t' in x.g ? x.g.t : r.get(x.g.v)) ?? null) : lookup(s ?? null, pp ?? null, o ?? null)
      if (!found.length) return false
    }
    return true
  }

  private plans = new Map<Pat | Scope, Map<string, WalkPlan>>()
  private planCount = 0

  /**
   * How a walk goes from the variables `start` binds: breadth-first over the variables toward each
   * goal (the keys), through the patterns, aliases and joins around (planned once per pattern and
   * bound variables). `within`: no further out than this scope. `valued`: a start that a BIND read
   * as having a value, which it can only have from a group that binds it before that BIND.
   */
  private plan(scope: Scope, p: Pat | undefined, start: Iterable<string>, goal: string[], within?: Scope, valued?: Alias): WalkPlan {
    const owner = p ?? scope
    let byBound = this.plans.get(owner)
    if (!byBound) this.plans.set(owner, (byBound = new Map()))
    const bound = new Set(start)
    const sig = `${[...bound].sort().join(' ')}|${goal.join(' ')}|${within ? this.scopeId(within) : ''}|${valued?.order ?? ''}`
    let plan = byBound.get(sig)
    if (plan) return plan
    // The patterns (and aliases) that occur with p in a solution: its scope and the scopes around it.
    const { around, aliases, joins, optionals, byVar } = this.neighbours(scope, p, within)
    // (While it is being planned, a walk back to the same place finds nothing new.)
    const unfinished: WalkPlan = { id: '', goal, reads: [], bound: false, unreachable: true, needed: [], reached: new Set(bound), checks: [], domains: [] }
    byBound.set(sig, unfinished)
    // Breadth-first over variables, from the bound ones to each goal.
    const via = new Map<string, Edge>()
    const queue = [...bound]
    const reached = new Set(bound)
    // Where each variable is bound: a walk leaves a scope only through what it certainly binds.
    const level = new Map<string, Scope>([...bound].map((v) => [v, scope]))
    const leaves = (v: string, to: Scope) => {
      let s: Scope | undefined = level.get(v)
      const inside = (x: Scope | undefined) => {
        for (; x; x = x.parent) if (x === to) return true
        return false
      }
      if (!inside(s)) return true
      for (; s && s !== to; s = s.parent) if (s.certain && !s.certain.has(v)) return false
      return true
    }
    const reach = (w: string, edge: Edge, at: Scope) => {
      if (reached.has(w)) return
      reached.add(w), via.set(w, edge), queue.push(w), level.set(w, at)
    }
    // (A pattern with a variable predicate reads every triple about a node: only when nothing else leads on.)
    const costly: { x: Pat; from: string }[] = []
    while ((queue.length || costly.length) && !goal.every((k) => reached.has(k))) {
      if (!queue.length) {
        const { x, from } = costly.shift()!
        for (const w of patVars(x)) reach(w, { pat: x, from }, x.scope)
        continue
      }
      const v = queue.shift()!
      for (const x of byVar.get(v) ?? []) {
        if (!leaves(v, x.scope)) continue
        if (!('path' in x.p) && 'v' in x.p) {
          costly.push({ x, from: v })
          continue
        }
        // Path connectors need a bound end to walk from.
        for (const w of patVars(x)) reach(w, { pat: x, from: v }, x.scope)
      }
      for (const a of aliases) {
        if (!leaves(v, a.scope)) continue
        if (a.to === v && a.total && !a.opaque) {
          const left = goal.filter((k) => !reached.has(k))
          const step = this.sourceStep(a, left, within)
          if (step) {
            const edge: Edge = { alias: a, sources: step, from: v }
            for (const w of step.to) reach(w, edge, a.scope)
          }
        }
        if (a.first && a.from[0] === v) reach(a.to, { alias: a, dir: 'in', from: v }, a.scope)
      }
      // A value read from an OPTIONAL: that it has one says the OPTIONAL matched.
      if (valued && bound.has(v)) {
        const binders = optionals.filter((o) => o.order < valued.order && scopeVars(o).has(v))
        if (binders.length && binders.every((o) => o.certain?.has(v))) {
          const step = this.joinStep(binders, v, goal, reached)
          if (step) {
            const edge: Edge = { join: step, from: v }
            for (const w of step.to) reach(w, edge, scope)
          }
        }
      }
      for (const j of joins) {
        // A branch that may leave v unbound takes any value outside: it does not lead anywhere from v.
        if (!leaves(v, j.at) || !j.branches.every((b) => b.certain?.has(v))) continue
        const step = this.joinStep(j.branches, v, goal, reached)
        if (!step) continue
        const edge: Edge = { join: step, from: v }
        for (const w of step.to) reach(w, edge, j.at)
      }
    }
    // No part of the key reached: any partition - unless the change joins with nothing around it
    // (then it is in no solution). Part of it: the slice it binds.
    const unreachable = goal.length > 0 && !goal.some((k) => reached.has(k))
    // The edges on the way to each key, in the order they were found (unreachable: all of them).
    const needed: Edge[] = unreachable ? [...via.values()] : []
    const seen = new Set<Edge>()
    for (const k of unreachable ? [] : goal) {
      if (!reached.has(k)) continue
      const chain: Edge[] = []
      for (let w = k; via.has(w); w = via.get(w)!.from) chain.push(via.get(w)!)
      for (const e of chain.reverse()) if (!seen.has(e)) seen.add(e), needed.push(e)
    }
    // A pattern joined once (a second edge through it adds nothing).
    const done = new Set<Pat>()
    const steps = needed.filter((e) => !e.pat || (!done.has(e.pat) && (done.add(e.pat), true)))
    // (The checks that read a node's every triple after those that may spare them.)
    const costlyLast = [...around].sort((a, b) => Number('v' in a.p) - Number('v' in b.p))
    const checks = costlyLast.map((x) => ({ x, blocked: patVars(x).filter((v) => !leaves(v, x.scope)) }))
    // The variables whose values the walk reads: the keys, and those of its steps and checks.
    const reads = new Set(goal)
    for (const e of steps) {
      if (e.pat) for (const v of patVars(e.pat)) reads.add(v)
      else if (e.join) for (const v of [e.from, ...e.join.to]) reads.add(v)
      else if (e.sources) for (const v of [e.from, ...e.sources.to]) reads.add(v)
      else for (const v of [e.alias!.to, ...e.alias!.from]) reads.add(v)
    }
    for (const { x } of checks) for (const v of patVars(x)) reads.add(v)
    const domains: WalkPlan['domains'] = []
    for (const a of aliases) if (a.total && !a.opaque && !a.from.length && leaves(a.to, a.scope)) domains.push({ v: a.to, admits: (t) => admits(a, t) })
    for (let s: Scope | undefined = scope; s; s = s === within ? undefined : s.parent)
      for (const { v, terms } of s.values) if (leaves(v, s)) domains.push({ v, admits: (t) => terms.some((c) => same(c, t)) })
    for (const { v } of domains) reads.add(v)
    plan = { id: String(this.planCount++), goal, bound: goal.every((k) => bound.has(k)), unreachable, needed: steps, reached, checks, domains, reads: [...reads].filter((v) => bound.has(v)).sort() }
    byBound.set(sig, plan)
    return plan
  }

  /**
   * From `v` through a join: the variables every branch reaches from it, each branch's plan to them;
   * none, when no branch has anything new to give. Of what it may give only the goals and what the
   * walk could go on from outside it (what every branch certainly binds) are wanted.
   */
  private joinStep(branches: Scope[], v: string, goal: string[], reached: Set<string>): JoinStep | undefined {
    const certain = [...branches[0]!.certain!].filter((w) => branches.every((b) => b.certain!.has(w)))
    const wanted = [...new Set([...goal, ...certain])].filter((w) => w !== v && !reached.has(w))
    if (!wanted.length) return undefined
    const to = wanted.filter((w) => branches.every((b) => this.plan(b, undefined, [v], wanted, b).reached.has(w)))
    return to.length ? { to, plans: branches.map((b) => this.plan(b, undefined, [v], to, b)) } : undefined
  }

  /**
   * From a BIND's value back to what it reads: each source it can have come from, and the goals every
   * one of them reaches (one that does not leads anywhere). A source that may hold a literal, read
   * through STR(), is no node to walk from.
   */
  private sourceStep(a: Alias, goal: string[], within?: Scope): SourceStep | undefined {
    if (!goal.length) return undefined
    const sources = new Set(a.from)
    for (const w of a.strs) if (this.isNode(w, a.scope)) sources.add(w)
    for (const m of a.mints) if (m.head !== undefined && (!m.str || this.isNode(m.head, a.scope))) sources.add(m.head)
    if (!sources.size) return undefined
    const plans = [...sources].map((w) => [w, this.plan(a.scope, undefined, [w], goal, within, a)] as const)
    const to = goal.filter((k) => plans.every(([, x]) => x.reached.has(k)))
    return to.length ? { to, plans: new Map(plans.map(([w]) => [w, this.plan(a.scope, undefined, [w], to, within, a)])) } : undefined
  }

  /** Whether a variable, seen from a scope, can only hold a node: a key, the subject of a triple around, or (in every branch) a BIND of only those. */
  private isNode(v: string, scope: Scope, seen = new Set<string>()): boolean {
    if (this.rule && this.keys.includes(v)) return true
    const here = (s: Scope): boolean => {
      if (s.pats.some((x) => !('path' in x.p) && 'v' in x.s && x.s.v === v)) return true
      const nodes = (a: Alias) => a.to === v && a.total && !a.opaque && !a.strs.length && a.constants.every((c) => c.termType === 'NamedNode') && a.from.every((w) => this.isNode(w, a.scope, seen))
      if (s.aliases.some(nodes)) return true
      return s.joins.some((branches) => branches.every((b) => b.certain?.has(v) && here(b)))
    }
    const at = `${v} ${this.scopeId(scope)}`
    if (seen.has(at)) return false
    seen.add(at)
    for (let s: Scope | undefined = scope; s; s = s.parent) if (here(s)) return true
    return false
  }

  private scopeIds = new WeakMap<Scope, number>()
  private scopeCount = 0
  private scopeId(s: Scope): number {
    let id = this.scopeIds.get(s)
    if (id === undefined) this.scopeIds.set(s, (id = this.scopeCount++))
    return id
  }

  private neighbourhoods = new Map<Pat | Scope, Map<Scope | undefined, { around: Pat[]; aliases: Alias[]; joins: { branches: Scope[]; at: Scope }[]; optionals: Scope[]; byVar: Map<string, Pat[]> }>>()

  /**
   * What a walk from pattern `p` (or from a derived row in `scope`) may go through: the patterns of
   * its scope and the scopes around it (out to `within`), which hold in every solution p takes part
   * in (so they also prune: `around`, without paths), and the required UNIONs and subqueries there,
   * but for the one the walk is in (its other branches are not this solution). Not an OPTIONAL
   * beside them: it need not match where a solution does, so a walk through one could miss it. By
   * variable; cached.
   */
  private neighbours(scope: Scope, p: Pat | undefined, within?: Scope) {
    const key = p ?? scope
    let byWithin = this.neighbourhoods.get(key)
    if (!byWithin) this.neighbourhoods.set(key, (byWithin = new Map()))
    let n = byWithin.get(within)
    if (n) return n
    const pats: Pat[] = []
    const aliases: Alias[] = []
    const joins: { branches: Scope[]; at: Scope }[] = []
    const optionals: Scope[] = []
    let inside: Scope | undefined
    for (let s: Scope | undefined = scope; s; inside = s, s = s.parent) {
      pats.push(...s.pats.filter((x) => x !== p)), aliases.push(...s.aliases)
      for (const branches of s.joins) if (!inside || !branches.includes(inside)) joins.push({ branches, at: s })
      optionals.push(...s.optionals.filter((o) => o !== inside))
      if (s === within) break
    }
    const inner = new Set(pats)
    const byVar = new Map<string, Pat[]>()
    for (const x of pats) for (const v of new Set(patVars(x))) byVar.set(v, [...(byVar.get(v) ?? []), x])
    n = { around: [...inner].filter((x) => !('path' in x.p)), aliases, joins, optionals, byVar }
    byWithin.set(within, n)
    return n
  }

  /** Rows extended by one pattern, looked up with what the row binds. */
  private extend(x: Pat, r: Map<string, Term>, lookup: Lookup): Map<string, Term>[] {
    const s = valueIn(r, x.s)
    const o = valueIn(r, x.o)
    const out: Map<string, Term>[] = []
    if (x.g) {
      // Inside GRAPH: a graph that is known, or each of the view's graphs the lookup finds.
      const g = valueIn(r, x.g)
      if (!g && 'path' in x.p) return []
      if (g) lookup = inGraph(lookup, g)
    }
    if ('path' in x.p) {
      // Walk the path from a bound end.
      const path = x.p.path
      if (s) for (const n of walkPath(this.nn, path, s, false, lookup)) {
        const row = new Map(r)
        if (set(row, x.o, n)) out.push(row)
      }
      else if (o) for (const n of walkPath(this.nn, path, o, true, lookup)) {
        const row = new Map(r)
        if (set(row, x.s, n)) out.push(row)
      }
      return out
    }
    const p = valueIn(r, x.p)
    if (!s && !o && !p) return []
    for (const q of x.g ? lookup(s ?? null, (p as NamedNode) ?? null, o ?? null, valueIn(r, x.g) ?? null) : lookup(s ?? null, (p as NamedNode) ?? null, o ?? null)) {
      const row = new Map(r)
      if ((!x.g || set(row, x.g, q.graph)) && set(row, x.s, q.subject) && set(row, x.p as Pos, q.predicate) && set(row, x.o, q.object)) out.push(row)
    }
    return out
  }

  // --- collecting the patterns -------------------------------------------------------------------

  private pos(n: Node, rename: (v: string) => string): Pos {
    switch (n.k) {
      case 'var':
        return { v: rename(n.v) }
      case 'bnode':
        return { v: rename('_:' + n.v) }
      case 'iri':
        return { t: this.f.namedNode(n.v) }
      case 'lit':
        return { t: n.lang ? this.f.literal(n.value, n.lang) : this.f.literal(n.value, n.dt ? this.f.namedNode(n.dt) : undefined) }
    }
  }

  private add(scope: Scope, s: Pos, p: Pos | { path: Path }, o: Pos) {
    if (this.graph && 'v' in this.graph && 'path' in p) throw new Error('a property path inside GRAPH ?var')
    const pat: Pat = { id: this.patterns.length, s, p, o, g: this.graph, scope }
    this.patterns.push(pat)
    scope.pats.push(pat)
  }

  private triple(scope: Scope, s: Pos, p: Node | Path, o: Pos, rename: (v: string) => string): void {
    if (p.k === 'var') return this.add(scope, s, { v: rename(p.v) }, o)
    if (p.k === 'iri' || p.k === 'lit' || p.k === 'bnode') return this.add(scope, s, this.pos(p, rename), o)
    // Paths: a sequence is a chain through fresh variables, an inverse swaps its ends.
    if (p.k === 'link') return this.add(scope, s, { t: this.f.namedNode(p.iri) }, o)
    if (p.k === 'inv') return this.triple(scope, o, p.p, s, rename)
    if (p.k === 'seq') {
      let from = s
      p.ps.forEach((step, i) => {
        const to: Pos = i === p.ps.length - 1 ? o : { v: `__p${this.fresh++}` }
        this.triple(scope, from, step, to, rename)
        from = to
      })
      return
    }
    this.add(scope, s, { path: p }, o)
  }

  /**
   * `left`: inside a LATERAL, the variables its left side certainly binds (as named here): a
   * subquery with LIMIT that projects one of them is evaluated per binding of it (correlated), so a
   * change reaches the bindings it joins to, not every partition.
   */
  private group(g: Group, scope: Scope, rename: (v: string) => string, left: ReadonlySet<string> = new Set()) {
    g.items.forEach((it, i) => {
      switch (it.k) {
        case 'triples':
          for (const t of it.triples) this.triple(scope, this.pos(t.s, rename), t.p, this.pos(t.o, rename), rename)
          break
        case 'lateral': {
          const before = [...certainVars({ items: g.items.slice(0, i), at: g.at, end: g.end })].map(rename)
          this.group(it.g, scope, rename, new Set([...left, ...before]))
          break
        }
        case 'group':
          this.group(it.g, scope, rename, left)
          break
        case 'graph': {
          const outer = this.graph
          this.graph = this.pos(it.name, rename)
          // A graph's solutions can need no triple of it (GRAPH ?g {}, a FILTER, an OPTIONAL): that the
          // graph has any quad is a dependency too.
          if (!it.g.items.some((x) => x.k === 'triples')) this.add(scope, { v: `__q${this.fresh++}` }, { v: `__q${this.fresh++}` }, { v: `__q${this.fresh++}` })
          this.group(it.g, scope, rename, left)
          this.graph = outer
          break
        }
        case 'optional': {
          const o = this.child(scope, false, this.certainIn(it.g, rename, left))
          scope.optionals.push(o)
          this.group(it.g, o, rename, left)
          break
        }
        case 'minus':
          this.group(it.g, this.child(scope, false, this.certainIn(it.g, rename, left)), rename, left)
          break
        case 'union': {
          const branches = it.gs.map((b) => this.child(scope, false, this.certainIn(b, rename, left)))
          it.gs.forEach((b, n) => this.group(b, branches[n]!, rename, left))
          scope.joins.push(branches)
          break
        }
        case 'service':
          throw new Error('SERVICE')
        case 'filter':
          this.expr(it.e, scope, rename)
          break
        case 'bind': {
          this.expr(it.e, scope, rename)
          const before = this.certainIn({ items: g.items.slice(0, i), at: g.at, end: g.end }, rename, left)
          this.alias(it.e, rename(it.as), scope, rename, before)
          break
        }
        case 'values':
          it.vars.forEach((v, n) => {
            const nodes = it.rows.map((r) => r[n])
            if (nodes.every((x) => x)) scope.values.push({ v: rename(v), terms: nodes.map((x) => (this.pos(x!, rename) as { t: Term }).t) })
          })
          break
        case 'select':
          this.select(it.q, scope, rename, left)
      }
    })
  }

  private scope(parent?: Scope, global = false, certain?: Set<string>): Scope {
    if (certain && this.rule) for (const k of this.keys) certain.add(k)
    return { parent, global, pats: [], aliases: [], joins: [], optionals: [], order: this.fresh++, values: [], certain }
  }

  private child(parent: Scope, global = false, certain?: Set<string>): Scope {
    return this.scope(parent, global, certain)
  }

  /**
   * What a group certainly binds (with what a LATERAL's left side bound before it is read): its
   * patterns', and those of BINDs that cannot fail, in its groups and UNIONs too.
   */
  private certainIn(g: Group, rename: (v: string) => string, left: ReadonlySet<string>): Set<string> {
    const out = new Set([...[...certainVars(g)].map(rename), ...left])
    for (const it of g.items) {
      if (it.k === 'bind') {
        if (this.value(it.e.text, rename, out).total) out.add(rename(it.as))
      } else if (it.k === 'group' || it.k === 'lateral') {
        for (const v of this.certainIn(it.g, rename, out)) out.add(v)
      } else if (it.k === 'union') {
        const sets = it.gs.map((b) => this.certainIn(b, rename, left))
        for (const v of sets[0] ?? []) if (sets.every((x) => x.has(v))) out.add(v)
      } else if (it.k === 'select') {
        // A subquery's own names, for its projected variables: BINDs in it may bind them.
        const projected = new Set(projectedVars(it.q))
        const id = this.fresh++
        const inner = (v: string) => (projected.has(v) ? rename(v) : `${v}#${id}`)
        const inGroup = it.q.groupBy.length ? new Set(it.q.groupBy.map((e) => /^[?$](\w+)$/.exec(e.text.trim())?.[1]).filter((v) => v)) : projected
        for (const v of this.certainIn(it.q.where, inner, left)) for (const w of inGroup) if (w && inner(w) === v) out.add(v)
      }
    }
    return out
  }

  private expr(e: Expr, scope: Scope, rename: (v: string) => string) {
    for (const x of e.exists) this.group(x.g, this.child(scope), rename)
    for (const a of e.aggregates) if (a.arg !== '*') this.expr(a.arg, scope, rename)
  }

  /** Record what a BIND can be; whether it certainly binds its variable. */
  private alias(e: Expr, to: string, scope: Scope, rename: (v: string) => string, known: ReadonlySet<string>): boolean {
    const t = e.text.trim()
    const value = this.value(t, rename, known)
    const arg = /^COALESCE\s*\(/i.test(t) ? splitArgs(callOf(t)?.args ?? '')[0]?.trim() : t
    const first = !!arg && /^[?$]\w+$/.test(arg) && value.from.length > 0
    if (value.from.length || value.strs.length || value.mints.length || value.constants.length) scope.aliases.push({ ...value, to, first, scope, order: this.fresh++ })
    return value.total
  }

  /** What an expression can evaluate to, in the variables' names here. */
  private value(text: string, rename: (v: string) => string, known: ReadonlySet<string>): Value {
    const t = text.trim()
    const none: Value = { from: [], strs: [], constants: [], mints: [], opaque: false, total: true }
    const v = /^[?$](\w+)$/.exec(t)
    if (v) return { ...none, from: [rename(v[1]!)], total: this.bound(v[1]!, rename, known) }
    const c = this.constant(t)
    if (c) return { ...none, constants: [c] }
    const call = callOf(t)
    const name = call?.name.toUpperCase()
    const args = call ? splitArgs(call.args) : []
    const fails = (x: string) => mayFail(x, (w) => this.bound(w, rename, known))
    if (name === 'COALESCE' || (name === 'IF' && args.length === 3)) {
      const parts = (name === 'IF' ? args.slice(1) : args).map((x) => this.value(x, rename, known))
      return {
        from: [...new Set(parts.flatMap((x) => x.from))],
        strs: [...new Set(parts.flatMap((x) => x.strs))],
        constants: parts.flatMap((x) => x.constants),
        mints: parts.flatMap((x) => x.mints),
        opaque: parts.some((x) => x.opaque),
        total: name === 'IF' ? !fails(args[0]!) && parts.every((x) => x.total) : parts.some((x) => x.total),
      }
    }
    if (name === 'STR' && args.length === 1) {
      const w = /^[?$](\w+)$/.exec(args[0]!.trim())
      if (w) return { ...none, strs: [rename(w[1]!)], total: this.bound(w[1]!, rename, known) }
    }
    if (name === 'IRI' || name === 'URI') {
      const inner = args.length === 1 ? callOf(args[0]!.trim()) : undefined
      const parts = inner?.name.toUpperCase() === 'CONCAT' ? splitArgs(inner.args).map((x) => x.trim()) : []
      const total = parts.length > 0 && !parts.some(fails)
      const string = /^"([^"\\]*)"$/.exec(parts[0] ?? '')
      if (string) return { ...none, mints: [{ str: false, sep: string[1]!, last: false }], total }
      const sep = /^"([^"\\]+)"$/.exec(parts[1] ?? '')
      if (sep) {
        const last = parts.length === 2
        const plain = /^[?$](\w+)$/.exec(parts[0]!)
        if (plain) return { ...none, mints: [{ head: rename(plain[1]!), str: false, sep: sep[1]!, last }], total }
        const of = callOf(parts[0]!)
        const w = of?.name.toUpperCase() === 'STR' ? /^[?$](\w+)$/.exec(of.args.trim()) : undefined
        if (w) return { ...none, mints: [{ head: rename(w[1]!), str: true, sep: sep[1]!, last }], total }
      }
    }
    return { ...none, opaque: true, total: !fails(t) }
  }

  private bound(v: string, rename: (v: string) => string, known: ReadonlySet<string>): boolean {
    return known.has(rename(v)) || (!!this.rule && this.keys.includes(v))
  }

  /** An IRI written in an expression. */
  private constant(t: string): Term | undefined {
    const iri = /^<([^<>\s]*)>$/.exec(t)
    if (iri) return this.f.namedNode(iri[1]!)
    const name = /^([\w-]*):([\w.-]*)$/.exec(t)
    const ns = name && this.rule?.prefixes.get(name[1]!)
    return ns ? this.f.namedNode(ns + name[2]!) : undefined
  }

  private select(q: Select, scope: Scope, rename: (v: string) => string, left: ReadonlySet<string> = new Set()) {
    // A subquery's own variables are its own: only what it projects joins the outside.
    const projected = new Set(projectedVars(q))
    const id = this.fresh++
    const inner = (v: string) => (projected.has(v) || (this.rule && this.keys.includes(v)) ? rename(v) : `${v}#${id}`)
    const at = this.derived.indexOf(q)
    if (at >= 0) {
      // A derived input: its own part follows its patterns; here only its rows matter.
      this.derivedAt[at] = { scope, vars: new Map([...projected].map((v) => [v, rename(v)])) }
      return
    }
    const correlated = [...projected].some((v) => left.has(rename(v)))
    const certain = new Set([...[...certainVars(q.where), ...q.projection.filter((x) => x.e).map((x) => x.v)].filter((v) => projected.has(v)).map(inner), ...left])
    const s = this.child(scope, (q.limit !== undefined || q.offset !== undefined) && !correlated, certain)
    scope.joins.push([s])
    // Projected expressions alias their variables.
    const known = new Set([...[...certainVars(q.where)].map(inner), ...left])
    for (const p of q.projection) if (p.e) this.alias(p.e, inner(p.v), s, inner, known)
    this.group(q.where, s, inner, left)
    for (const p of q.projection) if (p.e) this.expr(p.e, s, inner)
    for (const h of q.having) this.expr(h, s, inner)
    for (const e of q.groupBy) {
      this.expr(e, s, inner)
      if (e.as) this.alias(e, inner(e.as), s, inner, known)
    }
  }
}

const NUMERIC = /#(integer|decimal|double|float|int|long|short|byte|nonNegativeInteger|positiveInteger|nonPositiveInteger|negativeInteger|unsignedInt|unsignedLong|unsignedShort|unsignedByte)$/
/**
 * A query's constant and a stored term: equal, or the same number (a store may keep "01" and "+1"
 * as 1, and a query may write either): matching more is safe, a dependency missed is not.
 */
const varCache = new WeakMap<Pat, string[]>()
/** A pattern's variables (its subject, plain predicate, object and graph). */
function patVars(x: Pat): string[] {
  let vs = varCache.get(x)
  if (!vs) varCache.set(x, (vs = [x.s, 'path' in x.p ? undefined : x.p, x.o, x.g].filter((y): y is { v: string } => !!y && 'v' in y).map((y) => y.v)))
  return vs
}

/** A row with what a walk found of `to` (undefined: it disagrees). */
function mergeInto(r: Map<string, Term>, found: Map<string, Term>, to: string[]): Map<string, Term> | undefined {
  const row = new Map(r)
  for (const w of to) {
    const t = found.get(w)
    if (!t) continue
    const had = row.get(w)
    if (had && !had.equals(t)) return undefined
    row.set(w, t)
  }
  return row
}

/** Every variable a scope's groups mention. */
function scopeVars(s: Scope): Set<string> {
  const out = new Set<string>()
  const visit = (x: Scope) => {
    for (const p of x.pats) for (const v of patVars(p)) out.add(v)
    for (const a of x.aliases) out.add(a.to)
    for (const { v } of x.values) out.add(v)
    for (const o of x.optionals) visit(o)
    for (const j of x.joins) for (const b of j) visit(b)
  }
  visit(s)
  return out
}

/** What can be a node's IRI: other text is not the STR() of one (and a store would refuse to make it a term). */
const ABSOLUTE_IRI = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`]*$/

/** The heads an IRI minted so can have: what stands before the separator, wherever that is. */
function mintHeads(m: Mint, iri: string): string[] {
  if (m.head === undefined) return iri.startsWith(m.sep) ? [''] : []
  if (m.last) return iri.endsWith(m.sep) && iri.length > m.sep.length ? [iri.slice(0, -m.sep.length)] : []
  const out: string[] = []
  for (let i = iri.indexOf(m.sep, 1); i > 0; i = iri.indexOf(m.sep, i + 1)) out.push(iri.slice(0, i))
  return out
}

/** Whether a BIND of nothing from the data can have this value. */
function admits(a: Alias, t: Term): boolean {
  if (a.constants.some((c) => same(c, t))) return true
  if (a.strs.length && t.termType === 'Literal') return true
  return t.termType === 'NamedNode' && a.mints.some((m) => mintHeads(m, t.value).length > 0)
}

/** `name(args)`, when that is all of the text. */
function callOf(t: string): { name: string; args: string } | undefined {
  const m = /^(\w+)\s*\(/.exec(t)
  if (!m) return undefined
  let depth = 0
  let quote = ''
  for (let i = m[0].length - 1; i < t.length; i++) {
    const c = t[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i === t.length - 1 ? { name: m[1]!, args: t.slice(m[0].length, i) } : undefined
  }
  return undefined
}

/** Functions that fail only when an argument does. */
const TOTAL_CALLS = new Set(['IF', 'STR', 'CONCAT', 'IRI', 'URI', 'ENCODE_FOR_URI', 'SAMETERM', 'ISIRI', 'ISURI', 'ISBLANK', 'ISLITERAL', 'ISNUMERIC'])

/**
 * Whether an expression can fail: for a variable left unbound (BOUND, EXISTS and a COALESCE with a
 * way out cannot), or by a type (what is not known not to: arithmetic, an ordering, other functions).
 */
function mayFail(text: string, known: (v: string) => boolean): boolean {
  const t = text.trim()
  const call = callOf(t)
  if (call) {
    const name = call.name.toUpperCase()
    if (name === 'BOUND' || name === 'EXISTS') return false
    const args = splitArgs(call.args)
    if (name === 'COALESCE') return args.every((a) => mayFail(a, known))
    return !TOTAL_CALLS.has(name) || args.some((a) => mayFail(a, known))
  }
  // An operator's operands: without strings, groups, and what cannot fail.
  let rest = t.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
  for (let i = rest.search(/\b(BOUND|EXISTS|COALESCE)\b|\{/i); i >= 0; i = rest.search(/\b(BOUND|EXISTS|COALESCE)\b|\{/i)) {
    const open = rest.slice(i).search(/[({]/)
    if (open < 0) break
    let depth = 0
    let end = i + open
    for (; end < rest.length; end++) {
      if (rest[end] === '(' || rest[end] === '{') depth++
      else if ((rest[end] === ')' || rest[end] === '}') && --depth === 0) break
    }
    const head = rest.slice(i, i + open).trim().toUpperCase()
    if (head === 'COALESCE' && mayFail(rest.slice(i, end + 1), known)) return true
    rest = rest.slice(0, i) + ' ' + rest.slice(end + 1)
  }
  rest = rest.replace(/<[^<>\s]*>/g, ' ')
  if (/[<>+*]|\b(?!BOUND\b|EXISTS\b|COALESCE\b)\w+\s*\(/i.test(rest) && !/^\s*[!(]*\s*(ISIRI|ISURI|ISLITERAL|ISBLANK|SAMETERM)\b/i.test(rest)) return true
  return [...rest.matchAll(/[?$](\w+)/g)].some((m) => !known(m[1]!))
}

function same(constant: Term, t: Term): boolean {
  if (constant.equals(t)) return true
  return constant.termType === 'Literal' && t.termType === 'Literal' && NUMERIC.test(constant.datatype.value) && constant.datatype.equals(t.datatype) && Number(constant.value) === Number(t.value)
}

/** A position's term: its constant, or what the row binds its variable to. */
function valueIn(r: Map<string, Term>, pos: Pos): Term | undefined {
  return 't' in pos ? pos.t : r.get(pos.v)
}

/** Bind a position of a row to a term: whether it agrees (a constant, or a variable bound already). */
function set(row: Map<string, Term>, pos: Pos, t: Term): boolean {
  if ('t' in pos) return same(pos.t, t)
  const had = row.get(pos.v)
  if (had) return had.equals(t)
  row.set(pos.v, t)
  return true
}

/** A lookup confined to one named graph (paths inside GRAPH). */
const inGraph = (lookup: Lookup, g: Term): Lookup => (s, p, o) => lookup(s, p, o, g)

function dedupe(rows: Map<string, Term>[]): Map<string, Term>[] {
  const seen = new Set<string>()
  const out: Map<string, Term>[] = []
  for (const r of rows) {
    const names = [...r.keys()].sort()
    let k = ''
    for (const a of names) k += a + '=' + termKey(r.get(a)!) + ' '
    if (!seen.has(k)) seen.add(k), out.push(r)
  }
  return out
}

/** Split a call's arguments at top-level commas. */
export function splitArgs(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      cur += c
      if (c === '\\') cur += s[++i] ?? ''
      else if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '{') depth++
    else if (c === ')' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(cur)
  return out
}

/** The predicates a path may step through; undefined: any (a negated set). */
function pathIris(p: Path): string[] | undefined {
  switch (p.k) {
    case 'link':
      return [p.iri]
    case 'inv':
    case 'mod':
      return pathIris(p.p)
    case 'seq':
    case 'alt': {
      const all = p.ps.map(pathIris)
      return all.some((x) => !x) ? undefined : all.flat() as string[]
    }
    case 'nps':
      return undefined
  }
}

/** A p* or p?: true of every node of the graph with itself, so any triple is its input. */
const zeroLength = (p: Pat) => !!p.zero

/** A negated property set's directions: forward (not these), and inverse (not those), as written. */
function npsSides(p: Extract<Path, { k: 'nps' }>): { inv: boolean; exclude: Set<string> }[] {
  const fwd = p.iris.filter((x) => !x.inv).map((x) => x.iri)
  const back = p.iris.filter((x) => x.inv).map((x) => x.iri)
  const out: { inv: boolean; exclude: Set<string> }[] = []
  if (fwd.length || !back.length) out.push({ inv: false, exclude: new Set(fwd) })
  if (back.length) out.push({ inv: true, exclude: new Set(back) })
  return out
}

/** A path that is one step (a link, an inverse, an alternative of those, a negated set): its steps. */
function linkSteps(p: Path, inv = false): { iri?: string; inv: boolean; exclude?: Set<string> }[] | undefined {
  switch (p.k) {
    case 'link':
      return [{ iri: p.iri, inv }]
    case 'inv':
      return linkSteps(p.p, !inv)
    case 'alt': {
      const all = p.ps.map((x) => linkSteps(x, inv))
      return all.some((x) => !x) ? undefined : all.flat() as { iri?: string; inv: boolean; exclude?: Set<string> }[]
    }
    case 'nps':
      return npsSides(p).map((side) => ({ iri: undefined, inv: side.inv !== inv, exclude: side.exclude }))
    default:
      return undefined
  }
}

/** One step of a path from a node (forwards, or backwards with `back`). */


/** The nodes a path leads to from `n` (or that lead to `n`, `back`). */
export function walkPath(nn: (iri: string) => NamedNode, p: Path, n: Term, back: boolean, lookup: Lookup): Term[] {
  const out = new Map<string, Term>()
  const put = (t: Term) => out.set(termKey(t), t)
  switch (p.k) {
    case 'link': {
      const pred = nn(p.iri)
      for (const q of back ? lookup(null, pred, n) : lookup(n, pred, null)) put(back ? q.subject : q.object)
      break
    }
    case 'inv':
      for (const t of walkPath(nn, p.p, n, !back, lookup)) put(t)
      break
    case 'alt':
      for (const x of p.ps) for (const t of walkPath(nn, x, n, back, lookup)) put(t)
      break
    case 'seq': {
      let cur = [n]
      for (const x of back ? [...p.ps].reverse() : p.ps) {
        const next = new Map<string, Term>()
        for (const c of cur) for (const t of walkPath(nn, x, c, back, lookup)) next.set(termKey(t), t)
        cur = [...next.values()]
      }
      for (const t of cur) put(t)
      break
    }
    case 'mod': {
      if (p.mod !== '+') put(n)
      const seen = new Set<string>([termKey(n)])
      let frontier = [n]
      const once = p.mod === '?'
      while (frontier.length) {
        const next: Term[] = []
        for (const c of frontier) for (const t of walkPath(nn, p.p, c, back, lookup)) {
          put(t)
          const k = termKey(t)
          if (!seen.has(k) && !once) seen.add(k), next.push(t)
        }
        if (seen.size > 10_000) break
        frontier = next
      }
      break
    }
    case 'nps':
      for (const side of npsSides(p)) {
        const reverse = back !== side.inv
        for (const q of reverse ? lookup(null, null, n) : lookup(n, null, null)) if (!side.exclude.has(q.predicate.value)) put(reverse ? q.subject : q.object)
      }
      break
  }
  return [...out.values()]
}

export { RDF_TYPE }
