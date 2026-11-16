// Intent preloading (sem:OnIntent, sem:IntentPreview in ontology/core.ttl): when
// the person points at or focuses a choice - a navigation item, a tab - the
// component it would show is evaluated (and its DOM built, hidden) ahead of the
// click. What a choice would show is graph data: the sem:IntentPreview queries.
import { whenIdle } from './idle.ts'
import { C, RDF_TYPE, SEM } from './ns.ts'
import { prefixesFor } from './prefixes.ts'
import { owningFocus } from './rdf.ts'
import type { DomRenderer } from './render/dom.ts'
import type { Runtime } from './runtime.ts'

export interface IntentOptions {
  /** How to get idle time (defaults to whenIdle, src/idle.ts). */
  idle?: (run: (budgetMs: number) => void) => void
  /** Called after each slice, to build what was evaluated (e.g. renderer.flush). */
  flush?: () => void
}

type Idle = (run: (budgetMs: number) => void) => void
const defaultIdle: Idle = (run) => whenIdle((d) => run(Math.max(4, d.timeRemaining() - 2)), 200)

/**
 * What a control would show: the sem:IntentPreview queries' ?content, cached per control and option.
 * With an option (what a pointed element c:selects), the previews of a choice; without one, those
 * that do not read $option: what a control with no options opens (sem:OpenPreview).
 */
function previewsFor(runtime: Runtime, control: string, option: string | undefined, seen: Map<string, string[]>): string[] {
  const store = runtime.store
  const f = store.factory
  if (!store.sparql) return []
  const cacheKey = option === undefined ? control : control + ' ' + option
  const hit = seen.get(cacheKey)
  if (hit) return hit
  const prefixes = prefixesFor(store)
  const out = new Set<string>()
  for (const { subject: preview } of store.match(null, f.namedNode(RDF_TYPE), f.namedNode(SEM.IntentPreview))) {
    const query = store.match(preview, f.namedNode(SEM.select), null)[0]?.object.value
    if (!query || query.includes('$option') !== (option !== undefined)) continue
    let bound = query.replaceAll('$control', `<${control}>`)
    if (option !== undefined) bound = bound.replaceAll('$option', `<${option}>`)
    try {
      for (const row of store.select(prefixes + '\n' + bound, [f.defaultGraph()])) {
        const content = row.get('content')
        if (content?.termType === 'NamedNode') out.add(content.value)
      }
    } catch {}
  }
  seen.set(cacheKey, [...out])
  return [...out]
}

/** What a choice's option would show, by the rendered element that c:selects it. */
function previewsOf(runtime: Runtime, key: string, seen: Map<string, string[]>): string[] {
  const store = runtime.store
  const f = store.factory
  const option = store.match(f.namedNode(key), f.namedNode(C.selects), null)[0]?.object
  if (!option) return []
  return previewsFor(runtime, owningFocus(key), option.value, seen)
}

/** Follow pointing and focusing in `renderer`'s DOM; preload what choices would show. */
export function attachIntent(runtime: Runtime, renderer: DomRenderer, opts: IntentOptions = {}): () => void {
  const store = runtime.store
  const f = store.factory
  const idle = opts.idle ?? defaultIdle
  const seen = new Map<string, string[]>()
  let current = ''
  let pending: Set<string> | undefined

  function intend(e: Event) {
    let key: string | undefined
    let innermost: string | undefined
    for (let el = e.target as Node | null; el && el !== renderer.host; el = el.parentNode) {
      const k = renderer.keyOf(el)
      if (k && !innermost) innermost = k
      if (k && store.match(f.namedNode(k), f.namedNode(C.selects), null).length) {
        key = k
        break
      }
    }
    // An option of a choice; else the control the innermost element belongs to (a toggle that opens a window).
    const control = key ? undefined : innermost && owningFocus(innermost)
    const intent = key ?? control
    if (!intent || intent === current) return
    current = intent
    const contents = key ? previewsOf(runtime, key, seen) : previewsFor(runtime, control!, undefined, seen)
    if (!contents.length) return
    const start = !pending
    pending = new Set(contents)
    if (start) idle(slice)
  }

  function slice(budgetMs: number) {
    const contents = pending
    if (!contents) return
    const more = runtime.preload(contents, budgetMs)
    opts.flush?.()
    if (more && pending === contents) idle(slice)
    else if (pending !== contents) idle(slice)
    else pending = undefined
  }

  renderer.host.addEventListener('pointerover', intend)
  renderer.host.addEventListener('focusin', intend)
  return () => {
    renderer.host.removeEventListener('pointerover', intend)
    renderer.host.removeEventListener('focusin', intend)
  }
}

