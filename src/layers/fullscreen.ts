// Full screen as a fact (ontology/layers/fullscreen.ttl): the marks on what is shown full screen,
// the toggle a full-screenable component draws, and the function variants of the reactions. The
// host effect that enters and leaves full screen is src/fullscreen.ts.
import type { NamedNode, Quad } from '@rdfjs/types'
import type { ReactionContext, ReactionFn } from '../behaviour/events.ts'
import type { FnRule, Out, RuleContext } from '../engine/context.ts'
import { FS, H, NS, RDF_TYPE, RDFS_SUBCLASS, SEM } from '../ns.ts'
import type { Delta } from '../rdf.ts'
import { isTrue, named, str, text } from '../components/util.ts'

const none = (): Delta => ({ add: [], remove: [] })

/** The part a component shows full screen: its own fs:part, else its nearest class's, else its root. */
export function fullscreenPart(ctx: Pick<RuleContext, 'object' | 'objects'>, focus: NamedNode): string {
  const own = str(ctx.object(focus, FS.part))
  if (own !== undefined) return own
  const seen = new Set<string>()
  const todo = ctx.objects(focus, RDF_TYPE).filter(named)
  while (todo.length) {
    const cls = todo.shift()!
    if (seen.has(cls.value)) continue
    seen.add(cls.value)
    const part = str(ctx.object(cls, FS.part))
    if (part !== undefined) return part
    todo.push(...ctx.objects(cls, RDFS_SUBCLASS).filter(named))
  }
  return 'root'
}

/**
 * The toggle a full-screenable component draws, where its rendering places it: a button marked
 * fs:toggles the component (fs:Flip flips its fact), named in the viewer's language. Its
 * aria-pressed is the layer's (fs:Pressed), so showing it full screen does not render it again.
 */
export function fullscreenToggle(ctx: RuleContext, o: Out, focus: NamedNode): NamedNode {
  const label = text(ctx, ctx.nn(FS.ToggleCommand), NS.rdfs + 'label') ?? 'Full screen'
  const button = o.el('fullscreen-toggle', 'Button', { type: 'button', class: 'sem-fullscreen-toggle', 'aria-label': label })
  o.t(button, FS.toggles, focus)
  o.tip(button, label)
  return button
}

/** Marks the shown element data-sem-fullscreen, with how the host shows it (fs:Marks). */
const marks: FnRule = (ctx, focus) => {
  if (!isTrue(ctx.object(focus, FS.fullscreen))) return []
  const o = ctx.out(focus)
  const part = fullscreenPart(ctx, focus)
  const presentation = ctx.object(focus, FS.presentation)
  const how = named(presentation) ? (str(ctx.object(presentation, SEM.slug)) ?? '') : ''
  o.attr(ctx.nn(`${focus.value}/~${part}`), 'data-sem-fullscreen', how, `${part}-fullscreen`)
  return o.quads
}

/** A full-screenable component's own toggle is pressed while it is full screen (fs:Pressed). */
const pressed: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  o.attr(ctx.nn(`${focus.value}/~fullscreen-toggle`), 'aria-pressed', isTrue(ctx.object(focus, FS.fullscreen)) ? 'true' : 'false')
  return o.quads
}

export const fullscreenFunctions: Record<string, FnRule> = {
  'fullscreen:marks': marks,
  'fullscreen:pressed': pressed,
}

// --- reactions ---------------------------------------------------------------------------------

/** Whether the event's node is (inside) an element marked fs:toggles the target. */
function onToggle(ctx: ReactionContext): boolean {
  const hit = ctx.object(ctx.event, NS.beh + 'node')
  for (let n = hit; named(n); n = ctx.match(null, H.hasChild, n)[0]?.subject) {
    if (ctx.match(n, FS.toggles, ctx.target).length) return true
  }
  return false
}

/** Activating a full-screenable component's own toggle flips its fact (fs:Flip). */
const flip: ReactionFn = (ctx) => {
  if (!onToggle(ctx)) return none()
  const f = ctx.runtime.store.factory
  const old = ctx.match(ctx.target, FS.fullscreen, null)
  const on = old.some((q) => isTrue(q.object))
  return { remove: old, add: [f.quad(ctx.target, f.namedNode(FS.fullscreen), f.literal(String(!on), f.namedNode(NS.xsd + 'boolean')))] }
}

/** The host shows it as the event says: recorded while the fact holds (fs:EnterNative, fs:EnterMaximized). */
const enter =
  (presentation: string): ReactionFn =>
  (ctx) => {
    if (ctx.object(ctx.event, FS.presentation)?.value !== presentation) return none()
    const f = ctx.runtime.store.factory
    const old = ctx.match(ctx.target, FS.presentation, null)
    const remove = old.filter((q) => q.object.value !== presentation)
    const add: Quad[] = []
    if (isTrue(ctx.object(ctx.target, FS.fullscreen)) && !old.some((q) => q.object.value === presentation))
      add.push(f.quad(ctx.target, f.namedNode(FS.presentation), f.namedNode(presentation)))
    return { remove, add }
  }

/** The host no longer shows it: the fact and how go (fs:Exit). */
const exit: ReactionFn = (ctx) => ({
  remove: [...ctx.match(ctx.target, FS.fullscreen, null), ...ctx.match(ctx.target, FS.presentation, null)],
  add: [],
})

export const fullscreenReactions: Record<string, ReactionFn> = {
  'fullscreen:flip': flip,
  'fullscreen:enter-native': enter(FS.Native),
  'fullscreen:enter-maximized': enter(FS.Maximized),
  'fullscreen:exit': exit,
}
