import type { NamedNode, Quad, Quad_Graph } from '@rdfjs/types'
import { H, NS, PROV, RDF_TYPE, SEM } from '../ns.ts'
import { type Delta, mint, owningFocus, quadKey } from '../rdf.ts'
import { QueryInterrupted, type GraphStore } from '../store/types.ts'
import { createContext, type FnRule, LANGUAGE, type RuleContext } from './context.ts'
import { matchesRead, type ReadPattern } from '../sparql-reads.ts'
import { loadRules, type Rule, type Selection, selectRules, superclasses } from './rules.ts'
import type { Watchdog } from './watchdog.ts'

export interface EngineOptions {
  modality: string
  layers?: Iterable<string>
  prefer?: 'sparql' | 'function'
  functions?: Record<string, FnRule>
  /** Record PROV-O provenance for every derived node (see ontology/layers/provenance.ttl). */
  provenance?: boolean
  /** Evaluate a SPARQL rule once for all dirty foci when at least this many are dirty. */
  bulkThreshold?: number
  /** Distinguishes engines sharing a store; names the derived graph. */
  name?: string
  /** Further named graphs rules read as input (e.g. the change-log LDES). */
  inputGraphs?: string[]
  /** The viewer's languages, most preferred first (see util.text and the localization layer). */
  languages?: string[]
}

export interface EngineStats {
  /** Time and (rule, focus) evaluations per rule IRI. */
  byRule: Map<string, { runs: number; ms: number }>
  ruleRuns: number
  queries: number
  bulkQueries: number
  fnCalls: number
  derivedAdded: number
  derivedRemoved: number
}

type Listener = (delta: Delta) => void

/** A (rule, focus) pair that follows queries: the triple patterns they read. */
interface Follower {
  rule: Rule
  focus: string
  reads: ReadPattern[]
}

const warn = (msg: string) => console.warn(`[semblance] ${msg}`)

/** Whether an error is a query the store's deadline stopped (QueryInterrupted, or an engine error with `interrupted`). */
const interruption = (e: unknown): boolean => e instanceof QueryInterrupted || (e as { interrupted?: boolean } | undefined)?.interrupted === true

/** A store's error, about a rule; an interruption (the store's deadline) stays one. */
function ruleError(rule: Rule, e: unknown): Error {
  if (interruption(e)) return e instanceof QueryInterrupted ? e : new QueryInterrupted(`SPARQL rule <${rule.iri}> was interrupted: ${(e as Error).message}`)
  return new Error(`SPARQL rule <${rule.iri}> failed: ${(e as Error).message}`)
}

/** Foci of a rule batch a suspended run did not evaluate; `interrupted` when a query was cut off by the store's deadline. */
interface Leftover {
  foci: Set<string>
  interrupted: boolean
}

/**
 * Member-wise rules (sem:forEach) evaluate per (focus, member); the pair is keyed
 * as "focus member" (a space never occurs in an IRI).
 */
const SEP = ' '
const focusOf = (key: string) => {
  const i = key.indexOf(SEP)
  return i < 0 ? key : key.slice(0, i)
}
const memberOf = (key: string) => {
  const i = key.indexOf(SEP)
  return i < 0 ? undefined : key.slice(i + 1)
}

/** Triples about a focus that never invalidate it: its placement and its provenance. */
const isPlacementOrProvenance = (p: string) => p.startsWith(H.ns) || p.startsWith(NS.ord) || p.startsWith(NS.prov) || p === SEM.orderKey

/**
 * Incremental, stratified projection of a component graph into RDF/HTML.
 *
 * Each (rule, focus) pair owns an output set. When input or derived triples
 * change, the affected pairs are marked dirty and re-evaluated in stratum
 * order; their outputs are diffed, reference-counted (two rules may assert the
 * same triple) and written to this engine's derived graph. Net changes of a
 * run are reported to listeners as one delta.
 */
export class Engine {
  readonly graph: NamedNode
  /** The PROV-O software agent standing for this projection. */
  readonly agent: NamedNode
  readonly stats: EngineStats = { byRule: new Map(), ruleRuns: 0, queries: 0, bulkQueries: 0, fnCalls: 0, derivedAdded: 0, derivedRemoved: 0 }
  private readonly allRules: Rule[]
  private rules: Rule[] = []
  private strata: number[] = []
  private selection: Selection
  private readonly functions: Record<string, FnRule>
  private readonly provenance: boolean
  private readonly bulkThreshold: number
  private readonly graphs: Quad_Graph[]
  private readonly supers: (cls: string) => Set<string>
  private ctx: RuleContext

