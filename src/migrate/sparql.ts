// A change of shape applied to a query (#473). The migration's own pattern runs in the engine over
// the query's template and triple patterns, as a graph whose variables stand as terms: writes (a
// CONSTRUCT's template) take mig:forward, reads (the WHERE) the other direction's pattern, so a read
// keeps its meaning. What depends on a value that is only known at run time is composed: both shapes
// stay, each gated. What a pattern cannot prove is reported, never guessed.
import { createHash } from 'node:crypto'
import { createStore } from '../node/load.ts'
import { NS, RDF_TYPE } from '../ns.ts'
import { parseQuery, parseUpdate, type Group, type Item, type Node, type Query, type Triple, type UpdateOp } from '../view/sparql.ts'
import { compactIri, lex } from './turtle.ts'

const VAR = 'urn:semblance:migrate:v:'
const BLANK = 'urn:semblance:migrate:b:'
const PATH = 'urn:semblance:migrate:path:'
const MARK = '# semblance migrate: '

export interface QueryNote {
  kind: 'review' | 'migrated'
  message: string
}

export interface RewriteInput {
  /** The literal's text. */
  body: string
  /** The prefixes in scope (the file's and the framework's); the query's own are added. */
  prefixes: Map<string, string>
  /** Classes a rule's `$this` is an instance of, from what holds the query (sem:targets, beh:sourceClass). */
  holders: string[]
  migration: string
  back: boolean
  forward: string
  backward?: string
}

export interface RewriteResult {
  body: string
  notes: QueryNote[]
  /** Classes the holder must now say instead: a rule's sem:targets moves with its query. */
  holderMoves: Map<string, string>
}

const key = (t: { s: Node; p: Node | Triple['p']; o: Node }) => `${nodeKey(t.s)} ${predicateKey(t.p)} ${nodeKey(t.o)}`
function nodeKey(n: Node): string {
  if (n.k === 'var') return `?${n.v}`
  if (n.k === 'iri') return `<${n.v}>`
  if (n.k === 'bnode') return `_:${n.v}`
  return JSON.stringify([n.value, n.lang ?? '', n.dt ?? ''])
}
function predicateKey(p: Node | Triple['p']): string {
  const x = p as { k: string; iri?: string; v?: string }
  if (x.k === 'link') return `<${x.iri}>`
  if (x.k === 'var') return `?${x.v}`
  if (x.k === 'iri') return `<${x.v}>`
  return '<path>'
}
const predicateIri = (t: Triple): string | undefined => {
  const p = t.p as { k: string; iri?: string; v?: string }
  return p.k === 'link' ? p.iri : p.k === 'iri' ? p.v : undefined
}

function frozen(n: Node): string {
  if (n.k === 'var') return `<${VAR}${n.v}>`
  if (n.k === 'bnode') return `<${BLANK}${n.v}>`
  if (n.k === 'iri') return `<${n.v}>`
  return JSON.stringify(n.value) + (n.lang ? `@${n.lang}` : n.dt ? `^^<${n.dt}>` : '')
}
let paths = 0
const frozenTriple = (t: Triple) => {
  const p = t.p as { k: string; iri?: string; v?: string }
  const predicate = p.k === 'link' ? `<${p.iri}>` : p.k === 'var' ? `<${VAR}${p.v}>` : p.k === 'iri' ? `<${p.v}>` : `<${PATH}${paths++}>`
  return `${frozen(t.s)} ${predicate} ${frozen(t.o)} .`
}
function patternNode(n: Node): string {
  if (n.k === 'var') return `?${n.v}`
  return frozen(n)
}
const patternTriple = (t: Triple) => `${patternNode(t.s)} ${predicateKey(t.p)} ${patternNode(t.o)} .`

