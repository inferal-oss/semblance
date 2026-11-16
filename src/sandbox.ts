// The host effect of live examples (ontology/components/live.ttl). Each c:LiveExample's sources run in
// a sandbox of their own: a store with Semblance's ontology and the sources, its own runtime, its own
// projection, mounted in the example's host-owned slot with its own event bus. So a source that does
// not parse, a rule that throws or a reaction that fails stays inside the sandbox, and the site never
// sees the example's graph. What happened is written back to the site's graph, as data the example's
// rendering shows: c:sandboxState, c:problem, c:renderTime, c:edited. A sandbox is built when its
// example is first shown, and rebuilt when its sources change (after typing pauses); a hidden example
// costs nothing. With c:dataPreview, the example's data is shown by an RDF editor in diff mode
// (c:RdfEditor, c:diff) inside the sandbox, over the subjects of that CONSTRUCT, mounted in the
// example's data slot: what the interactions added and removed since it was built, from the
// sandbox's own change log. How many triples of the data the last interaction added and removed is
// written back (c:triplesAdded/Removed) for the caption. A server renders the examples it shows the
// same way (prerenderSandboxes, docs/SSR.md), and the client's first sandbox of such a slot takes the
// server's elements over. With c:storeSource, one of the example's editors is a simulated store
// instead of a source of the sandbox (src/simulated-store.ts): the sandbox binds every src:Source of
// its graph to that store, in-process, through the remote-sources effect; an edit of the store's
// Turtle is one change to the store, which reaches the page as a delta, and the page's writes come
// back to the store's text. The store lives as long as the example is mounted, across rebuilds.
import { Parser } from 'n3'
import type { Quad, Term } from '@rdfjs/types'
import { EventBus } from './behaviour/events.ts'
import { Fullscreen, type FullscreenHost } from './fullscreen.ts'
import type { FnRule } from './engine/context.ts'
import { DEFAULT_LAYERS, MOD, NS, RDF_FIRST, RDF_NIL, RDF_REST, RDF_TYPE, SEM, STY, XSD_BOOLEAN, XSD_INTEGER } from './ns.ts'
import { compactIri } from './prefixes.ts'
import { type Delta, mint, quadKey } from './rdf.ts'
import { DomRenderer } from './render/dom.ts'
import { toHTML } from './render/serialize.ts'
import { type Projection, Runtime } from './runtime.ts'
import type { GraphStore } from './store/types.ts'
import { compileStyles } from './style/compile.ts'
import { BOX_ATTRIBUTE, boxSelector, scopedCss } from './style/scope.ts'
import { readPolicy, type SafetyPolicy } from './safety.ts'
import { overBudget } from './budget.ts'
import { attachAnchoredPopups } from './web/anchored-popups.ts'
import { attachSizeHandles } from './web/size-handles.ts'
import { replayKept, SSR_ATTRIBUTE } from './web/takeover.ts'
import { adoptSheet, dropSheet } from './web/builtins.ts'
import type { SourceServer } from './node/source-server.ts'
import { RemoteSources, type SourceTransport } from './remote.ts'
import { localTransport, parseStore, simulatedStore, storeDelta, storeTurtle } from './simulated-store.ts'

const c = NS.c
/** The diff viewer of a live example's data, in its sandbox (each sandbox has a store of its own). */
const DATA_VIEWER = 'urn:semblance:live:data'
export const LIVE = {
  LiveExample: c + 'LiveExample',
  sources: c + 'sources',
  storeSource: c + 'storeSource',
  exampleRoot: c + 'exampleRoot',
  textPreview: c + 'textPreview',
  dataPreview: c + 'dataPreview',
  triplesAdded: c + 'triplesAdded',
  changedRow: c + 'changedRow',
  triplesRemoved: c + 'triplesRemoved',
  original: c + 'original',
  value: c + 'value',
  label: c + 'label',
  sandboxState: c + 'sandboxState',
  Live: c + 'SandboxLive',
  Stale: c + 'SandboxStale',
  Broken: c + 'SandboxBroken',
  problem: c + 'problem',
  SandboxProblem: c + 'SandboxProblem',
  message: c + 'message',
  inSource: c + 'inSource',
  sourceLine: c + 'sourceLine',
  renderTime: c + 'renderTime',
  edited: c + 'edited',
  interacted: c + 'interacted',
  copied: c + 'copied',
} as const

/**
 * Turtle declarations of every prefix Semblance knows, on one line: a source may use them without
 * declaring them (its own lines then start at line 2, and are reported as from 1).
 */
const PREAMBLE = Object.entries(NS).map(([p, ns]) => `@prefix ${p}: <${ns}> .`).join(' ') + '\n'

/** One source of an example: its editor in the site's graph, its name and its text. */
export interface SandboxSource {
  editor?: string
  name: string
  text: string
}

/** A problem a build met; an error stops the build, a warning does not. */
export interface SandboxProblem {
  message: string
  severity: 'error' | 'warning'
  /** The editor of the source it is in. */
  source?: string
  /** The line of that source, from 1. */
  line?: number
}

export interface SandboxOptions {
  /** A store with Semblance's ontology and the given Turtle loaded (loadStore of src/web or src/node, with a store kind). */
  load: (...turtle: string[]) => GraphStore
  layers?: Iterable<string>
  prefer?: 'sparql' | 'function'
  /** Function rules beyond the built-in ones, by name. */
  functions?: Record<string, FnRule>
  /**
   * How long one turn of a sandbox may run, in ms (1500). Over it, the sandbox stops itself (its
   * watchdog's held work is dropped, src/engine/watchdog.ts) and says so inline, rather than
   * freezing the site: a build is reported broken, an interaction leaves a problem.
   */
  budgetMs?: number
  /** Where relative URLs in the examples resolve: the site's (its screen projection's urlBase, src/render/html-index.ts). */
  urlBase?: string
  /**
   * What an example may render (src/safety.ts): its sources are authored content, so what the
   * policy refuses is left out and reported as a warning. Read from a trusted store (authoredPolicy);
   * by default from a store of the ontology alone (`load()`), never the sandbox's nor one that
   * restored remembered state.
   */
  policy?: SafetyPolicy
}

const ontologyPolicies = new WeakMap<SandboxOptions['load'], SafetyPolicy>()
/** The policy of authored content, read from a store of the ontology alone (once per loader). */
function trustedPolicy(opts: SandboxOptions): SafetyPolicy {
  if (opts.policy) return opts.policy
  let p = ontologyPolicies.get(opts.load)
  if (!p) {
    const store = opts.load()
    try {
      ontologyPolicies.set(opts.load, (p = readPolicy(store)))
    } finally {
      store.dispose?.()
    }
  }
  return p
}

/** What a stalled sandbox says: the budget, and the slowest work of the turn. */
function stallProblem(runtime: Runtime, sources: SandboxSource[], budgetMs: number): SandboxProblem {
  const s = runtime.watchdog.stall
  const w = s?.culprit
  const what = w ? ` The slowest work was ${short(w.iri, sources)}${w.focus ? ` for ${short(w.focus.split(' ')[0]!, sources)}` : ''} (${Math.round(w.ms)} ms).` : ''
  const over = s?.limit && s.limit !== 'time' ? overBudget(runtime) : `took longer than ${budgetMs} ms`
  return { message: `Stopped: rendering ${over}, and ${s?.pending ?? runtime.held} renderings were left undone.${what}`, severity: 'error' }
}

