import type { HtmlIndex } from './html-index.ts'

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;')

/** Static HTML for a component instance (server-side rendering, tests). */
export function toHTML(index: HtmlIndex, focus: string): string {
  const root = index.resolve(focus)
  return root ? node(index, root) : ''
}

function node(index: HtmlIndex, k: string): string {
  const n = index.nodes.get(k)!
  if (n.cls === 'Text') return escapeText(n.data ?? '')
  const tag = index.tagName(k) ?? 'sem-unknown'
  const attrs = index.attributes(k).map(([name, v]) => (v === '' ? ` ${name}` : ` ${name}="${escapeAttr(v)}"`))
  const open = `<${tag}${attrs.join('')}>`
  if (index.isVoid(k)) return open
  const inner = index
    .childrenOf(k)
    .map((slot) => index.resolve(slot))
    .filter((r): r is string => r !== undefined)
    .map((r) => node(index, r))
    .join('')
  return `${open}${inner}</${tag}>`
}

const BLOCK = new Set(['div', 'p', 'ul', 'ol', 'li', 'pre', 'section', 'header', 'footer', 'main', 'form'])

/** Plain-text reading of a (typically text-modality) projection: blocks become lines. */
export function toText(index: HtmlIndex, focus: string): string {
  const lines: string[] = []
  let line = ''
  const flush = () => {
    if (line.length) lines.push(line)
    line = ''
  }
  const walk = (k: string) => {
    const n = index.nodes.get(k)!
    if (n.cls === 'Text') {
      if (line.length && !line.endsWith(' ')) line += ' '
      line += n.data ?? ''
      return
    }
    const block = BLOCK.has(index.tagName(k) ?? '')
    if (block) flush()
    for (const slot of index.childrenOf(k)) {
      const r = index.resolve(slot)
      if (r) walk(r)
    }
    if (block) flush()
  }
  const root = index.resolve(focus)
  if (root) walk(root)
  flush()
  return lines.join('\n')
}
