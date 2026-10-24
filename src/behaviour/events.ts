import type { NamedNode, Quad, Quad_Graph, Term } from '@rdfjs/types'
import { BEH, EVENTS_GRAPH, LDES, NS, RDF_TYPE, RDFS_SUBCLASS, SEM, XSD_BOOLEAN, XSD_INTEGER } from '../ns.ts'
import type { Delta } from '../rdf.ts'
import { prefixesFor } from '../prefixes.ts'
import type { DomRenderer } from '../render/dom.ts'
import type { Projection, Runtime } from '../runtime.ts'
import { comboOf } from '../layers/keyboard.ts'
import { reactions as builtinReactions } from './reactions.ts'

const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime'
/** Distinguishes event IRIs across page loads sharing a store snapshot. */
const RUN = Date.now().toString(36)

/** Milliseconds in an ISO 8601 duration (days, hours, minutes, seconds). */
export function parseDuration(iso: string): number | undefined {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso)
  if (!m) return undefined
  const [, d = 0, h = 0, min = 0, sec = 0] = m.map((x) => (x === undefined ? undefined : Number(x)))
  return (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec)) * 1000
}

export interface ReactionContext {
  runtime: Runtime
  event: NamedNode
  /** The component instance the event is addressed to. */
  target: NamedNode
  /** Match over input, events and the projection's derived graph. */
  match(s: Term | null, p: string | null, o: Term | null): Quad[]
  object(s: Term, p: string): Term | undefined
}

export type ReactionFn = (ctx: ReactionContext) => Delta

export interface EventDetail {
  /** The RDF/HTML node the interaction hit. */
  node?: string
  value?: string
  checked?: boolean
  /** Numeric details (beh:x, beh:y, beh:width, beh:height). */
  numbers?: Record<string, number>
}

export interface Handled {
  /** False when no reaction produced anything (the event was not recorded). */
  recorded: boolean
  event: NamedNode
  type: string
  target: NamedNode
  reactions: string[]
  delta: Delta
}

interface Reaction {
  iri: string
  when: string
  source?: string
  sourceClass?: string
  deletes?: string
  inserts?: string
  fn?: string
}

/**
 * Records relevant interactions as RDF events and applies the reactions that
 * match them. An event is addressed to the innermost component (walking up
 * from the DOM target) that has a reaction for its class; reactions are
 * evaluated against the state before the event and applied as one delta.
 *
 * Each event, with the size of the change it caused, becomes an immutable
 * member of the beh:ChangeLog LDES; members no retention policy of the
 * stream's view keeps any more (count or age) are retired.
 */
export class EventBus {
  readonly graph: NamedNode
  private sequence = 0
  private readonly graphs: Quad_Graph[]
  /** Retained members, oldest first, so retirement touches only what expires. */
  private retained?: { event: NamedNode; at: number }[]

  constructor(
    readonly runtime: Runtime,
    readonly projection: Projection,
    private readonly opts: { functions?: Record<string, ReactionFn>; prefer?: 'sparql' | 'function'; stream?: string } = {},
  ) {
    const f = runtime.store.factory
    this.graph = f.namedNode(EVENTS_GRAPH)
    this.graphs = [f.defaultGraph(), this.graph, projection.engine.graph]
  }

  private get f() {
    return this.runtime.store.factory
  }

  private match = (s: Term | null, p: string | null, o: Term | null): Quad[] =>
    this.graphs.flatMap((g) => this.runtime.store.match(s, p ? this.f.namedNode(p) : null, o, g))

  private value(s: Term, p: string): Term | undefined {
    return this.match(s, p, null)[0]?.object
  }

  private reactions(): Reaction[] {
    const nn = (iri: string) => this.f.namedNode(iri)
    return this.runtime.store.match(null, nn(RDF_TYPE), nn(BEH.Reaction), this.f.defaultGraph()).map(({ subject: r }) => ({
      iri: r.value,
      when: this.value(r, BEH.when)?.value ?? '',
      source: this.value(r, BEH.source)?.value,
      sourceClass: this.value(r, BEH.sourceClass)?.value,
      deletes: this.value(r, BEH.deletes)?.value,
      inserts: this.value(r, BEH.inserts)?.value,
      fn: this.value(r, SEM.function)?.value,
    }))
  }

