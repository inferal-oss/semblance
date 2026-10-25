// The function twin of the spark chart's points (ex:SparkPoints in foreign.ttl).
import type { FnRule } from '../../src/engine/context.ts'
import { C, NS } from '../../src/ns.ts'

const EX = 'https://example.org/foreign#'

const sparkPoints: FnRule = (ctx, focus) => {
  const points = ctx.objects(focus, EX + 'point').flatMap((p) => {
    const label = ctx.object(p, C.label)
    const value = ctx.object(p, EX + 'amount')
    const order = ctx.object(p, EX + 'order')
    return label && value && order ? [{ label: label.value, value: value.value, order: order.value }] : []
  })
  points.sort((a, b) => Number(a.order) - Number(b.order))
  const json = '[' + points.map((p) => `{"label":"${p.label}","order":${p.order},"value":${p.value}}`).join(',') + ']'
  const o = ctx.out(focus)
  o.t(focus, EX + 'pointsJson', ctx.f.literal(json, ctx.nn(NS.rdf + 'JSON')))
  return o.quads
}

export const foreignExampleFunctions: Record<string, FnRule> = { 'ex:spark-points': sparkPoints }