  private rulesByClass = new Map<string, Rule[]>()
  private followers = new Map<string, Rule[]>()
  /** focus -> classes that have rules */
  private types = new Map<string, Set<string>>()
  /** object -> followed predicate -> subjects */
  private links = new Map<string, Map<string, Set<string>>>()
  private outputs = new Map<Rule, Map<string, Map<string, Quad>>>()
  /** Traced reads of function rules: subject -> rule -> focus -> predicates read ('*' = any). */
  private readers = new Map<string, Map<Rule, Map<string, Set<string>>>>()
  /** The inverse, to retract a pair's previous reads: rule -> focus -> subjects. */
  private readsOf = new Map<Rule, Map<string, string[]>>()
  /** Pairs that follow queries, by rule and focus, and by the predicates they read ('*' = any). */
  private queryFollowers = new Map<Rule, Map<string, Follower>>()
  private queryFollowersByPredicate = new Map<string, Set<Follower>>()
  /** Followers whose reads changed, waiting for the next frame (sem:refresh sem:NextFrame). */
  private stale = new Set<Follower>()
  /**
   * Called when work starts waiting for the next frame (once until refresh()): the host
   * schedules refresh() then.
   */
  onStale?: () => void
  private refs = new Map<string, { q: Quad; n: number }>()
  private dirty = new Map<number, Map<Rule, Set<string>>>()
  /** Member-wise rules: rule -> focus -> member keys with output (to retract them). */
  private memberKeys = new Map<Rule, Map<string, Set<string>>>()
  private current = -Infinity
  /** Whether the triple being propagated types a minted (derived) instance. */
  private derivedTrigger = false
  /** The (rule, focus) whose output is being committed: its own writes never re-dirty it. */
  private committing?: { rule: Rule; focus: string }
  /** Evaluations per (rule, focus) in the current run, to catch rules that never settle. */
  private evaluations = new Map<string, number>()
  private pending = { add: new Map<string, Quad>(), remove: new Map<string, Quad>() }
  private listeners: Listener[] = []
  /**
   * Demand-driven evaluation: when set, (rule, focus) pairs whose focus is not
   * demanded (e.g. not shown) are parked instead of evaluated, until resume().
   */
  demand?: (focus: string) => boolean
  /** Whether parked work for a focus may be evaluated in idle time (see sem:warm). */
  warmable?: (focus: string) => boolean
  private deferred = new Map<Rule, Set<string>>()
  /** While warming, parked work is evaluated regardless of demand. */
  private warming = false
  /**
   * The turn's time budget (src/engine/watchdog.ts): over it, the rest of a run's pending pairs
   * are held instead of evaluated, until the runtime continues or stops them.
   */
  watchdog?: Watchdog
  /** Pairs set aside by a suspended run, by stratum: still to evaluate. */
  private held = new Map<number, Map<Rule, Set<string>>>()
  private heldPairs = 0
  /** Pairs a stopped stall left out of date: their output is as it was before the stall. */
  private stopped = new Map<Rule, Set<string>>()
  private stoppedPairs = 0

  constructor(
    readonly store: GraphStore,
    opts: EngineOptions,
  ) {
    const f = store.factory
    this.graph = f.namedNode('urn:semblance:derived:' + (opts.name ?? 'main'))
    this.agent = f.namedNode('urn:semblance:projection:' + (opts.name ?? 'main'))
    this.graphs = [f.defaultGraph(), ...(opts.inputGraphs ?? []).map((g) => f.namedNode(g)), this.graph]
    this.functions = opts.functions ?? {}
    this.provenance = opts.provenance ?? false
    this.bulkThreshold = opts.bulkThreshold ?? 2
    this.supers = superclasses(store)
    this.allRules = loadRules(store)
    this.selection = { modality: opts.modality, layers: new Set(opts.layers ?? []), prefer: opts.prefer ?? 'sparql', sparql: store.sparql, languages: opts.languages ?? [] }
    this.ctx = createContext(store, this.graphs, opts.modality, this.selection.languages)
    this.activate(selectRules(this.allRules, this.selection, warn))
  }

  get languages(): readonly string[] {
    return this.selection.languages ?? []
  }

  get activeRules(): readonly Rule[] {
    return this.rules
  }

  /** Active rules that currently produce output for at least one focus. */
  rulesInUse(): Rule[] {
    return this.rules.filter((r) => (this.outputs.get(r)?.size ?? 0) > 0)
  }

  /** Number of distinct derived triples currently asserted. */
  get derivedSize(): number {
    return this.refs.size
  }

  /** Sizes of the engine's bookkeeping, for leak checks: all must stay bounded by what is derived. */
  footprint(): Record<string, number> {
    let outputs = 0
    for (const byFocus of this.outputs.values()) outputs += byFocus.size
    let readers = 0
    for (const byRule of this.readers.values()) for (const foci of byRule.values()) readers += foci.size
    let readsOf = 0
    for (const byFocus of this.readsOf.values()) readsOf += byFocus.size
    let deferred = 0
    for (const foci of this.deferred.values()) deferred += foci.size
    let members = 0
    for (const byOwner of this.memberKeys.values()) for (const keys of byOwner.values()) members += keys.size
    let following = 0
    for (const byFocus of this.queryFollowers.values()) following += byFocus.size
    return { refs: this.refs.size, outputs, readerSubjects: this.readers.size, readers, readsOf, deferred, members, types: this.types.size, links: this.links.size, following, stale: this.stale.size }
  }

  onChange(listener: Listener): () => void {
    this.listeners.push(listener)
    return () => (this.listeners = this.listeners.filter((l) => l !== listener))
  }

  private evaluationListeners: ((slot: string, focus: string) => void)[] = []
  /** Hear every (rule, focus) evaluation: the rendering it implements (its slot) and the focus. For tracing what a change re-ran. */
  onEvaluate(listener: (slot: string, focus: string) => void): () => void {
    this.evaluationListeners.push(listener)
    return () => (this.evaluationListeners = this.evaluationListeners.filter((l) => l !== listener))
  }

  /** Initial projection of everything already in the store. */
  start(): void {
    this.reindex()
    for (const [focus, classes] of this.types) for (const cls of classes) for (const r of this.rulesFor(cls)) this.markFocus(r, focus)
    this.run()
  }

  /** Propagate a change that has already been applied to the store's default graph. */
  process(delta: Delta): void {
    for (const q of delta.remove) this.propagate(q, -1)
    for (const q of delta.add) this.propagate(q, 1)
    this.run()
  }

  /** Whether any undemanded work is parked. */
  get hasDeferred(): boolean {
    for (const foci of this.deferred.values()) if (foci.size) return true
    return false
  }

  /**
   * Evaluate parked work regardless of demand, in small slices, for at most
   * `budgetMs` (e.g. in idle time): hidden views become ready before they are
   * shown, and interactions never pay for them. Returns whether work remains.
   */
  warm(budgetMs: number, slice = 4, only?: (focus: string) => boolean): boolean {
    if (!this.demand) return false
    const allowed = only ?? this.warmable
    const until = performance.now() + budgetMs
    this.warming = true
    try {
      while (performance.now() < until) {
        let picked = 0
        for (const [rule, foci] of this.deferred) {
          for (const focus of foci) {
            // Lazy parts stay parked until they are shown (or intended: `only`).
            if (allowed && !allowed(focusOf(focus))) continue
            foci.delete(focus)
            this.markDirty(rule, focus)
            if (++picked >= slice) break
          }
          if (picked >= slice) break
        }
        if (!picked) break
        this.run()
      }
    } finally {
      this.warming = false
    }
    return this.hasWarmable(allowed)
  }

