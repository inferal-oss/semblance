// The localization layer (ontology/layers/l10n.ttl): labels in the viewer's language.
import type { FnRule } from '../engine/context.ts'
import { L10N } from '../ns.ts'
import { text } from '../components/util.ts'

/**
 * For components with translations: each translated property (c:label, and every other property
 * that is l10n:localizedAs one) in the viewer's language, as that property, for SPARQL rules.
 */
const localLabel: FnRule = (ctx, focus) => {
  // The ontology says which properties are translated; it does not change during a run.
  const localized = ctx.memo('l10n:localizedAs', () =>
    ctx.untraced(() => ctx.match(null, L10N.localizedAs, null).flatMap((q) => (q.object.termType === 'NamedNode' ? [[q.subject.value, q.object.value] as const] : []))),
  )
  const o = ctx.out(focus)
  for (const [property, local] of localized) {
    const labels = ctx.objects(focus, property)
    if (labels.length < 2 && !labels.some((t) => t.termType === 'Literal' && t.language)) continue
    const label = text(ctx, focus, property)
    if (label !== undefined) o.t(focus, local, label)
  }
  return o.quads
}

export const l10nFunctions: Record<string, FnRule> = { 'l10n:label': localLabel }
