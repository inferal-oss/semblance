// Reflow Semblance's SVG in the browser, where the container width is known.
// Keep the rendered field groups in place so their RDF identity and events survive.
const selector = '[data-byte-wrap="true"]'
const decoration = "[data-byte-wrap-decoration]"
const svgNS = "http://www.w3.org/2000/svg"
interface Field {
  node: SVGGElement
  bar: SVGRectElement
  start: number
  width: number
  size: number
  x: number
  offset?: string | null
  labels: { element: SVGTextElement; lines: string[] }[]
}

interface Row { fields: Field[]; width: number }

const top = 38
const bottom = 85
const lineHeight = 14
const viewBoxes = new WeakMap<SVGSVGElement, { source: string; wrapped: string }>()

function svg<K extends keyof SVGElementTagNameMap>(parent: Element, name: K, attributes: Record<string, string | number>, text?: string) {
  const element = parent.ownerDocument.createElementNS(svgNS, name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value))
  if (text !== undefined) element.textContent = text
  parent.append(element)
  return element
}

function byteRows(fields: Field[], available: number) {
  const rows: Row[] = []
  let row: Row | undefined
  for (const field of fields) {
    // A field wider than a whole row gets a row of its own. Other fields keep
    // their original widths and break onto the next row when they no longer fit.
    field.size = Math.min(available, Math.max(48, field.width))
    if (!row || row.width + field.size > available) {
      row = { fields: [], width: 0 }
      rows.push(row)
    }
    row.fields.push(field)
    row.width += field.size
  }
  return rows
}

function move(element: SVGElement | null, x: number, y = 0) {
  if (element) element.style.transform = `translate(${x}px, ${y}px)`
}

function textLines(element: SVGTextElement, limit: number, pen: CanvasRenderingContext2D) {
  const value = (element.textContent ?? '').trim()
  const style = element.ownerDocument.defaultView!.getComputedStyle(element)
  pen.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const fits = (value: string) => pen.measureText(value).width <= limit
  if (fits(value)) return [value]
  const lines = []
  let line = ""
  for (const word of value.split(/\s+/u)) {
    const joined = line ? line + " " + word : word
    if (fits(joined)) {
      line = joined
      continue
    }
    if (line) lines.push(line)
    line = ""
    for (const character of word) {
      if (line && !fits(line + character)) {
        lines.push(line)
        line = ""
      }
      line += character
    }
  }
  if (line) lines.push(line)
  return lines
}

function drawLines(element: SVGTextElement, lines: string[], x: number, y: number, parent: SVGElement) {
  for (const [index, line] of lines.entries()) svg(parent, "text", {
    class: element.getAttribute("class") ?? "", x, y: y + index * lineHeight, "text-anchor": "middle",
  }, line)
}

function drawField(field: Field, x: number, y: number, rowNumber: number, extra: number) {
  const { node, bar, size, width, labels } = field
  const delta = size - width
  move(node, x - field.start, y)
  node.dataset.byteWrapRow = String(rowNumber)
  bar.style.width = size + "px"
  bar.style.height = bottom - top + extra + "px"
  let lower = 0
  for (const { element, lines } of labels) {
    const center = Number(element.getAttribute("x")) + delta / 2
    const baseline = Number(element.getAttribute("y")) + lower
    element.style.opacity = lines.length > 1 ? "0" : ""
    move(element, delta / 2, lower)
    if (lines.length > 1) {
      const copy = svg(node, "g", {
        "data-byte-wrap-decoration": "", "aria-hidden": "true", "pointer-events": "none",
      })
      drawLines(element, lines, center, baseline, copy)
      lower += (lines.length - 1) * lineHeight
    }
  }
  move(node.querySelector<SVGElement>(".card-offset"), delta / 2)
  move(node.querySelector<SVGElement>(".continuation"), delta)
  for (const mark of node.querySelectorAll<SVGRectElement>(":scope > .used")) {
    if (!width) continue
    const start = Number(mark.getAttribute("x"))
    const offset = ((start - field.start) * size) / width
    const span = (Number(mark.getAttribute("width")) * size) / width
    move(mark, offset - (start - field.start), extra)
    mark.style.width = Math.min(size - offset, Math.max(2, span)) + "px"
  }
  field.x = x
}

