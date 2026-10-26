import { parseHTML } from 'linkedom'
import { describe, expect, it, vi } from 'vitest'
import { attachAnchoredPopups } from '../src/web/anchored-popups.ts'

function fixture({ native = true, rtl = false, top = 30, left = 250, kind = 'menu', hidden = false } = {}) {
  const klass = kind === 'menu' ? 'sem-menu-popup' : kind === 'popover' ? 'sem-panel' : kind.includes('date') ? 'sem-date-popup' : 'sem-ta-popup'
  const popupHtml = `<section class="${klass}" style="color:red" ${hidden ? 'hidden' : ''}>Options</section>`
  const contents = kind === 'menu' ? `<button data-test-anchor aria-haspopup="menu">Actions</button>${popupHtml}`
    : kind === 'popover' ? `<button data-test-anchor class="sem-trigger">Details</button>${popupHtml}`
    : kind.includes('date') ? `<span class="sem-date-row" data-test-anchor><input><button>Calendar</button></span>${popupHtml}`
    : `<span class="sem-ta-field" data-test-anchor><input>${popupHtml}</span>`
  const { document, window } = parseHTML(`<!doctype html><html><body><main><section data-sem-c="${kind}">${contents}</section></main></body></html>`)
  Object.defineProperty(document.documentElement, 'clientWidth', { value: 480 })
  Object.defineProperty(document.documentElement, 'clientHeight', { value: 600 })
  Object.defineProperty(window, 'getComputedStyle', { configurable: true, value: () => ({ direction: rtl ? 'rtl' : 'ltr' }) })
  const callbacks: FrameRequestCallback[] = []
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => (callbacks.push(callback), callbacks.length) })
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: vi.fn() })
  const host = document.querySelector('main')!
  const trigger = host.querySelector<HTMLElement>('[data-test-anchor]')!
  const popup = host.querySelector<HTMLElement>(`.${klass}`)!
  let open = false
  const show = vi.fn(() => { open = true })
  const hide = vi.fn(() => { open = false })
  const matches = popup.matches.bind(popup)
  Object.defineProperty(popup, 'matches', { value: (selector: string) => selector === ':popover-open' ? open : matches(selector) })
  if (native) {
    popup.showPopover = show
    popup.hidePopover = hide
  }
  trigger.getBoundingClientRect = () => ({ top, left, bottom: top + 38, right: left + 90, width: 90, height: 38 }) as DOMRect
  popup.getBoundingClientRect = () => ({ width: 200, height: 100 }) as DOMRect
  return { document, window, host, popup, show, hide, callbacks }
}

