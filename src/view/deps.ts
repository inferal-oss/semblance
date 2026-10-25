// Exact dependencies of a partitioned view (docs/IVM.md §6.2, §6.4, §9.3): which partitions a
// changed triple can touch. Every triple pattern of the view's body - in OPTIONAL, UNION, MINUS,
// EXISTS / NOT EXISTS, subqueries, property paths - is a dependency. A changed triple is routed
// to the patterns whose constant positions it matches; for each, a delta query binds the pattern
// to the triple and probes the store's own indexes through the patterns that occur with it in a
// solution (its group and the groups around it) until it reaches the partition key: those are
// the partitions to evaluate again. Probes read the store with this tick's removed triples put
// back (the union of the old and the new state), so a solution that existed before the change,
// or exists after it, is found either way. A pattern that cannot reach the key (a setting that
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
}

export interface Pat {
  id: number
  s: Pos
  /** A plain predicate (or a variable), or a path. */
  p: Pos | { path: Path }
  o: Pos
  scope: Scope
}

/** BIND(?from AS ?to), BIND(COALESCE(?a, …) AS ?to), BIND(IF(…, ?a, ?b) AS ?to): ?to is one of ?from. */
interface Alias {
  to: string
  from: string[]
  /** Whether the first source, when bound, is the value (COALESCE, a plain alias). */
  first: boolean
  scope: Scope
}

/** A triple lookup over the view's dataset (and the tick's removed triples). */
export type Lookup = (s: Term | null, p: Term | null, o: Term | null) => Quad[]

export class Dependencies {
  readonly patterns: Pat[] = []
  private byPredicate = new Map<string, Pat[]>()
  private anyPredicate: Pat[] = []
  private fresh = 0
  private readonly nn = (iri: string) => this.f.namedNode(iri)
  /** What could not be analysed (the view is then recomputed). */
  problem?: string
  /** Derived subqueries, in the order given: the scope they sit in, and their variables as named there. */
  private derivedAt: { scope: Scope; vars: Map<string, string> }[] = []

  constructor(
    private readonly f: Factory,
    where: Group,
    readonly keys: string[],
    private readonly derived: readonly Select[] = [],
  ) {
    const root: Scope = { global: false, pats: [], aliases: [] }
    try {
      this.group(where, root, (v) => v)
    } catch (e) {
      this.problem = (e as Error).message
    }
    for (const p of this.patterns) {
      const iris = 'path' in p.p ? pathIris(p.p.path) : 't' in p.p ? [p.p.t.value] : undefined
      if (!iris) this.anyPredicate.push(p)
      else for (const iri of iris) this.byPredicate.set(iri, [...(this.byPredicate.get(iri) ?? []), p])
    }
  }

  /** Root patterns over the key alone (and constants): a new key must match them to have rows. */
  anchors(): Pat[] {
    return this.patterns.filter((p) => !p.scope.parent && !('path' in p.p) && [p.s, p.p as Pos, p.o].every((x) => 't' in x || this.keys.includes(x.v)))
  }

