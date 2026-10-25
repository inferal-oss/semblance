// The fullscreen effect (ontology/layers/fullscreen.ttl): `<component> fs:fullscreen true` in the
// input graph is shown full screen, and its retraction leaves it; how the host shows it, and that it
// left on its own, come back as events addressed to the component (fs:Entered, fs:Exited), handled
// by ordinary reactions. The request starts in the same task as the change that asserted the fact -
// the click's or the key press's, while the page still has the person's activation, which browsers
// require. Where the host cannot show it full screen (no activation, a frame without
// allowfullscreen, a refusal, no Fullscreen API), it shows the element over the page instead: in the
// top layer as a manual popover, filling the viewport by the theme's rule (fs:Maximized), and Esc
// leaves it as Esc leaves the host's full screen. Facts already in the graph when it attaches (a
// restored session) are retracted: the page is not full screen.
import type { NamedNode } from '@rdfjs/types'
import type { EventBus, Handled } from './behaviour/events.ts'
import { fullscreenPart } from './layers/fullscreen.ts'
import { FS } from './ns.ts'
import type { Delta } from './rdf.ts'

/** The host's full screen: the document's Fullscreen API, or a stand-in. */
export interface FullscreenHost {
  /** Whether it may show this element full screen at all (document.fullscreenEnabled). */
  enabled(el: Element): boolean
  /** Show it full screen (Element.requestFullscreen): rejects where the host refuses. */
  request(el: Element): Promise<void>
  /** Leave full screen (document.exitFullscreen). */
  exit(el: Element): Promise<void>
  /** What it shows full screen now (document.fullscreenElement). */
  current(el: Element): Element | null
  /** Call back whenever it enters or leaves full screen (fullscreenchange); returns how to stop. */
  watch(changed: () => void): () => void
}

/** The document's Fullscreen API. */
export function documentFullscreen(doc: Document | undefined = globalThis.document): FullscreenHost {
  return {
    enabled: (el) => !!el.ownerDocument.fullscreenEnabled && typeof el.requestFullscreen === 'function',
    request: (el) => el.requestFullscreen(),
    exit: (el) => (el.ownerDocument.fullscreenElement ? el.ownerDocument.exitFullscreen() : Promise.resolve()),
    current: (el) => el.ownerDocument.fullscreenElement,
    watch: (changed) => {
      doc?.addEventListener('fullscreenchange', changed)
      return () => doc?.removeEventListener('fullscreenchange', changed)
    },
  }
}

export interface FullscreenOptions {
  /** The element of a rendered node (by its IRI), if it is shown. */
  element: (iri: string) => Element | undefined
  /** The document whose Esc leaves the fallback (and whose full screen it is, by default). */
  document?: Document
  /** The host's full screen (the document's by default); null: there is none, so always the fallback. */
  host?: FullscreenHost | null
  /**
   * How long the host may take to show it, in ms (2000): a host that neither shows it nor refuses
   * by then (an embedding that never answers) gets the fallback.
   */
  settleMs?: number
  /** After each event a reaction handled (e.g. to patch the DOM). */
  onHandled?: (h: Handled) => void
}

type Popover = Element & { showPopover?: () => void; hidePopover?: () => void }

export class Fullscreen {
  /** Components the host shows full screen, or is asked to: their elements. */
  private native = new Map<string, Element>()
  /** Components shown over the page instead. */
  private maximized = new Map<string, Popover>()
  /** Of those asked for, the ones the host has shown. */
  private entered = new Set<string>()
  private pending = new Set<Promise<void>>()
  private detach?: () => void
  private readonly host: FullscreenHost | null

  constructor(
    private readonly bus: EventBus,
    private readonly opts: FullscreenOptions,
  ) {
    this.host = opts.host !== undefined ? opts.host : documentFullscreen(opts.document)
  }

  /** Perform the facts from now on. Returns a function that stops it. */
  attach(): () => void {
    const off = this.bus.runtime.onInput((graph, delta) => this.changed(graph, delta))
    const doc = this.opts.document ?? globalThis.document
    const unwatch = this.host?.watch(() => this.hostChanged())
    const key = (e: KeyboardEvent) => this.key(e)
    doc?.addEventListener('keydown', key)
    this.detach = () => {
      off()
      unwatch?.()
      doc?.removeEventListener('keydown', key)
      this.detach = undefined
    }
    // A restored fact: the page is not full screen, so the graph must not say it is.
    const store = this.bus.runtime.store
    const f = store.factory
    for (const q of store.match(null, f.namedNode(FS.fullscreen), null, f.defaultGraph()))
      if (q.object.value === 'true' && q.subject.termType === 'NamedNode') this.later(() => this.report(FS.Exited, q.subject as NamedNode))
    return this.detach
  }

