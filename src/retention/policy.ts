// Retention policies, read from the graph (ontology/layers/retention.ttl, docs/RETENTION.md).
//
// A stream's view names its policies (ldes:retentionPolicy). Policies without ret:having keep the
// stream's most recent members (ldes:amount) or its recent ones (a duration); a member is kept while
// any of them keeps it. Policies with ret:having extend them: a member those let go is offered to the
// first that matches it (one of the member's properties), which keeps its ldes:amount most recent.
// What no policy keeps leaves by the exit of the policy that let it go last: dropped or offloaded.
// Every operation costs what it retires: members leave from the front of a queue, never by a scan.
import type { NamedNode, Term } from '@rdfjs/types'
import { LDES, NS } from '../ns.ts'
import { parseDuration } from '../rdf.ts'
import type { GraphStore } from '../store/types.ts'

const RET = NS.ret

export type Exit = 'drop' | 'offload'

export interface Policy {
  iri: string
  /** ldes:amount: the most recent this many. */
  amount?: number
  /** A duration (tree:value or ldes:fullLogDuration) in milliseconds: those appended within it. */
  withinMs?: number
  /** ret:having: only members with one of these properties. */
  having: string[]
  exit: Exit
  /** ret:storageAmount: how many offloaded members storage keeps (unbounded when absent). */
  storageAmount?: number
  /** ret:announce: crossing its horizon is announced. */
  announce: boolean
}

/**
 * The retention policies of a stream's views, in the order the stream declares them (by IRI, so the
 * order is stable). No view, or a view without policies, is an empty list: the stream keeps everything.
 */
export function policiesOf(store: GraphStore, stream: Term): Policy[] {
  const f = store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const one = (s: Term, p: string) => store.match(s as NamedNode, nn(p), null)[0]?.object
  const out: Policy[] = []
  for (const view of store.match(stream as NamedNode, nn(LDES.view), null)) {
    for (const q of store.match(view.object as NamedNode, nn(LDES.retentionPolicy), null)) {
      const p = q.object
      const amount = one(p, LDES.amount)
      const duration = one(p, NS.tree + 'value') ?? one(p, LDES.fullLogDuration)
      const storage = one(p, RET + 'storageAmount')
      out.push({
        iri: p.value,
        amount: amount ? Number(amount.value) : undefined,
        withinMs: duration && !amount ? parseDuration(duration.value) : undefined,
        having: store.match(p as NamedNode, nn(RET + 'having'), null).map((x) => x.object.value),
        exit: one(p, RET + 'onExpiry')?.value === RET + 'Offload' ? 'offload' : 'drop',
        storageAmount: storage ? Number(storage.value) : undefined,
        announce: one(p, RET + 'announce')?.value === 'true',
      })
    }
  }
  return out.sort((a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0))
}

/** How many members a stream's policies keep at most, by count (Infinity when a policy keeps by age or none bounds it). */
export function boundOf(policies: Policy[]): number {
  if (!policies.length) return Infinity
  let n = 0
  for (const p of policies) {
    if (p.amount === undefined) return Infinity
    n += p.amount
  }
  return n
}

/** The policies' amount for streams that only count (the inspection logs): the largest of the general ones. */
export function amountOf(policies: Policy[], fallback: number): number {
  const general = policies.filter((p) => !p.having.length)
  if (!general.length) return fallback
  if (general.some((p) => p.amount === undefined)) return Infinity
  return Math.max(...general.map((p) => p.amount!))
}

export interface Member {
  iri: string
  seq: number
  /** When it was appended (ms since the epoch). */
  at: number
}

export interface Expiry {
  member: Member
  /** The policy that let it go last (its exit decides what happens); undefined: no policy had it. */
  policy?: Policy
}

/**
 * The retained members of one stream, as queues: the general window (every member, oldest first), a
 * queue per policy with ret:having, and what was recalled from storage. `append` and `recall` return
 * what no longer fits; each costs what it returns.
 *
 * What a ret:having policy keeps, with what was recalled, stays a contiguous run of the stream's
 * history: when one must leave, it is a member the host says may leave first (an undone change,
 * newest first), else the oldest. So an undo never finds a newer step missing while an older one is
 * there.
 */
export class StreamRetention {
  /** Every member the general policies keep, oldest first. */
  private readonly all: Member[] = []
  /** Members a ret:having policy keeps, by policy, oldest first. */
  private readonly extended = new Map<string, Member[]>()
  /** Members brought back from storage, oldest first. */
  private readonly back: Member[] = []
  /** The policy each recalled member came from. */
  private readonly from = new Map<string, Policy | undefined>()

  constructor(
    /** The stream's policies now (read on every append, so a change in the graph applies at once). */
    private readonly policies: () => Policy[],
    /** Whether a member has a property (for ret:having). */
    private readonly has: (member: string, property: string) => boolean,
    /** How many recalled members are held (ret:recallLimit). */
    private readonly recallLimit: () => number = () => 1000,
    /** Members that may leave before any other (undone changes): their IRIs. */
    private readonly leaveFirst: () => Iterable<string> = () => [],
  ) {}

  /** Members in memory: what the policies keep plus what was recalled. */
  get size(): number {
    let n = this.all.length + this.back.length
    for (const q of this.extended.values()) n += q.length
    return n
  }

