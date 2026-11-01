performance.mark('sem:main')
import appGraph from './app.ttl?raw'
import { EventBus, type Handled } from '../src/behaviour/events.ts'
import { Scheduler } from '../src/behaviour/schedule.ts'
import { Clipboard } from '../src/clipboard.ts'
import { Files, type Uploader } from '../src/files.ts'
import { Fullscreen } from '../src/fullscreen.ts'
import { Islands } from '../src/foreign.ts'
import { workerThumbnails } from '../src/file-store.ts'
import { StallMonitor } from '../src/behaviour/stall.ts'
import { EX, todoReactions } from '../src/examples/todo.ts'
import { indexedDbBackend, Persistence, webStorageBackend } from '../src/persistence.ts'
import { Navigation, rendererReveal, setBase } from '../src/navigation.ts'
import { attachIntent } from '../src/intent.ts'
import { NetworkCapture } from '../src/network.ts'
import { Sandboxes } from '../src/sandbox.ts'
import { compactIri, declaredPrefixes } from '../src/prefixes.ts'
import { graphLanguages } from '../src/server/render.ts'
import { pageGraphs, serverRendered, serverStyled, takeOver } from '../src/web/takeover.ts'
import { carryInFragment, type CompileMode, prepareSite, recordSiteSources, ROOT, siteLayers, siteNamedGraphs, siteSources } from './site.ts'
import { L10N, MOD, NS, SEM, STY } from '../src/ns.ts'
import type { Delta } from '../src/rdf.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { parseTurtle, Runtime } from '../src/runtime.ts'
import { sourceQuads } from '../src/sources.ts'
import type { Quad } from '@rdfjs/types'
import { compileStyles } from '../src/style/compile.ts'
import { hasStore, initWeb, loadOntology, loadStoreOf, loadStoreWith, ONTOLOGY_NAMES, ontologyText, type StoreKind } from '../src/web/load.ts'
import { attachWalkthroughs } from '../src/web/walkthrough.ts'
import { attachConnectors } from '../src/web/connectors.ts'
import { attachSnaps } from '../src/web/snap.ts'
import { attachLightboxes } from '../src/web/lightbox.ts'
import { attachAnchoredPopups } from '../src/web/anchored-popups.ts'
import { RenderedState } from '../src/rendered.ts'
import { RecalculationTrace } from '../src/recalculation.ts'
import { perfRunner } from './perf-runner.ts'
import { chartJs, flatpickr, leaflet, modules } from './foreign.ts'

// The host: a mount point, the effects of graph state (theme on <html>,
// engine layers, store choice, URL, benchmark runs) and nothing else. The
// whole interface is the component graph in app.ttl.

const UI = 'https://semblance.dev/demo#'
const params = new URLSearchParams(location.search)
// Semblance's own WASM engine by default: the fastest store (rdf-engine/results); Hybrid
// if this build has no engine builds.
const kind = (params.get('store') ?? (hasStore('wat') ? 'wat' : 'hybrid')) as StoreKind
// SPARQL by default: the rules are queries, inspectable and portable. Function twins render the same
// HTML, faster in the browser (Rules menu, ?prefer=function); a store without SPARQL (N3) needs them.
const prefer = (kind === 'n3' ? 'function' : (params.get('prefer') ?? 'sparql')) as 'sparql' | 'function'
// Compiled queries (Semblance's engines only; rdf-engine/results/compiled.md): off, on a query's
// second run, or in idle time (?compile=off|run|idle; Tools › Engine). By default in idle time on
// the Rust engine, where it pays on whole pages, and off on WAT, where queries are too small a part
// of a page for it to.
const defaultCompile = (store: string): CompileMode => (store === 'rust' ? 'idle' : 'off')
const compileParam = ['off', 'run', 'idle'].includes(params.get('compile') ?? '') ? (params.get('compile') as CompileMode) : undefined
const compile = compileParam ?? defaultCompile(kind)

