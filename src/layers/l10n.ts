// The localization layer (ontology/layers/l10n.ttl): labels in the viewer's language.
import type { FnRule } from '../engine/context.ts'
import { C, L10N } from '../ns.ts'
import { RDFS_LABEL, text } from '../components/util.ts'

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

/** A phrase's label in the viewer's language (for SPARQL rules; l10n:Phrases). */
const phraseLabel: FnRule = (ctx, focus) => {
  const label = text(ctx, focus, RDFS_LABEL)
  if (label === undefined) return []
  const o = ctx.out(focus)
  o.t(focus, L10N.label, label)
  return o.quads
}

export const l10nFunctions: Record<string, FnRule> = { 'l10n:label': localLabel, 'l10n:phrase': phraseLabel }
