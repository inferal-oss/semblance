// The view compiler (docs/IVM.md §21): from a parsed query to a maintained plan.
//
//   SELECT [DISTINCT] … WHERE { body } [GROUP BY ?v…] [HAVING …] [ORDER BY …] [LIMIT n] [OFFSET n]
//   CONSTRUCT { template } WHERE { body }
//   CONSTRUCT { template } WHERE { { SELECT … } [UNION { SELECT … }]… BIND(…)… FILTER(…)… }
//
// The body is partitioned by a key (iv:partitionBy; else the member of a `<stream> tree:member ?m`
// pattern; else the subject of the first triple pattern): each partition is the body evaluated
// with the key bound (VALUES, then LATERAL, so it stays correlated), on the store, so joins
// outside the member, OPTIONAL, UNION, MINUS, EXISTS / NOT EXISTS, VALUES, BIND and FILTER are
// all the store's own evaluation of one partition. Above the partitions: DISTINCT with counts,
// GROUP BY with incremental aggregates (and arithmetic over aggregates, HAVING), top-k over an
// ordered multiset. Which partitions a change touches comes from the body's triple patterns
// (deps.ts). Anything else compiles to a recompute plan that says why (iv:fallback).
import type { Term } from '@rdfjs/types'
import { termKey } from '../rdf.ts'
import { Dependencies } from './deps.ts'
import type { Aggregate, AggregateFn, MaintainedPlan, Op, Order, Part, Post, RecomputePlan, SparqlRunner, ViewCompiler, ViewPlan, ViewSource } from './plan.ts'
import { certainVars, type Expr, type Group, groupVars, type Item, parseQuery, projectedVars, type Query, type Select, SparqlSyntaxError } from './sparql.ts'

