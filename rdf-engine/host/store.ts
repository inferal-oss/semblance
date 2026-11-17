// Semblance's GraphStore over any engine build. Terms cross the boundary once:
// the adapter's own (shared) term objects carry their engine id, ids map back
// to them, and the factory hands out those same objects. Terms from other
// factories are looked up by value. In idle time (`maintain`) the engine frees
// terms nothing uses any more; the adapter then forgets their ids.
//
// WebAssembly memory never shrinks, so what the engine frees stays the page's. When live
// state is well below the memory (`liveBytes` against `memoryBytes`), `compact` copies
// the store into a fresh instance and drops the old one: the browser gets the difference
// back. The term objects handed out stay valid (they are re-tagged with their new ids).
// Idle time copies a slice at a time (`compactStep`), journaling the changes made meanwhile.
import type { DefaultGraph, Literal, NamedNode, Quad, Term } from '@rdfjs/types'
import type { Factory, GraphStore, QueryAnswer, StoreCompaction } from '../../src/store/types.ts'
import { DEFAULT_GRAPH, Engine, EngineError, Form, Format, Kind, type Query } from './engine.ts'
import { narrowPolicy, withFetching, type FetchPolicy } from './fetching.ts'

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string'

/** Engine ids are tagged on term objects under a key of each store's own. */
type Tagged = { [key: symbol]: number | undefined }

abstract class Base {
  [key: symbol]: number | undefined
  abstract readonly termType: string
  abstract readonly value: string
  equals(other: Term | null | undefined): boolean {
    if (!other || other.termType !== this.termType || other.value !== this.value) return false
    if (this.termType !== 'Literal') return true
    const a = this as unknown as Literal
    const b = other as Literal
    return a.language === b.language && (a.direction ?? '') === (b.direction ?? '') && a.datatype.value === b.datatype.value
  }
}

class Iri extends Base implements NamedNode {
  readonly termType = 'NamedNode' as const
  constructor(readonly value: string) {
    super()
  }
}

class Blank extends Base {
  readonly termType = 'BlankNode' as const
  constructor(readonly value: string) {
    super()
  }
}

class Lit extends Base implements Literal {
  readonly termType = 'Literal' as const
  constructor(
    readonly value: string,
    readonly language: string,
    readonly direction: '' | 'ltr' | 'rtl',
    readonly datatype: NamedNode,
  ) {
    super()
  }
}

class Default extends Base implements DefaultGraph {
  readonly termType = 'DefaultGraph' as const
  readonly value = '' as const
}

class TripleTerm extends Base {
  readonly termType = 'Quad' as const
  readonly value = ''
  constructor(
    readonly subject: Term,
    readonly predicate: Term,
    readonly object: Term,
    readonly graph: Term,
  ) {
    super()
  }
  override equals(other: Term | null | undefined): boolean {
    const q = other as Quad | undefined
    return !!q && q.termType === 'Quad' && q.subject.equals(this.subject) && q.predicate.equals(this.predicate) && q.object.equals(this.object) && q.graph.equals(this.graph)
  }
}

/** Ids of one engine instance to another's (0: none), in a typed array that grows as it is used. */
class IdMap {
  private a: Uint32Array
  constructor(size: number) {
    this.a = new Uint32Array(Math.max(1024, size))
  }
  get(id: number): number {
    return id < this.a.length ? this.a[id]! : 0
  }
  set(id: number, to: number): void {
    if (id >= this.a.length) {
      const b = new Uint32Array(Math.max(id + 1, this.a.length * 2))
      b.set(this.a)
      this.a = b
    }
    this.a[id] = to
  }
}

/** A store quad; distinct from triple terms only in being used as a statement. */
const quad = (s: Term, p: Term, o: Term, g: Term) => new TripleTerm(s, p, o, g) as unknown as Quad

/** When idle time (`maintain`) compacts the store: see EngineStore.compact. */
export interface CompactionPolicy {
  /** Compact when the estimate of live bytes is below this fraction of the memory (default 0.5; 0: never in idle time). */
  below?: number
  /** Not while the memory is smaller than this many bytes: small stores are not churned (default 64 MiB). */
  floor?: number
  /**
   * Abandon a compaction in flight when more changes wait in its journal than this many times the
   * quads it copies (default 1): catching up would then cost more than starting again.
   */
  journal?: number
}

export const COMPACTION_DEFAULTS: Required<CompactionPolicy> = { below: 0.5, floor: 64 << 20, journal: 1 }

/** What one compaction did. */
export type Compaction = StoreCompaction

