// Candidates for generalization in Semblance's ontology: things declared for one component (or
// written into one example) that look like they belong to a layer or a shared vocabulary.
//
//   npx tsx .agents/skills/generalize-review/scripts/candidates.ts [--demo] [focus ...]
//
// focus: prefixed names (c:Badge, pos:, val:Layer) or IRIs; only findings that mention one of them
// are printed. --demo also loads the site (demo/app.ttl, demo/gallery/*.ttl), so per-example
// workarounds are found too. Prints Markdown. Findings are leads, not verdicts: read each one.

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadStore } from '../../../../src/node/load.ts'
import { NS, SPARQL_PREFIXES } from '../../../../src/ns.ts'
import { compactIri } from '../../../../src/prefixes.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const args = process.argv.slice(2)
const demo = args.includes('--demo')
const focus = args.filter((a) => !a.startsWith('--'))

const graphs: string[] = []
if (demo) {
  graphs.push(readFileSync(root + 'demo/app.ttl', 'utf8'))
  for (const f of readdirSync(root + 'demo/gallery').filter((f) => f.endsWith('.ttl'))) graphs.push(readFileSync(root + 'demo/gallery/' + f, 'utf8'))
}
const store = loadStore('oxigraph', ...graphs)
const prefixes: Record<string, string> = { ...NS, ui: 'https://semblance.dev/demo#' }
const short = (v: string) => (/^https?:|^urn:/.test(v) ? compactIri(v, prefixes) : v)
const expand = (t: string) => {
  const m = /^([a-z0-9]*):(.*)$/i.exec(t)
  return m && prefixes[m[1]!] !== undefined ? prefixes[m[1]!] + m[2] : t
}
const wanted = focus.map(expand)
const relevant = (values: string[]) => !wanted.length || values.some((v) => wanted.some((w) => v === w || v.startsWith(w)))

function select(query: string): Record<string, string>[] {
  return store.select(SPARQL_PREFIXES + '\n' + query, [store.factory.defaultGraph()]).map((row) => Object.fromEntries([...row].map(([k, t]) => [k, t.value])))
}

function section(title: string, why: string, rows: Record<string, string>[], cols: string[]) {
  const shown = rows.filter((r) => relevant(Object.values(r)))
  console.log(`\n## ${title}\n\n${why}\n`)
  if (!shown.length) return console.log('_None._')
  console.log(`| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|`)
  for (const r of shown.slice(0, 60)) console.log(`| ${cols.map((c) => short(r[c] ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 140)).join(' | ')} |`)
  if (shown.length > 60) console.log(`\n…and ${shown.length - 60} more.`)
}

console.log(`# Generalization candidates${focus.length ? ' for ' + focus.join(', ') : ''}${demo ? ' (with the site)' : ''}`)

// 1. A property declared for one class but used on instances of other classes.
section(
  'Properties used beyond their declared class',
  'A property whose rdfs:domain is one component class, set on instances that are not of it: the concept is wider than the class (move it to a shared vocabulary or a layer, and widen or drop the domain).',
  select(`
SELECT ?property ?domain (COUNT(DISTINCT ?other) AS ?otherClasses) (SAMPLE(?other) AS ?example)
WHERE {
  ?property rdfs:domain ?domain . ?domain rdfs:subClassOf+ sem:Component .
  ?s ?property ?o ; a ?other . ?other rdfs:subClassOf+ sem:Component .
  FILTER NOT EXISTS { ?s a/rdfs:subClassOf* ?domain }
}
GROUP BY ?property ?domain ORDER BY DESC(?otherClasses) ?property`),
  ['property', 'domain', 'otherClasses', 'example'],
)

