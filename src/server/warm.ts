// A warm runtime for per-request rendering (#383, docs/SSR.md): rather than a fresh store and a
// first projection for every request, one runtime per isolate (per language: the projection's
// languages are fixed when it is made) is loaded and projected once, then moved to each request's
// address. A move is one change: back from what the last address read into the graph, then what
// this one reads (as the client's navigation reads it before its first projection), so the page is
// the page a fresh store renders at that address (test/warm.test.ts checks it, address by address).
// Platform-neutral: the caller loads the store (Node, Deno, Cloudflare Workers).
import type { Quad } from '@rdfjs/types'
import { compose, overlay, readLocations, type Reader } from '../navigation.ts'
import type { Delta } from '../rdf.ts'
import type { Projection, Runtime } from '../runtime.ts'
import type { GraphStore } from '../store/types.ts'
import { rememberedPolicies } from './remembered.ts'
import { addressStatus, authoredBox, documentLanguage, project, readerLanguages, type Rendered, type RenderOptions, serializeRoot, storeReader, urlDelta } from './render.ts'

export interface WarmOptions extends Omit<RenderOptions, 'store' | 'url' | 'layers'> {
  /** A fresh store with the ontology (or the app's subset of it) and the app's graphs: called once per language. */
  load(): GraphStore | Promise<GraphStore>
  /** The layers to enable, or how to read them from the loaded store (Site.layers). */
  layers?: Iterable<string> | ((store: GraphStore) => Iterable<string>)
  /** What to set on <html> besides lang and dir, read from the graph at the address (Site.documentAttributes). */
  attributes?(store: GraphStore): Record<string, string>
}

export type WarmRendered = Omit<Rendered, 'runtime' | 'projection'> & { attributes: Record<string, string> }

export interface WarmRenderer {
  /** Render the root at an address, as renderToString from a fresh store does. Requests run one at a time. */
  render(url: string): Promise<WarmRendered>
  /** How many renders loaded a store (cold) and how many moved a loaded one (warm). */
  readonly stats: { cold: number; warm: number }
  /** Let go of every runtime and store. */
  dispose(): void
}

interface Warm {
  store: GraphStore
  runtime: Runtime
  projection: Projection
  languages: string[]
  /** What the addresses read into the graph since it was loaded: undone before the next one is read. */
  applied: Delta
  css?: string
}

const key = (q: Quad) => `${q.subject.termType}:${q.subject.value} ${q.predicate.value} ${q.object.termType}:${q.object.value}${q.object.termType === 'Literal' ? '@' + q.object.language + '^' + q.object.datatype.value : ''}`

/** The change that undoes `d`. */
const inverse = (d: Delta): Delta => ({ add: d.remove, remove: d.add })

/** `d` without what cancels out (a quad removed and added again). */
function net(d: Delta): Delta {
  const added = new Set(d.add.map(key))
  const removed = new Set(d.remove.map(key))
  return { add: d.add.filter((q) => !removed.has(key(q))), remove: d.remove.filter((q) => !added.has(key(q))) }
}

/** Render a site's addresses from runtimes loaded once and moved to each request's address. */
export function warmRenderer(opts: WarmOptions): WarmRenderer {
  const warm = new Map<string, Warm>()
  const stats = { cold: 0, warm: 0 }
  // The live examples' renderings: their sources do not change on a server, so each is built once.
  const sandboxes = opts.sandboxes && { ...opts.sandboxes, cache: opts.sandboxes.cache ?? new Map<string, Map<string, string>>() }
  let queue: Promise<unknown> = Promise.resolve()

  // A fresh runtime at `url`, as renderToString makes one, keeping what the address changed.
  const cold = async (url: string): Promise<Warm> => {
    const store = await opts.load()
    const r = storeReader(store)
    const { delta } = urlDelta(r, opts.root, url)
    for (const q of delta.remove) store.delete(q)
    for (const q of delta.add) store.add(store.factory.quad(q.subject, q.predicate, q.object, store.factory.defaultGraph()))
    opts.prepare?.(store)
    const languages = opts.languages ?? readerLanguages(r, opts.root)
    const layers = typeof opts.layers === 'function' ? opts.layers(store) : opts.layers
    const { runtime, projection, css } = project({ ...opts, layers, store }, languages)
    stats.cold++
    return { store, runtime, projection, languages, applied: delta, css }
  }

  const page = (w: Warm, url: string): WarmRendered => {
    const r = storeReader(w.store)
    const loc = readLocations(r).find((l) => l.root === opts.root)
    const { found, address } = addressStatus(r, loc, url)
    const html = serializeRoot(w.runtime, w.projection, opts.root, { ...opts, sandboxes, shownOnly: true })
    return { html, css: w.css, status: found ? 200 : 404, address, remembered: rememberedPolicies(w.store, opts.root), attributes: opts.attributes?.(w.store) ?? {}, ...documentLanguage(w.store, w.languages[0] ?? 'en'), ...(authoredBox(opts) && { box: authoredBox(opts) }) }
  }

  const render = async (url: string) => {
    // Any loaded runtime reads what the address changes from the graph as loaded (its moves undone).
    const some = warm.values().next().value as Warm | undefined
    if (some) {
      const base: Reader = overlay(storeReader(some.store), inverse(some.applied))
      const { delta } = urlDelta(base, opts.root, url)
      const languages = opts.languages ?? readerLanguages(overlay(base, delta), opts.root)
      const w = warm.get(languages.join(' '))
      if (w) {
        // From where it is to where the address says: one change, so the rules run once.
        const move = net(compose(inverse(w.applied), delta))
        if (move.add.length || move.remove.length) w.runtime.apply(move)
        w.applied = delta
        stats.warm++
        return page(w, url)
      }
    }
    const w = await cold(url)
    warm.set(w.languages.join(' '), w)
    return page(w, url)
  }

  return {
    stats,
    render(url) {
      const next = queue.then(() => render(url))
      // A failed render leaves its runtime where it may be wrong: the next request loads afresh.
      queue = next.catch(() => {
        for (const w of warm.values()) w.runtime.dispose(), w.store.dispose?.()
        warm.clear()
      })
      return next
    },
    dispose() {
      for (const w of warm.values()) w.runtime.dispose(), w.store.dispose?.()
      warm.clear()
    },
  }
}
