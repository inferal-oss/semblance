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

/** What a choice's option would show: the sem:IntentPreview queries' ?content, cached per control and option. */
function previewsOf(runtime: Runtime, key: string, seen: Map<string, string[]>): string[] {
  const store = runtime.store
  const f = store.factory
  const option = store.match(f.namedNode(key), f.namedNode(C.selects), null)[0]?.object
  if (!option || !store.sparql) return []
  const control = owningFocus(key)
  const cacheKey = control + ' ' + option.value
  const hit = seen.get(cacheKey)
  if (hit) return hit
  const prefixes = prefixesFor(store)
  const out = new Set<string>()
  for (const { subject: preview } of store.match(null, f.namedNode(RDF_TYPE), f.namedNode(SEM.IntentPreview))) {
    const query = store.match(preview, f.namedNode(SEM.select), null)[0]?.object.value
    if (!query) continue
    const bound = query.replaceAll('$control', `<${control}>`).replaceAll('$option', `<${option.value}>`)
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
    for (let el = e.target as Node | null; el && el !== renderer.host; el = el.parentNode) {
      const k = renderer.keyOf(el)
      if (k && store.match(f.namedNode(k), f.namedNode(C.selects), null).length) {
        key = k
        break
      }
    }
    if (!key || key === current) return
    current = key
    const contents = previewsOf(runtime, key, seen)
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

/**
 * Prepare in idle time what the options of every choice that says sem:anticipates would show, an
 * option at a time, as pointing at each would (its content where its warmth allows: sem:OnIntent,
 * sem:Eager): a first click shows a page evaluated ahead - and so does a tap, which no pointing comes
 * before. Call it once the page is quiet (its graphs in). Returns a function that stops it.
 */
export function anticipate(runtime: Runtime, opts: IntentOptions = {}): () => void {
  const store = runtime.store
  const f = store.factory
  const idle = opts.idle ?? defaultIdle
  const controls = new Set(store.match(null, f.namedNode(SEM.anticipates), null).filter((q) => q.object.value === 'true').map((q) => q.subject.value))
  const seen = new Map<string, string[]>()
  const queue: Set<string>[] = []
  for (const q of store.match(null, f.namedNode(C.selects), null)) {
    if (q.subject.termType !== 'NamedNode' || !controls.has(owningFocus(q.subject.value))) continue
    const contents = previewsOf(runtime, q.subject.value, seen)
    if (contents.length && !queue.some((c) => contents.every((x) => c.has(x)))) queue.push(new Set(contents))
  }
  let stopped = false
  const slice = (budgetMs: number) => {
    if (stopped || !queue.length) return
    if (!runtime.preload(queue[0]!, budgetMs, { anticipated: true })) queue.shift()
    opts.flush?.()
    if (queue.length) idle(slice)
  }
  if (queue.length) idle(slice)
  return () => void (stopped = true)
}
