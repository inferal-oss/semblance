import type { Term } from '@rdfjs/types'
import { RDF_FIRST, RDF_NIL, RDF_REST, RDFS_SUBCLASS, RDF_TYPE, SEM } from '../ns.ts'
import { prefixesFor } from '../prefixes.ts'
import { queryReads } from '../sparql-reads.ts'
import { prefixMap } from '../view/compile.ts'
import { focusPredicates } from './focus-predicates.ts'
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
  /**
   * Paths of followed predicates (sem:follows given an RDF list): a change on a node reached
   * from the focus along a path, or on any node on the way, makes the focus dirty. A step
   * "*p" is any number of p steps (sem:zeroOrMore); "^p" is a step against p (sem:inverse); a last
   * step "^@q r" is against the predicate the focus names along q r (sem:inverseVia).
   */
  followPaths: string[][]
  /**
   * The predicates whose changes (on the focus, or on a followed node) make the focus dirty:
   * sem:watches, else, for a SPARQL rule, every predicate its query names (with what it requires,
   * is stopped by and follows), when it names them all. Absent: any predicate.
   */
  watches?: Set<string>
  /**
   * Paths from the focus to predicates the rule reads too (with `watches`; a step "^p" goes against
   * p): a SPARQL rule whose variable predicates come from its focus (`$this c:property ?p . ?target
   * ?p ?value`, focus-predicates.ts) watches, per focus, the predicates its focus names there.
   */
  watchesVia?: string[][]
  /** Predicates that have one of these properties are read too (with `watches`): `$this ?p ?v . ?p sty:hookAttribute ?name`. */
  watchesMarked?: string[]
  /**
   * sem:watchesAnywhere: predicates the rule reads on any node (a list of every shortcut, of every
   * shape result): a change to a triple with one of them makes each of its foci due.
   */
  anywhere: string[]
  /**
   * sem:watchesStatements: its focus is a property, and the rule reads the statements made with it
   * on any node (`?s $this ?o`): a change to one makes that focus dirty.
   */
  watchesStatements: boolean
  /**
   * sem:watchesManyValued: the rule reads, on any node, the statements made with each predicate that
   * has one of these properties, and says something only about a node with two values or more of
   * one: a change in the input to such a node's values makes each of its foci due.
   */
  manyValued: string[]
  /** Re-run when other rules change nodes minted under the same focus. */
  readsMinted: boolean
  /**
   * Member-wise rule: evaluated once per (focus, member) for each `focus <forEach> member`,
   * so adding, removing or changing one member re-runs only that member's evaluation.
   * A function rule gets the member as an argument; a SPARQL rule as `$member`, which is
   * substituted like `$this`.
   */
  forEach?: string
  /**
   * Which of its member's predicates a member-wise SPARQL rule reads: these
   * (sem:memberWatches), and the values of these focus properties (sem:memberWatchesVia,
   * for predicates the data names, such as a list's c:sortBy). Absent: all of them.
   */
  memberWatches?: { predicates: Set<string>; via: string[] }
  /**
   * Applies only to instances typed in the input graphs, not to ones other rules
   * mint (pre-render rules in strata below the components: localization, validation).
   */
  inputOnly: boolean
  /**
   * Evaluated whether or not its focus is shown (sem:always): state derived about a node no
   * projection shows (a nav:Location, a phrase, the viewer), which shown components read.
   */
  always?: boolean
  /**
   * Whether a SPARQL rule may be evaluated once for many foci (bulk). Only if every
   * subject its template writes is the focus or a node minted under it, so the output
   * can be grouped back by focus (see attributable()); sem:bulk false opts out.
   */
  bulk: boolean
  /** The focus must have at least one of these properties, or the rule is not run (sem:requires). */
  requires: string[]
  /** The focus must have none of these properties, or the rule is not run (sem:unless). */
  unless: string[]
  /**
   * SPARQL extension groups the rule's query uses (sem:needsExtension, `sx:Math` …; the
   * engine's EXTENSIONS.md): it is chosen only on a store that has them all (GraphStore.extensions).
   */
  needs: string[]
  /**
   * When a triple a query the rule followed reads changes (RuleContext.select with follow):
   * re-run it in the same run ('now'), or at the host's next frame, once for all such changes
   * ('frame', sem:refresh sem:NextFrame).
   */
  refresh: 'now' | 'frame'
  /**
   * A SPARQL rule that reads the viewer's language preferences (l10n:prefers, which the engine
   * states in its derived graph) or a text picked by them (l10n:label): a language change
   * re-runs it for every focus.
   */
  readsLanguage: boolean
  /**
   * iv:strategy iv:Incremental on a SPARQL rule (or its rendering): its query is a maintained view
   * partitioned by its focus (docs/IVM.md §10.1 step 3), and a focus's output is read from it.
   */
  incremental: boolean
}