/** The options a control shows, by what each c:selects, in the order it shows them (its rendered order). */
function optionsInOrder(runtime: Runtime, control: string): { value: string; key: string }[] {
  const store = runtime.store
  const f = store.factory
  const byKey = new Map<string, string>()
  for (const q of store.match(null, f.namedNode(C.selects), null)) {
    if (q.subject.termType === 'NamedNode' && q.object.termType === 'NamedNode' && owningFocus(q.subject.value) === control) byKey.set(q.subject.value, q.object.value)
  }
  if (!byKey.size) return []
  const out: { value: string; key: string }[] = []
  const values = new Set<string>()
  const index = runtime.projections[0]?.index
  const root = index?.rootOf(control)
  // A walk of what the control renders: its options where it shows them (a list and its compact
  // picker show the same values: the first place counts).
  if (index && root) {
    const seen = new Set<string>()
    const walk = (key: string) => {
      if (seen.has(key) || seen.size > 4096) return
      seen.add(key)
      const value = byKey.get(key)
      if (value !== undefined && !values.has(value)) values.add(value), out.push({ value, key })
      for (const slot of index.childrenOf(key)) {
        const r = index.resolve(slot)
        if (r) walk(r)
      }
    }
    walk(root)
  }
  // (What the walk did not reach, in no particular order, after it.)
  for (const [key, value] of byKey) if (!values.has(value)) values.add(value), out.push({ value, key })
  return out
}

/** What a control has chosen: c:property of what it c:controls, else its own c:selected. */
function chosenBy(runtime: Runtime, control: string): string | undefined {
  const store = runtime.store
  const f = store.factory
  const target = store.match(f.namedNode(control), f.namedNode(C.controls), null)[0]?.object
  const property = store.match(f.namedNode(control), f.namedNode(C.property), null)[0]?.object
  if (target?.termType === 'NamedNode' && property?.termType === 'NamedNode') return store.match(target, property, null)[0]?.object.value
  return store.match(f.namedNode(control), f.namedNode(C.selected), null)[0]?.object.value
}

/**
 * Prepare in idle time what the options of the choices that anticipate would show, an option at a
 * time, as pointing at each would (its content where its warmth allows: sem:OnIntent, sem:Eager): a
 * first click shows a page evaluated ahead - and so does a tap, which no pointing comes before.
 * sem:anticipates prepares every option, and keeps it; sem:anticipatesNear the options near the
 * chosen one, while the choice is shown, following it. Options are prepared by their distance from
 * what their choice has chosen, nearest first, across choices (#436). A control with no options (a
 * toggle that opens a window) prepares what it opens (sem:OpenPreview), one step away (#434); a choice
 * that follows its choice is planned again when it is shown or hidden. Call it once the page is quiet
 * (its graphs in). Returns a function that stops it.
 */
