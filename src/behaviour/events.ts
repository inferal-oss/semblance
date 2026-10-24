import type { NamedNode, Quad, Quad_Graph, Term } from '@rdfjs/types'
import { BEH, EVENTS_GRAPH, KEY, LDES, NS, RDF_TYPE, RDFS_SUBCLASS, SEM, XSD_BOOLEAN, XSD_INTEGER } from '../ns.ts'
import { type Delta, MINT_SEPARATOR, owningFocus, parseDuration } from '../rdf.ts'
import { prefixesFor } from '../prefixes.ts'
import type { DomRenderer } from '../render/dom.ts'
import type { Projection, Runtime } from '../runtime.ts'
import { comboOf, navigate, normalizeShortcut, rove } from '../layers/keyboard.ts'
import { reactions as builtinReactions } from './reactions.ts'
import { DragHost } from './drag.ts'
import { type Clock, systemClock } from './clock.ts'

const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime'
/** Distinguishes event IRIs across page loads sharing a store snapshot. */
const RUN = Date.now().toString(36)

// Re-exported: persistence imports it from rdf.ts, so it does not import this module (which imports it back).
export { parseDuration }

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
  /** A text control's caret (selectionStart) after the interaction (beh:caret). */
  caret?: number
  /** The key combination of a key press, normalized as key:shortcut is ("tab", "mod+enter"; beh:key). */
  key?: string
  /** Further statements about the event, by predicate (a drop carries the drag's: what, from, where). */
  about?: [predicate: string, object: Term][]
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
  /** What time an event happens at (beh:at): the host's clock, which tests can move by hand. */
  readonly clock: Clock

  constructor(
    readonly runtime: Runtime,
    readonly projection: Projection,
    private readonly opts: { functions?: Record<string, ReactionFn>; prefer?: 'sparql' | 'function'; stream?: string; clock?: Clock } = {},
  ) {
    this.clock = opts.clock ?? systemClock()
    const f = runtime.store.factory
    this.graph = f.namedNode(EVENTS_GRAPH)
    this.graphs = [f.defaultGraph(), this.graph, projection.engine.graph]
    // Reactions and the class hierarchy are read once and kept until the input changes
    // them (a reaction's triples, a type, a subclass link).
    runtime.onInput((graph, delta) => {
      if (graph !== undefined) return
      for (const q of [...delta.add, ...delta.remove]) {
        const p = q.predicate.value
        if (p.startsWith(NS.beh) || p === SEM.function || p === RDFS_SUBCLASS) this.cachedReactions = undefined
        if (p === RDF_TYPE || p === RDFS_SUBCLASS) this.classCache.clear()
      }
    })
    // Types the projection derives (minted components) change a node's classes too.
    projection.engine.onChange((delta) => {
      for (const q of [...delta.add, ...delta.remove]) if (q.predicate.value === RDF_TYPE) this.classCache.delete(q.subject.value)
    })
  }

  private cachedReactions?: Map<string, Reaction[]>
  private classCache = new Map<string, Set<string>>()

  private get f() {
    return this.runtime.store.factory
  }

  private match = (s: Term | null, p: string | null, o: Term | null): Quad[] =>
    this.graphs.flatMap((g) => this.runtime.store.match(s, p ? this.f.namedNode(p) : null, o, g))

  private value(s: Term, p: string): Term | undefined {
    return this.match(s, p, null)[0]?.object
  }

  /** Reactions by the event class they handle (cached; see the constructor). */
  private reactionsByEvent(): Map<string, Reaction[]> {
    if (this.cachedReactions) return this.cachedReactions
    const byEvent = new Map<string, Reaction[]>()
    for (const r of this.reactions()) {
      let list = byEvent.get(r.when)
      if (!list) byEvent.set(r.when, (list = []))
      list.push(r)
    }
    for (const list of byEvent.values()) list.sort((a, b) => a.iri.localeCompare(b.iri))
    return (this.cachedReactions = byEvent)
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
    const cached = this.classCache.get(node)
    if (cached) return cached
    const out = new Set<string>()
    const todo = this.match(this.f.namedNode(node), RDF_TYPE, null).map((q) => q.object.value)
    while (todo.length) {
      const c = todo.pop()!
      if (out.has(c)) continue
      out.add(c)
      for (const q of this.runtime.store.match(this.f.namedNode(c), this.f.namedNode(RDFS_SUBCLASS), null)) todo.push(q.object.value)
    }
    this.classCache.set(node, out)
    return out
  }

  /** Reactions for an event class on a component instance. */
  reactionsFor(type: string, target: string): Reaction[] {
    const candidates = this.reactionsByEvent().get(type)
    if (!candidates) return []
    const types = this.classes(target)
    return candidates.filter((r) => r.source === target || (r.sourceClass !== undefined && types.has(r.sourceClass)))
  }

  /** Where the pointer was last seen (view state, for commands that act "here"). */
  private pointer?: { x: number; y: number }

  /** The pointer's place for a command event: the RDF/HTML node under it and its distance to the viewport's edges. */
  private pointerDetail(renderer: DomRenderer): EventDetail {
    const p = this.pointer
    const view = renderer.host.ownerDocument.defaultView
    if (!p || !view) return {}
    let node: string | undefined
    for (let el: Node | null = renderer.host.ownerDocument.elementFromPoint?.(p.x, p.y) ?? null; el && el !== renderer.host; el = el.parentNode) {
      node = renderer.keyOf(el)
      if (node) break
    }
    return { node, numbers: { x: p.x, y: p.y, toEnd: view.innerWidth - p.x, toBottom: view.innerHeight - p.y } }
  }

  /** The key:Command bound to a (normalized) key combination, if any. */
  commandFor(combo: string): string | undefined {
    const store = this.runtime.store
    const type = this.f.namedNode(RDF_TYPE)
    const command = this.f.namedNode(KEY.Command)
    for (const q of store.match(null, this.f.namedNode(KEY.shortcut), null, this.f.defaultGraph())) {
      if (normalizeShortcut(q.object.value) === combo && store.match(q.subject, type, command, this.f.defaultGraph()).length) return q.subject.value
    }
    return undefined
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
    // A restored log (persistence) continues where it left off.
    if (this.sequence === 0) {
      for (const q of this.runtime.store.match(null, f.namedNode(BEH.sequence), null, this.graph)) this.sequence = Math.max(this.sequence, Number(q.object.value) || 0)
    }
    const seq = ++this.sequence
    const event = nn(`urn:semblance:event:${RUN}-${seq}`)
    const quads = [
      f.quad(event, nn(RDF_TYPE), nn(type)),
      f.quad(event, nn(BEH.target), nn(target)),
      f.quad(event, nn(BEH.sequence), f.literal(String(seq), nn(XSD_INTEGER))),
      f.quad(event, nn(BEH.at), f.literal(new Date(this.clock.now()).toISOString(), nn(XSD_DATETIME))),
    ]
    if (detail.node !== undefined) quads.push(f.quad(event, nn(BEH.node), nn(detail.node)))
    if (detail.value !== undefined) quads.push(f.quad(event, nn(BEH.value), f.literal(detail.value)))
    if (detail.checked !== undefined) quads.push(f.quad(event, nn(BEH.checked), f.literal(String(detail.checked), nn(XSD_BOOLEAN))))
    if (detail.caret !== undefined) quads.push(f.quad(event, nn(NS.beh + 'caret'), f.literal(String(detail.caret), nn(XSD_INTEGER))))
    if (detail.key !== undefined) quads.push(f.quad(event, nn(NS.beh + 'key'), f.literal(detail.key)))
    for (const [p, o] of detail.about ?? []) quads.push(f.quad(event, nn(p), o as NamedNode))
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
    // The state change and the member that records it are one tick: views over the log and
    // over the state agree after every event (docs/IVM.md, decision 8).
    return this.runtime.transaction(() => {
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
    })
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
    const doc = renderer.host.ownerDocument
    const apple = /Mac|iPhone|iPad/.test(doc.defaultView?.navigator?.platform ?? '')
    // Key presses a reaction handled are not also the keyboard layer's (nor the browser's).
    const consumed = new WeakSet<Event>()
    const listener = (e: Event) => {
      if (renderer.inSlot(e.target as Node)) return
      // Key events carry their combination; an event class may name the keys it is for (beh:key).
      const combo = e.type.startsWith('key') && (e as KeyboardEvent).key ? comboOf(e as KeyboardEvent, apple) : undefined
      const types = combo === undefined ? this.eventClasses(e.type) : this.eventClasses(e.type).filter((t) => this.forKey(t, combo))
      if (!types.length) return
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
          if (detail.value !== undefined && typeof control.selectionStart === 'number') detail.caret = control.selectionStart
          if (combo !== undefined) detail.key = combo
          const custom = (e as CustomEvent).detail
          if (custom && typeof custom === 'object') detail.numbers = custom as Record<string, number>
          const handled = this.emit(type, focus, detail, reactions)
          // Reactions that changed nothing let the event reach the enclosing components
          // (a generic reaction on c:Button must not swallow its container's click).
          if (!handled.recorded && !handled.delta.add.length && !handled.delta.remove.length) continue
          if (combo !== undefined) e.preventDefault(), consumed.add(e)
          onHandled(handled)
          this.placeCaret(renderer, focus)
          return
        }
      }
    }
    // Drag and drop (ontology/layers/dragdrop.ttl): the pointer gesture (below), and its keys before
    // any other key handling - on the host for keys inside it, on the document for the rest.
    const drags = new DragHost(this, renderer, onHandled)
    const dragKeys = (e: Event) => {
      if ((e.currentTarget === doc) === renderer.host.contains(e.target as Node)) return
      if (drags.key(e as KeyboardEvent, apple)) e.preventDefault(), e.stopImmediatePropagation()
    }
    const native = (e: Event) => (e.target as Element).closest?.('[data-sem-gesture=drag]') && e.preventDefault()
    renderer.host.addEventListener('keydown', dragKeys)
    doc.addEventListener('keydown', dragKeys)
    renderer.host.addEventListener('dragstart', native)
    for (const t of domTypes) renderer.host.addEventListener(t, listener)
    // A field marked data-sem-controlled shows what the graph says once its input is handled,
    // also when nothing changed (a code input drops characters its charset does not allow).
    const controlled = (e: Event) => {
      const field = e.target as HTMLInputElement
      const key = field.hasAttribute?.('data-sem-controlled') ? renderer.keyOf(field) : undefined
      if (!key) return
      const value = new Map(renderer.index.attributes(key)).get('value') ?? ''
      if (field.value !== value) field.value = value
    }
    renderer.host.addEventListener('input', controlled)
    const gestures = (e: Event) => this.gesture(e as PointerEvent, renderer, drags)
    renderer.host.addEventListener('pointerdown', gestures)
    // Keyboard layer: a key combination activates the element that declares it.
    const keys = (e: Event) => {
      const k = e as KeyboardEvent
      if (!k.key || consumed.has(k) || ['Shift', 'Control', 'Alt', 'Meta'].includes(k.key)) return
      if (renderer.host.contains(k.target as Node) && (sizeByKey(k, renderer) || moveByKey(k, renderer) || navigate(k))) return k.preventDefault()
      const combo = comboOf(k, apple)
      const typing = (k.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]')
      if (typing && !combo.startsWith('mod+') && k.key !== 'Escape') return
      // Commands (key:Command) are graph nodes, not elements: the press becomes their event,
      // carrying where the pointer is (the node under it, its distance to the edges).
      const command = this.commandFor(combo)
      if (command && !(typing && this.value(this.f.namedNode(command), KEY.whileTyping)?.value === 'false')) {
        k.preventDefault()
        const handled = this.emit(KEY.Press, command, this.pointerDetail(renderer))
        if (handled.recorded || handled.delta.add.length || handled.delta.remove.length) onHandled(handled)
        return
      }
      const el = [...renderer.host.querySelectorAll('[data-sem-shortcut]')].find((x) => x.getAttribute('data-sem-shortcut') === combo) as HTMLElement | undefined
      if (!el && combo === 'escape') {
        // Escape dismisses the most recent open overlay: its control marked data-sem-escape.
        const dismiss = [...renderer.host.querySelectorAll('[data-sem-escape]')].filter((x) => !x.closest('[hidden]')).at(-1) as HTMLElement | undefined
        if (dismiss) k.preventDefault(), dismiss.click()
        return
      }
      if (!el || el.closest('[hidden], [inert]')) return
      k.preventDefault()
      const field = el.matches('input, textarea, select') ? el : (el.querySelector('input:not([type=checkbox]):not([type=radio]), textarea, select') as HTMLElement | null)
      if (field) return field.focus()
      const control = el.matches('button, a, [role=button], input') ? el : (el.querySelector('button, a, [role=button], input') as HTMLElement | null)
      ;(control ?? el).click()
    }
    doc.addEventListener('keydown', keys)
    const track = (e: Event) => {
      const p = e as PointerEvent
      this.pointer = { x: p.clientX, y: p.clientY }
    }
    doc.addEventListener('pointermove', track, { passive: true })
    // Entering a navigable component by Tab puts the rest of its parts out of the tab order.
    const entered = (e: Event) => {
      const part = e.target as HTMLElement
      const root = part.closest?.('[data-sem-nav-items]')
      if (root && part.matches(root.getAttribute('data-sem-nav-items')!)) rove(root, part)
    }
    renderer.host.addEventListener('focusin', entered)
    return () => {
      for (const t of domTypes) renderer.host.removeEventListener(t, listener)
      renderer.host.removeEventListener('input', controlled)
      renderer.host.removeEventListener('pointerdown', gestures)
      renderer.host.removeEventListener('keydown', dragKeys)
      doc.removeEventListener('keydown', dragKeys)
      renderer.host.removeEventListener('dragstart', native)
      drags.dispose()
      doc.removeEventListener('keydown', keys)
      doc.removeEventListener('pointermove', track)
      renderer.host.removeEventListener('focusin', entered)
    }
  }

  /** Whether an event class is recorded for a key combination: any key, unless it names some (beh:key). */
  private forKey(type: string, key: string): boolean {
    const keys = this.runtime.store.match(this.f.namedNode(type), this.f.namedNode(NS.beh + 'key'), null, this.f.defaultGraph())
    return !keys.length || keys.some((q) => q.object.value === key)
  }

  /**
   * A text control rendered with data-sem-caret keeps its caret where the graph says
   * after an event its component handled (rewriting the value would put it at the end).
   */
  private placeCaret(renderer: DomRenderer, focus: string) {
    const root = renderer.nodeOf(focus + MINT_SEPARATOR + 'root') as HTMLElement | undefined
    // Only the component's own control (not one of a component nested in it).
    const field = [...(root?.querySelectorAll?.('[data-sem-caret]') ?? [])].find((el) => owningFocus(renderer.keyOf(el) ?? '') === focus) as
      | HTMLTextAreaElement
      | undefined
    const at = Number(field?.getAttribute('data-sem-caret'))
    if (!field || !Number.isFinite(at) || typeof field.setSelectionRange !== 'function') return
    if (field.ownerDocument.activeElement !== field) field.focus?.()
    if (field.selectionStart !== at || field.selectionEnd !== at) field.setSelectionRange(at, at)
  }

  /**
   * Drag gestures on handles marked data-sem-gesture: the nearest component
   * root follows the pointer (a transient view change), and on release one
   * sem-move / sem-resize DOM event carries the result into an RDF event. A "drag" handle
   * carries what it shows to drop targets (src/behaviour/drag.ts).
   *
   * A move says where the box was let go (x, y), how far the pointer was from each edge of the
   * viewport, and how fast it was going then (inlineVelocity, blockVelocity, px/s): the graph
   * decides whether that docks it (c:snapDistance, c:throwTime). A handle marked
   * data-sem-move-size="content" carries its box at the box's own size, floating; any other is
   * pinned to the size it had, so a frame attached to an edge comes away whole.
   */
  private gesture(e: PointerEvent, renderer: DomRenderer, drags: DragHost) {
    const handle = (e.target as Element).closest?.('[data-sem-gesture]') as HTMLElement | null
    if (!handle || e.button !== 0 || (e.target as Element).closest('button, input, select, textarea')) return
    if (handle.dataset.semGesture === 'size') return this.sizeGesture(e, handle, renderer)
    if (handle.dataset.semGesture === 'drag') return drags.pointer(e, handle)
    const box = boxOf(handle, renderer)
    if (!box) return
    const kind = handle.dataset.semGesture
    // Where the box is on screen (a theme may centre it with a translate, which the drag drops).
    const rect = box.getBoundingClientRect()
    const start = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, width: box.offsetWidth, height: box.offsetHeight }
    const target = box
    const natural = kind === 'move' && handle.dataset.semMoveSize === 'content'
    // What the graph says (the renderer's last write); the drag only changes the view until release.
    const original = target.getAttribute('style')
    const edge = target.getAttribute('data-sem-edge')
    e.preventDefault()
    handle.setPointerCapture?.(e.pointerId)
    // The last moments of the gesture, for its velocity at release.
    const trail: { x: number; y: number; t: number }[] = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }]
    let moved = false
    const move = (m: PointerEvent) => {
      const dx = m.clientX - start.x
      const dy = m.clientY - start.y
      trail.push({ x: m.clientX, y: m.clientY, t: m.timeStamp })
      while (trail.length > 2 && m.timeStamp - trail[0]!.t > 100) trail.shift()
      if (kind === 'move') {
        if (!moved && natural) target.setAttribute('data-sem-edge', 'none')
        moved = true
        const size = natural ? {} : { width: `${start.width}px`, height: `${start.height}px` }
        // Grabbed docked, it comes away at its own size under the pointer, as far into it as it was.
        const width = natural ? target.offsetWidth : start.width
        const height = natural ? target.offsetHeight : start.height
        const left = natural ? m.clientX - Math.min(start.x - start.left, width / 2) : start.left + dx
        const top = natural ? m.clientY - Math.min(start.y - start.top, height / 2) : start.top + dy
        Object.assign(target.style, { left: `${left}px`, top: `${Math.max(0, top)}px`, right: 'auto', bottom: 'auto', translate: 'none', ...size })
      } else Object.assign(target.style, { width: `${Math.max(280, start.width + dx)}px`, height: `${Math.max(180, start.height + dy)}px` })
    }
    const up = (u: PointerEvent) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      let detail: Record<string, number> | undefined
      if (kind === 'move' && moved && u.type === 'pointerup') {
        // Where the pointer was released, as distances to the viewport's logical edges (for snapping).
        const view = target.ownerDocument.documentElement
        const rtl = target.ownerDocument.defaultView?.getComputedStyle(target).direction === 'rtl'
        const fromLeft = u.clientX
        const fromRight = view.clientWidth - u.clientX
        // Its velocity over the last 100 ms (none if it came to rest before it was let go).
        const first = trail[0]!
        const span = u.timeStamp - first.t
        const still = u.timeStamp - trail[trail.length - 1]!.t > 60
        const vx = span > 0 && !still ? ((u.clientX - first.x) / span) * 1000 : 0
        const vy = span > 0 && !still ? ((u.clientY - first.y) / span) * 1000 : 0
        const placed = target.getBoundingClientRect()
        detail = {
          x: natural ? placed.left : target.offsetLeft,
          y: natural ? placed.top : target.offsetTop,
          toStart: rtl ? fromRight : fromLeft,
          toEnd: rtl ? fromLeft : fromRight,
          toTop: u.clientY,
          toBottom: view.clientHeight - u.clientY,
          inlineVelocity: rtl ? -vx : vx,
          blockVelocity: vy,
        }
      } else if (kind !== 'move') detail = { width: target.offsetWidth, height: target.offsetHeight }
      // Back to the graph's state: the reactions decide what the gesture did (moved, snapped
      // to an edge, or nothing), and the renderer shows that.
      if (original === null) target.removeAttribute('style')
      else target.setAttribute('style', original)
      if (edge === null) target.removeAttribute('data-sem-edge')
      else target.setAttribute('data-sem-edge', edge)
      // A press that never moved (or a gesture the browser took over) changes nothing.
      if (detail) handle.dispatchEvent(new CustomEvent(kind === 'move' ? 'sem-move' : 'sem-resize', { bubbles: true, detail }))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  /**
   * One-axis sizing (data-sem-gesture="size": a separator, a column's edge, a panel's free
   * edge). The handle says what it sizes (data-sem-sizes: "previous" or "next" for a sibling,
   * else a selector for its closest ancestor, else the nearest component root), along which
   * axis (data-sem-axis "x" or "y"), in which direction (data-sem-sign -1 when dragging toward
   * the start grows it) and within which bounds (data-sem-min, data-sem-max, in px). While
   * dragging only the view changes; on release one sem-size DOM event carries the new size
   * and the room there was (the sized element's parent along the axis) into a beh:Size event.
   */
  private sizeGesture(e: PointerEvent, handle: HTMLElement, renderer: DomRenderer) {
    const target = sizedBy(handle, renderer)
    if (!target) return
    const { axis, sign, min, max } = sizing(handle)
    const start = { at: axis === 'x' ? e.clientX : e.clientY, size: measure(target, axis) }
    const original = target.getAttribute('style')
    e.preventDefault()
    handle.setPointerCapture?.(e.pointerId)
    let size = start.size
    const move = (m: PointerEvent) => {
      size = Math.min(max, Math.max(min, start.size + sign * ((axis === 'x' ? m.clientX : m.clientY) - start.at)))
      setSize(target, axis, size)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      if (original === null) target.removeAttribute('style')
      else target.setAttribute('style', original)
      if (size !== start.size) handle.dispatchEvent(sizeEvent(handle, size, extentOf(target, axis)))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
}

/** The component root a gesture handle belongs to (the nearest element that renders a focus). */
function boxOf(handle: HTMLElement, renderer: DomRenderer): HTMLElement | null {
  let box: HTMLElement | null = handle
  while (box && !(renderer.keyOf(box) && renderer.index.focusOf(renderer.keyOf(box)!))) box = box.parentElement
  return box
}

// --- moving by key (move handles) -------------------------------------------------------------------

/** The edge each arrow key heads for, by writing direction. */
const ARROW_EDGES: Record<string, { ltr: string; rtl: string }> = {
  ArrowUp: { ltr: 'top', rtl: 'top' },
  ArrowDown: { ltr: 'bottom', rtl: 'bottom' },
  ArrowLeft: { ltr: 'start', rtl: 'end' },
  ArrowRight: { ltr: 'end', rtl: 'start' },
}
const OPPOSITE: Record<string, string> = { top: 'bottom', bottom: 'top', start: 'end', end: 'start' }

/**
 * Arrow keys on a focused move handle (data-sem-gesture="move" that takes focus): 16 px a press
 * (64 with Shift), kept on screen, committed like a drag with one sem-move event that says where
 * the box is and how far it now is from the edge it moved towards, so the graph docks it there once
 * it is within reach (c:snapDistance). Docked, the arrow away from its edge takes it off (a move
 * with no position: it floats where it last floated); the others do nothing. Returns whether the
 * key was used.
 */
export function moveByKey(k: KeyboardEvent, renderer: DomRenderer): boolean {
  const handle = (k.target as Element | null)?.closest?.('[data-sem-gesture="move"]') as HTMLElement | null
  const heading = ARROW_EDGES[k.key]
  if (!handle || !heading || !handle.hasAttribute('tabindex') || !renderer.host.contains(handle) || k.altKey || k.ctrlKey || k.metaKey) return false
  const box = boxOf(handle, renderer)
  if (!box) return false
  const doc = box.ownerDocument
  const rtl = doc.defaultView?.getComputedStyle?.(box)?.direction === 'rtl'
  const towards = rtl ? heading.rtl : heading.ltr
  const edge = box.getAttribute('data-sem-edge')
  const send = (detail: Record<string, number>) => handle.dispatchEvent(new (doc.defaultView?.CustomEvent ?? CustomEvent)('sem-move', { bubbles: true, detail }))
  if (edge && edge !== 'none') {
    if (towards === OPPOSITE[edge]) send({})
    return true
  }
  const view = doc.documentElement
  const r = box.getBoundingClientRect()
  const step = k.shiftKey ? 64 : 16
  const dx = k.key === 'ArrowLeft' ? -step : k.key === 'ArrowRight' ? step : 0
  const dy = k.key === 'ArrowUp' ? -step : k.key === 'ArrowDown' ? step : 0
  const left = Math.max(0, Math.min(view.clientWidth - r.width, r.left + dx))
  const top = Math.max(0, Math.min(view.clientHeight - r.height, r.top + dy))
  const away = { top, bottom: view.clientHeight - (top + r.height), start: rtl ? view.clientWidth - (left + r.width) : left, end: rtl ? left : view.clientWidth - (left + r.width) }
  const name = { top: 'toTop', bottom: 'toBottom', start: 'toStart', end: 'toEnd' }[towards]!
  send({ x: left, y: top, [name]: away[towards as keyof typeof away] })
  return true
}

// --- one-axis sizing (separators) ------------------------------------------------------------------

/** The element a size handle sizes (see EventBus.sizeGesture). */
function sizedBy(handle: HTMLElement, renderer: DomRenderer): HTMLElement | null {
  const sizes = handle.dataset.semSizes
  if (sizes === 'previous') return handle.previousElementSibling as HTMLElement | null
  if (sizes === 'next') return handle.nextElementSibling as HTMLElement | null
  if (sizes) return handle.closest(sizes) as HTMLElement | null
  let box: HTMLElement | null = handle
  while (box && !(renderer.keyOf(box) && renderer.index.focusOf(renderer.keyOf(box)!))) box = box.parentElement
  return box
}

function sizing(handle: HTMLElement) {
  const n = (v: string | undefined, fallback: number) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : fallback)
  return {
    axis: handle.dataset.semAxis === 'y' ? ('y' as const) : ('x' as const),
    sign: n(handle.dataset.semSign, 1) < 0 ? -1 : 1,
    min: n(handle.dataset.semMin, 0),
    max: n(handle.dataset.semMax, Infinity),
    step: n(handle.dataset.semStep, 16),
  }
}