export interface Selection {
  modality: string
  /** Enabled layers (IRIs). Rules without a layer always run. */
  layers: ReadonlySet<string>
  prefer: 'sparql' | 'function'
  /** Whether the store can evaluate SPARQL; slots with only SPARQL implementations are skipped otherwise. */
  sparql?: boolean
  /** The SPARQL extension groups the store has (GraphStore.extensions); a SPARQL rule needing another is skipped. */
  extensions?: ReadonlySet<string>
  /** The viewer's languages, most preferred first (the localization layer). */
  languages?: string[]
}

/**
 * What makes a SPARQL rule language-dependent: it reads the viewer's preferences, or a text
 * picked by them (l10n:label, l10n:name and the other twins derived in lower strata), so it
 * re-runs when they change.
 */
const READS_LANGUAGE = /\bl10n:[a-z]\w*|<https:\/\/semblance\.dev\/ns\/l10n#[a-z]\w*>/

/** Read every sem:Rule from the ontology graph(s) loaded in the store. */
/** localeCompare's order, without setting up a comparison per call. */
const collator = new Intl.Collator()

export function loadRules(store: GraphStore): Rule[] {
  const { namedNode } = store.factory
  const one = (s: Term, p: string): Term | undefined => store.match(s, namedNode(p), null)[0]?.object
  const all = (s: Term, p: string): string[] => store.match(s, namedNode(p), null).map((q) => q.object.value)

  // Semblance's prefixes, and those the graph declares (sh:prefix / sh:namespace), as reactions have.
  const prefixes = prefixesFor(store)
  const declarations = prefixLines(prefixes)
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
    // A rule may take its query from another (sem:constructFrom): one check for several renderings
    // (a component's own shapes, and its entries' member-wise).
    const from = one(r, SEM.constructFrom)
    const query = one(r, SEM.construct)?.value ?? (from ? one(from, SEM.construct)?.value : undefined)
    const fn = one(r, SEM.function)?.value
    if (!query === !fn) throw new Error(`Rule <${r.value}> needs exactly one of sem:construct / sem:function`)
    const watches = getAll(SEM.watches)
    // A followed predicate, or a path of them (an RDF list).
    const followTerms = store.match(r, namedNode(SEM.follows), null).map((q) => q.object)
    const follows = (followTerms.length || !slot ? followTerms : store.match(slot, namedNode(SEM.follows), null).map((q) => q.object)).map((t) => {
      if (t.termType === 'NamedNode') return t.value
      const path: string[] = []
      for (let n: Term | undefined = t; n && n.value !== RDF_NIL; n = one(n, RDF_REST)) {
        const first = one(n, RDF_FIRST)
        if (!first) continue
        // [ sem:zeroOrMore p ]: any number of p steps (an RDF list's rdf:rest), written "*p".
        // [ sem:inverse p ]: a step against p (from a node to what it is p of), written "^p".
        // [ sem:inverseVia ( q … ) ]: a step against the predicate the focus names along q …, written "^@q …".
        const star = first.termType === 'NamedNode' ? undefined : one(first, SEM.zeroOrMore)
        const inverse = first.termType === 'NamedNode' ? undefined : one(first, SEM.inverse)
        const via = first.termType === 'NamedNode' ? undefined : one(first, SEM.inverseVia)
        if (via) {
          const names: string[] = []
          for (let v: Term | undefined = via; v && v.value !== RDF_NIL; v = one(v, RDF_REST)) {
            const q = one(v, RDF_FIRST)
            if (q) names.push(q.value)
          }
          path.push('^@' + names.join(' '))
        } else path.push(star ? '*' + star.value : inverse ? '^' + inverse.value : first.value)
      }
      if (path.slice(0, -1).some((step) => step.startsWith('^@'))) throw new Error(`Rule <${r.value}>: a [ sem:inverseVia … ] step must be the last of its sem:follows path`)
      // One plain step is a followed predicate; a lone [ sem:inverse p ] or [ sem:zeroOrMore p ] stays a path.
      return path.length === 1 && !/^[*^]/.test(path[0]!) ? path[0]! : path
    })
    const requires = getAll(SEM.requires)
    const unless = getAll(SEM.unless)
    const forEach = get(SEM.forEach)?.value
    rules.push({
      iri: r.value,
      target: target.value,
      stratum: Number(get(SEM.stratum)?.value ?? 0),
      modality: get(SEM.modality)?.value,
      layer: get(SEM.layer)?.value,
      slot: slot?.value ?? r.value,
      kind: query ? 'sparql' : 'function',
      queryParts: query ? (prefixes + '\n' + query).split('$this') : undefined,
      fn,
      follows: follows.filter((p): p is string => typeof p === 'string'),
      followPaths: follows.filter((p): p is string[] => typeof p !== 'string'),
      ...(watches.length ? { watches: new Set(watches) } : query ? watchedPredicates(declarations, query, [...requires, ...unless, ...follows.flat().filter((p) => !p.startsWith('^@')).map((p) => p.replace(/^[*^]/, '')), ...(forEach ? [forEach] : [])]) : {}),
      readsMinted: get(SEM.readsMinted)?.value === 'true',
      forEach,
      anywhere: getAll(SEM.watchesAnywhere),
      watchesStatements: get(SEM.watchesStatements)?.value === 'true',
      manyValued: getAll(SEM.watchesManyValued),
      memberWatches:
        getAll(SEM.memberWatches).length || getAll(SEM.memberWatchesVia).length
          ? { predicates: new Set(getAll(SEM.memberWatches)), via: getAll(SEM.memberWatchesVia) }
          : undefined,
      inputOnly: get(SEM.inputOnly)?.value === 'true',
      always: get(SEM.always)?.value === 'true',
      // Member-wise output is attributed to (focus, member) pairs, which bulk output cannot be.
      bulk: get(SEM.bulk)?.value !== 'false' && !get(SEM.forEach) && (!query || attributableOnce(query)),
      requires,
      unless,
      // The rule's own: a rendering's sem:needsExtension says what its SPARQL rule awaits.
      needs: all(r, SEM.needsExtension),
      refresh: get(SEM.refresh)?.value === SEM.NextFrame ? 'frame' : 'now',
      readsLanguage: !!query && READS_LANGUAGE.test(query),
      incremental: !!query && get('https://semblance.dev/ns/view#strategy')?.value === 'https://semblance.dev/ns/view#Incremental',
    })
  }
  return rules.sort((a, b) => a.stratum - b.stratum || collator.compare(a.iri, b.iri))
}

