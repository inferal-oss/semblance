// A large addition (the graphs a page did not need first, #209) applied as several changes, so no
// one of them is a long task (#263, #254). Each slice is a set of whole descriptions: a subject's
// triples with every blank node it reaches (a rule's sem:follows path, a shape's property list), so
// no change leaves a node half described. What defines rules (a sem:Rule, the slot it implements,
// whatever it is - a sem:Rendering, a sem:BuildingBlock -, the rule it takes its query from, a
// subclass link, a prefix declaration) comes first, in one change: the engine reads its rules again
// once (Engine.process), and the slices after it are data its rules take in incrementally. SHACL
// shapes come with them: a shape names others (sh:or), so the shapes layer judges by all or none.
import type { Quad } from '@rdfjs/types'
import { NS, RDF_TYPE, RDFS_SUBCLASS, SEM } from './ns.ts'

const RULE_CLASSES = new Set([SEM.Rule, NS.sem + 'Rendering', NS.sem + 'BuildingBlock', NS.sh + 'NodeShape', NS.sh + 'PropertyShape'])
// A rule reads its properties from the node these name too (loadRules): that node defines it as well.
const RULE_LINKS = new Set([SEM.implements, SEM.constructFrom])
const RULE_PREDICATES = new Set([RDFS_SUBCLASS, NS.sem + 'readsLocation', NS.sem + 'readsProvenance', NS.sh + 'prefix', NS.sh + 'namespace', NS.sh + 'declare', NS.sh + 'targetClass'])

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

/** What takes an addition in (arrive): the runtime, idle periods, and the DOM to patch. */
export interface Arrival {
  runtime: { apply(delta: { add: Quad[]; remove: Quad[] }): unknown; arriving(on: boolean): void }
  /** The next idle period. */
  idle(): Promise<{ timeRemaining(): number }>
  /**
   * What of what is left is needed now, the visitor having moved to another page: nothing (false);
   * the triples a test picks (those of the graphs that page needs, Site.pageGraphs); or all of it
   * (true: what that page needs is not known). The same test is taken in once.
   */
  urgent(): boolean | ((q: Quad) => boolean)
  /**
   * The next task once the browser has had its turn, with the time to spend in it: what is left
   * when all of it is needed goes a few slices per task. Without it, all of it goes in at once.
   */
  task?(): Promise<{ timeRemaining(): number }>
  /** Patch the DOM after a change. */
  flush(): void
}

/**
 * Take sliced additions in through the runtime: what defines rules at once, then as many slices
 * per idle period as fit in it. Once the visitor moves to another page, what it needs of what is
 * left (`urgent`) goes in at once, as one change, and as if it were all (what is due over the
 * whole graph is evaluated, what was evaluated before is again); the rest follows as before. That
 * page may show what is among it (an example reached from another page, #378), and would otherwise
 * stay empty until the last slice, seconds later where idle periods are few or short; all of the
 * rest at once was a task of a second (#420). When what it needs is not known, the rest goes a few
 * slices per task.
 */
export async function arrive({ rules, rest }: Slices, a: Arrival): Promise<void> {
  a.runtime.arriving(true)
  a.runtime.apply({ add: rules, remove: [] })
  a.flush()
  let left = rest
  let i = 0
  const taken = new Set<(q: Quad) => boolean>()
  // What the page shown needs, not yet taken in (all of the rest: true).
  const pending = (): false | true | ((q: Quad) => boolean) => {
    const u = a.urgent()
    return u === true || (typeof u === 'function' && !taken.has(u) && u)
  }
  // What the page shown needs goes in at once, as one change and a task of its own (true if it did).
  const take = (): boolean => {
    const u = pending()
    if (typeof u !== 'function') return false
    taken.add(u)
    const now: Quad[] = []
    left = left.slice(i).map((s) => s.filter((q) => !u(q) || (now.push(q), false))).filter((s) => s.length)
    i = 0
    if (!now.length) return false
    // What the page needs has arrived: what is due over the whole graph is evaluated, and what was
    // evaluated before is again (the page is the page loaded directly); the rest is a new arrival.
    a.runtime.apply({ add: now, remove: [] })
    a.runtime.arriving(false)
    a.runtime.arriving(true)
    a.flush()
    return true
  }
  while (i < left.length) {
    if (pending() === true && !a.task) {
      a.runtime.apply({ add: left.slice(i).flat(), remove: [] })
      a.flush()
      break
    }
    const deadline = await (pending() && a.task ? a.task() : a.idle())
    // (The visitor may have moved meanwhile.)
    if (take() || (pending() === true && !a.task)) continue
    while (i < left.length) {
      a.runtime.apply({ add: left[i++]!, remove: [] })
      if (deadline.timeRemaining() <= 8 || typeof pending() === 'function') break
    }
    a.flush()
  }
  a.runtime.arriving(false)
  a.flush()
}