// The graphs a page rendered beforehand needs first (it names them; the build checked that they
// render it): the rest load in idle time, once the page is interactive. Any other page loads all.
const firstGraphs = serverRendered(document.getElementById('app')!) ? pageGraphs(document) : undefined
const wanted = (name: string) => !firstGraphs || firstGraphs.includes(name)
// The Components page: one graph per component group (demo/gallery/*.ttl), each a chunk of its own.
const galleryLoaders = Object.fromEntries(Object.entries(import.meta.glob('./gallery/*.ttl', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>).map(([p, load]) => ['demo/' + p.slice(2), load]))
const galleryFiles: Record<string, string> = {}
const loadGallery = (names: string[]) => Promise.all(names.map(async (n) => void (galleryFiles[n] ??= await galleryLoaders[n]!())))
// Only the chosen store's code and WASM are loaded, and the graphs the page needs, at once.
await Promise.all([initWeb(kind, { ontology: false }), loadOntology(ONTOLOGY_NAMES.filter(wanted)), loadGallery(Object.keys(galleryLoaders).filter(wanted))])
performance.mark('sem:wasm')
const storeOptions = { compiled: compile === 'idle' ? ('idle' as const) : compile === 'run' }
const store = loadStoreOf(kind, storeOptions, ONTOLOGY_NAMES.filter(wanted), ...Object.values(siteNamedGraphs(appGraph, galleryFiles)))
performance.mark('sem:store', { detail: { graphs: firstGraphs?.length } })
// The examples show their own source, recorded as data (c:SourceText).
recordSiteSources(store, galleryFiles)
// One file is one page: where we are goes in the fragment.
if (import.meta.env.MODE === 'single') carryInFragment(store)
// Served under a path (SEMBLANCE_BASE): the site's paths start there.
else if (import.meta.env.BASE_URL.startsWith('/') && import.meta.env.BASE_URL !== '/') setBase(store, import.meta.env.BASE_URL)
// Remembered state (per:Policy nodes in the graph) is restored before the first projection.
const persistence = new Persistence(store, {
  [NS.per + 'Session']: webStorageBackend(sessionStorage),
  [NS.per + 'Device']: webStorageBackend(localStorage),
  [NS.per + 'Database']: indexedDbBackend(),
})
await persistence.restore().catch((e) => console.warn('[semblance] could not restore remembered state', e))
// Where we are (ui:location in app.ttl): the address over what storage kept, before the first projection too.
const navigation = new Navigation(store, { root: UI + 'shell', persistence })
await navigation.restore()
performance.mark('sem:restore')
const f = store.factory
const nn = (iri: string) => f.namedNode(iri)
const app = nn(UI + 'app')
const dg = f.defaultGraph()
const appValues = (p: string) => store.match(app, nn(p), null, dg).map((q) => q.object)

// Settings that arrive through the URL become graph state before projecting (as the build does: site.ts).
prepareSite(store, { kind, prefer, compile })

const runtime = new Runtime(store)
const enabledLayers = () => siteLayers(store)
// Each projection evaluates only what is shown under its mount root (demand-driven), in the
// graph's language (the address's): a page rendered beforehand was too. Provenance is recorded
// from when something reads it (the inspector, a card turned over), not for the first page.
const languages = graphLanguages(store, ROOT)
const screen = runtime.project({ modality: MOD.Screen, layers: enabledLayers(), prefer, provenance: 'onDemand', languages, name: 'screen', roots: [ROOT] })
const text = runtime.project({ modality: MOD.Text, prefer, provenance: 'onDemand', languages, name: 'text', roots: [EX + 'page'] })
performance.mark('sem:rules')

// The keyboard layer shows ⌘ / ⌥ glyphs on Apple platforms, Ctrl / Alt elsewhere.
if (/Mac|iPhone|iPad/.test(navigator.platform)) document.documentElement.setAttribute('data-sem-platform', 'apple')

// A page rendered beforehand links the stylesheet the build compiled from this graph: it is not compiled again.
let css = serverStyled(document) ? undefined : compileStyles(store)
const siteCss = () => (css ??= compileStyles(store))
if (css !== undefined) {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
}
performance.mark('sem:styles')

const shell = new DomRenderer(screen.index, document.getElementById('app')!, ROOT)
// A page rendered beforehand (npm run build: every address of the site) is taken over as it is:
// the projection has the same nodes, so none is created. What the visitor did meanwhile is replayed
// once everything listens (at the end).
const takeover = serverRendered(shell.host) ? takeOver(shell) : undefined
if (takeover) performance.mark('sem:adopted', { detail: { nodes: takeover.nodes, mismatches: takeover.mismatches } })
// The Text projection mounts into its slot once the slot is shown (it is evaluated on demand).
let textDom: DomRenderer | undefined
// The Layout page's c:HostSlot specimen: content the host owns (a native slider), mounted once.
function hostSlotDemo(slot: Element | undefined) {
  if (!slot || slot.firstChild) return
  const input = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: '100', value: '40' })
  input.setAttribute('aria-label', 'A slider the host owns')
  const output = document.createElement('output')
  output.textContent = input.value
  input.addEventListener('input', () => (output.textContent = input.value))
  const row = document.createElement('div')
  row.style.cssText = 'display: flex; gap: 0.75em; align-items: center'
  row.append(input, output)
  slot.append(row)
}