// 2. The same style declared for several classes separately.
section(
  'The same declaration repeated across component classes',
  'One CSS property and value declared by style rules of three or more classes (same part): a general rule, a hookable property or a layer would say it once.',
  select(`
SELECT ?property ?value (COUNT(DISTINCT ?class) AS ?classes) (GROUP_CONCAT(DISTINCT STRAFTER(STR(?class), "#"); separator=", ") AS ?which)
WHERE {
  ?rule a sty:StyleRule ; sty:appliesTo ?class ; sty:declares ?d .
  FILTER NOT EXISTS { ?rule sty:part ?part }
  FILTER NOT EXISTS { ?rule sty:when ?when }
  FILTER NOT EXISTS { ?rule sty:state ?state }
  ?d sty:property ?property .
  { ?d sty:raw ?value } UNION { ?d sty:token ?value }
  FILTER(?property NOT IN ("display", "background", "color", "padding", "border", "border-radius", "font", "gap", "font-size", "font-weight", "box-shadow", "position"))
}
GROUP BY ?property ?value HAVING (COUNT(DISTINCT ?class) >= 3) ORDER BY DESC(?classes)`),
  ['property', 'value', 'classes', 'which'],
)

// 3. Function-only renderings and their reasons: a reason shared by several is a missing building block.
section(
  'Function-only renderings, by reason',
  'A rendering without SPARQL, with the reason it gives. Reasons that recur (the viewer\'s locale, tokenizing, a query held in data, a walk over a predicate named in data) point at a missing building block every one of them would use.',
  select(`
SELECT ?rendering ?targets ?why WHERE { ?rendering sem:functionOnly ?why . OPTIONAL { ?rendering sem:targets ?targets } }
ORDER BY ?why`),
  ['rendering', 'targets', 'why'],
)

// 4. Properties several unrelated component classes each declare under their own name.
section(
  'Look-alike properties',
  'Properties of different classes with the same local name: possibly one concept declared twice (merge into one shared property).',
  select(`
SELECT ?name (COUNT(DISTINCT ?property) AS ?declarations) (GROUP_CONCAT(DISTINCT STR(?property); separator=" ") AS ?which)
WHERE {
  ?property rdfs:domain ?domain . ?domain rdfs:subClassOf+ sem:Component .
  BIND(REPLACE(STR(?property), "^.*[#/]", "") AS ?name)
}
GROUP BY ?name HAVING (COUNT(DISTINCT ?property) > 1) ORDER BY DESC(?declarations)`),
  ['name', 'declarations', 'which'],
)

// 5. Reactions repeated for several classes.
section(
  'Reactions repeated across classes',
  'Reactions of different source classes that handle the same event with the same function: a capability class (a mixin like c:Draggable) or a layer would hold one.',
  select(`
SELECT ?when ?fn (COUNT(DISTINCT ?class) AS ?classes) (GROUP_CONCAT(DISTINCT STRAFTER(STR(?class), "#"); separator=", ") AS ?which)
WHERE { ?r a beh:Reaction ; beh:when ?when ; beh:sourceClass ?class ; sem:function ?fn . }
GROUP BY ?when ?fn HAVING (COUNT(DISTINCT ?class) > 1) ORDER BY DESC(?classes)`),
  ['when', 'fn', 'classes', 'which'],
)

if (demo) {
  // 6. Vocabulary the site invents for itself that the framework may want.
  section(
    'Layouts, classes and properties the site declares for itself',
    'pos:Layout values, classes and properties in the demo\'s own namespace: a workaround one example needed may be what every app needs (move it into the framework).',
    select(`
SELECT ?term ?kind ?comment
WHERE {
  { ?term a pos:Layout BIND("layout" AS ?kind) } UNION { ?term a owl:Class BIND("class" AS ?kind) }
  UNION { ?term a owl:ObjectProperty BIND("property" AS ?kind) } UNION { ?term a owl:DatatypeProperty BIND("property" AS ?kind) }
  FILTER(STRSTARTS(STR(?term), "https://semblance.dev/demo"))
  OPTIONAL { ?term rdfs:comment ?comment }
}
ORDER BY ?kind ?term`),
    ['term', 'kind', 'comment'],
  )
}