  /** Whether parked work remains that idle time may evaluate. */
  private hasWarmable(allowed = this.warmable): boolean {
    for (const foci of this.deferred.values()) for (const focus of foci) if (!allowed || allowed(focusOf(focus))) return true
    return false
  }

  /** Evaluate parked pairs whose focus is now demanded. Returns whether anything ran. */
  resume(): boolean {
    if (!this.demand) return false
    let any = false
    for (const [rule, foci] of this.deferred) {
      for (const focus of foci) {
        if (this.demand(focusOf(focus)) || !this.isInstance(focus, rule)) {
          foci.delete(focus)
          this.markDirty(rule, focus)
          any = true
        }
      }
    }
    if (any) this.run()
    return any
  }

  /** Whether followed queries' reads changed since the last refresh() (see sem:refresh). */
  get hasStale(): boolean {
    return this.stale.size > 0
  }

  /**
   * Re-run, once each, the rules whose followed queries read triples that changed since the
   * last refresh (sem:refresh sem:NextFrame): the host calls this at its next frame, so a burst
   * of changes costs one evaluation. Returns whether anything was re-run.
   */
  refresh(): boolean {
    if (!this.stale.size) return false
    const stale = [...this.stale]
    this.stale.clear()
    for (const f of stale) this.markDirty(f.rule, f.focus)
    this.run()
    return true
  }

  /**
   * Switch modality, layers or implementation preference. Rules that are no
   * longer selected retract their output; every selected rule is re-evaluated
   * (kept rules may read what the retracted ones produced) and diffing keeps
   * the resulting delta minimal.
   */
  reconfigure(sel: Partial<Selection>): void {
    // A language change alone re-runs only what picked a text by language (util.text
    // records it as a read of LANGUAGE); everything else stays as it is.
    if (sel.languages && sel.modality === undefined && sel.prefer === undefined && sel.layers === undefined) {
      this.selection = { ...this.selection, languages: sel.languages }
      this.ctx = createContext(this.store, this.graphs, this.selection.modality, this.selection.languages)
      for (const [rule, foci] of this.readers.get(LANGUAGE) ?? []) for (const focus of foci.keys()) this.markDirty(rule, focus)
      this.run()
      return
    }
    this.selection = { ...this.selection, ...sel }
    if (sel.modality || sel.languages) this.ctx = createContext(this.store, this.graphs, this.selection.modality, this.selection.languages)
    const after = selectRules(this.allRules, this.selection, warn)
    // Swapping modality or implementations can change every output:
    // re-evaluate all. Otherwise (layers) only added rules run; rules reading what
    // changed are re-run by ordinary propagation (traced reads, sem:readsMinted).
    const full = sel.modality !== undefined || sel.prefer !== undefined
    const before = new Set(this.rules)
    const kept = new Set(full ? [] : after.filter((r) => before.has(r)))
    for (const r of this.rules) if (!kept.has(r)) for (const focus of [...(this.outputs.get(r)?.keys() ?? [])]) this.commit(r, focus, [])
    for (const r of this.rules) if (!kept.has(r)) this.outputs.delete(r), this.memberKeys.delete(r), this.forgetAllFollowing(r)
    // Keep what the retractions dirtied for rules that stay; drop the rest.
    for (const byRule of this.dirty.values()) for (const r of [...byRule.keys()]) if (!kept.has(r)) byRule.delete(r)
    this.activate(after)
    this.reindex()
    for (const [focus, classes] of this.types) for (const c of classes) for (const r of this.rulesFor(c)) if (!kept.has(r)) this.markFocus(r, focus)
    this.run()
  }

  /** Which rule produced a derived node, and for which focus. */
  explain(node: string): { rule: string; focus: string } | undefined {
    for (let focus = owningFocus(node); ; focus = owningFocus(focus)) {
      for (const [rule, byFocus] of this.outputs) {
        const keys = rule.forEach ? [...(this.memberKeys.get(rule)?.get(focus) ?? [])] : [focus]
        for (const key of keys) for (const q of byFocus.get(key)?.values() ?? []) if (q.subject.value === node) return { rule: rule.iri, focus }
      }
      if (owningFocus(focus) === focus) return undefined
    }
  }

  /** Remove everything this engine derived from the store. */
  dispose(): void {
    for (const { q } of this.refs.values()) this.store.delete(q)
    this.refs.clear()
    this.outputs.clear()
  }

  // --- rule bookkeeping ------------------------------------------------------

  private activate(rules: Rule[]) {
    this.rules = rules
    this.strata = [...new Set(rules.map((r) => r.stratum))].sort((a, b) => a - b)
    this.rulesByClass.clear()
    this.followers.clear()
    for (const r of rules) for (const p of r.follows) this.followers.set(p, [...(this.followers.get(p) ?? []), r])
    for (const r of rules) {
      if (r.kind === 'function' && !this.functions[r.fn!]) throw new Error(`No function registered for "${r.fn}" (rule <${r.iri}>)`)
      if (r.kind === 'sparql' && !this.store.sparql) throw new Error(`Store "${this.store.kind}" cannot run SPARQL rule <${r.iri}>`)
      if (r.kind === 'sparql' && r.forEach) throw new Error(`Member-wise (sem:forEach) rules must be functions (rule <${r.iri}>)`)
    }
  }

  /** Rebuild the instance and follow-link indexes from the input and derived graphs. */
  private reindex() {
    const f = this.store.factory
    this.types.clear()
    this.links.clear()
    for (const g of this.graphs) {
      for (const q of this.store.match(null, f.namedNode(RDF_TYPE), null, g)) this.index(q, 1)
      for (const p of this.followers.keys()) for (const q of this.store.match(null, f.namedNode(p), null, g)) this.index(q, 1)
    }
  }

  private rulesFor(cls: string): Rule[] {
    let rs = this.rulesByClass.get(cls)
    if (!rs) {
      const supers = this.supers(cls)
      this.rulesByClass.set(cls, (rs = this.rules.filter((r) => supers.has(r.target))))
    }
    return rs
  }

