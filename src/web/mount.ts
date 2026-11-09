import { EventBus, type Handled, type ReactionFn } from '../behaviour/events.ts'
import type { FnRule } from '../engine/context.ts'
import { DEFAULT_LAYERS, MOD, NS } from '../ns.ts'
import { Islands, type IslandAdapter, type WidgetLike } from '../foreign.ts'
import { DomRenderer } from '../render/dom.ts'
import type { HostContext, HostRenderer } from '../render/hosts.ts'
import { RenderedState } from '../rendered.ts'
import { type Projection, Runtime } from '../runtime.ts'
import type { GraphStore } from '../store/types.ts'
import { compileStyles } from '../style/compile.ts'
import { readPolicy, Refused, type SafetyPolicy } from '../safety.ts'
import { Files, type FilesOptions } from '../files.ts'
import { Fullscreen, type FullscreenOptions } from '../fullscreen.ts'
import { attachConnectors } from './connectors.ts'
import { attachSnaps } from './snap.ts'
import { attachLightboxes } from './lightbox.ts'
import { attachAnchoredPopups } from './anchored-popups.ts'
import { attachSizeHandles } from './size-handles.ts'
import { hasStore, initWeb, loadStore, loadStoreWithOntology, type StoreKind } from './load.ts'
import { serverRendered, serverStyled, takeOver } from './takeover.ts'
import { markPlatform } from './platform.ts'
import { graphLanguages } from '../server/render.ts'
import { Navigation, type NavigationOptions, rendererReveal, windowScroll } from '../navigation.ts'
import { RemoteSources, type RemoteSourcesOptions } from '../remote.ts'

export { DEFAULT_LAYERS }

export interface MountOptions {
  /** The IRI of the component to show: the root of the projection. */
  root: string
  /** Turtle to load besides Semblance's own ontology: your app's components, your component classes and their rules. */
  graphs?: string[]
  /**
   * Turtle from an untrusted author (a person, a page, a model), loaded after `graphs`: the root is
   * then rendered as authored content (src/safety.ts, docs/SAFETY.md). What the policy refuses
   * (script, event handler attributes, javascript: URLs, CSS that loads a resource, …) is left out and
   * reported through `onRefused`. The policy is read from the ontology and `graphs` alone.
   */
  authored?: string[]
  /** The policy of authored content, instead of the framework's safe:Authored (read from a trusted store). */
  policy?: SafetyPolicy
  /** Hear about what the policy refused (by default console.warn). */
  onRefused?: (e: Error) => void
  /**
   * Semblance's ontology as the app ships it: the part its graphs use (docs/SUBSET.md; the Vite
   * plugin's `virtual:semblance/ontology`), in place of the whole ontology, which is then not fetched.
   */
  ontology?: string
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
  /** The files effect (c:FileDrop: the picker, drops, uploads and their handlers); false leaves it off. */
  files?: Omit<FilesOptions, 'onHandled'> | false
  /** The fullscreen effect (fs:fullscreen, fs:fullViewport): its host, or how long it may take; false leaves it off. */
  fullscreen?: Omit<FullscreenOptions, 'element' | 'onHandled'> | false
  /** Foreign components (ext:Island, docs/FOREIGN.md): widgets by their ext:widget name. */
  widgets?: Record<string, WidgetLike>
  /** Loaders by the name ext:module gives (a dynamic import: a custom element's definition, a library). */
  modules?: Record<string, () => Promise<unknown>>
  /** Adapters for kinds of foreign component beyond the built-in ones, by their ext:Adapter IRI. */
  adapters?: Record<string, IslandAdapter>
  /**
   * A component library that draws hosted components (ext:Hosted, docs/HOSTED.md): `reactHosts(…)`
   * from @inferal-oss/semblance-react, or an adapter of your own.
   */
  hosts?: HostRenderer
  /**
   * The navigation effect (nav:Location in the graph): the address is read before the first
   * projection, written back after changes, and links to the location's paths are followed in
   * place. On by default when the graph declares a location for `root`; false leaves it off.
   */
  navigation?: Omit<NavigationOptions, 'root'> | false
  /** Changes to make before the first projection (after the address is read): the same a server makes (renderToString's prepare). */
  prepare?: (store: GraphStore) => void
  /** Record provenance (ontology/layers/provenance.ttl). */
  provenance?: boolean
  /**
   * Remote sources (src:Source, docs/REMOTE.md): each source's store, by the source's IRI. The graph
   * says what a page binds to; the host, here, says where it is and with what credentials.
   */
  sources?: Omit<RemoteSourcesOptions, 'bus' | 'onChange'>
}