export function anticipate(runtime: Runtime, opts: IntentOptions = {}): () => void {
  const store = runtime.store
  const f = store.factory
  const idle = opts.idle ?? defaultIdle
  const seen = new Map<string, string[]>()
  /** Each anticipating control's reach: Infinity for sem:anticipates true. */
  const reach = new Map<string, number>()
  for (const q of store.match(null, f.namedNode(SEM.anticipates), null)) if (q.object.value === 'true') reach.set(q.subject.value, Infinity)
  for (const q of store.match(null, f.namedNode(SEM.anticipatesNear), null)) {
    const n = Number(q.object.value)
    if (Number.isFinite(n) && n >= 0 && !reach.has(q.subject.value)) reach.set(q.subject.value, n)
  }
  // What each control's choice is written as (the target's property): a change to it plans again.
  const watched = new Set<string>()
  for (const control of reach.keys()) {
    const target = store.match(f.namedNode(control), f.namedNode(C.controls), null)[0]?.object.value
    const property = store.match(f.namedNode(control), f.namedNode(C.property), null)[0]?.object.value
    watched.add(target && property ? target + ' ' + property : control + ' ' + C.selected)
  }
  let queue: { contents: Set<string>; owner: string }[] = []
  /** Whether each choice that follows its choice was shown when last planned. */
  const shownWhenPlanned = new Map<string, boolean>()
  const plan = () => {
    const ranked: { rank: number; at: number; contents: Set<string>; owner: string }[] = []
    let at = 0
    for (const [control, n] of reach) {
      const near = Number.isFinite(n)
      // (Only while the choice is shown, for one that follows it.)
      const hidden = near && !runtime.shows(control)
      if (near) shownWhenPlanned.set(control, !hidden)
      const options = hidden ? [] : optionsInOrder(runtime, control)
      const chosen = chosenBy(runtime, control)
      const here = options.findIndex((o) => o.value === chosen)
      const kept = new Set<string>()
      options.forEach((o, i) => {
        const d = here < 0 ? i + 1 : Math.abs(i - here)
        if (d > n) return
        const contents = previewsOf(runtime, o.key, seen)
        for (const c of contents) kept.add(c)
        // At each distance the next before the previous; then the order the choices were found in.
        if (contents.length) ranked.push({ rank: 2 * d + (i < here ? 1 : 0), at: at++, contents: new Set(contents), owner: near ? control : '' })
      })
      // A control with no options (a toggle that opens a window): what it opens, one step away.
      if (!options.length && n >= 1 && !hidden) {
        const contents = previewsFor(runtime, control, undefined, seen)
        for (const c of contents) kept.add(c)
        if (contents.length) ranked.push({ rank: 2, at: at++, contents: new Set(contents), owner: near ? control : '' })
      }
      // Not kept beyond its reach (what is still near stays kept: its views are not suspended).
      if (near) runtime.forgetAnticipated(control, kept)
    }
    ranked.sort((a, b) => a.rank - b.rank || a.at - b.at)
    queue = []
    for (const r of ranked) if (!queue.some((c) => c.owner === r.owner && [...r.contents].every((x) => c.contents.has(x)))) queue.push(r)
  }
  let stopped = false
  let running = false
  const slice = (budgetMs: number) => {
    running = false
    if (stopped || !queue.length) return
    const next = queue[0]!
    if (!runtime.preload(next.contents, budgetMs, { anticipated: next.owner || true }) && queue[0] === next) queue.shift()
    opts.flush?.()
    schedule()
  }
  const schedule = () => {
    if (!running && !stopped && queue.length) (running = true), idle(slice)
  }
  /** A replanning asked for, once what changed is rendered: whether a choice changed, else only a check of what is shown. */
  let replanning: 'chose' | 'check' | undefined
  const off = runtime.onInput((graph, delta) => {
    if (replanning === 'chose' || stopped) return
    const chose = [...delta.add, ...delta.remove].some((q) => watched.has(q.subject.value + ' ' + q.predicate.value))
    // A change of the app's state may show or hide a choice that follows its choice (a window that
    // holds tabs opens): asked once it is rendered, for those few choices.
    if (!chose && (replanning || graph !== undefined || !shownWhenPlanned.size)) return
    const asked = replanning
    replanning = chose ? 'chose' : 'check'
    if (asked) return
    // Once the change is rendered (its options and what is shown follow it).
    idle(() => {
      const why = replanning
      replanning = undefined
      if (stopped) return
      if (why === 'check' && ![...shownWhenPlanned].some(([control, shown]) => runtime.shows(control) !== shown)) return
      plan()
      schedule()
    })
  })
  plan()
  schedule()
  return () => {
    stopped = true
    off()
  }
}