  /** Classes of a node, with superclasses. */
  private classes(node: string): Set<string> {
    const out = new Set<string>()
    const todo = this.match(this.f.namedNode(node), RDF_TYPE, null).map((q) => q.object.value)
    while (todo.length) {
      const c = todo.pop()!
      if (out.has(c)) continue
      out.add(c)
      for (const q of this.runtime.store.match(this.f.namedNode(c), this.f.namedNode(RDFS_SUBCLASS), null)) todo.push(q.object.value)
    }
    return out
  }

  /** Reactions for an event class on a component instance. */
  reactionsFor(type: string, target: string): Reaction[] {
    const types = this.classes(target)
    return this.reactions()
      .filter((r) => r.when === type && (r.source === target || (r.sourceClass !== undefined && types.has(r.sourceClass))))
      .sort((a, b) => a.iri.localeCompare(b.iri))
  }

  /** Event classes recorded from a DOM event type. */
  eventClasses(domEvent: string): string[] {
    return this.runtime.store
      .match(null, this.f.namedNode(BEH.domEvent), this.f.literal(domEvent), this.f.defaultGraph())
      .map((q) => q.subject.value)
  }

  get stream(): NamedNode {
    return this.f.namedNode(this.opts.stream ?? BEH.ChangeLog)
  }

  /** Record an event on `target`, apply its reactions, and append it to the change log. */
  emit(type: string, target: string, detail: EventDetail = {}, reactions = this.reactionsFor(type, target)): Handled {
    const { f } = this
    const nn = (iri: string) => f.namedNode(iri)
    const seq = ++this.sequence
    const event = nn(`urn:semblance:event:${RUN}-${seq}`)
    const quads = [
      f.quad(event, nn(RDF_TYPE), nn(type)),
      f.quad(event, nn(BEH.target), nn(target)),
      f.quad(event, nn(BEH.sequence), f.literal(String(seq), nn(XSD_INTEGER))),
      f.quad(event, nn(BEH.at), f.literal(new Date().toISOString(), nn(XSD_DATETIME))),
    ]
    if (detail.node !== undefined) quads.push(f.quad(event, nn(BEH.node), nn(detail.node)))
    if (detail.value !== undefined) quads.push(f.quad(event, nn(BEH.value), f.literal(detail.value)))
    if (detail.checked !== undefined) quads.push(f.quad(event, nn(BEH.checked), f.literal(String(detail.checked), nn(XSD_BOOLEAN))))
    for (const [name, v] of Object.entries(detail.numbers ?? {})) quads.push(f.quad(event, nn(NS.beh + name), f.literal(String(Math.round(v)), nn(XSD_INTEGER))))
    // The event is readable by reactions before it is a member of the stream.
    for (const q of quads) this.runtime.store.add(f.quad(q.subject, q.predicate, q.object, this.graph))

    // Every reaction sees the state before the event. Only those that change
    // something handled it (generic reactions often match and do nothing).
    const delta: Delta = { add: [], remove: [] }
    const acted: Reaction[] = []
    for (const r of reactions) {
      const d = this.react(r, event, nn(target))
      if (!d.add.length && !d.remove.length) continue
      acted.push(r)
      delta.remove.push(...d.remove)
      delta.add.push(...d.add)
    }
    reactions = acted
    for (const r of acted) quads.push(f.quad(event, nn(BEH.handledBy), nn(r.iri)))
    const forget = () => {
      for (const q of quads) this.runtime.store.delete(f.quad(q.subject, q.predicate, q.object, this.graph))
    }
    if (!delta.add.length && !delta.remove.length) {
      forget()
      return { recorded: false, event, type, target: nn(target), reactions: [], delta }
    }
    const applied = this.runtime.apply(delta)
    // Event classes marked beh:recorded false (e.g. hovers) change state but stay out of the log.
    if (this.value(nn(type), BEH.recorded)?.value === 'false') {
      forget()
      return { recorded: false, event, type, target: nn(target), reactions: reactions.map((r) => r.iri), delta: applied }
    }

    // Completing the member: its effect, its predecessor, then the tree:member link
    // and the stream's head pointer.
    const int = (n: number) => f.literal(String(n), nn(XSD_INTEGER))
    const remove = this.expired()
    const head = this.runtime.store.match(this.stream, nn(BEH.latest), null, this.graph)
    this.runtime.log({
      remove: [...remove, ...head],
      add: [
        ...quads,
        f.quad(event, nn(BEH.added), int(applied.add.length)),
        f.quad(event, nn(BEH.removed), int(applied.remove.length)),
        ...head.map((q) => f.quad(event, nn(BEH.previous), q.object)),
        f.quad(this.stream, nn(LDES.member), event),
        f.quad(this.stream, nn(BEH.latest), event),
      ],
    })
    this.members().push({ event, at: Date.now() })
    return { recorded: true, event, type, target: nn(target), reactions: reactions.map((r) => r.iri), delta: applied }
  }

