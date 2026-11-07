// The privacy (concealment) layer (ontology/layers/privacy.ttl).
import type { FnRule } from '../engine/context.ts'
import { NS } from '../ns.ts'
import { isTrue } from '../components/util.ts'

const PRV = NS.prv

/** A concealed text field without a declared input type is a password field. */
const mask: FnRule = (ctx, focus) => {
  // (Its own output is no declared type: a re-evaluation reads it too.)
  if (!isTrue(ctx.object(focus, PRV + 'concealed')) || ctx.objects(focus, NS.c + 'inputType').some((t) => t.value !== 'password')) return []
  const o = ctx.out(focus)
  o.t(focus, NS.c + 'inputType', 'password')
  return o.quads
}

/** Marks a concealed or sensitive component's root (attribute nodes, as the SPARQL rule mints them). */
const marks: FnRule = (ctx, focus) => {
  const names = [
    ...(isTrue(ctx.object(focus, PRV + 'concealed')) ? ['data-sem-concealed'] : []),
    ...(isTrue(ctx.object(focus, PRV + 'sensitive')) ? ['data-sem-sensitive'] : []),
  ]
  if (!names.length) return []
  const o = ctx.out(focus)
  const root = ctx.nn(focus.value + '/~root')
  for (const name of names) o.attr(root, name, '')
  return o.quads
}

export const privacyFunctions: Record<string, FnRule> = { 'privacy:mask': mask, 'privacy:marks': marks }