/** Build when the slot comes near the view, in idle time (at once where there is no IntersectionObserver). */
function deferUntilSeen(slot: Element, build: () => void) {
  if (!('IntersectionObserver' in window)) return build()
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      observer.disconnect()
      idle(() => build())
    },
    { rootMargin: '200px' },
  )
  observer.observe(slot)
}

// Every graph of the site, once the rest of them (beyond what the page needed first) are loaded.
let graphsLoaded: () => void
const allGraphs = new Promise<void>((resolve) => (graphsLoaded = resolve))
if (!firstGraphs) graphsLoaded!()

// Live examples (c:LiveExample) run in sandboxes of their own, mounted in their slots once shown.
let sandboxes: Sandboxes | undefined
// DOM patches are timed: a hang outside every turn of the engine is blamed on them (the stall log).
let stalls: StallMonitor | undefined
const flush = () => (stalls ? stalls.rendering(patch) : patch())
const patch = () => {
  shell.flush()
  sandboxes?.sync()
  hostSlotDemo(shell.slot('gallery-host'))
  const slot = shell.slot('text')
  if (slot && textDom?.host !== slot) textDom = new DomRenderer(text.index, slot, EX + 'page')
  textDom?.flush()
}
sandboxes = new Sandboxes(runtime, screen, {
  renderer: shell,
  shown: (c) => screen.index.isShown(c, new Set([UI + 'shell'])),
  flush: () => flush(),
  load: (...turtle) => loadStoreWith(kind, storeOptions, ...turtle),
  prefer,
  languages: () => [...screen.engine.languages],
  siteCss,
  // Each example loads the ontology into a store of its own: built once its slot is near the view,
  // after the page has painted (an example below the fold waits until it is scrolled to), and once
  // the whole ontology is here (its pre-rendered HTML shows until then).
  defer: (slot, build) => void allGraphs.then(() => deferUntilSeen(slot, build)),
})
sandboxes.attach()
flush()
performance.mark('sem:patch', { detail: { ops: shell.ops } })
// Views that follow their queries (sem:refresh sem:NextFrame) re-run at the next frame.
runtime.onRefresh(flush)

// --- effects of graph state --------------------------------------------------------------