  private isInstance(focus: string, rule: Rule): boolean {
    const classes = this.types.get(focusOf(focus))
    if (classes) for (const c of classes) if (this.supers(c).has(rule.target)) return true
    return false
  }

  private watched(rule: Rule, focus: string, predicate: string): boolean {
    if (rule.watches) return rule.watches.has(predicate)
    const fn = rule.kind === 'function' ? this.functions[rule.fn!] : undefined
    return fn?.watches ? fn.watches(this.ctx, this.store.factory.namedNode(focus)).has(predicate) : true
  }

  private markDirty(rule: Rule, focus: string) {
    // Input-only rules never hear about instances other rules mint, nor about what
    // higher strata derive (they judge the input, which is settled before them).
    if (rule.inputOnly && (this.derivedTrigger || rule.stratum < this.current || !this.typedInInput(focusOf(focus)))) return
    if (rule.stratum < this.current) {
      throw new Error(`Stratification violation: stratum ${this.current} invalidated <${rule.iri}> (stratum ${rule.stratum}) for <${focus}>`)
    }
    let byRule = this.dirty.get(rule.stratum)
    if (!byRule) this.dirty.set(rule.stratum, (byRule = new Map()))
    let foci = byRule.get(rule)
    if (!foci) byRule.set(rule, (foci = new Set()))
    foci.add(focus)
    // Dirty again: it is evaluated now, not as held or stopped work.
    if (this.heldPairs && this.held.get(rule.stratum)?.get(rule)?.delete(focus)) this.heldPairs--
    if (this.stoppedPairs && this.stopped.get(rule)?.delete(focus)) this.stoppedPairs--
  }

  /** Whether a node is typed in one of the input graphs (not only by a rule's output). */
  private typedInInput(focus: string): boolean {
    const f = this.store.factory
    const s = f.namedNode(focus)
    const p = f.namedNode(RDF_TYPE)
    return this.graphs.slice(0, -1).some((g) => this.store.match(s, p, null, g).length > 0)
  }

  /** Dirty a rule for a focus: for a member-wise rule, every current and previous member. */
  private markFocus(rule: Rule, focus: string) {
    if (!rule.forEach) return this.markDirty(rule, focus)
    const f = this.store.factory
    for (const g of this.graphs) {
      for (const q of this.store.match(f.namedNode(focus), f.namedNode(rule.forEach), null, g)) {
        if (q.object.termType === 'NamedNode') this.markDirty(rule, focus + SEP + q.object.value)
      }
    }
    for (const key of this.memberKeys.get(rule)?.get(focus) ?? []) this.markDirty(rule, key)
  }

  /** Whether a member-wise pair's link (`focus forEach member`) still holds. */
  private linked(rule: Rule, key: string): boolean {
    const member = memberOf(key)
    if (!rule.forEach || member === undefined) return true
    const f = this.store.factory
    const [s, p, o] = [f.namedNode(focusOf(key)), f.namedNode(rule.forEach), f.namedNode(member)]
    return this.graphs.some((g) => this.store.match(s, p, o, g).length > 0)
  }

  // --- change propagation ----------------------------------------------------

  /** Keep the instance and follow-link indexes current. */
  private index(q: Quad, sign: 1 | -1) {
    const s = q.subject.value
    const p = q.predicate.value
    if (p === RDF_TYPE && this.rulesFor(q.object.value).length) {
      let classes = this.types.get(s)
      if (sign > 0) {
        if (!classes) this.types.set(s, (classes = new Set()))
        classes.add(q.object.value)
      } else if (classes) {
        classes.delete(q.object.value)
        if (!classes.size) this.types.delete(s)
      }
    }
    if (this.followers.has(p) && q.object.termType === 'NamedNode') {
      const o = q.object.value
      let byPred = this.links.get(o)
      if (!byPred) this.links.set(o, (byPred = new Map()))
      let subjects = byPred.get(p)
      if (!subjects) byPred.set(p, (subjects = new Set()))
      if (sign > 0) subjects.add(s)
      else {
        subjects.delete(s)
        if (!subjects.size) byPred.delete(p)
        if (!byPred.size) this.links.delete(o)
      }
    }
  }

  private propagate(q: Quad, sign: 1 | -1) {
    const outer = this.derivedTrigger
    // Only the discovery of minted instances (a derived rdf:type) is hidden from
    // input-only rules; what they read still re-runs them as usual.
    this.derivedTrigger = q.predicate.value === RDF_TYPE && q.graph.equals(this.graph)
    try {
      this.propagateQuad(q, sign)
    } finally {
      this.derivedTrigger = outer
    }
  }

  private propagateQuad(q: Quad, sign: 1 | -1) {
    const s = q.subject.value
    const p = q.predicate.value
    // Removing a type: dirty its rules while the instance is still indexed, so
    // they re-run, find the focus gone, and retract their output.
    if (p === RDF_TYPE) for (const r of this.rulesFor(q.object.value)) this.markFocus(r, s)
    if (sign < 0) this.index(q, sign)
    // A rule never reads its focus's own placement (where a parent put it) or
    // provenance, so those triples about a focus don't invalidate it.
    const classes = isPlacementOrProvenance(p) ? undefined : this.types.get(s)
    if (classes) {
      for (const c of classes) {
        for (const r of this.rulesFor(c)) {
          // A member link touches only that member's evaluation.
          if (r.forEach === p) {
            if (q.object.termType === 'NamedNode') this.markDirty(r, s + SEP + q.object.value)
          } else if (this.watched(r, s, p)) this.markFocus(r, s)
        }
      }
    }
    const back = this.links.get(s)
    if (back) {
      for (const [fp, subjects] of back) {
        for (const r of this.followers.get(fp) ?? []) {
          for (const x of subjects) if (this.isInstance(x, r) && this.watched(r, x, p)) this.markFocus(r, x)
        }
      }
    }
    // Function rules that read this subject (traced) re-run if they read this predicate.
    const readers = this.readers.get(s)
    if (readers) {
      for (const [r, foci] of readers) {
        if (r.stratum < this.current) continue
        for (const [focus, preds] of foci) {
          if (this.committing?.rule === r && this.committing.focus === focus) continue
          if (preds.has('*') || preds.has(p)) this.markDirty(r, focus)
        }
      }
    }
    // Function rules that follow a query re-run if the triple matches what it reads.
    if (this.queryFollowersByPredicate.size) {
      this.touchFollowers(this.queryFollowersByPredicate.get(p), q)
      this.touchFollowers(this.queryFollowersByPredicate.get('*'), q)
    }
    // Rules that read what was minted under their focus (e.g. the tooltip layer)
    // re-run when a lower stratum changes it.
    const owner = owningFocus(s)
    if (owner !== s) {
      const ownerClasses = this.types.get(owner)
      if (ownerClasses) {
        for (const c of ownerClasses) for (const r of this.rulesFor(c)) if (r.readsMinted && r.stratum > this.current) this.markFocus(r, owner)
      }
    }
    if (sign > 0) this.index(q, sign)
  }

