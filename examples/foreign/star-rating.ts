// A stand-in for a third-party web component: <star-rating>. It knows nothing about Semblance. Like
// most published components it takes a `value` property and a `max` attribute, raises `change` (with
// detail.value) when a person picks a rating, never when its value is set from outside, styles itself in
// its shadow root from custom properties (--star-rating-on, --star-rating-off, --star-rating-size)
// and exposes its stars as ::part(star). It is a slider for assistive technology, follows the
// direction of the page (arrow keys swap in RTL) and takes its accessible name from aria-label.

type Win = typeof globalThis & { HTMLElement: typeof HTMLElement; customElements: CustomElementRegistry; CustomEvent: typeof CustomEvent }

const CSS = `
:host { display: inline-flex; gap: .15em; font-size: var(--star-rating-size, 1.5rem); line-height: 1; cursor: pointer; border-radius: .25em; }
:host(:focus-visible) { outline: 2px solid var(--star-rating-on, gold); outline-offset: 2px; }
span { color: var(--star-rating-off, #ccc); transition: color .15s, transform .15s; user-select: none; }
span[data-on] { color: var(--star-rating-on, gold); }
span:hover { transform: scale(1.15); }
@media (prefers-reduced-motion: reduce) { span { transition: none; } span:hover { transform: none; } }
`

/** Define <star-rating> in a window (the page's, or a test's linkedom window). */
export function defineStarRating(win: Win = globalThis as Win): void {
  if (win.customElements.get('star-rating')) return
  class StarRating extends win.HTMLElement {
    static observedAttributes = ['max']
    private current = 0
    private readonly shadow: ShadowRoot

    constructor() {
      super()
      this.shadow = this.attachShadow({ mode: 'open' })
      this.addEventListener('click', (e) => {
        const star = (e.composedPath?.()[0] ?? e.target) as Element
        const n = Number(star?.getAttribute?.('data-n'))
        if (n) this.choose(n === this.current ? 0 : n)
      })
      this.addEventListener('keydown', (e) => {
        const rtl = this.closest('[dir]')?.getAttribute('dir') === 'rtl'
        const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowUp: 1, ArrowDown: -1 }[e.key]
        const to = step !== undefined ? this.current + step : e.key === 'Home' ? 0 : e.key === 'End' ? this.max : undefined
        if (to === undefined) return
        e.preventDefault()
        this.choose(Math.max(0, Math.min(this.max, to)))
      })
    }

    get max(): number {
      return Number(this.getAttribute('max')) || 5
    }

    get value(): number {
      return this.current
    }

    set value(v: number) {
      const n = Math.max(0, Math.min(this.max, Math.round(Number(v) || 0)))
      if (n === this.current) return
      this.current = n
      this.render()
    }

    connectedCallback() {
      if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0')
      this.setAttribute('role', 'slider')
      this.render()
    }

    attributeChangedCallback() {
      this.render()
    }

    private choose(n: number) {
      if (n === this.current) return
      this.value = n
      this.dispatchEvent(new win.CustomEvent('change', { detail: { value: n }, bubbles: true, composed: true }))
    }

    private render() {
      this.setAttribute('aria-valuemin', '0')
      this.setAttribute('aria-valuemax', String(this.max))
      this.setAttribute('aria-valuenow', String(this.current))
      this.setAttribute('aria-valuetext', `${this.current} / ${this.max}`)
      let stars = ''
      for (let i = 1; i <= this.max; i++) stars += `<span part="star${i <= this.current ? ' on' : ''}" data-n="${i}"${i <= this.current ? ' data-on' : ''} aria-hidden="true">★</span>`
      this.shadow.innerHTML = `<style>${CSS}</style>${stars}`
    }
  }
  win.customElements.define('star-rating', StarRating)
}
