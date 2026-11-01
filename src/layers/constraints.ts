// The layout constraints layer (ontology/layers/constraints.ttl): the parts a component's
// renderings name (lc:role on the nodes they mint) are marked on their elements, data-sem-part
// (the role's slug) and, for a part that has its role at one width class only, data-sem-part-at.
import type { FnRule } from '../engine/context.ts'
import { LC, SEM } from '../ns.ts'
import { owningFocus } from '../rdf.ts'
import { named, str } from '../components/util.ts'

const parts: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  for (const q of ctx.match(null, LC.role, null)) {
    const node = q.subject
    if (!named(node) || owningFocus(node.value) !== focus.value) continue
    const slug = str(ctx.object(q.object, SEM.slug))
    if (slug === undefined) continue
    const local = node.value.slice(focus.value.length + 2)
    o.attr(node, 'data-sem-part', slug, local + '-part')
    const width = ctx.object(node, LC.atWidth)
    const at = width && str(ctx.object(width, SEM.slug))
    if (at !== undefined) o.attr(node, 'data-sem-part-at', at, local + '-part-at')
  }
  return o.quads
}

export const constraintsFunctions: Record<string, FnRule> = { 'constraints:parts': parts }