  private touchFollowers(followers: Set<Follower> | undefined, q: Quad) {
    if (!followers) return
    const s = q.subject.value
    const p = q.predicate.value
    for (const f of followers) {
      if (this.stale.has(f)) continue
      if (this.committing?.rule === f.rule && this.committing.focus === f.focus) continue
      // What the rule (or a layer over it) renders under its focus is not what it read.
      const focus = focusOf(f.focus)
      if (s === focus || s.startsWith(focus + '/~')) continue
      if (!f.reads.some((r) => matchesRead(r, s, p, q.object))) continue
      if (f.rule.refresh === 'now') {
        if (f.rule.stratum >= this.current) this.markDirty(f.rule, f.focus)
      } else if (this.demand && !this.warming && !f.rule.always && !this.demand(focus)) {
        // Not shown: it waits, parked, until it is (no frame needed).
        let parked = this.deferred.get(f.rule)
        if (!parked) this.deferred.set(f.rule, (parked = new Set()))
        parked.add(f.focus)
      } else {
        const first = !this.stale.size
        this.stale.add(f)
        if (first) this.onStale?.()
      }
    }
  }

  /** Replace a (rule, focus) pair's followed query reads. */
  private recordFollowing(rule: Rule, focus: string, reads: ReadPattern[]) {
    this.forgetFollowing(rule, focus)
    if (!reads.length) return
    const f: Follower = { rule, focus, reads }
    let byFocus = this.queryFollowers.get(rule)
    if (!byFocus) this.queryFollowers.set(rule, (byFocus = new Map()))
    byFocus.set(focus, f)
    for (const p of new Set(reads.map((r) => r.p ?? '*'))) {
      let set = this.queryFollowersByPredicate.get(p)
      if (!set) this.queryFollowersByPredicate.set(p, (set = new Set()))
      set.add(f)
    }
  }

  private forgetFollowing(rule: Rule, focus: string) {
    const byFocus = this.queryFollowers.get(rule)
    const f = byFocus?.get(focus)
    if (!f) return
    byFocus!.delete(focus)
    if (!byFocus!.size) this.queryFollowers.delete(rule)
    this.stale.delete(f)
    for (const p of new Set(f.reads.map((r) => r.p ?? '*'))) {
      const set = this.queryFollowersByPredicate.get(p)
      set?.delete(f)
      if (set && !set.size) this.queryFollowersByPredicate.delete(p)
    }
  }

  private forgetAllFollowing(rule: Rule) {
    for (const focus of [...(this.queryFollowers.get(rule)?.keys() ?? [])]) this.forgetFollowing(rule, focus)
  }

  // --- evaluation ------------------------------------------------------------

  private run() {
    const wd = this.watchdog
    if (wd) return wd.turn(() => this.runWatched(wd))
    try {
      for (const stratum of this.strata) {
        this.current = stratum
        for (let batch = this.dirty.get(stratum); batch?.size; batch = this.dirty.get(stratum)) {
          this.dirty.set(stratum, new Map())
          for (const [rule, foci] of batch) this.evaluate(rule, foci)
        }
      }
    } finally {
      this.current = -Infinity
      this.evaluations.clear()
    }
    this.emit()
  }

  /**
   * A run within a turn's budget. Between rule batches (and every few evaluations within one) the
   * watchdog is asked whether the turn is over budget; if it is, everything still dirty is held:
   * set aside, as it is, until continueHeld() or stopHeld(). Strata below the one it stopped in are
   * complete; every derived triple comes from a complete evaluation. What changed so far is
   * reported as usual, so the page shows it (and can show that it is not finished).
   */
  private runWatched(wd: Watchdog) {
    let suspended = false
    let interrupted = false
    const ms = wd.remaining()
    if (ms !== undefined) this.store.setDeadline?.(Date.now() + ms)
    try {
      outer: for (const stratum of this.strata) {
        this.current = stratum
        for (let batch = this.dirty.get(stratum); batch?.size; batch = this.dirty.get(stratum)) {
          this.dirty.set(stratum, new Map())
          // Over budget: this rule's unevaluated foci, and the rules after it in the batch, are held.
          let stop: Rule | undefined
          let left: Leftover | undefined
          for (const [rule, foci] of batch) {
            if (stop) {
              if (foci.size) this.hold(rule, foci)
              continue
            }
            if (wd.due()) {
              stop = rule
              if (foci.size) this.hold(rule, foci)
              continue
            }
            left = this.evaluate(rule, foci)
            if (left) (stop = rule), this.hold(rule, left.foci), (interrupted = left.interrupted)
          }
          if (stop) {
            suspended = true
            break outer
          }
        }
      }
    } finally {
      this.current = -Infinity
      this.evaluations.clear()
      if (ms !== undefined) this.store.setDeadline?.(undefined)
    }
    if (suspended) {
      // Everything else that is dirty waits too (higher strata read what is held).
      for (const [stratum, byRule] of this.dirty) for (const [r, fs] of byRule) if (fs.size) this.hold(r, fs, stratum)
      this.dirty.clear()
      wd.suspended(this, interrupted)
    }
    this.emit()
  }

