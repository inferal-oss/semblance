import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { attachPopovers } from '../src/web/popover.ts'

function page(left: number, width = 240) {
  const { document, window } = parseHTML('<main><div data-sem-c="popover"><button class="sem-trigger">Open</button><div class="sem-panel">Panel</div></div></main>')
  const host = document.querySelector('main') as HTMLElement
  const panel = document.querySelector('.sem-panel') as HTMLElement
  Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true })
  Object.defineProperty(window, 'requestAnimationFrame', { value: () => 1, configurable: true })
  Object.defineProperty(window, 'cancelAnimationFrame', { value: () => {}, configurable: true })
  panel.getBoundingClientRect = () => ({ left, right: left + width, width, top: 0, bottom: 100, height: 100, x: left, y: 0, toJSON: () => {} })
  return { host, panel, window }
}

describe('Popover viewport placement', () => {
  it('moves a right-edge panel inwards and restores its anchor after a resize', () => {
    const { host, panel, window } = page(260)
    const effect = attachPopovers(host)
    effect.update()
    expect(Number.parseFloat(panel.style.translate)).toBe(-192)
    Object.defineProperty(window, 'innerWidth', { value: 600, configurable: true })
    effect.update()
    expect(panel.style.translate).toBe('')
    effect.dispose()
  })

  it('moves a left-edge panel inwards and leaves a centered panel alone', () => {
    const left = page(-30)
    const leftEffect = attachPopovers(left.host)
    leftEffect.update()
    expect(Number.parseFloat(left.panel.style.translate)).toBe(42)
    leftEffect.dispose()

    const center = page(40)
    const centerEffect = attachPopovers(center.host)
    centerEffect.update()
    expect(center.panel.style.translate).toBe('')
    centerEffect.dispose()
  })

  it('does not measure a closed panel', () => {
    const { host, panel } = page(260)
    panel.hidden = true
    const effect = attachPopovers(host)
    effect.update()
    expect(panel.style.translate).toBe('')
    effect.dispose()
  })
})
