// Phase 1's view compiler (docs/IVM.md §20): a narrow recognizer for aggregates over LDES
// members, standing in for a compiler over a real SPARQL algebra (the rdf-engine's Rust
// parser) behind the same interface. What it recognizes:
//
//   SELECT ?g… (AGG([DISTINCT] expr) AS ?x)… WHERE { … ?stream tree:member ?m … } [GROUP BY ?g…] [ORDER BY …]
//   CONSTRUCT { template } WHERE { { that SELECT } BIND(…)… FILTER(…)… }
//
// with AGG one of COUNT, SUM, AVG, MIN, MAX. The WHERE body of the SELECT is the
// member-local part: it is evaluated for given members (VALUES, then LATERAL, so it stays
// correlated) and must read only the member and what it reaches - the oracle checks that in
// tests. Anything else compiles to a recompute plan that says why.
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import type { Aggregate, AggregateFn, RecomputePlan, SparqlRunner, StreamAggregatePlan, ViewCompiler, ViewPlan, ViewSource } from './plan.ts'

const TREE_MEMBER = 'https://w3id.org/tree#member'
const XSD = 'http://www.w3.org/2001/XMLSchema#'

/** Blank out string literals, IRIs and comments (same length), so braces and keywords can be found. */
export function mask(q: string): string {
  let out = ''
  let i = 0
  while (i < q.length) {
    const c = q[i]!
    if (c === '"' || c === "'") {
      const long = q.startsWith(c.repeat(3), i)
      const end = long ? q.indexOf(c.repeat(3), i + 3) : findQuote(q, i + 1, c)
      const stop = end < 0 ? q.length : end + (long ? 3 : 1)
      out += c + ' '.repeat(Math.max(0, stop - i - 2)) + (stop - i >= 2 ? c : '')
      i = stop
    } else if (c === '<' && /^<[^\s<>"{}|^`\\]*>/.test(q.slice(i))) {
      const stop = q.indexOf('>', i) + 1
      out += '<' + ' '.repeat(stop - i - 2) + '>'
      i = stop
    } else if (c === '#') {
      const stop = q.indexOf('\n', i) < 0 ? q.length : q.indexOf('\n', i)
      out += ' '.repeat(stop - i)
      i = stop
    } else {
      out += c
      i++
    }
  }
  return out
}

function findQuote(q: string, from: number, c: string): number {
  for (let i = from; i < q.length; i++) {
    if (q[i] === '\\') i++
    else if (q[i] === c) return i
  }
  return -1
}

/** Index of the bracket closing the one at `open` (in masked text). */
function closing(m: string, open: number): number {
  const o = m[open]!
  const cl = o === '{' ? '}' : ')'
  let depth = 0
  for (let i = open; i < m.length; i++) {
    if (m[i] === o) depth++
    else if (m[i] === cl && --depth === 0) return i
  }
  return -1
}

interface SelectParts {
  projection: string
  body: string
  /** Offset of the body in the original text, for the oracle's window filter. */
  bodyAt: number
  groupBy: string[]
  modifiers: string
}

function parseSelect(q: string, m: string, at: number): SelectParts | string {
  const head = /^\s*SELECT\s+/i.exec(m.slice(at))
  if (!head) return 'not a SELECT'
  const start = at + head[0].length
  if (/^(DISTINCT|REDUCED)\b/i.test(m.slice(start))) return 'SELECT DISTINCT / REDUCED'
  const open = m.indexOf('{', start)
  if (open < 0) return 'no WHERE'
  const close = closing(m, open)
  if (close < 0) return 'unbalanced braces'
  const projection = q.slice(start, open).replace(/\bWHERE\s*$/i, '').trim()
  const modifiers = m.slice(close + 1)
  const group = /^\s*GROUP\s+BY\s+((?:[?$]\w+\s*)+)/i.exec(modifiers)
  const rest = group ? modifiers.slice(group[0].length) : modifiers
  if (/\b(HAVING|LIMIT|OFFSET)\b/i.test(rest)) return 'HAVING, LIMIT or OFFSET (phase 2)'
  if (/\bGROUP\s+BY\b/i.test(rest)) return 'GROUP BY on expressions'
  return {
    projection,
    body: q.slice(open + 1, close),
    bodyAt: open + 1,
    groupBy: group ? [...group[1]!.matchAll(/[?$](\w+)/g)].map((x) => x[1]!) : [],
    modifiers,
  }
}

interface Projected {
  vars: string[]
  aggregates: (Aggregate & { expr: string })[]
}

function parseProjection(p: string): Projected | string {
  const pm = mask(p)
  const vars: string[] = []
  const aggregates: (Aggregate & { expr: string })[] = []
  let i = 0
  while (i < pm.length) {
    if (/\s/.test(pm[i]!)) {
      i++
      continue
    }
    if (pm[i] === '?' || pm[i] === '$') {
      const v = /^[?$](\w+)/.exec(pm.slice(i))!
      vars.push(v[1]!)
      i += v[0].length
      continue
    }
    if (pm[i] !== '(') return `cannot read the projection at "${p.slice(i, i + 20)}"`
    const end = closing(pm, i)
    if (end < 0) return 'unbalanced parentheses in the projection'
    const inner = p.slice(i + 1, end)
    const im = pm.slice(i + 1, end)
    const as = /\s+AS\s+[?$](\w+)\s*$/i.exec(im)
    if (!as) return 'a projected expression without AS'
    const expr = inner.slice(0, as.index).trim()
    const em = im.slice(0, as.index).trim()
    const fn = /^(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.exec(em)
    if (!fn) return `projected expression "${expr}" is not an aggregate (phase 2)`
    const argOpen = em.indexOf('(')
    if (closing(em, argOpen) !== em.length - 1) return `aggregate "${expr}" inside an expression (phase 2)`
    let arg = expr.slice(argOpen + 1, em.length - 1).trim()
    const distinct = /^DISTINCT\s+/i.test(arg)
    if (distinct) arg = arg.replace(/^DISTINCT\s+/i, '')
    const slot = `__a${aggregates.length}`
    aggregates.push({ as: as[1]!, fn: fn[1]!.toUpperCase() as AggregateFn, distinct, slot: arg === '*' ? '*' : slot, expr: arg })
    i = end + 1
  }
  return { vars, aggregates }
}

const FORBIDDEN = /\b(SELECT|GRAPH|SERVICE|NOW|RAND|UUID|STRUUID|BNODE|LIMIT|OFFSET)\b/i

/** PREFIX declarations, as a map. */
export function prefixMap(prefixes: string): Map<string, string> {
  return new Map([...prefixes.matchAll(/PREFIX\s+([\w-]*):\s*<([^>]*)>/gi)].map((m) => [m[1]!, m[2]!]))
}

function expand(term: string, prefixes: Map<string, string>): string | undefined {
  if (term.startsWith('<')) return term.slice(1, -1)
  const i = term.indexOf(':')
  const ns = prefixes.get(term.slice(0, i))
  return ns === undefined ? undefined : ns + term.slice(i + 1)
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

export const recognizer: ViewCompiler = {
  compile(source: ViewSource, run: SparqlRunner): ViewPlan {
    const plan = recognize(source, run)
    return typeof plan === 'string' ? ({ kind: 'recompute', form: source.form, query: source.query, reason: plan } satisfies RecomputePlan) : plan
  },
}

function recognize(source: ViewSource, run: SparqlRunner): StreamAggregatePlan | string {
  const q = source.query
  const m = mask(q)
  const prefixes = prefixMap(source.prefixes + '\n' + q)
  let select: SelectParts | string
  let template: string | undefined
  let rest = ''
  // CONSTRUCT { template } WHERE { { SELECT … } rest }
  let queryBody = q
  const prologue = /^\s*((?:PREFIX\s+[\w-]*:\s*<\s*>\s*|BASE\s+<\s*>\s*)*)/i.exec(m)![0].length
  const mm = m.slice(prologue)
  queryBody = q.slice(prologue)
  if (/^CONSTRUCT\b/i.test(mm)) {
    if (source.form !== 'construct') return 'CONSTRUCT text in sem:select'
    const tOpen = mm.indexOf('{')
    const tClose = closing(mm, tOpen)
    template = queryBody.slice(tOpen + 1, tClose)
    const wOpen = mm.indexOf('{', tClose + 1)
    if (!/^\s*(WHERE)?\s*$/i.test(mm.slice(tClose + 1, wOpen))) return 'CONSTRUCT WHERE shorthand or FROM'
    const wClose = closing(mm, wOpen)
    if (wClose < 0) return 'unbalanced braces'
    if (mm.slice(wClose + 1).trim()) return 'solution modifiers on a CONSTRUCT (phase 2)'
    const sOpen = mm.indexOf('{', wOpen + 1)
    if (sOpen < 0 || mm.slice(wOpen + 1, sOpen).trim()) return 'the WHERE does not start with an aggregate subquery'
    const sClose = closing(mm, sOpen)
    select = parseSelect(queryBody, mm.slice(0, sClose), sOpen + 1)
    rest = queryBody.slice(sClose + 1, wClose)
    // The rest may only compute from the aggregate row (BIND, FILTER): it reads nothing.
    const restMasked = mm.slice(sClose + 1, wClose)
    let left = ''
    for (let i = 0; i < restMasked.length; ) {
      const k = /^(BIND|FILTER)\s*\(/i.exec(restMasked.slice(i))
      if (k) {
        const end = closing(restMasked, i + k[0].length - 1)
        if (end < 0) return 'unbalanced parentheses'
        i = end + 1
      } else left += restMasked[i++]
    }
    if (left.replace(/[\s.]/g, '')) return 'the CONSTRUCT reads more than its aggregate subquery (phase 2)'
    if (FORBIDDEN.test(restMasked)) return 'NOW(), RAND() or similar after the aggregate'
  } else {
    if (source.form !== 'select') return 'SELECT text in sem:construct'
    select = parseSelect(queryBody, mm, 0)
  }
  if (typeof select === 'string') return select
  const projected = parseProjection(select.projection)
  if (typeof projected === 'string') return projected
  if (!projected.aggregates.length) return 'no aggregate (phase 2: joins and filters over streams)'
  for (const v of projected.vars) if (!select.groupBy.includes(v)) return `?${v} is projected but not grouped`
  const bodyMasked = mask(select.body)
  if (FORBIDDEN.test(bodyMasked)) return 'a subquery, GRAPH, SERVICE or a non-deterministic function in the member-local part'
  const members = [...select.body.matchAll(/([?$]\w+|<[^>\s]*>|[A-Za-z][\w-]*:[\w-]*)\s+(?:tree:member|<https:\/\/w3id\.org\/tree#member>)\s+[?$](\w+)/g)]
  if (members.length !== 1) return members.length ? 'more than one tree:member pattern' : 'no stream: no <stream> tree:member ?member pattern'
  const [, streamTerm, memberVar] = members[0]! as unknown as [string, string, string]
  const streamVar = /^[?$]/.test(streamTerm) ? streamTerm.slice(1) : undefined
  const stream = streamVar ? source.over : expand(streamTerm, prefixes)
  if (!streamVar && !stream) return `unknown prefix in ${streamTerm}`
  if (source.over && stream !== source.over) return `iv:over <${source.over}> but the query reads ${streamTerm}`
  if (!stream && source.window) return 'a window needs a fixed stream'
  if (projected.aggregates.some((a) => a.slot !== '*' && FORBIDDEN.test(mask(a.expr)))) return 'a non-deterministic aggregate argument'

  const timeBy = source.window ? (source.window.timeBy ?? (stream ? run.timestampPath(stream) : undefined)) : undefined
  if (source.window && !timeBy) return 'a window over a stream without ldes:timestampPath (and no iv:timeBy)'

  // The member-local query: the body, for the given members, correlated through LATERAL.
  const slots = projected.aggregates.filter((a) => a.slot !== '*').map((a) => `(${a.expr} AS ?${a.slot})`)
  const keep = [...new Set([memberVar, ...(streamVar ? [streamVar] : []), ...select.groupBy])].map((v) => '?' + v)
  const localHead = `SELECT ${keep.join(' ')} ${slots.join(' ')} WHERE {`
  const local = (batch: readonly { stream: NamedNode; member: NamedNode }[]) => {
    const out = new Map<string, Map<string, Term>[]>()
    if (!batch.length) return out
    const values = streamVar
      ? `VALUES (?${streamVar} ?${memberVar}) { ${batch.map((b) => `(<${b.stream.value}> <${b.member.value}>)`).join(' ')} }`
      : `VALUES ?${memberVar} { ${batch.map((b) => `<${b.member.value}>`).join(' ')} }`
    for (const row of run.select(`${localHead}\n  ${values}\n  LATERAL {\n${select.body}\n  }\n}`)) {
      const key = (streamVar ? row.get(streamVar)!.value : stream!) + ' ' + row.get(memberVar)!.value
      let rows = out.get(key)
      if (!rows) out.set(key, (rows = []))
      rows.push(row)
    }
    return out
  }
  // The output of one aggregate row: the template over the row (and the BINDs after it).
  const rowVars = [...select.groupBy, ...projected.aggregates.map((a) => a.as)]
  const output =
    template === undefined
      ? undefined
      : (row: Map<string, Term>): Quad[] =>
          run.construct(`CONSTRUCT {${template}} WHERE {\n  VALUES (${rowVars.map((v) => '?' + v).join(' ')}) { (${rowVars.map((v) => sparqlTerm(row.get(v))).join(' ')}) }\n${rest}\n}`)
  // The oracle: the query itself, with the window written as a filter at the clock's time.
  const reference = (now: number) => {
    if (!source.window || !timeBy) return q
    const cutoff = new Date(now - source.window.rangeMs).toISOString()
    const at = prologue + select.bodyAt
    return q.slice(0, at) + `\n  ?${memberVar} <${timeBy}> ?__t . FILTER(?__t >= "${cutoff}"^^<${XSD}dateTime>)\n` + q.slice(at)
  }
  return {
    kind: 'stream-aggregate',
    form: source.form,
    stream,
    streamVar,
    memberVar,
    groupBy: select.groupBy,
    aggregates: projected.aggregates.map(({ expr: _e, ...a }) => a),
    window: source.window && timeBy ? { rangeMs: source.window.rangeMs, timeBy } : undefined,
    local,
    output,
    reference,
    algebra: {
      local: `LATERAL(VALUES ?${memberVar}, {${select.body.trim().replace(/\s+/g, ' ')}})`,
      group: `Group((${select.groupBy.map((v) => '?' + v).join(' ')}), ${projected.aggregates.map((a) => `${a.fn}(${a.distinct ? 'DISTINCT ' : ''}${a.slot === '*' ? '*' : '…'}) AS ?${a.as}`).join(', ')})`,
      output: template === undefined ? undefined : `Construct({${template.trim().replace(/\s+/g, ' ')}})`,
    },
  }
}

export { TREE_MEMBER }