  private hold(rule: Rule, foci: Iterable<string>, stratum = rule.stratum) {
    let byRule = this.held.get(stratum)
    if (!byRule) this.held.set(stratum, (byRule = new Map()))
    let set = byRule.get(rule)
    if (!set) byRule.set(rule, (set = new Set()))
    for (const f of foci) if (!set.has(f)) set.add(f), this.heldPairs++
  }

  /** (rule, focus) pairs a suspended run set aside, still to evaluate. */
  get heldCount(): number {
    return this.heldPairs
  }

  /** Pairs a stopped stall left out of date. */
  get stoppedCount(): number {
    return this.stoppedPairs
  }

  /** The foci of held (or stopped) pairs, at most `n`: what is out of date. */
  heldFoci(n = 50, which: 'held' | 'stopped' = 'held'): string[] {
    const out = new Set<string>()
    const sets = which === 'held' ? [...this.held.values()].flatMap((m) => [...m.values()]) : [...this.stopped.values()]
    for (const fs of sets) for (const f of fs) if (out.add(focusOf(f)).size >= n) return [...out]
    return [...out]
  }

  /**
   * Evaluate held work, within the open turn (a slice: the runtime calls this in a turn with a
   * small budget, and yields between slices). Returns whether work is still held.
   */
  continueHeld(): boolean {
    if (!this.heldPairs) return false
    for (const [stratum, byRule] of this.held) for (const [r, fs] of byRule) for (const f of fs) this.markDirtyAt(r, f, stratum)
    this.held.clear()
    this.heldPairs = 0
    this.run()
    if (!this.heldPairs) this.watchdog?.released(this)
    return this.heldPairs > 0
  }

  /**
   * Drop held work: the stall is stopped. Pairs whose focus is gone (or no longer linked) are
   * retracted, which costs no query, so nothing is shown for what no longer exists; the rest keep
   * the output of their last complete evaluation and are recorded as stopped (out of date) until
   * their input changes again (they are then evaluated as usual) or retryStopped() runs them.
   * What the retractions dirty is stopped too: stopping evaluates nothing.
   */
  stopHeld(): number {
    const held = this.held
    this.held = new Map()
    this.heldPairs = 0
    const stop = (rule: Rule, focus: string) => {
      let set = this.stopped.get(rule)
      if (!set) this.stopped.set(rule, (set = new Set()))
      if (!set.has(focus)) set.add(focus), this.stoppedPairs++
    }
    for (const byRule of held.values()) {
      for (const [rule, foci] of byRule) {
        for (const focus of foci) {
          if (!this.isInstance(focus, rule) || !this.linked(rule, focus)) this.commit(rule, focus, [])
          else stop(rule, focus)
        }
      }
    }
    for (const byRule of this.dirty.values()) for (const [rule, foci] of byRule) for (const focus of foci) stop(rule, focus)
    this.dirty.clear()
    this.watchdog?.released(this)
    this.emit()
    return this.stoppedPairs
  }

  /** Evaluate the pairs a stopped stall left out of date (under the turn's budget, as any run). */
  retryStopped(): void {
    if (!this.stoppedPairs) return
    const stopped = this.stopped
    this.stopped = new Map()
    this.stoppedPairs = 0
    for (const [rule, foci] of stopped) for (const focus of foci) this.markDirty(rule, focus)
    this.run()
  }

  /** Dirty a pair at the stratum it was held in (the stratum check passed when it was first dirtied). */
  private markDirtyAt(rule: Rule, focus: string, stratum: number) {
    let byRule = this.dirty.get(stratum)
    if (!byRule) this.dirty.set(stratum, (byRule = new Map()))
    let foci = byRule.get(rule)
    if (!foci) byRule.set(rule, (foci = new Set()))
    foci.add(focus)
  }

  /** Report the run's net change to listeners. */
  private emit() {
    const { add, remove } = this.pending
    if (!add.size && !remove.size) return
    this.pending = { add: new Map(), remove: new Map() }
    const delta = { add: [...add.values()], remove: [...remove.values()] }
    for (const l of this.listeners) l(delta)
  }

  private evaluate(rule: Rule, foci: Set<string>): Leftover | undefined {
    const t = performance.now()
    const wd = this.watchdog
    const w0 = wd ? wd.clock() : 0
    let left: Leftover | undefined
    try {
      left = this.evaluateAll(rule, foci)
      return left
    } finally {
      // What was evaluated: the foci left in the set (parked ones were taken out), less those held.
      const n = foci.size - (left?.foci.size ?? 0)
      const entry = this.stats.byRule.get(rule.iri) ?? { runs: 0, ms: 0 }
      const ms = performance.now() - t
      // (rule, focus) evaluations, whether one query answered several of them or not.
      entry.runs += n
      entry.ms += ms
      this.stats.byRule.set(rule.iri, entry)
      if (wd) wd.note('rule', rule.iri, wd.focus, n, wd.clock() - w0)
    }
  }

