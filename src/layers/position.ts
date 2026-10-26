// The position layer's derivations (ontology/layers/position.ttl): columns whose parts line up.
// Function twins of pos:AlignedColumnRows and pos:RowSpans.
import type { FnRule, RuleContext } from '../engine/context.ts'
import { C, POS, RDF_TYPE, RDFS_SUBCLASS } from '../ns.ts'
import { nodes } from '../components/util.ts'

/** The children of a pos:AlignedColumns container, and the fields of a pos:FieldRow, take their rows from it. */
const alignedColumns: FnRule = (ctx, focus) => {
  const layouts = ctx.objects(focus, POS.layout).map((l) => l.value)
  const aligned = layouts.includes(POS.AlignedColumns)
  if (!aligned && !layouts.includes(POS.FieldRow)) return []
  const o = ctx.out(focus)
  for (const column of nodes(ctx, ctx.object(focus, C.children)))
    if (aligned || declaredParts(ctx, column) !== undefined) o.t(column, POS.rows, ctx.nn(POS.RowSubgrid))
  return o.quads
}

/** The most parts any class of `focus` declares (pos:rowParts), if one does. */
const declaredParts = (ctx: RuleContext, focus: Parameters<RuleContext['objects']>[0]) => {
  let declared: number | undefined
  const seen = new Set<string>()
  const classes = ctx.objects(focus, RDF_TYPE)
  for (let i = 0; i < classes.length; i++) {
    const cls = classes[i]!
    if (seen.has(cls.value)) continue
    seen.add(cls.value)
    for (const p of ctx.objects(cls, POS.rowParts)) {
      const n = Number(p.value)
      if (Number.isFinite(n)) declared = declared === undefined ? n : Math.max(declared, n)
    }
    classes.push(...ctx.objects(cls, RDFS_SUBCLASS))
  }
  return declared
}

/** The pos:RowSpan of `n` rows, if there is one. */
export const spanOf = (ctx: RuleContext, n: number | undefined) =>
  n === undefined ? undefined : ctx.match(null, RDF_TYPE, POS.RowSpan).find((q) => ctx.objects(q.subject, POS.count).some((c) => Number(c.value) === n))?.subject

/** What takes rows spans as many as it has parts: its class's pos:rowParts, else its c:children. */
const rowSpan: FnRule = (ctx, focus) => {
  if (!ctx.objects(focus, POS.rows).some((r) => r.value === POS.RowSubgrid)) return []
  const span = spanOf(ctx, declaredParts(ctx, focus) ?? nodes(ctx, ctx.object(focus, C.children)).length)
  if (!span) return []
  return ctx.out(focus).t(focus, POS.rowSpan, span).quads
}

export const positionFunctions: Record<string, FnRule> = {
  'position:aligned-columns': alignedColumns,
  'position:row-span': rowSpan,
}
