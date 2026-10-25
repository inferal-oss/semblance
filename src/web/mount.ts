import { EventBus, type Handled, type ReactionFn } from '../behaviour/events.ts'
import type { FnRule } from '../engine/context.ts'
import { DEFAULT_LAYERS, MOD } from '../ns.ts'
import { DomRenderer } from '../render/dom.ts'
import { type Projection, Runtime } from '../runtime.ts'
import type { GraphStore } from '../store/types.ts'
import { compileStyles } from '../style/compile.ts'
import { attachConnectors } from './connectors.ts'
import { hasStore, initWeb, loadStore, type StoreKind } from './load.ts'

export { DEFAULT_LAYERS }

export interface MountOptions {
  /** The IRI of the component to show: the root of the projection. */
  root: string
  /** Turtle to load besides Semblance's own ontology: your app's components, your component classes and their rules. */
  graphs?: string[]
  /** The store; Semblance's own WASM engine when this build has it, else Hybrid. */
  store?: StoreKind
  /** Which implementation of a rendering to use when it has both: SPARQL (the default) or a function. */
  prefer?: 'sparql' | 'function'
  /** Function rules, by the name a sem:Rule's sem:function gives. */
  functions?: Record<string, FnRule>
  /** Reaction functions, by the name a beh:Reaction's sem:function gives (for stores without SPARQL). */
  reactions?: Record<string, ReactionFn>
  /** Layer IRIs to enable (DEFAULT_LAYERS otherwise). */
  layers?: Iterable<string>
  /** The viewer's languages, most preferred first (navigator.languages otherwise). */
  languages?: string[]
  /** Called after each event is handled and the DOM patched. */
  onHandled?: (h: Handled) => void
}

export interface MountedApp {
  store: GraphStore
  runtime: Runtime
  projection: Projection
  renderer: DomRenderer
  bus: EventBus
  /** Patch the DOM with whatever changed since (after changing the store through runtime.apply). */
  flush(): void
  /** Detach events and idle work, and remove the styles. The DOM is left as it is. */
  unmount(): void
}

/**
 * Mount a component graph into an element: load the store, compile the theme, project the
 * root on screen, patch it into `element` and route the element's events to reactions.
 * Hidden parts are evaluated in idle time; connectors (c:Connector) are drawn where their ends
 * are. Persistence, navigation and the other host effects are opt-in: attach them to `runtime` (see docs/GETTING-STARTED.md).
 */
export async function mount(element: HTMLElement, opts: MountOptions): Promise<MountedApp> {
  const kind = opts.store ?? (hasStore('wat') ? 'wat' : 'hybrid')
  // A store without SPARQL (N3) can only run function rules.
  const prefer = kind === 'n3' ? 'function' : (opts.prefer ?? 'sparql')
  await initWeb(kind)
  const store = loadStore(kind, ...(opts.graphs ?? []))
  const runtime = new Runtime(store)
  const projection = runtime.project({
    modality: MOD.Screen,
    layers: opts.layers ?? DEFAULT_LAYERS,
    prefer,
    functions: opts.functions,
    languages: opts.languages ?? [...(globalThis.navigator?.languages ?? [])],
    name: 'screen',
    roots: [opts.root],
  })

  const doc = element.ownerDocument
  const sheet = new (doc.defaultView ?? globalThis).CSSStyleSheet()
  sheet.replaceSync(compileStyles(store))
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]

  const renderer = new DomRenderer(projection.index, element, opts.root)
  const flush = () => renderer.flush()

  // Hidden parts (other tabs, closed panels) are evaluated a slice at a time when the page is idle.
  const idle = (cb: (d: { timeRemaining(): number }) => void) =>
    'requestIdleCallback' in globalThis ? requestIdleCallback(cb, { timeout: 1000 }) : setTimeout(() => cb({ timeRemaining: () => 8 }), 30)
  let warming = false
  let stopped = false
  const warm = (deadline: { timeRemaining(): number }) => {
    if (stopped) return
    const more = runtime.warm(Math.max(2, deadline.timeRemaining() - 2))
    flush()
    warming = more
    if (more) idle(warm)
  }
  const scheduleWarmup = () => {
    if (!warming && !stopped) (warming = true), idle(warm)
  }

  const bus = new EventBus(runtime, projection, { functions: opts.reactions, prefer })
  const detach = bus.attach(renderer, (h) => {
    flush()
    scheduleWarmup()
    opts.onHandled?.(h)
  })
  flush()
  scheduleWarmup()
  // Connectors are drawn where their ends are (nothing to do while there is none).
  const connectors = attachConnectors(element)

  return {
    store,
    runtime,
    projection,
    renderer,
    bus,
    flush,
    unmount() {
      stopped = true
      detach()
      connectors.dispose()
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet)
    },
  }
}