export function wrapByteLayout(plot: SVGSVGElement, width: number, pen: CanvasRenderingContext2D) {
  const strip = plot.querySelector(":scope > g[role=list]")
  if (!strip) return
  const fields: Field[] = [...strip.querySelectorAll<SVGGElement>(":scope > g")].flatMap(node => {
    const bar = node.querySelector<SVGRectElement>(":scope > rect:first-child")
    if (!bar) return []
    return [{
      node, bar, size: 0, x: 0, labels: [],
      start: Number(bar.getAttribute("x")), width: Number(bar.getAttribute("width")),
      offset: node.querySelector(".offset")?.textContent,
    }]
  })
  const offsetWidth = Math.max(0, ...[...strip.querySelectorAll<SVGTextElement>(":scope > g > .offset")].map(element => element.getComputedTextLength()))
  const margin = Math.max(18, Math.min(Math.floor(width / 4), Math.ceil(offsetWidth / 2) + 4))
  const available = width - margin * 2
  if (!fields.length || available < 64) return
  for (const child of plot.querySelectorAll(":scope > " + decoration + ", :scope > g[role=list] > g > " + decoration)) child.remove()

  const rows = byteRows(fields, available)
  const spans = [...plot.querySelectorAll<SVGGElement>(":scope > g[data-byte-first][data-byte-last]")].map(group => ({
    first: Number(group.dataset.byteFirst), last: Number(group.dataset.byteLast),
    label: group.querySelector(".annotation")?.textContent ?? "",
  }))
  const finalField = fields.at(-1)!.node
  const lastOffset = finalField.querySelectorAll<SVGTextElement>(".offset")
  const extent = lastOffset.length > 1 ? lastOffset[1]?.textContent ?? undefined : undefined
  if (extent !== undefined) {
    lastOffset[1]!.style.opacity = "0"
    const endTick = finalField.querySelectorAll<SVGPathElement>(".tick")[1]
    if (endTick) endTick.style.opacity = "0"
  }
  const drawing = svg(plot, "g", { "data-byte-wrap-decoration": "", "aria-hidden": "true" })
  let y = plot.querySelector(":scope > .axis-label")?.textContent ? 0 : -6
  let index = 0
  for (const [rowNumber, row] of rows.entries()) {
    const first = index
    const rowEnd = margin + row.width
    for (const field of row.fields) {
      field.labels = [...field.node.querySelectorAll<SVGTextElement>(":scope > :is(.label, .meta)")].map(element => ({
        element, lines: textLines(element, field.size - 12, pen),
      }))
    }
    const extra = Math.max(...row.fields.map(field =>
      lineHeight * field.labels.reduce((sum, { lines }) => sum + lines.length - 1, 0)))
    svg(drawing, "path", { class: "rail", d: `M${margin} ${y + top - 1}H${rowEnd}` })
    let x = margin
    for (const field of row.fields) {
      drawField(field, x, y, rowNumber, extra)
      x += field.size
      index++
    }
    const offset = index === fields.length ? extent : fields[index]?.offset
    svg(drawing, "path", { class: "tick", d: `M${rowEnd} ${y + 30}v8` })
    if (offset != null) svg(drawing, "text", {
      class: "offset", x: rowEnd, y: y + 26, "text-anchor": "middle",
    }, offset)

    let end = y + bottom + extra
    for (const span of spans) {
      if (span.last < first || span.first >= index || span.last < span.first) continue
      const left = fields[Math.max(first, span.first)]!
      const right = fields[Math.min(index - 1, span.last)]!
      const rightEdge = right.x + right.size
      end += 15
      // Open ends indicate that the same span continues on an adjacent row.
      svg(drawing, "path", { class: "bracket", d: `M${left.x} ${end}${
        span.first >= first ? "v-5m0 5" : ""}H${rightEdge}${span.last < index ? "v-5" : ""}` })
      const caption = svg(drawing, "text", {
        class: "annotation", x: (left.x + rightEdge) / 2, y: end + 14, "text-anchor": "middle",
      }, span.label)
      // Keep a short bracket's label within the whole diagram, even at a row edge.
      const lines = textLines(caption, available, pen)
      const half = Math.max(...lines.map(line => pen.measureText(line).width)) / 2
      const center = Math.max(half + 4, Math.min(width - half - 4, (left.x + rightEdge) / 2))
      if (lines.length > 1) {
        drawLines(caption, lines, center, end + 14, drawing)
        caption.remove()
      } else caption.setAttribute("x", String(center))
      end += 16 + (lines.length - 1) * lineHeight
    }
    y = end - 12
  }
  const viewBox = `0 0 ${width} ${y + 18}`
  const current = plot.getAttribute("viewBox") ?? ""
  const previous = viewBoxes.get(plot)
  viewBoxes.set(plot, { source: previous && current === previous.wrapped ? previous.source : current, wrapped: viewBox })
  if (current !== viewBox) plot.setAttribute("viewBox", viewBox)
  plot.dataset.byteWrapped = ""
}

