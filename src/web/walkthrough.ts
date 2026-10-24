// The host side of walkthroughs (ontology/components/walkthrough.ttl): what only the page knows,
// where things are. The graph says which step is being read (c:current), what each phrase
// mentions (data-sem-mentions on a c:Mention) and which statement of the source to show
// (data-sem-highlighted lines); this effect
//   - reports the step that crosses the reading line while the page scrolls, as an unrecorded
//     c:StepInView event (a "sem-step" DOM event on the rendered step: the bus records it),
//   - draws a curved arrow from each mention of the current step (and each lit mention) to its
//     node in the diagram, into the walkthrough's host-owned slot, kept attached on every frame
//     the page scrolls or resizes,
//   - brings the first highlighted line of a source view into view inside its scroll box.
// Colors are the theme's (the arrows are classed, inside the walkthrough); motion follows
// mot:preference (data-sem-motion) and the system's reduced-motion setting.

const SVG = 'http://www.w3.org/2000/svg'
/** Where the reader's eye is: the step whose top has passed this fraction of the viewport is being read. */
const READING_LINE = 0.4

export interface WalkthroughHost {
  /** Re-measure now (e.g. after the renderer patched the page). */
  update(): void
  dispose(): void
}

export function attachWalkthroughs(host: HTMLElement): WalkthroughHost {
  const doc = host.ownerDocument
  const win = doc.defaultView!
  let frame = 0
  let scrolled = false
  const reported = new WeakMap<Element, Element>()
  const drawn = new WeakMap<Element, string>()

  const reduced = (el: Element) => {
    const pref = el.closest('[data-sem-motion]')?.getAttribute('data-sem-motion')
    return pref === 'reduced' || pref === 'none' || !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  }
  const shown = (el: Element) => !el.closest('[hidden]') && el.getClientRects().length > 0

  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(run)
  }
  const onScroll = () => {
    scrolled = true
    schedule()
  }

  /** How much a sticky bar covers at the top of the page: what stays in view sticks below it (--sem-sticky-top). */
  let stickyTop = -1
  function measureStickyTop() {
    const bar = doc.querySelector('[data-sem-c=app-bar]')
    const style = bar && win.getComputedStyle(bar)
    const top = bar && (style!.position === 'sticky' || style!.position === 'fixed') ? Math.ceil(bar.getBoundingClientRect().height) + 12 : 16
    if (top !== stickyTop) doc.documentElement.style.setProperty('--sem-sticky-top', `${(stickyTop = top)}px`)
  }

  function run() {
    frame = 0
    measureStickyTop()
    for (const root of host.querySelectorAll<HTMLElement>('[data-sem-c=walkthrough]')) {
      if (!shown(root)) continue
      if (scrolled) report(root)
      arrows(root)
    }
    scrolled = false
  }

  /** The step crossing the reading line becomes the current one (once per change). */
  function report(root: HTMLElement) {
    const steps = [...root.querySelectorAll<HTMLElement>(':scope > .sem-walk-body > .sem-walk-steps > .sem-walk-step')]
    if (!steps.length) return
    const rect = root.getBoundingClientRect()
    if (rect.bottom < 0 || rect.top > win.innerHeight) return
    const line = win.innerHeight * READING_LINE
    let reading = steps[0]!
    for (const s of steps) if (s.getBoundingClientRect().top <= line) reading = s
    // At the end of the page the last steps cannot reach the line: the lowest one fully in view is read.
    const atEnd = win.scrollY + win.innerHeight >= doc.documentElement.scrollHeight - 2
    if (atEnd) for (const s of steps) if (s.getBoundingClientRect().bottom <= win.innerHeight) reading = s
    if (reading.getAttribute('aria-current') === 'step' || reported.get(root) === reading) return
    reported.set(root, reading)
    reading.dispatchEvent(new win.CustomEvent('sem-step', { bubbles: true }))
  }

  /** Curved arrows from the mentions being read to their nodes, in the walkthrough's slot. */
  function arrows(root: HTMLElement) {
    const slot = root.querySelector<HTMLElement>(':scope > .sem-walk-arrows')
    if (!slot) return
    let svg = slot.querySelector<SVGSVGElement>(':scope > svg')
    if (!svg) {
      svg = doc.createElementNS(SVG, 'svg')
      svg.setAttribute('aria-hidden', 'true')
      slot.append(svg)
    }
    const base = root.getBoundingClientRect()
    const aside = root.querySelector<HTMLElement>('.sem-walk-aside')
    // What scrolls under the app bar is out of sight: no arrow starts there.
    const top = Math.max(0, aside ? parseFloat(win.getComputedStyle(aside).top) || 0 : 0)
    const current = root.querySelector('.sem-walk-step[aria-current=step]')
    const mentions = new Set<Element>([...(current?.querySelectorAll('[data-sem-mentions]') ?? []), ...root.querySelectorAll('[data-sem-lit]')])
    const wanted: { key: string; d: string; leader: string; start: [number, number]; lit: boolean }[] = []
    for (const m of mentions) {
      const term = m.getAttribute('data-sem-mentions')
      if (!term) continue
      const dot = [...root.querySelectorAll('.sem-plot [data-sem-term]')].find((n) => n.getAttribute('data-sem-term') === term)?.querySelector('.sem-dot')
      if (!dot) continue
      const a = m.getBoundingClientRect()
      const b = dot.getBoundingClientRect()
      const inView = (r: DOMRect) => r.bottom > top && r.top < win.innerHeight && r.width > 0
      if (!inView(a) || !inView(b)) continue
      const end: [number, number] = [b.left + b.width / 2 - base.left, b.top + b.height / 2 - base.top]
      const radius = b.width / 2 + 3
      // Beside (either side: right to left, the diagram is on the left): a leader under the rest of
      // the line, between the lines and never through words, to the step's edge, then the curve.
      // Stacked (a narrow page): straight down from the word.
      const side = b.left > a.right ? 1 : b.right < a.left ? -1 : 0
      const box = (m.closest('.sem-walk-step') ?? m).getBoundingClientRect()
      const edge = (side > 0 ? box.right : box.left) - base.left
      const y = a.bottom - base.top
      const start: [number, number] = side ? [(side > 0 ? a.right : a.left) - base.left, y] : [a.left + a.width / 2 - base.left, a.bottom + 2 - base.top]
      const from: [number, number] = side ? [side > 0 ? Math.max(edge, start[0] + 6) : Math.min(edge, start[0] - 6), y] : start
      const leader = side ? `M${start[0].toFixed(1)},${y.toFixed(1)} L${from[0].toFixed(1)},${y.toFixed(1)}` : ''
      wanted.push({ key: m.id || term, d: path(from, end, radius, side), leader, start, lit: m.hasAttribute('data-sem-lit') })
    }
    const key = wanted.map((w) => w.key).join(' ')
    const fresh = drawn.get(root) !== key
    drawn.set(root, key)
    let layer = svg.querySelector<SVGGElement>(':scope > g')
    if (fresh || !layer) {
      layer?.remove()
      layer = doc.createElementNS(SVG, 'g')
      svg.append(layer)
      for (let i = 0; i < wanted.length; i++) {
        const leader = doc.createElementNS(SVG, 'path')
        leader.setAttribute('class', 'sem-walk-leader')
        const p = doc.createElementNS(SVG, 'path')
        p.setAttribute('class', 'sem-walk-arrow')
        const head = doc.createElementNS(SVG, 'path')
        head.setAttribute('class', 'sem-walk-arrow-head')
        const dot = doc.createElementNS(SVG, 'circle')
        dot.setAttribute('class', 'sem-walk-arrow-start')
        dot.setAttribute('r', '2.5')
        layer.append(leader, p, head, dot)
      }
    }
    const parts = layer.children
    const N = 4
    wanted.forEach((w, i) => {
      const [leader, p, head, dot] = [parts[i * N], parts[i * N + 1], parts[i * N + 2], parts[i * N + 3]] as SVGElement[]
      leader!.setAttribute('d', w.leader)
      p!.setAttribute('d', w.d)
      head!.setAttribute('d', arrowHead(w.d))
      dot!.setAttribute('cx', w.start[0].toFixed(1))
      dot!.setAttribute('cy', w.start[1].toFixed(1))
      for (const el of [leader!, p!, head!]) w.lit ? el.setAttribute('data-lit', '') : el.removeAttribute('data-lit')
    })
    // A new set of arrows draws itself in, unless motion is calmed.
    if (fresh && wanted.length && !reduced(root)) {
      for (let i = 0; i < wanted.length; i++) {
        const p = parts[i * N + 1] as SVGPathElement
        const length = p.getTotalLength?.() ?? 0
        if (!length || !p.animate) continue
        p.animate([{ strokeDasharray: `${length}`, strokeDashoffset: `${length}` }, { strokeDasharray: `${length}`, strokeDashoffset: '0' }], { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)', delay: i * 40 })
      }
    }
  }

  /** Bring a source view's first highlighted line into view within its own scroll box. */
  function reveal(line: Element) {
    const pre = line.closest<HTMLElement>('.sem-source')
    if (!pre || !shown(pre)) return
    const first = pre.querySelector('.sem-line[data-sem-highlighted]')
    if (first !== line) return
    const box = pre.getBoundingClientRect()
    const at = first.getBoundingClientRect()
    const smooth = !reduced(pre)
    pre.scrollTo?.({ top: pre.scrollTop + at.top - box.top - pre.clientHeight * 0.2, behavior: smooth ? 'smooth' : 'auto' })
    // Stacked under the steps (a narrow page), the box itself may be out of view.
    if (box.bottom < 0 || box.top > win.innerHeight) pre.scrollIntoView?.({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' })
  }

  const observer = new win.MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && r.attributeName === 'data-sem-highlighted' && (r.target as Element).hasAttribute('data-sem-highlighted')) reveal(r.target as Element)
    }
    schedule()
  })
  observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-current', 'data-sem-lit', 'data-sem-highlighted', 'data-sem-salience', 'hidden'] })
  win.addEventListener('scroll', onScroll, { passive: true, capture: true })
  win.addEventListener('resize', schedule, { passive: true })
  schedule()
  return {
    update: schedule,
    dispose() {
      observer.disconnect()
      win.removeEventListener('scroll', onScroll, { capture: true })
      win.removeEventListener('resize', schedule)
      if (frame) win.cancelAnimationFrame(frame)
    },
  }
}