/** A prefix header's declarations: each prefix's line, by its name with the colon. */
function prefixLines(header: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of header.split('\n')) {
    const m = /^PREFIX\s+([\w-]*:)/i.exec(line)
    if (m) out.set(m[1]!, line)
  }
  return out
}

/** The prefixes a query may use: every name followed by a colon in it (by query: the same queries are read by every engine). */
function prefixesUsed(query: string): string[] {
  let used = usedCache.get(query)
  if (!used) usedCache.set(query, (used = [...new Set(query.match(/(?<![\w.-])[A-Za-z][\w.-]*:|(?<![\w-]):/g) ?? [])]))
  return used
}
const usedCache = new Map<string, string[]>()

/**
 * What a query watches (namedPredicates), read once per query: every engine (the page's, each live
 * example's sandbox, a reload of the rules) reads the same few hundred queries, and parsing them is
 * most of the cost of starting one. Keyed by the query with the declarations of the prefixes it
 * uses, so engines whose graphs declare other prefixes share it. The result is shared: it is never
 * changed.
 */
function watchedPredicates(declarations: Map<string, string>, query: string, also: string[]): Pick<Rule, 'watches' | 'watchesVia' | 'watchesMarked'> {
  const header = prefixesUsed(query).flatMap((name) => declarations.get(name) ?? []).join('\n')
  const key = header + '\n' + query + '\n\0' + also.join(' ')
  let read = watchedCache.get(key)
  if (!read) {
    // Queries typed into live examples come and go: the caches are let go when they grow past them.
    if (watchedCache.size >= 4096) watchedCache.clear(), usedCache.clear()
    watchedCache.set(key, (read = namedPredicates(header + '\n' + query, also)))
  }
  return read
}
const watchedCache = new Map<string, Pick<Rule, 'watches' | 'watchesVia' | 'watchesMarked'>>()

