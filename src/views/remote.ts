// Views over data that lives elsewhere (docs/VIEWS.md, docs/REMOTE.md's protocol): follow a store's
// stream into a Views, read-only. The snapshot replaces what the Views holds of the patterns, each
// delta is one change, and a broken stream resumes from the last cursor. A change from the store
// costs what it changes in the views, however large the store is. A mounted app uses the
// remote-sources effect (src/remote.ts) instead, which also writes back and keeps its state as triples.
import type { Delta } from '../rdf.ts'
import { type DeltaMessage, heldOf, type Pattern, type Snapshot, statementsOf } from '../source-protocol.ts'
import { quadKey } from '../rdf.ts'
import type { SourceTransport } from '../remote.ts'
import type { Views } from './views.ts'

export interface FollowOptions {
  /** The part of the store to follow (docs/REMOTE.md: triple patterns, or a class's instances). */
  patterns: Pattern[]
  /** The named graph its statements land in (one of the Views' graphs); default: the default graph. */
  graph?: string
  /** Waits between attempts to reach the store: doubling from minMs up to maxMs (default 500, 10000). */
  backoff?: { minMs?: number; maxMs?: number }
  /** Hear every message taken in: the change it made (a snapshot's, a delta's). */
  onChange?: (event: 'snapshot' | 'delta', change: Delta, cursor: number) => void
  /** Hear the stream break (it is opened again after the backoff). */
  onError?: (error: unknown) => void
}

/** A followed source (followSource): its cursor, whether it is live, and how to stop. */
export interface Followed {
  /** The store's cursor of the last message taken in (undefined before the snapshot). */
  readonly cursor: number | undefined
  /** Whether the stream is open and has delivered its snapshot. */
  readonly live: boolean
  /** Resolves when the first snapshot has been taken in. */
  readonly ready: Promise<void>
  /** Stop following: the views keep what they hold. */
  stop(): void
}

/**
 * Follow a store's stream (a SourceTransport: httpTransport(endpoint), or one in-process) into
 * `views`: the snapshot as one change (what the views held of the patterns and the store no longer
 * has goes), then each delta as one change, in cursor order.
 */
export function followSource(views: Views, transport: SourceTransport, opts: FollowOptions): Followed {
  const controller = new AbortController()
  const f = views.store.factory
  const graph = opts.graph === undefined ? f.defaultGraph() : f.namedNode(opts.graph)
  let cursor: number | undefined
  let live = false
  let attempts = 0
  let stopped = false
  let resolveReady!: () => void
  const ready = new Promise<void>((r) => (resolveReady = r))
  const change = (d: Delta) => (opts.graph === undefined ? views.apply(d) : views.write(opts.graph, d))

  const received = (event: string, data: unknown) => {
    if (stopped) return
    if (event === 'snapshot') {
      const snap = data as Snapshot
      const add = statementsOf(snap.add, f)
      const keep = new Set(add.map(quadKey))
      const remove = heldOf(views.store, opts.patterns, graph).filter((q) => !keep.has(quadKey(q)))
      const applied = change({ add, remove })
      cursor = snap.cursor
      live = true
      attempts = 0
      opts.onChange?.('snapshot', applied, snap.cursor)
      resolveReady()
    } else if (event === 'delta') {
      const d = data as DeltaMessage
      const applied = change({ add: statementsOf(d.add, f), remove: statementsOf(d.remove, f) })
      cursor = d.cursor
      opts.onChange?.('delta', applied, d.cursor)
    } else if (event === 'cursor') cursor = (data as { cursor: number }).cursor
  }

  const delay = (attempt: number) => {
    const min = opts.backoff?.minMs ?? 500
    const max = opts.backoff?.maxMs ?? 10_000
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.min(min * 2 ** Math.max(0, attempt - 1), max))
      controller.signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
    })
  }

  void (async () => {
    while (!stopped) {
      try {
        await transport.follow(opts.patterns, cursor, received, controller.signal)
        throw new Error('the stream ended')
      } catch (e) {
        if (stopped) return
        live = false
        attempts++
        opts.onError?.(e)
        await delay(attempts)
      }
    }
  })()

  return {
    get cursor() {
      return cursor
    },
    get live() {
      return live
    },
    ready,
    stop() {
      stopped = true
      live = false
      controller.abort()
    },
  }
}
