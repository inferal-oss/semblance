// An element's border box as laid out, before any CSS transform, relative to the viewport (as
// getBoundingClientRect is), in CSS pixels. getBoundingClientRect gives the bounding box of the
// transformed element: a card a theme tilts by a fraction of a degree moves every control in it
// by a different amount, so a row of fields reads as misaligned (Doodle, #192). Layout checks
// compare boxes as laid out.
//
// Each transformed element on the way down (outermost first) maps layout coordinates by
// p -> O + A(p - O) + t, O its transform origin; their composition G is affine. The bounding box
// of G(rect) has G(centre) at its centre and |A| times the size as its size, so the layout box
// is found from it. A transform that cannot be inverted (a 45 degree turn of the size, a zero
// scale) keeps the element's offset size.
//
// It is self-contained (it reads nothing from module scope): scripts/layout-check.ts sends it to
// the page as text.

export interface LayoutBox {
  x: number
  y: number
  width: number
  height: number
}

export function layoutBox(el: Element): LayoutBox {
  const win = el.ownerDocument.defaultView as (Window & typeof globalThis) | null
  const r = el.getBoundingClientRect()
  if (!win || !win.DOMMatrix) return { x: r.x, y: r.y, width: r.width, height: r.height }
  // the transform of one element, origin-relative: a, b, c, d (linear), e, f (translation)
  const own = (n: Element) => {
    const cs = win.getComputedStyle(n)
    const parts: string[] = []
    // a translate in percent is of the element's own size
    const o = n as HTMLElement
    const size = [o.offsetWidth ?? 0, o.offsetHeight ?? 0]
    const px = (v: string, i: number) => (v.endsWith('%') ? (parseFloat(v) / 100) * size[i]! : parseFloat(v) || 0) + 'px'
    if (cs.translate && cs.translate !== 'none') parts.push(`translate(${cs.translate.split(' ').slice(0, 2).map(px).join(',')})`)
    if (cs.rotate && cs.rotate !== 'none' && !cs.rotate.includes(' ')) parts.push(`rotate(${cs.rotate})`)
    if (cs.scale && cs.scale !== 'none') parts.push(`scale(${cs.scale.split(' ').slice(0, 2).join(',')})`)
    if (cs.transform && cs.transform !== 'none') parts.push(cs.transform)
    if (!parts.length) return undefined
    let m: DOMMatrix
    try {
      m = new win.DOMMatrix(parts.join(' '))
    } catch {
      return undefined
    }
    if (m.isIdentity) return undefined
    const [ox, oy] = cs.transformOrigin.split(' ').map((v) => parseFloat(v) || 0)
    return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f, ox: ox!, oy: oy! }
  }
  const chain: { n: Element; m: NonNullable<ReturnType<typeof own>> }[] = []
  for (let n: Element | null = el; n; n = n.parentElement) {
    const m = own(n)
    if (m) chain.unshift({ n, m })
  }
  if (!chain.length) return { x: r.x, y: r.y, width: r.width, height: r.height }
  // G(p) = [ga gc; gb gd] p + (ge, gf), from layout coordinates to the viewport
  let ga = 1, gb = 0, gc = 0, gd = 1, ge = 0, gf = 0
  const offsetSize = (n: Element, w: number, h: number) => {
    const o = n as HTMLElement
    return typeof o.offsetWidth === 'number' ? [o.offsetWidth, o.offsetHeight] : [w, h]
  }
  // The layout box of n, from its bounding box under the linear part [a c; b d] and the affine G.
  const unmap = (n: Element, box: DOMRect, a: number, b: number, c: number, d: number) => {
    const det = Math.abs(a) * Math.abs(d) - Math.abs(b) * Math.abs(c)
    let w: number, h: number
    if (Math.abs(det) > 1e-6) {
      w = (Math.abs(d) * box.width - Math.abs(c) * box.height) / det
      h = (Math.abs(a) * box.height - Math.abs(b) * box.width) / det
    } else [w, h] = offsetSize(n, box.width, box.height)
    return { w, h, cx: box.x + box.width / 2, cy: box.y + box.height / 2 }
  }
  const inv = (x: number, y: number) => {
    // G^-1 of a point: [ga gc; gb gd]^-1 (p - (ge, gf))
    const det = ga * gd - gb * gc
    const px = x - ge
    const py = y - gf
    return [(gd * px - gc * py) / det, (-gb * px + ga * py) / det] as const
  }
  let result: LayoutBox | undefined
  for (const { n, m } of chain) {
    // the linear part of G after this transform: G's times its
    const la = ga * m.a + gc * m.b, lb = gb * m.a + gd * m.b, lc = ga * m.c + gc * m.d, ld = gb * m.c + gd * m.d
    const box = n === el ? r : n.getBoundingClientRect()
    const { w, h, cx, cy } = unmap(n, box, la, lb, lc, ld)
    // c' = G(C - dv + A dv + t), dv = (w, h) / 2 - origin: C = G^-1(c') + dv - A dv - t
    const dx = w / 2 - m.ox, dy = h / 2 - m.oy
    const [qx, qy] = inv(cx, cy)
    const Cx = qx + dx - (m.a * dx + m.c * dy) - m.e
    const Cy = qy + dy - (m.b * dx + m.d * dy) - m.f
    if (n === el) result = { x: Cx - w / 2, y: Cy - h / 2, width: w, height: h }
    // G <- G o F, F(p) = O + A(p - O) + t: translation G(O - A O + t)
    const Ox = Cx - dx, Oy = Cy - dy
    const tx = Ox - (m.a * Ox + m.c * Oy) + m.e, ty = Oy - (m.b * Ox + m.d * Oy) + m.f
    const ne = ga * tx + gc * ty + ge, nf = gb * tx + gd * ty + gf
    ;[ga, gb, gc, gd, ge, gf] = [la, lb, lc, ld, ne, nf]
  }
  if (result) return result
  // el itself is not transformed: its box through G
  const { w, h, cx, cy } = unmap(el, r, ga, gb, gc, gd)
  const [x, y] = inv(cx, cy)
  return { x: x - w / 2, y: y - h / 2, width: w, height: h }
}
