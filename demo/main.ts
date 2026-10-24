import appGraph from './app.ttl?raw'
import { EventBus, type Handled } from '../src/behaviour/events.ts'
import { EX, todoApp, todoReactions } from '../src/examples/todo.ts'
import { L10N, MOD, NS, SEM, STY } from '../src/ns.ts'
import type { Delta } from '../src/rdf.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'
import { initWeb, loadStore, type StoreKind } from '../src/web/load.ts'
import { perfRunner } from './perf-runner.ts'

// The host: a mount point, the effects of graph state (theme on <html>,
// engine layers, store choice, URL, benchmark runs) and nothing else. The
// whole interface is the component graph in app.ttl.

const UI = 'https://semblance.dev/demo#'
const params = new URLSearchParams(location.search)
const kind = (params.get('store') ?? 'hybrid') as StoreKind
const prefer = (kind === 'n3' ? 'function' : (params.get('prefer') ?? 'sparql')) as 'sparql' | 'function'
const STORES: Record<StoreKind, string> = { hybrid: 'Hybrid', oxigraph: 'Oxigraph', n3: 'N3' }
const RULES = { sparql: 'PreferSparql', function: 'PreferFunction' } as const
const PAGES = { playground: 'Playground', performance: 'Performance', components: 'Components' } as const

await initWeb()
// The Components page: one graph per component group (demo/gallery/*.ttl).
const gallery = Object.values(import.meta.glob('./gallery/*.ttl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const store = loadStore(kind, todoApp(5), appGraph, ...gallery)
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
setApp(UI + 'page', UI + (PAGES[location.hash.slice(1) as keyof typeof PAGES] ?? 'Playground'))

const runtime = new Runtime(store)
const enabledLayers = () => new Set(appValues(SEM.enables).map((t) => t.value))
// Each projection evaluates only what is shown under its mount root (demand-driven).
const screen = runtime.project({ modality: MOD.Screen, layers: enabledLayers(), prefer, provenance: true, name: 'screen', roots: [UI + 'shell'] })
const text = runtime.project({ modality: MOD.Text, prefer, provenance: true, name: 'text', roots: [EX + 'page'] })

// The keyboard layer shows ⌘ / ⌥ glyphs on Apple platforms, Ctrl / Alt elsewhere.
if (/Mac|iPhone|iPad/.test(navigator.platform)) document.documentElement.setAttribute('data-sem-platform', 'apple')

const sheet = new CSSStyleSheet()
sheet.replaceSync(compileStyles(store))
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]

const shell = new DomRenderer(screen.index, document.getElementById('app')!, UI + 'shell')
// The Text projection mounts into its slot once the slot is shown (it is evaluated on demand).
let textDom: DomRenderer | undefined
// Modal overlays take focus when they open and give it back when they close.
let modal: Element | null = null
let opener: HTMLElement | null = null
function focusModal() {
  const open = [...document.querySelectorAll('[aria-modal=true]')].filter((d) => !d.closest('[hidden]')).at(-1) ?? null
  if (open === modal) return
  if (open && !modal) opener = document.activeElement as HTMLElement | null
  modal = open
  if (open) (open.querySelector('input, textarea, select, button:not(.sem-close), [tabindex]') as HTMLElement | null ?? (open as HTMLElement)).focus?.()
  else opener?.focus?.(), (opener = null)
}

const flush = () => {
  shell.flush()
  focusModal()
  const slot = shell.slot('text')
  if (slot && textDom?.host !== slot) textDom = new DomRenderer(text.index, slot, EX + 'page')
  textDom?.flush()
}
flush()

// --- effects of graph state --------------------------------------------------------------

function syncSettings() {
  const slug = (t: { value: string } | undefined) => t && store.match(nn(t.value), nn(SEM.slug), null)[0]?.object.value
  const scheme = slug(appValues(STY.colorScheme)[0])
  if (scheme) document.documentElement.setAttribute('data-sem-color-scheme', scheme)

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
  document.documentElement.lang = code ?? 'en'
  document.documentElement.dir = rtl ? 'rtl' : 'ltr'

  const key = (p: string) => {
    const v = appValues(p)[0]
    return v && store.match(nn(v.value), nn(UI + 'key'), null)[0]?.object.value
  }
  const page = key(UI + 'page') ?? 'playground'
  if (location.hash.slice(1) !== page) history.replaceState(null, '', '#' + page)
  const nextStore = key(UI + 'store') ?? kind
  const nextRules = key(UI + 'rules') ?? prefer
  if (nextStore !== kind || (nextRules !== prefer && nextStore !== 'n3')) {
    location.search = new URLSearchParams({ store: nextStore, prefer: nextRules }).toString()
  }
  checkPerf()
}

/** Record what the last change cost in the graph (ui:stats), where c:Metrics shows it. */
function recordStats(action: string, ms: number, ruleRuns: number, domOps: number) {
  writeStats({ action: f.literal(action), ms: decimal(ms), ruleRuns: integer(ruleRuns), domOps: integer(domOps) })
}

/** Observable memory: JS heap (where the browser reports it), storage, graph and DOM size. */
async function recordMemory() {
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize
  const estimated = (await navigator.storage?.estimate?.().catch(() => undefined))?.usage ?? 0
  let session = 0
  try {
    for (let i = 0; i < sessionStorage.length; i++) session += (sessionStorage.key(i)!.length + (sessionStorage.getItem(sessionStorage.key(i)!) ?? '').length) * 2
  } catch {}
  const storage = estimated + session
  writeStats({
    ...(heap !== undefined ? { heap: decimal(heap / 1024 / 1024) } : {}),
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
let mark = { t: 0, runs: 0, ops: 0 }
runtime.apply = (delta) => {
  mark = { t: performance.now(), runs: runs(), ops: shell.ops }
  return apply(delta)
}

const short = (iri: string) => {
  for (const [p, ns] of Object.entries({ ...NS, ui: UI, ex: EX })) if (iri.startsWith(ns)) return `${p}:${iri.slice(ns.length)}`
  return iri
}
const bus = new EventBus(runtime, screen, { functions: todoReactions, prefer })
bus.attach(shell, (h: Handled) => {
  syncSettings()
  flush()
  scheduleWarmup()
  if (h.recorded) {
    const cost = { ms: performance.now() - mark.t, runs: runs() - mark.runs, ops: shell.ops - mark.ops }
    recordStats(`${short(h.type)} → ${h.reactions.map(short).join(', ')}`, cost.ms, cost.runs, cost.ops)
    flush()
  }
})

// Back/forward and typed URLs write the page into the graph.
addEventListener('hashchange', () => {
  const page = PAGES[location.hash.slice(1) as keyof typeof PAGES]
  if (!page) return
  apply({ remove: store.match(app, nn(UI + 'page'), null, dg), add: [f.quad(app, nn(UI + 'page'), nn(UI + page))] })
  syncSettings()
  flush()
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
if (import.meta.env.DEV) Object.assign(window, { semblance: { runtime, store, screen, text, bus, shell, textDom } })