/** A cubic Bézier from a mention to a node's edge: out of the text sideways (or downwards), into the node. */
function path(start: [number, number], end: [number, number], radius: number, side: number): string {
  const [x0, y0] = start
  const [cx, cy] = end
  const dx = cx - x0
  const dy = cy - y0
  const len = Math.hypot(dx, dy) || 1
  // Stop at the node's ring, coming in along the last control's direction.
  const k = Math.max(40, Math.abs(side ? dx : dy) * 0.5)
  const c1: [number, number] = side ? [x0 + side * k, y0] : [x0, y0 + k]
  const c2: [number, number] = side ? [cx - side * k * 0.6, cy] : [cx, cy - k * 0.6]
  const [ux, uy] = [cx - c2[0], cy - c2[1]]
  const ul = Math.hypot(ux, uy) || len
  const x1 = cx - (ux / ul) * radius
  const y1 = cy - (uy / ul) * radius
  const f = (n: number) => n.toFixed(1)
  return `M${f(x0)},${f(y0)} C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(x1)},${f(y1)}`
}

/** A small arrowhead at the end of a path drawn by path(), along its last control's direction. */
function arrowHead(d: string): string {
  const n = d.match(/-?\d+(\.\d+)?/g)!.map(Number)
  const [c2x, c2y, x, y] = n.slice(-4) as [number, number, number, number]
  const l = Math.hypot(x - c2x, y - c2y) || 1
  const [ux, uy] = [(x - c2x) / l, (y - c2y) / l]
  const f = (v: number) => v.toFixed(1)
  return `M${f(x)},${f(y)} L${f(x - ux * 8 - uy * 4.5)},${f(y - uy * 8 + ux * 4.5)} L${f(x - ux * 8 + uy * 4.5)},${f(y - uy * 8 - ux * 4.5)} Z`
}
