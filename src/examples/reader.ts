// Function twin of the reader example's rule (demo/gallery/_ex-reader.ttl): the same triples as
// rd:SchematicRendering-sparql, for stores without SPARQL.
import type { NamedNode } from '@rdfjs/types'
import type { FnRule } from '../engine/context.ts'
import { C, H, SEM } from '../ns.ts'

const RD = 'https://semblance.dev/demo/reader#'
const encodeForUri = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())

/** The viewport to scale (its own size as the view box) and a shadow per shown component. */
const schematic: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const vw = ctx.object(focus, RD + 'viewWidth')?.value
  const vh = ctx.object(focus, RD + 'viewHeight')?.value
  const children: NamedNode[] = []
  if (vw !== undefined && vh !== undefined) {
    const svg = o.svg('svg', 'Svg', { viewBox: `0 0 ${vw} ${vh}`, role: 'img', 'aria-label': ctx.object(focus, C.label)?.value ?? '' })
    const place = (n: NamedNode, key: string) => o.t(svg, H.hasChild, n).t(n, SEM.orderKey, key)
    place(o.svg('frame', 'Rect', { class: 'ex-schematic-viewport', width: vw, height: vh }), '0')
    const size = Math.round(Number(vw) / 32)
    for (const shadow of ctx.objects(focus, RD + 'shadow')) {
      if (shadow.termType !== 'NamedNode') continue
      const read = (p: string) => ctx.object(shadow, RD + p)?.value
      const [name, x, y, w, h] = ['name', 'x', 'y', 'width', 'height'].map(read)
      if (name === undefined || x === undefined || y === undefined || w === undefined || h === undefined) continue
      const slug = encodeForUri(name)
      // The label at the top of the shadow's part in the viewport.
      const rect = o.svg(`r-${slug}`, 'Rect', { x, y, width: w, height: h })
      const text = o.svg(`t-${slug}`, 'Text', { x: Math.max(Number(x), 0) + Math.floor(size / 2), y: Math.max(Number(y), 0) + Math.floor((size * 3) / 2), 'font-size': size }, [o.text(`t-${slug}-data`, name)])
      place(o.svg(`g-${slug}`, 'G', { class: 'ex-schematic-shadow' }, [rect, text]), `1 ${name}`)
    }
    children.push(svg)
  }
  children.push(o.el('caption', 'Span', { class: 'ex-schematic-caption' }, [o.text('caption-text', vw !== undefined && vh !== undefined ? `Viewport ${vw} × ${vh}` : 'Not measured yet.')]))
  o.renders(o.el('root', 'Div', {}, children))
  return o.quads
}

export const readerFunctions: Record<string, FnRule> = {
  'reader:schematic': schematic,
}