  /** Patterns a changed triple matches (by their constant positions). */
  route(q: Quad): Pat[] {
    const out: Pat[] = []
    for (const p of [...(this.byPredicate.get(q.predicate.value) ?? []), ...this.anyPredicate]) {
      if ('t' in p.s && !p.s.t.equals(q.subject)) {
        if (!('path' in p.p)) continue
      }
      if ('t' in p.o && !p.o.t.equals(q.object)) {
        if (!('path' in p.p)) continue
      }
      if ('path' in p.p && p.p.path.k === 'nps' && p.p.path.iris.some((x) => x.iri === q.predicate.value)) continue
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
    if (p.scope.global || this.inGlobal(p.scope)) return 'global'
    const starts = this.bind(p, q, lookup)
    if (starts === 'global') return 'global'
    return this.keysOf(starts.map((start) => this.walk(p.scope, p, start, lookup)))
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
    for (; s; s = s.parent) if (s.global) return true
    return false
  }

  /** Initial bindings of a pattern to a changed triple (several for closures). */
  private bind(p: Pat, q: Quad, lookup: Lookup): Map<string, Term>[] | 'global' {
    const row = new Map<string, Term>()
    const put = (pos: Pos, t: Term) => {
      if ('t' in pos) return pos.t.equals(t)
      const had = row.get(pos.v)
      if (had) return had.equals(t)
      row.set(pos.v, t)
      return true
    }
    if (!('path' in p.p)) return put(p.s, q.subject) && put(p.p, q.predicate) && put(p.o, q.object) ? [row] : []
    const path = p.p.path
    // A link, an alternative of links, a negated set: the triple is one step.
    const direct = linkSteps(path)
    if (direct) {
      const out: Map<string, Term>[] = []
      for (const { iri, inv } of direct) {
        if (iri !== undefined && iri !== q.predicate.value) continue
        row.clear()
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
        for (const inv of new Set(steps.filter((x) => x.iri === q.predicate.value || x.iri === undefined).map((x) => x.inv))) {
          const [from, to] = inv ? [q.object, q.subject] : [q.subject, q.object]
          const starts = many(through([from], segments.slice(0, i), true), true).filter((n) => !('t' in p.s) || p.s.t.equals(n))
          const ends = many(through([to], segments.slice(i + 1), false), false).filter((n) => !('t' in p.o) || p.o.t.equals(n))
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
  private walk(scope: Scope, p: Pat | undefined, start: Map<string, Term>, lookup: Lookup): Map<string, Term>[] | 'global' {
    const bound = new Set(start.keys())
    if (this.keys.every((k) => bound.has(k))) return [start]
    // The patterns (and aliases) that occur with p in a solution: its scope and the scopes around it.
    const pats: Pat[] = []
    const aliases: Alias[] = []
    for (let s: Scope | undefined = scope; s; s = s.parent) pats.push(...s.pats.filter((x) => x !== p)), aliases.push(...s.aliases)
    // Breadth-first over variables, from the bound ones to each key.
    type Edge = { pat?: Pat; alias?: Alias; dir?: 'out' | 'in'; from: string }
    const via = new Map<string, Edge>()
    const queue = [...bound]
    const reached = new Set(bound)
    const varsOf = (x: Pat) => [x.s, 'path' in x.p ? undefined : x.p, x.o].filter((y): y is { v: string } => !!y && 'v' in y).map((y) => y.v)
    while (queue.length && !this.keys.every((k) => reached.has(k))) {
      const v = queue.shift()!
      for (const x of pats) {
        const vs = varsOf(x)
        if (!vs.includes(v)) continue
        // Path connectors need a bound end to walk from.
        for (const w of vs) if (!reached.has(w)) reached.add(w), via.set(w, { pat: x, from: v }), queue.push(w)
      }
      for (const a of aliases) {
        if (a.to === v) for (const w of a.from) if (!reached.has(w)) reached.add(w), via.set(w, { alias: a, dir: 'out', from: v }), queue.push(w)
        if (a.first && a.from[0] === v && !reached.has(a.to)) reached.add(a.to), via.set(a.to, { alias: a, dir: 'in', from: v }), queue.push(a.to)
      }
    }
    // No part of the key reached: any partition. Part of it: the slice it binds.
    if (this.keys.length && !this.keys.some((k) => reached.has(k))) return 'global'
    // The edges on the way to each key, in the order they were found.
    const needed: Edge[] = []
    const seen = new Set<Edge>()
    for (const k of this.keys) {
      if (!reached.has(k)) continue
      const chain: Edge[] = []
      for (let w = k; via.has(w); w = via.get(w)!.from) chain.push(via.get(w)!)
      for (const e of chain.reverse()) if (!seen.has(e)) seen.add(e), needed.push(e)
    }
    // Patterns that hold in every solution p takes part in (its scope and those around it; not
    // paths) prune the rows once they bind all of a pattern's variables: a semi-join, so a probe
    // reaches the partitions that hold the change, not every one its first edge leads to.
    const checks = pats.filter((x) => !('path' in x.p) && x !== p)
    const holds = (r: Map<string, Term>) =>
      checks.every((x) => {
        const val = (pos: Pos) => ('t' in pos ? pos.t : r.get(pos.v))
        const s = val(x.s)
        const pp = val(x.p as Pos)
        const o = val(x.o)
        return !s || !pp || !o || lookup(s, pp, o).length > 0
      })
    let rows = [start].filter(holds)
    const done = new Set<Pat | Alias>()
    for (const e of needed) {
      const x = (e.pat ?? e.alias)!
      if (e.pat && done.has(x)) continue
      done.add(x)
      const next: Map<string, Term>[] = []
      for (const r of rows) {
        if (e.pat) next.push(...this.extend(e.pat, r, lookup))
        else {
          const a = e.alias!
          if (e.dir === 'out') {
            const t = r.get(a.to)
            if (!t) continue
            for (const w of a.from) {
              const had = r.get(w)
              if (had && !had.equals(t)) continue
              next.push(new Map(r).set(w, t))
            }
          } else {
            const t = r.get(a.from[0]!)
            if (t && !r.has(a.to)) next.push(new Map(r).set(a.to, t))
            else next.push(r)
          }
        }
        if (next.length > 50_000) return 'global'
      }
      rows = dedupe(next).filter(holds)
    }
    return rows.filter((r) => this.keys.every((k) => r.has(k) || !reached.has(k)))
  }

  /** Rows extended by one pattern, looked up with what the row binds. */
  private extend(x: Pat, r: Map<string, Term>, lookup: Lookup): Map<string, Term>[] {
    const val = (pos: Pos) => ('t' in pos ? pos.t : r.get(pos.v))
    const s = val(x.s)
    const o = val(x.o)
    const out: Map<string, Term>[] = []
    const set = (row: Map<string, Term>, pos: Pos, t: Term) => {
      if ('t' in pos) return pos.t.equals(t)
      const had = row.get(pos.v)
      if (had) return had.equals(t)
      row.set(pos.v, t)
      return true
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
    const p = val(x.p)
    if (!s && !o && !p) return []
    for (const q of lookup(s ?? null, (p as NamedNode) ?? null, o ?? null)) {
      const row = new Map(r)
      if (set(row, x.s, q.subject) && set(row, x.p as Pos, q.predicate) && set(row, x.o, q.object)) out.push(row)
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
    const pat: Pat = { id: this.patterns.length, s, p, o, scope }
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
        case 'graph':
          this.group(it.g, scope, rename, left)
          break
        case 'optional':
        case 'minus':
          this.group(it.g, this.child(scope), rename, left)
          break
        case 'union':
          for (const b of it.gs) this.group(b, this.child(scope), rename, left)
          break
        case 'service':
          throw new Error('SERVICE')
        case 'filter':
          this.expr(it.e, scope, rename)
          break
        case 'bind':
          this.expr(it.e, scope, rename)
          this.alias(it.e, rename(it.as), scope, rename)
          break
        case 'values':
          break
        case 'select':
          this.select(it.q, scope, rename, left)
      }
    })
  }

  private child(parent: Scope, global = false): Scope {
    return { parent, global, pats: [], aliases: [] }
  }

  private expr(e: Expr, scope: Scope, rename: (v: string) => string) {
    for (const x of e.exists) this.group(x.g, this.child(scope), rename)
    for (const a of e.aggregates) if (a.arg !== '*') this.expr(a.arg, scope, rename)
  }

  private alias(e: Expr, to: string, scope: Scope, rename: (v: string) => string) {
    const t = e.text.trim()
    const v = /^[?$](\w+)$/.exec(t)
    if (v) return void scope.aliases.push({ to, from: [rename(v[1]!)], first: true, scope })
    const call = /^(COALESCE|IF)\s*\(([\s\S]*)\)$/i.exec(t)
    if (!call) return
    const args = splitArgs(call[2]!)
    const isIf = call[1]!.toUpperCase() === 'IF'
    const vars = (isIf ? args.slice(1) : args).map((a) => /^[?$](\w+)$/.exec(a.trim())?.[1]).filter((x): x is string => !!x).map(rename)
    if (vars.length) scope.aliases.push({ to, from: vars, first: !isIf && /^[?$]\w+$/.test(args[0]?.trim() ?? ''), scope })
  }

  private select(q: Select, scope: Scope, rename: (v: string) => string, left: ReadonlySet<string> = new Set()) {
    // A subquery's own variables are its own: only what it projects joins the outside.
    const projected = new Set(projectedVars(q))
    const id = this.fresh++
    const inner = (v: string) => (projected.has(v) ? rename(v) : `${v}#${id}`)
    const at = this.derived.indexOf(q)
    if (at >= 0) {
      // A derived input: its own part follows its patterns; here only its rows matter.
      this.derivedAt[at] = { scope, vars: new Map([...projected].map((v) => [v, rename(v)])) }
      return
    }
    const correlated = [...projected].some((v) => left.has(rename(v)))
    const s = this.child(scope, (q.limit !== undefined || q.offset !== undefined) && !correlated)
    // Projected expressions alias their variables.
    for (const p of q.projection) if (p.e) this.alias(p.e, inner(p.v), s, inner)
    this.group(q.where, s, inner, left)
    for (const p of q.projection) if (p.e) this.expr(p.e, s, inner)
    for (const h of q.having) this.expr(h, s, inner)
  }
}

function dedupe(rows: Map<string, Term>[]): Map<string, Term>[] {
  const seen = new Map<string, Map<string, Term>>()
  for (const r of rows) {
    const k = [...r.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([a, t]) => a + '=' + termKey(t)).join(' ')
    if (!seen.has(k)) seen.set(k, r)
  }
  return [...seen.values()]
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

/** A path that is one step (a link, an inverse, an alternative of those, a negated set): its steps. */
function linkSteps(p: Path, inv = false): { iri?: string; inv: boolean }[] | undefined {
  switch (p.k) {
    case 'link':
      return [{ iri: p.iri, inv }]
    case 'inv':
      return linkSteps(p.p, !inv)
    case 'alt': {
      const all = p.ps.map((x) => linkSteps(x, inv))
      return all.some((x) => !x) ? undefined : all.flat() as { iri?: string; inv: boolean }[]
    }
    case 'nps':
      return [{ iri: undefined, inv }]
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
      for (const q of back ? lookup(null, null, n) : lookup(n, null, null)) {
        if (p.iris.some((x) => x.iri === q.predicate.value && !x.inv)) continue
        put(back ? q.subject : q.object)
      }
      break
  }
  return [...out.values()]
}

export { RDF_TYPE }
