// Block conversions (ontology/components/block-editor.ttl, blk:Conversion): the function twins of the
// four kinds the built-in conversions are like - blk:Retype, blk:Wrap, blk:Unwrap, blk:Relist. A
// conversion is raised on a block ($this, the event's target) by its IRI, so the event's class is the
// conversion, and its blk:to the type the block becomes. Each returns the same change as its SPARQL pair.
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import type { Delta } from '../rdf.ts'
import type { ReactionContext, ReactionFn } from '../behaviour/events.ts'
import { NS, RDF_TYPE, RDFS_SUBCLASS } from '../ns.ts'

const BLK = NS.blk
const PO_CONTAINS = 'http://www.essepuntato.it/2008/12/pattern#contains'
const NEXT = 'http://purl.org/co/nextItem'
const RDF_VALUE = NS.rdf + 'value'
const CHECKED = BLK + 'checked'

/** The change a conversion makes, built up as quads. */
function change(ctx: ReactionContext) {
  const f = ctx.runtime.store.factory
  const out: Delta = { add: [], remove: [] }
  const nn = (iri: string) => f.namedNode(iri)
  const q = (s: Term, p: string, o: Term): Quad => f.quad(s as NamedNode, nn(p), o)
  return {
    f,
    nn,
    out,
    add: (s: Term | undefined, p: string, o: Term | undefined) => s && o && out.add.push(q(s, p, o)),
    remove: (s: Term | undefined, p: string, o: Term | undefined) => s && o && out.remove.push(q(s, p, o)),
  }
}

const objects = (ctx: ReactionContext, s: Term, p: string) => ctx.match(s, p, null).map((q) => q.object)
const subjects = (ctx: ReactionContext, p: string, o: Term) => ctx.match(null, p, o).map((q) => q.subject)

/** Whether a class is (a subclass of) another: `?c rdfs:subClassOf* ?sup`. */
function sub(ctx: ReactionContext, c: Term, sup: string): boolean {
  const seen = new Set<string>()
  const todo = [c.value]
  while (todo.length) {
    const x = todo.pop()!
    if (x === sup) return true
    if (seen.has(x)) continue
    seen.add(x)
    for (const s of objects(ctx, ctx.runtime.store.factory.namedNode(x), RDFS_SUBCLASS)) todo.push(s.value)
  }
  return false
}
const isA = (ctx: ReactionContext, x: Term, sup: string) => objects(ctx, x, RDF_TYPE).some((t) => sub(ctx, t, sup))

/** The type the block becomes: the blk:to of the conversion the event is. */
function target(ctx: ReactionContext): Term | undefined {
  for (const conv of objects(ctx, ctx.event, RDF_TYPE)) {
    const to = ctx.object(conv, BLK + 'to')
    if (to) return to
  }
  return undefined
}

/** What a type's template starts a block with (blk:template), but its type, blocks and text. */
function templated(ctx: ReactionContext, to: Term): [Term, Term][] {
  const skip = new Set([RDF_TYPE, PO_CONTAINS, RDF_VALUE])
  return objects(ctx, to, BLK + 'template').flatMap((t) => ctx.match(t, null, null).filter((q) => !skip.has(q.predicate.value)).map((q) => [q.predicate, q.object] as [Term, Term]))
}

/** The part of an event's IRI after "event:", as the SPARQL rules mint from it. */
const eventKey = (ctx: ReactionContext) => ctx.event.value.slice(ctx.event.value.indexOf('event:') + 'event:'.length)

