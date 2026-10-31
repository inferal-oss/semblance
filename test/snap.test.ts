import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachSnaps, type SnapHost } from '../src/web/snap.ts'

const effects: SnapHost[] = []
afterEach(() => {
  for (const effect of effects.splice(0)) effect.dispose()
  vi.useRealTimers()
})

// Controlled geometry and browser event ordering around the actual host effect.
// In particular, scrollend can arrive before a pending render animation frame.
function fixture({ fallback = false } = {}) {
  type Item = {
    id: number
    hasAttribute(name: string): boolean
    getClientRects(): object[]
    getBoundingClientRect(): { left: number; width: number }
    dispatchEvent(event: { type: string }): void
  }
  const listeners = new Map<string, (event: unknown) => void>()
  const frames = new Map<number, () => void>()
  const events: { type: string; image: number }[] = []
  let nextFrame = 1, observed: (() => void) | undefined, zoomed = false
  const win = {
    CustomEvent: class { constructor(public type: string) {} },
    MutationObserver: class {
      constructor(callback: () => void) { observed = callback }
      observe() {}
      disconnect() { observed = undefined }
    },
    requestAnimationFrame(callback: () => void) { const id = nextFrame++; frames.set(id, callback); return id },
    cancelAnimationFrame(id: number) { frames.delete(id) },
    matchMedia() { return { matches: false } },
    addEventListener() {}, removeEventListener() {},
  }
  if (!fallback) Object.assign(win, { onscrollend: null })
  const track = {
    children: [] as Item[], scrollLeft: 0, current: null as Item | null,
    querySelector() { return this.current },
    closest(selector: string) { return selector === '[data-zoomed]' && zoomed ? {} : null },
    hasAttribute(name: string) { return name === 'data-sem-snap' },
    getClientRects() { return [{}] },
    getBoundingClientRect() { return { left: 0, width: 100 } },
    scrollBy({ left }: { left: number }) { this.scrollLeft += left },
  }
  const images: Item[] = [1, 2, 3].map(id => ({
    id,
    hasAttribute() { return track.current === this },
    getClientRects() { return [{}] },
    getBoundingClientRect() { return { left: track.children.indexOf(this) * 100 - track.scrollLeft, width: 100 } },
    dispatchEvent(event: { type: string }) { events.push({ type: event.type, image: this.id }) },
  }))
  const host = {
    ownerDocument: { defaultView: win },
    querySelectorAll() { return [track] },
    addEventListener(name: string, callback: (event: unknown) => void) { listeners.set(name, callback) },
    removeEventListener(name: string) { listeners.delete(name) },
  }
  const effect = attachSnaps(host as unknown as HTMLElement)
  effects.push(effect)
  const render = (ids: number[], current: number, scrollLeft: number, zoom = false) => {
    track.children = ids.map(id => images[id - 1])
    track.current = images[current - 1]
    track.scrollLeft = scrollLeft
    zoomed = zoom
    observed?.()
  }
  const tick = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback() } }
  const scroll = (type: string) => listeners.get(type)?.({ type, target: track })
  return { effect, track, events, render, tick, scroll, frames }
}

describe('snap host effect', () => {
  it('keeps the graph-selected last image when stale scrollend precedes a re-keyed track update', () => {
    const f = fixture()
    f.render([1, 2, 3], 2, 100)
    f.tick()
    f.render([2, 3], 3, 0)
    f.scroll('scrollend')
    expect(f.events).toEqual([])
    expect(f.track.scrollLeft).toBe(100)
    f.tick()
    expect(f.events).toEqual([])
  })

  it('reports a reader swipe on an unchanged track', () => {
    const f = fixture()
    f.render([1, 2, 3], 1, 0)
    f.tick()
    f.track.scrollLeft = 100
    f.scroll('scrollend')
    expect(f.events).toEqual([{ type: 'sem-snap', image: 2 }])
  })

  it('positions the graph-selected frame before accepting a scroll when leaving zoom', () => {
    const f = fixture()
    f.render([3], 3, 0, true)
    f.tick()
    f.render([2, 3], 3, 0)
    f.scroll('scrollend')
    expect(f.events).toEqual([])
    expect(f.track.scrollLeft).toBe(100)
  })

  it('cancels pending animation frames and fallback settle timers when disposed', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = fixture({ fallback: true })
    f.render([1, 2, 3], 1, 0)
    f.tick()
    f.track.scrollLeft = 100
    f.scroll('scroll')
    f.render([1, 2, 3], 1, 100)
    expect(f.frames.size).toBe(1)
    f.effect.dispose()
    expect(f.frames.size).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(f.events).toEqual([])
  })
})
