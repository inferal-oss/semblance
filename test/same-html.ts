import { expect } from 'vitest'

/** Two renderings, compared where they first differ (so a failure shows the difference, not two long prefixes). */
export function sameHtml(a: string, b: string, what: string) {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  expect(a.slice(Math.max(0, i - 300), i + 300), what).toBe(b.slice(Math.max(0, i - 300), i + 300))
}
