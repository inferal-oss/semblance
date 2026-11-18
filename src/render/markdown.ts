// Markdown from a projection's RDF/HTML (an HtmlIndex), for readers that take Markdown (agents, the
// site's /llms/ pages): what a page shows, as headings, paragraphs, links, emphasis, code, lists,
// tables and quotes. It reads the rendered elements, so it needs no rendering of its own: every
// component that renders semantic HTML reads well, in every modality's SPARQL rule and function twin
// alike (they render the same elements).
//
// What a reader of the page does not see is left out: an element that is `hidden` or `aria-hidden`,
// a control (a button, a field, a tab: Markdown cannot act) with what names and describes it (its
// label, its keys hint), a graphic (svg). A link's note for a screen reader on how it opens (`.sem-sr`
// inside an `a`) is left out too: a Markdown link has no "new tab".
//
// Some of what controls hold is content all the same. A button in running text (a mention of a term)
// reads as its words. A field of code (a text area whose class names its language, `language-…`, as a
// `<code>`'s does: a code editor) reads as a code block of its text; a code block's language label
// (`.sem-language`, in it or beside it) is its fence's language. A tab panel reads under its tab's
// name, every panel of a tab list, shown or not: a document has no tabs to choose.
import type { HtmlIndex } from './html-index.ts'

export interface MarkdownOptions {
  /** Where a link goes in the Markdown, from its href (default: the href). `undefined` keeps its text without the link. */
  link?: (href: string) => string | undefined
  /**
   * The level the subtree's top headings take (default: their own): its headings move down together,
   * so that it sits under a heading of the page that holds it (a specimen under its section).
   */
  headings?: number
  /**
   * Read controls as their words (a button as its label, a field as its value, a choice as what is
   * chosen) rather than leaving them out: for a page whose subject they are (a gallery's specimen).
   */
  controls?: boolean
}