interface StoreTerm {
  termType: string
  value: string
  language?: string
  datatype?: { value: string }
}
function nodeOf(t: StoreTerm): Node {
  if (t.termType === 'NamedNode') {
    if (t.value.startsWith(VAR)) return { k: 'var', v: t.value.slice(VAR.length) }
    if (t.value.startsWith(BLANK)) return { k: 'bnode', v: t.value.slice(BLANK.length) }
    return { k: 'iri', v: t.value }
  }
  const dt = t.datatype?.value
  return { k: 'lit', value: t.value, ...(t.language ? { lang: t.language } : dt && dt !== NS.xsd + 'string' ? { dt } : {}) }
}

type Binding = Map<string, Node>

/** Every way a pattern matches a graph of frozen triples. */
function match(graph: string[], pattern: Triple[]): Binding[] {
  if (!pattern.length) return []
  const store = createStore('wat')
  store.loadTurtle(graph.join('\n'))
  const rows = store.select(`SELECT * WHERE { ${pattern.map(patternTriple).join(' ')} }`, [store.factory.defaultGraph()])
  return rows.map((r) => new Map([...r].map(([k, v]) => [k, nodeOf(v as StoreTerm)])))
}

const writeNode = (n: Node, prefixes: Map<string, string>, dollars: Set<string>): string => {
  if (n.k === 'var') return `${dollars.has(n.v) ? '$' : '?'}${n.v}`
  if (n.k === 'iri') return compactIri(n.v, prefixes)
  if (n.k === 'bnode') return `_:${n.v}`
  if (n.dt === NS.xsd + 'integer' || n.dt === NS.xsd + 'decimal' || n.dt === NS.xsd + 'boolean') return n.value
  return JSON.stringify(n.value) + (n.lang ? `@${n.lang}` : n.dt ? `^^${compactIri(n.dt, prefixes)}` : '')
}

/** A triple with a pattern's variables replaced. */
function substitute(t: Triple, b: Binding): Triple {
  const n = (x: Node): Node => (x.k === 'var' && b.has(x.v) ? b.get(x.v)! : x)
  const p = t.p as { k: string; v?: string }
  return { s: n(t.s), p: p.k === 'var' && b.has(p.v!) ? (b.get(p.v!)! as Triple['p']) : t.p, o: n(t.o) }
}

function writeTriples(ts: Triple[], prefixes: Map<string, string>, dollars: Set<string>): string {
  const bySubject = new Map<string, Triple[]>()
  const written = new Set<string>()
  for (const t of ts) {
    if (written.has(key(t))) continue
    written.add(key(t))
    const k = nodeKey(t.s)
    bySubject.set(k, [...(bySubject.get(k) ?? []), t])
  }
  const lines: string[] = []
  for (const own of bySubject.values()) {
    const entries = own.map((t) => {
      const iri = predicateIri(t)
      const p = iri === RDF_TYPE ? 'a' : iri ? compactIri(iri, prefixes) : writeNode(t.p as Node, prefixes, dollars)
      return `${p} ${writeNode(t.o, prefixes, dollars)}`
    })
    lines.push(`${writeNode(own[0]!.s, prefixes, dollars)} ${entries.join(' ; ')} .`)
  }
  return lines.join('\n  ')
}

function groupTriples(g: Group, out: Triple[] = []): Triple[] {
  for (const it of g.items) if (it.k === 'triples') out.push(...it.triples)
  return out
}

function walkBlocks(g: Group, visit: (it: Extract<Item, { k: 'triples' }>) => void) {
  for (const it of g.items) {
    if (it.k === 'triples') visit(it)
    else if (it.k === 'group' || it.k === 'optional' || it.k === 'minus' || it.k === 'lateral' || it.k === 'graph' || it.k === 'service') walkBlocks(it.g, visit)
    else if (it.k === 'union') it.gs.forEach((x) => walkBlocks(x, visit))
    else if (it.k === 'select') walkBlocks(it.q.where, visit)
    else if (it.k === 'filter' || it.k === 'bind') it.e.exists.forEach((x) => walkBlocks(x.g, visit))
  }
}

