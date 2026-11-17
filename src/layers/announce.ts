// The announcements layer (ontology/layers/announce.ttl): toasts from the change log.
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import type { ReactionFn } from '../behaviour/events.ts'
import type { FnRule } from '../engine/context.ts'
import { ANN, BEH, C, NS, RDF_TYPE, STY } from '../ns.ts'
import { mint } from '../rdf.ts'
import { named, num, str, text } from '../components/util.ts'
import { FB, hitMarks } from '../components/feedback.ts'
import { maintainedRows } from '../view/rows.ts'

/** Without the view: how far back the layer looks for announcing events. */
const WINDOW = 50

const RET = NS.ret
const TREE_MEMBER = NS.tree + 'member'

/** What the rule and reaction contexts both read with. */
type Reads = { match(s: Term | null, p: string | null, o: Term | null): Quad[] }

/** Whether a reaction's announcements wait for acknowledgement (ann:retention a ret:UntilAcknowledged). */
function waits(ctx: Reads, reaction: Term, untilAcknowledged: Term): boolean {
  return ctx.match(reaction, ANN.retention, null).some((q) => ctx.match(q.object, RDF_TYPE, untilAcknowledged).length > 0)
}

/** Whether an event was acknowledged (ret:acknowledged true). */
const acknowledged = (ctx: Reads, m: Term) => ctx.match(m, RET + 'acknowledged', null).some((q) => q.object.value === 'true')

const toasts: FnRule = (ctx, focus) => {
  const stream = ctx.object(focus, ANN.from)
  if (!named(stream)) return []
  const limit = num(ctx, focus, C.limit, 3)
  const until = ctx.nn(RET + 'UntilAcknowledged')
  const o = ctx.out(focus)
  const found: { seq: number; text: string; tone?: string; m: Term }[] = []
  /** What a member's announcing reaction says (the first that says something), and its tone. */
  const said = (m: Term, only?: (r: Term) => boolean) => {
    for (const reaction of ctx.objects(m, BEH.handledBy)) {
      if (only && !only(reaction)) continue
      // An event may say it itself (ann:announcesFrom: e.g. a refusal's reason).
      const from = ctx.object(reaction, ANN.announcesFrom)
      const t = (named(from) ? text(ctx, m, from.value) : undefined) ?? text(ctx, reaction, ANN.announces)
      if (t !== undefined) return { seq: Number(str(ctx.object(m, BEH.sequence)) ?? 0), text: t, tone: ctx.object(reaction, ANN.tone)?.value, m }
    }
    return undefined
  }
  // The announcing members, newest first: the region's maintained view (ann:RecentAnnouncements),
  // else a walk back from the log's head. Those that wait for acknowledgement are not among them.
  const rows = maintainedRows(ctx, ctx.nn(mint(focus.value, 'view-RecentAnnouncements')))
  const members: Term[] = []
  if (rows) members.push(...rows.map((r) => r.get('m')!).filter(named))
  else for (let seen = 0, m = ctx.object(stream, BEH.latest); named(m) && seen < WINDOW; seen++, m = ctx.object(m, BEH.previous)) members.push(m)
  for (const m of members) {
    if (found.length >= limit) break
    if (!rows && ctx.objects(m, BEH.handledBy).some((r) => waits(ctx, r, until))) continue
    const a = said(m)
    if (a) found.push(a)
  }
  // Besides them, every announcement that waits for acknowledgement and has none yet: from the few
  // reactions that say so, the members of this log they handled.
  for (const { subject: reaction } of ctx.match(null, ANN.retention, null)) {
    if (!waits(ctx, reaction, until)) continue
    for (const { subject: m } of ctx.match(null, BEH.handledBy, reaction)) {
      if (acknowledged(ctx, m) || !ctx.match(stream, TREE_MEMBER, m).length || !ctx.object(m, BEH.sequence)) continue
      const a = said(m, (r) => r.equals(reaction))
      if (a) found.push(a)
    }
  }
  for (const a of found) {
    // Keys sort chronologically, and the region orders hosted toasts by IRI.
    const toast = o.node('ann-' + String(a.seq).padStart(10, '0'))
    o.t(toast, RDF_TYPE, ctx.nn(C.Toast)).t(toast, C.label, a.text).t(toast, ANN.event, a.m).t(focus, C.hosts, toast)
    if (a.tone) o.t(toast, STY.tone, ctx.nn(a.tone))
  }
  return o.quads
}

export const announceFunctions: Record<string, FnRule> = { 'announce:toasts': toasts }

/** ann:Acknowledge's twin: dismissing a toast that waits for acknowledgement acknowledges its event. */
const acknowledge: ReactionFn = (ctx) => {
  const none = { add: [], remove: [] }
  if (!hitMarks(ctx, FB.closes) || ctx.match(ctx.target, NS.c + 'dismissible', null).some((q) => q.object.value === 'false')) return none
  const f = ctx.runtime.store.factory
  const until = f.namedNode(RET + 'UntilAcknowledged')
  const add = ctx
    .match(ctx.target, ANN.event, null)
    .map((q) => q.object)
    .filter((m) => named(m) && !acknowledged(ctx, m) && ctx.match(m, BEH.handledBy, null).some((q) => waits(ctx, q.object, until)))
    .map((m) => f.quad(m as NamedNode, f.namedNode(RET + 'acknowledged'), f.literal('true', f.namedNode(NS.xsd + 'boolean'))))
  return { add, remove: [] }
}

export const announceReactions: Record<string, ReactionFn> = { 'announce:acknowledge': acknowledge }