describe('anchored popup host effect', () => {
  it('uses the native popover layer and clamps a menu near the right edge', () => {
    const app = fixture({ left: 430 })
    const dispose = attachAnchoredPopups(app.host)
    expect(app.show).toHaveBeenCalledOnce()
    expect(app.popup.getAttribute('popover')).toBe('manual')
    expect(app.popup.style.position).toBe('fixed')
    expect(app.popup.style.width).toBe('200px')
    expect(app.popup.style.left).toBe('272px')
    expect(app.popup.style.top).toBe('74px')
    dispose()
    expect(app.hide).toHaveBeenCalledOnce()
    expect(app.popup.getAttribute('popover')).toBeNull()
    expect(app.popup.style.color).toBe('red')
    expect(app.popup.getAttribute('style')).toBe('color:red')
  })

  it('aligns RTL menus to the trigger end and opens upward when there is more room', () => {
    const app = fixture({ rtl: true, top: 550, left: 200 })
    const dispose = attachAnchoredPopups(app.host)
    expect(app.popup.style.left).toBe('90px')
    expect(app.popup.style.top).toBe('444px')
    dispose()
  })

  it('positions a fixed popup when native popovers are unavailable', () => {
    const app = fixture({ native: false })
    const dispose = attachAnchoredPopups(app.host)
    expect(app.popup.getAttribute('popover')).toBeNull()
    expect(app.popup.style.position).toBe('fixed')
    dispose()
  })

  it('coalesces resize work and cancels pending work when disposed', () => {
    const app = fixture()
    const dispose = attachAnchoredPopups(app.host)
    app.window.dispatchEvent(new app.window.Event('resize'))
    app.window.dispatchEvent(new app.window.Event('resize'))
    expect(app.callbacks).toHaveLength(1)
    dispose()
    expect(app.window.cancelAnimationFrame).toHaveBeenCalledOnce()
  })

  it.each(['popover', 'date-field', 'date-range-field', 'combobox', 'tag-input'])('anchors a %s panel to its own control', kind => {
    const app = fixture({ kind, top: 550 })
    const dispose = attachAnchoredPopups(app.host)
    expect(app.show).toHaveBeenCalledOnce()
    expect(app.popup.style.top).toBe('444px')
    expect(app.popup.style.left).toBe('250px')
    dispose()
  })

  it('lets typeahead panels follow their field width', () => {
    const app = fixture({ kind: 'tag-input' })
    const dispose = attachAnchoredPopups(app.host)
    expect(app.popup.style.width).toBe('90px')
    dispose()
  })

  it('follows persistent panel visibility without changing its graph-owned hidden state', async () => {
    const app = fixture({ kind: 'date-field', hidden: true })
    const dispose = attachAnchoredPopups(app.host)
    expect(app.show).not.toHaveBeenCalled()
    expect(app.popup.hidden).toBe(true)
    app.popup.hidden = false
    await Promise.resolve()
    await Promise.resolve()
    expect(app.show).toHaveBeenCalledOnce()
    expect(app.popup.hidden).toBe(false)
    app.popup.hidden = true
    await Promise.resolve()
    await Promise.resolve()
    expect(app.hide).toHaveBeenCalledOnce()
    expect(app.popup.getAttribute('popover')).toBeNull()
    expect(app.popup.getAttribute('style')).toBe('color:red')
    expect(app.popup.hidden).toBe(true)
    dispose()
  })

  it('does not rescan the whole app when unrelated content changes', async () => {
    const app = fixture()
    const queries = vi.spyOn(app.host, 'querySelectorAll')
    const dispose = attachAnchoredPopups(app.host)
    queries.mockClear()
    const paragraph = app.document.createElement('p')
    paragraph.textContent = 'Unrelated content'
    app.host.append(paragraph)
    await Promise.resolve()
    await Promise.resolve()
    expect(queries).not.toHaveBeenCalled()
    expect(app.show).toHaveBeenCalledOnce()
    dispose()
  })

  it('restores a removed popup before the renderer reuses it', async () => {
    const app = fixture()
    const dispose = attachAnchoredPopups(app.host)
    app.popup.remove()
    await Promise.resolve()
    await Promise.resolve()
    expect(app.popup.getAttribute('popover')).toBeNull()
    expect(app.popup.style.color).toBe('red')
    dispose()
  })
  it('keeps percentage minimums relative to the original anchor instead of the viewport', () => {
    const app = fixture()
    app.popup.getBoundingClientRect = () => ({
      width: app.popup.style.position === 'fixed' && !app.popup.style.minWidth ? 480 : 200,
      height: 100,
    }) as DOMRect
    const dispose = attachAnchoredPopups(app.host)
    expect(app.popup.style.width).toBe('200px')
    dispose()
  })

  it('remeasures a panel when lazy content arrives after it opens', async () => {
    const app = fixture({ kind: 'date-field' })
    let intrinsicWidth = 18
    app.popup.getBoundingClientRect = () => ({ width: Number.parseFloat(app.popup.style.width) || intrinsicWidth, height: 100 }) as DOMRect
    const dispose = attachAnchoredPopups(app.host)
    expect(app.popup.style.width).toBe('18px')
    intrinsicWidth = 268
    const grid = app.document.createElement('section')
    grid.textContent = 'Calendar content'
    app.popup.append(grid)
    await Promise.resolve()
    await Promise.resolve()
    expect(app.popup.style.width).toBe('268px')
    expect(app.popup.contains(grid)).toBe(true)
    dispose()
  })

  it('leaves host-slot content to its own popup controller', () => {
    const app = fixture()
    const slot = app.document.createElement('section')
    slot.setAttribute('data-sem-c', 'host-slot')
    const nested = app.host.firstElementChild!
    app.host.append(slot)
    slot.append(nested)
    const disposeOuter = attachAnchoredPopups(app.host)
    expect(app.show).not.toHaveBeenCalled()
    const disposeInner = attachAnchoredPopups(nested)
    expect(app.show).toHaveBeenCalledOnce()
    disposeOuter()
    expect(app.hide).not.toHaveBeenCalled()
    expect(app.popup.style.width).toBe('200px')
    disposeInner()
    expect(app.hide).toHaveBeenCalledOnce()
  })

  it('supports renderer-owned slot detection for other foreign content', () => {
    const app = fixture()
    const dispose = attachAnchoredPopups(app.host, element => element === app.host)
    expect(app.show).not.toHaveBeenCalled()
    expect(app.popup.getAttribute('style')).toBe('color:red')
    dispose()
  })

})