// The favicon is the app bar's mark as it looks now (theme, color scheme), drawn with its
// computed colors; demo/favicon.svg (npm run gen:mark) stands in until the page has rendered.
let favicon = ''
function syncFavicon() {
  const look = [store.match(nn(UI + 'shell'), nn(NS.sty + 'theme'), null)[0]?.object.value, document.documentElement.getAttribute('data-sem-color-scheme'), matchMedia('(prefers-color-scheme: dark)').matches].join(' ')
  if (look === favicon) return
  favicon = look
  requestAnimationFrame(() => {
    const mark = document.querySelector('[data-sem-c=app-bar] [data-sem-c=graph-mark]')
    if (!mark) return
    const copy = mark.cloneNode(true) as SVGSVGElement
    const live = [mark, ...mark.querySelectorAll('*')]
    ;[copy, ...copy.querySelectorAll('*')].forEach((el, i) => {
      const css = getComputedStyle(live[i]!)
      for (const p of ['stop-color', 'fill', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap']) {
        if (el.localName !== 'svg' && css.getPropertyValue(p)) el.setAttribute(p, css.getPropertyValue(p))
      }
      for (const a of [...el.attributes]) if (a.name.startsWith('data-') || a.name === 'class' || a.name === 'id' && el.localName === 'svg') el.removeAttribute(a.name)
    })
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    let link = document.querySelector<HTMLLinkElement>('link[rel=icon]')
    if (!link) document.head.append((link = Object.assign(document.createElement('link'), { rel: 'icon', type: 'image/svg+xml' })))
    link.href = 'data:image/svg+xml,' + encodeURIComponent(copy.outerHTML)
  })
}

function syncSettings() {
  const slug = (t: { value: string } | undefined) => t && store.match(nn(t.value), nn(SEM.slug), null)[0]?.object.value
  const scheme = slug(appValues(STY.colorScheme)[0])
  // Only when changed: rewriting an attribute on <html> can restyle the whole page.
  const html = document.documentElement
  if (scheme && html.getAttribute('data-sem-color-scheme') !== scheme) html.setAttribute('data-sem-color-scheme', scheme)

  const layers = enabledLayers()
  const active = new Set(screen.engine.activeRules.map((r) => r.layer).filter(Boolean))
  const known = new Set(store.match(null, nn(NS.rdf + 'type'), nn(SEM.Layer)).map((q) => q.subject.value))
  const wanted = [...layers].filter((l) => known.has(l))
  if (wanted.length !== active.size || wanted.some((l) => !active.has(l))) screen.engine.reconfigure({ layers })

  // Localization: the viewer's language is a projection setting; RTL languages flip the page.
  const language = appValues(L10N.language)[0]
  const code = language && store.match(nn(language.value), nn(L10N.code), null)[0]?.object.value
  if (code && screen.engine.languages[0] !== code) {
    screen.engine.reconfigure({ languages: [code] })
    text.engine.reconfigure({ languages: [code] })
  }
  const rtl = !!language && store.match(nn(language.value), nn(L10N.direction), nn(L10N.RTL)).length > 0
  if (html.lang !== (code ?? 'en')) html.lang = code ?? 'en'
  if (html.dir !== (rtl ? 'rtl' : 'ltr')) html.dir = rtl ? 'rtl' : 'ltr'

  const key = (p: string) => {
    const v = appValues(p)[0]
    return v && store.match(nn(v.value), nn(UI + 'key'), null)[0]?.object.value
  }
  syncFavicon()

  const nextStore = key(UI + 'store') ?? kind
  const nextRules = key(UI + 'rules') ?? prefer
  const chosenCompile = (key(UI + 'compile') ?? compile) as CompileMode
  // Another store keeps a mode chosen here (in the menu or the address), else takes its own default.
  const nextCompile = chosenCompile !== compile || compileParam ? chosenCompile : defaultCompile(nextStore)
  if (nextStore !== kind || (nextRules !== prefer && nextStore !== 'n3') || chosenCompile !== compile) {
    const search = new URLSearchParams({ store: nextStore, prefer: nextRules })
    if (nextCompile !== defaultCompile(nextStore)) search.set('compile', nextCompile)
    location.search = search.toString()
  }
  checkPerf()
}

/** Record what the last change cost in the graph (ui:stats), where c:Metrics shows it. */
function recordStats(action: string, ms: number, ruleRuns: number, domOps: number, viewRows: number) {
  writeStats({ action: f.literal(action), ms: decimal(ms), ruleRuns: integer(ruleRuns), domOps: integer(domOps), viewRows: integer(viewRows) })
}

/**
 * Observable memory: JS heap, storage, graph and DOM size. Only Chromium reports the
 * heap (performance.memory, or measureUserAgentSpecificMemory when cross-origin
 * isolated); elsewhere it says so instead of disappearing.
 */
async function recordMemory() {
  const legacy = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize
  let heap = legacy
  const measure = (performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> }).measureUserAgentSpecificMemory
  if (heap === undefined && measure && crossOriginIsolated) heap = (await measure.call(performance).catch(() => undefined))?.bytes
  const estimated = (await navigator.storage?.estimate?.().catch(() => undefined))?.usage ?? 0
  let session = 0
  try {
    for (let i = 0; i < sessionStorage.length; i++) session += (sessionStorage.key(i)!.length + (sessionStorage.getItem(sessionStorage.key(i)!) ?? '').length) * 2
  } catch {}
  const storage = estimated + session
  writeStats({
    heap: f.literal(heap !== undefined ? `${(heap / 1024 / 1024).toFixed(1)} MB` : 'n/a (not reported by this browser)'),
    storage: decimal(storage / 1024),
    triples: integer(store.size?.() ?? store.match(null, null, null).length),
    domNodes: integer(document.getElementsByTagName('*').length),
  })
  flush()
}