/** A GraphStore with the engine's own counters, for tests and benchmarks. */
export type EngineStore = GraphStore & {
  termCount(): number
  /** The engine's WebAssembly memory, in bytes: its high-water mark, since that memory never shrinks. */
  memoryBytes(): number
  /** An estimate of the memory a fresh instance holding the same quads and terms would need. */
  liveBytes(): number
  /**
   * Copy the store into a fresh engine instance and drop the old one, so its memory goes. Term
   * objects handed out before stay valid, prepared queries are prepared again as they are used.
   * With `below`, only when liveBytes is below that fraction of memoryBytes. Undefined when it did
   * not: it would not win, or a fetch (SERVICE, LOAD) or a Jelly stream is in flight. In one step:
   * a compaction in flight (compactStep) is finished now, whatever `below` says.
   */
  compact(opts?: { below?: number }): Compaction | undefined
  /**
   * Compact a slice at a time (what `maintain` does): start a compaction (by `below`, as compact)
   * when none is in flight, then copy for about `budgetMs`. Changes made between slices are
   * journaled and replayed into the copy before the swap; an update, a Turtle or Jelly load or a
   * Jelly stream abandons it (the store stays as it is), and so does a journal larger than the
   * store (CompactionPolicy.journal). The Compaction in the step that swapped, else undefined.
   */
  compactStep(budgetMs: number, opts?: { below?: number }): Compaction | undefined
  /** The compaction in flight: quads copied of those it started with, changes journaled and replayed. */
  compacting(): { copied: number; quads: number; journal: number; replayed: number } | undefined
  /** Why the last compaction in flight was abandoned. */
  readonly abandoned: string | undefined
  /** When `maintain` compacts (the retention layer tightens it under pressure). */
  setCompaction(policy: CompactionPolicy): void
  /** Sizes of the host's caches over the engine (term objects, prepared queries, idle-compiled profiles), for leak checks. */
  footprint(): Record<string, number>
  /** A deadline for queries, on the Date.now() clock: one running past it throws an error with `interrupted` (undefined: none). */
  setDeadline(at: number | undefined): void
  /** A step budget for each query, as setDeadline (undefined: unlimited). */
  setFuel(steps: number | undefined): void
  update: NonNullable<GraphStore['update']>
  setFetchPolicy: NonNullable<GraphStore['setFetchPolicy']>
  /** The engine itself and term ids, for measurements that bypass the adapter. */
  engine: Engine
  idOf(t: Term): number
}

export interface EngineStoreOptions {
  /**
   * Compiled queries (ABI.md, "Optional: compiled queries"): compile a prepared
   * query, for the variables it has bound, on its n-th run with them. 0: never.
   * 'idle': in idle time (`maintain`), the queries whose timed runs say it pays
   * (Engine.compileIdle).
   */
  compile?: number | 'idle'
  /** The time zone `sx:formatDateTime` uses when its options name none (default: the host's own). */
  timeZone?: string
  /** What `query` and `update` may fetch for SERVICE and LOAD (docs/FETCHING.md; default: nothing). setFetchPolicy replaces it. */
  fetchPolicy?: FetchPolicy
  /** When idle time compacts the store (COMPACTION_DEFAULTS); setCompaction replaces it. */
  compaction?: CompactionPolicy
}

/** The host's policy as it is now: later changes to the object it gave do not reach the store. */
const snapshot = (p: FetchPolicy | undefined): FetchPolicy => (p ? { ...p, endpoints: { ...p.endpoints }, documents: { ...p.documents } } : {})

/**
 * What a fresh instance of each build spends per quad and per term (beyond the term's own bytes),
 * fitted to stores copied into fresh instances (quads over few terms, terms with short and long
 * values). Rust's per term includes the blocks its size-class heap keeps from outgrown vectors.
 */
const FRESH_BYTES: Record<string, [perQuad: number, perTerm: number]> = { wat: [163, 148], rust: [157, 400] }

/** Called with every engine store made (benchmarks use it to watch queries). */
export const engineStoreHooks: { created?: (store: EngineStore) => void } = {}