/** Elements that are not shown as content: controls, graphics and what is never rendered. */
const SKIP = new Set(['button', 'input', 'select', 'textarea', 'option', 'label', 'svg', 'script', 'style', 'template', 'noscript', 'head'])
/** What is left out when controls read as their words: what is never shown, graphics, a choice's other options. */
const SKIP_UNCONTROLLED = new Set(['option', 'datalist', 'svg', 'script', 'style', 'template', 'noscript', 'head'])
/** The elements a reader acts with: what describes one (aria-describedby) goes with it. */
const CONTROLS = new Set(['button', 'input', 'select', 'textarea'])
/** Roles of controls (on elements that are not controls by their tag). */
const CONTROL_ROLES = new Set(['tab', 'tablist', 'menu', 'menubar', 'listbox', 'option', 'toolbar', 'slider', 'spinbutton', 'switch', 'checkbox', 'radio', 'radiogroup', 'combobox'])
/** Elements that are blocks: what holds them is a block too. */
const BLOCKS = new Set([
  ...['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'form', 'fieldset', 'legend', 'address', 'hgroup'],
  ...['figure', 'figcaption', 'details', 'summary', 'dl', 'dt', 'dd', 'ul', 'ol', 'li', 'pre', 'table', 'blockquote', 'hr'],
  ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
])
const QUOTES = new Set(['status', 'alert', 'note'])

/** The Markdown of the element (or component) at `focus`: blocks separated by a blank line. */
export function toMarkdown(index: HtmlIndex, focus: string, opts: MarkdownOptions = {}): string {
  const root = index.resolve(focus)
  return root ? new Writer(index, opts, root).blocks(root).join('\n\n') : ''
}

class Writer {
  private readonly blocky = new Map<string, boolean>()
  /** The elements of the subtree by their id (a tab panel's name is its tab's). */
  private readonly byId = new Map<string, string>()
  /** The ids that describe a control (aria-describedby): its hint goes with it. */
  private readonly describing = new Set<string>()
  /** Each element's parent, in the subtree. */
  private readonly parent = new Map<string, string>()
  /** How many levels the headings move down. */
  private readonly shift: number
  constructor(
    private readonly index: HtmlIndex,
    private readonly opts: MarkdownOptions,
    root: string,
  ) {
    const levels: number[] = []
    const walk = (k: string) => {
      if (this.isText(k)) return
      const a = this.attrs(k)
      const id = a.get('id')
      if (id !== undefined) this.byId.set(id, k)
      if (CONTROLS.has(this.tag(k))) for (const d of (a.get('aria-describedby') ?? '').split(/\s+/)) if (d) this.describing.add(d)
      const h = /^h([1-6])$/.exec(this.tag(k))
      if (h) levels.push(Number(h[1]))
      for (const c of this.children(k)) {
        this.parent.set(c, k)
        walk(c)
      }
    }
    walk(root)
    this.shift = opts.headings !== undefined && levels.length ? Math.max(0, opts.headings - Math.min(...levels)) : 0
  }

  private children(k: string): string[] {
    return this.index
      .childrenOf(k)
      .map((slot) => this.index.resolve(slot))
      .filter((r): r is string => r !== undefined)
  }
  private attrs(k: string): Map<string, string> {
    return new Map(this.index.attributes(k))
  }
  private tag(k: string): string {
    return this.index.tagName(k) ?? ''
  }
  private isText(k: string): boolean {
    return this.index.nodes.get(k)?.cls === 'Text'
  }
  private classes(k: string): string[] {
    return (this.attrs(k).get('class') ?? '').split(/\s+/).filter(Boolean)
  }
  private role(k: string): string {
    return this.attrs(k).get('role') ?? ''
  }
  /** Whether a reader of the page sees the element (a tab panel: whichever tab is chosen). */
  private shown(k: string): boolean {
    if (this.isText(k)) return true
    if (this.codeField(k)) return true
    const a = this.attrs(k)
    const id = a.get('id')
    return (
      !(this.opts.controls ? SKIP_UNCONTROLLED : SKIP).has(this.tag(k)) &&
      !this.classes(k).includes('sem-language') &&
      (this.opts.controls || !CONTROL_ROLES.has(this.role(k))) &&
      (!a.has('hidden') || this.role(k) === 'tabpanel') &&
      a.get('aria-hidden') !== 'true' &&
      !(id !== undefined && this.describing.has(id)) &&
      !this.index.isSvg(k)
    )
  }
  /** The language a field of code names (a code editor's text area), if it is one. */
  private codeField(k: string): string | undefined {
    return this.tag(k) === 'textarea' ? this.languageClass(k) : undefined
  }
  private languageClass(k: string): string | undefined {
    return this.classes(k).find((c) => c.startsWith('language-'))?.slice('language-'.length)
  }
  /** Whether an element holds text of its own beside its elements: running text, whose buttons are words in it. */
  private prose(k: string): boolean {
    return !this.isText(k) && this.children(k).some((c) => this.isText(c) && /\S/.test(this.index.nodes.get(c)!.data ?? ''))
  }
  /** The name an element is given (aria-label, or the text of what aria-labelledby names). */
  private nameOf(k: string): string {
    const a = this.attrs(k)
    const by = (a.get('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => this.byId.get(id))
      .filter((r): r is string => r !== undefined)
      .map((r) => this.words(r))
      .join(' ')
    return (by || a.get('aria-label') || '').replace(/\s+/g, ' ').trim()
  }
  /** The text of an element, controls included (a tab's name). */
  private words(k: string): string {
    if (this.isText(k)) return this.index.nodes.get(k)!.data ?? ''
    if (this.attrs(k).get('aria-hidden') === 'true' || this.index.isSvg(k)) return ''
    return this.children(k).map((c) => this.words(c)).join('')
  }
  /** Whether a block element is under `k` (or is `k`). */
  private hasBlock(k: string): boolean {
    let b = this.blocky.get(k)
    if (b === undefined) {
      b = !this.isText(k) && this.shown(k) && (BLOCKS.has(this.tag(k)) || this.codeField(k) !== undefined || this.children(k).some((c) => this.hasBlock(c)))
      this.blocky.set(k, b)
    }
    return b
  }

  /** The blocks of an element in a block context. */
  blocks(k: string): string[] {
    if (!this.shown(k)) return []
    if (!this.hasBlock(k)) {
      const text = this.inline(k).trim()
      return text ? [paragraph(text)] : []
    }
    const tag = this.tag(k)
    const heading = /^h([1-6])$/.exec(tag)
    if (heading) {
      const text = this.flat(k)
      return text ? [`${'#'.repeat(Math.min(6, Number(heading[1]) + this.shift))} ${text}`] : []
    }
    if (tag === 'pre' || this.codeField(k)) return [this.fence(k)]
    if (tag === 'hr') return ['---']
    const role = this.role(k)
    if (role === 'tabpanel') {
      const inner = this.container(k)
      const name = this.nameOf(k)
      return inner.length && name && !inner[0]!.replace(/^#+ /, '').startsWith(markdownText(name)) ? [paragraph(`**${markdownText(name)}**`), ...inner] : inner
    }
    if (tag === 'ul' || tag === 'ol' || role === 'list') return this.list(k, tag === 'ol')
    if (tag === 'table') return this.table(k)
    if (tag === 'blockquote' || QUOTES.has(role)) {
      const inner = this.container(k)
      return inner.length ? [inner.join('\n\n').replace(/^/gm, '> ').replace(/^> $/gm, '>')] : []
    }
    if (tag === 'a') {
      // A link around blocks (a card): its first block carries the link.
      const inner = this.container(k)
      const href = this.href(k)
      if (!inner.length || href === undefined) return inner
      const [first, ...rest] = inner
      const h = /^(#+ )(.*)$/.exec(first!)
      return [h ? `${h[1]}[${h[2]}](${href})` : first!.includes('\n') ? first! : `[${first}](${href})`, ...rest]
    }
    return this.container(k)
  }

  /** Children in a block context: runs of inline content become paragraphs. */
  private container(k: string): string[] {
    const out: string[] = []
    let run: string[] = []
    const flush = () => {
      const text = join(run).trim()
      if (text) out.push(paragraph(text))
      run = []
    }
    for (const c of this.children(k)) {
      if (this.hasBlock(c)) {
        flush()
        out.push(...this.blocks(c))
      } else run.push(this.inline(c, false, this.prose(k)))
    }
    flush()
    return out
  }

  /** An element's inline Markdown (it holds no blocks); `inProse`: its parent is running text. */
  inline(k: string, inLink = false, inProse = false): string {
    const n = this.index.nodes.get(k)!
    if (n.cls === 'Text') return escape((n.data ?? '').replace(/\s+/g, ' '))
    const tag = this.tag(k)
    // A button in running text (a mention) is a word of it.
    if (inProse && tag === 'button' && this.attrs(k).get('aria-hidden') !== 'true' && !this.attrs(k).has('hidden'))
      return join(this.children(k).map((c) => this.inline(c, inLink, this.prose(k))))
    if (!this.shown(k)) return ''
    if (inLink && this.classes(k).includes('sem-sr')) return ''
    // A switch's or a check box's state, when controls read as their words.
    const checked = this.attrs(k).get('aria-checked')
    if (this.opts.controls && (checked === 'true' || checked === 'false')) {
      const rest = this.inlineOf(k, inLink)
      return rest ? `${checked === 'true' ? '☑' : '☐'} ${rest}` : ''
    }
    return this.inlineOf(k, inLink)
  }

  /** An element's own inline Markdown, by its tag. */
  private inlineOf(k: string, inLink: boolean): string {
    const tag = this.tag(k)
    const prose = this.prose(k)
    const inner = () => join(this.children(k).map((c) => this.inline(c, inLink || tag === 'a', prose)))
    switch (tag) {
      case 'br':
        return '\\\n'
      case 'input': {
        // Shown only when controls read as their words: what it holds, or a box's state.
        const a = this.attrs(k)
        const type = a.get('type') ?? 'text'
        if (type === 'hidden') return ''
        if (type === 'checkbox' || type === 'radio') return a.has('checked') ? '☑' : '☐'
        return markdownText(a.get('value') ?? '')
      }
      case 'select': {
        const chosen = this.children(k).filter((c) => this.tag(c) === 'option')
        const pick = chosen.find((c) => this.attrs(c).has('selected')) ?? chosen[0]
        return pick ? markdownText(this.words(pick)) : ''
      }
      case 'img': {
        const a = this.attrs(k)
        return a.get('src') ? `![${escape(a.get('alt') ?? '')}](${a.get('src')})` : ''
      }
      case 'code':
      case 'kbd':
      case 'samp':
        return codeSpan(this.raw(k).replace(/\s+/g, ' '))
      case 'strong':
      case 'b':
        return wrap('**', inner())
      case 'em':
      case 'i':
        return wrap('*', inner())
      case 'a': {
        // A link that shows no text (an icon) reads as its name.
        const text = inner().trim() || markdownText(this.attrs(k).get('aria-label') ?? '')
        const href = this.href(k)
        return !text || href === undefined ? text : `[${text}](${href})`
      }
      default:
        return this.named(k, inner())
    }
  }

  /** The element as one line of inline Markdown, its blocks run together (a heading, a cell). */
  private flat(k: string): string {
    return this.hasBlock(k) ? join(this.children(k).map((c) => this.flat(c))).trim() : this.inline(k).trim()
  }

  /**
   * What an element shows, after what its name says beyond that: a name that ends with the shown text
   * says the rest first (a diff line named "Added: …", whose sign is hidden from a screen reader).
   */
  private named(k: string, md: string): string {
    const name = this.attrs(k).get('aria-label')?.replace(/\s+/g, ' ').trim()
    const shown = this.raw(k).replace(/\s+/g, ' ').trim()
    if (!name || !shown || name === shown || !name.endsWith(shown)) return md
    const more = name.slice(0, -shown.length).trim()
    return more ? `${markdownText(more)} ${md}` : md
  }

  private href(k: string): string | undefined {
    const href = this.attrs(k).get('href')
    if (href === undefined) return undefined
    const to = this.opts.link ? this.opts.link(href) : href
    return to === undefined ? undefined : /[\s()<>]/.test(to) ? `<${to.replace(/[<>]/g, encodeURIComponent)}>` : to
  }

  /** The text of an element as it is (code), shown parts only. */
  private raw(k: string): string {
    if (this.isText(k)) return this.index.nodes.get(k)!.data ?? ''
    if (!this.shown(k)) return ''
    return this.tag(k) === 'br' ? '\n' : this.children(k).map((c) => this.raw(c)).join('')
  }

  private fence(k: string): string {
    // The code block's language, as its label (in it or beside it) or its code's class names it.
    const isLabel = (c: string) => !this.isText(c) && this.classes(c).includes('sem-language')
    const parent = this.parent.get(k)
    const label = this.children(k).find(isLabel) ?? (parent !== undefined ? this.children(parent).find(isLabel) : undefined)
    const language =
      (label ? this.index.childrenOf(label).map((c) => this.index.nodes.get(c)?.data ?? '').join('') : '') ||
      this.languageClass(k) ||
      this.children(k)
        .map((c) => (this.isText(c) ? undefined : this.languageClass(c)))
        .find(Boolean) ||
      ''
    const body = this.raw(k).replace(/^\n+|\s+$/g, '')
    const ticks = '`'.repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)))
    return `${ticks}${language.trim().toLowerCase().replace(/\s+/g, '-')}\n${body}\n${ticks}`
  }

  private list(k: string, ordered: boolean): string[] {
    const items = this.children(k).filter((c) => this.shown(c) && (!this.isText(c) || (this.index.nodes.get(c)!.data ?? '').trim()))
    const lines = items
      .map((item, i) => {
        const marker = ordered ? `${i + 1}. ` : '- '
        const inner = this.tag(item) === 'li' || this.attrs(item).get('role') === 'listitem' ? this.container(item) : this.blocks(item)
        if (!inner.length) return ''
        inner[0] = this.named(item, inner[0]!)
        const pad = ' '.repeat(marker.length)
        // Every line after the first under the item's text (a blank line stays blank).
        return marker + inner.join('\n\n').replace(/\n(?!\n)/g, '\n' + pad)
      })
      .filter(Boolean)
    if (!lines.length) return []
    // A tight list while every item is one block; loose (a blank line between) otherwise.
    return [lines.join(lines.some((l) => l.includes('\n\n')) ? '\n\n' : '\n')]
  }

  private table(k: string): string[] {
    const rows: string[][] = []
    const walk = (n: string) => {
      for (const c of this.children(n)) {
        if (!this.shown(c) || this.isText(c)) continue
        const tag = this.tag(c)
        if (tag === 'tr') rows.push(this.children(c).filter((d) => ['td', 'th'].includes(this.tag(d)) && this.shown(d)).map((d) => this.flat(d).replace(/\|/g, '\\|').replace(/\\\n/g, ' ')))
        else if (tag !== 'caption') walk(c)
      }
    }
    walk(k)
    if (!rows.length) return []
    const width = Math.max(...rows.map((r) => r.length))
    const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`
    const caption = this.children(k).find((c) => this.tag(c) === 'caption')
    return [...(caption ? [paragraph(this.flat(caption))] : []), [line(rows[0]!), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')]
  }
}

/** Inline pieces, a space between two that the page shows apart (its words), none before punctuation. */
function join(parts: string[]): string {
  let out = ''
  for (const p of parts) {
    if (!p) continue
    if (out && !/\s$/.test(out) && !/[(\[/]$/.test(out) && !/^[\s.,;:!?)\]]/.test(p)) out += ' '
    out += p
  }
  return out.replace(/ {2,}/g, ' ')
}

/** Text that reads as itself in Markdown: its emphasis, code, link and HTML characters escaped. */
export function markdownText(s: string): string {
  return escape(s.replace(/\s+/g, ' '))
}

function escape(s: string): string {
  return s.replace(/[\\`*[\]]/g, '\\$&').replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m) => m.replace('_', '\\_')).replace(/<(?=[A-Za-z/!?])/g, '\\<')
}

/** A paragraph that does not start as another block would (a heading, a list item, a quote). */
function paragraph(text: string): string {
  return text.replace(/^(#{1,6}\s|>|[-+*]\s|\d+[.)]\s|=+\s*$|-+\s*$)/, '\\$1')
}

function wrap(mark: string, s: string): string {
  const t = s.trim()
  return t ? `${mark}${t}${mark}` : ''
}

function codeSpan(s: string): string {
  const t = s.trim()
  if (!t) return ''
  const ticks = '`'.repeat(Math.max(1, ...[...t.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return ticks.length > 1 || t.startsWith('`') || t.endsWith('`') ? `${ticks} ${t} ${ticks}` : `${ticks}${t}${ticks}`
}