const decimal = (n: number) => f.literal(n.toFixed(2), nn(NS.xsd + 'decimal'))
const integer = (n: number) => f.literal(String(n), nn(NS.xsd + 'integer'))
function writeStats(values: Record<string, Delta['add'][number]['object']>) {
  const stats = nn(UI + 'stats')
  const props = Object.keys(values).map((k) => nn(UI + k))
  apply({
    remove: props.flatMap((p) => store.match(stats, p, null, dg)),
    add: Object.entries(values).map(([k, o]) => f.quad(stats, nn(UI + k), o)),
  })
}

// --- interaction --------------------------------------------------------------------------

const apply = runtime.apply.bind(runtime)
const runs = () => screen.engine.stats.ruleRuns + text.engine.stats.ruleRuns
let mark = { t: 0, runs: 0, ops: 0, views: 0 }
runtime.apply = (delta) => {
  mark = { t: performance.now(), runs: runs(), ops: shell.ops, views: runtime.views.totals.rowsIn }
  return apply(delta)
}

// Event and reaction names in the status bar, compacted with every prefix the graph knows.
const prefixes = { ...NS, ...declaredPrefixes(store), ui: UI, ex: EX }
const short = (iri: string) => compactIri(iri, prefixes)
const bus = new EventBus(runtime, screen, { functions: todoReactions, prefer })
// Pointing at a navigation item or a tab evaluates what it would show (sem:OnIntent).
attachIntent(runtime, shell, { flush: () => flush() })
// Walkthroughs: the step in view is reported to the graph; arrows follow what it mentions.
attachWalkthroughs(document.getElementById('app')!)
// Connectors (a sheet's dependencies, a walkthrough's arrows, a canvas's): drawn where their ends are.
const connectors = attachConnectors(document.getElementById('app')!)
// Swiped tracks (a gallery's carousel, a lightbox): where they come to rest, and the current item in view.
attachSnaps(document.getElementById('app')!)
// Lightboxes: grown from their image and given back to it, sliding, zooming and panning.
attachLightboxes(document.getElementById('app')!)
attachAnchoredPopups(document.getElementById('app')!, node => !shell.inSlot(node))
persistence.attach(runtime)
// The page's own fetches and sockets, and the events it reports, as net:Capture members.
const network = new NetworkCapture(runtime, { onWrite: () => flush() })
network.attach()
Object.assign(globalThis, { network })
// Where the components that ask for it (rnd:observes) are, and in what state: the rendered graph.
// The page is patched only when a rule that reads it derived something (most writes derive nothing).
const derived = () => screen.engine.stats.derivedAdded + screen.engine.stats.derivedRemoved + text.engine.stats.derivedAdded + text.engine.stats.derivedRemoved
let derivedBefore = derived()
const rendered = new RenderedState(runtime, shell, {
  onWrite: () => {
    if (derived() !== derivedBefore) flush()
    derivedBefore = derived()
  },
})
rendered.attach()
// Maintained views keep time on the bus's clock (their windows age with beh:at); a window that
// moved by itself patches the page like an event does.
runtime.views.clock = bus.clock
runtime.onTimer(() => {
  flush()
  scheduleWarmup()
})
// The watchdog (ui:watchdog in app.ttl): a turn over budget is suspended and the stall dialog asks
// whether to continue or stop; hangs nothing could interrupt are logged (a heartbeat worker, long tasks).
stalls = new StallMonitor(runtime, {
  watchdog: UI + 'watchdog',
  bus,
  flush: () => flush(),
  onHandled: () => {
    syncSettings()
    flush()
  },
  worker: () => new Worker(new URL('../src/behaviour/heartbeat.worker.ts', import.meta.url), { type: 'module' }),
})
stalls.attach()
stalls.observe()
// Sheets that trace recalculation are told which formulas each change re-ran.
const recalculation = new RecalculationTrace(runtime, screen)
bus.attach(shell, (h: Handled) => {
  syncSettings()
  recalculation.record()
  flush()
  scheduleWarmup()
  if (h.recorded) {
    const cost = { ms: performance.now() - mark.t, runs: runs() - mark.runs, ops: shell.ops - mark.ops, views: runtime.views.totals.rowsIn - mark.views }
    statsAfterPaint(`${short(h.type)} → ${h.reactions.map(short).join(', ')}`, cost.ms, cost.runs, cost.ops, cost.views)
  }
})
// The status bar's figures are a change of their own (a tick and a patch): written after the page
// has painted the interaction they measure, so it does not wait for them; the latest of a burst wins.
let pendingStats: Parameters<typeof recordStats> | undefined
function statsAfterPaint(...stats: Parameters<typeof recordStats>) {
  const scheduled = !!pendingStats
  pendingStats = stats
  if (scheduled) return
  const write = () => {
    if (!pendingStats) return
    const latest = pendingStats
    pendingStats = undefined
    recordStats(...latest)
    flush()
  }
  // After the next frame; a hidden page has no frames, so a timer stands in.
  requestAnimationFrame(() => setTimeout(write))
  setTimeout(write, 100)
}
// Things due later (beh:dueAt: the chat example's script) become beh:Due events, on the bus's
// clock; one that waits for a component to be shown waits while it is hidden.
const scheduler = new Scheduler(bus, {
  shown: (c) => screen.index.isShown(c, new Set([UI + 'shell'])),
  onHandled: () => {
    syncSettings()
    flush()
    scheduleWarmup()
  },
})
scheduler.attach()
// Copies (clip:Request) go to the page's clipboard; how it went comes back as an event (a toast).
new Clipboard(bus, {
  onHandled: () => {
    syncSettings()
    flush()
  },
}).attach()
// What is asserted full screen (fs:fullscreen) is shown so, or over the page where the browser
// will not; leaving it, by Esc or the browser's own control, comes back as an event.
new Fullscreen(bus, {
  element: (iri) => {
    const n = shell.nodeOf(iri)
    return n?.nodeType === 1 ? (n as Element) : undefined
  },
  onHandled: () => {
    syncSettings()
    flush()
  },
}).attach()
// Foreign components (ext:Island): Shoelace, Chart.js, Leaflet and flatpickr from a CDN, loaded when an island first shows,
// mounted in their slots after each patch; what they report comes back as events.
new Islands(bus, shell, {
  modules,
  widgets: { 'chart.js': chartJs, leaflet, flatpickr },
  onHandled: () => {
    syncSettings()
    flush()
  },
}).attach()

