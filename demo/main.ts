import appGraph from './app.ttl?raw'
import { EventBus, type Handled } from '../src/behaviour/events.ts'
import { Scheduler } from '../src/behaviour/schedule.ts'
import { Clipboard } from '../src/clipboard.ts'
import { Files, type Uploader } from '../src/files.ts'
import { Fullscreen } from '../src/fullscreen.ts'
import { StallMonitor } from '../src/behaviour/stall.ts'
import { EX, todoApp, todoReactions } from '../src/examples/todo.ts'
import { indexedDbBackend, Persistence, webStorageBackend } from '../src/persistence.ts'
import { Navigation, rendererReveal } from '../src/navigation.ts'
import { attachIntent } from '../src/intent.ts'
import { NetworkCapture } from '../src/network.ts'
import { Sandboxes } from '../src/sandbox.ts'
import { compactIri, declaredPrefixes } from '../src/prefixes.ts'
import { isExampleSource, recordSources } from '../src/sources.ts'
import { L10N, MOD, NS, SEM, STY } from '../src/ns.ts'
import type { Delta } from '../src/rdf.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'
import { hasStore, initWeb, loadStoreWith, type StoreKind } from '../src/web/load.ts'
import { attachWalkthroughs } from '../src/web/walkthrough.ts'
import { attachConnectors } from '../src/web/connectors.ts'
import { RecalculationTrace } from '../src/recalculation.ts'
import { perfRunner } from './perf-runner.ts'

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
// second run, or in idle time (?compile=run|idle; Tools › Engine).
const compile = (['off', 'run', 'idle'].includes(params.get('compile') ?? '') ? params.get('compile') : 'off') as 'off' | 'run' | 'idle'
const COMPILES = { off: 'CompileOff', run: 'CompileOnRun', idle: 'CompileIdle' } as const
const STORES: Record<StoreKind, string> = { wat: 'SemblanceWasm', rust: 'SemblanceRust', hybrid: 'Hybrid', oxigraph: 'Oxigraph', n3: 'N3' }
const RULES = { sparql: 'PreferSparql', function: 'PreferFunction' } as const

// Only the chosen store's code and WASM are loaded.
await initWeb(kind)
// The Components page: one graph per component group (demo/gallery/*.ttl).
const galleryFiles = import.meta.glob('./gallery/*.ttl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const gallery = Object.values(galleryFiles)
const storeOptions = { compiled: compile === 'idle' ? ('idle' as const) : compile === 'run' }
const store = loadStoreWith(kind, storeOptions, todoApp(5), appGraph, ...gallery)
// The examples show their own source, recorded as data (c:SourceText).
recordSources(store, {
  'src/examples/todo.ts': todoApp(5),
  ...Object.fromEntries(Object.entries(galleryFiles).map(([p, t]) => ['demo/' + p.slice(2), t]).filter(([p]) => isExampleSource(p!))),
})
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
const f = store.factory
const nn = (iri: string) => f.namedNode(iri)
const app = nn(UI + 'app')
const dg = f.defaultGraph()
const appValues = (p: string) => store.match(app, nn(p), null, dg).map((q) => q.object)
const setApp = (p: string, value: string) => {
  for (const q of store.match(app, nn(p), null, dg)) store.delete(q)
  store.add(f.quad(app, nn(p), nn(value), dg))
}

// Settings that arrive through the URL become graph state before projecting.
setApp(UI + 'store', UI + STORES[kind])
setApp(UI + 'rules', UI + RULES[prefer])
setApp(UI + 'compile', UI + COMPILES[compile])

const runtime = new Runtime(store)
const enabledLayers = () => new Set(appValues(SEM.enables).map((t) => t.value))
// Each projection evaluates only what is shown under its mount root (demand-driven).
const screen = runtime.project({ modality: MOD.Screen, layers: enabledLayers(), prefer, provenance: true, name: 'screen', roots: [UI + 'shell'] })
const text = runtime.project({ modality: MOD.Text, prefer, provenance: true, name: 'text', roots: [EX + 'page'] })

// The keyboard layer shows ⌘ / ⌥ glyphs on Apple platforms, Ctrl / Alt elsewhere.
if (/Mac|iPhone|iPad/.test(navigator.platform)) document.documentElement.setAttribute('data-sem-platform', 'apple')

const sheet = new CSSStyleSheet()
const css = compileStyles(store)
sheet.replaceSync(css)
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]

const shell = new DomRenderer(screen.index, document.getElementById('app')!, UI + 'shell')
// The Text projection mounts into its slot once the slot is shown (it is evaluated on demand).
let textDom: DomRenderer | undefined
// Modal overlays and menus take focus when they open and give it back when they close.
const popups = {
  modal: { selector: '[aria-modal=true]', first: 'input, textarea, select, button:not(.sem-close), [tabindex]', open: null as Element | null, opener: null as HTMLElement | null },
  menu: { selector: '[role=menu]', first: '[role=menuitem]:not([disabled])', open: null as Element | null, opener: null as HTMLElement | null },
}
function focusModal() {
  for (const p of Object.values(popups)) {
    const open = [...document.querySelectorAll(p.selector)].filter((d) => !d.closest('[hidden]')).at(-1) ?? null
    if (open === p.open) continue
    if (open && !p.open) p.opener = document.activeElement as HTMLElement | null
    const wasFocusedInside = !!p.open && (p.open.contains(document.activeElement) || document.activeElement === document.body)
    p.open = open
    if (open) {
      if (!open.contains(document.activeElement)) ((open.querySelector(p.first) as HTMLElement | null) ?? (open as HTMLElement)).focus?.()
    } else {
      if (wasFocusedInside || document.activeElement === document.body) p.opener?.focus?.()
      p.opener = null
    }
  }
}

// Live examples (c:LiveExample) run in sandboxes of their own, mounted in their slots once shown.
let sandboxes: Sandboxes | undefined
// DOM patches are timed: a hang outside every turn of the engine is blamed on them (the stall log).
let stalls: StallMonitor | undefined
const flush = () => (stalls ? stalls.rendering(patch) : patch())
const patch = () => {
  shell.flush()
  sandboxes?.sync()
  focusModal()
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
  siteCss: css,
})
sandboxes.attach()
flush()
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
  const nextCompile = key(UI + 'compile') ?? compile
  if (nextStore !== kind || (nextRules !== prefer && nextStore !== 'n3') || nextCompile !== compile) {
    const search = new URLSearchParams({ store: nextStore, prefer: nextRules })
    if (nextCompile !== 'off') search.set('compile', nextCompile)
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
    triples: integer(store.match(null, null, null).length),
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
persistence.attach(runtime)
// The page's own fetches and sockets, and the events it reports, as net:Capture members.
const network = new NetworkCapture(runtime, { onWrite: () => flush() })
network.attach()
Object.assign(globalThis, { network })
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
    recordStats(`${short(h.type)} → ${h.reactions.map(short).join(', ')}`, cost.ms, cost.runs, cost.ops, cost.views)
    flush()
  }
})
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
new Files(bus, {
  handlers: { demo: demoUpload },
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
void recordMemory()
setInterval(() => void recordMemory(), 3000)

// A handle for poking at the graph from the console (dev builds only).
if (import.meta.env.DEV) Object.assign(window, { semblance: { runtime, store, screen, text, bus, shell, textDom, navigation, sandboxes, connectors, stalls } })