  /**
   * Members (with their triples) that no retention policy of the stream's view keeps
   * once one more member is appended. Policies: beh:LatestMembersPolicy (ldes:amount)
   * and ldes:DurationAgoPolicy (tree:value, or the older ldes:fullLogDuration). No
   * policy keeps everything. Only the retired members are touched.
   */
  private expired(): Quad[] {
    const store = this.runtime.store
    const view = this.value(this.stream, LDES.view)
    const policies = view ? this.match(view, LDES.retentionPolicy, null).map((q) => q.object) : []
    if (!policies.length) return []
    const keeps: ((index: number, at: number, size: number) => boolean)[] = policies.map((p) => {
      const amount = this.value(p, LDES.amount)
      if (amount) return (i, _at, size) => size - i <= Number(amount.value)
      const duration = this.value(p, NS.tree + 'value') ?? this.value(p, LDES.fullLogDuration)
      const ms = duration ? parseDuration(duration.value) : undefined
      if (ms !== undefined) {
        const cutoff = Date.now() - ms
        return (_i, at) => at >= cutoff
      }
      return () => true
    })
    const members = this.members()
    const size = members.length + 1
    const out: Quad[] = []
    let n = 0
    while (n < members.length && !keeps.some((keep) => keep(n, members[n].at, size))) {
      const m = members[n++].event
      out.push(...store.match(this.stream, this.f.namedNode(LDES.member), m, this.graph), ...store.match(m, null, null, this.graph))
    }
    members.splice(0, n)
    return out
  }

  /** The retained members in append order, read from the graph once. */
  private members() {
    if (this.retained) return this.retained
    const store = this.runtime.store
    this.retained = store
      .match(this.stream, this.f.namedNode(LDES.member), null, this.graph)
      .map((m) => ({
        event: m.object as NamedNode,
        seq: Number(this.value(m.object, BEH.sequence)?.value ?? 0),
        at: Date.parse(this.value(m.object, BEH.at)?.value ?? '') || 0,
      }))
      .sort((a, b) => a.seq - b.seq)
      .map(({ event, at }) => ({ event, at }))
    return this.retained
  }

  /** Stream members, most recent first, with all their triples (walks back from the head). */
  recent(n = 5): Quad[][] {
    const store = this.runtime.store
    const out: Quad[][] = []
    for (let m = this.value(this.stream, BEH.latest); m && out.length < n; m = this.value(m, BEH.previous)) {
      const quads = store.match(m, null, null, this.graph)
      if (!quads.length) break
      out.push(quads)
    }
    return out
  }

  private react(r: Reaction, event: NamedNode, target: NamedNode): Delta {
    const useFn = r.fn && (!this.runtime.store.sparql || this.opts.prefer === 'function' || (!r.deletes && !r.inserts))
    if (useFn) {
      const fn = this.opts.functions?.[r.fn!] ?? builtinReactions[r.fn!]
      if (!fn) throw new Error(`No reaction function registered for "${r.fn}" (<${r.iri}>)`)
      return fn({ runtime: this.runtime, event, target, match: this.match, object: (s, p) => this.value(s, p) })
    }
    const run = (q: string | undefined) => {
      if (!q) return []
      const prefixes = prefixesFor(this.runtime.store)
      const text = (prefixes + '\n' + q).replaceAll('$event', `<${event.value}>`).replaceAll('$this', `<${target.value}>`)
      try {
        return this.runtime.store.construct(text, this.graphs)
      } catch (e) {
        throw new Error(`Reaction <${r.iri}> failed: ${(e as Error).message}`)
      }
    }
    return { remove: run(r.deletes), add: run(r.inserts) }
  }

