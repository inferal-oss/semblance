// Variable predicates a SPARQL rule takes from its focus. A field that edits another node's
// property reads `$this c:controls ?target ; c:property ?p . ?target ?p ?value`: its predicate is a
// variable, so the predicates its query names do not say what it reads (src/engine/rules.ts), and it
// re-ran for every change to the node it follows - every field over one form node re-rendered when
// any of them changed (#153). But ?p only ever holds the focus's own c:property: the rule reads, on
// the followed node, the predicates its focus names. That is what this finds - for each variable
// predicate, where its values come from: a focus property (`$this <q> ?p`), an IRI, or a BIND of
// COALESCE / IF over those - so the engine watches, per focus, the values of those focus properties
// (as a member-wise rule's sem:memberWatchesVia). Anything else - a variable predicate bound by
// another pattern, a VALUES row or a subquery, or one that may be unbound where its pattern is
// evaluated - reads every predicate: undefined. Never too little.
import { type Expr, type Group, type Item, itemVars, type Node, type Path, parseQuery, projectedVars } from '../view/sparql.ts'

/**
 * Where a query's variable predicates come from: the nodes reached from the focus along the paths
 * in `via` (a step "^p" goes against p), and `iris`.
 */
export interface FocusPredicates {
  via: string[][]
  iris: Set<string>
  /** Predicates that have one of these properties (`?p sty:hookAttribute ?name . $this ?p ?v`). */
  marked: Set<string>
  /** The predicates its patterns name (property paths: each step's). */
  named: Set<string>
}

/** A group, and where it sits: its parent group, the item of the parent holding it, and whether a
 * binding must come before that item to be seen (EXISTS in a BIND, LATERAL: evaluated in order). */
interface Scope {
  g: Group
  parent?: Scope
  at?: number
  ordered?: boolean
  /** A LATERAL group: what is bound before it is substituted in it. */
  lateral?: boolean
  /** A subquery in a LATERAL: the variables it projects, which alone it takes from around it. */
  only?: Set<string>
}

/** Inside a LATERAL, short of a subquery of its own. */
function inLateral(scope: Scope | undefined): boolean {
  for (let s = scope; s; s = s.parent) if (s.lateral) return true
  return false
}

