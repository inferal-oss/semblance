// The validation layer (ontology/layers/validation.ttl): SHACL property
// shapes checked against field values, concluded as c:error / val:invalid,
// and buttons gated on the fields they require.
import type { Term } from '@rdfjs/types'
import type { FnRule, RuleContext } from '../engine/context.ts'
import { C, NS, VAL, XSD_BOOLEAN } from '../ns.ts'
import { isTrue, nodes, rdfList, str, text } from '../components/util.ts'

const SH = NS.sh

/** The first constraint of `shape` that `value` violates, as a message; undefined if it conforms. */
function violation(ctx: RuleContext, shape: Term, value: string | undefined): string | undefined {
  const n = (p: string) => {
    const v = str(ctx.object(shape, SH + p))
    return v === undefined ? undefined : Number(v)
  }
  const message = (fallback: string) => text(ctx, shape, SH + 'message') ?? fallback
  const required = (n('minCount') ?? 0) > 0
  if (value === undefined || value === '') return required ? message('Required.') : undefined
  const minLength = n('minLength')
  if (minLength !== undefined && value.length < minLength) return message(`At least ${minLength} characters.`)
  const maxLength = n('maxLength')
  if (maxLength !== undefined && value.length > maxLength) return message(`At most ${maxLength} characters.`)
  const pattern = str(ctx.object(shape, SH + 'pattern'))
  if (pattern !== undefined) {
    let re: RegExp | undefined
    try {
      re = new RegExp(pattern, str(ctx.object(shape, SH + 'flags')) ?? '')
    } catch {
      return message(`Invalid pattern in shape: ${pattern}`)
    }
    if (!re.test(value)) return message('Does not match the expected format.')
  }
  const datatype = str(ctx.object(shape, SH + 'datatype'))
  const numeric = datatype === NS.xsd + 'integer' || datatype === NS.xsd + 'decimal'
  const x = Number(value)
  if (numeric && (value.trim() === '' || !Number.isFinite(x) || (datatype === NS.xsd + 'integer' && !Number.isInteger(x)))) {
    return message(datatype === NS.xsd + 'integer' ? 'A whole number.' : 'A number.')
  }
  const min = n('minInclusive')
  if (min !== undefined && !(x >= min)) return message(`At least ${min}.`)
  const max = n('maxInclusive')
  if (max !== undefined && !(x <= max)) return message(`At most ${max}.`)
  const allowed = ctx.object(shape, SH + 'in')
  if (allowed && !rdfList(ctx, allowed).some((t) => t.value === value)) return message('Not one of the allowed values.')
  return undefined
}

/** A field's current value: c:value, or c:checked for boolean controls. Undefined while pristine. */
function valueOf(ctx: RuleContext, field: Term): string | undefined {
  const v = ctx.object(field, C.value)
  if (v) return v.value
  const checked = ctx.object(field, C.checked)
  return checked ? (isTrue(checked) ? 'true' : '') : undefined
}

const check: FnRule = (ctx, focus) => {
  const shape = ctx.object(focus, VAL.validates)
  const requires = ctx.object(focus, VAL.requires)
  if (!shape && !requires) return []
  const o = ctx.out(focus)
  const bool = ctx.nn(XSD_BOOLEAN)
  if (shape) {
    const value = valueOf(ctx, focus)
    const problem = violation(ctx, shape, value)
    if (problem !== undefined) {
      o.t(focus, VAL.invalid, ctx.f.literal('true', bool))
      // Pristine fields are invalid (so forms stay gated) but say nothing yet.
      if (value !== undefined) o.t(focus, C.error, problem)
    }
  }
  if (requires) {
    const blocked = nodes(ctx, requires).some((field) => isTrue(ctx.object(field, VAL.invalid)))
    if (blocked) o.t(focus, C.disabled, ctx.f.literal('true', bool))
  }
  return o.quads
}

export const validationFunctions: Record<string, FnRule> = { 'validation:check': check }
