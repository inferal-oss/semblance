// Memory pressure (docs/RETENTION.md): a budget in the graph (ret:MemoryBudget), measured in idle
// time, answered in a fixed order, cheapest and safest first.
//
//   1. evict derived state: the renderings of what is hidden (Runtime.evict, both projections);
//   2. compact the engines (a store that can, GraphStore.compact);
//   3. offload history: what was recalled, and at Critical half of what ret:having policies hold;
//   4. raise ret:Pressure on the budget, for the app's reactions to answer (announced);
//   5. ask the host (onRetention), the last line of defence.
//
// Owned data is never dropped at any step. The level and the figures are graph state, in
// urn:semblance:retention, so the Memory tool and an app's own views read them; ret:simulate makes
// the effect act as if a level held (the tool, tests), and ret:request asks for one step now.
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import type { EventBus } from '../behaviour/events.ts'
import { NS, RETENTION_GRAPH } from '../ns.ts'
import type { Runtime } from '../runtime.ts'

const RET = NS.ret
const RDF_TYPE = NS.rdf + 'type'
const MIB = 2 ** 20

export type Level = 'normal' | 'elevated' | 'critical'

/** What the host is told when the effect's own steps were not enough. */
export interface PressureReport {
  /** 'memory': the budget stayed exceeded; 'storage': the browser refused to take offloaded history. */
  reason: 'memory' | 'storage'
  level: Level
  usedBytes: number
  maxBytes: number
  /** For 'storage': the stream whose history waits in memory, and how many members. */
  stream?: string
  pending?: number
}

/**
 * The host's answer: a new budget (memory), or whether history storage refused may be dropped
 * (storage; without an answer, what waits is kept in memory up to twice its policies' amounts, then
 * the oldest is dropped, counted and announced).
 */
export interface RetentionAnswer {
  maxBytes?: number
  drop?: boolean
}

export type OnRetention = (report: PressureReport) => RetentionAnswer | void | Promise<RetentionAnswer | void>

export interface Sample {
  wasmBytes: number
  heapBytes?: number
}

export interface PressureOptions {
  /** Raises ret:Pressure (its reactions announce it). */
  bus?: EventBus
  /** The last line of defence. */
  onRetention?: OnRetention
  /** A budget for a graph that declares none (mount's maxMemory). */
  maxBytes?: number
  /** How to measure (tests replace it). */
  sample?: () => Sample
  /** How often to measure (ms, default 2000), in idle time. */
  every?: number
  /** After a step changed the graph (to patch the DOM). */
  onChange?: () => void
}

/** The engines' WebAssembly memory and, where the browser reports it, the JS heap. */
export function measure(runtime: Runtime): Sample {
  const store = runtime.store
  const wasmBytes = store.memoryBytes?.() ?? (store as unknown as { engine?: { x?: { memory?: WebAssembly.Memory } } }).engine?.x?.memory?.buffer.byteLength ?? 0
  const memory = (globalThis.performance as unknown as { memory?: { usedJSHeapSize: number } } | undefined)?.memory
  return { wasmBytes, heapBytes: memory?.usedJSHeapSize }
}

export class MemoryPressure {
  private escalation = 0
  private raised = false
  private asked = false
  private evicted = 0
  private written = new Map<string, string>()
  private timer?: ReturnType<typeof setInterval>
  level: Level = 'normal'

  constructor(
    readonly runtime: Runtime,
    readonly opts: PressureOptions = {},
  ) {
    // History the browser refused to store, waiting in memory past its bound: the host decides.
    const ask = opts.onRetention
    if (ask)
      runtime.retention.opts.onStorage = async (stream, waiting) => {
        const answer = await ask({ reason: 'storage', level: this.level, usedBytes: 0, maxBytes: 0, stream, pending: waiting })
        return answer?.drop === false ? 'keep' : 'drop'
      }
  }

  private get f() {
    return this.runtime.store.factory
  }