/** The non-triple parts of a migration's WHERE: expressions move into the query, VALUES decide. */
interface Extras {
  binds: Extract<Item, { k: 'bind' }>[]
  filters: Extract<Item, { k: 'filter' }>[]
  values: Extract<Item, { k: 'values' }>[]
}
function extras(g: Group): Extras {
  return {
    binds: g.items.filter((i): i is Extract<Item, { k: 'bind' }> => i.k === 'bind'),
    filters: g.items.filter((i): i is Extract<Item, { k: 'filter' }> => i.k === 'filter'),
    values: g.items.filter((i): i is Extract<Item, { k: 'values' }> => i.k === 'values'),
  }
}

/** An expression's text, its variables renamed or replaced by what they stand for. */
function substituteExpr(text: string, b: Binding, prefixes: Map<string, string>, dollars: Set<string>, fresh: Map<string, string>): string {
  return lex(text)
    .map((t) => {
      if (t.k !== 'var') return t.text
      const name = t.text.slice(1)
      const to = b.get(name)
      if (to) return writeNode(to, prefixes, dollars)
      return '?' + (fresh.get(name) ?? name)
    })
    .join('')
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)

function varsIn(text: string): Set<string> {
  return new Set(lex(text).filter((t) => t.k === 'var').map((t) => t.text.slice(1)))
}

function freshName(want: string, used: Set<string>): string {
  if (!used.has(want)) return used.add(want), want
  for (let i = 1; ; i++) {
    const n = `${want}_${i}`
    if (!used.has(n)) return used.add(n), n
  }
}

export function rewriteQuery(input: RewriteInput): RewriteResult {
  const notes: QueryNote[] = []
  const holderMoves = new Map<string, string>()
  const none = (body: string): RewriteResult => ({ body, notes, holderMoves })
  const prefixes = new Map(input.prefixes)
  const parseHead = [...prefixes].map(([p, ns]) => `PREFIX ${p}: <${ns}>`).join('\n') + '\n'
  const withHead = (b: string) => parseHead + b.replace(/\$([A-Za-z_]\w*)/g, '?$1')

  // A composed query comes back from what it was, if nobody has touched it since.
  const marker = input.body.startsWith(MARK) ? /^# semblance migrate: (\S+) (\S+) (.*)\n/.exec(input.body) : null
  if (marker) {
    if (marker[1] === input.migration && input.back) {
      const rest = input.body.slice(marker[0].length)
      if (hash(rest) === marker[2]) {
        notes.push({ kind: 'migrated', message: 'a composed query restored' })
        return none(JSON.parse(marker[3]!) as string)
      }
      notes.push({ kind: 'review', message: 'a composed query was edited since it was composed: it stays as it is' })
      return none(input.body)
    }
  }

  const ops = (text: string): UpdateOp[] => parseUpdate(parseHead + text).ops
  const writeOps = ops(input.back ? input.backward! : input.forward)
  // A read of the old shape is answered from the new one: the opposite direction's INSERT is the old
  // shape, its WHERE the new. Without one, the forward operation stands in, with no expressions.
  const readSource = input.back ? input.forward : input.backward
  const readOps = readSource ? ops(readSource) : undefined

  let body = input.body
  let composed = false
  const opCount = writeOps.length
  for (let index = 0; index < opCount; index++) {
    const write = writeOps[index]!
    const q = parseQuery(withHead(body))
    const out = applyOp(body, q, write, readOps?.[index], parseHead, prefixes, input.holders, notes, holderMoves, () => (composed = true))
    if (out !== undefined) body = out
  }
  if (composed && body !== input.body) body = `${MARK}${input.migration} ${hash(body)} ${JSON.stringify(input.body)}\n${body}`
  return { body, notes, holderMoves }
}

