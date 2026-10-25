// A stand-in for a vanilla chart library: a bar chart behind mount(element, options, emit) →
// { update, destroy }, the shape most widget libraries have (a map, an editor, a chart). It knows
// nothing about Semblance: it takes points ({ label, value, order }), the selected label and a caption,
// calls emit('select', { label, index }) when a bar is chosen and emit('point', { label }) when one
// is pointed at, and styles itself from custom properties (--spark-bar, --spark-bar-selected,
// --spark-text) in a stylesheet it adds to the document once.
import type { Widget } from '../../src/foreign.ts'

interface Point {
  label: string
  value: number
  order?: number
}

const CSS = `
.spark { display: grid; gap: .5rem; margin: 0; font: inherit; color: var(--spark-text, #555); }
.spark-bars { display: flex; align-items: flex-end; gap: .35rem; block-size: 7rem; padding-block-start: .25rem; }
.spark-bar { flex: 1; min-inline-size: 1.5rem; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: .2rem;
  block-size: 100%; padding: 0; border: 0; background: none; color: inherit; font: inherit; font-size: .75rem; cursor: pointer; }
.spark-bar > i { display: block; inline-size: 100%; border-radius: .3rem .3rem 0 0; background: var(--spark-bar, steelblue); transition: background .15s; }
.spark-bar[aria-pressed=true] > i { background: var(--spark-bar-selected, navy); }
.spark-bar:focus-visible { outline: 2px solid var(--spark-bar-selected, navy); outline-offset: 2px; border-radius: .3rem; }
.spark figcaption { font-size: .8rem; }
`

function ensureStyles(doc: Document) {
  if (doc.getElementById('spark-styles')) return
  const style = doc.createElement('style')
  style.id = 'spark-styles'
  style.textContent = CSS
  doc.head?.appendChild(style)
}

export const spark: Widget = {
  mount(element, options, emit) {
    const doc = element.ownerDocument
    ensureStyles(doc)
    let points: Point[] = []
    let selected: string | undefined
    const figure = doc.createElement('figure')
    figure.className = 'spark'
    const bars = doc.createElement('div')
    bars.className = 'spark-bars'
    bars.setAttribute('role', 'group')
    const caption = doc.createElement('figcaption')
    figure.append(bars, caption)
    element.append(figure)

    const draw = () => {
      const max = Math.max(1, ...points.map((p) => p.value))
      bars.replaceChildren(
        ...points.map((p, index) => {
          const b = doc.createElement('button')
          b.type = 'button'
          b.className = 'spark-bar'
          b.setAttribute('aria-pressed', String(p.label === selected))
          b.setAttribute('aria-label', `${p.label}: ${p.value}`)
          const bar = doc.createElement('i')
          bar.setAttribute('style', `block-size: ${Math.round((p.value / max) * 100)}%`)
          const label = doc.createElement('span')
          label.textContent = p.label
          b.append(bar, label)
          b.addEventListener('click', () => emit('select', { label: p.label, index }))
          b.addEventListener('pointerenter', () => emit('point', { label: p.label }))
          b.addEventListener('focus', () => emit('point', { label: p.label }))
          return b
        }),
      )
    }
    const set = (o: Record<string, unknown>) => {
      if ('points' in o) points = Array.isArray(o.points) ? [...(o.points as Point[])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : []
      if ('selected' in o) selected = o.selected === undefined ? undefined : String(o.selected)
      if ('label' in o) {
        caption.textContent = o.label === undefined ? '' : String(o.label)
        bars.setAttribute('aria-label', caption.textContent)
      }
    }
    set(options)
    draw()
    return {
      update(changed) {
        set(changed)
        // New points redraw the bars; a new selection only marks them (the focused bar stays).
        if ('points' in changed) draw()
        else for (const [i, b] of [...bars.children].entries()) b.setAttribute('aria-pressed', String(points[i]?.label === selected))
      },
      destroy() {
        figure.remove()
      },
    }
  },
}