  /** The budget node: the graph's ret:MemoryBudget, or one made for the host's maxBytes. */
  budget(): NamedNode | undefined {
    const store = this.runtime.store
    const f = this.f
    const found = store.match(null, f.namedNode(RDF_TYPE), f.namedNode(RET + 'MemoryBudget'), f.defaultGraph())[0]?.subject
    if (found) return found as NamedNode
    if (this.opts.maxBytes === undefined) return undefined
    const b = f.namedNode('urn:semblance:memory')
    this.runtime.apply({ remove: [], add: [f.quad(b, f.namedNode(RDF_TYPE), f.namedNode(RET + 'MemoryBudget')), f.quad(b, f.namedNode(RET + 'maxBytes'), f.literal(String(this.opts.maxBytes), f.namedNode(NS.xsd + 'integer')))] })
    return b
  }

  private one(s: Term, p: string): Term | undefined {
    return this.runtime.store.match(s as NamedNode, this.f.namedNode(p), null, this.f.defaultGraph())[0]?.object
  }

  /** Measure in idle time, every `every` ms, and act on requests as they are written. Returns a stop. */
  attach(): () => void {
    const stopInput = this.runtime.onInput((graph, delta) => {
      if (graph !== undefined) return
      const asks = (q: Quad) => [RET + 'request', RET + 'simulate', RET + 'maxMiB', RET + 'maxBytes'].includes(q.predicate.value) || (q.predicate.value === NS.c + 'value' && this.controls(q.subject))
      if (delta.add.some(asks)) queueMicrotask(() => void this.step())
    })
    const g = globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }
    const idle = (run: () => void) => (g.requestIdleCallback ? g.requestIdleCallback(run, { timeout: 1000 }) : setTimeout(run, 0))
    this.timer = setInterval(() => idle(() => void this.step()), this.opts.every ?? 2000)
    const stopEnd = this.runtime.onEnd(() => this.stop())
    return () => {
      stopInput()
      stopEnd()
      this.stop()
    }
  }

  /** Whether a node is the control a budget follows (ret:maxFrom). */
  private controls(node: Term): boolean {
    return this.runtime.store.match(null, this.f.namedNode(RET + 'maxFrom'), node as NamedNode, this.f.defaultGraph()).length > 0
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One measurement, and what its level asks for. */
  async step(): Promise<Level> {
    if (this.runtime.ended) return this.level
    const b = this.budget()
    if (!b) return this.level
    const f = this.f
    const store = this.runtime.store
    // Requests first: a person asked for a step now.
    for (const q of store.match(b, f.namedNode(RET + 'request'), null, f.defaultGraph())) {
      if (q.object.value === RET + 'Evict') this.evict(Infinity)
      if (q.object.value === RET + 'OffloadNow') this.offload('critical')
      this.runtime.apply({ add: [], remove: [q] })
    }
    const maxBytes = this.maxBytes(b)
    const x = (this.opts.sample ?? (() => measure(this.runtime)))()
    const triples = store.size?.() ?? 0
    // Without a heap figure (outside Chromium), the store's size stands in for what the heap holds.
    const used = x.wasmBytes + (x.heapBytes ?? triples * 120)
    const elevatedAt = Number(this.one(b, RET + 'elevatedAt')?.value ?? 0.8)
    const measured: Level = used >= maxBytes ? 'critical' : used >= maxBytes * elevatedAt ? 'elevated' : 'normal'
    const simulated = this.one(b, RET + 'simulate')?.value
    const level: Level = simulated === RET + 'Critical' ? 'critical' : simulated === RET + 'Elevated' ? 'elevated' : simulated === RET + 'Normal' ? 'normal' : measured
    this.level = level
    this.runtime.pressure = level
    if (level === 'normal') {
      this.escalation = 0
      this.raised = this.asked = false
    } else {
      // 1, 2, 3: evict, compact, offload.
      const derived = this.derived()
      this.evict(level === 'critical' ? Infinity : Math.ceil(derived * 0.25))
      // A compaction copies the whole store: only when live state is below most of the memory
      // (after the eviction above), so lasting pressure does not copy a store that cannot shrink.
      store.compact?.({ below: level === 'critical' ? 0.9 : 0.75 })
      this.offload(level)
      if (level === 'critical') this.escalation++
      // 4: the app's reactions, once a crossing.
      if (level === 'critical' && this.escalation >= 2 && !this.raised && this.opts.bus) {
        this.raised = true
        this.opts.bus.emit(RET + 'Pressure', b.value)
      }
      // 5: the host, last.
      if (level === 'critical' && this.escalation >= 3 && !this.asked && this.opts.onRetention) {
        this.asked = true
        const answer = await this.opts.onRetention({ reason: 'memory', level, usedBytes: used, maxBytes })
        if (answer?.maxBytes && !this.runtime.ended) {
          const p = f.namedNode(RET + 'maxBytes')
          this.runtime.apply({ remove: store.match(b, p, null, f.defaultGraph()), add: [f.quad(b, p, f.literal(String(Math.round(answer.maxBytes)), f.namedNode(NS.xsd + 'integer')))] })
        }
      }
    }
    this.report(b, { level, used, wasm: x.wasmBytes, heap: x.heapBytes, triples, derived: this.derived() })
    if (!this.runtime.ended) this.opts.onChange?.()
    return level
  }

  private maxBytes(b: Term): number {
    const bytes = this.one(b, RET + 'maxBytes')
    if (bytes) return Number(bytes.value)
    const mib = this.one(b, RET + 'maxMiB')
    if (mib) return Number(mib.value) * MIB
    const control = this.one(b, RET + 'maxFrom')
    const set = control && this.one(control, NS.c + 'value')
    if (set) return Number(set.value) * MIB
    return this.opts.maxBytes ?? Infinity
  }

  /** Derived triples across projections (what eviction can release). */
  private derived(): number {
    return this.runtime.projections.reduce((n, p) => n + p.engine.derivedSize, 0)
  }

  private evict(limit: number) {
    this.evicted += this.runtime.evict(limit)
  }

  /** Offload what retention holds beyond its policies: what was recalled, and at Critical half of what ret:having policies keep. */
  private offload(level: Level) {
    for (const s of this.runtime.retention.all()) s.relieve(level === 'critical' ? 0.5 : 0)
  }

  private report(b: NamedNode, x: { level: Level; used: number; wasm: number; heap?: number; triples: number; derived: number }) {
    const f = this.f
    const nn = (iri: string) => f.namedNode(iri)
    const mib = (n: number) => f.literal((Math.round((n / MIB) * 10) / 10).toFixed(1), nn(NS.xsd + 'decimal'))
    const int = (n: number) => f.literal(String(n), nn(NS.xsd + 'integer'))
    const want = new Map<string, Term>([
      [RET + 'level', nn(RET + x.level[0]!.toUpperCase() + x.level.slice(1))],
      [RET + 'usedMiB', mib(x.used)],
      [RET + 'wasmMiB', mib(x.wasm)],
      [RET + 'triples', int(x.triples)],
      [RET + 'derivedTriples', int(x.derived)],
      [RET + 'evicted', int(this.evicted)],
    ])
    if (x.heap !== undefined) want.set(RET + 'heapMiB', mib(x.heap))
    const g = nn(RETENTION_GRAPH)
    const store = this.runtime.store
    const add: Quad[] = []
    const remove: Quad[] = []
    for (const [p, o] of want) {
      const key = o.termType + ':' + o.value
      if (this.written.get(p) === key) continue
      remove.push(...store.match(b, nn(p), null, g))
      add.push(f.quad(b, nn(p), o as NamedNode))
      this.written.set(p, key)
    }
    if (add.length || remove.length) this.runtime.write(RETENTION_GRAPH, { add, remove })
  }
}
