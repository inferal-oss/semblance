// Formulas (ontology/components/formula.ttl): a component's value from a SELECT.
import type { FnRule } from '../engine/context.ts'
import { NS, SEM, STY } from '../ns.ts'
import { str } from './util.ts'

const VALUE_QUERY = NS.c + 'valueQuery'

/** The first solution of the component's c:valueQuery, as its c:value (and sty:tone). */
const formulaValue: FnRule = (ctx, focus) => {
  const view = ctx.object(focus, VALUE_QUERY)
  const query = view && str(ctx.object(view, SEM.select))
  if (!query || !ctx.sparql) return []
  let row
  try {
    row = ctx.select(query.replaceAll('$this', `<${focus.value}>`))[0]
  } catch {
    return []
  }
  if (!row) return []
  const o = ctx.out(focus)
  const value = row.get('value')
  if (value?.termType === 'Literal') o.t(focus, NS.c + 'value', value)
  const tone = row.get('tone')
  if (tone?.termType === 'NamedNode') o.t(focus, STY.tone, tone)
  return o.quads
}

export const formulaFunctions: Record<string, FnRule> = { 'formula:value': formulaValue }