const retype: ReactionFn = (ctx) => {
  const to = target(ctx)
  const c = change(ctx)
  if (!to) return c.out
  const self = ctx.target
  for (const t of objects(ctx, self, RDF_TYPE)) if (sub(ctx, t, BLK + 'Block') && t.value !== to.value) c.remove(self, RDF_TYPE, t)
  if (sub(ctx, to, BLK + 'PlainTextBlock'))
    for (const m of objects(ctx, self, BLK + 'mark')) {
      c.remove(self, BLK + 'mark', m)
      for (const q of ctx.match(m, null, null)) c.remove(m, q.predicate.value, q.object)
    }
  for (const [cls, p] of [[BLK + 'Toggle', NS.c + 'expanded'], [BLK + 'Callout', NS.c + 'icon'], [BLK + 'Code', NS.schema + 'programmingLanguage']] as const)
    if (!sub(ctx, to, cls)) for (const v of objects(ctx, self, p)) c.remove(self, p, v)
  c.add(self, RDF_TYPE, to)
  for (const [p, v] of templated(ctx, to)) if (!ctx.match(self, p.value, null).length) c.add(self, p.value, v)
  // Blocks it held, when the new type holds none, follow it instead.
  const children = objects(ctx, self, PO_CONTAINS)
  if (!sub(ctx, to, BLK + 'Container') && children.length) {
    const next = objects(ctx, self, NEXT)
    for (const child of children) c.remove(self, PO_CONTAINS, child)
    for (const n of next) c.remove(self, NEXT, n)
    for (const parent of subjects(ctx, PO_CONTAINS, self)) for (const child of children) c.add(parent, PO_CONTAINS, child)
    const held = new Set(children.map((x) => x.value))
    for (const first of children) if (!subjects(ctx, NEXT, first).some((p) => held.has(p.value))) c.add(self, NEXT, first)
    for (const last of children) if (!objects(ctx, last, NEXT).length) for (const n of next) c.add(last, NEXT, n)
  }
  return c.out
}

const wrap: ReactionFn = (ctx) => {
  const to = target(ctx)
  const c = change(ctx)
  const item = to && ctx.object(to, BLK + 'itemClass')
  if (!to || !item) return c.out
  const self = ctx.target
  const parents = subjects(ctx, PO_CONTAINS, self)
  const prevs = subjects(ctx, NEXT, self)
  const next = objects(ctx, self, NEXT)
  for (const t of objects(ctx, self, RDF_TYPE)) if (sub(ctx, t, BLK + 'Block')) c.remove(self, RDF_TYPE, t)
  for (const p of parents) c.remove(p, PO_CONTAINS, self)
  for (const p of prevs) c.remove(p, NEXT, self)
  for (const n of next) c.remove(self, NEXT, n)
  for (const p of [NS.c + 'expanded', NS.c + 'icon']) for (const v of objects(ctx, self, p)) c.remove(self, p, v)
  c.add(self, RDF_TYPE, item)
  if (sub(ctx, item, BLK + 'TodoItem')) c.add(self, CHECKED, c.f.literal('false', c.nn(NS.xsd + 'boolean')))
  // After a list of the kind it becomes, it joins it as its last item; else before one, as its first; else
  // it is the only item of a new one.
  const prev = prevs[0]
  if (prev && ctx.match(prev, RDF_TYPE, to).length) {
    c.add(prev, PO_CONTAINS, self)
    for (const last of objects(ctx, prev, PO_CONTAINS)) if (!objects(ctx, last, NEXT).length) c.add(last, NEXT, self)
    for (const n of next) c.add(prev, NEXT, n)
    return c.out
  }
  const after = next[0]
  if (after && ctx.match(after, RDF_TYPE, to).length) {
    c.add(after, PO_CONTAINS, self)
    const held = objects(ctx, after, PO_CONTAINS)
    for (const first of held) if (!held.some((h) => objects(ctx, h, NEXT).some((n) => n.value === first.value))) c.add(self, NEXT, first)
    for (const p of prevs) c.add(p, NEXT, after)
    return c.out
  }
  const list = c.nn(`${self.value}-list-${eventKey(ctx)}`)
  c.add(list, RDF_TYPE, to)
  c.add(list, PO_CONTAINS, self)
  for (const n of next) c.add(list, NEXT, n)
  for (const p of parents) c.add(p, PO_CONTAINS, list)
  for (const p of prevs) c.add(p, NEXT, list)
  return c.out
}

