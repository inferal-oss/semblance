// Which pages of this browser are open (docs/RETENTION.md §8.10). A sweep of stored keys must leave
// what a page that is still open uses: another tab of the app, maybe of another version. Each page
// marks itself open, under a name of its owner's (a prefix) and its run, for as long as it lives;
// a page about to remove what another page wrote reads the marks first. In a browser the marks are
// Web Locks (navigator.locks): a lock is held while its page lives, released by the browser when the
// page goes (closed, crashed or navigated away), and navigator.locks.query() lists every page's of
// the origin.

/** The marks of open pages. */
export interface OpenPages {
  /** Mark this page open under `name` until the returned function is called. */
  open(name: string): () => void
  /** The names open pages are marked under (this page's too) that start with `prefix`. */
  marked(prefix: string): Promise<string[]>
}

interface LockLike {
  name?: string
}
interface Locks {
  request(name: string, options: { mode: 'shared' | 'exclusive' }, callback: () => Promise<void>): Promise<unknown>
  query(): Promise<{ held?: LockLike[]; pending?: LockLike[] }>
}

/** Open pages as Web Locks (every current browser); undefined where there are none. */
export function webLockPages(locks: Locks | undefined = (globalThis.navigator as { locks?: Locks } | undefined)?.locks): OpenPages | undefined {
  if (typeof locks?.request !== 'function' || typeof locks.query !== 'function') return undefined
  return {
    open(name) {
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      // Shared: a name is a page's own, and a mark never waits for another.
      void locks.request(name, { mode: 'shared' }, () => held).catch(() => {})
      return release
    },
    async marked(prefix) {
      const state = await locks.query()
      // A mark asked for and not yet granted is a page that is open too.
      const names = [...(state.held ?? []), ...(state.pending ?? [])].map((l) => l.name ?? '')
      return [...new Set(names.filter((n) => n.startsWith(prefix)))]
    },
  }
}

/** Open pages in memory: one for a whole "browser" of a test, shared by the runtimes that are its tabs. */
export function memoryPages(): OpenPages & { readonly names: Map<string, number> } {
  const names = new Map<string, number>()
  return {
    names,
    open(name) {
      names.set(name, (names.get(name) ?? 0) + 1)
      let done = false
      return () => {
        if (done) return
        done = true
        const n = (names.get(name) ?? 1) - 1
        if (n) names.set(name, n)
        else names.delete(name)
      }
    },
    marked: async (prefix) => [...names.keys()].filter((n) => n.startsWith(prefix)),
  }
}

/** The open pages of a runtime by default: Web Locks in a page (a document), none elsewhere (a server, a test). */
export function defaultPages(): OpenPages | undefined {
  return typeof document === 'undefined' ? undefined : webLockPages()
}

/** A run's name (base 36: when it started, in ms, then four random characters): when it started, if it says. */
export function runStartedAt(run: string): number | undefined {
  if (!/^[0-9a-z]{9,}$/.test(run)) return undefined
  const t = parseInt(run.slice(0, -4), 36)
  return Number.isFinite(t) ? t : undefined
}

/** A new run's name: when it started and four random characters. */
export function newRun(now = Date.now()): string {
  return now.toString(36) + Math.random().toString(36).slice(2, 6).padEnd(4, '0')
}
