// The retention layer's function rules and reactions (ontology/layers/retention.ttl): the twin of
// c:HorizonList's SPARQL renderings, the horizon announcements and Show older.
import type { Term } from '@rdfjs/types'
import type { ReactionFn } from '../behaviour/events.ts'
import type { FnRule } from '../engine/context.ts'
import { formatLocale } from '../engine/context.ts'
import { BEH, H, MOD, NS, RDF_TYPE, SEM, XSD_INTEGER } from '../ns.ts'
import { labelOf, named, RDFS_LABEL, text } from '../components/util.ts'
import { md5Key } from '../components/data.ts'
import { TUPLE } from '../render/order-key.ts'
import { formatNumber, sortKey } from '../../rdf-engine/host/intl.ts'

const RET = NS.ret
const C = NS.c

const fill = (phrase: string, n: number, lang: string) => phrase.split('{n}').join(formatNumber(n, lang))
const count = (t: Term | undefined) => (t ? Number(t.value) || 0 : 0)

/** Every horizon (or the one c:of names): what is in memory, offloaded and no longer kept, and Show older. */
const horizonList: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  ctx.readsLanguage()
  const lang = formatLocale(ctx.languages)
  const only = ctx.objects(focus, C + 'of')
  const phrase = (name: string) => text(ctx, ctx.nn(RET + name), RDFS_LABEL) ?? ''
  const rows = ctx
    .match(null, RDF_TYPE, RET + 'Horizon')
    .map((q) => q.subject)
    .filter(named)
    .flatMap((h) => {
      const s = ctx.object(h, RET + 'of')
      if (!s || (only.length && !only.some((x) => x.value === s.value))) return []
      const label = labelOf(ctx, s)
      const inMemory = count(ctx.object(h, RET + 'inMemory'))
      const offloaded = count(ctx.object(h, RET + 'offloaded'))
      const dropped = count(ctx.object(h, RET + 'dropped'))
      const status = [fill(phrase('InMemoryPhrase'), inMemory, lang), offloaded > 0 ? fill(phrase('OffloadedPhrase'), offloaded, lang) : '', dropped > 0 ? fill(phrase('DroppedPhrase'), dropped, lang) : '']
        .filter(Boolean)
        .join(' · ')
      return [{ s, label, status, offloaded, k: 'h-' + md5Key(s.value), order: TUPLE + 's' + sortKey(label, lang) }]
    })
  if (ctx.modality === MOD.Text) {
    const root = o.el('root', 'Div')
    for (const { label, status, k, order } of rows) {
      const line = o.text(k + '-line', `${label}: ${status}\n`)
      o.t(line, SEM.orderKey, order).t(root, H.hasChild, line)
    }
    o.renders(root)
    return o.quads
  }
  const root = o.el('root', 'Ul', { 'aria-label': labelOf(ctx, ctx.nn(RET + 'Horizon')) })
  for (const { s, label, status, offloaded, k, order } of rows) {
    const older = o.el(k + '-older', 'Button', { type: 'button', class: 'sem-older', disabled: offloaded > 0 ? undefined : '' }, [o.text(k + '-older-text', phrase('ShowOlderPhrase'))])
    o.t(older, RET + 'recalls', s)
    const row = o.el(k, 'Li', {}, [
      o.el(k + '-what', 'Div', { class: 'sem-what' }, [
        o.el(k + '-label', 'Strong', {}, [o.text(k + '-label-text', label)]),
        o.el(k + '-status', 'Span', {}, [o.text(k + '-status-text', status)]),
      ]),
      older,
    ])
    o.t(row, SEM.orderKey, order)
    o.t(root, H.hasChild, row)
  }
  o.renders(root)
  return o.quads
}

/** The first event of its kind on a node says so, once: `$this <flag> <kind>` (ret:crossed, ret:warned). */
const once =
  (flag: string, kind: string): ReactionFn =>
  (ctx) => {
    const f = ctx.runtime.store.factory
    if (ctx.match(ctx.target, flag, f.namedNode(kind)).length) return { add: [], remove: [] }
    return { add: [f.quad(ctx.target, f.namedNode(flag), f.namedNode(kind))], remove: [] }
  }

/** Show older: the stream the hit button recalls, asked for its list's c:limit (50) most recent offloaded members. */
const recall: ReactionFn = (ctx) => {
  const f = ctx.runtime.store.factory
  for (let n = ctx.object(ctx.event, BEH.node), hops = 0; n && hops < 32; hops++, n = ctx.match(null, NS.rdfhtml + 'hasChild', n)[0]?.subject) {
    const s = ctx.object(n, RET + 'recalls')
    if (!s) continue
    const limit = ctx.object(ctx.target, C + 'limit')
    const amount = f.literal(limit ? limit.value : '50', f.namedNode(XSD_INTEGER))
    return { remove: ctx.match(s, RET + 'recall', null), add: [f.quad(s as never, f.namedNode(RET + 'recall'), amount)] }
  }
  return { add: [], remove: [] }
}

export const retentionFunctions: Record<string, FnRule> = { 'horizon-list': horizonList }
export const retentionReactions: Record<string, ReactionFn> = {
  'retention:crossed-offloaded': once(RET + 'crossed', RET + 'Offloaded'),
  'retention:crossed-dropped': once(RET + 'crossed', RET + 'Dropped'),
  'retention:pressure-warned': once(RET + 'warned', RET + 'Critical'),
  'retention:recall': recall,
}