  private evaluateAll(rule: Rule, foci: Set<string>): Leftover | undefined {
    const wd = this.watchdog
    if (wd) (wd.rule = rule.iri), (wd.focus = foci.values().next().value)
    if (this.demand && !this.warming && !rule.always) {
      // Park undemanded foci (retractions always run, so nothing stale stays visible).
      let parked = this.deferred.get(rule)
      for (const focus of [...foci]) {
        if (this.isInstance(focus, rule) && !this.demand(focusOf(focus))) {
          if (!parked) this.deferred.set(rule, (parked = new Set()))
          parked.add(focus)
          foci.delete(focus)
        }
      }
      if (!foci.size) return
      for (const focus of foci) parked?.delete(focus)
    }
    // A rule that requires a property its focus doesn't have (or is not for one it has) has nothing to say about it.
    if (rule.requires.length || rule.unless.length) {
      for (const focus of [...foci]) {
        const node = focusOf(focus)
        if ((rule.requires.length && !this.hasAny(node, rule.requires)) || (rule.unless.length && this.hasAny(node, rule.unless))) {
          this.commit(rule, focus, [])
          foci.delete(focus)
        }
      }
      if (!foci.size) return
    }
    // Several foci of an attributable SPARQL rule: one query, restricted to them (VALUES).
    if (rule.kind === 'sparql' && rule.bulk && foci.size >= this.bulkThreshold) {
      const live = [...foci].filter((focus) => this.isInstance(focus, rule))
      let groups: Map<string, Quad[]>
      try {
        groups = live.length ? this.bulk(rule, live) : new Map<string, Quad[]>()
      } catch (e) {
        // The store's deadline interrupted the query: the whole batch waits, uncommitted.
        if (wd && interruption(e)) return { foci: new Set(foci), interrupted: true }
        throw e
      }
      this.stats.ruleRuns += live.length
      for (const focus of foci) this.commit(rule, focus, this.isInstance(focus, rule) ? (groups.get(focus) ?? []) : [])
      if (wd) wd.evaluated(live.length)
      return
    }
    if (!wd) {
      for (const focus of foci) this.commit(rule, focus, this.isInstance(focus, rule) && this.linked(rule, focus) ? this.evaluateOne(rule, focus) : [])
      return
    }
    // Watched: every few evaluations the clock is read; over budget, the rest of the foci wait.
    let left: Leftover | undefined
    for (const focus of foci) {
      if (left) {
        left.foci.add(focus)
        continue
      }
      wd.focus = focus
      let quads: Quad[]
      try {
        quads = this.isInstance(focus, rule) && this.linked(rule, focus) ? this.evaluateOne(rule, focus) : []
      } catch (e) {
        // A query the store's deadline stopped (in a SPARQL rule, or one a function rule ran).
        if (!interruption(e)) throw e
        left = { foci: new Set([focus]), interrupted: true }
        continue
      }
      this.commit(rule, focus, quads)
      if (wd.check()) left = { foci: new Set(), interrupted: false }
    }
    return left?.foci.size ? left : undefined
  }

  private evaluateOne(rule: Rule, focus: string): Quad[] {
    this.stats.ruleRuns++
    if (rule.kind === 'function') {
      this.stats.fnCalls++
      const trace = new Map<string, Set<string>>()
      const reads: ReadPattern[] = []
      this.ctx.trace = trace
      this.ctx.queryReads = reads
      try {
        const f = this.store.factory
        const member = memberOf(focus)
        return this.functions[rule.fn!]!(this.ctx, f.namedNode(focusOf(focus)), member === undefined ? undefined : f.namedNode(member))
      } finally {
        this.ctx.trace = this.ctx.queryReads = undefined
        this.recordReads(rule, focus, trace)
        if (reads.length || this.queryFollowers.has(rule)) this.recordFollowing(rule, focus, reads)
      }
    }
    this.stats.queries++
    if (this.store.constructFor) return this.constructFor(rule, [focus])
    return this.construct(rule, rule.queryParts!.join('<' + focus + '>'))
  }

  /** Drop a (rule, focus) pair's traced reads. */
  private forgetReads(rule: Rule, focus: string) {
    const byFocus = this.readsOf.get(rule)
    for (const subject of byFocus?.get(focus) ?? []) {
      const byRule = this.readers.get(subject)
      const foci = byRule?.get(rule)
      if (!foci) continue
      foci.delete(focus)
      if (!foci.size) byRule!.delete(rule)
      if (!byRule!.size) this.readers.delete(subject)
    }
    byFocus?.delete(focus)
  }

  /** Replace a (rule, focus) pair's traced reads. */
  private recordReads(rule: Rule, focus: string, trace: Map<string, Set<string>>) {
    this.forgetReads(rule, focus)
    let byFocus = this.readsOf.get(rule)
    if (!byFocus) this.readsOf.set(rule, (byFocus = new Map()))
    trace.delete(focusOf(focus)) // the focus's own triples are covered by its self-watch
    if (!trace.size) return
    byFocus.set(focus, [...trace.keys()])
    for (const [subject, preds] of trace) {
      let byRule = this.readers.get(subject)
      if (!byRule) this.readers.set(subject, (byRule = new Map()))
      let foci = byRule.get(rule)
      if (!foci) byRule.set(rule, (foci = new Map()))
      foci.set(focus, preds)
    }
  }

  /** Whether a node has at least one of the properties (in any graph the rules read). */
  private hasAny(focus: string, properties: string[]): boolean {
    const f = this.store.factory
    const s = f.namedNode(focus)
    return properties.some((p) => this.graphs.some((g) => this.store.match(s, f.namedNode(p), null, g).length > 0))
  }