  /** Resolves once every report started so far has been made (for tests). */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending])
  }

  private changed(graph: string | undefined, delta: Delta) {
    if (graph !== undefined) return
    const on = new Set<string>()
    for (const q of delta.add) if (q.predicate.value === FS.fullscreen && q.object.value === 'true') on.add(q.subject.value)
    for (const q of delta.remove) if (q.predicate.value === FS.fullscreen && q.object.value === 'true' && !on.has(q.subject.value)) this.leave(q.subject.value)
    for (const q of delta.add) if (q.predicate.value === FS.fullscreen && q.object.value !== 'true') this.leave(q.subject.value)
    for (const c of on) this.enter(c)
  }

  private enter(component: string) {
    if (this.native.has(component) || this.maximized.has(component)) return
    const store = this.bus.runtime.store
    const f = store.factory
    const focus = f.namedNode(component)
    const read = {
      object: (s: string | { value: string }, p: string | { value: string }) =>
        store.match(f.namedNode(typeof s === 'string' ? s : s.value), f.namedNode(typeof p === 'string' ? p : p.value), null, f.defaultGraph())[0]?.object,
      objects: (s: string | { value: string }, p: string | { value: string }) =>
        store.match(f.namedNode(typeof s === 'string' ? s : s.value), f.namedNode(typeof p === 'string' ? p : p.value), null, f.defaultGraph()).map((q) => q.object),
    }
    const el = this.opts.element(`${component}/~${fullscreenPart(read, focus)}`)
    // Not shown: there is nothing to show full screen.
    if (!el) return this.later(() => this.report(FS.Exited, focus))
    const host = this.host
    let requested: Promise<void> | undefined
    try {
      if (host?.enabled(el)) requested = host.request(el)
    } catch {
      requested = undefined
    }
    if (!requested) return this.maximize(component, el)
    this.native.set(component, el)
    let timer: ReturnType<typeof setTimeout> | undefined
    const unanswered = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The host did not answer.')), this.opts.settleMs ?? 2000)
    })
    // An answer after the fallback was chosen: the host shows it after all, so leave again.
    requested.then(
      () => {
        if (this.native.get(component) !== el) void host!.exit(el).catch(() => undefined)
      },
      () => undefined,
    )
    this.track(
      Promise.race([requested, unanswered]).finally(() => clearTimeout(timer)).then(
        () => {
          // The fact went before the host had shown it (the answer above leaves again).
          if (this.native.get(component) !== el) return
          this.entered.add(component)
          this.report(FS.Entered, focus, FS.Native)
        },
        () => {
          if (this.native.get(component) !== el) return
          this.native.delete(component)
          this.maximize(component, el)
        },
      ),
    )
  }

  /** Over the page: the top layer, so no ancestor's overflow or stacking clips it. */
  private maximize(component: string, el: Popover) {
    this.maximized.set(component, el)
    if (typeof el.showPopover === 'function') {
      el.setAttribute('popover', 'manual')
      try {
        el.showPopover()
      } catch {
        // Not connected, or already open: the theme's fixed position still fills the viewport.
      }
    }
    this.later(() => this.report(FS.Entered, this.bus.runtime.store.factory.namedNode(component), FS.Maximized))
  }

  private unmaximize(component: string) {
    const el = this.maximized.get(component)
    if (!el) return
    this.maximized.delete(component)
    if (el.hasAttribute('popover')) {
      try {
        el.hidePopover?.()
      } catch {
        // Already hidden.
      }
      el.removeAttribute('popover')
    }
  }

  private leave(component: string) {
    const focus = this.bus.runtime.store.factory.namedNode(component)
    if (this.maximized.has(component)) {
      this.unmaximize(component)
      return this.later(() => this.report(FS.Exited, focus))
    }
    const el = this.native.get(component)
    if (!el) return
    this.native.delete(component)
    this.entered.delete(component)
    // The host's change would not name it once it is gone from the map: say it here.
    const host = this.host
    if (host?.current(el) === el) void host.exit(el).catch(() => undefined)
    this.later(() => this.report(FS.Exited, focus))
  }

  /** The host left full screen on its own (Esc, its control, another element): the fact goes. */
  private hostChanged() {
    for (const [component, el] of [...this.native]) {
      // Asked for, not yet shown: its promise says how it went.
      if (!this.entered.has(component)) continue
      const shown = this.host?.current(el) ?? null
      if (shown && (shown === el || el.contains(shown))) continue
      this.native.delete(component)
      this.entered.delete(component)
      this.report(FS.Exited, this.bus.runtime.store.factory.namedNode(component))
    }
  }

  /** Esc over the page's fallback leaves it, as it leaves the host's full screen. */
  private key(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || !this.maximized.size) return
    const component = [...this.maximized.keys()].at(-1)!
    e.preventDefault()
    this.unmaximize(component)
    this.report(FS.Exited, this.bus.runtime.store.factory.namedNode(component))
  }

  /** After the change that asked (reactions do not run inside another's transaction). */
  private later(fn: () => void) {
    this.track(Promise.resolve().then(fn))
  }

  private track(p: Promise<void>) {
    this.pending.add(p)
    void p.finally(() => this.pending.delete(p))
  }

  private report(type: string, component: NamedNode, presentation?: string) {
    if (!this.detach) return
    const f = this.bus.runtime.store.factory
    const handled = this.bus.emit(type, component.value, presentation ? { about: [[FS.presentation, f.namedNode(presentation)]] } : {})
    if (handled.recorded || handled.delta.add.length || handled.delta.remove.length) this.opts.onHandled?.(handled)
  }
}