export function engineStore(module: WebAssembly.Module, kind: string, options: EngineStoreOptions = {}): EngineStore {
  let deadline: number | undefined
  let fuel: number | undefined
  /** An instance of the engine, as this store sets it up (again on compaction). */
  const instance = () => {
    const x = new Engine(module)
    x.autoCompile = typeof options.compile === 'number' ? options.compile : 0
    x.idleCompile = options.compile === 'idle'
    x.timeZone = options.timeZone
    x.setDeadline(deadline)
    x.setFuel(fuel)
    return x
  }
  let e = instance()
  /** The memory of an empty instance: what no state needs. */
  const emptyBytes = e.memoryBytes()
  // This store's tag: term objects of another store (another engine) carry ids that mean nothing
  // here. A compaction replaces it, so that no object keeps an id of the instance it dropped.
  let ID = Symbol('engine id')
  const defaultGraph = new Default()
  defaultGraph[ID] = DEFAULT_GRAPH
  /** Term objects by id, filled as ids come back from the engine. */
  let byId: (Term | undefined)[] = [undefined, defaultGraph]
  /** Shared term objects by value, so the factory and results agree: those the engine took (tagged with an id). */
  const iris = new Map<string, Iri>()
  const literals = new Map<string, Lit>()
  /**
   * Shared term objects the engine has not taken (made by the factory, or looked up and unknown),
   * at most FRESH of each, the oldest forgotten first: collect() forgets only terms whose id it
   * frees, so these would otherwise stay for good. Forgetting one loses only sharing. Tagged, a
   * term moves to `iris` or `literals` (tagged).
   */
  const freshIris = new Map<string, Iri>()
  const freshLiterals = new Map<string, Lit>()
  const FRESH = 4096
  function fresh<T>(m: Map<string, T>, k: string, t: T): T {
    if (m.size >= FRESH) m.delete(m.keys().next().value!)
    m.set(k, t)
    return t
  }
  /** A shared term has an id now: kept with the engine's terms, until collect() frees it. */
  function took(t: Base) {
    if (t instanceof Iri) {
      if (freshIris.get(t.value) === t) freshIris.delete(t.value), iris.set(t.value, t)
    } else if (t instanceof Lit) {
      const k = literalKey(t.value, t.language, t.direction, t.datatype.value)
      if (freshLiterals.get(k) === t) freshLiterals.delete(k), literals.set(k, t)
    }
  }
  const literalKey = (value: string, language: string, direction: string, datatype: string) => value + '\u0000' + (language ? language + '\u0000' + direction : datatype)
  const xsdString = namedNode(XSD_STRING)

  function namedNode(value: string): Iri {
    return iris.get(value) ?? freshIris.get(value) ?? fresh(freshIris, value, new Iri(value))
  }

  function sharedLiteral(value: string, language: string, direction: '' | 'ltr' | 'rtl', datatype: string): Lit {
    const k = literalKey(value, language, direction, datatype)
    let t = literals.get(k) ?? freshLiterals.get(k)
    if (!t) {
      const dt = language ? (direction ? RDF_DIR_LANG : RDF_LANG) : datatype
      t = fresh(freshLiterals, k, new Lit(value, language, direction, namedNode(dt)))
    }
    return t
  }

  function literal(value: string, languageOrDatatype?: string | NamedNode | { language: string; direction?: string }): Literal {
    if (typeof languageOrDatatype === 'string') return sharedLiteral(value, languageOrDatatype.toLowerCase(), '', '')
    if (languageOrDatatype && 'language' in languageOrDatatype) {
      return sharedLiteral(value, languageOrDatatype.language.toLowerCase(), (languageOrDatatype.direction ?? '') as '' | 'ltr' | 'rtl', '')
    }
    return sharedLiteral(value, '', '', languageOrDatatype?.value ?? XSD_STRING)
  }

  const bnodes = new Map<string, Blank>()
  function blankNode(label: string): Blank {
    let t = bnodes.get(label)
    if (!t) bnodes.set(label, (t = new Blank(label)))
    return t
  }

  /** The engine id of a term: interned when `intern`, else 0 if the engine has never seen it. */
  function idOf(t: Term, intern: boolean): number {
    const tagged = t as Term & Tagged
    const has = tagged[ID]
    if (has !== undefined) return has
    let id: number
    switch (t.termType) {
      case 'NamedNode': {
        const shared = namedNode(t.value)
        const sharedId = shared[ID]
        if (sharedId !== undefined) return sharedId
        id = intern ? e.iri(t.value) : e.lookupIri(t.value)
        if (id) {
          shared[ID] = id
          byId[id] ??= shared
          took(shared)
        }
        break
      }
      case 'DefaultGraph':
        return DEFAULT_GRAPH
      case 'BlankNode': {
        const shared = blankNode(t.value)
        let sharedId = shared[ID]
        if (sharedId === undefined) {
          shared[ID] = sharedId = e.bnode(t.value)
          byId[sharedId] ??= shared
        }
        return sharedId
      }
      case 'Literal': {
        const l = t as Literal
        const lang = l.language.toLowerCase()
        const direction = (l.direction ?? '') as '' | 'ltr' | 'rtl'
        const shared = sharedLiteral(l.value, lang, direction, l.datatype.value)
        let sharedId = shared[ID]
        if (sharedId === undefined) {
          const dir = direction === 'ltr' ? 1 : direction === 'rtl' ? 2 : 0
          shared[ID] = sharedId = lang ? e.langLiteral(l.value, lang, dir) : e.literal(l.value, l.datatype.value === XSD_STRING ? 0 : idOf(l.datatype, true))
          byId[sharedId] ??= shared
          took(shared)
        }
        return sharedId
      }
      case 'Quad': {
        const q = t as unknown as Quad
        const [s, p, o] = [idOf(q.subject, intern), idOf(q.predicate, intern), idOf(q.object, intern)]
        if (!s || !p || !o) return 0
        id = e.triple(s, p, o)
        break
      }
      default:
        throw new Error(`cannot store a ${t.termType}`)
    }
    if (id && t instanceof Base) {
      tagged[ID] = id
      byId[id] ??= t
    }
    return id
  }

  function termOf(id: number): Term {
    const known = byId[id]
    if (known) return known
    let t: Base
    switch (e.kind(id)) {
      case Kind.Iri:
        t = namedNode(e.value(id))
        break
      case Kind.BlankNode:
        t = blankNode(e.value(id))
        break
      case Kind.Literal: {
        const dir = e.direction(id)
        t = sharedLiteral(e.value(id), e.lang(id), dir === 1 ? 'ltr' : dir === 2 ? 'rtl' : '', termOf(e.datatype(id)).value)
        break
      }
      case Kind.Triple: {
        const [s, p, o] = e.tripleParts(id)
        t = new TripleTerm(termOf(s), termOf(p), termOf(o), defaultGraph)
        break
      }
      default:
        throw new Error(`engine returned unknown term id ${id}`)
    }
    t[ID] = id
    byId[id] = t as Term
    took(t)
    return t as Term
  }

  // Parsed queries by text. Semblance substitutes each focus into the text, so
  // this is bounded; prepared queries with bound variables avoid the parse.
  const prepared = new Map<string, Query>()
  const prepare = (text: string) => {
    let q = prepared.get(text)
    if (q) {
      prepared.delete(text)
    } else {
      q = e.prepare(text)
      if (prepared.size >= 512) {
        const [oldest, old] = prepared.entries().next().value!
        prepared.delete(oldest)
        old.release()
      }
    }
    prepared.set(text, q)
    return q
  }
  /**
   * IRIs the engine did not know when looked up. Every term a quad is added with is tagged
   * first, so an IRI that is still untagged is in no quad, unless Turtle loaded since: for
   * matching (and graph lists) it stays unknown without asking the engine again.
   */
  const unknown = new Set<string>()
  /** The engine id of a term to find quads by, or 0 if no quad can contain it. */
  function known(t: Term): number {
    if (t.termType !== 'NamedNode' || (t as Term & Tagged)[ID] !== undefined) return idOf(t, false)
    const shared = namedNode(t.value)
    const sharedId = shared[ID]
    if (sharedId !== undefined) return sharedId
    if (unknown.has(t.value)) return 0
    const id = idOf(t, false)
    if (!id) {
      if (unknown.size >= 4096) unknown.clear()
      unknown.add(t.value)
    }
    return id
  }

  const graphIds = (graphs: Term[]) => {
    const out: number[] = []
    for (const g of graphs) {
      const id = known(g)
      if (id) out.push(id)
    }
    // Every requested graph unknown to the engine: an empty default graph.
    return graphs.length && !out.length ? [0xffffffff] : out
  }
  let sparql: boolean
  try {
    e.prepare('ASK {}').release()
    sparql = true
  } catch (err) {
    if (!(err instanceof EngineError)) throw err
    sparql = false
  }

  const triplesOf = (r: ReturnType<Query['run']>): Quad[] => {
    if (r.form !== Form.Construct && r.form !== Form.Describe) throw new Error('not a CONSTRUCT query')
    const out: Quad[] = new Array(r.triples.length / 3)
    for (let i = 0, k = 0; i < r.triples.length; i += 3, k++) out[k] = quad(termOf(r.triples[i]!), termOf(r.triples[i + 1]!), termOf(r.triples[i + 2]!), defaultGraph)
    return out
  }

  /** Free unused engine terms and forget them here. */
  let liveAfterCollect = e.termCount()
  function collect() {
    for (const id of e.collect()) {
      const t = byId[id] as (Base & Term) | undefined
      if (!t) continue
      byId[id] = undefined
      delete t[ID]
      if (t instanceof Iri) iris.delete(t.value)
      else if (t instanceof Blank) bnodes.delete(t.value)
      else if (t instanceof Lit) literals.delete(literalKey(t.value, t.language, t.direction, t.datatype.value))
    }
    liveAfterCollect = e.termCount()
  }

  // --- compaction ----------------------------------------------------------------------

  /** Jelly readers and writers open on the engine: their handles are the instance's own. */
  let streams = 0
  let compaction = { ...COMPACTION_DEFAULTS, ...options.compaction }
  /**
   * The live estimate: the memory of an empty instance, and per quad and per term what a fresh
   * instance of this build spends (FRESH_BYTES), with the term's own bytes from the dictionary's
   * mean (measured again when the terms have changed by a quarter, and by every compaction).
   * `scale` is what the last compaction found the memory to be against the estimate: the engine's
   * growth in steps and size classes, at this store's size.
   */
  const [PER_QUAD, PER_TERM] = FRESH_BYTES[kind] ?? FRESH_BYTES.wat!
  let meanTermBytes = 0
  let measuredAt = -1
  let scale = 1
  function rawLive(quads: number, terms: number): number {
    if (measuredAt < 0 || Math.abs(terms - measuredAt) > measuredAt / 4) {
      meanTermBytes = terms ? e.termBytes() / terms : 0
      measuredAt = terms
    }
    return quads * PER_QUAD + terms * (PER_TERM + meanTermBytes)
  }
  const liveBytes = () => Math.round(emptyBytes + scale * rawLive(e.quadCount(), e.termCount()))

  /**
   * A compaction in flight (compactStep): the old instance stays the store's, queried and changed as
   * ever, while its quads are copied into `next` a slice at a time. Every add and delete made to the
   * old one meanwhile goes into the journal, replayed into `next` after the copy; the swap comes in
   * the step that finds both done, so it never waits on a change. Ids of the old instance stay valid
   * throughout: nothing is collected while a compaction is in flight.
   */
  interface Pending {
    old: Engine
    next: Engine
    /** When it started (performance.now()), and the old memory then. */
    started: number
    before: number
    /** The old store's quads when it started, 4 ids each, and how far the copy has come. */
    quads: Uint32Array
    at: number
    /** Changes since: [op, s, p, o, g] in old ids (op 1: add, 0: delete), and how far it is replayed. */
    journal: number[]
    replayed: number
    /** Abandoned when the journal holds more changes than this: restarting would cost less than catching up. */
    limit: number
    /** Old ids to new, for every term a copied quad uses. */
    map: IdMap
    /** The next instance's tag, and its term objects by id, filled as terms are copied. */
    tag: symbol
    ids: (Term | undefined)[]
    copy: (id: number) => number
    slices: number
    longest: number
    work: number
    replay: number
  }
  let pending: Pending | undefined
  /**
   * After a swap, the term caches are swept a slice at a time: an object with an old id gets its new
   * one (the copy tagged most already), or leaves the cache when no quad uses its term any more, as
   * collect would have it leave. Until then an untagged object is interned again as it is used.
   */
  let sweep: { tag: symbol; map: IdMap; caches: [Map<string, Base & Term>, Iterator<[string, Base & Term]>][] } | undefined
  /** Idle time starts no compaction before this (performance.now()) after one was abandoned. */
  let retryAt = 0
  let abandons = 0
  /** Why the last compaction was abandoned. */
  let abandoned: string | undefined

  function start(opts: { below?: number }): boolean {
    if (fetchingOps || streams) return false
    if (opts.below !== undefined && liveBytes() >= opts.below * e.memoryBytes()) return false
    finishSweep()
    const old = e
    const next = instance()
    const map = new IdMap(old.termCount() * 2)
    map.set(DEFAULT_GRAPH, DEFAULT_GRAPH)
    const tag = Symbol('engine id')
    const ids: (Term | undefined)[] = [undefined, defaultGraph]
    const oldXsd = old.lookupIri(XSD_STRING)
    // Old ids to new: every term a quad uses, through the cached objects' values where there are
    // some (those are tagged with their new id). Blank nodes keep their labels (a Jelly or Turtle
    // load would give them fresh ones).
    const copy = (id: number): number => {
      const done = map.get(id)
      if (done) return done
      const t = byId[id]
      let n: number
      switch (old.kind(id)) {
        case Kind.Iri: {
          n = next.iri(t instanceof Iri ? t.value : old.value(id))
          break
        }
        case Kind.BlankNode: {
          n = next.bnode(t instanceof Blank ? t.value : old.value(id))
          break
        }
        case Kind.Literal: {
          const v = t instanceof Lit ? t.value : old.value(id)
          const lang = t instanceof Lit ? t.language : old.lang(id)
          if (lang) n = next.langLiteral(v, lang, old.direction(id))
          else {
            const dt = old.datatype(id)
            n = next.literal(v, dt === oldXsd ? 0 : copy(dt))
          }
          break
        }
        case Kind.Triple: {
          const [a, b, c] = old.tripleParts(id)
          n = next.triple(copy(a), copy(b), copy(c))
          break
        }
        case Kind.DefaultGraph:
          n = DEFAULT_GRAPH
          break
        default:
          throw new Error(`compaction met unknown term id ${id}`)
      }
      map.set(id, n)
      if (t) {
        ;(t as Term & Tagged)[tag] = n
        ids[n] ??= t
      }
      return n
    }
    const t0 = performance.now()
    const quads = old.match(0, 0, 0, 0)
    pending = {
      old,
      next,
      started: t0,
      before: old.memoryBytes(),
      quads,
      at: 0,
      journal: [],
      replayed: 0,
      limit: compaction.journal * Math.max(quads.length / 4, 1024),
      map,
      tag,
      ids,
      copy,
      slices: 0,
      longest: 0,
      work: 0,
      replay: 0,
    }
    return true
  }

  /** Give up the compaction in flight: the store stays as it is (the old instance), the copy goes. */
  function abandon(why: string) {
    const p = pending
    if (!p) return
    pending = undefined
    p.next.dispose()
    abandoned = why
    // Idle time tries again later, the later the more often it gave up (2 s, doubling, up to a minute).
    abandons++
    retryAt = performance.now() + Math.min(60_000, 1000 * 2 ** abandons)
  }

  /** Journal a change made to the old instance while a compaction is in flight. */
  function journal(p: Pending, op: number, s: number, pr: number, o: number, g: number) {
    p.journal.push(op, s, pr, o, g)
    if (p.journal.length - p.replayed > 5 * p.limit) abandon('the store changed more while it was copied than it holds')
  }

  /** Quads (or journal entries) a slice copies before it looks at the clock again. */
  const CHUNK = 1024
  const chunk = new Uint32Array(4 * CHUNK)

  /** Work on the compaction in flight until `until` (performance.now()), at least a chunk; the swap once all is copied. */
  function step(until: number, t0 = performance.now()): Compaction | undefined {
    const p = pending!
    const { next, quads, journal: J, copy } = p
    do {
      if (p.at < quads.length) {
        const end = Math.min(quads.length, p.at + 4 * CHUNK)
        const n = end - p.at
        for (let i = 0; i < n; i++) chunk[i] = copy(quads[p.at + i]!)
        // In the order they were, a chunk at a time.
        next.apply([], chunk.subarray(0, n))
        p.at = end
      } else if (p.replayed < J.length) {
        const r0 = performance.now()
        // The changes made meanwhile, in order: a quad holds as its last change left it.
        const end = Math.min(J.length, p.replayed + 5 * CHUNK)
        for (let i = p.replayed; i < end; i += 5) {
          const s = copy(J[i + 1]!)
          const pr = copy(J[i + 2]!)
          const o = copy(J[i + 3]!)
          const g = copy(J[i + 4]!)
          if (J[i]) next.add(s, pr, o, g)
          else next.remove(s, pr, o, g)
        }
        p.replayed = end
        p.replay += performance.now() - r0
      } else break
    } while (performance.now() < until)
    if (p.at < quads.length || p.replayed < J.length) {
      const ms = performance.now() - t0
      p.slices++
      p.work += ms
      p.longest = Math.max(p.longest, ms)
      return undefined
    }

    // Swap: the next instance is the store's; the shared term objects carry their new ids under its
    // tag (the copy tagged those it met, the sweep does the rest). Triple terms re-intern as used.
    const t1 = performance.now()
    pending = undefined
    p.old.dispose()
    e = next
    ;(defaultGraph as unknown as Tagged)[p.tag] = DEFAULT_GRAPH
    sweep = { tag: ID, map: p.map, caches: ([iris, literals, bnodes] as Map<string, Base & Term>[]).map((m) => [m, m.entries()]) }
    ID = p.tag
    byId = p.ids
    // Prepared queries (and compiled ones) were the old instance's: they are prepared again as they run.
    prepared.clear()
    unknown.clear()
    liveAfterCollect = e.termCount()
    const after = e.memoryBytes()
    const terms = e.termCount()
    // The mean term is the old dictionary's, measured within the last quarter of change: a walk of
    // the new one would be the longest part of the swap. It is measured again as terms change.
    if (measuredAt < 0) rawLive(p.quads.length / 4, terms)
    measuredAt = terms
    const raw = rawLive(e.quadCount(), terms)
    if (raw > 0) scale = Math.max(0.5, (after - emptyBytes) / raw)
    abandons = 0
    retryAt = 0
    const end = performance.now()
    const ms = end - t0
    p.slices++
    p.work += ms
    p.longest = Math.max(p.longest, ms)
    return {
      before: p.before,
      after,
      quads: quads.length / 4,
      terms,
      ms: p.work,
      slices: p.slices,
      longestMs: p.longest,
      swapMs: end - t1,
      journal: J.length / 5,
      journalMs: p.replay,
      elapsedMs: end - p.started,
    }
  }

  /** Sweep the term caches after a swap until `until`; true when done. */
  function sweepStep(until: number): boolean {
    const w = sweep!
    const now = ID
    let n = 0
    while (w.caches.length) {
      const [cache, it] = w.caches[0]!
      for (;;) {
        if (++n % 1024 === 0 && performance.now() >= until) return false
        const r = it.next()
        if (r.done) break
        const [key, t] = r.value
        const was = t[w.tag]
        if (was === undefined) continue
        delete t[w.tag]
        if (t[now] !== undefined) continue
        const id = w.map.get(was)
        if (id) {
          t[now] = id
          byId[id] ??= t
        } else cache.delete(key)
      }
      w.caches.shift()
    }
    delete (defaultGraph as unknown as Tagged)[w.tag]
    sweep = undefined
    return true
  }
  function finishSweep() {
    if (sweep) sweepStep(Infinity)
  }

  /**
   * Compact a slice at a time: start a compaction (by `below`, as compact) when none is in flight,
   * then work on it for about `budgetMs`. The Compaction in the step that swapped, else undefined
   * (still in flight, or none started: see `compacting`).
   */
  function compactStep(budgetMs: number, opts: { below?: number } = {}): Compaction | undefined {
    if (fetchingOps || streams) return undefined
    // The slice is the whole call: the sweep of the last compaction, the start of this one.
    const t0 = performance.now()
    const until = t0 + budgetMs
    if (sweep && !sweepStep(until)) return undefined
    if (!pending && !start(opts)) return undefined
    return step(until, t0)
  }

  /** Compact now, in one step: the compaction in flight, or a new one. */
  function compact(opts: { below?: number } = {}): Compaction | undefined {
    if (fetchingOps || streams) return undefined
    const t0 = performance.now()
    if (!pending && !start(opts)) return undefined
    const c = step(Infinity, t0)!
    const t1 = performance.now()
    finishSweep()
    c.ms += performance.now() - t1
    return c
  }

  // --- SERVICE and LOAD (ABI.md, "Optional: fetching") ---------------------------------

  /** Fetching operations in flight: the engine's request table is theirs, and nothing is collected. */
  let fetchingOps = 0
  /** Fetching operations run one at a time: they share the engine's request table. */
  let queue: Promise<unknown> = Promise.resolve()
  /** A synchronous call (a rule's, a view's) that would fetch is refused, and fetches nothing. */
  function sync<T>(f: () => T): T {
    try {
      return f()
    } catch (err) {
      if (!(err instanceof EngineError && err.waiting)) throw err
      if (!fetchingOps) e.fetchClear()
      throw new Error('SERVICE and LOAD reach the network: only store.query and store.update run them (docs/FETCHING.md); rules, views and reactions cannot')
    }
  }
  function selectRows(query: string, graphs: Term[], r = prepare(query).run(graphIds(graphs))) {
    // An ASK answers true or false, as Oxigraph's query does.
    if (r.form === Form.Ask) return r.value as never
    if (r.form !== Form.Select) throw new Error('not a SELECT query')
    const out: Map<string, Term>[] = []
    const width = r.vars.length
    if (!width) return Array.from({ length: r.count }, () => new Map<string, Term>())
    for (let i = 0; i < r.rows.length; i += width) {
      const m = new Map<string, Term>()
      for (let k = 0; k < width; k++) if (r.rows[i + k]) m.set(r.vars[k]!, termOf(r.rows[i + k]!))
      out.push(m)
    }
    return out
  }
  /** The host's fetch policy: what `query` and `update` may reach. */
  let fetchPolicy = snapshot(options.fetchPolicy)
  /**
   * `attempt` with every SERVICE and LOAD answered under the store's policy (narrowed by the call's,
   * as it is now: a replacement after the call does not change it), after the operations before it.
   */
  function fetchingOp<T>(call: FetchPolicy | undefined, attempt: () => T): Promise<T> {
    if (!sparql) return Promise.reject(new Error(`The ${kind} store has no SPARQL engine yet`))
    let policy: FetchPolicy
    try {
      policy = narrowPolicy(fetchPolicy, call)
    } catch (err) {
      return Promise.reject(err)
    }
    const op = queue.then(async () => {
      fetchingOps++
      const round = () => {
        // Each round within the operation's deadline, then the store's own again.
        e.setDeadline(policy.deadline ?? deadline)
        try {
          return attempt()
        } finally {
          e.setDeadline(deadline)
        }
      }
      try {
        // A build without fetching answers what needs nothing fetched, and refuses the rest.
        return e.fetches ? await withFetching(e, policy, round) : sync(round)
      } finally {
        fetchingOps--
      }
    })
    queue = op.catch(() => {})
    return op
  }
  /** A query's answer, by its form. */
  function answer(query: string, graphs: Term[]): QueryAnswer {
    const r = prepare(query).run(graphIds(graphs))
    if (r.form === Form.Construct || r.form === Form.Describe) return triplesOf(r)
    return selectRows(query, graphs, r)
  }

  const factory: Factory = {
    namedNode,
    literal: literal as Factory['literal'],
    defaultGraph: () => defaultGraph,
    quad: (s, p, o, g) => quad(s, p, o, g ?? defaultGraph),
  }

  const store: EngineStore = {
    kind,
    factory,
    sparql,
    extensions: e.extensions,
    timeZone: options.timeZone,
    crossGraphMatch: true,
    add(q) {
      const s = idOf(q.subject, true)
      const p = idOf(q.predicate, true)
      const o = idOf(q.object, true)
      const g = idOf(q.graph, true)
      // While a compaction is in flight, what changed goes into its journal (what did not, need not).
      if (e.add(s, p, o, g) && pending) journal(pending, 1, s, p, o, g)
    },
    delete(q) {
      const s = known(q.subject)
      const p = known(q.predicate)
      const o = known(q.object)
      const g = known(q.graph)
      if (s && p && o && g && e.remove(s, p, o, g) && pending) journal(pending, 0, s, p, o, g)
    },
    has(q) {
      const s = known(q.subject)
      const p = known(q.predicate)
      const o = known(q.object)
      const g = known(q.graph)
      return !!(s && p && o && g) && e.has(s, p, o, g)
    },
    match(s, p, o, g) {
      const a = s ? known(s) : 0
      const b = p ? known(p) : 0
      const c = o ? known(o) : 0
      const d = g ? known(g) : 0
      // A bound term the engine has never seen matches nothing (0 would mean "any").
      if ((s && !a) || (p && !b) || (o && !c) || (g && !d)) return []
      const r = e.match(a, b, c, d)
      const out: Quad[] = new Array(r.length / 4)
      for (let i = 0, k = 0; i < r.length; i += 4, k++) out[k] = quad(termOf(r[i]!), termOf(r[i + 1]!), termOf(r[i + 2]!), termOf(r[i + 3]!))
      return out
    },
    matchBatch(patterns) {
      // One crossing for the patterns whose bound terms the engine knows (any other matches nothing).
      const ids: number[] = []
      const asked: number[] = []
      patterns.forEach(([s, p, o, g], i) => {
        const a = s ? known(s) : 0
        const b = p ? known(p) : 0
        const c = o ? known(o) : 0
        const d = g ? known(g) : 0
        if ((s && !a) || (p && !b) || (o && !c) || (g && !d)) return
        ids.push(a, b, c, d)
        asked.push(i)
      })
      const out: Quad[][] = patterns.map(() => [])
      if (!asked.length) return out
      const found = e.matchBatch(ids)
      asked.forEach((i, k) => {
        const r = found[k]!
        const qs: Quad[] = (out[i] = new Array(r.length / 4))
        for (let j = 0, n = 0; j < r.length; j += 4, n++) qs[n] = quad(termOf(r[j]!), termOf(r[j + 1]!), termOf(r[j + 2]!), termOf(r[j + 3]!))
      })
      return out
    },
    select(query, graphs) {
      if (!sparql) throw new Error(`The ${kind} store has no SPARQL engine yet`)
      return sync(() => selectRows(query, graphs as Term[]))
    },
    constructFor(query, variable, values, graphs) {
      const q = prepare(query)
      const ids: number[] = []
      for (const v of values) {
        const id = idOf(v, false)
        if (id) ids.push(id)
      }
      if (!ids.length) return []
      q.bindValues(variable, ids)
      try {
        return sync(() => triplesOf(q.run(graphIds(graphs as Term[]))))
      } finally {
        q.bindValues(variable, [])
      }
    },
    construct(query, graphs) {
      if (!sparql) throw new Error(`The ${kind} store has no SPARQL engine yet; use function rules (prefer: "function")`)
      return sync(() => triplesOf(prepare(query).run(graphIds(graphs as Term[]))))
    },
    query(query, opts = {}) {
      return fetchingOp(opts.policy, () => answer(query, (opts.graphs ?? []) as Term[])) as never
    },
    update(text, opts = {}) {
      return fetchingOp(opts.policy, () => {
        // What an update changes is the engine's own to know: a compaction in flight cannot journal it.
        abandon('an update changed the store')
        e.update(text)
        // IRIs it added may be ones looked up as unknown before.
        unknown.clear()
      })
    },
    setFetchPolicy(policy) {
      fetchPolicy = snapshot(policy)
    },
    loadTurtle(text) {
      unknown.clear()
      abandon('Turtle was loaded')
      e.load(Format.Turtle, text)
    },
    loadJelly(bytes, graph) {
      unknown.clear()
      abandon('Jelly was loaded')
      return e.loadBytes(Format.Jelly, bytes, graph ? idOf(graph, true) : DEFAULT_GRAPH)
    },
    jellyReader(graph) {
      abandon('a Jelly stream was opened')
      const r = e.jellyReader(graph ? idOf(graph, true) : DEFAULT_GRAPH)
      let open = true
      streams++
      return {
        frame(bytes) {
          unknown.clear()
          return r.add(bytes)
        },
        end: () => {
          try {
            return r.finish()
          } finally {
            r.release()
            if (open) streams--
            open = false
          }
        },
      }
    },
    *jellyFrames(graph, options = {}) {
      const g = graph ? idOf(graph, false) : 0
      // The ids are read at once (the store holds them anyway); the frames are written a batch at a time.
      const ids = graph && !g ? new Uint32Array(0) : e.match(0, 0, 0, g)
      const w = e.jellyWriter({ ...options, physical: 2 })
      const step = 4 * (options.frameRows ?? 4096)
      streams++
      try {
        for (let i = 0; i < ids.length; i += step) {
          const out = w.write(ids.subarray(i, i + step))
          if (out.length) yield out
        }
        yield w.flush()
      } finally {
        streams--
        w.release()
      }
    },
    dumpJelly(graph, options = {}) {
      const g = graph ? idOf(graph, false) : 0
      const w = e.jellyWriter({ ...options, physical: 2 })
      try {
        const parts = [graph && !g ? new Uint8Array(0) : w.write(e.match(0, 0, 0, g)), w.flush()]
        const out = new Uint8Array(parts[0]!.length + parts[1]!.length)
        out.set(parts[0]!)
        out.set(parts[1]!, parts[0]!.length)
        return out
      } finally {
        w.release()
      }
    },
    termCount: () => e.termCount(),
    // The engine's own terms (iris, literals, blank nodes tagged) follow what is stored, and collect() frees them.
    footprint: () => ({ freshIris: freshIris.size, freshLiterals: freshLiterals.size, prepared: prepared.size, idleCompiled: e.idleCompiledProfiles.length }),
    size: () => e.quadCount(),
    dispose() {
      // Each store has its own instance and memory; drop them and the term caches,
      // so they go as soon as the engine object does, not when the store's last holder does.
      prepared.clear()
      byId.length = 0
      iris.clear()
      literals.clear()
      freshIris.clear()
      freshLiterals.clear()
      unknown.clear()
      pending?.next.dispose()
      pending = sweep = undefined
      e.dispose()
    },
    setDeadline: (at) => {
      e.setDeadline((deadline = at))
      pending?.next.setDeadline(at)
    },
    setFuel: (steps) => {
      e.setFuel((fuel = steps))
      pending?.next.setFuel(steps)
    },
    get engine() {
      return e
    },
    idOf: (t) => idOf(t, false),
    // While a compaction is in flight, the page holds both instances.
    memoryBytes: () => e.memoryBytes() + (pending ? pending.next.memoryBytes() : 0),
    liveBytes,
    compact,
    compactStep,
    compacting: () => (pending ? { copied: pending.at / 4, quads: pending.quads.length / 4, journal: pending.journal.length / 5, replayed: pending.replayed / 5 } : undefined),
    get abandoned() {
      return abandoned
    },
    setCompaction(policy) {
      compaction = { ...COMPACTION_DEFAULTS, ...policy }
    },
    maintain(budgetMs) {
      const t0 = performance.now()
      const until = t0 + budgetMs
      // A compaction in flight, or the sweep after one, goes on a slice at a time. Neither while a
      // fetch or a Jelly stream is in flight: their handles and ids are the instance's own.
      if (!fetchingOps && !streams) {
        if (sweep) sweepStep(until)
        if (pending) step(until)
      }
      // Collect once the dictionary has grown by half since the last collection. Not while a fetch
      // is in flight (its answers' terms are in the engine's request table), nor while a compaction
      // is (the copy and its journal hold ids of the old instance, the sweep ids of both).
      if (!fetchingOps && !pending && !sweep && e.termCount() > liveAfterCollect * 1.5 + 1000) collect()
      // Start a compaction when live state has fallen well below the memory (not for small stores,
      // nor soon after one was abandoned), and spend what is left of the budget on it.
      if (!pending && !sweep && compaction.below > 0 && !fetchingOps && !streams && t0 >= retryAt && e.memoryBytes() >= compaction.floor) {
        const s0 = performance.now()
        if (start({ below: compaction.below })) step(until, s0)
      }
      const more = !!pending || !!sweep
      // What time is left compiles the queries that have run most (compiled: 'idle').
      return e.compileIdle(until - performance.now()) || more
    },
  }
  engineStoreHooks.created?.(store)
  return store
}

const RDF_LANG = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString'
const RDF_DIR_LANG = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#dirLangString'
