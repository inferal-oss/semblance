// Undo over the change log (docs/IVM.md §16, decision 11): a reaction marked beh:undoable has its
// effective change recorded on the event's member (beh:asserted, beh:retracted: rdf:Statement nodes
// minted under it), and activating a beh:Undoer applies the opposite of the latest recorded change
// that has not been undone and still applies - every triple it added is still there and none it
// removed is back; a change that later ones overlapped is skipped, not forced. The SPARQL pair is
// beh:UndoLatest (ontology/layers/behaviour.ttl); this is its function twin.
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import { BEH, H, NS, SEM } from '../ns.ts'
import type { ReactionContext, ReactionFn } from './events.ts'
import { type FnRule, formatLocale } from '../engine/context.ts'
import { mint } from '../rdf.ts'
import { RDFS_LABEL, text } from '../components/util.ts'
import { formatNumber } from '../../rdf-engine/host/intl.ts'

const RDF = NS.rdf
const TREE_MEMBER = NS.tree + 'member'

/** A recorded statement's triple, in the input graph (undefined: the statement is not whole). */
function statement(ctx: ReactionContext, st: Term): Quad | undefined {
  const s = ctx.object(st, RDF + 'subject')
  const p = ctx.object(st, RDF + 'predicate')
  const o = ctx.object(st, RDF + 'object')
  return s && p && o ? ctx.runtime.store.factory.quad(s as NamedNode, p as NamedNode, o) : undefined
}

const holds = (ctx: ReactionContext, q: Quad) => ctx.match(q.subject, q.predicate.value, q.object).length > 0

/**
 * A member's recorded change, or undefined when one of its statements is not whole (a remembered
 * log stored without them): such a change is neither undone nor redone, as by beh:UndoLatest.
 */
function changeOf(ctx: ReactionContext, m: Term): { added: Quad[]; removed: Quad[] } | undefined {
  const added: Quad[] = []
  const removed: Quad[] = []
  for (const [p, out] of [[BEH.asserted, added], [BEH.retracted, removed]] as const) {
    for (const q of ctx.match(m, p, null)) {
      const st = statement(ctx, q.object)
      if (!st) return undefined
      out.push(st)
    }
  }
  return { added, removed }
}

const undoLatest: ReactionFn = (ctx) => {
  const f = ctx.runtime.store.factory
  const log = (ctx.object(ctx.target, BEH.log) as NamedNode | undefined) ?? f.namedNode(BEH.ChangeLog)
  const undone = new Set(ctx.match(log, BEH.undone, null).map((q) => q.object.value))
  let best: { m: Term; n: number; added: Quad[]; removed: Quad[] } | undefined
  for (const { object: m } of ctx.match(log, TREE_MEMBER, null)) {
    if (undone.has(m.value)) continue
    const change = changeOf(ctx, m)
    if (!change) continue
    const { added, removed } = change
    if (!added.length && !removed.length) continue
    if (!added.every((q) => holds(ctx, q)) || removed.some((q) => holds(ctx, q))) continue
    const n = Number(ctx.object(m, BEH.sequence)?.value ?? NaN)
    if (!best || n > best.n) best = { m, n, added, removed }
  }
  const members = new Set(ctx.match(log, TREE_MEMBER, null).map((q) => q.object.value))
  // Undone members the log has since retired: forget them.
  const gone = ctx.match(log, BEH.undone, null).filter((q) => !members.has(q.object.value))
  const remove = gone.map((q) => f.quad(q.subject as NamedNode, q.predicate as NamedNode, q.object))
  if (!best) return { remove, add: [] }
  return { remove: [...remove, ...best.added], add: [...best.removed, f.quad(log, f.namedNode(BEH.undone), best.m as NamedNode)] }
}

/** beh:RedoLatest's twin: the change undone last (the undone member with the lowest sequence) applied again, when it can be. */
const redoLatest: ReactionFn = (ctx) => {
  const f = ctx.runtime.store.factory
  const log = (ctx.object(ctx.target, BEH.log) as NamedNode | undefined) ?? f.namedNode(BEH.ChangeLog)
  let best: { m: Term; n: number; added: Quad[]; removed: Quad[] } | undefined
  for (const { object: m } of ctx.match(log, BEH.undone, null)) {
    const change = changeOf(ctx, m)
    if (!change) continue
    const { added, removed } = change
    if (added.some((q) => holds(ctx, q)) || !removed.every((q) => holds(ctx, q))) continue
    const n = Number(ctx.object(m, BEH.sequence)?.value ?? NaN)
    if (!Number.isFinite(n)) continue
    if (!best || n < best.n) best = { m, n, added, removed }
  }
  if (!best) return { remove: [], add: [] }
  return { remove: [...best.removed, f.quad(log, f.namedNode(BEH.undone), best.m as NamedNode)], add: best.added }
}

export const undoReactions: Record<string, ReactionFn> = { 'beh:undo-latest': undoLatest, 'beh:redo-latest': redoLatest }


/**
 * beh:UndoHorizon's twin: an Undoer whose log has nothing in memory to undo (beh:undoableCount, from
 * beh:UndoableCounts) is disabled, and says why: nothing was done, or how much its horizon no longer keeps.
 */
const undoHorizon: FnRule = (ctx, focus) => {
  const log = ctx.object(focus, BEH.log) ?? ctx.nn(BEH.ChangeLog)
  if (ctx.objects(log, BEH.undoableCount).some((n) => Number(n.value) > 0)) return []
  const horizon = ctx.match(null, NS.ret + 'of', log).map((q) => q.subject).find((h) => ctx.match(h, RDF + 'type', NS.ret + 'Horizon').length > 0)
  const dropped = horizon ? Number(ctx.object(horizon, NS.ret + 'dropped')?.value ?? 0) || 0 : 0
  ctx.readsLanguage()
  const phrase = (local: string) => text(ctx, ctx.nn(NS.beh + local), RDFS_LABEL) ?? ''
  const why = dropped > 0 ? phrase('HistoryStarts').split('{n}').join(formatNumber(dropped, formatLocale(ctx.languages))) : phrase('NothingToUndo')
  const o = ctx.out(focus)
  const root = ctx.nn(mint(focus.value, 'root'))
  o.t(root, H.ns + 'disabled', '').t(root, SEM.tooltip, why)
  return o.quads
}

export const undoFunctions: Record<string, FnRule> = { 'undo:horizon': undoHorizon }