const unwrap: ReactionFn = (ctx) => {
  const to = target(ctx)
  const c = change(ctx)
  const a = ctx.target
  if (!to || sub(ctx, to, BLK + 'Item') || !isA(ctx, a, BLK + 'Item')) return c.out
  const list = subjects(ctx, PO_CONTAINS, a)[0]
  const outer = list && subjects(ctx, PO_CONTAINS, list)[0]
  if (!list || !outer) return c.out
  const pv = subjects(ctx, NEXT, a)[0]
  const nx = objects(ctx, a, NEXT)[0]
  const prevList = subjects(ctx, NEXT, list)[0]
  const nextList = objects(ctx, list, NEXT)[0]
  // The items after it, when it is in the middle: they go to a new list.
  const after: Term[] = []
  for (let x = nx; x && !after.some((y) => y.value === x!.value); x = objects(ctx, x, NEXT)[0]) after.push(x)
  for (const t of objects(ctx, a, RDF_TYPE)) c.remove(a, RDF_TYPE, t)
  for (const v of objects(ctx, a, CHECKED)) c.remove(a, CHECKED, v)
  c.remove(a, NEXT, nx)
  c.remove(list, PO_CONTAINS, a)
  c.remove(pv, NEXT, a)
  if (pv && nx) for (const m of after) c.remove(list, PO_CONTAINS, m)
  if (!pv) c.remove(prevList, NEXT, list)
  if (pv) c.remove(list, NEXT, nextList)
  if (!pv && !nx) {
    for (const q of ctx.match(list, null, null)) c.remove(list, q.predicate.value, q.object)
    c.remove(outer, PO_CONTAINS, list)
  }
  c.add(a, RDF_TYPE, to)
  for (const [p, v] of templated(ctx, to)) c.add(a, p.value, v)
  c.add(outer, PO_CONTAINS, a)
  if (!pv && nx) c.add(prevList, NEXT, a), c.add(a, NEXT, list)
  if (pv && !nx) c.add(list, NEXT, a), c.add(a, NEXT, nextList)
  if (pv && nx) {
    const fresh = c.nn(`${list.value}-${eventKey(ctx)}`)
    c.add(a, NEXT, fresh)
    for (const t of objects(ctx, list, RDF_TYPE)) c.add(fresh, RDF_TYPE, t)
    for (const m of after) c.add(fresh, PO_CONTAINS, m)
    c.add(fresh, NEXT, nextList)
    c.add(outer, PO_CONTAINS, fresh)
  }
  if (!pv && !nx) c.add(prevList, NEXT, a), c.add(a, NEXT, nextList)
  return c.out
}

const relist: ReactionFn = (ctx) => {
  const to = target(ctx)
  const c = change(ctx)
  const item = to && ctx.object(to, BLK + 'itemClass')
  if (!to || !item) return c.out
  const self = ctx.target
  const list = isA(ctx, self, BLK + 'List') ? self : subjects(ctx, PO_CONTAINS, self).find((l) => isA(ctx, l, BLK + 'List'))
  if (!list || ctx.match(list, RDF_TYPE, to).length) return c.out
  const todo = sub(ctx, item, BLK + 'TodoItem')
  for (const t of objects(ctx, list, RDF_TYPE)) if (sub(ctx, t, BLK + 'List')) c.remove(list, RDF_TYPE, t)
  c.add(list, RDF_TYPE, to)
  for (const i of objects(ctx, list, PO_CONTAINS)) {
    for (const t of objects(ctx, i, RDF_TYPE)) if (sub(ctx, t, BLK + 'Item') && t.value !== item.value) c.remove(i, RDF_TYPE, t)
    if (!todo) for (const v of objects(ctx, i, CHECKED)) c.remove(i, CHECKED, v)
    c.add(i, RDF_TYPE, item)
    if (todo && !objects(ctx, i, CHECKED).length) c.add(i, CHECKED, c.f.literal('false', c.nn(NS.xsd + 'boolean')))
  }
  return c.out
}

export const conversionReactions: Record<string, ReactionFn> = { 'blk:retype': retype, 'blk:wrap': wrap, 'blk:unwrap': unwrap, 'blk:relist': relist }