// Files: the picker and drops (file:Pick, files dragged over the page) come in as events; uploads
// go to the site's stand-in server (the "demo" handler: a moment per file, and the first try of
// every third file fails, so progress, failure and retry can be seen).
let demoUploads = 0
const demoUpload: Uploader = (file, ctx) =>
  new Promise((resolve, reject) => {
    const fails = ++demoUploads % 3 === 0
    const total = Math.max(1, file.size)
    const steps = 12
    let step = 0
    const timer = setInterval(() => {
      step++
      ctx.onProgress(Math.round((total * step) / steps))
      if (fails && step === Math.round(steps / 2)) clearInterval(timer), reject(new Error('The connection to the server was lost.'))
      else if (step >= steps) clearInterval(timer), resolve({})
    }, 160)
    ctx.signal.addEventListener('abort', () => clearInterval(timer), { once: true })
  })
// Files kept in the browser (file:keepIn: the file explorer) go to IndexedDB; their previews are
// made in a worker, so decoding a large photo never holds up the page.
new Files(bus, {
  handlers: { demo: demoUpload },
  thumbnail: workerThumbnails(() => new Worker(new URL('../src/thumbnail.worker.ts', import.meta.url), { type: 'module' })),
  onHandled: () => {
    syncSettings()
    flush()
  },
}).attach(shell)