/** A built sandbox: the example's own store, runtime and projections. */
export interface Sandbox {
  root: string
  store: GraphStore
  runtime: Runtime
  screen: Projection
  text?: Projection
  /** The diff viewer of its data (c:dataPreview), projected once mounted. */
  data?: Projection
  /** Whether its sources declare styles of their own (sty:StyleRule, sty:Token, sty:Keyframes). */
  styled: boolean
  /** Its store's stylesheet, compiled under the policy, when it is styled (scopedCss takes what it adds to the site's). */
  css?: string
  /** With a simulated store: its event bus (made before its first rendering, so the store's events reach its reactions), and the effect that follows the store. */
  bus?: EventBus
  remote?: RemoteSources
  /** What the effect calls once the store changed the graph (the host's flush, once mounted). */
  hooks: { changed?: () => void }
}

export interface Build {
  sandbox?: Sandbox
  problems: SandboxProblem[]
  /** Whole milliseconds the build took. */
  ms: number
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** "Expected entity but got . on line 4." -> the message and the source's own line. */
function parseError(e: Error, source: SandboxSource): SandboxProblem {
  const line = (e as Error & { context?: { line?: number } }).context?.line
  const message = e.message.replace(/\s+on line \d+\.?$/, '').replace(/^./, (ch) => ch.toUpperCase())
  return { message, severity: 'error', source: source.editor, line: line !== undefined ? Math.max(1, line - 1) : undefined }
}

const STYLE_CLASSES = new Set([STY.StyleRule, NS.sty + 'Token', NS.sty + 'Keyframes'])

/**
 * Build a sandbox for `sources` (in load order) showing `root`: parse each source (an error names
 * its line), load them over Semblance's ontology, project `root` on screen (and in the Text
 * modality with `withText`), and check that it rendered. Shape violations are warnings.
 */
export function buildSandbox(
  sources: SandboxSource[],
  root: string,
  opts: SandboxOptions & { languages?: string[]; withText?: boolean; store?: SourceServer; written?: () => void },
): Build {
  const t0 = now()
  const problems: SandboxProblem[] = []
  const done = (sandbox?: Sandbox): Build => ({ sandbox, problems, ms: Math.max(0, Math.round(now() - t0)) })
  let styled = false
  for (const s of sources) {
    try {
      const quads = new Parser({ format: 'text/turtle' }).parse(PREAMBLE + s.text)
      styled ||= quads.some((q) => q.predicate.value === RDF_TYPE && STYLE_CLASSES.has(q.object.value))
    } catch (e) {
      problems.push(parseError(e as Error, s))
    }
  }
  if (problems.length) return done()
  let store: GraphStore
  try {
    store = opts.load(...sources.map((s) => PREAMBLE + s.text))
  } catch (e) {
    problems.push({ message: (e as Error).message, severity: 'error' })
    return done()
  }
  // A build that fails lets go of its store at once: Oxigraph's share one WebAssembly memory.
  let runtime: Runtime | undefined
  const failed = () => (runtime ? runtime.dispose() : store.dispose?.(), done())
  const f = store.factory
  if (!store.match(f.namedNode(root), null, null).length) {
    problems.push({ message: `Nothing to show: ${short(root, sources)} is not described in the source.`, severity: 'error' })
    return failed()
  }
  const warnings: string[] = []
  const policy = trustedPolicy(opts)
  try {
    runtime = new Runtime(store)
    const budgetMs = opts.budgetMs ?? 1500
    runtime.watchdog.budgetMs = budgetMs
    const base = { layers: opts.layers ?? DEFAULT_LAYERS, prefer: opts.prefer, functions: opts.functions, languages: opts.languages, roots: [root], urlBase: opts.urlBase, policy }
    const screen = runtime.project({ ...base, modality: MOD.Screen, name: 'screen' }, (e) => warnings.push(e.message))
    const text = opts.withText ? runtime.project({ ...base, modality: MOD.Text, name: 'text' }, (e) => warnings.push(e.message)) : undefined
    // Over budget: the sandbox stops itself, and the build is broken (the site never waits on it).
    if (runtime.held) {
      problems.push(stallProblem(runtime, sources, budgetMs))
      runtime.stopStall()
      return failed()
    }
    // A simulated store: every src:Source of the sandbox follows it, its snapshot applied before the
    // build returns (the first rendering, on a server too, shows what the store holds).
    const hooks: Sandbox['hooks'] = {}
    let bus: EventBus | undefined
    let remote: RemoteSources | undefined
    if (opts.store) {
      bus = new EventBus(runtime, screen, { prefer: opts.prefer })
      const transport = localTransport(opts.store, opts.written)
      const endpoints: Record<string, SourceTransport> = {}
      for (const q of store.match(null, f.namedNode(RDF_TYPE), f.namedNode(NS.src + 'Source'), f.defaultGraph())) endpoints[q.subject.value] = transport
      remote = new RemoteSources(runtime, { endpoints, bus, onChange: () => hooks.changed?.() })
      remote.attach()
      if (runtime.held) {
        problems.push(stallProblem(runtime, sources, budgetMs))
        runtime.stopStall()
        return failed()
      }
    }
    if (!screen.index.resolve(root)) problems.push({ message: `${short(root, sources)} renders nothing: is it an instance of a component class with a rendering?`, severity: 'error' })
    const css = styled ? compileStyles(store, { policy, onRefused: (e) => warnings.push(e.message) }) : undefined
    for (const w of new Set(warnings)) problems.push({ message: w, severity: 'warning' })
    problems.push(...violations(store, sources))
    if (problems.some((p) => p.severity === 'error')) return failed()
    return done({ root, store, runtime, screen, text, styled, css, bus, remote, hooks })
  } catch (e) {
    problems.push({ message: (e as Error).message, severity: 'error' })
    return failed()
  }
}

/** The shapes layer's results, as warnings: "ex:cups: A tally needs a label". */
function violations(store: GraphStore, sources: SandboxSource[]): SandboxProblem[] {
  const f = store.factory
  const out: SandboxProblem[] = []
  for (const q of store.match(null, f.namedNode(NS.sh + 'resultMessage'), null)) {
    const focus = store.match(q.subject, f.namedNode(NS.sh + 'focusNode'), null)[0]?.object
    out.push({ message: `${focus ? short(focus.value, sources) + ': ' : ''}${q.object.value}`, severity: 'warning' })
  }
  return out.sort((a, b) => (a.message < b.message ? -1 : a.message > b.message ? 1 : 0))
}

/** An IRI as the sources would write it (their own prefixes, then Semblance's). */
function short(iri: string, sources: SandboxSource[]): string {
  return compactIri(iri, { ...NS, ...declared(sources.map((s) => s.text).join('\n')) })
}

function declared(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of text.matchAll(/@prefix\s+([A-Za-z][\w-]*)?:\s*<([^>]*)>/g)) out[m[1] ?? ''] = m[2]!
  return out
}

