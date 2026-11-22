// The localization layer (ontology/layers/l10n.ttl): labels in the viewer's language.
import type { FnRule } from '../engine/context.ts'
import { C, L10N, RDF_TYPE, RDFS_SUBCLASS, SEM } from '../ns.ts'
import { text } from '../components/util.ts'
import { md5 } from '../components/data.ts'

/** For components with translations: their label in the viewer's language (for SPARQL rules). */
const localLabel: FnRule = (ctx, focus) => {
  const labels = ctx.objects(focus, C.label)
  if (labels.length < 2 && !labels.some((t) => t.termType === 'Literal' && t.language)) return []
  const label = text(ctx, focus, C.label)
  if (label === undefined) return []
  const o = ctx.out(focus)
  o.t(focus, L10N.label, label)
  return o.quads
}

/**
 * l10n:Terms, member-wise (sem:watchesManyValued): for a node with two values or more of a text
 * property that has an l10n: twin (l10n:pickedAs), the one in the viewer's language as the twin,
 * on a node of the viewer's about it (components' own c:label is l10n:label's per component).
 */
const terms: FnRule = (ctx, viewer, member) => {
  if (!member) return []
  const o = ctx.out(viewer)
  const component = () => ctx.objects(member, RDF_TYPE).some((t) => ctx.memo('l10n:component ' + t.value, () => isComponentClass(ctx, t.value)))
  const at = o.node('t-' + md5(member.value))
  let about = false
  for (const twin of ctx.match(null, L10N.pickedAs, null)) {
    const p = twin.subject.value
    if (new Set(ctx.objects(member, p).filter((t) => t.termType === 'Literal').map((t) => t.value + '@' + (t as { language?: string }).language)).size < 2) continue
    if (p === C.label && component()) continue
    const value = text(ctx, member, p)
    if (value === undefined) continue
    if (!about) o.t(at, L10N.of, member), (about = true)
    o.t(at, twin.object.value, value)
  }
  return o.quads
}

/** Whether a class is sem:Component or one of its subclasses. */
function isComponentClass(ctx: Parameters<FnRule>[0], cls: string): boolean {
  const seen = new Set<string>()
  const todo = [cls]
  while (todo.length) {
    const c = todo.pop()!
    if (c === SEM.Component) return true
    if (seen.has(c)) continue
    seen.add(c)
    for (const sup of ctx.untraced(() => ctx.objects(ctx.nn(c), RDFS_SUBCLASS))) todo.push(sup.value)
  }
  return false
}

export const l10nFunctions: Record<string, FnRule> = { 'l10n:label': localLabel, 'l10n:terms': terms }