/** `query` with `$this` written `?this`, `prefixes` its prologue's. */
export function focusPredicates(query: string, prefixes: Map<string, string>): FocusPredicates | undefined {
  let where: Group
  try {
    where = parseQuery(query, prefixes).select.where
  } catch {
    return undefined
  }
  // Every variable predicate's pattern, with its scope.
  const uses: { v: string; scope: Scope }[] = []
  const named = new Set<string>()
  let unreadable = false
  const exprs = (e: Expr, scope: Scope, at: number, ordered: boolean) => {
    for (const x of e.exists) walk({ g: x.g, parent: scope, at, ordered })
  }
  const walk = (scope: Scope) => {
    scope.g.items.forEach((it: Item, at: number) => {
      switch (it.k) {
        case 'triples':
          for (const t of it.triples) {
            if (t.p.k === 'var') uses.push({ v: t.p.v, scope })
            // A negated property set reads every predicate; other paths name theirs.
            else if (!links(t.p, named)) unreadable = true
          }
          break
        case 'group':
        case 'optional':
        case 'minus':
        case 'service':
        case 'graph':
          walk({ g: it.g, parent: scope, at })
          break
        case 'lateral':
          walk({ g: it.g, parent: scope, at, ordered: true, lateral: true })
          break
        case 'union':
          for (const g of it.gs) walk({ g, parent: scope, at })
          break
        case 'filter':
          exprs(it.e, scope, at, false)
          break
        case 'bind':
          exprs(it.e, scope, at, true)
          break
        case 'select': {
          // Evaluated on its own: a variable predicate inside is bound inside, or not at all - but
          // in a LATERAL, the variables it projects take the values bound before it.
          const inner: Scope = { g: it.q.where }
          if (inLateral(scope)) Object.assign(inner, { parent: scope, at, only: new Set(projectedVars(it.q)) })
          walk(inner)
          for (const e of [...it.q.projection.flatMap((p) => (p.e ? [p.e] : [])), ...it.q.having, ...it.q.orderBy.map((o) => o.e)]) exprs(e, inner, Infinity, false)
          break
        }
      }
    })
  }
  walk({ g: where })
  if (unreadable) return undefined

  const iri = (text: string): string | undefined => {
    const m = /^<([^>]*)>$/.exec(text) ?? /^([\w-]*):([\w.-]*)$/.exec(text)
    if (!m) return undefined
    if (m.length === 2) return m[1]
    const ns = prefixes.get(m[1]!)
    return ns === undefined ? undefined : ns + m[2]
  }
  // The groups a position sees, innermost first, each with the items it sees (those before `before`:
  // a group evaluated in order sees only what its parent bound before it).
  const visible = function* (v: string, scope: Scope, before = Infinity): Generator<[Scope, number]> {
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      yield [s, Math.min(before, s.g.items.length)]
      if (s.only && !s.only.has(v)) return
      before = s.ordered ? s.at! : Infinity
    }
  }
  // The values a variable certainly has where it is used: by a pattern that links it to the focus
  // (or to a node certainly linked to it) in a group around it - which every other pattern joined
  // with it there can only narrow - or by a BIND or VALUES of such values. Undefined: it may be
  // unbound, or anything.
  const certain = (v: string, scope: Scope, before?: number, seen = new Set<string>()): Values | undefined => {
    if (v === 'this') return { paths: [[]], iris: [], marked: [] }
    if (seen.has(v)) return undefined
    const seen1 = new Set(seen).add(v)
    let marked: string | undefined
    for (const [s, upTo] of visible(v, scope, before)) {
      for (let at = 0; at < upTo; at++) {
        const it = s.g.items[at]!
        if (it.k === 'triples') {
          for (const t of it.triples) {
            if (t.p.k !== 'link') continue
            // ?x q ?v, or ?v q ?x: a step from (or back to) a node linked to the focus.
            const [other, step] = t.o.k === 'var' && t.o.v === v ? [t.s, t.p.iri] : t.s.k === 'var' && t.s.v === v ? [t.o, '^' + t.p.iri] : []
            if (other?.k !== 'var') continue
            const from = certain(other.v, s, upTo, seen1)
            if (from && !from.iris.length && !from.marked.length) return { paths: from.paths.map((p) => [...p, step!]), iris: [], marked: [] }
          }
          // ?v q ?x: a node that has q (when nothing links it to the focus).
          for (const t of it.triples) if (!marked && t.p.k === 'link' && t.s.k === 'var' && t.s.v === v) marked = t.p.iri
        }
        if (it.k === 'bind' && it.as === v) return value(it.e.text.trim(), s, at, true, seen1)
        if (it.k === 'values' && it.vars.includes(v)) {
          const i = it.vars.indexOf(v)
          const iris = it.rows.map((r) => (r[i]?.k === 'iri' ? r[i].v : undefined))
          return iris.every((x) => x) ? { paths: [], iris: iris as string[], marked: [] } : undefined
        }
      }
    }
    return marked ? { paths: [], iris: [], marked: [marked] } : undefined
  }
  // The values a variable holds where it is bound: certain ones, or ones certain inside each OPTIONAL
  // that binds it (whatever else such an OPTIONAL holds can only narrow them). An argument of
  // COALESCE may be unbound.
  const maybe = (v: string, scope: Scope, before: number, seen: Set<string>): Values | undefined => {
    const sure = certain(v, scope, before, seen)
    if (sure) return sure
    const out: Values = { paths: [], iris: [], marked: [] }
    for (const [s, upTo] of visible(v, scope, before)) {
      for (let at = 0; at < upTo; at++) {
        const it = s.g.items[at]!
        if (it.k === 'filter' || (it.k === 'bind' && it.as !== v) || !itemVars(it, new Set()).has(v)) continue
        const inside = it.k === 'optional' ? certain(v, { g: it.g, parent: s, at }, undefined, seen) : it.k === 'bind' ? value(it.e.text.trim(), s, at, false, seen) : undefined
        if (!inside) return undefined
        merge(out, inside)
      }
    }
    return out
  }
  // An expression's values: IRIs, variables as above, COALESCE and IF over them. `bound`: it must
  // have a value (COALESCE: one of its arguments certainly does).
  const value = (text: string, scope: Scope, at: number, bound: boolean, seen: Set<string>): Values | undefined => {
    const v = /^[?$](\w+)$/.exec(text)?.[1]
    if (v) return bound ? certain(v, scope, at, seen) : maybe(v, scope, at, seen)
    const c = iri(text)
    if (c) return { paths: [], iris: [c], marked: [] }
    const call = /^(COALESCE|IF)\s*\(([\s\S]*)\)$/i.exec(text)
    if (!call) return undefined
    const args = splitArgs(call[2]!).map((x) => x.trim())
    // IF's condition decides; its two branches are the values.
    if (call[1]!.toUpperCase() === 'IF' && args.length !== 3) return undefined
    const each = (call[1]!.toUpperCase() === 'IF' ? args.slice(1) : args).map((x) => value(x, scope, at, false, seen))
    if (each.some((x) => !x)) return undefined
    if (bound && (call[1]!.toUpperCase() === 'IF' ? !args.slice(1).every((x) => value(x, scope, at, true, seen)) : !args.some((x) => value(x, scope, at, true, seen)))) return undefined
    return each.reduce((a, b) => merge(a!, b!), { paths: [], iris: [], marked: [] })
  }

  const out: FocusPredicates = { via: [], iris: new Set(), marked: new Set(), named }
  const seenPaths = new Set<string>()
  for (const { v, scope } of uses) {
    const vals = certain(v, scope)
    // A variable predicate that is the focus itself is no predicate the focus names.
    if (!vals || vals.paths.some((p) => !p.length)) return undefined
    for (const p of vals.paths) if (!seenPaths.has(p.join(' '))) seenPaths.add(p.join(' ')), out.via.push(p)
    for (const i of vals.iris) out.iris.add(i)
    for (const m of vals.marked) out.marked.add(m)
  }
  return out
}

/** A variable's values: those reached from the focus along these paths, these IRIs, and nodes that have these properties. */
interface Values {
  paths: string[][]
  iris: string[]
  marked: string[]
}

function merge(a: Values, b: Values): Values {
  a.paths.push(...b.paths)
  a.iris.push(...b.iris)
  a.marked.push(...b.marked)
  return a
}

/** The predicates a path names, into `out`; false for a negated property set (any predicate). */
function links(p: Node | Path, out: Set<string>): boolean {
  if (p.k === 'link' || p.k === 'iri') return out.add(p.k === 'link' ? p.iri : p.v), true
  if (p.k === 'inv' || p.k === 'mod') return links(p.p, out)
  if (p.k === 'seq' || p.k === 'alt') return p.ps.every((x) => links(x, out))
  return p.k !== 'nps'
}

/** A call's arguments, split at its top-level commas. */
function splitArgs(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    else if (c === ',' && depth === 0) out.push(text.slice(start, i)), (start = i + 1)
  }
  out.push(text.slice(start))
  return out
}