const measure = (el: HTMLElement, axis: 'x' | 'y') => {
  const r = el.getBoundingClientRect?.()
  return (axis === 'x' ? (r?.width ?? el.offsetWidth) : (r?.height ?? el.offsetHeight)) || 0
}
const extentOf = (el: HTMLElement, axis: 'x' | 'y') => (el.parentElement ? measure(el.parentElement, axis) : 0)

/** The sem-size DOM event, made by the handle's own window (a test DOM refuses foreign events). */
const sizeEvent = (handle: HTMLElement, size: number, extent: number) =>
  new (handle.ownerDocument.defaultView?.CustomEvent ?? CustomEvent)('sem-size', { bubbles: true, detail: { size, extent } })

/** The transient view of a size being dragged: pinned along its axis (flex items too). */
function setSize(el: HTMLElement, axis: 'x' | 'y', size: number) {
  Object.assign(el.style, axis === 'x' ? { width: `${size}px`, flex: `0 0 ${size}px` } : { height: `${size}px`, flex: `0 0 ${size}px` })
}

/**
 * Arrow keys on a focused size handle (role=separator): a step along its axis (data-sem-step,
 * 16px by default), Home and End to its bounds. Commits like a drag, with one sem-size event.
 * Returns whether the key was used.
 */
export function sizeByKey(k: KeyboardEvent, renderer: DomRenderer): boolean {
  const handle = (k.target as Element | null)?.closest?.('[data-sem-gesture="size"]') as HTMLElement | null
  if (!handle || !renderer.host.contains(handle) || k.altKey || k.ctrlKey || k.metaKey) return false
  const { axis, sign, min, max, step } = sizing(handle)
  const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
  const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
  if (![forward, back, 'Home', 'End'].includes(k.key)) return false
  const target = sizedBy(handle, renderer)
  if (!target) return false
  const current = measure(target, axis)
  const size =
    k.key === 'Home' ? min : k.key === 'End' ? (Number.isFinite(max) ? max : current) : Math.min(max, Math.max(min, current + sign * (k.key === forward ? step : -step)))
  if (size !== current) handle.dispatchEvent(sizeEvent(handle, size, extentOf(target, axis)))
  return true
}