  private bulk(rule: Rule, foci: string[]): Map<string, Quad[]> {
    this.stats.bulkQueries++
    const groups = new Map<string, Quad[]>()
    if (this.store.constructFor) {
      for (const q of this.constructFor(rule, foci)) {
        const focus = owningFocus(q.subject.value)
        let g = groups.get(focus)
        if (!g) groups.set(focus, (g = []))
        g.push(q)
      }
      return groups
    }
    // Restrict ?this to the dirty foci, at the start of the WHERE clause.
    const query = rule.queryParts!.join('?this')
    const template = query.search(/CONSTRUCT\s*\{/i)
    const where = query.slice(template).search(/WHERE\s*\{/i)
    const at = where < 0 ? -1 : template + where + query.slice(template + where).indexOf('{') + 1
    const restricted = at < 0 ? query : `${query.slice(0, at)} VALUES ?this { ${foci.map((x) => `<${x}>`).join(' ')} } ${query.slice(at)}`
    for (const q of this.construct(rule, restricted)) {
      const focus = owningFocus(q.subject.value)
      let g = groups.get(focus)
      if (!g) groups.set(focus, (g = []))
      g.push(q)
    }
    return groups
  }

  private constructFor(rule: Rule, foci: string[]): Quad[] {
    const f = this.store.factory
    try {
      return this.store.constructFor!(rule.queryParts!.join('?this'), 'this', foci.map((x) => f.namedNode(x)), this.graphs)
    } catch (e) {
      throw ruleError(rule, e)
    }
  }

  private construct(rule: Rule, query: string): Quad[] {
    try {
      return this.store.construct(query, this.graphs)
    } catch (e) {
      throw ruleError(rule, e)
    }
  }

  private commit(rule: Rule, focus: string, quads: Quad[]) {
    for (const l of this.evaluationListeners) l(rule.slot, focus)
    const pair = rule.iri + ' ' + focus
    const n = (this.evaluations.get(pair) ?? 0) + 1
    this.evaluations.set(pair, n)
    if (n > 100) throw new Error(`Rule <${rule.iri}> does not settle for <${focus}>: its output keeps invalidating itself`)
    let byFocus = this.outputs.get(rule)
    if (!byFocus) this.outputs.set(rule, (byFocus = new Map()))
    const prev = byFocus.get(focus)
    const next = new Map<string, Quad>()
    const f = this.store.factory
    for (const q of quads) {
      if (q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode') {
        throw new Error(`Rule <${rule.iri}> emitted a blank node for <${focus}>; mint IRIs instead`)
      }
      next.set(quadKey(q), q)
    }
    if (this.provenance && next.size) for (const p of this.provenanceOf(rule, focus, quads)) next.set(quadKey(p), p)
    this.committing = { rule, focus }
    try {
      if (prev) for (const [k, q] of prev) if (!next.has(k)) this.release(k, q)
      for (const [k, q] of next) if (!prev?.has(k)) this.retain(k, q)
    } finally {
      this.committing = undefined
    }
    if (next.size) byFocus.set(focus, next)
    else {
      byFocus.delete(focus)
      // A pair with nothing to show no longer needs to hear about what it read,
      // unless it is still an instance (its next input may produce output).
      if (!this.isInstance(focus, rule) || !this.linked(rule, focus)) this.forgetReads(rule, focus), this.forgetFollowing(rule, focus)
    }
    if (rule.forEach && memberOf(focus) !== undefined) {
      let byOwner = this.memberKeys.get(rule)
      if (!byOwner) this.memberKeys.set(rule, (byOwner = new Map()))
      const owner = focusOf(focus)
      let keys = byOwner.get(owner)
      if (next.size) {
        if (!keys) byOwner.set(owner, (keys = new Set()))
        keys.add(focus)
      } else if (keys) {
        keys.delete(focus)
        if (!keys.size) byOwner.delete(owner)
      }
    }
  }

  /**
   * PROV-O for one (rule, focus) evaluation: an activity that used the focus
   * and the nodes the rule follows, carried out by this projection with the
   * rule as its plan. Nodes the output types were generated by the activity;
   * other nodes it wrote to (decorations) were influenced by it.
   */
  private provenanceOf(rule: Rule, focus: string, quads: Quad[]): Quad[] {
    const f = this.store.factory
    const nn = (iri: string) => f.namedNode(iri)
    const g = this.graph
    const local = rule.iri.slice(Math.max(rule.iri.lastIndexOf('#'), rule.iri.lastIndexOf('/')) + 1)
    const member = memberOf(focus)
    focus = focusOf(focus)
    const activity = nn(mint(focus, 'prov-' + encodeURIComponent(local) + (member === undefined ? '' : '-' + encodeURIComponent(member))))
    const association = nn(activity.value + '-association')
    const out = [
      f.quad(activity, nn(RDF_TYPE), nn(PROV.Activity), g),
      f.quad(activity, nn(PROV.wasAssociatedWith), this.agent, g),
      f.quad(this.agent, nn(RDF_TYPE), nn(PROV.SoftwareAgent), g),
      f.quad(activity, nn(PROV.qualifiedAssociation), association, g),
      f.quad(association, nn(RDF_TYPE), nn(PROV.Association), g),
      f.quad(association, nn(PROV.agent), this.agent, g),
      f.quad(association, nn(PROV.hadPlan), nn(rule.iri), g),
      f.quad(activity, nn(PROV.used), nn(focus), g),
      ...(member === undefined ? [] : [f.quad(activity, nn(PROV.used), nn(member), g)]),
    ]
    for (const p of rule.follows) {
      for (const q of this.store.match(nn(focus), nn(p), null)) if (q.object.termType === 'NamedNode') out.push(f.quad(activity, nn(PROV.used), q.object, g))
    }
    // Text nodes and attribute occurrences are covered by their element's provenance.
    const generated = new Set<string>()
    const minor = new Set<string>()
    for (const q of quads) {
      if (q.predicate.value !== RDF_TYPE || q.subject.value === focus) continue
      if (q.object.value === H.Text || q.object.value === H.Attribute) minor.add(q.subject.value)
      else generated.add(q.subject.value)
    }
    const touched = new Set(quads.map((q) => q.subject.value).filter((s) => !minor.has(s)))
    for (const s of touched) {
      if (s === focus) continue
      out.push(f.quad(nn(s), nn(generated.has(s) ? PROV.wasGeneratedBy : PROV.wasInfluencedBy), activity, g))
    }
    return out
  }

  private retain(key: string, q: Quad) {
    const ref = this.refs.get(key)
    if (ref) return void ref.n++
    const f = this.store.factory
    const stored = q.graph.equals(this.graph) ? q : f.quad(q.subject, q.predicate, q.object, this.graph)
    this.store.add(stored)
    this.refs.set(key, { q: stored, n: 1 })
    this.stats.derivedAdded++
    if (!this.pending.remove.delete(key)) this.pending.add.set(key, stored)
    this.propagate(stored, 1)
  }

  private release(key: string, _q: Quad) {
    const ref = this.refs.get(key)!
    if (--ref.n) return
    this.store.delete(ref.q)
    this.refs.delete(key)
    this.stats.derivedRemoved++
    if (!this.pending.add.delete(key)) this.pending.remove.set(key, ref.q)
    this.propagate(ref.q, -1)
  }
}