/**
 * A source as a complete Turtle file: the declarations of the Semblance prefixes it uses but does
 * not declare, then the source (what Copy puts on the clipboard).
 */
export function completeSource(text: string): string {
  const own = declared(text)
  // Prefixed names outside IRIs and comments.
  const bare = text.replace(/<[^<>\s]*>/g, '').replace(/(^|\s)#[^\n]*/g, '$1')
  const used = new Set([...bare.matchAll(/(?<![\w:@/.-])([A-Za-z][\w-]*):(?=[A-Za-z_\s(\[;,.]|$)/gm)].map((m) => m[1]!))
  const missing = Object.entries(NS).filter(([p]) => used.has(p) && !(p in own))
  return missing.length ? missing.map(([p, ns]) => `@prefix ${p}: <${ns}> .`).join('\n') + '\n\n' + text : text
}

// --- a live example in the site's graph ----------------------------------------------------------

/** What the site's graph says of a live example: its sources (each editor's text as edited, else as written), what it shows, and how. */
export interface ExampleSpec {
  sources: SandboxSource[]
  /** c:exampleRoot: the root of its projection. */
  root?: string
  /** c:textPreview: shown in the Text modality too. */
  withText: boolean
  /** c:dataPreview: the CONSTRUCT of its data. */
  dataQuery?: string
  /** c:storeSource: the source that is the simulated store's Turtle (one of `sources`, not loaded into the sandbox). */
  store?: SandboxSource
}

/** A live example as the site's graph describes it now. */
export function exampleSpec(store: GraphStore, example: string): ExampleSpec {
  const f = store.factory
  const dg = f.defaultGraph()
  const one = (s: Term, p: string) => store.match(s, f.namedNode(p), null, dg)[0]?.object
  const ex = f.namedNode(example)
  const sources: SandboxSource[] = []
  for (let cell = one(ex, LIVE.sources); cell && cell.value !== RDF_NIL && sources.length < 64; cell = one(cell, RDF_REST)) {
    const editor = one(cell, RDF_FIRST)
    if (!editor) continue
    const text = one(editor, LIVE.value)?.value ?? one(editor, LIVE.original)?.value ?? ''
    sources.push({ editor: editor.value, name: one(editor, LIVE.label)?.value ?? editor.value.replace(/^.*[#/]/, ''), text })
  }
  const storeEditor = one(ex, LIVE.storeSource)?.value
  return {
    sources,
    store: storeEditor === undefined ? undefined : sources.find((s) => s.editor === storeEditor),
    root: one(ex, LIVE.exampleRoot)?.value,
    withText: store.match(ex, f.namedNode(LIVE.textPreview), null, dg).some((q) => q.object.value === 'true'),
    dataQuery: one(ex, LIVE.dataPreview)?.value,
  }
}

/** The store of an example's c:storeSource, from its Turtle: the store, or the problem with the text (the store is then empty). */
export function exampleStore(source: SandboxSource): { server: SourceServer; problem?: SandboxProblem } {
  try {
    return { server: simulatedStore(parseStore(source.text, PREAMBLE)) }
  } catch (e) {
    return { server: simulatedStore([]), problem: parseError(e as Error, source) }
  }
}

/** Build the sandbox of an example as the site's graph describes it (a build with no root is a problem); its store's source is not one of the sandbox's. */
function buildExample(spec: ExampleSpec, opts: SandboxOptions & { languages?: string[]; store?: SourceServer; written?: () => void }): Build {
  return spec.root
    ? buildSandbox(spec.store ? spec.sources.filter((s) => s !== spec.store) : spec.sources, spec.root, { ...opts, withText: spec.withText })
    : { problems: [{ message: 'The example names nothing to show (c:exampleRoot).', severity: 'error' as const }], ms: 0 }
}

/** What a build or an interaction found, as written to the site's graph (only what is given changes). */
export interface SandboxStatus {
  state?: string
  problems?: SandboxProblem[]
  ms?: number
  edited?: boolean
  interacted?: boolean
}

/** The change to the site's graph that says `status` of `example` (empty when it says so already). */
export function statusDelta(store: GraphStore, example: string, status: SandboxStatus): Delta {
  const f = store.factory
  const dg = f.defaultGraph()
  const s = f.namedNode(example)
  const nn = (iri: string) => f.namedNode(iri)
  const integer = (n: number) => f.literal(String(n), nn(XSD_INTEGER))
  const current: Quad[] = []
  const given = [
    [LIVE.sandboxState, status.state],
    [LIVE.problem, status.problems],
    [LIVE.renderTime, status.ms],
    [LIVE.edited, status.edited],
    [LIVE.interacted, status.interacted],
  ] as const
  for (const [p, v] of given) {
    if (v === undefined) continue
    for (const q of store.match(s, nn(p), null, dg)) {
      current.push(q)
      if (p === LIVE.problem) current.push(...store.match(q.object, null, null, dg))
    }
  }
  const desired: Quad[] = []
  if (status.state) desired.push(f.quad(s, nn(LIVE.sandboxState), nn(status.state)))
  if (status.ms !== undefined) desired.push(f.quad(s, nn(LIVE.renderTime), integer(status.ms)))
  if (status.edited) desired.push(f.quad(s, nn(LIVE.edited), f.literal('true', nn(XSD_BOOLEAN))))
  if (status.interacted) desired.push(f.quad(s, nn(LIVE.interacted), f.literal('true', nn(XSD_BOOLEAN))))
  ;(status.problems ?? []).slice(0, 20).forEach((p, i) => {
    const node = nn(`${example}/problem-${i}`)
    desired.push(
      f.quad(s, nn(LIVE.problem), node),
      f.quad(node, nn(RDF_TYPE), nn(LIVE.SandboxProblem)),
      f.quad(node, nn(SEM.order), integer(i)),
      f.quad(node, nn(LIVE.message), f.literal(p.message)),
      f.quad(node, nn(STY.tone), nn(NS.sty + (p.severity === 'error' ? 'Danger' : 'Warning'))),
    )
    if (p.source) desired.push(f.quad(node, nn(LIVE.inSource), nn(p.source)))
    if (p.line !== undefined) desired.push(f.quad(node, nn(LIVE.sourceLine), integer(p.line)))
  })
  const keys = new Set(desired.map(quadKey))
  const had = new Set(current.map(quadKey))
  return { remove: current.filter((q) => !keys.has(quadKey(q))), add: desired.filter((q) => !had.has(quadKey(q))) }
}

/** The example's data (c:dataPreview) in its sandbox now: the CONSTRUCT, with Semblance's prefixes and the sources' own declared. */
function readData(sandbox: Sandbox, query: string, sources: SandboxSource[]): Quad[] | undefined {
  const prefixes = { ...NS, ...declared(sources.map((s) => s.text).join('\n')) }
  const head = Object.entries(prefixes).map(([p, ns]) => `PREFIX ${p}: <${ns}>`).join('\n')
  try {
    return sandbox.store.construct(head + '\n' + query, [sandbox.store.factory.defaultGraph()])
  } catch (e) {
    console.warn('[semblance] the data of a live example could not be read', e)
    return undefined
  }
}

/**
 * The diff viewer's entries: the data's subjects (`seen`, since the sandbox was built: one whose
 * statements all went still shows them, removed), and the sources' own prefixes, so it writes their names.
 */
function showData(sandbox: Sandbox, quads: Quad[], seen: Set<string>, sources: SandboxSource[]): void {
  const own = declared(sources.map((s) => s.text).join('\n'))
  const bf = sandbox.store.factory
  const viewer = bf.namedNode(DATA_VIEWER)
  const entry = bf.namedNode(c + 'entry')
  for (const q of quads) if (q.subject.termType === 'NamedNode') seen.add(q.subject.value)
  const desired = [...seen].map((iri) => bf.quad(viewer, entry, bf.namedNode(iri)))
  Object.entries(own).forEach(([p, ns], i) => {
    const decl = bf.namedNode(`${DATA_VIEWER}-prefix-${i}`)
    desired.push(bf.quad(decl, bf.namedNode(NS.sh + 'prefix'), bf.literal(p)), bf.quad(decl, bf.namedNode(NS.sh + 'namespace'), bf.literal(ns, bf.namedNode(NS.xsd + 'anyURI'))))
  })
  const current = [...sandbox.store.match(viewer, entry, null), ...Object.keys(own).flatMap((_, i) => sandbox.store.match(bf.namedNode(`${DATA_VIEWER}-prefix-${i}`), null, null))]
  const want = new Set(desired.map(quadKey))
  const have = new Set(current.map(quadKey))
  const delta: Delta = { remove: current.filter((q) => !want.has(quadKey(q))), add: desired.filter((q) => !have.has(quadKey(q))) }
  if (delta.add.length || delta.remove.length) sandbox.runtime.apply(delta)
}

/**
 * The data's viewer in a built sandbox: a read-only RDF editor in diff mode over the data's
 * subjects, with its entries in place before it is first projected (so its first rendering, on a
 * server or in the browser, is the same).
 */
function projectData(sandbox: Sandbox, query: string, sources: SandboxSource[], seen: Set<string>, opts: SandboxOptions & { languages?: string[] }): Projection {
  const sf = sandbox.store.factory
  const viewer = sf.namedNode(DATA_VIEWER)
  sandbox.runtime.apply({
    add: [sf.quad(viewer, sf.namedNode(RDF_TYPE), sf.namedNode(c + 'RdfEditor')), sf.quad(viewer, sf.namedNode(c + 'diff'), sf.literal('true', sf.namedNode(XSD_BOOLEAN)))],
    remove: [],
  })
  const quads = readData(sandbox, query, sources)
  if (quads) showData(sandbox, quads, seen, sources)
  return (sandbox.data = sandbox.runtime.project(
    { layers: opts.layers ?? DEFAULT_LAYERS, prefer: opts.prefer, functions: opts.functions, languages: opts.languages, roots: [DATA_VIEWER], modality: MOD.Screen, name: 'data', urlBase: opts.urlBase, policy: trustedPolicy(opts) },
    (e) => console.warn('[semblance] the data of a live example', e.message),
  ))
}

/** The attribute of a sandbox's own element (its styles are scoped to it). */
const SANDBOX_ATTRIBUTE = BOX_ATTRIBUTE
/** The attribute of the style a server put beside a styled sandbox's rendering (the client's own sheet replaces it). */
const SANDBOX_STYLES_ATTRIBUTE = 'data-sem-sandbox-styles'

/** The slot names of a live example (sem:slot in its renderings): the rendering, the text, the data. */
export const slotsOf = (example: string) => ({ screen: example, text: `${example} text`, data: `${example} data` })

export interface PrerenderOptions extends SandboxOptions {
  /** The site's projection roots: an example is rendered when it is shown under them. */
  roots: Iterable<string>
  /** The site's stylesheet, or how to get it (a styled sandbox's own rules are what it adds). */
  siteCss?: string | (() => string)
  /**
   * What examples rendered to, kept across renders of a site whose examples' sources do not change
   * (a warm server runtime, src/server/warm.ts): an example built once with the same sources, in
   * the same languages, for the same slots, is not built again.
   */
  cache?: Map<string, Map<string, string>>
}

/**
 * Server-side rendering of the site's live examples: each one shown has its sandbox built as the
 * browser builds it (its sources, a store of its own, the same turn limit), its rendering, text
 * and data serialized for its slots, and is let go. A build that fails writes its problems to the
 * site's graph, as the browser's host does. The client takes the slots over (Sandboxes.mount).
 * Returns what each slot holds, by its name (toHTML's `slots`).
 */
export function prerenderSandboxes(runtime: Runtime, screen: Projection, opts: PrerenderOptions): Map<string, string> {
  const out = new Map<string, string>()
  const store = runtime.store
  const f = store.factory
  const roots = new Set(opts.roots)
  const languages = [...screen.engine.languages]
  let n = 0
  // Read from the ontology alone, as the browser's Sandboxes do, so both render the same.
  opts = { ...opts, policy: trustedPolicy(opts) }
  for (const q of store.match(null, f.namedNode(RDF_TYPE), f.namedNode(LIVE.LiveExample), f.defaultGraph())) {
    const iri = q.subject.value
    const slots = slotsOf(iri)
    if (!screen.index.slots.has(slots.screen) || !screen.index.isShown(iri, roots)) continue
    const spec = exampleSpec(store, iri)
    const id = `ssr-${++n}`
    const wanted = [slots.screen, ...[slots.text, slots.data].filter((sl) => screen.index.slots.has(sl))]
    const key = JSON.stringify([iri, id, languages, opts.urlBase ?? screen.index.urlBase, wanted, spec])
    const cached = opts.cache?.get(key)
    if (cached) {
      for (const [slot, html] of cached) out.set(slot, html)
      continue
    }
    const simulated = spec.store && exampleStore(spec.store)
    const built = buildExample(spec, { ...opts, urlBase: opts.urlBase ?? screen.index.urlBase, languages, store: simulated?.server })
    if (simulated?.problem) built.problems.push(simulated.problem)
    const sandbox = built.sandbox
    if (!sandbox) {
      // What the browser's host writes of a build that failed (and nothing was ever shown).
      const delta = statusDelta(store, iri, { state: LIVE.Broken, problems: built.problems })
      if (delta.add.length || delta.remove.length) runtime.apply(delta)
      continue
    }
    try {
      const css = sandbox.css ? scopedCss(sandbox.css, typeof opts.siteCss === 'function' ? opts.siteCss() : (opts.siteCss ?? ''), boxSelector(id)) : ''
      const style = css ? `<style ${SANDBOX_STYLES_ATTRIBUTE}>${css.replace(/<\/style/gi, '<\\/style')}</style>` : ''
      out.set(slots.screen, `${style}<div ${SANDBOX_ATTRIBUTE}="${id}" ${SSR_ATTRIBUTE}>${toHTML(sandbox.screen.index, sandbox.root)}</div>`)
      if (sandbox.text && screen.index.slots.has(slots.text)) out.set(slots.text, `<div>${toHTML(sandbox.text.index, sandbox.root)}</div>`)
      if (spec.dataQuery && screen.index.slots.has(slots.data)) {
        const data = projectData(sandbox, spec.dataQuery, spec.sources, new Set(), { ...opts, urlBase: opts.urlBase ?? screen.index.urlBase, languages })
        out.set(slots.data, `<div>${toHTML(data.index, DATA_VIEWER)}</div>`)
      }
      opts.cache?.set(key, new Map([...out].filter(([slot]) => wanted.includes(slot))))
    } finally {
      sandbox.runtime.dispose()
    }
  }
  return out
}

// --- the host effect -------------------------------------------------------------------------------

export interface SandboxesOptions extends SandboxOptions {
  /** The site's renderer: the examples' slots are its elements. */
  renderer: DomRenderer
  /** Whether a component of the site is shown (e.g. screen.index.isShown(c, roots)). */
  shown: (component: string) => boolean
  /** Patch the site's DOM, after the sandboxes wrote their state to its graph. */
  flush: () => void
  /** The site's languages, most preferred first: a sandbox follows them. */
  languages?: () => string[]
  /** The site's stylesheet (compileStyles of its store), or how to get it when first needed: a sandbox's own sheet has only the rules it adds. */
  siteCss?: string | (() => string)
  /**
   * When to build a shown example's sandbox (each loads the whole ontology into a store of its
   * own): at once by default; a host may wait until its slot is in view or the page is idle, so a
   * page's first moments are not spent on examples below the fold. Call `build` then (once).
   */
  defer?: (slot: Element, build: () => void) => void
  /**
   * When a deferred example's first sandbox, once built, is mounted (its slots taken over, its data
   * projected, what was kept replayed): at once by default; a host may put it in a task of its own
   * (the next idle period), so neither is a long task. Until then what is done there stays kept.
   */
  pace?: (mount: () => void) => void
  /** How long typing pauses before a sandbox is rebuilt, in ms (300). */
  delayMs?: number
  /** Put text on the clipboard (navigator.clipboard by default). */
  copy?: (text: string) => Promise<void> | void
  /** How long a copy request stays (the button says "Copied"), in ms (1500). */
  copiedMs?: number
  /**
   * The full screen an example's own fs:fullscreen may take (none by default: a sandbox does not
   * take the person's screen; what it asserts is shown over the page instead, and Esc leaves it).
   */
  fullscreen?: FullscreenHost | null
  /**
   * How many sandboxes stay built (8). Each holds a store with the whole ontology (about 12 MB of
   * engine memory); past this, those hidden longest are let go, and built again when shown.
   */
  maxMounted?: number
}

interface Mounted {
  iri: string
  /** The site's slot element the sandbox is mounted in. */
  slot: Element
  sandbox?: Sandbox
  /** A sandbox built and waiting to be mounted (SandboxesOptions.pace). */
  pending?: Sandbox
  renderer?: DomRenderer
  textRenderer?: DomRenderer
  /** The data pane's renderer: the sandbox's diff viewer (c:dataPreview). */
  dataRenderer?: DomRenderer
  /** The data's subjects since the sandbox was built: the viewer lists them, so one whose statements all went still shows them, removed. */
  dataSubjects?: Set<string>
  detach?: () => void
  sheet?: CSSStyleSheet
  timer?: ReturnType<typeof setTimeout>
  /** The texts of the build that is mounted, or of the last build tried. */
  key?: string
  languages: string
  builds: number
  /** When it was last seen shown (a count of syncs). */
  shownAt: number
  /** The data the example shows (c:dataPreview) as last found: its triples by key. */
  data?: Map<string, Quad>
  /** Its simulated store (c:storeSource): the store, its editor, and the text the store holds now. */
  store?: { server: SourceServer; editor: string; text: string }
  /** An edit of the store's text waiting for typing to pause. */
  storeTimer?: ReturnType<typeof setTimeout>
  /** What the last build met, and what is wrong with the store's text (shown together). */
  buildProblems?: SandboxProblem[]
  storeProblem?: SandboxProblem
}

let sandboxes = 0

let created: ((s: Sandboxes) => void) | undefined
/**
 * Hear about every Sandboxes made (one listener; undefined stops): test/setup.ts disposes each
 * test's before releasing its stores, so no rebuild waiting for typing to pause outlives them.
 */
export function watchSandboxes(listener: ((s: Sandboxes) => void) | undefined): void {
  created = listener
}

/**
 * Mounts a sandbox in every c:LiveExample that is shown, and keeps it in step with its sources.
 * Call `sync()` after each flush of the site's renderer (it is cheap when nothing was shown or
 * hidden); `attach()` follows edits.
 */
export class Sandboxes {
  private readonly mounted = new Map<string, Mounted>()
  private readonly editorOf = new Map<string, string>()
  private seenVisibility = -1
  private syncs = 0
  private syncing = false
  private detachInput?: () => void
  /** Timers that are not a sandbox's own (withdrawing a copy request). */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private disposed = false
  /** While the host writes what happened to the site's graph (its own removals ask for nothing). */
  private writing = false
  /** While the host writes a store's text back to its editor (it holds that already). */
  private writingStore = false
  /** Builds done, for tests and cost checks. */
  builds = 0
  /** What taking over server-rendered slots found (tests, performance marks): nodes paired, and those patched. */
  readonly adopted = { nodes: 0, mismatches: 0 }

  constructor(
    readonly runtime: Runtime,
    readonly screen: Projection,
    private readonly opts: SandboxesOptions,
  ) {
    // The policy is read from the ontology alone (trustedPolicy), when the first sandbox is built:
    // never from the site's store, which holds what storage restored.
    created?.(this)
  }

  /** Follow the site's input: an edit of a source rebuilds its sandbox (once typing pauses); a copy request copies. */
  attach(): () => void {
    this.detachInput = this.runtime.onInput((graph, delta) => graph === undefined && this.changed(delta))
    return () => this.dispose()
  }

  /** How many sandboxes are built now. */
  get size(): number {
    return this.mounted.size
  }

  /** The sandbox of a live example, if it is mounted. */
  sandboxOf(example: string): Sandbox | undefined {
    return this.mounted.get(example)?.sandbox
  }

  /** The renderer of a mounted sandbox (its DOM), if any. */
  rendererOf(example: string): DomRenderer | undefined {
    return this.mounted.get(example)?.renderer
  }

  /** Mount the sandboxes of the examples shown since the last call, and follow the site's language. */
  sync(): void {
    if (this.syncing || this.disposed) return
    this.syncing = true
    try {
      const languages = this.opts.languages?.() ?? []
      const lang = languages.join(',')
      for (const m of this.mounted.values()) {
        if (m.languages === lang || !m.sandbox) continue
        m.languages = lang
        for (const p of [m.sandbox.screen, m.sandbox.text, m.sandbox.data]) p?.engine.reconfigure({ languages })
        m.renderer?.flush()
        m.textRenderer?.flush()
        m.dataRenderer?.flush()
      }
      const visibility = this.screen.index.visibility
      if (visibility === this.seenVisibility) return
      this.seenVisibility = visibility
      const tick = ++this.syncs
      const store = this.runtime.store
      const f = store.factory
      for (const q of store.match(null, f.namedNode(RDF_TYPE), f.namedNode(LIVE.LiveExample), f.defaultGraph())) {
        const iri = q.subject.value
        const slot = this.opts.renderer.nodeOf(mint(iri, 'screen')) as Element | undefined
        if (!slot || !this.opts.shown(iri)) continue
        const m = this.mounted.get(iri)
        if (m?.slot === slot) {
          m.shownAt = tick
          continue
        }
        if (m) this.unmount(m)
        const fresh: Mounted = { iri, slot, languages: lang, builds: 0, shownAt: tick }
        this.mounted.set(iri, fresh)
        if (this.opts.defer) this.opts.defer(slot, () => !this.disposed && this.mounted.get(iri) === fresh && !fresh.builds && (this.build(fresh, this.opts.pace), this.opts.flush()))
        else this.build(fresh)
      }
      // Too many built: let go of those hidden longest (shown ones stay, however many).
      const max = this.opts.maxMounted ?? 8
      if (this.mounted.size > max) {
        const hidden = [...this.mounted.values()].filter((x) => x.shownAt !== tick).sort((a, b) => a.shownAt - b.shownAt)
        for (const x of hidden.slice(0, this.mounted.size - max)) this.unmount(x)
      }
    } finally {
      this.syncing = false
    }
  }

  /** Rebuild now the sandboxes waiting for typing to pause (tests; a host about to unload). */
  settle(): void {
    for (const m of this.mounted.values()) {
      if (m.timer === undefined) continue
      clearTimeout(m.timer)
      m.timer = undefined
      this.build(m)
    }
  }

  /**
   * Stop: every sandbox's timers are cancelled, its bus and listeners detached and its runtime and
   * store released; a callback that was already on its way does nothing.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.detachInput?.()
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    for (const m of this.mounted.values()) this.unmount(m)
    this.mounted.clear()
    this.editorOf.clear()
  }

  private changed(delta: Delta) {
    for (const q of delta.remove) {
      this.touched(q, q.predicate.value === LIVE.value ? 0 : undefined)
      // Reset withdrew c:interacted: build the example again as written (at once, not after typing pauses).
      if (q.predicate.value === LIVE.interacted && !this.writing) this.rebuild(q.subject.value, 0)
    }
    for (const q of delta.add) {
      this.touched(q)
      if (q.predicate.value === LIVE.copied) void this.copy(q.subject.value, q.object.value)
    }
  }

  /** An editor's text changed: its example is built again, or, for its store's text, the store changes (after `ms`, by default once typing pauses). */
  private touched(q: Quad, ms?: number) {
    const p = q.predicate.value
    if (p !== LIVE.value && p !== LIVE.original) return
    const example = this.editorOf.get(q.subject.value)
    if (!example) return
    const m = this.mounted.get(example)
    if (m?.store?.editor !== q.subject.value) return this.rebuild(example, this.opts.delayMs ?? 300)
    if (this.writingStore) return
    if (m.storeTimer !== undefined) clearTimeout(m.storeTimer)
    m.storeTimer = setTimeout(() => {
      m.storeTimer = undefined
      if (!this.disposed && this.mounted.get(m.iri) === m) this.storeEdited(m)
    }, ms ?? this.opts.delayMs ?? 300)
  }

  /**
   * The store's text was edited: the store becomes what it says, as one change, which reaches the
   * page as a delta (the sandbox is not built again). Text that does not parse leaves the store as it is.
   */
  private storeEdited(m: Mounted) {
    const store = m.store
    const source = this.spec(m.iri).store
    if (!store || !source || source.text === store.text) return
    let quads: Quad[]
    try {
      quads = parseStore(source.text, PREAMBLE)
    } catch (e) {
      m.storeProblem = parseError(e as Error, source)
      this.write(m.iri, { problems: this.problemsOf(m), edited: this.edited(this.sources(m.iri)) })
      return
    }
    store.text = source.text
    m.storeProblem = undefined
    store.server.change(storeDelta(store.server, quads))
    this.write(m.iri, { problems: this.problemsOf(m), edited: this.edited(this.sources(m.iri)) })
  }

  /** The store took a write of the page: its editor shows what it holds now. */
  private storeWritten(m: Mounted, server: SourceServer) {
    const store = m.store
    if (this.disposed || store?.server !== server || m.storeProblem) return
    const text = storeTurtle(server, store.text, { ...NS, ...declared(store.text) })
    if (text === store.text) return
    store.text = text
    const site = this.runtime.store
    const sf = site.factory
    const editor = sf.namedNode(store.editor)
    const value = sf.namedNode(LIVE.value)
    this.writingStore = true
    try {
      this.runtime.apply({ remove: site.match(editor, value, null, sf.defaultGraph()), add: [sf.quad(editor, value, sf.literal(text))] })
    } finally {
      this.writingStore = false
    }
    this.write(m.iri, { edited: true })
    this.opts.flush()
  }

  private problemsOf(m: Mounted): SandboxProblem[] {
    return [...(m.buildProblems ?? []), ...(m.storeProblem ? [m.storeProblem] : [])]
  }

  /** Whether a source differs from its c:original. */
  private edited(sources: SandboxSource[]): boolean {
    const store = this.runtime.store
    const f = store.factory
    return sources.some((s) => {
      const editor = f.namedNode(s.editor!)
      const original = store.match(editor, f.namedNode(LIVE.original), null)[0]?.object.value
      const value = store.match(editor, f.namedNode(LIVE.value), null)[0]?.object.value
      return value !== undefined && value !== original
    })
  }

  /** Build an example again after `ms` (a later request replaces a waiting one); with 0, even if its sources are the same. */
  private rebuild(example: string, ms: number) {
    const m = this.mounted.get(example)
    if (!m) return
    if (m.timer !== undefined) clearTimeout(m.timer)
    if (ms === 0) m.key = undefined
    m.timer = setTimeout(() => {
      m.timer = undefined
      if (!this.disposed && this.mounted.get(m.iri) === m) this.build(m)
    }, ms)
  }

  /** The example as the site's graph describes it (its editors are followed). */
  private spec(example: string): ExampleSpec {
    const spec = exampleSpec(this.runtime.store, example)
    for (const s of spec.sources) this.editorOf.set(s.editor!, example)
    return spec
  }

  /** The example's sources from the site's graph: each editor's text as edited, else as written. */
  private sources(example: string): SandboxSource[] {
    return this.spec(example).sources
  }

  private build(m: Mounted, pace?: (mount: () => void) => void) {
    const spec = this.spec(m.iri)
    const sources = spec.sources
    // The store's text is not the sandbox's: editing it changes the store, not the build.
    const key = JSON.stringify(sources.filter((s) => s !== spec.store).map((s) => s.text))
    const edited = this.edited(sources)
    // The store is made once, from its text, and kept across builds (the page's writes are in it).
    if (spec.store && m.store?.editor !== spec.store.editor) {
      const made = exampleStore(spec.store)
      m.store = { server: made.server, editor: spec.store.editor!, text: spec.store.text }
      m.storeProblem = made.problem
    } else if (!spec.store) (m.store = undefined), (m.storeProblem = undefined)
    if (key === m.key && m.sandbox) {
      // Typed and typed back: the sandbox shows these sources already.
      this.write(m.iri, { edited })
      return
    }
    m.key = key
    this.builds++
    m.builds++
    const t0 = now()
    // A build is a turn of the site's watchdog (no budget of its own there): a hang it causes is blamed on the example.
    const wd = this.runtime.watchdog
    const built = wd.turn(() => {
      const server = m.store?.server
      const written = server && (() => this.storeWritten(m, server))
      const b = buildExample(spec, { ...this.opts, urlBase: this.opts.urlBase ?? this.screen.index.urlBase, languages: this.opts.languages?.(), store: server, written })
      wd.note('rule', LIVE.LiveExample, m.iri, 1, now() - t0)
      return b
    })
    if (built.sandbox && pace && !m.sandbox) {
      // Mounted in a task of its own; let go if the example was rebuilt or let go meanwhile.
      const sandbox = built.sandbox
      const buildMs = now() - t0
      m.pending = sandbox
      pace(() => {
        if (m.pending !== sandbox) return
        m.pending = undefined
        if (this.disposed || this.mounted.get(m.iri) !== m) return sandbox.runtime.dispose()
        const t1 = now()
        this.mount(m, sandbox)
        m.buildProblems = built.problems
        this.write(m.iri, { state: LIVE.Live, problems: this.problemsOf(m), ms: Math.max(0, Math.round(buildMs + now() - t1)), edited, interacted: false })
        this.opts.flush()
      })
      return
    }
    if (m.pending) m.pending.runtime.dispose(), (m.pending = undefined)
    if (built.sandbox) this.mount(m, built.sandbox)
    else if (!m.sandbox) {
      // What the server rendered will not be taken over: what was done there is let go.
      const served = this.served(m)
      if (served) served.removeAttribute(SSR_ATTRIBUTE), replayKept(served, { discard: true })
    }
    const ms = Math.max(0, Math.round(now() - t0))
    const state = built.sandbox ? LIVE.Live : m.sandbox ? LIVE.Stale : LIVE.Broken
    m.buildProblems = built.problems
    this.write(m.iri, { state, problems: this.problemsOf(m), ms: built.sandbox ? ms : undefined, edited, interacted: built.sandbox ? false : undefined })
  }

  /**
   * Put a built sandbox in the slot, in place of the one there (whose bus and styles go with it).
   * The first sandbox of a slot that a server rendered (prerenderSandboxes) takes its elements over
   * instead: its first projection is the server's, so no node is created and nothing flashes.
   */
  private mount(m: Mounted, sandbox: Sandbox) {
    const doc = m.slot.ownerDocument
    const n = ++sandboxes
    const textSlot = sandbox.text && (this.opts.renderer.nodeOf(mint(m.iri, 'text')) as Element | undefined)
    const dataQuery = this.dataQuery(m)
    const dataSlot = dataQuery && (this.opts.renderer.nodeOf(mint(m.iri, 'data')) as Element | undefined)
    // What a server rendered in the slots: the sandbox's element, and the text's and the data's.
    const served = !m.sandbox ? this.served(m) : null
    const servedIn = (slot: Element | undefined | '') => (served && slot && slot.firstElementChild?.localName === 'div' ? slot.firstElementChild : null)
    const taken: Element[] = []
    const hostIn = (own: Element | null) => (own ? (taken.push(own), own) : doc.createElement('div'))
    const host = hostIn(served)
    host.setAttribute(SANDBOX_ATTRIBUTE, String(n))
    const renderer = new DomRenderer(sandbox.screen.index, host, sandbox.root)
    let textRenderer: DomRenderer | undefined
    let textHost: Element | undefined
    if (sandbox.text && textSlot) {
      textHost = hostIn(servedIn(textSlot))
      textRenderer = new DomRenderer(sandbox.text.index, textHost, sandbox.root)
    }
    // The data: a read-only RDF editor in diff mode, in the sandbox, over the data's subjects.
    let dataRenderer: DomRenderer | undefined
    let dataHost: Element | undefined
    const seen = new Set<string>()
    if (dataQuery && dataSlot) {
      const data = projectData(sandbox, dataQuery, this.sources(m.iri), seen, { ...this.opts, urlBase: this.opts.urlBase ?? this.screen.index.urlBase, languages: this.opts.languages?.() })
      dataHost = hostIn(servedIn(dataSlot))
      dataRenderer = new DomRenderer(data.index, dataHost, DATA_VIEWER)
    }
    const flush = () => {
      renderer.flush()
      textRenderer?.flush()
      dataRenderer?.flush()
    }
    // Rendered on the server: adopted as it is (what differs, an edit remembered, is patched).
    for (const r of [renderer, textRenderer, dataRenderer]) {
      if (!r) continue
      if (!taken.includes(r.host)) r.flush()
      else {
        const a = r.adopt()
        this.adopted.nodes += a.nodes
        this.adopted.mismatches += a.mismatches
      }
    }
    const bus = sandbox.bus ?? new EventBus(sandbox.runtime, sandbox.screen, { prefer: this.opts.prefer })
    // What the store changes shows at once.
    sandbox.hooks.changed = flush
    const failed = (e: Error) => this.write(m.iri, { problems: [{ message: e.message, severity: 'error' }] })
    const detachBus = bus.attach(
      renderer,
      (h) => {
        flush()
        if (!h.delta.add.length && !h.delta.remove.length) return
        this.followData(m, sandbox, true)
        this.write(m.iri, { interacted: true })
      },
      failed,
    )
    // What the example asserts full screen is shown over the page (or full screen, if allowed).
    const detachFullscreen = new Fullscreen(bus, {
      element: (iri) => {
        const n = renderer.nodeOf(iri)
        return n?.nodeType === 1 ? (n as Element) : undefined
      },
      document: doc,
      host: this.opts.fullscreen ?? null,
      onHandled: () => flush(),
    }).attach()
    // An interaction over budget: the sandbox stops itself (what it left undone keeps its last
    // rendering) and the problem shows inline.
    const detachStall = sandbox.runtime.watchdog.onStall(() =>
      queueMicrotask(() => {
        if (this.disposed || m.sandbox !== sandbox || !sandbox.runtime.held) return
        const problem = stallProblem(sandbox.runtime, this.sources(m.iri), this.opts.budgetMs ?? 1500)
        sandbox.runtime.stopStall()
        flush()
        this.write(m.iri, { problems: [problem] })
      }),
    )
    const detachRefresh = sandbox.runtime.onRefresh(flush)
    const detachTimer = sandbox.runtime.onTimer(flush)
    const sheet = sandbox.css ? this.sheet(doc, sandbox.css, n) : undefined
    // The new rendering replaces the old in one step (the server's styles go once its own are in).
    this.unmountSandbox(m)
    if (!taken.includes(host)) m.slot.replaceChildren(host)
    else for (const style of [...m.slot.children]) if (style.hasAttribute(SANDBOX_STYLES_ATTRIBUTE)) style.remove()
    const detachPopups = attachAnchoredPopups(host, node => !renderer.inSlot(node))
    const detachSizeHandles = attachSizeHandles(renderer)
    if (textSlot && textHost && !taken.includes(textHost)) textSlot.replaceChildren(textHost)
    if (dataSlot && dataHost && !taken.includes(dataHost)) dataSlot.replaceChildren(dataHost)
    m.sandbox = sandbox
    m.renderer = renderer
    m.textRenderer = textRenderer
    m.dataRenderer = dataRenderer
    m.dataSubjects = seen
    m.sheet = sheet
    this.followData(m, sandbox, false)
    m.detach = () => {
      detachStall()
      detachBus()
      detachFullscreen()
      detachPopups()
      detachSizeHandles()
      detachRefresh()
      detachTimer()
    }
    // What the visitor did in the server's rendering before now happens now, with everything listening.
    if (served) {
      served.removeAttribute(SSR_ATTRIBUTE)
      replayKept(served)
    }
  }

  /** The element a server rendered in the example's slot (prerenderSandboxes), if it is there. */
  private served(m: Mounted): Element | null {
    return [...m.slot.children].find((el) => el.getAttribute(SANDBOX_ATTRIBUTE)?.startsWith('ssr-')) ?? null
  }

  /** The style rules the sandbox adds to the site's, scoped to its own element. */
  private sheet(doc: Document, compiled: string, n: number): CSSStyleSheet | undefined {
    const Sheet = (doc.defaultView as (Window & typeof globalThis) | null)?.CSSStyleSheet
    if (!Sheet || !('adoptedStyleSheets' in doc)) return undefined
    const site = typeof this.opts.siteCss === 'function' ? this.opts.siteCss() : (this.opts.siteCss ?? '')
    const css = scopedCss(compiled, site, boxSelector(String(n)))
    if (!css) return undefined
    const sheet = new Sheet()
    sheet.replaceSync(css)
    adoptSheet(doc, sheet)
    return sheet
  }

  private unmountSandbox(m: Mounted) {
    m.detach?.()
    // The sandbox's runtime and store are its own: release them (Oxigraph's share one WebAssembly memory).
    m.sandbox?.runtime.dispose()
    if (m.sheet) dropSheet(m.slot.ownerDocument, m.sheet)
    m.detach = m.sheet = m.sandbox = m.renderer = m.textRenderer = m.dataRenderer = undefined
  }

  private unmount(m: Mounted) {
    if (m.timer !== undefined) clearTimeout(m.timer)
    if (m.storeTimer !== undefined) clearTimeout(m.storeTimer)
    m.pending?.runtime.dispose()
    m.pending = undefined
    this.unmountSandbox(m)
    this.mounted.delete(m.iri)
  }

  /** Write what a build found to the site's graph (only what changed; what is not given stays), and patch the site. */
  private write(example: string, status: SandboxStatus) {
    const delta = statusDelta(this.runtime.store, example, status)
    if (!delta.add.length && !delta.remove.length) return
    this.writing = true
    try {
      this.runtime.apply(delta)
    } finally {
      this.writing = false
    }
    this.opts.flush()
  }

  /** The example's data query (c:dataPreview), if it has one. */
  private dataQuery(m: Mounted): string | undefined {
    const site = this.runtime.store
    const sf = site.factory
    return site.match(sf.namedNode(m.iri), sf.namedNode(LIVE.dataPreview), null, sf.defaultGraph())[0]?.object.value
  }

  /**
   * The example's data (c:dataPreview) as it is now in its sandbox: its subjects are the diff
   * viewer's entries (and the sources' prefixes are declared for it); after an interaction
   * (`changed`) how many of its triples it added and removed is written to the site's graph.
   */
  private followData(m: Mounted, sandbox: Sandbox, changed: boolean) {
    const query = this.dataQuery(m)
    if (!query) return
    const site = this.runtime.store
    const sf = site.factory
    const sources = this.sources(m.iri)
    const quads = readData(sandbox, query, sources)
    if (!quads) return
    const now = new Map(quads.map((q) => [quadKey(q), q]))
    const before = m.data
    m.data = now
    // The viewer's entries: the data's subjects; the sources' own prefixes, so it writes their names.
    if (sandbox.data) {
      showData(sandbox, quads, (m.dataSubjects ??= new Set()), sources)
      m.dataRenderer?.flush()
    }
    // After a build nothing has happened yet: what was said of the last interaction goes.
    const added = changed && before ? [...now.keys()].filter((k) => !before.has(k)).length : 0
    const removed = changed && before ? [...before.keys()].filter((k) => !now.has(k)).length : 0
    if (changed && !added && !removed) return
    const s = sf.namedNode(m.iri)
    const nn = (iri: string) => sf.namedNode(iri)
    const integer = (n: number) => sf.literal(String(n), nn(XSD_INTEGER))
    const desired: Quad[] = changed ? [sf.quad(s, nn(LIVE.triplesAdded), integer(added)), sf.quad(s, nn(LIVE.triplesRemoved), integer(removed))] : []
    // The arrows point at the viewer's first row marked added (else removed): its label, by its id.
    const host = changed ? m.dataRenderer?.host : undefined
    const row = host?.querySelector('[data-sem-change=added] > .sem-row > .sem-label[id]') ?? host?.querySelector('[data-sem-change=removed] > .sem-row > .sem-label[id]')
    if (row) desired.push(sf.quad(s, nn(LIVE.changedRow), nn(row.id)))
    const dg = sf.defaultGraph()
    const current = [LIVE.triplesAdded, LIVE.triplesRemoved, LIVE.changedRow].flatMap((p) => site.match(s, nn(p), null, dg))
    const keys = new Set(desired.map(quadKey))
    const had = new Set(current.map(quadKey))
    const delta: Delta = { remove: current.filter((q) => !keys.has(quadKey(q))), add: desired.filter((q) => !had.has(quadKey(q))) }
    if (!delta.add.length && !delta.remove.length) return
    this.runtime.apply(delta)
    this.opts.flush()
  }

  /** Carry out a copy request: the source shown, with the prefixes it uses; then withdraw the request. */
  private async copy(example: string, editor: string) {
    const source = this.sources(example).find((s) => s.editor === editor)
    if (source) {
      const write = this.opts.copy ?? ((t: string) => globalThis.navigator?.clipboard?.writeText(t))
      try {
        await write(completeSource(source.text))
      } catch (e) {
        console.warn('[semblance] could not copy', e)
      }
    }
    if (this.disposed) return
    const t = setTimeout(() => {
      this.timers.delete(t)
      if (this.disposed) return
      const f = this.runtime.store.factory
      const requests = this.runtime.store.match(f.namedNode(example), f.namedNode(LIVE.copied), null, f.defaultGraph())
      if (!requests.length) return
      this.runtime.apply({ remove: requests, add: [] })
      this.opts.flush()
    }, this.opts.copiedMs ?? 1500)
    this.timers.add(t)
  }
}

// Scoping a sandbox's styles is the scoping of every authored box (src/style/scope.ts).
export { scopedCss }