export interface MountedApp {
  store: GraphStore
  runtime: Runtime
  projection: Projection
  renderer: DomRenderer
  bus: EventBus
  /** The files effect, unless it was left off: the contents of picked and dropped files (fileOf). */
  files?: Files
  /** The navigation effect, when the graph declares a location for the root. */
  navigation?: Navigation
  /** What taking over server-rendered HTML did (when the element held some): nodes adopted, mismatches patched, events replayed. */
  takeover?: { nodes: number; mismatches: number; replayed: number }
  /** The islands effect: foreign components mounted in the slots islands render. */
  islands: Islands
  /** The rendered state of the components that ask for it (rnd:observes; ontology/layers/rendered.ttl). */
  rendered: RenderedState
  /** The remote-sources effect, when `sources` was given. */
  sources?: RemoteSources
  /** Patch the DOM with whatever changed since (after changing the store through runtime.apply). */
  flush(): void
  /** Detach effects, release the owned runtime and store, and remove injected styles. The DOM is left as it is. Safe to call again; the runtime and store must not be used afterwards. */
  unmount(): void
}

/**
 * Mount a component graph into an element: load the store, compile the theme, project the
 * root on screen, patch it into `element` and route the element's events to reactions.
 * Hidden parts are evaluated in idle time; connectors (c:Connector) are drawn where their ends
 * are; picked, dropped and uploaded files go through the files effect (opts.files), and what is
 * asserted full screen or filling the window through the fullscreen effect (opts.fullscreen); foreign components (ext:Island) are mounted in their slots; the components that ask (rnd:observes) have their rendered state measured into the graph. Persistence, navigation and the other host effects are opt-in: attach them to `runtime` (see docs/GETTING-STARTED.md).
 */
