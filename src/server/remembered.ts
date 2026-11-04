// What a page can put back before its first paint (src/web/remembered.ts), read from the graph: the
// per:Policy nodes in a scope with a Web Storage object (per:webStorage: IndexedDB cannot be read
// synchronously), that remember a hooked property (sty:hookAttribute) of one subject (per:subject;
// what a CONSTRUCT remembers cannot be told without running it). The subject is the document, when
// the document's attributes carry its hook, or the mounted root, whose rendered element is known
// without a marker. Which key, which version and which values come from the graph; the script holds
// no name of its own.
import { NS, RDF_TYPE, SEM, STY } from '../ns.ts'
import { Persistence, STORAGE_PREFIX } from '../persistence.ts'
import type { GraphStore } from '../store/types.ts'
import type { FirstPaintPlan, FirstPaintPolicy, RememberedHook } from '../web/remembered.ts'

export type RememberedPolicy = Omit<FirstPaintPolicy, 'hooks'> & { hooks: (RememberedHook & { root: boolean })[] }

/** The policies that can be put back before the first paint, with the hooks they cover. */
export function rememberedPolicies(store: GraphStore, root: string): RememberedPolicy[] {
  const f = store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const one = (s: Parameters<GraphStore['match']>[0], p: string) => store.match(s, nn(p), null)[0]?.object
  const out: RememberedPolicy[] = []
  for (const policy of new Persistence(store, {}).policies()) {
    if (policy.dimension || !policy.subject || !policy.properties.length) continue
    const storage = one(nn(policy.scope), NS.per + 'webStorage')?.value
    if (!storage) continue
    const hooks = policy.properties.flatMap((property): RememberedPolicy['hooks'] => {
      const attribute = one(nn(property), STY.hookAttribute)?.value
      const range = one(nn(property), NS.rdfs + 'range')
      if (!attribute || !range) return []
      const values: Record<string, string> = {}
      const schemes: Record<string, string> = {}
      for (const { subject: v } of store.match(null, nn(RDF_TYPE), range)) {
        const slug = one(v, SEM.slug)?.value
        if (!slug) continue
        values[v.value] = slug
        for (const { object: d } of store.match(v, nn(STY.declares), null)) {
          if (one(d, STY.property)?.value === 'color-scheme') schemes[v.value] = one(d, STY.raw)?.value ?? ''
        }
      }
      return [{ subject: policy.subject!.value, property, attribute, values, root: policy.subject!.value === root, ...(Object.keys(schemes).length && { schemes }) }]
    })
    if (hooks.length) out.push({ iri: policy.iri, storage, version: policy.version, ...(policy.retentionMs !== undefined && { retentionMs: policy.retentionMs }), ...(!policy.enabled && { off: true as const }), hooks })
  }
  return out
}

/** Where each hook lands in this document; what lands nowhere is left out. Undefined when nothing does. */
export function firstPaintPlan(remembered: RememberedPolicy[], mount: string, attributes: Record<string, string>): FirstPaintPlan | undefined {
  const policies = remembered.flatMap((p): FirstPaintPolicy[] => {
    const hooks = p.hooks.flatMap(({ root, schemes, ...h }): RememberedHook[] => {
      if (root) return [h]
      return h.attribute in attributes ? [{ ...h, ...(schemes && { schemes }), document: true }] : []
    })
    return hooks.length ? [{ ...p, hooks }] : []
  })
  return policies.length ? { mount, prefix: STORAGE_PREFIX, enabled: STORAGE_PREFIX + 'enabled', policies } : undefined
}

/** The CSS color scheme the document says now, for the <meta> that colours the page before its stylesheet. */
export function documentScheme(remembered: RememberedPolicy[], attributes: Record<string, string>): string | undefined {
  for (const p of remembered) {
    for (const h of p.hooks) {
      if (h.root || !h.schemes || !(h.attribute in attributes)) continue
      const value = Object.keys(h.values).find((v) => h.values[v] === attributes[h.attribute])
      if (value && h.schemes[value]) return h.schemes[value]
    }
  }
  return undefined
}