  /**
   * Record DOM interactions inside a rendered projection. For each DOM event,
   * the innermost component with a matching reaction receives the RDF event.
   */
  attach(renderer: DomRenderer, onHandled: (h: Handled) => void = () => {}): () => void {
    const domTypes = new Set(this.runtime.store.match(null, this.f.namedNode(BEH.domEvent), null).map((q) => q.object.value))
    const listener = (e: Event) => {
      if (renderer.inSlot(e.target as Node)) return
      const types = this.eventClasses(e.type)
      let node: string | undefined
      for (let el = e.target as Node | null; el && el !== renderer.host; el = el.parentNode) {
        const key = renderer.keyOf(el)
        node ??= key
        const focus = key && renderer.index.focusOf(key)
        if (!focus) continue
        for (const type of types) {
          const reactions = this.reactionsFor(type, focus)
          if (!reactions.length) continue
          const control = e.target as HTMLInputElement
          const detail: EventDetail = { node }
          if (e.type !== 'click' && e.type !== 'mouseover' && 'value' in control && typeof control.value === 'string') detail.value = control.value
          if (control.type === 'checkbox') detail.checked = control.checked
          const custom = (e as CustomEvent).detail
          if (custom && typeof custom === 'object') detail.numbers = custom as Record<string, number>
          const handled = this.emit(type, focus, detail, reactions)
          if (handled.recorded || handled.delta.add.length || handled.delta.remove.length) onHandled(handled)
          return
        }
      }
    }
    for (const t of domTypes) renderer.host.addEventListener(t, listener)
    const gestures = (e: Event) => this.gesture(e as PointerEvent, renderer)
    renderer.host.addEventListener('pointerdown', gestures)
    // Keyboard layer: a key combination activates the element that declares it.
    const doc = renderer.host.ownerDocument
    const apple = /Mac|iPhone|iPad/.test(doc.defaultView?.navigator?.platform ?? '')
    const keys = (e: Event) => {
      const k = e as KeyboardEvent
      if (!k.key || ['Shift', 'Control', 'Alt', 'Meta'].includes(k.key)) return
      const combo = comboOf(k, apple)
      const typing = (k.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]')
      if (typing && !combo.startsWith('mod+') && k.key !== 'Escape') return
      const el = [...renderer.host.querySelectorAll('[data-sem-shortcut]')].find((x) => x.getAttribute('data-sem-shortcut') === combo) as HTMLElement | undefined
      if (!el || el.closest('[hidden], [inert]')) return
      k.preventDefault()
      const field = el.matches('input, textarea, select') ? el : (el.querySelector('input:not([type=checkbox]):not([type=radio]), textarea, select') as HTMLElement | null)
      if (field) return field.focus()
      const control = el.matches('button, a, [role=button], input') ? el : (el.querySelector('button, a, [role=button], input') as HTMLElement | null)
      ;(control ?? el).click()
    }
    doc.addEventListener('keydown', keys)
    return () => {
      for (const t of domTypes) renderer.host.removeEventListener(t, listener)
      renderer.host.removeEventListener('pointerdown', gestures)
      doc.removeEventListener('keydown', keys)
    }
  }

  /**
   * Drag gestures on handles marked data-sem-gesture: the nearest component
   * root follows the pointer (a transient view change), and on release one
   * sem-move / sem-resize DOM event carries the result into an RDF event.
   */
  private gesture(e: PointerEvent, renderer: DomRenderer) {
    const handle = (e.target as Element).closest?.('[data-sem-gesture]') as HTMLElement | null
    if (!handle || e.button !== 0 || (e.target as Element).closest('button, input, select, textarea')) return
    let box: HTMLElement | null = handle
    while (box && !(renderer.keyOf(box) && renderer.index.focusOf(renderer.keyOf(box)!))) box = box.parentElement
    if (!box) return
    const kind = handle.dataset.semGesture
    const start = { x: e.clientX, y: e.clientY, left: box.offsetLeft, top: box.offsetTop, width: box.offsetWidth, height: box.offsetHeight }
    const target = box
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    const move = (m: PointerEvent) => {
      const dx = m.clientX - start.x
      const dy = m.clientY - start.y
      if (kind === 'move') Object.assign(target.style, { left: `${start.left + dx}px`, top: `${Math.max(0, start.top + dy)}px` })
      else Object.assign(target.style, { width: `${Math.max(280, start.width + dx)}px`, height: `${Math.max(180, start.height + dy)}px` })
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      const detail =
        kind === 'move' ? { x: target.offsetLeft, y: target.offsetTop } : { width: target.offsetWidth, height: target.offsetHeight }
      handle.dispatchEvent(new CustomEvent(kind === 'move' ? 'sem-move' : 'sem-resize', { bubbles: true, detail }))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
}
