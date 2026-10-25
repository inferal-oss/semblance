// Overlap and duplication between Semblance components: rule bodies, style blocks, vocabularies,
// reactions and function twins that look like copies of each other.
//
//   npx tsx .agents/skills/component-overlap/scripts/overlap.ts [--demo] [--min=0.6] [--top=25] [focus ...]
//
// focus: prefixed names (c:TextField), slugs (text-field), file names (inputs.ttl, inputs.ts) or a
// prefix of them (c:Date); only findings that mention one are printed. --demo also reads the site
// (demo/app.ttl, demo/gallery/*.ttl). --min is the similarity threshold (Jaccard of 4-token
// shingles; 0..1), --top the rows per section. Prints Markdown. Findings are leads, not verdicts.
//
// It parses the Turtle itself (N3, file by file) rather than querying a store, so every finding
// says which file it is in and the whole run takes about a second.

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Parser, type Quad, type Term } from 'n3'
import { NS } from '../../../../src/ns.ts'
import { ONTOLOGY_FILES } from '../../../../src/ontology.ts'
import { compactIri } from '../../../../src/prefixes.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const args = process.argv.slice(2)
const demo = args.includes('--demo')
const option = (name: string, fallback: number) => Number(args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const MIN = option('min', 0.6)
const TOP = option('top', 25)
const focus = args.filter((a) => !a.startsWith('--'))

const prefixes: Record<string, string> = { ...NS, ui: 'https://semblance.dev/demo#' }
const short = (v: string) => (/^https?:|^urn:/.test(v) ? compactIri(v, prefixes) : v)
const expand = (t: string) => {
  const m = /^([a-z0-9]*):(.*)$/i.exec(t)
  return m && prefixes[m[1]!] !== undefined ? prefixes[m[1]!] + m[2] : t
}
const wanted = focus.flatMap((f) => [f, expand(f)])
const relevant = (values: string[]) => !focus.length || values.some((v) => wanted.some((w) => v.includes(w)))

// --- the graph, with the file each triple came from ---------------------------------------------

const files: [string, string][] = ONTOLOGY_FILES.map((f) => ['ontology/' + f, readFileSync(root + 'ontology/' + f, 'utf8')])
if (demo) {
  files.push(['demo/app.ttl', readFileSync(root + 'demo/app.ttl', 'utf8')])
  for (const f of readdirSync(root + 'demo/gallery').filter((f) => f.endsWith('.ttl'))) files.push(['demo/gallery/' + f, readFileSync(root + 'demo/gallery/' + f, 'utf8')])
}

const bySubject = new Map<string, Quad[]>()
const fileOf = new Map<string, string>()
const key = (t: Term) => (t.termType === 'BlankNode' ? '_:' + t.value : t.value)
for (const [file, text] of files) {
  const quads = new Parser({ blankNodePrefix: file.replace(/\W/g, '_') + '_' }).parse(text)
  for (const q of quads) {
    const s = key(q.subject)
    let list = bySubject.get(s)
    if (!list) bySubject.set(s, (list = []))
    list.push(q)
    if (!fileOf.has(s)) fileOf.set(s, file)
  }
}
const objects = (s: string, p: string) => (bySubject.get(s) ?? []).filter((q) => q.predicate.value === p).map((q) => q.object)
const one = (s: string, p: string) => objects(s, p)[0]
const subjectsOfType = (type: string) => [...bySubject.keys()].filter((s) => objects(s, NS.rdf + 'type').some((o) => o.value === type))
const local = (iri: string) => iri.replace(/^.*[#/]/, '')

// --- similarity ---------------------------------------------------------------------------------

const SHINGLE = 4

/** SPARQL with the variables, IRIs minted from $this, literals and whitespace normalized away. */
function sparqlTokens(q: string): string[] {
  const text = q
    .replace(/#[^\n"]*$/gm, '')
    // Minting an IRI from $this is in every rule (ground rule 4): one token, so it glues nothing together.
    .replace(/IRI\s*\(\s*CONCAT\s*\(\s*STR\s*\(\s*\$this\s*\)\s*,\s*"[^"]*"\s*\)\s*\)/g, ' MINT ')
    .replace(/"(?:[^"\\]|\\.)*"(@[a-z-]+|\^\^\S+)?/g, ' LIT ')
    .replace(/\?[A-Za-z_][\w]*/g, ' ?v ')
    .replace(/<[^>\s]*>/g, ' IRI ')
  return text.match(/\$this|\?v|LIT|IRI|MINT|[A-Za-z_][\w-]*:[\w-]*|[A-Za-z_]\w*|[{}().;,|*/+=!<>&-]+/g) ?? []
}

/** TypeScript with identifiers kept (they carry the meaning), strings and comments dropped. */
function tsTokens(code: string): string[] {
  const text = code
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .replace(/`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, ' S ')
  return text.match(/[A-Za-z_$][\w$]*|\d+|[{}()[\].;,?:=<>!&|+\-*/]+/g) ?? []
}

function shingles(tokens: string[]): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + SHINGLE <= tokens.length; i++) out.add(tokens.slice(i, i + SHINGLE).join(' '))
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  const [small, large] = a.size < b.size ? [a, b] : [b, a]
  let both = 0
  for (const x of small) if (large.has(x)) both++
  return both / (a.size + b.size - both)
}

/** How much of the smaller one is inside the larger one: a fragment copied into a bigger body. */
function containment(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  const [small, large] = a.size < b.size ? [a, b] : [b, a]
  let both = 0
  for (const x of small) if (large.has(x)) both++
  return both / small.size
}

interface Item {
  name: string
  owner: string
  file: string
  set: Set<string>
  size: number
  /** The normalized token sequence, for shared blocks. */
  tokens?: string[]
}

/** Pairs of items with different owners whose similarity is at least MIN, best first. */
function similarPairs(items: Item[], measure = jaccard, minSize = 12): [Item, Item, number][] {
  const big = items.filter((i) => i.size >= minSize)
  // An inverted index over shingles keeps this near-linear: only pairs sharing a shingle are compared.
  const index = new Map<string, number[]>()
  big.forEach((item, n) => {
    for (const s of item.set) {
      let list = index.get(s)
      if (!list) index.set(s, (list = []))
      list.push(n)
    }
  })
  const seen = new Set<number>()
  const out: [Item, Item, number][] = []
  for (const list of index.values()) {
    if (list.length > 40) continue // boilerplate every body has (BIND(IRI(CONCAT(STR($this)...)
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const [i, j] = [list[x]!, list[y]!]
        const pair = i * big.length + j
        if (seen.has(pair)) continue
        seen.add(pair)
        const [a, b] = [big[i]!, big[j]!]
        if (a.owner === b.owner) continue
        const score = measure(a.set, b.set)
        if (score >= MIN) out.push([a, b, score])
      }
  }
  return out.sort((p, q) => q[2] - p[2])
}

function table(title: string, why: string, cols: string[], rows: string[][]) {
  const shown = rows.filter((r) => relevant(r))
  console.log(`\n## ${title}\n\n${why}\n`)
  if (!shown.length) return console.log('_None._')
  console.log(`| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|`)
  for (const r of shown.slice(0, TOP)) console.log(`| ${r.map((c) => c.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 160)).join(' | ')} |`)
  if (shown.length > TOP) console.log(`\n…and ${shown.length - TOP} more (--top=${shown.length}).`)
}

const pct = (x: number) => `${Math.round(x * 100)}%`
const files2 = (a: Item, b: Item) => (a.file === b.file ? a.file : `${a.file}, ${b.file}`)

/** Groups of items that are (nearly) the same text: one row per group instead of every pair. */
const SAME = 0.95
function clusters(pairs: [Item, Item, number][]): Item[][] {
  const parent = new Map<Item, Item>()
  const find = (i: Item): Item => {
    const p = parent.get(i) ?? i
    if (p === i) return i
    const r = find(p)
    parent.set(i, r)
    return r
  }
  for (const [a, b, x] of pairs) if (x >= SAME) parent.set(find(a), find(b))
  const groups = new Map<Item, Item[]>()
  for (const [a, b, x] of pairs)
    if (x >= SAME)
      for (const i of [a, b]) {
        const r = find(i)
        let list = groups.get(r)
        if (!list) groups.set(r, (list = []))
        if (!list.includes(i)) list.push(i)
      }
  return [...groups.values()].sort((a, b) => b.length - a.length)
}

/** A section of near-copies (clusters) and one of similar pairs below that. */
function similarity(title: string, why: string, what: string, pairs: [Item, Item, number][]) {
  table(
    `${title}: copies`,
    `${why} These are copies (${pct(SAME)} or more alike), grouped.`,
    ['copies', what, 'owners', 'files'],
    clusters(pairs).map((g) => [String(g.length), g.map((i) => i.name).join(' · '), [...new Set(g.map((i) => i.owner))].join(' · '), [...new Set(g.map((i) => i.file))].join(', ')]),
  )
  table(
    `${title}: similar`,
    'Alike but not copies: shared structure with differences worth reading side by side.',
    [what, 'owner', what, 'owner', 'similar', 'files'],
    pairs.filter(([, , x]) => x < SAME).map(([a, b, x]) => [a.name, a.owner, b.name, b.owner, pct(x), files2(a, b)]),
  )
}

console.log(`# Component overlap${focus.length ? ' for ' + focus.join(', ') : ''}${demo ? ' (with the site)' : ''}`)
console.log(`\nThreshold ${pct(MIN)} (\`--min\`), ${SHINGLE}-token shingles.`)

/**
 * Partial duplication: blocks of at least `width` consecutive tokens that occur in two or more
 * items, however different the rest of them is. Each block is extended to its longest run, and
 * blocks found in the same places are reported once. These are the targets for extracting a
 * fragment: a building block, a shared rendering, a helper. `inside` marks a block repeated
 * within one owner (a component's screen and text rules, two branches of one function).
 */
function sharedBlocks(title: string, why: string, items: Item[], width: number) {
  const windows = new Map<string, [number, number][]>()
  items.forEach((item, n) => {
    const t = item.tokens ?? []
    for (let i = 0; i + width <= t.length; i++) {
      const k = t.slice(i, i + width).join(' ')
      let list = windows.get(k)
      if (!list) windows.set(k, (list = []))
      list.push([n, i])
    }
  })
  // A window shared by too many places is the framework's grammar, not a copy.
  const shared = new Map<string, [number, number][]>()
  for (const [k, at] of windows) if (new Set(at.map(([n]) => n)).size >= 2 && at.length <= 30) shared.set(k, at)
  const blocks = new Map<string, { text: string; places: Set<number>; length: number }>()
  items.forEach((item, n) => {
    const t = item.tokens ?? []
    let i = 0
    while (i + width <= t.length) {
      const at = shared.get(t.slice(i, i + width).join(' '))
      if (!at) {
        i++
        continue
      }
      // Extend while some of the same partners continue; the block is where all of them share it.
      let partners = new Set(at.map(([m]) => m).filter((m) => m !== n))
      let j = i + 1
      while (j + width <= t.length) {
        const next = shared.get(t.slice(j, j + width).join(' '))
        const still = new Set((next ?? []).map(([m]) => m).filter((m) => partners.has(m)))
        if (!still.size) break
        partners = still
        j++
      }
      const places = new Set([n, ...partners])
      const text = t.slice(i, j + width - 1).join(' ')
      const prev = blocks.get(text)
      if (prev) for (const p of places) prev.places.add(p)
      else blocks.set(text, { text, places, length: j + width - 1 - i })
      i = j + width - 1
    }
  })
  // Drop a block contained in a longer block found in the same places.
  const list = [...blocks.values()].sort((a, b) => b.length - a.length)
  const kept: typeof list = []
  for (const b of list) if (!kept.some((k) => k.text.includes(b.text) && [...b.places].every((p) => k.places.has(p)))) kept.push(b)
  // A block must say something: two distinct names (terms, identifiers), not a run of BIND(IF(…)).
  const meaningful = (text: string) => new Set(text.match(/\b[a-z][\w]*:[\w-]+|\b[a-z]\w{3,}\b/gi)?.filter((w) => !/^(BIND|BOUND|OPTIONAL|FILTER|CONCAT|COALESCE|EXISTS|STR|MINT|UNION|SELECT|WHERE|const|return|undefined)$/i.test(w))).size >= 2
  const score = (b: { length: number; where: Item[] }) => b.length * Math.log2(b.where.length)
  const rows = kept
    .filter((b) => meaningful(b.text))
    .map((b) => ({ ...b, where: [...b.places].map((n) => items[n]!) }))
    .sort((a, b) => score(b) - score(a))
    .map((b) => {
      const owners = [...new Set(b.where.map((i) => i.owner))]
      return [
        String(b.length),
        String(b.where.length),
        owners.length < b.where.length ? 'yes' : '',
        b.text.length > 150 ? b.text.slice(0, 147) + '…' : b.text,
        b.where.map((i) => i.name).join(' · '),
        [...new Set(b.where.map((i) => i.file))].join(', '),
      ]
    })
  table(title, why, ['tokens', 'places', 'inside', 'block', 'where', 'files'], rows)
}

// --- 1. SPARQL rendering rules ------------------------------------------------------------------

const targetsOf = (rendering: string) => objects(rendering, NS.sem + 'targets').map((t) => short(t.value))
const rules: Item[] = []
for (const s of subjectsOfType(NS.sem + 'Rule')) {
  const body = one(s, NS.sem + 'construct')
  const rendering = one(s, NS.sem + 'implements')
  if (!body || !rendering) continue
  const tokens = sparqlTokens(body.value)
  const set = shingles(tokens)
  const owner = targetsOf(rendering.value).join(', ') || short(rendering.value)
  rules.push({ name: short(s), owner, file: fileOf.get(s)!, set, size: set.size, tokens })
}

similarity(
  'Rendering rules',
  'SPARQL rule bodies of different components, normalized (variables, literals and IRIs erased) and compared as shingle sets: the same rendering written twice (one component with options, a subclass, or a shared building block).',
  'rule',
  similarPairs(rules),
)

sharedBlocks(
  'Blocks shared by rendering rules',
  'Partial duplication: a run of 24 or more normalized SPARQL tokens that occurs in two or more rules (of different components, or twice inside one: \'inside\'), however different the rest is. Targets for extracting a fragment into a building block, a shared rendering or a layer. Longest and most repeated first.',
  rules,
  24,
)

// Fragments: a block of shingles that recurs in many rules (the label/help/error trio, ARIA wiring).
{
  const runs = new Map<string, Set<string>>()
  for (const r of rules) {
    const tokens = [...r.set]
    for (const t of tokens) {
      if (!/\b(?:c|a11y|l10n|nav|val|dep):/.test(t)) continue
      let owners = runs.get(t)
      if (!owners) runs.set(t, (owners = new Set()))
      owners.add(r.owner)
    }
  }
  // Collapse shingles shared by the same set of components into one fragment.
  const fragments = new Map<string, string[]>()
  for (const [s, owners] of runs) {
    if (owners.size < 4) continue
    const k = [...owners].sort().join(', ')
    let list = fragments.get(k)
    if (!list) fragments.set(k, (list = []))
    list.push(s)
  }
  const rows = [...fragments]
    .filter(([, shs]) => shs.length >= 3)
    .map(([owners, shs]) => ({ owners, shs, count: owners.split(', ').length }))
    .sort((a, b) => b.count * b.shs.length - a.count * a.shs.length)
    .map(({ owners, shs, count }) => [String(count), String(shs.length), shs.slice(0, 3).join(' · '), owners])
  table(
    'Fragments repeated across rules',
    'Runs of normalized SPARQL (mentioning component, a11y, l10n, nav, val or dep vocabulary) that occur in the rules of four or more components, grouped by the components that share them. A long shared run is a fragment to name once: a building block, a shared rendering, a layer.',
    ['components', 'shingles', 'sample', 'which'],
    rows,
  )
}

// --- 2. reactions -------------------------------------------------------------------------------

const reactions: Item[] = []
for (const s of subjectsOfType(NS.beh + 'Reaction')) {
  const parts = [one(s, NS.beh + 'deletes'), one(s, NS.beh + 'inserts'), one(s, NS.beh + 'where')].filter(Boolean).map((t) => t!.value)
  if (!parts.length) continue
  const when = one(s, NS.beh + 'when')
  const set = shingles([short(when?.value ?? ''), ...parts.flatMap(sparqlTokens)])
  const owner = objects(s, NS.beh + 'sourceClass').map((t) => short(t.value)).join(', ') || '?'
  reactions.push({ name: short(s), owner, file: fileOf.get(s)!, set, size: set.size })
}
similarity(
  'Reactions',
  'Reactions of different source classes whose event and deletes/inserts are alike after normalization: a mixin class with one reaction, or one component with options.',
  'reaction',
  similarPairs(reactions, jaccard, 8),
)

// --- 3. styles ----------------------------------------------------------------------------------

interface StyleRule {
  subject: string
  file: string
  decls: string[]
}
const styleRules: StyleRule[] = []
for (const s of subjectsOfType(NS.sty + 'StyleRule')) {
  const decls = objects(s, NS.sty + 'declares')
    .map((d) => {
      const p = one(key(d), NS.sty + 'property')?.value
      const v = one(key(d), NS.sty + 'raw') ?? one(key(d), NS.sty + 'token')
      return p && v ? `${p}: ${v.termType === 'NamedNode' ? short(v.value) : v.value}` : undefined
    })
    .filter((d): d is string => !!d)
    .sort()
  if (!decls.length) continue
  const applies = objects(s, NS.sty + 'appliesTo').map((t) => one(t.value, NS.sem + 'slug')?.value ?? short(t.value))
  const when = objects(s, NS.sty + 'when').map((t) => short(t.value))
  const part = one(s, NS.sty + 'part')?.value
  const state = one(s, NS.sty + 'state')?.value
  const width = objects(s, NS.sty + 'atWidth').map((t) => short(t.value))
  // The subject a person would recognize: the component (or the [data-sem-c=…] a theme rule names).
  const named = part ? [...part.matchAll(/data-sem-c=["']?([\w-]+)/g)].map((m) => m[1]!) : []
  const who = [...new Set([...applies, ...named])].join('+') || '*'
  const context = [when.length ? `when ${when.join('+')}` : '', state ?? '', width.length ? `at ${width.join('+')}` : ''].filter(Boolean).join(' ')
  const slot = part ? part.replace(/:not\(:where\(.*$/, '').replace(/\[data-sem-c=["']?[\w-]+["']?\]/g, '').trim() : ''
  styleRules.push({ subject: `${who}${slot ? ' ' + slot.slice(0, 60) : ''}${context ? ` (${context})` : ''}`, file: fileOf.get(s)!, decls })
}

// Exactly the same block (two or more declarations) under different subjects.
{
  const blocks = new Map<string, StyleRule[]>()
  for (const r of styleRules) {
    if (r.decls.length < 2) continue
    const k = r.decls.join('; ')
    let list = blocks.get(k)
    if (!list) blocks.set(k, (list = []))
    list.push(r)
  }
  const rows = [...blocks]
    .map(([decls, rs]) => ({ decls, rs, subjects: [...new Set(rs.map((r) => r.subject))] }))
    .filter((b) => b.subjects.length >= 2)
    .sort((a, b) => b.subjects.length * b.rs[0]!.decls.length - a.subjects.length * a.rs[0]!.decls.length)
    .map((b) => [String(b.subjects.length), decls(b.decls), b.subjects.join(' · '), [...new Set(b.rs.map((r) => r.file.replace('ontology/theme/', '')))].join(', ')])
  function decls(d: string) {
    return d.length > 120 ? d.slice(0, 117) + '…' : d
  }
  table(
    'Identical style blocks',
    'The same set of declarations (two or more) in style rules for different components, parts or themes. One shared rule (a family of classes, a hook value, a theme variable) would say it once and keep it from drifting.',
    ['subjects', 'declarations', 'where', 'files'],
    rows,
  )
}

// Near-identical blocks: different subjects whose declaration sets mostly coincide (the drift).
{
  const items: Item[] = styleRules
    .filter((r) => r.decls.length >= 3)
    .map((r) => ({ name: r.subject, owner: r.subject, file: r.file.replace('ontology/theme/', ''), set: new Set(r.decls), size: r.decls.length }))
  const pairs = similarPairs(items, jaccard, 3).filter(([a, b, x]) => x < 1 && a.owner !== b.owner)
  table(
    'Near-identical style blocks',
    'Style rules of different subjects that share most of their declarations but not all: copies that have drifted apart (a padding here, a radius there). Decide which is right and make it one rule.',
    ['rule', 'rule', 'similar', 'only in first', 'only in second', 'files'],
    pairs.map(([a, b, x]) => [
      a.name,
      b.name,
      pct(x),
      [...a.set].filter((d) => !b.set.has(d)).join('; '),
      [...b.set].filter((d) => !a.set.has(d)).join('; '),
      a.file === b.file ? a.file : `${a.file}, ${b.file}`,
    ]),
  )
}

// --- 4. vocabularies ----------------------------------------------------------------------------

{
  // What a component class reads: the c: terms its rendering rules and reactions mention with $this.
  const reads = new Map<string, Set<string>>()
  const add = (owner: string, body: string) => {
    let set = reads.get(owner)
    if (!set) reads.set(owner, (set = new Set()))
    for (const m of body.matchAll(/\$this\s+((?:[a-z0-9]+:[\w-]+\s*\/?\s*)+)/g)) for (const t of m[1]!.split(/[\s/]+/)) if (t.startsWith('c:') || t.startsWith('a11y:') || t.startsWith('nav:')) set.add(t)
  }
  for (const s of subjectsOfType(NS.sem + 'Rule')) {
    const body = one(s, NS.sem + 'construct')
    const rendering = one(s, NS.sem + 'implements')
    if (body && rendering) for (const t of targetsOf(rendering.value)) add(t, body.value)
  }
  for (const s of subjectsOfType(NS.beh + 'Reaction')) {
    const body = [one(s, NS.beh + 'deletes'), one(s, NS.beh + 'inserts')].filter(Boolean).map((t) => t!.value).join('\n')
    for (const c of objects(s, NS.beh + 'sourceClass')) add(short(c.value), body)
  }
  for (const s of bySubject.keys()) {
    const domain = one(s, NS.rdfs + 'domain')
    if (domain && domain.value.startsWith(NS.c)) {
      let set = reads.get(short(domain.value))
      if (!set) reads.set(short(domain.value), (set = new Set()))
      set.add(short(s))
    }
  }
  // Every component reads c:label; weigh terms by rarity so shared basics do not dominate.
  const counts = new Map<string, number>()
  for (const set of reads.values()) for (const t of set) counts.set(t, (counts.get(t) ?? 0) + 1)
  const n = reads.size
  const weight = (t: string) => Math.log(n / (counts.get(t) ?? 1))
  const classes = [...reads].filter(([, s]) => s.size >= 3)
  const rows: [string, string, number, string][] = []
  for (let i = 0; i < classes.length; i++)
    for (let j = i + 1; j < classes.length; j++) {
      const [[a, sa], [b, sb]] = [classes[i]!, classes[j]!]
      let both = 0
      let either = 0
      const shared: string[] = []
      for (const t of new Set([...sa, ...sb])) {
        const w = weight(t)
        either += w
        if (sa.has(t) && sb.has(t)) {
          both += w
          shared.push(t)
        }
      }
      const score = either ? both / either : 0
      if (score >= MIN * 0.75 && shared.length >= 3) rows.push([a, b, score, shared.join(' ')])
    }
  rows.sort((p, q) => q[2] - p[2])
  table(
    'Components with overlapping vocabularies',
    'Pairs of component classes that read most of the same properties (in their renderings, their reactions, or by rdfs:domain), weighted so that rare terms count more than c:label. Candidates for one component with options, a subclass, or a shared part.',
    ['class', 'class', 'overlap', 'shared terms'],
    rows.map(([a, b, x, t]) => [a, b, pct(x), t]),
  )
}

// --- 5. function twins --------------------------------------------------------------------------

{
  const items: Item[] = []
  const dir = root + 'src/components/'
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const lines = readFileSync(dir + f, 'utf8').split('\n')
    // A top-level declaration runs from its first line to the next line that is just "}" (or "})").
    for (let i = 0; i < lines.length; i++) {
      const m = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*(?::[^=]+)?=)/.exec(lines[i]!)
      if (!m) continue
      let end = i
      if (!/[{(]\s*$/.test(lines[i]!)) continue
      while (end + 1 < lines.length && !/^[})]/.test(lines[end + 1]!)) end++
      const body = lines.slice(i, end + 2).join('\n')
      const tokens = tsTokens(body)
      const set = shingles(tokens)
      items.push({ name: `${f}:${i + 1} ${m[1] ?? m[2]}`, owner: `${f}#${m[1] ?? m[2]}`, file: 'src/components/' + f, set, size: set.size, tokens })
      i = end + 1
    }
  }
  similarity(
    'Function twins and helpers',
    'Top-level functions in src/components/ whose token shingles coincide: the same rendering or helper written twice. Shared code belongs in src/components/util.ts (or a layer\'s module), and its SPARQL twin probably repeats too.',
    'function',
    similarPairs(items, jaccard, 30),
  )
  // A smaller function contained in a larger one: an inlined copy of a helper.
  sharedBlocks(
    'Blocks shared by functions',
    'Partial duplication in src/components/: a run of 40 or more tokens that occurs in two or more functions, however different the rest is. Targets for extracting a helper into util.ts (or the layer\'s module); the matching SPARQL rules probably share a block too.',
    items,
    40,
  )
  // Not a component's own screen and text twins, nor a registry of functions.
  const stem = (i: Item) => i.owner.replace(/(Screen|Text|Rendering)$/, '')
  const contained = similarPairs(items, containment, 30).filter(
    ([a, b, x]) => x >= Math.max(MIN, 0.8) && jaccard(a.set, b.set) < MIN && stem(a) !== stem(b) && !/#functions$/.test(a.owner + ' ' + b.owner),
  )
  table(
    'Helpers copied into other functions',
    'A function whose body is mostly contained in another function in a different place: a helper that was inlined instead of called.',
    ['function', 'function', 'contained'],
    contained.map(([a, b, x]) => (a.size < b.size ? [a.name, b.name, pct(x)] : [b.name, a.name, pct(x)])),
  )
}
