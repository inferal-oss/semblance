// Formulas (ontology/components/formula.ttl): a component's value from a SELECT.
import type { Term } from '@rdfjs/types'
import type { FnRule, Out } from '../engine/context.ts'
import { NS, RDF_TYPE, SEM, STY } from '../ns.ts'
import { str } from './util.ts'
import { maintainedRows } from '../view/rows.ts'

const VALUE_QUERY = NS.c + 'valueQuery'

/** What a solution says, on the component: ?value as c:value, ?tone as sty:tone, ?max and ?label. */
function write(o: Out, focus: Term, row: Map<string, Term>) {
  const value = row.get('value')
  if (value?.termType === 'Literal') o.t(focus, NS.c + 'value', value)
  const tone = row.get('tone')
  if (tone?.termType === 'NamedNode') o.t(focus, STY.tone, tone)
  // A bound (a progress bar's total) and a caption may come from the data too.
  const max = row.get('max')
  if (max?.termType === 'Literal') o.t(focus, NS.c + 'max', max)
  const label = row.get('label')
  if (label?.termType === 'Literal') o.t(focus, NS.c + 'label', label)
  return o.quads
}

/** c:Formula: the first row of the component's c:valueQuery, a maintained view - its own instance when it is one per component. */
const formulaValue: FnRule = (ctx, focus) => {
  const view = ctx.object(focus, VALUE_QUERY)
  if (!view || !ctx.match(view, RDF_TYPE, NS.iv + 'View').length) return []
  const instance = ctx.match(null, NS.iv + 'focus', focus).map((q) => q.subject).find((i) => ctx.match(i, NS.iv + 'instanceOf', view).length)
  const row = maintainedRows(ctx, instance ?? view)?.[0]
  return row ? write(ctx.out(focus), focus, row) : []
}

/** c:QueryFormula: a c:valueQuery that is not a view, run (with $this the component). */
const formulaQuery: FnRule = (ctx, focus) => {
  const view = ctx.object(focus, VALUE_QUERY)
  const query = view && str(ctx.object(view, SEM.select))
  if (!query || !ctx.sparql || ctx.match(view, RDF_TYPE, NS.iv + 'View').length) return []
  let row
  try {
    row = ctx.select(query.replaceAll('$this', `<${focus.value}>`))[0]
  } catch {
    return []
  }
  return row ? write(ctx.out(focus), focus, row) : []
}

/** c:FormulaKind: c:runsQuery true when the component's c:valueQuery is not a maintained view. */
const formulaKind: FnRule = (ctx, focus) => {
  const view = ctx.object(focus, VALUE_QUERY)
  if (!view || ctx.match(view, RDF_TYPE, NS.iv + 'View').length) return []
  return ctx.out(focus).t(focus, NS.c + 'runsQuery', ctx.f.literal('true', ctx.nn(NS.xsd + 'boolean'))).quads
}

export const formulaFunctions: Record<string, FnRule> = { 'formula:kind': formulaKind, 'formula:value': formulaValue, 'formula:query': formulaQuery }
