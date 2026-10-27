// Measuring a rendered page into a box tree: every component root (data-sem-c) and, inside each,
// the parts the constraints layer names by role (lc:selector), with border boxes in document px.
// This is what a rendered-state effect (#35, rnd:) would write for the components and parts that
// invariants mention; scripts/layout-check.ts runs it in a real browser to record fixtures.
//
// It runs in the page (serialized with toString), so it reads nothing from module scope.

export interface MeasuredNode {
  /** the component's slug (data-sem-c), or the part's component's */
  slug: string
  /** for a part: its role (lc: local name), e.g. "SingleLineControl" */
  part?: string
  /** the nearest component above (index into nodes), -1 at the top */
  parent: number
  x: number
  y: number
  width: number
  height: number
  /** it clips or scrolls its overflow on the inline axis */
  scrolls?: boolean
  /** by how much its content is wider than its box (scrollWidth - clientWidth), when it is */
  overflowsBy?: number
  /** text of a short label, to read findings by */
  text?: string
  /** for a child of a row (direction row): the line it is on when the row wraps (0, 1, ...) */
  line?: number
  /** the position layer's hooks on a component root (data-sem-direction, data-sem-layout) */
  direction?: string
  layout?: string
}

export interface MeasuredPage {
  url: string
  width: number
  height: number
  theme: string
  /** the site's language (set by the driver) */
  lang?: string
  dir: string
  /** document.scrollingElement.scrollWidth */
  scrollWidth: number
  nodes: MeasuredNode[]
}

/** Part roles to selectors; a media condition picks another selector where a width class moves the part. */
export type PartSelectors = Record<string, { selector: string; media?: string }[]>

export function measurePage(parts: PartSelectors): MeasuredPage {
  const nodes: MeasuredNode[] = []
  const indexOf = new Map<Element, number>()
  const round = (n: number) => Math.round(n * 100) / 100
  const box = (el: Element) => {
    const r = el.getBoundingClientRect()
    return { x: round(r.left + scrollX), y: round(r.top + scrollY), width: round(r.width), height: round(r.height) }
  }
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 || r.height > 0
  }
  const nearest = (el: Element): number => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const i = indexOf.get(p)
      if (i !== undefined) return i
    }
    return -1
  }
  const overflow = (el: Element, node: MeasuredNode) => {
    const over = el.scrollWidth - el.clientWidth
    if (over > 1 && el.clientWidth > 0) node.overflowsBy = over
  }
  for (const el of Array.from(document.querySelectorAll('[data-sem-c]'))) {
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    const scrolls = cs.overflowX !== 'visible'
    const node: MeasuredNode = { slug: el.getAttribute('data-sem-c')!, parent: nearest(el), ...box(el) }
    if (scrolls) node.scrolls = true
    const direction = el.getAttribute('data-sem-direction')
    if (direction) node.direction = direction
    const layout = el.getAttribute('data-sem-layout')
    if (layout) node.layout = layout
    if (!scrolls) overflow(el, node)
    indexOf.set(el, nodes.length)
    nodes.push(node)
  }
  // the lines of each row: a child starts a new line when it begins below the line so far
  nodes.forEach((row, r) => {
    if (row.direction !== 'row') return
    const kids = nodes.filter((n) => n.parent === r).sort((a, b) => a.y - b.y)
    let line = -1
    let bottom = -Infinity
    for (const k of kids) {
      if (k.y >= bottom - 1) {
        line++
        bottom = k.y + k.height
      } else bottom = Math.max(bottom, k.y + k.height)
      k.line = line
    }
  })
  for (const [role, picks] of Object.entries(parts)) {
    const selector = (picks.find((p) => p.media && matchMedia(p.media).matches) ?? picks.find((p) => !p.media))!.selector
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (!visible(el)) continue
      const owner = indexOf.has(el) ? indexOf.get(el)! : nearest(el)
      if (owner < 0) continue
      const text = (el.textContent ?? '').trim().slice(0, 40)
      const node: MeasuredNode = { slug: nodes[owner].slug, part: role, parent: owner, ...box(el), ...(text ? { text } : {}) }
      overflow(el, node)
      nodes.push(node)
    }
  }
  const root = document.querySelector('[data-sem-theme]')
  return {
    url: location.href,
    width: document.documentElement.clientWidth,
    height: innerHeight,
    theme: root?.getAttribute('data-sem-theme') ?? '',
    dir: document.documentElement.dir || 'ltr',
    scrollWidth: document.scrollingElement!.scrollWidth,
    nodes,
  }
}
