// A whole HTML document from a template (the client build's index.html) and a rendering
// (renderToString): the root's HTML in the mount element, marked for the client to take over, the
// document's language, direction and attributes on <html>, the stylesheet (a file the client does
// not compile again, or inline), the script that puts back what the visitor chose (src/web/remembered.ts)
// and the one that marks the viewer's platform (src/web/platform.ts: the key hints' spelling), both
// before the first paint, and the one that keeps what the visitor does until the client is ready
// (src/web/takeover.ts). Platform-neutral string work: used by the static build, the request handler
// and anyone's own server.
import { CAPTURE_SCRIPT, SSR_ATTRIBUTE, STYLES_ATTRIBUTE } from '../web/takeover.ts'
import { PLATFORM_SCRIPT } from '../web/platform.ts'
import { COLOR_SCHEME_META, rememberedScript } from '../web/remembered.ts'
import { documentScheme, firstPaintPlan } from './remembered.ts'
import type { Rendered } from './render.ts'

export interface DocumentOptions {
  /** The mount element's id in the template (default "app"). */
  mount?: string
  /** The stylesheet: a URL to link (the server or build writes the CSS there), or inline (one self-contained file). Default inline. */
  stylesheet?: { href: string } | 'inline' | 'none'
  /** More attributes for <html> (a color scheme's hook). */
  attributes?: Record<string, string>
  /** More for <head> (preloads, a canonical link): HTML, added before </head>. */
  head?: string
  /** Keep events until the client takes over (default true). */
  capture?: boolean
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** Set attributes on the template's <html> element (replacing those it has of the same name). */
function htmlAttributes(doc: string, attrs: Record<string, string>): string {
  return doc.replace(/<html\b([^>]*)>/i, (_, own: string) => {
    let rest = own
    for (const name of Object.keys(attrs)) rest = rest.replace(new RegExp(`\\s${name}(?:=("[^"]*"|'[^']*'|[^\\s>]*))?`, 'i'), '')
    return `<html${rest}${Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')}>`
  })
}

/**
 * What the visitor chose, put back ahead of the template's first stylesheet (a script waits for those
 * before it), with the color scheme the browser paints the empty page in meanwhile.
 */
function rememberedHead(doc: string, remembered: Rendered['remembered'], mount: string, attributes: Record<string, string>): string {
  const plan = firstPaintPlan(remembered, mount, attributes)
  const scheme = documentScheme(remembered, attributes)
  const meta = scheme && !COLOR_SCHEME_META.test(doc) ? `<meta name="color-scheme" content="${escapeAttr(scheme)}">` : ''
  const script = plan ? `<script>${rememberedScript(plan)}</script>` : ''
  if (!meta && !script) return doc
  const head = /<head\b[^>]*>/i.exec(doc)
  if (!head) return doc
  const from = head.index + head[0].length
  const first = doc.slice(from).search(/<(?:link|style|script)\b|<\/head>/i)
  const at = first < 0 ? from : from + first
  return doc.slice(0, at) + meta + script + doc.slice(at)
}

/**
 * The document around the root's HTML: everything before it (up to the mount element's opening
 * tag) and after it. The head can go out before the projection is done (renderToStream).
 */
export function documentParts(template: string, rendered: Pick<Rendered, 'css' | 'lang' | 'dir'> & Partial<Pick<Rendered, 'remembered'>>, opts: DocumentOptions = {}): [string, string] {
  const mount = opts.mount ?? 'app'
  let doc = htmlAttributes(template, { lang: rendered.lang, dir: rendered.dir, ...opts.attributes })
  const sheet = opts.stylesheet ?? 'inline'
  const styles =
    sheet === 'none' ? '' : sheet === 'inline' ? (rendered.css ? `<style ${STYLES_ATTRIBUTE}>${rendered.css.replace(/<\/style/gi, '<\\/style')}</style>` : '') : `<link rel="stylesheet" href="${escapeAttr(sheet.href)}" ${STYLES_ATTRIBUTE}>`
  // Functions, so `$` in what is inserted is not read as a replacement pattern. The platform is
  // marked ahead of the styles that read it, so no key hint is painted in the other spelling first.
  doc = doc.replace(/<\/head>/i, () => `<script>${PLATFORM_SCRIPT}</script>${styles}${opts.head ?? ''}</head>`)
  doc = rememberedHead(doc, rendered.remembered ?? [], mount, opts.attributes ?? {})
  const open = new RegExp(`<div id="${mount}"([^>]*)>\\s*</div>`, 'i')
  const m = open.exec(doc)
  if (!m) throw new Error(`The template has no empty <div id="${mount}"></div> to render into`)
  // Before the mount element: what is clicked while the rest of the HTML streams in is kept too.
  const capture = opts.capture === false ? '' : `<script>${CAPTURE_SCRIPT}</script>`
  return [doc.slice(0, m.index) + `${capture}<div id="${mount}"${m[1]} ${SSR_ATTRIBUTE}>`, '</div>' + doc.slice(m.index + m[0].length)]
}

/** The document: `template` with `rendered` in its mount element. */
export function renderDocument(template: string, rendered: Pick<Rendered, 'html' | 'css' | 'lang' | 'dir'> & Partial<Pick<Rendered, 'remembered'>>, opts: DocumentOptions = {}): string {
  const [before, after] = documentParts(template, rendered, opts)
  return before + rendered.html + after
}