/** attributable(), once per query (as watchedPredicates). */
function attributableOnce(query: string): boolean {
  let yes = attributableCache.get(query)
  if (yes === undefined) {
    if (attributableCache.size >= 4096) attributableCache.clear()
    attributableCache.set(query, (yes = attributable(query)))
  }
  return yes
}
const attributableCache = new Map<string, boolean>()

/**
 * The predicates a query names in its patterns (with `also`), or undefined when some pattern takes
 * any predicate (a variable, a negated set) or the query cannot be read: a changed triple whose
 * predicate it does not name matches none of its patterns, so it cannot change the query's result.
 * A SPARQL rule watches these as a function rule's traced reads would, and is not re-run for the
 * rest of its focus's (or a followed node's) triples.
 */
export function namedPredicates(query: string, also: string[]): Pick<Rule, 'watches' | 'watchesVia' | 'watchesMarked'> {
  const reads = queryReads(query)
  if (!reads) return {}
  if (reads.every((r) => r.p !== undefined)) return { watches: new Set([...reads.map((r) => r.p!), ...also]) }
  // Variable predicates: watched as the focus names them, when that is all they can be.
  const text = query.replaceAll('$this', '?this')
  const from = focusPredicates(text, prefixMap(text.slice(0, text.search(/\b(CONSTRUCT|SELECT)\b/i))))
  if (!from) return {}
  const watches = new Set([...from.named, ...from.iris, ...also])
  return { watches, ...(from.via.length && { watchesVia: from.via }), ...(from.marked.size && { watchesMarked: [...from.marked] }) }
}

/** Whether the store can run a rule: a SPARQL rule needs SPARQL and every extension group it names. */
export function runnable(r: Pick<Rule, 'kind' | 'needs'>, sel: Pick<Selection, 'sparql' | 'extensions'>): boolean {
  return r.kind !== 'sparql' || (sel.sparql !== false && r.needs.every((g) => sel.extensions?.has(g)))
}

/**
 * Pick the active rules: matching modality, enabled layer, one runnable implementation per slot:
 * the preferred kind if the store can run it, else the next (a SPARQL rule needing an extension
 * the store lacks falls back to its function twin).
 */
