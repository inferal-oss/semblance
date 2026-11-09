// An element's content attributes, as the index has them, in React's naming: what React needs to
// write the same attribute back (className for class, tabIndex for tabindex, a style object for a
// style string, true for a boolean attribute present with no value).

/** HTML attributes React spells otherwise than the attribute itself (lower-case in HTML). */
const RENAMED: Record<string, string> = {
  class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', minlength: 'minLength',
  colspan: 'colSpan', rowspan: 'rowSpan', contenteditable: 'contentEditable', spellcheck: 'spellCheck', autocomplete: 'autoComplete',
  autofocus: 'autoFocus', autoplay: 'autoPlay', autocapitalize: 'autoCapitalize', crossorigin: 'crossOrigin', datetime: 'dateTime',
  enctype: 'encType', formaction: 'formAction', formenctype: 'formEncType', formmethod: 'formMethod', formnovalidate: 'formNoValidate',
  formtarget: 'formTarget', frameborder: 'frameBorder', inputmode: 'inputMode', enterkeyhint: 'enterKeyHint', novalidate: 'noValidate',
  playsinline: 'playsInline', srcset: 'srcSet', srcdoc: 'srcDoc', srclang: 'srcLang', usemap: 'useMap', accesskey: 'accessKey',
  allowfullscreen: 'allowFullScreen', cellpadding: 'cellPadding', cellspacing: 'cellSpacing', charset: 'charSet', hreflang: 'hrefLang',
  referrerpolicy: 'referrerPolicy', nomodule: 'noModule', fetchpriority: 'fetchPriority', popovertarget: 'popoverTarget',
  popovertargetaction: 'popoverTargetAction', itemprop: 'itemProp', itemscope: 'itemScope', itemtype: 'itemType', itemid: 'itemID',
  itemref: 'itemRef', marginheight: 'marginHeight', marginwidth: 'marginWidth', datafld: 'dataFld', 'accept-charset': 'acceptCharset',
  'http-equiv': 'httpEquiv', 'xlink:href': 'xlinkHref', 'xml:lang': 'xmlLang', 'xml:space': 'xmlSpace',
}

/** Boolean attributes: present (any value) is true. */
const BOOLEAN = new Set([
  'disabled', 'checked', 'hidden', 'readonly', 'required', 'multiple', 'selected', 'autofocus', 'open', 'inert', 'novalidate',
  'formnovalidate', 'allowfullscreen', 'async', 'defer', 'controls', 'loop', 'muted', 'playsinline', 'reversed', 'default',
  'itemscope', 'nomodule', 'autoplay',
])

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** A style attribute's declarations as React's style object (custom properties kept as they are). */
export function styleObject(css: string): Record<string, string> {
  const out: Record<string, string> = {}
  let depth = 0
  let quote = ''
  let start = 0
  const take = (end: number) => {
    const decl = css.slice(start, end)
    const colon = decl.indexOf(':')
    if (colon > 0) {
      const name = decl.slice(0, colon).trim()
      const value = decl.slice(colon + 1).trim()
      if (name && value) out[name.startsWith('--') ? name : camel(name.startsWith('-ms-') ? name.slice(1) : name)] = value
    }
    start = end + 1
  }
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!
    if (quote) {
      if (c === quote && css[i - 1] !== '\\') quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ';' && depth === 0) take(i)
  }
  take(css.length)
  return out
}

/** The name React gives an attribute (aria-* and data-* stay as they are; other hyphenated names are camelCased). */
export function propName(attribute: string): string {
  const renamed = RENAMED[attribute]
  if (renamed) return renamed
  if (attribute.startsWith('aria-') || attribute.startsWith('data-') || !attribute.includes('-')) return attribute
  return camel(attribute)
}

/**
 * Attributes as React props. For a form control the value and checked state are its initial ones
 * (defaultValue, defaultChecked): what it shows follows the graph through the adapter, as in the
 * DOM renderer, so a field being typed in is never reset by React.
 */
export function reactAttributes(attributes: Iterable<[string, string]>, tag?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const control = tag === 'input' || tag === 'textarea' || tag === 'select'
  const custom = tag?.includes('-')
  for (const [name, value] of attributes) {
    // A custom element takes its attributes as they are (React 19 writes them so).
    if (custom) out[name === 'class' ? 'className' : name] = value
    else if (name === 'style') out.style = styleObject(value)
    else if (control && name === 'value') out.defaultValue = value
    else if (control && name === 'checked') out.defaultChecked = true
    else if (BOOLEAN.has(name)) out[propName(name)] = true
    else out[propName(name)] = value
  }
  return out
}