  /** The oldest member in memory (for the horizon). */
  oldest(): Member | undefined {
    let o: Member | undefined
    for (const m of [this.all[0], this.back[0], ...[...this.extended.values()].map((q) => q[0])]) if (m && (!o || m.seq < o.seq)) o = m
    return o
  }

  /** Members a ret:having policy keeps (oldest first), for recalling ahead of an undo. */
  queue(policy: string): readonly Member[] {
    return this.extended.get(policy) ?? []
  }

  /** Recalled members held, oldest first. */
  recalled(): readonly Member[] {
    return this.back
  }

  /** Members restored with the stream (a remembered log): oldest first, then retired as if appended in order. */
  load(members: Member[], now: number): Expiry[] {
    const out: Expiry[] = []
    for (const m of [...members].sort((a, b) => a.seq - b.seq)) out.push(...this.append(m, now))
    return out
  }

  /** Append a member; returns the members no policy keeps any more. */
  append(member: Member, now: number): Expiry[] {
    const policies = this.policies()
    this.all.push(member)
    // No policy: the stream keeps everything (LDES: no policy, no retirement).
    if (!policies.length) return []
    const general = policies.filter((p) => !p.having.length)
    const out: Expiry[] = []
    while (this.all.length) {
      const size = this.all.length
      const m = this.all[0]!
      let kept = false
      let last: Policy | undefined
      for (const p of general) {
        const keeps = p.amount !== undefined ? size <= p.amount : p.withinMs !== undefined ? m.at >= now - p.withinMs : true
        if (keeps) kept = true
        else last = p
      }
      if (kept) break
      this.all.shift()
      out.push(...this.offer(m, last ?? general[0], policies, now))
    }
    return out
  }

  /** A member the general policies let go, offered to the first ret:having policy that matches it. */
  private offer(m: Member, from: Policy | undefined, policies: Policy[], now: number): Expiry[] {
    const p = policies.find((x) => x.having.length && x.having.some((h) => this.has(m.iri, h)))
    if (!p) return [{ member: m, policy: from }]
    let q = this.extended.get(p.iri)
    if (!q) this.extended.set(p.iri, (q = []))
    q.push(m)
    const out: Expiry[] = []
    while (q.length && ((p.amount !== undefined && q.length > p.amount) || (p.withinMs !== undefined && q[0]!.at < now - p.withinMs))) {
      const before = this.back.length
      out.push(this.evict(q, p))
      // One left what was recalled (older, or undone): the queue's oldest takes its place there, so
      // both stay at their size and together contiguous.
      if (this.back.length < before) {
        const moved = q.shift()!
        this.from.set(moved.iri, p)
        this.back.push(moved)
        this.back.sort((a, b) => a.seq - b.seq)
      }
    }
    return out
  }

  /**
   * One member leaves `q` (a policy's queue, or what was recalled) together with what was recalled:
   * an undone one first (the newest), else the oldest of the two, so what stays is contiguous.
   */
  private evict(q: Member[], p: Policy | undefined): Expiry {
    const firsts = new Set(this.leaveFirst())
    if (firsts.size) {
      let best: { list: Member[]; i: number } | undefined
      for (const list of q === this.back ? [this.back] : [q, this.back])
        for (let i = list.length - 1; i >= 0; i--)
          if (firsts.has(list[i]!.iri)) {
            if (!best || list[i]!.seq > best.list[best.i]!.seq) best = { list, i }
            break
          }
      if (best) return this.take(best.list, best.i, p)
    }
    const fromBack = q !== this.back && this.back.length && this.back[0]!.seq < q[0]!.seq
    return fromBack ? this.take(this.back, 0, p) : this.take(q, 0, p)
  }

  private take(list: Member[], i: number, p: Policy | undefined): Expiry {
    const [m] = list.splice(i, 1)
    if (list === this.back) {
      const from = this.from.get(m!.iri)
      this.from.delete(m!.iri)
      return { member: m!, policy: from ?? p }
    }
    return { member: m!, policy: p }
  }

  /** Everything recalled leaves again (memory pressure): the most recent first, with the policy each came from. */
  releaseRecalled(): Expiry[] {
    const out: Expiry[] = []
    while (this.back.length) out.push(this.take(this.back, this.back.length - 1, undefined))
    return out
  }

  /** The oldest `share` of what each ret:having policy keeps leaves (memory pressure). */
  shrink(share: number): Expiry[] {
    const out: Expiry[] = []
    const policies = new Map(this.policies().map((p) => [p.iri, p]))
    for (const [iri, q] of this.extended) {
      const n = Math.floor(q.length * share)
      for (let i = 0; i < n; i++) out.push(this.take(q, 0, policies.get(iri)))
    }
    return out
  }

  /**
   * Members brought back from storage (oldest first): held besides what the policies keep, up to the
   * recall limit; returns those that no longer fit, with the policy they came from.
   */
  recall(members: Member[], from?: Policy): Expiry[] {
    for (const m of members) this.from.set(m.iri, from)
    this.back.push(...members)
    this.back.sort((a, b) => a.seq - b.seq)
    const out: Expiry[] = []
    const limit = this.recallLimit()
    while (this.back.length > limit) out.push(this.evict(this.back, from))
    return out
  }
}