function applyOp(
  body: string,
  q: Query,
  write: UpdateOp,
  read: UpdateOp | undefined,
  head: string,
  prefixes: Map<string, string>,
  holders: string[],
  notes: QueryNote[],
  holderMoves: Map<string, string>,
  markComposed: () => void,
): string | undefined {
  const full = head + body.replace(/\$([A-Za-z_]\w*)/g, '?$1')
  const offset = head.length
  const dollars = new Set([...body.matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]!))
  const merged = new Map([...prefixes, ...q.prefixes])
  const template = q.template ?? []
  const certain = groupTriples(q.select.where)
  const whole: Triple[] = []
  walkBlocks(q.select.where, (b) => whole.push(...b.triples))
  const holder: Triple[] = dollars.has('this') || /\?this\b/.test(body) ? holders.map((c) => ({ s: { k: 'var', v: 'this' }, p: { k: 'link', iri: RDF_TYPE }, o: { k: 'iri', v: c } }) as Triple) : []
  const opTerms = new Set([...write.del, ...write.ins].flatMap((t) => [predicateIri(t), t.o.k === 'iri' ? t.o.v : undefined]).filter(Boolean) as string[])
  const mentioned = (ts: Triple[]) => ts.some((t) => opTerms.has(predicateIri(t) ?? '') || (t.o.k === 'iri' && opTerms.has(t.o.v)) || (t.p as { k: string }).k !== 'link')
  if (!mentioned([...template, ...whole, ...holder])) return undefined
  const used = varsIn(body)
  const edits: { at: number; end: number; text: string }[] = []
  const deletedPredicates = write.del.map(predicateIri).filter(Boolean) as string[]

  // Writes.
  if (q.form === 'construct' && template.length) {
    const ex = extras(write.where)
    const whereTriples = groupTriples(write.where)
    const graph = [...template, ...certain, ...holder].map(frozenTriple)
    const solutions = match(graph, whereTriples)
    const inTemplate = new Set(template.map(key))
    const consumed = new Set<string>()
    const added: Triple[] = []
    const removed = new Set<string>()
    const appended: string[] = []
    let accepted = false
    const seen = new Set<string>()
    for (const sol of solutions) {
      const deleted = write.del.map((t) => substitute(t, sol))
      const id = deleted.map(key).sort().join('|')
      if (seen.has(id)) continue
      seen.add(id)
      if (!deleted.every((t) => inTemplate.has(key(t)))) {
        if (deleted.some((t) => inTemplate.has(key(t)))) notes.push({ kind: 'review', message: 'a template writes part of what this migration moves; the rest may come from elsewhere' })
        continue
      }
      if (deleted.some((t) => consumed.has(key(t)))) continue
      const b: Binding = new Map(sol)
      const fresh = new Map<string, string>()
      const name = (v: string) => {
        let f = fresh.get(v)
        if (!f) fresh.set(v, (f = freshName(v, used)))
        return f
      }
      let gated: { old: Node; news: { k: Node; v: Node }[] } | undefined
      if (ex.values.length) {
        const v = ex.values[0]!
        // A column whose value the query knows chooses a row; one it only knows at run time is composed.
        const col = v.vars.findIndex((x) => b.has(x))
        if (col < 0 || v.vars.length !== 2) {
          notes.push({ kind: 'review', message: 'a VALUES this tool cannot apply' })
          continue
        }
        const known = b.get(v.vars[col]!)!
        const other = v.vars[1 - col]!
        if (known.k === 'var') {
          gated = { old: known, news: v.rows.filter((r) => r[col] && r[1 - col]).map((r) => ({ k: r[col]!, v: r[1 - col]! })) }
          b.set(other, { k: 'var', v: name(other) })
        } else {
          const row = v.rows.find((r) => r[col] && nodeKey(r[col]!) === nodeKey(known))
          if (!row) continue
          b.set(other, row[1 - col]!)
        }
      }
      if (ex.filters.length && !gated) {
        notes.push({ kind: 'review', message: 'this migration applies only to some values (a FILTER): settle it by hand' })
        continue
      }
      for (const t of write.ins) for (const n of [t.s, t.o]) if (n.k === 'var' && !b.has(n.v)) b.set(n.v, { k: 'var', v: name(n.v) })
      if (gated) {
        const keep = name('keep')
        const old = writeNode(gated.old, merged, dollars)
        const target = writeNode(b.get(ex.values[0]!.vars.find((x) => x !== [...sol.keys()].find((y) => ex.values[0]!.vars.includes(y)))!)!, merged, dollars)
        let chain = '?unbound'
        for (const row of [...gated.news].reverse()) chain = `IF(${old} = ${writeNode(row.k, merged, dollars)}, ${writeNode(row.v, merged, dollars)}, ${chain})`
        appended.push(`BIND(${chain} AS ${target})`, `BIND(IF(${old} IN (${gated.news.map((r) => writeNode(r.k, merged, dollars)).join(', ')}), ?unbound, ${old}) AS ?${keep})`)
        markComposed()
        for (const t of deleted) {
          added.push({ ...t, o: t.o.k === 'var' && nodeKey(t.o) === nodeKey(gated.old) ? { k: 'var', v: keep } : t.o })
        }
      }
      for (const t of deleted) consumed.add(key(t)), removed.add(key(t))
      added.push(...write.ins.map((t) => substitute(t, b)))
      for (const bind of ex.binds) {
        if (!b.has(bind.as)) b.set(bind.as, { k: 'var', v: name(bind.as) })
        const target = b.get(bind.as)!
        if (target.k === 'var') appended.push(`BIND(${substituteExpr(bind.e.text, b, merged, dollars, fresh)} AS ?${target.v})`)
      }
      accepted = true
      notes.push({ kind: 'migrated', message: 'a template rewritten' })
    }
    if (accepted) {
      const kept = template.filter((t) => !removed.has(key(t)))
      const text = writeTriples([...kept, ...added], merged, dollars)
      const open = full.indexOf(q.templateText!, q.select.at)
      edits.push({ at: open, end: open + q.templateText!.length, text: `\n  ${text}\n` })
      if (appended.length) edits.push({ at: q.select.where.end - 1, end: q.select.where.end - 1, text: `\n  ${appended.join('\n  ')}\n` })
    } else if (template.some((t) => deletedPredicates.includes(predicateIri(t) ?? ''))) {
      const guards = whereTriples.filter((t) => !write.del.some((d) => key(d) === key(t)))
      if (guards.length && match(graph, write.del).some((sol) => write.del.map((t) => substitute(t, sol)).every((t) => inTemplate.has(key(t)))))
        notes.push({ kind: 'review', message: "a template writes what this migration moves, but the query doesn't state the class it applies to" })
      else if (!notes.some((n) => n.kind === 'review')) notes.push({ kind: 'review', message: 'a template writes part of what this migration moves; the rest may come from elsewhere' })
    }
  }

  // Reads: a pattern of the old shape asks the new one.
  const oldOp = read
  if (oldOp) {
    const old = oldOp.ins
    const replacement = groupTriples(oldOp.where)
    const ex = extras(oldOp.where)
    // The conditions under which the old shape moves (a class, say) are stated on the writing side.
    const align = match(old.map(frozenTriple), write.del)[0]
    const guards = align ? groupTriples(write.where).filter((t) => !write.del.some((d) => key(d) === key(t))).map((t) => substitute(t, align)) : []
    const pattern = [...old, ...guards]
    const context = [...certain, ...holder].map(frozenTriple)
    walkBlocks(q.select.where, (block) => {
      const blockKeys = new Set(block.triples.map(key))
      const holderKeys = new Set(holder.map(key))
      const graph = [...new Set([...block.triples.map(frozenTriple), ...context])]
      const seen = new Set<string>()
      const taken = new Set<string>()
      const add: Triple[] = []
      const gone = new Set<string>()
      let union: string | undefined
      let done = false
      for (const sol of match(graph, pattern)) {
        const matched = old.map((t) => substitute(t, sol))
        const id = matched.map(key).sort().join('|')
        if (seen.has(id)) continue
        seen.add(id)
        const inBlock = (t: Triple) => blockKeys.has(key(t)) || holderKeys.has(key(t))
        // A match made of the holder's class alone is the rule's, and is settled once, below.
        if (!matched.some((t) => blockKeys.has(key(t)))) continue
        if (!matched.every(inBlock)) {
          if (matched.some((t) => blockKeys.has(key(t)))) notes.push({ kind: 'review', message: 'a pattern reads part of what this migration moves' })
          continue
        }
        if (matched.some((t) => taken.has(key(t)))) continue
        const b: Binding = new Map(sol)
        const fresh = new Map<string, string>()
        const name = (v: string) => {
          let f = fresh.get(v)
          if (!f) fresh.set(v, (f = freshName(v, used)))
          return f
        }
        let valuesRow: string | undefined
        let skip = false
        if (ex.values.length) {
          const v = ex.values[0]!
          const col = v.vars.findIndex((x) => b.has(x))
          if (col < 0 || v.vars.length !== 2) {
            notes.push({ kind: 'review', message: 'a VALUES this tool cannot apply' })
            continue
          }
          const known = b.get(v.vars[col]!)!
          const other = v.vars[1 - col]!
          if (known.k === 'var') {
            b.set(other, { k: 'var', v: name(other) })
            const header = `(${v.vars.map((x) => writeNode(b.get(x)!, merged, dollars)).join(' ')})`
            const rows = v.rows.map((r) => `(${r.map((x) => (x ? writeNode(x, merged, dollars) : 'UNDEF')).join(' ')})`).join(' ')
            valuesRow = `VALUES ${header} { ${rows} }`
          } else {
            const row = v.rows.find((r) => r[col] && nodeKey(r[col]!) === nodeKey(known))
            if (!row) skip = true
            else b.set(other, row[1 - col]!)
          }
        }
        if (skip) continue
        for (const t of replacement) for (const n of [t.s, t.o]) if (n.k === 'var' && !b.has(n.v)) b.set(n.v, { k: 'var', v: name(n.v) })
        for (const t of matched) taken.add(key(t))
        const emitted = replacement.map((t) => substitute(t, b))
        for (const t of matched) if (blockKeys.has(key(t))) gone.add(key(t))
        // A rule's own class: the holder moves with the query.
        for (const t of matched) {
          if (blockKeys.has(key(t)) || !holderKeys.has(key(t))) continue
          const to = emitted.find((e) => predicateIri(e) === RDF_TYPE && nodeKey(e.s) === nodeKey(t.s))
          if (t.o.k === 'iri' && to?.o.k === 'iri') holderMoves.set(t.o.v, to.o.v)
        }
        const toWrite = emitted.filter((e) => !(predicateIri(e) === RDF_TYPE && holderKeys.has(key({ s: e.s, p: { k: 'link', iri: RDF_TYPE }, o: matched.find((m) => predicateIri(m) === RDF_TYPE && !blockKeys.has(key(m)))?.o ?? e.o } as Triple)) && !matched.some((m) => predicateIri(m) === RDF_TYPE && blockKeys.has(key(m)))))
        if (valuesRow) {
          const oldText = writeTriples(matched, merged, dollars)
          union = `{ ${writeTriples(toWrite, merged, dollars)} ${valuesRow} } UNION { ${oldText} }`
          markComposed()
        } else {
          add.push(...toWrite)
          // A BIND is only needed for what the rest of the query still reads: going back, the node a mint made is not.
          const outside = varsIn(full.slice(offset, block.at) + full.slice(block.end))
          const around = block.triples.filter((t) => !matched.some((m) => key(m) === key(t))).concat(toWrite)
          const read = new Set(around.flatMap((t) => [t.s, t.o].flatMap((n) => (n.k === 'var' ? [n.v] : []))))
          for (const bind of ex.binds) {
            const target = b.get(bind.as)
            if (target?.k === 'var' && (outside.has(target.v) || read.has(target.v))) add.push({ s: { k: 'var', v: '__bind' }, p: { k: 'link', iri: '' }, o: { k: 'lit', value: `BIND(${substituteExpr(bind.e.text, b, merged, dollars, fresh)} AS ${writeNode(target, merged, dollars)})` } } as Triple)
          }
        }
        done = true
        notes.push({ kind: 'migrated', message: 'a pattern rewritten' })
      }
      if (!done) return
      const remaining = block.triples.filter((t) => !gone.has(key(t)))
      const plain = add.filter((t) => (t.s as { v?: string }).v !== '__bind')
      const binds = add.filter((t) => (t.s as { v?: string }).v === '__bind').map((t) => (t.o as { value: string }).value)
      const parts = [remaining.length || plain.length ? writeTriples([...remaining, ...plain], merged, dollars) : '', union ?? '', ...binds].filter(Boolean)
      edits.push({ at: block.at, end: block.end, text: parts.join('\n  ') })
    })
    // Patterns the holder alone satisfied: the discriminator goes into the WHERE.
    if (holder.length && !holderMoves.size) {
      for (const sol of match(context, pattern)) {
        const matched = old.map((t) => substitute(t, sol))
        if (!matched.every((t) => holder.some((h) => key(h) === key(t)))) continue
        const b: Binding = new Map(sol)
        const emitted = replacement.map((t) => substitute(t, b))
        const extra = emitted.filter((e) => predicateIri(e) !== RDF_TYPE)
        for (const t of matched) {
          const to = emitted.find((e) => predicateIri(e) === RDF_TYPE && nodeKey(e.s) === nodeKey(t.s))
          if (t.o.k === 'iri' && to?.o.k === 'iri') holderMoves.set(t.o.v, to.o.v)
        }
        if (extra.length) edits.push({ at: q.select.where.at + 1, end: q.select.where.at + 1, text: `\n  ${writeTriples(extra, merged, dollars)}` })
        notes.push({ kind: 'migrated', message: "a rule's class moved, its query narrowed" })
        break
      }
    }
  } else if (whole.some((t) => deletedPredicates.includes(predicateIri(t) ?? ''))) {
    notes.push({ kind: 'review', message: 'a pattern reads what this migration moves, and it has no way back to read through' })
  }

  if (!edits.length) return undefined
  edits.sort((a, b) => b.at - a.at)
  let text = full
  for (const e of edits) text = text.slice(0, e.at) + e.text + text.slice(e.end)
  let result = restoreDollars(text.slice(offset), dollars)
  result = removeDeadBinds(result, head, q)
  return result
}

