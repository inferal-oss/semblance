// Benchmark rows as RDF (SOSA observations), and judgements over them as SPARQL.
import { SPARQL_PREFIXES } from '../src/ns.ts'
import type { GraphStore } from '../src/store/types.ts'
import { CONFIGS, type Config, type Row } from './scenarios.ts'

export const PERF = 'https://semblance.dev/ns/perf#'
const PREFIXES = `PREFIX perf: <${PERF}>\nPREFIX sosa: <http://www.w3.org/ns/sosa/>\n`
const SEM = 'https://semblance.dev/ns/core#'

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
export const configIri = (id: string) => `${PERF}cfg-${slug(id)}`
const SCENARIOS: Record<string, string> = {
  'initial render': 'InitialRender',
  'toggle item': 'ToggleItem',
  'rename item': 'RenameItem',
  'reorder item': 'ReorderItem',
  'add item': 'AddItem',
  'type in field': 'TypeInField',
}
export const scenarioIri = (name: string) => PERF + (SCENARIOS[name] ?? slug(name))

const dec = (n: number) => `"${(Math.round(n * 10_000) / 10_000).toFixed(4)}"^^<http://www.w3.org/2001/XMLSchema#decimal>`
const str = (s: string) => JSON.stringify(s)

function describeConfig(c: Config, order: number): string {
  const store = { oxigraph: 'Oxigraph', hybrid: 'Hybrid', n3: 'N3' }[c.store]
  const rules = c.prefer === 'sparql' ? 'Sparql' : 'Function'
  const evaluation = c.prefer === 'sparql' ? (Number.isFinite(c.bulkThreshold) ? ' ; perf:evaluation perf:Bulk' : ' ; perf:evaluation perf:PerFocus') : ''
  return `<${configIri(c.id)}> a perf:Configuration ; rdfs:label ${str(c.id)} ; sem:order ${order} ; perf:store perf:${store} ; perf:rules perf:${rules}${evaluation} .`
}

/** The configurations measured, in display order. */
export function configurationsTurtle(configs: Config[] = CONFIGS): string {
  return [`@prefix perf: <${PERF}> .`, `@prefix sem: <${SEM}> .`, '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .', '', ...configs.map((c, i) => describeConfig(c, i + 1)), ''].join('\n')
}

/** Observations as Turtle: the run (perf:run) with its planned sizes, and one sosa:Observation per row. */
export function observationsTurtle(rows: Row[], configs: Config[] = CONFIGS, plannedSizes = [...new Set(rows.map((r) => r.size))]): string {
  const lines = [
    configurationsTurtle(configs),
    `@prefix sosa: <http://www.w3.org/ns/sosa/> .`,
    `perf:run a perf:Run${plannedSizes.length ? ' ; perf:plannedSize ' + plannedSizes.join(', ') : ''} .`,
    '',
  ]
  rows.forEach((r, i) => {
    const total = r.engineMs + (r.domMs ?? 0)
    lines.push(`perf:run perf:hasObservation perf:obs-${slug(r.env)}-${i} .`)
    lines.push(
      `perf:obs-${slug(r.env)}-${i} a sosa:Observation ; perf:environment ${str(r.env)} ;` +
        ` perf:configuration <${configIri(r.config)}> ; perf:scenario <${scenarioIri(r.scenario)}> ; perf:items ${r.size} ;` +
        ` perf:engineMs ${dec(r.engineMs)} ;${r.domMs !== undefined ? ` perf:domMs ${dec(r.domMs)} ;` : ''}` +
        ` perf:totalMs ${dec(total)} ; sosa:hasSimpleResult ${dec(total)} ; perf:ruleRuns ${dec(r.ruleRuns)} ; perf:derivedTriples ${r.derived} .`,
    )
  })
  return lines.join('\n') + '\n'
}

export interface Finding {
  judgement: string
  judgementLabel: string
  order: number
  verdict: 'good' | 'concern' | 'insight'
  items?: number
  text: string
}

export interface Judgement {
  iri: string
  label: string
  order: number
  query: string
}

/** The judgements declared in the perf ontology. */
export function judgements(store: GraphStore): Judgement[] {
  const f = store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const one = (s: string, p: string) => store.match(nn(s), nn(p), null)[0]?.object.value
  return store
    .match(null, nn('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), nn(PERF + 'Judgement'))
    .map((q) => ({
      iri: q.subject.value,
      label: one(q.subject.value, 'http://www.w3.org/2000/01/rdf-schema#label') ?? q.subject.value,
      order: Number(one(q.subject.value, SEM + 'order') ?? 99),
      query: (one(q.subject.value, SEM + 'construct') ?? '').trim(),
    }))
    .sort((a, b) => a.order - b.order)
}

/** Run every judgement's CONSTRUCT over the observations loaded in `store`. */
export function judge(store: GraphStore): { judgements: Judgement[]; findings: Finding[] } {
  const all = judgements(store)
  const findings: Finding[] = []
  for (const j of all) {
    const quads = store.construct(SPARQL_PREFIXES + '\n' + PREFIXES + j.query, [store.factory.defaultGraph()])
    const bySubject = new Map<string, Map<string, string>>()
    for (const q of quads) {
      const m = bySubject.get(q.subject.value) ?? new Map<string, string>()
      m.set(q.predicate.value, q.object.value)
      bySubject.set(q.subject.value, m)
    }
    for (const m of bySubject.values()) {
      const items = Number(m.get(SEM + 'sortKey'))
      findings.push({
        judgement: j.iri,
        judgementLabel: j.label,
        order: j.order,
        verdict: (m.get(SEM + 'verdict') ?? PERF + 'Insight').slice(PERF.length).toLowerCase() as Finding['verdict'],
        items: Number.isFinite(items) ? items : undefined,
        text: m.get(SEM + 'text') ?? '',
      })
    }
  }
  findings.sort((a, b) => a.order - b.order || (a.items ?? 0) - (b.items ?? 0) || a.text.localeCompare(b.text))
  return { judgements: all, findings }
}

export interface View {
  iri: string
  label: string
  query: string
}

export type Binding = Record<string, string | number | boolean>

/** The views declared in the perf ontology. */
export function views(store: GraphStore): View[] {
  const f = store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const one = (s: string, p: string) => store.match(nn(s), nn(p), null)[0]?.object.value
  return store
    .match(null, nn('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), nn(PERF + 'View'))
    .map((q) => ({
      iri: q.subject.value,
      label: one(q.subject.value, 'http://www.w3.org/2000/01/rdf-schema#label') ?? q.subject.value,
      order: Number(one(q.subject.value, SEM + 'order') ?? 99),
      query: (one(q.subject.value, SEM + 'select') ?? '').trim(),
    }))
    .sort((a, b) => a.order - b.order)
    .map(({ order: _, ...v }) => v)
}

/** Run a view's SELECT; literals become numbers/booleans where typed so. */
export function select(store: GraphStore, view: View): Binding[] {
  return store.select(SPARQL_PREFIXES + '\n' + PREFIXES + view.query, [store.factory.defaultGraph()]).map((solution) => {
    const row: Binding = {}
    for (const [name, term] of solution) {
      const dt = term.termType === 'Literal' ? term.datatype.value : ''
      row[name] = /#(integer|decimal|double|float)$/.test(dt) ? Number(term.value) : dt.endsWith('#boolean') ? term.value === 'true' : term.value
    }
    return row
  })
}
