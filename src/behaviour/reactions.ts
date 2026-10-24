// Function implementations of the reactions declared in component vocabularies
// (used where SPARQL is unavailable or functions are preferred).
import { BEH, C, H, XSD_BOOLEAN } from '../ns.ts'
import type { ReactionFn } from './events.ts'

const textFieldInput: ReactionFn = ({ runtime, event, target, match, object }) => {
  const f = runtime.store.factory
  const value = object(event, BEH.value)
  return {
    remove: [...match(target, C.value, null), ...match(target, C.error, null)],
    add: value ? [f.quad(target, f.namedNode(C.value), value)] : [],
  }
}

const listItemChange: ReactionFn = ({ runtime, event, target, match, object }) => {
  const f = runtime.store.factory
  const item = object(target, C.of)
  const p = object(target, C.checkedFrom)
  const checked = object(event, BEH.checked)
  if (!item || !p || !checked) return { add: [], remove: [] }
  return { remove: match(item, p.value, null), add: [f.quad(item, p, checked)] }
}

/** The option or tab selected by the event's node or its nearest RDF/HTML ancestor that selects one. */
const selection = ({ event, object, match }: Parameters<ReactionFn>[0]) => {
  for (let node = object(event, BEH.node), hops = 0; node && hops < 32; hops++) {
    const selected = object(node, C.selects)
    if (selected) return selected
    node = match(null, H.hasChild, node)[0]?.subject
  }
  return undefined
}

const tabsSelect: ReactionFn = (ctx) => {
  const f = ctx.runtime.store.factory
  const tab = selection(ctx)
  if (!tab) return { add: [], remove: [] }
  return { remove: ctx.match(ctx.target, C.selected, null), add: [f.quad(ctx.target, f.namedNode(C.selected), tab)] }
}

const segmentedSelect: ReactionFn = (ctx) => {
  const f = ctx.runtime.store.factory
  const option = selection(ctx)
  const target = ctx.object(ctx.target, C.controls)
  const p = ctx.object(ctx.target, C.property)
  if (!option || !target || !p) return { add: [], remove: [] }
  return { remove: ctx.match(target, p.value, null), add: [f.quad(target, p, option)] }
}

const flippableFlip: ReactionFn = (ctx) => {
  const f = ctx.runtime.store.factory
  // Only the card's own flip buttons (c:flips) turn it over.
  for (let node = ctx.object(ctx.event, BEH.node), hops = 0; node && hops < 32; hops++) {
    if (ctx.object(node, C.flips)?.equals(ctx.target)) {
      const current = ctx.match(ctx.target, C.flipped, null)
      const flipped = current.some((q) => q.object.value === 'true')
      return { remove: current, add: [f.quad(ctx.target, f.namedNode(C.flipped), f.literal(String(!flipped), f.namedNode(XSD_BOOLEAN)))] }
    }
    node = ctx.match(null, H.hasChild, node)[0]?.subject
  }
  return { add: [], remove: [] }
}

const choiceSelect: ReactionFn = (ctx) => {
  const f = ctx.runtime.store.factory
  const target = ctx.object(ctx.target, C.controls)
  const p = ctx.object(ctx.target, C.property)
  const value = ctx.object(ctx.event, BEH.value)
  if (!target || !p || !value) return { add: [], remove: [] }
  return { remove: ctx.match(target, p.value, null), add: [f.quad(target, p, f.namedNode(value.value))] }
}

const chipsToggle: ReactionFn = (ctx) => {
  const f = ctx.runtime.store.factory
  const option = selection(ctx)
  const target = ctx.object(ctx.target, C.controls)
  const p = ctx.object(ctx.target, C.property)
  if (!option || !target || !p) return { add: [], remove: [] }
  const existing = ctx.match(target, p.value, option)
  return existing.length ? { remove: existing, add: [] } : { remove: [], add: [f.quad(target, p, option)] }
}

export const reactions: Record<string, ReactionFn> = {
  'choice:select': choiceSelect,
  'chips:toggle': chipsToggle,
  'flippable:flip': flippableFlip,
  'tabs:select': tabsSelect,
  'segmented:select': segmentedSelect,
  'textfield:input': textFieldInput,
  'listitem:change': listItemChange,
}