export const TREE_MEMBER = 'https://w3id.org/tree#member'
const XSD = 'http://www.w3.org/2001/XMLSchema#'
const NONDETERMINISTIC = /\b(NOW|RAND|UUID|STRUUID|BNODE)\s*\(/i

class Unsupported extends Error {}

/** PREFIX declarations, as a map. */
export function prefixMap(prefixes: string): Map<string, string> {
  return new Map([...prefixes.matchAll(/PREFIX\s+([\w-]*):\s*<([^>]*)>/gi)].map((m) => [m[1]!, m[2]!]))
}

/** A term as SPARQL text. */
export function sparqlTerm(t: Term | undefined): string {
  if (!t) return 'UNDEF'
  if (t.termType === 'NamedNode') return `<${t.value}>`
  if (t.termType === 'Literal') {
    const s = '"' + t.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
    return t.language ? `${s}@${t.language}` : t.datatype.value === XSD + 'string' ? s : `${s}^^<${t.datatype.value}>`
  }
  throw new Error(`a maintained view cannot hold a ${t.termType}`)
}

/** A partition key as a string: its terms' keys. */
export const keyString = (terms: readonly (Term | undefined)[]) => terms.map((t) => (t ? termKey(t) : '')).join(' ')

export const compiler: ViewCompiler = {
  compile(source: ViewSource, run: SparqlRunner): ViewPlan {
    try {
      return compile(source, run)
    } catch (e) {
      if (!(e instanceof Unsupported) && !(e instanceof SparqlSyntaxError)) throw e
      return { kind: 'recompute', form: source.form, query: source.query, reason: (e as Error).message } satisfies RecomputePlan
    }
  },
}

const flat = (s: string) => s.trim().replace(/\s+/g, ' ')

function compile(source: ViewSource, run: SparqlRunner): MaintainedPlan {
  const q = parseQuery(source.query, prefixMap(source.prefixes))
  if (q.form === 'ask') throw new Unsupported('ASK')
  if (q.form !== source.form) throw new Unsupported(`${q.form.toUpperCase()} text in sem:${source.form}`)
  const text = q.text
  const prologue = text.slice(0, q.bodyAt)
  if (q.form === 'construct') {
    for (const t of q.template!) {
      if (t.s.k === 'bnode' || t.o.k === 'bnode') throw new Unsupported('a blank node in the template')
      if (t.p.k !== 'var' && t.p.k !== 'link') throw new Unsupported('a path in the template')
    }
    const sel = q.select
    if (sel.orderBy.length || sel.limit !== undefined || sel.offset !== undefined) throw new Unsupported('solution modifiers on a CONSTRUCT')
    // CONSTRUCT { … } WHERE { { SELECT … } (UNION { SELECT … })* BIND/FILTER… }: the subqueries are the parts.
    const [first, ...rest] = sel.where.items
    const sub0 = asSelect(first)
    const subqueries = sub0 ? [sub0] : first?.k === 'union' && first.gs.every((g) => g.items.length === 1 && g.items[0]!.k === 'select') ? first.gs.map((g) => (g.items[0] as { q: Select }).q) : undefined
    if (subqueries && rest.every((it) => it.k === 'bind' || it.k === 'filter')) {
      const parts = subqueries.map((s) => part(s, source, run, text, prologue))
      const post = postOf(rest, [...new Set(parts.flatMap((p) => [...p.vars, ...(p.post?.binds.map((b) => b.as) ?? [])]))], text, prologue)
      // A subquery with LIMIT inside a CONSTRUCT: one part, its top-k at the plan level.
      const sub = subqueries.length === 1 ? subqueries[0]! : undefined
      const topk = sub && (sub.limit !== undefined || sub.offset !== undefined) ? topkOf(sub, parts[0]!, text) : undefined
      if (!topk && subqueries.some((s) => s.limit !== undefined || s.offset !== undefined)) throw new Unsupported('LIMIT in one branch of a UNION')
      return plan(source, q, parts, topk, post)
    }
    // CONSTRUCT { … } WHERE { body }: the template over the body's solutions.
    const p = part({ ...sel, star: true, projection: [] }, source, run, text, prologue)
    return plan(source, q, [p], undefined, undefined)
  }
  const sel = q.select
  const p = part(sel, source, run, text, prologue)
  const topk = sel.limit !== undefined || sel.offset !== undefined || sel.orderBy.length ? topkOf(sel, p, text) : undefined
  return plan(source, q, [p], topk, undefined)
}

function plan(source: ViewSource, q: Query, parts: Part[], topk: { topk: MaintainedPlan['topk']; orderPost?: Post } | undefined, post: Post | undefined): MaintainedPlan {
  const vars = q.form === 'select' ? (q.select.star ? [...groupVars(q.select.where)].filter((v) => !v.startsWith('__')) : q.select.projection.map((p) => p.v)) : []
  // The oracle: the query itself, with a window written as a filter at the clock's time.
  const windowed = parts.find((p) => p.window)
  const reference = (now: number) => {
    if (!windowed?.window || !source.window) return q.text
    const cutoff = new Date(now - windowed.window.rangeMs).toISOString()
    const at = windowAt(q)
    return q.text.slice(0, at) + `\n  ?${windowed.stream!.memberVar} <${windowed.window.timeBy}> ?__t . FILTER(?__t >= "${cutoff}"^^<${XSD}dateTime>)\n` + q.text.slice(at)
  }
  const signature = JSON.stringify([parts.map(shape), topk?.topk?.order, topk?.orderPost, post, q.templateText])
  return {
    kind: 'maintained',
    form: q.form as 'select' | 'construct',
    parts,
    topk: topk?.topk,
    orderPost: topk?.orderPost,
    post,
    vars,
    template: q.template,
    reference,
    signature,
    algebra: {
      topk: topk?.topk ? `TopK((${topk.topk.order.map((o) => (o.desc ? `DESC(?${o.slot})` : `?${o.slot}`)).join(' ')}), offset ${topk.topk.offset}${topk.topk.limit === undefined ? '' : `, limit ${topk.topk.limit}`})` : undefined,
      post: post ? [...post.binds.map((b) => `Extend(?${b.as} := ${flat(b.expr)})`), ...post.filters.map((f) => `Filter(${flat(f)})`)].join(', ') : undefined,
      output: q.templateText !== undefined ? `Construct({${flat(q.templateText)}})` : undefined,
    },
  }
}

/** A part's structure, without its body's text. */
function shape(p: Part): unknown {
  return [p.keys, p.slots, p.op, p.vars, p.post, p.stream, p.window, p.algebra.op, (p.derived ?? []).map((d) => [d.vars, shape(d.part)])]
}

/** Where the window's filter goes in the oracle: the start of the (first) member-local body. */
function windowAt(q: Query): number {
  const g = asSelect(q.select.where.items[0])?.where ?? q.select.where
  return g.at + 1
}

/** A part: the partitions of a SELECT's body and what it does with their rows. */
function part(sel: Select, source: ViewSource, run: SparqlRunner, text: string, prologue: string): Part {
  checkGroup(sel.where)
  const isRoot = (q: Select) => sel.where.items.some((it) => asSelect(it) === q)
  // Aggregate subqueries (candidates; see below which are maintained as parts of their own).
  const candidates = derivedSubqueries(sel.where)
  const certain = certainVars(sel.where)
  // Bound only by a derived subquery at the root: its group variables (an aggregate of aggregates).
  const fromSub = new Set<string>()
  for (const q of candidates) if (isRoot(q)) for (const e of q.groupBy) if (/^[?$]\w+$/.test(e.text.trim()) && certainVars(q.where).has(e.text.trim().slice(1)) && !certain.has(e.text.trim().slice(1))) fromSub.add(e.text.trim().slice(1))
  for (const v of fromSub) certain.add(v)
  // The partition key.
  const members = rootTriples(sel.where).filter((t) => t.p.k === 'link' && t.p.iri === TREE_MEMBER && t.o.k === 'var')
  if (members.length > 1 && !source.partitionBy) throw new Unsupported('more than one tree:member pattern (say iv:partitionBy)')
  let keys: string[]
  let stream: Part['stream']
  if (source.partitionBy) keys = source.partitionBy
  else if (members.length === 1) {
    const m = members[0]!
    const memberVar = (m.o as { v: string }).v
    const streamVar = m.s.k === 'var' ? m.s.v : undefined
    const fixed = m.s.k === 'iri' ? m.s.v : undefined
    if (source.over && fixed && fixed !== source.over) throw new Unsupported(`iv:over <${source.over}> but the query reads <${fixed}>`)
    stream = { stream: fixed ?? (streamVar ? undefined : source.over), streamVar, memberVar }
    keys = streamVar ? [streamVar, memberVar] : [memberVar]
  } else {
    // The subjects of the body's own triple patterns: a partition per combination (a cell; a
    // configuration, a scenario and a size of a cross product), so a change to one reaches its slice.
    // A constant subject's values are a dimension too (the sizes a run plans). With no triples of
    // its own, the groups of a derived subquery (an aggregate of aggregates: a partition per row).
    const dims = rootTriples(sel.where).flatMap((t) => (t.s.k === 'var' ? [t.s.v] : t.o.k === 'var' && t.p.k !== 'var' ? [t.o.v] : []))
    if (!dims.length) dims.push(...fromSub)
    keys = [...new Set(dims.filter((v) => certain.has(v) && !v.startsWith('__')))]
  }
  for (const k of keys) if (!certain.has(k)) throw new Unsupported(`the partition key ?${k} is not bound in every solution`)
  // Derived subqueries: those at the root, and those elsewhere that project no key (a nested one
  // projecting a key stays the store's: its rows could not be joined to the key there).
  const subs = candidates.filter((q) => isRoot(q) || !projectedVars(q).some((v) => keys.includes(v)))
  const derived = subs.map((q) => ({ part: part(q, { ...source, partitionBy: undefined, window: undefined }, run, text, prologue), vars: projectedVars(q) }))
  // Keys a derived subquery alone binds are not correlated (VALUES in LATERAL cannot bind what the
  // left side binds): its rows are filtered to the batch instead. Keys the body binds too are
  // renamed in its rows and joined by a FILTER.
  const leftKeys = keys.filter((k) => !fromSub.has(k))
  const renamed = derived.map((d, i) => new Map(isRoot(subs[i]!) ? d.vars.filter((v) => leftKeys.includes(v)).map((v) => [v, `__d${i}_${v}`] as const) : []))
  const pieces: string[] = []
  let at = sel.where.at + 1
  for (const q of subs) pieces.push(text.slice(at, q.at)), (at = q.end)
  pieces.push(text.slice(at, sel.where.end - 1))
  const joins = renamed.flatMap((m) => [...m].map(([v, r]) => `FILTER(sameTerm(?${r}, ?${v}))`)).join(' ')
  const columns = (i: number) => derived[i]!.vars.map((v) => '?' + (renamed[i]!.get(v) ?? v)).join(' ')
  const body = pieces.reduce((acc, piece, i) => acc + (i ? `VALUES (${columns(i - 1)}) { … }` : '') + piece, '') + (joins ? ' ' + joins : '')
  const deps = new Dependencies(run.factory, sel.where, keys, subs)
  if (deps.problem) throw new Unsupported(deps.problem)

  // What the partition rows hold, and what the part does with them.
  const slots = new Map<string, string | undefined>() // slot -> expression (undefined: a variable of the body)
  for (const k of keys) slots.set(k, undefined)
  const aggregates: (Aggregate & { expr?: string })[] = []
  const post: Post = { binds: [], filters: [], inputs: [], prologue }
  const aggOf = (a: Expr['aggregates'][number], as: string): Aggregate => {
    if (a.fn === 'SAMPLE' || a.fn === 'GROUP_CONCAT') throw new Unsupported(`${a.fn} (phase 5)`)
    let slot = '*'
    if (a.arg !== '*') {
      const v = /^[?$](\w+)$/.exec(a.arg.text.trim())?.[1]
      if (v) slot = v, slots.set(v, slots.get(v))
      else {
        slot = `__a${aggregates.length}`
        slots.set(slot, a.arg.text)
      }
      if (NONDETERMINISTIC.test(a.arg.text)) throw new Unsupported('a non-deterministic aggregate argument')
    }
    const agg = { as, fn: a.fn as AggregateFn, distinct: a.distinct, slot }
    aggregates.push(agg)
    return agg
  }
  /** An expression with its aggregates replaced by internal aggregate variables. */
  const overAggregates = (e: Expr): string => {
    let out = ''
    let at = e.at
    for (const a of e.aggregates) {
      const g = aggOf(a, `__g${aggregates.length}`)
      out += text.slice(at, a.at) + '?' + g.as
      at = a.end
    }
    return out + text.slice(at, e.end)
  }
  const grouped = sel.groupBy.length > 0 || sel.projection.some((p) => p.e?.aggregates.length) || sel.having.length > 0
  let op: Op
  let vars: string[]
  if (grouped) {
    const groupBy = sel.groupBy.map((e) => {
      const v = /^[?$](\w+)$/.exec(e.text.trim())?.[1]
      if (!v) throw new Unsupported('GROUP BY an expression')
      slots.set(v, undefined)
      return v
    })
    if (sel.star) throw new Unsupported('SELECT * with GROUP BY')
    for (const p of sel.projection) {
      if (!p.e) {
        if (!groupBy.includes(p.v)) throw new Unsupported(`?${p.v} is projected but not grouped`)
        continue
      }
      const a = p.e.aggregates
      if (a.length === 1 && a[0]!.at === p.e.at && a[0]!.end === p.e.end) aggOf(a[0]!, p.v)
      else if (a.length) post.binds.push({ expr: overAggregates(p.e), as: p.v })
      else post.binds.push({ expr: p.e.text, as: p.v })
      if (NONDETERMINISTIC.test(p.e.text)) throw new Unsupported('a non-deterministic expression')
    }
    for (const h of sel.having) post.filters.push(overAggregates(h))
    op = { k: 'group', groupBy, aggregates }
    vars = [...groupBy, ...aggregates.map((a) => a.as)]
  } else {
    const projected = sel.star ? [...groupVars(sel.where)].filter((v) => !v.startsWith('__')) : sel.projection.map((p) => p.v)
    for (const p of sel.star ? [] : sel.projection) {
      if (p.e && NONDETERMINISTIC.test(p.e.text)) throw new Unsupported('a non-deterministic expression')
      slots.set(p.v, p.e?.text)
    }
    for (const v of projected) if (!slots.has(v)) slots.set(v, undefined)
    op = sel.distinct || sel.reduced ? { k: 'distinct' } : { k: 'bag' }
    vars = projected
  }
  // ORDER BY over variables of the body that a bag keeps (a DISTINCT or a GROUP BY orders by its own output).
  for (const o of sel.orderBy) {
    const v = /^[?$](\w+)$/.exec(o.e.text.trim())?.[1]
    if (v && op.k === 'bag' && !vars.includes(v)) slots.set(v, undefined), vars.push(v)
  }
  post.inputs = [...vars]
  if (NONDETERMINISTIC.test(body)) throw new Unsupported('NOW(), RAND() or similar in the body')
  const slotNames = [...slots.keys()]
  const head = `${prologue}SELECT ${slotNames.map((s) => (slots.get(s) === undefined ? '?' + s : `(${slots.get(s)} AS ?${s})`)).join(' ')} WHERE {`
  // Slices (keys with UNDEF parts) may overlap in one batch: each VALUES row is numbered (?__k), and
  // a partition takes its rows from the first row that covers it - all of its solutions, once.
  const headK = head.replace(/ WHERE \{$/, ' ?__k WHERE {')
  // The body with each derived subquery's current rows in its place (those the batch's keys allow).
  const bodyWith = (batch: readonly (Term | undefined)[][] | undefined, rows: readonly Map<string, Term>[][] | undefined) => {
    if (!subs.length) return body
    return (
      pieces.reduce((acc, piece, i) => {
        if (!i) return piece
        const d = derived[i - 1]!
        const allowed = new Map<string, Set<string>>()
        for (const v of d.vars) {
          const k = keys.indexOf(v)
          if (k >= 0 && batch && batch.every((b) => b[k])) allowed.set(v, new Set(batch.map((b) => termKey(b[k]!))))
        }
        const fits = (r: Map<string, Term>) => [...allowed].every(([v, set]) => r.has(v) && set.has(termKey(r.get(v)!)))
        const values = (rows?.[i - 1] ?? []).filter(fits).map((r) => `(${d.vars.map((v) => sparqlTerm(r.get(v))).join(' ')})`)
        return acc + `VALUES (${columns(i - 1)}) { ${values.join(' ')} }` + piece
      }, '') + (joins ? '\n  ' + joins : '')
    )
  }
  const local = (batch0: readonly (Term | undefined)[][] | undefined, rows?: readonly Map<string, Term>[][]) => {
    const out = new Map<string, Map<string, Term>[]>()
    if (batch0 && !batch0.length) return out
    const body = bodyWith(batch0, rows)
    // The batch on the keys the body correlates (others filtered the derived rows above).
    const at = leftKeys.map((k) => keys.indexOf(k))
    const batch = batch0 && [...new Map(batch0.map((b) => at.map((i) => b[i])).map((b) => [keyString(b), b])).values()]
    const sliced = !!batch && leftKeys.length > 0 && batch.some((b) => b.some((t) => !t))
    const query = !batch || !leftKeys.length
      ? `${head}\n${body}\n}`
      : sliced
        ? `${headK}\n  VALUES (?__k ${leftKeys.map((k) => '?' + k).join(' ')}) { ${batch.map((b, i) => `(${i} ${b.map(sparqlTerm).join(' ')})`).join(' ')} }\n  LATERAL {\n${body}\n  }\n}`
        : `${head}\n  VALUES (${leftKeys.map((k) => '?' + k).join(' ')}) { ${batch.map((b) => `(${b.map(sparqlTerm).join(' ')})`).join(' ')} }\n  LATERAL {\n${body}\n  }\n}`
    const from = new Map<string, string>()
    const result = run.select(query)
    for (const row of result) {
      const key = keyString(keys.map((k) => row.get(k)))
      if (sliced) {
        const k = row.get('__k')!.value
        row.delete('__k')
        const first = from.get(key)
        if (first === undefined) from.set(key, k)
        else if (first !== k) continue
      }
      let rows = out.get(key)
      if (!rows) out.set(key, (rows = []))
      rows.push(row)
    }
    return out
  }
  const timeBy = source.window ? (source.window.timeBy ?? (stream?.stream ? run.timestampPath(stream.stream) : undefined)) : undefined
  if (source.window && !stream?.stream) throw new Unsupported('a window needs a fixed stream')
  if (source.window && !timeBy) throw new Unsupported('a window over a stream without ldes:timestampPath (and no iv:timeBy)')
  const keyText = keys.length ? keys.map((k) => '?' + k).join(' ') : '()'
  return {
    keys,
    slots: slotNames,
    local,
    deps,
    stream,
    window: source.window && timeBy ? { rangeMs: source.window.rangeMs, timeBy } : undefined,
    op,
    vars,
    post: post.binds.length || post.filters.length ? post : undefined,
    derived: derived.length ? derived : undefined,
    patternless: withoutTriples(sel.where, text),
    head: head.slice(prologue.length),
    algebra: {
      local: keys.length ? `LATERAL(VALUES ${keyText}, {${flat(body)}})` : `{${flat(body)}}`,
      op:
        op.k === 'group'
          ? `Group((${op.groupBy.map((v) => '?' + v).join(' ')}), ${op.aggregates.filter((a) => !a.as.startsWith('__g') || true).map((a) => `${a.fn}(${a.distinct ? 'DISTINCT ' : ''}${a.slot === '*' ? '*' : '…'}) AS ?${a.as}`).join(', ')})`
          : op.k === 'distinct'
            ? `Distinct(Project(${vars.map((v) => '?' + v).join(' ')}))`
            : `Project(${vars.map((v) => '?' + v).join(' ')})`,
      post: post.binds.length || post.filters.length ? [...post.binds.map((b) => `Extend(?${b.as} := ${flat(b.expr)})`), ...post.filters.map((f) => `Filter(${flat(f)})`)].join(', ') : undefined,
    },
  }
}

/** ORDER BY keys (expressions computed before the top-k), LIMIT and OFFSET. */
function topkOf(sel: Select, p: Part, text: string): { topk: MaintainedPlan['topk']; orderPost?: Post } {
  const order: Order[] = []
  const binds: Post['binds'] = []
  const available = new Set([...p.vars, ...(p.post?.binds.map((b) => b.as) ?? [])])
  sel.orderBy.forEach((o, i) => {
    const v = /^[?$](\w+)$/.exec(o.e.text.trim())?.[1]
    if (v && available.has(v)) return void order.push({ slot: v, desc: o.desc })
    if (o.e.aggregates.length) throw new Unsupported('ORDER BY an aggregate expression (project it, and order by its variable)')
    if (o.e.exists.length) throw new Unsupported('ORDER BY with EXISTS')
    for (const x of o.e.vars) if (!available.has(x)) throw new Unsupported(`ORDER BY reads ?${x}, which the rows do not keep`)
    const slot = `__o${i}`
    binds.push({ expr: text.slice(o.e.at, o.e.end), as: slot })
    order.push({ slot, desc: o.desc })
  })
  return { topk: { order, limit: sel.limit, offset: sel.offset ?? 0 }, orderPost: binds.length ? { binds, filters: [], inputs: [...available], prologue: text.slice(0, 0) } : undefined }
}

/** The BINDs and FILTERs after a CONSTRUCT's subqueries. */
function postOf(items: Item[], inputs: string[], text: string, prologue: string): Post | undefined {
  if (!items.length) return undefined
  const post: Post = { binds: [], filters: [], inputs, prologue }
  for (const it of items) {
    if (it.k === 'bind') {
      if (it.e.exists.length || it.e.aggregates.length) throw new Unsupported('EXISTS or an aggregate after the subquery')
      if (NONDETERMINISTIC.test(it.e.text)) throw new Unsupported('NOW(), RAND() or similar after the subquery')
      post.binds.push({ expr: text.slice(it.e.at, it.e.end), as: it.as })
    } else if (it.k === 'filter') {
      if (it.e.exists.length) throw new Unsupported('EXISTS after the subquery (it would read the store)')
      post.filters.push(text.slice(it.e.at, it.e.end))
    }
  }
  return post
}

/** `{ SELECT … }` as an item of a group. */
function asSelect(it: Item | undefined): Select | undefined {
  if (it?.k === 'select') return it.q
  if (it?.k === 'group' && it.g.items.length === 1 && it.g.items[0]!.k === 'select') return it.g.items[0]!.q
  return undefined
}

/**
 * Aggregate subqueries (GROUP BY, aggregates, HAVING; no LIMIT / OFFSET) in a group, outside
 * explicit LATERALs (there the store keeps them correlated) and outside each other.
 */
function derivedSubqueries(g: Group, out: Select[] = []): Select[] {
  for (const it of g.items) {
    if (it.k === 'select') {
      const q = it.q
      if ((q.groupBy.length || q.having.length || q.projection.some((p) => p.e?.aggregates.length)) && q.limit === undefined && q.offset === undefined) out.push(q)
    } else if (it.k === 'union') it.gs.forEach((b) => derivedSubqueries(b, out))
    else if (it.k === 'group' || it.k === 'optional' || it.k === 'minus') derivedSubqueries(it.g, out)
    else if (it.k === 'filter' || it.k === 'bind') for (const x of it.e.exists) derivedSubqueries(x.g, out)
  }
  return out.sort((a, b) => a.at - b.at)
}

/** A group's text with every triples block (at any depth) left out. */
function withoutTriples(g: Group, text: string): string {
  const spans: [number, number][] = []
  const visit = (g: Group) => {
    for (const it of g.items) {
      if (it.k === 'triples') spans.push([it.at, it.end])
      else if (it.k === 'select') visit(it.q.where)
      else if (it.k === 'union') it.gs.forEach(visit)
      else if ('g' in it) visit(it.g)
      else if (it.k === 'filter' || it.k === 'bind') for (const x of it.e.exists) visit(x.g)
    }
  }
  visit(g)
  spans.sort((a, b) => a[0] - b[0])
  let out = ''
  let at = g.at
  for (const [from, to] of spans) if (from >= at) (out += text.slice(at, from) + '…'), (at = to)
  return out + text.slice(at, g.end)
}

function rootTriples(g: Group) {
  const out: import('./sparql.ts').Triple[] = []
  for (const it of g.items) {
    if (it.k === 'triples') out.push(...it.triples)
    else if (it.k === 'group' || it.k === 'lateral') out.push(...rootTriples(it.g))
  }
  return out
}

function checkGroup(g: Group) {
  for (const it of g.items) {
    if (it.k === 'service') throw new Unsupported('SERVICE')
    if (it.k === 'graph') throw new Unsupported('GRAPH (views read the union of their graphs)')
    if (it.k === 'select') {
      checkGroup(it.q.where)
      for (const p of it.q.projection) if (p.e?.aggregates.some((a) => a.fn === 'SAMPLE')) throw new Unsupported('SAMPLE')
    }
    if ('g' in it) checkGroup(it.g)
    if (it.k === 'union') it.gs.forEach(checkGroup)
  }
}

export { projectedVars }
