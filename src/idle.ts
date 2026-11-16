// Idle time for work the page does ahead (warming, intent and anticipation, graph slices).
// requestIdleCallback where there is one; Safari has none, and a timeout that offered a few
// milliseconds every few dozen gave it a sixth of the time Chromium gets, so sections it was to
// prepare ahead were still unprepared half a minute later (#379).

/** What an idle period offers: the time left in it. */
export interface IdleDeadline {
  timeRemaining(): number
}

/** The longest idle period requestIdleCallback gives (no frame due); the fallback's period. */
const PERIOD_MS = 50

/** Run `cb` in idle time: requestIdleCallback (at the latest after `timeout`), else at once after a
 * timeout, with a period's time to use, as requestIdleCallback offers when nothing else is due. */
export function whenIdle(cb: (deadline: IdleDeadline) => void, timeout = 1000): void {
  if ('requestIdleCallback' in globalThis) return void requestIdleCallback(cb, { timeout })
  setTimeout(() => {
    const end = performance.now() + PERIOD_MS
    cb({ timeRemaining: () => Math.max(0, end - performance.now()) })
  }, 1)
}
