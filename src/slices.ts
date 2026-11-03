// A large addition (the graphs a page did not need first, #209) applied as several changes, so no
// one of them is a long task (#263, #254). Each slice is a set of whole descriptions: a subject's
// triples with every blank node it reaches (a rule's sem:follows path, a shape's property list), so
// no change leaves a node half described. What defines rules (a sem:Rule, the slot it implements,
// whatever it is - a sem:Rendering, a sem:BuildingBlock -, the rule it takes its query from, a
// subclass link, a prefix declaration) comes first, in one change: the engine reads its rules again
// once (Engine.process), and the slices after it are data its rules take in incrementally.
import type { Quad } from '@rdfjs/types'
import { NS, RDF_TYPE, RDFS_SUBCLASS, SEM } from './ns.ts'

const RULE_CLASSES = new Set([SEM.Rule, NS.sem + 'Rendering', NS.sem + 'BuildingBlock'])
// A rule reads its properties from the node these name too (loadRules): that node defines it as well.
const RULE_LINKS = new Set([SEM.implements, SEM.constructFrom])
const RULE_PREDICATES = new Set([RDFS_SUBCLASS, NS.sem + 'readsLocation', NS.sem + 'readsProvenance', NS.sh + 'prefix', NS.sh + 'namespace', NS.sh + 'declare'])

export interface Slices {
  /** The descriptions that define rules (or what rules read about themselves), as one change. */
  rules: Quad[]
  /** The rest, in slices of about `size` triples (a description is never split). */
  rest: Quad[][]
}

/** Split an addition into whole descriptions: those that define rules, then the rest in slices of about `size` triples. */
export function sliceAddition(quads: readonly Quad[], size = 2000): Slices {
  // Union-find over subjects: a blank node goes with whatever states it.
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let r = k
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!
    for (let n = k; n !== r; ) {
      const next = parent.get(n)!
      parent.set(n, r)
      n = next
    }
    return r
  }
  const key = (t: Quad['subject'] | Quad['object']) => (t.termType === 'BlankNode' ? '_:' + t.value : t.value)
  for (const q of quads) {
    const s = key(q.subject)
    if (!parent.has(s)) parent.set(s, s)
    if (q.object.termType !== 'BlankNode') continue
    const o = key(q.object)
    if (!parent.has(o)) parent.set(o, o)
    const a = find(s)
    const b = find(o)
    // A named root stays the root (a blank node joins it).
    if (a !== b) a.startsWith('_:') ? parent.set(a, b) : parent.set(b, a)
  }
  const groups = new Map<string, Quad[]>()
  const definesRules = new Set<string>()
  const linked = new Set<string>()
  for (const q of quads) {
    const root = find(key(q.subject))
    let g = groups.get(root)
    if (!g) groups.set(root, (g = []))
    g.push(q)
    const p = q.predicate.value
    if (RULE_PREDICATES.has(p) || (p === RDF_TYPE && RULE_CLASSES.has(q.object.value))) definesRules.add(root)
    if (RULE_LINKS.has(p)) linked.add(key(q.object))
  }
  for (const l of linked) if (parent.has(l)) definesRules.add(find(l))
  const rules: Quad[] = []
  const rest: Quad[][] = []
  let slice: Quad[] = []
  for (const [root, g] of groups) {
    if (definesRules.has(root)) {
      rules.push(...g)
      continue
    }
    if (slice.length && slice.length + g.length > size) rest.push(slice), (slice = [])
    slice.push(...g)
  }
  if (slice.length) rest.push(slice)
  return { rules, rest }
}