function restoreByteLayout(plot: SVGSVGElement) {
  const previous = viewBoxes.get(plot)
  if (!previous) return
  if (plot.getAttribute('viewBox') === previous.wrapped) plot.setAttribute('viewBox', previous.source)
  viewBoxes.delete(plot)
  delete plot.dataset.byteWrapped
  plot.querySelectorAll(':scope > ' + decoration + ', :scope > g[role=list] > g > ' + decoration)
    .forEach(node => node.remove())
  for (const cell of plot.querySelectorAll<SVGGElement>(':scope > g[role=list] > g[data-byte-wrap-row]')) {
    delete cell.dataset.byteWrapRow
    cell.style.removeProperty('transform')
    for (const child of cell.querySelectorAll<SVGElement>(':scope > :is(rect, text, path)')) {
      for (const prop of ['transform', 'width', 'height', 'opacity']) child.style.removeProperty(prop)
    }
  }
}

export function attachByteLayouts(host: HTMLElement): () => void {
  const window = host.ownerDocument.defaultView
  if (!window?.ResizeObserver || !window.MutationObserver) return () => {}
  const pending = new Set<HTMLElement>()
  const widths = new WeakMap<HTMLElement, number>()
  let frame: number | undefined
  let pen: CanvasRenderingContext2D | null | undefined
  const schedule = (layout: HTMLElement) => {
    pending.add(layout)
    frame ??= window.requestAnimationFrame(() => {
      frame = undefined
      const plots = [...pending].map(layout => [layout, layout.querySelector<SVGSVGElement>(':scope > svg'), layout.clientWidth] as const)
      pending.clear()
      pen ??= host.ownerDocument.createElement('canvas').getContext('2d')
      for (const [layout, plot, width] of plots) {
        if (!plot) continue
        if (!layout.matches(selector)) restoreByteLayout(plot)
        else if (pen && width) wrapByteLayout(plot, width, pen)
      }
    })
  }
  const resize = new window.ResizeObserver(entries => {
    for (const { target } of entries) {
      const layout = target as HTMLElement
      const width = layout.clientWidth
      if (width !== widths.get(layout)) {
        widths.set(layout, width)
        schedule(layout)
      }
    }
  })
  const within = (node: Node, visit: (layout: HTMLElement) => void) => {
    if (node.nodeType !== 1) return
    const element = node as HTMLElement
    if (element.matches(selector)) visit(element)
    element.querySelectorAll<HTMLElement>(selector).forEach(visit)
  }
  const observe = (layout: HTMLElement) => {
    resize.observe(layout)
    schedule(layout)
  }
  const mutations = new window.MutationObserver(records => {
    for (const { target, addedNodes, removedNodes, attributeName } of records) {
      const parent = target.nodeType === 1 ? target as Element : target.parentElement
      if (!parent || parent.closest(decoration)) continue
      if (attributeName === 'data-byte-wrap') {
        const layout = parent as HTMLElement
        if (layout.matches(selector)) observe(layout)
        else {
          resize.unobserve(layout)
          widths.delete(layout)
          schedule(layout)
        }
        continue
      }
      for (const node of removedNodes) within(node, layout => resize.unobserve(layout))
      let changed = !addedNodes.length && !removedNodes.length
      for (const node of addedNodes) {
        if (node.nodeType === 1 && (node as Element).matches(decoration)) continue
        changed = true
        within(node, observe)
      }
      for (const node of removedNodes) if (node.nodeType !== 1 || !(node as Element).matches(decoration)) changed = true
      const layout = parent.closest<HTMLElement>(selector)
      if (changed && layout) schedule(layout)
    }
  })
  mutations.observe(host, { childList: true, characterData: true, subtree: true, attributes: true,
    attributeFilter: ['x', 'width', 'data-byte-first', 'data-byte-last', 'data-byte-wrap'] })
  host.querySelectorAll<HTMLElement>(selector).forEach(observe)
  let disposed = false
  void host.ownerDocument.fonts?.ready.then(() => {
    if (!disposed) host.querySelectorAll<HTMLElement>(selector).forEach(schedule)
  })
  return () => {
    disposed = true
    mutations.disconnect()
    resize.disconnect()
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    pending.clear()
  }
}
