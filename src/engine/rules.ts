import type { Term } from '@rdfjs/types'
import { RDFS_SUBCLASS, RDF_TYPE, SEM, SPARQL_PREFIXES } from '../ns.ts'
import type { GraphStore } from '../store/types.ts'

export interface Rule {
  iri: string
  target: string
  stratum: number
  modality?: string
  layer?: string
  /** Abstract sem:Rendering this rule implements (or its own IRI). */
  slot: string
  kind: 'sparql' | 'function'
  /** Full query text with prefixes, split on `$this` for fast substitution. */
  queryParts?: string[]
  fn?: string
  follows: string[]
  watches?: Set<string>
  /** Re-run when other rules change nodes minted under the same focus. */
  readsMinted: boolean
  /**
   * Member-wise rule: evaluated once per (focus, member) for each `focus <forEach> member`,
   * so adding, removing or changing one member re-runs only that member's evaluation.
   */
  forEach?: string
}

export interface Selection {
  modality: string
  /** Enabled layers (IRIs). Rules without a layer always run. */
  layers: ReadonlySet<string>
  prefer: 'sparql' | 'function'
  /** Whether the store can evaluate SPARQL; slots with only SPARQL implementations are skipped otherwise. */
  sparql?: boolean
}

/** Read every sem:Rule from the ontology graph(s) loaded in the store. */
export function loadRules(store: GraphStore): Rule[] {
  const { namedNode } = store.factory
  const one = (s: Term, p: string): Term | undefined => store.match(s, namedNode(p), null)[0]?.object
  const all = (s: Term, p: string): string[] => store.match(s, namedNode(p), null).map((q) => q.object.value)

  const rules: Rule[] = []
  for (const q of store.match(null, namedNode(RDF_TYPE), namedNode(SEM.Rule))) {
    const r = q.subject
    const slot = one(r, SEM.implements)
    // Properties are read from the rule first, then from the slot it implements.
    const get = (p: string) => one(r, p) ?? (slot ? one(slot, p) : undefined)
    const getAll = (p: string) => {
      const own = all(r, p)
      return own.length || !slot ? own : all(slot, p)
    }
    const target = get(SEM.targets)
    if (!target) throw new Error(`Rule <${r.value}> has no sem:targets`)
    const query = one(r, SEM.construct)?.value
    const fn = one(r, SEM.function)?.value
    if (!query === !fn) throw new Error(`Rule <${r.value}> needs exactly one of sem:construct / sem:function`)
    const watches = getAll(SEM.watches)
    rules.push({
      iri: r.value,
      target: target.value,
      stratum: Number(get(SEM.stratum)?.value ?? 0),
      modality: get(SEM.modality)?.value,
      layer: get(SEM.layer)?.value,
      slot: slot?.value ?? r.value,
      kind: query ? 'sparql' : 'function',
      queryParts: query ? (SPARQL_PREFIXES + '\n' + query).split('$this') : undefined,
      fn,
      follows: getAll(SEM.follows),
      watches: watches.length ? new Set(watches) : undefined,
      readsMinted: get(SEM.readsMinted)?.value === 'true',
      forEach: get(SEM.forEach)?.value,
    })
  }
  return rules.sort((a, b) => a.stratum - b.stratum || a.iri.localeCompare(b.iri))
}

/** Pick the active rules: matching modality, enabled layer, one runnable implementation per slot. */
export function selectRules(rules: Rule[], sel: Selection, warn: (msg: string) => void = () => {}): Rule[] {
  const bySlot = new Map<string, Rule[]>()
  for (const r of rules) {
    if (r.modality && r.modality !== sel.modality) continue
    if (r.layer && !sel.layers.has(r.layer)) continue
    bySlot.set(r.slot, [...(bySlot.get(r.slot) ?? []), r])
  }
  const out: Rule[] = []
  for (const [slot, impls] of bySlot) {
    const runnable = sel.sparql === false ? impls.filter((r) => r.kind !== 'sparql') : impls
    if (!runnable.length) {
      warn(`<${slot}> has no implementation this store can run; skipped`)
      continue
    }
    out.push(runnable.find((r) => r.kind === sel.prefer) ?? runnable[0]!)
  }
  return out
}

/** class -> every class it is a (reflexive, transitive) subclass of. */
export function superclasses(store: GraphStore): (cls: string) => Set<string> {
  const direct = new Map<string, string[]>()
  for (const q of store.match(null, store.factory.namedNode(RDFS_SUBCLASS), null)) {
    direct.set(q.subject.value, [...(direct.get(q.subject.value) ?? []), q.object.value])
  }
  const cache = new Map<string, Set<string>>()
  return function supers(cls) {
    let out = cache.get(cls)
    if (out) return out
    out = new Set([cls])
    const todo = [cls]
    while (todo.length) for (const sup of direct.get(todo.pop()!) ?? []) if (!out.has(sup)) out.add(sup), todo.push(sup)
    cache.set(cls, out)
    return out
  }
}