export function selectRules(rules: Rule[], sel: Selection, warn: (msg: string) => void = () => {}): Rule[] {
  const bySlot = new Map<string, Rule[]>()
  for (const r of rules) {
    if (r.modality && r.modality !== sel.modality) continue
    if (r.layer && !sel.layers.has(r.layer)) continue
    bySlot.set(r.slot, [...(bySlot.get(r.slot) ?? []), r])
  }
  const out: Rule[] = []
  for (const [slot, impls] of bySlot) {
    const can = impls.filter((r) => runnable(r, sel))
    if (!can.length) {
      warn(`<${slot}> has no implementation this store can run; skipped`)
      continue
    }
    out.push(can.find((r) => r.kind === sel.prefer) ?? can[0]!)
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

/**
 * Whether every subject in a CONSTRUCT template is $this or a variable bound to an
 * IRI minted from it (BIND(IRI(CONCAT(STR($this), ...)) AS ?v)). Bulk evaluation
 * groups output by the focus a subject was minted under; a triple about any other
 * node (another component, a list member) could not be given back to its focus.
 */
export function attributable(query: string): boolean {
  const open = query.search(/CONSTRUCT\s*\{/i)
  if (open < 0) return true
  let depth = 0
  let end = -1
  const start = query.indexOf('{', open)
  for (let i = start; i < query.length; i++) {
    if (query[i] === '{') depth++
    else if (query[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  if (end < 0) return false
  // Drop string literals, so their dots and semicolons don't split statements.
  const template = query.slice(start + 1, end).replace(STRINGS, '""')
  // Minted from $this, or from a node minted from it (to a fixed point).
  const minted = new Set(['$this', '?this'])
  // A BIND whose expression builds an IRI from a minted node (IRI(CONCAT(STR(?x), ...)),
  // possibly inside IF / COALESCE) mints too - unless a branch of it is a node from the data
  // (IF(?zoned, ?declaredZone, IRI(…))): a variable bound elsewhere in the query, not minted.
  const text = query.replace(STRINGS, '""')
  const bindings = [...text.matchAll(/BIND\s*\(([\s\S]*?)\s+AS\s+(\?\w+)\s*\)/gi)]
  // Variables bound outside BIND expressions (a pattern, VALUES) or by a BIND; the rest (?none) stay unbound.
  const outside = bindings.reduce((t, m) => t.replace(m[0], ' '), text.slice(text.search(/WHERE\s*\{/i)))
  const bound = (v: string) => bindings.some((m) => m[2] === v) || new RegExp(`[?$]${v.slice(1)}\\b`).test(outside)
  const binds = bindings
    .filter((m) => /IRI\s*\(/i.test(m[1]!))
    .map((m) => ({ from: [...m[1]!.matchAll(/STR\s*\(\s*([$?]\w+)\s*\)/gi)].map((x) => x[1]!), branches: branchVariables(m[1]!), to: m[2]! }))
  for (let grew = true; grew; ) {
    grew = false
    for (const { from, branches, to } of binds) {
      if (minted.has(to) || !from.length || !from.every((v) => minted.has(v))) continue
      if (branches.every((v) => minted.has(v) || !bound(v))) minted.add(to), (grew = true)
    }
  }
  const subjects = template
    .split(/\s\.(?=\s|$)/)
    .map((statement) => statement.trim().split(/\s+/)[0])
    .filter((t): t is string => !!t)
  return subjects.every((t) => minted.has(t))
}

/** SPARQL string literals, long and short, in double or single quotes. */
const STRINGS = /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g

/** The variables an expression can evaluate to as they are: itself, or a branch of IF / COALESCE. */
function branchVariables(expression: string): string[] {
  const e = expression.trim()
  if (/^[$?]\w+$/.test(e)) return [e]
  const call = /^(IF|COALESCE)\s*\(/i.exec(e)
  if (!call || !e.endsWith(')')) return []
  const args: string[] = []
  let depth = 0
  let from = call[0].length
  for (let i = from; i < e.length - 1; i++) {
    if (e[i] === '(') depth++
    else if (e[i] === ')') depth--
    else if (e[i] === ',' && depth === 0) args.push(e.slice(from, i)), (from = i + 1)
  }
  args.push(e.slice(from, e.length - 1))
  return (call[1]!.toUpperCase() === 'IF' ? args.slice(1) : args).flatMap(branchVariables)
}