function restoreDollars(text: string, dollars: Set<string>): string {
  return lex(text)
    .map((t) => (t.k === 'var' && dollars.has(t.text.slice(1)) ? '$' + t.text.slice(1) : t.text))
    .join('')
}

/** A BIND whose variable nothing reads any more, left by a template that stopped naming it. */
function removeDeadBinds(body: string, head: string, before: Query): string {
  const candidates = new Set<string>()
  const was = new Set((before.template ?? []).flatMap((t) => [t.s, t.o]).flatMap((n) => (n.k === 'var' ? [n.v] : [])))
  for (const v of was) candidates.add(v)
  const toks = lex(body).filter((t) => t.k === 'var')
  const count = (v: string) => toks.filter((t) => t.text.slice(1) === v).length
  const full = head + body.replace(/\$([A-Za-z_]\w*)/g, '?$1')
  const q = parseQuery(full)
  const remove = q.select.where.items.filter((i): i is Extract<Item, { k: 'bind' }> => i.k === 'bind' && candidates.has(i.as) && count(i.as) === 1)
  if (!remove.length) return body
  let out = body
  for (const b of remove.sort((x, y) => y.at - x.at)) {
    const at = b.at - head.length
    let start = at
    while (start > 0 && (out[start - 1] === ' ' || out[start - 1] === '\n')) start--
    out = out.slice(0, start) + out.slice(b.end - head.length)
  }
  return out
}