// Changes of where we are go to the address; Back, Forward and typed or followed addresses
// come back as nav:Navigate events, and a followed link's target is brought into view.
navigation.attach(runtime, {
  bus,
  reveal: rendererReveal(shell),
  onNavigate: () => {
    syncSettings()
    flush()
  },
})

const checkPerf = perfRunner(runtime, flush)
syncSettings()
flush()
// What the visitor did before the client was ready happens now (the page was taken over).
if (takeover) takeover.replay()
performance.mark('sem:ready')

// Hidden views are evaluated in idle time, a slice at a time, so navigation finds
// them ready and interactions never pay for them.
const idle = (cb: (d: { timeRemaining(): number }) => void) =>
  'requestIdleCallback' in window ? requestIdleCallback(cb, { timeout: 1000 }) : setTimeout(() => cb({ timeRemaining: () => 8 }), 30)
let warming = false
function warmup(deadline: { timeRemaining(): number }) {
  const more = runtime.warm(Math.max(2, deadline.timeRemaining() - 2))
  flush()
  warming = more
  if (more) idle(warmup)
}
const scheduleWarmup = () => {
  if (!warming) (warming = true), idle(warmup)
}
scheduleWarmup()
if (firstGraphs) idle(() => void loadRest())

/**
 * The graphs the page did not need first, in idle time: fetched, read a file per slice, then loaded
 * as one change through the runtime (their rules join the engine, their reactions the bus, their
 * remembered state is restored), with the sources of the examples among them.
 */
async function loadRest() {
  performance.mark('sem:graphs-fetch')
  const ontology = ONTOLOGY_NAMES.filter((n) => !wanted(n))
  const gallery = Object.keys(galleryLoaders).filter((n) => !wanted(n))
  await Promise.all([loadOntology(ontology), loadGallery(gallery)])
  const texts = [...ontology.map((n) => ontologyText(n)!), ...gallery.map((n) => galleryFiles[n]!)]
  const add: Quad[] = []
  for (const text of texts) {
    await new Promise<void>((resolve) => idle(() => resolve()))
    add.push(...parseTurtle(text, store.factory))
  }
  add.push(...sourceQuads(store.factory, siteSources(Object.fromEntries(gallery.map((n) => [n, galleryFiles[n]!])))))
  performance.mark('sem:graphs-parsed', { detail: { quads: add.length } })
  runtime.apply({ add, remove: [] })
  await persistence.restoreAdded().catch((e) => console.warn('[semblance] could not restore remembered state', e))
  flush()
  scheduleWarmup()
  graphsLoaded()
  performance.mark('sem:graphs')
}
void recordMemory()
setInterval(() => void recordMemory(), 3000)

// A handle for poking at the graph from the console (dev builds only).
if (import.meta.env.DEV) Object.assign(window, { semblance: { runtime, store, screen, text, bus, shell, textDom, navigation, sandboxes, connectors, stalls, rendered } })