export async function mount(element: HTMLElement, opts: MountOptions): Promise<MountedApp> {
  const kind = opts.store ?? (hasStore('wat') ? 'wat' : 'hybrid')
  // A store without SPARQL (N3) can only run function rules.
  const prefer = kind === 'n3' ? 'function' : (opts.prefer ?? 'sparql')
  await initWeb(kind, { ontology: opts.ontology === undefined })
  // Over the whole ontology, or the part the app ships (opts.ontology).
  const load = (...graphs: string[]) => (opts.ontology === undefined ? loadStore(kind, ...graphs) : loadStoreWithOntology(kind, {}, opts.ontology, ...graphs))
  // Authored content: the policy is read before the author's graphs are in the store (they could add to it).
  let policy = opts.policy
  if (!policy && opts.authored) {
    const trusted = load(...(opts.graphs ?? []))
    try {
      policy = readPolicy(trusted)
    } finally {
      trusted.dispose?.()
    }
  }
  const store = load(...(opts.graphs ?? []), ...(opts.authored ?? []))
  const onRefused = opts.onRefused ?? ((e: Error) => console.warn('[semblance]', e.message))
  // Where we are, before the first projection: the address (a server rendered the same one).
  const declared = store.match(null, store.factory.namedNode(NS.nav + 'root'), store.factory.namedNode(opts.root)).length > 0
  const located = !!(opts.navigation && opts.navigation.location) || 'location' in globalThis
  const navigation = opts.navigation === false || !declared || !located ? undefined : new Navigation(store, { ...opts.navigation, root: opts.root })
  await navigation?.restore()
  opts.prepare?.(store)
  const ssr = serverRendered(element)
  const runtime = new Runtime(store)
  const projection = runtime.project({
    modality: MOD.Screen,
    layers: opts.layers ?? DEFAULT_LAYERS,
    prefer,
    functions: opts.functions,
    // Server-rendered HTML was rendered in the graph's language: the client's first render must be the same.
    languages: opts.languages ?? (ssr ? graphLanguages(store, opts.root) : [...(globalThis.navigator?.languages ?? [])]),
    provenance: opts.provenance,
    name: 'screen',
    roots: [opts.root],
    policy,
  }, policy ? (e) => (e instanceof Refused ? onRefused(e) : console.error(e)) : undefined)

  const doc = element.ownerDocument
  // The key hints' spelling (a server-rendered page's head has marked it already).
  markPlatform(doc)
  // A server-rendered page links the stylesheet the server compiled: the same, so it is not compiled again.
  const sheet = serverStyled(doc) ? undefined : new (doc.defaultView ?? globalThis).CSSStyleSheet()
  if (sheet) {
    sheet.replaceSync(compileStyles(store, { policy, onRefused }))
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
  }

  const hostContext: HostContext = { runtime, projection }
  const hosts = opts.hosts?.(projection.index, hostContext)
  const renderer = new DomRenderer(projection.index, element, opts.root, hosts)
  // The server's DOM is taken over as it is: no node is created for what it already shows.
  const adopted = ssr ? takeOver(renderer) : undefined
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
  hostContext.bus = bus
  hostContext.onHandled = (h) => {
    flush()
    scheduleWarmup()
    opts.onHandled?.(h)
  }
  const detach = bus.attach(renderer, (h) => {
    flush()
    scheduleWarmup()
    opts.onHandled?.(h)
  })
  flush()
  scheduleWarmup()
  // Connectors are drawn where their ends are (nothing to do while there is none).
  const connectors = attachConnectors(element)
  // Files: a file:Pick opens the system picker, files dropped on a file drop's zone arrive, and
  // accepted files are uploaded as their drop says; each reports back as events on the bus.
  const files =
    opts.files === false
      ? undefined
      : new Files(bus, {
          ...opts.files,
          onHandled: (h) => {
            flush()
            scheduleWarmup()
            opts.onHandled?.(h)
          },
        })
  const detachFiles = files?.attach(renderer)
  // Full screen and filling the window: fs:fullscreen and fs:fullViewport on a component are shown
  // so; the browser leaving on its own, or Esc, comes back as an event.
  const detachFullscreen =
    opts.fullscreen === false
      ? undefined
      : new Fullscreen(bus, {
          ...opts.fullscreen,
          element: (iri) => {
            const n = renderer.nodeOf(iri)
            return n?.nodeType === 1 ? (n as Element) : undefined
          },
          document: opts.fullscreen?.document ?? doc,
          onHandled: (h) => {
            flush()
            scheduleWarmup()
            opts.onHandled?.(h)
          },
        }).attach()
  // Swiped tracks (a carousel, a lightbox) report where they came to rest and follow the graph.
  const snaps = attachSnaps(element)
  // Lightboxes grow from their image and give it back, slide between images, zoom and pan.
  const lightboxes = attachLightboxes(element)
  const popups = attachAnchoredPopups(element, node => !renderer.inSlot(node))
  // Size handles say what their boxes come to, which only the page knows.
  const sizeHandles = attachSizeHandles(renderer)
  // Foreign components are mounted in their islands' slots after each patch (nothing to do while there is none).
  const islands = new Islands(bus, renderer, {
    widgets: opts.widgets,
    modules: opts.modules,
    adapters: opts.adapters,
    onHandled: (h) => {
      flush()
      scheduleWarmup()
      opts.onHandled?.(h)
    },
  })
  const detachIslands = islands.attach()
  // Where the components that ask for it are, and in what state (nothing is measured while none asks).
  // The page is patched only when a rule that reads the state derived something from it.
  const derived = () => projection.engine.stats.derivedAdded + projection.engine.stats.derivedRemoved
  let derivedBefore = derived()
  const rendered = new RenderedState(runtime, renderer, {
    onWrite: () => {
      if (derived() !== derivedBefore) flush()
      derivedBefore = derived()
    },
  })
  const detachRendered = rendered.attach()
  // The window's scroll follows the location only where the location is the window's own address.
  const win = element.ownerDocument.defaultView
  const scroll = win && !(opts.navigation && opts.navigation.location) ? windowScroll(win) : undefined
  const detachNavigation = navigation?.attach(runtime, { bus, links: element, onNavigate: flush, reveal: rendererReveal(renderer), scroll })
  // Remote sources: their part of the graph is loaded, follows the stores, and is written back.
  const sources = opts.sources && new RemoteSources(runtime, { ...opts.sources, bus, onChange: () => (flush(), scheduleWarmup()) })
  const detachSources = sources?.attach()
  // What the visitor did before now (a click, typing) happens now, on the adopted nodes.
  const takeover = adopted && { nodes: adopted.nodes, mismatches: adopted.mismatches, replayed: adopted.replay() }

  return {
    store,
    runtime,
    projection,
    renderer,
    bus,
    files,
    navigation,
    takeover,
    islands,
    rendered,
    sources,
    flush,
    unmount() {
      if (stopped) return
      stopped = true
      detach()
      detachFiles?.()
      detachFullscreen?.()
      detachIslands()
      hosts?.dispose()
      connectors.dispose()
      snaps.dispose()
      lightboxes.dispose()
      popups()
      sizeHandles()
      detachRendered()
      detachNavigation?.()
      detachSources?.()
      if (sheet) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet)
      runtime.dispose()
    },
  }
}
