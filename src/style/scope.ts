// Scoping authored styles to the authored box (docs/SAFETY.md): the element that holds authored
// content - a live example's sandbox, an authored mount, an authored page rendered on the server -
// carries BOX_ATTRIBUTE, and the style rules its graphs add are rewritten so that each selector
// starts at that element. Keyframes it adds get a name of their own in the scope, so they redefine
// nothing outside it. One function for every place authored content renders.

/** The attribute of the authored box (a live example's sandbox, an authored mount element). */
export const BOX_ATTRIBUTE = 'data-sem-sandbox'
/** The selector of every authored box: the trusted rule that contains it (ontology/layers/safety.ttl) selects it so. */
const BOX = `[${BOX_ATTRIBUTE}]`

/** The selector of one authored box. */
export const boxSelector = (id: string): string => `[${BOX_ATTRIBUTE}="${id.replace(/["\\]/g, '')}"]`

/**
 * The rules of `css` (compileStyles' output) that `site` does not have, each selector started at
 * `scope` (a selector that already is `:root` or the box styles `scope` itself; one that starts at a
 * sibling, or names `&` or `:scope`, styles nothing and is left out), in their cascade layers and
 * media conditions; and the keyframes it adds, renamed for the scope, with the animations of those
 * rules that name them. With `site` empty, the whole of `css` is scoped.
 */
export function scopedCss(css: string, site: string, scope: string): string {
  const known = siteKeys(site)
  const suffix = '__' + scope.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  const renamed = new Map<string, string>()
  const frames: string[] = []
  const layers: string[] = []
  for (const item of items(css)) {
    if (item.body === undefined) continue
    const keyframes = /^@keyframes\s+(\S+)$/.exec(item.prelude)
    if (keyframes) {
      if (known.has(keyKeyframes(item.prelude, item.body))) continue
      const name = keyframes[1]! + suffix
      renamed.set(keyframes[1]!, name)
      frames.push(`@keyframes ${name} {${item.body}}`)
    }
  }
  for (const item of items(css)) {
    const layer = /^@layer\s+(sem\.\w+)$/.exec(item.prelude)?.[1]
    if (!layer || item.body === undefined) continue
    const plain: string[] = []
    const media = new Map<string, string[]>()
    for (const { condition, prelude, body } of rules(item.body)) {
      if (known.has(keyRule(layer, condition, prelude, body))) continue
      const selectors = splitSelectors(prelude).flatMap((s) => scopeSelector(s, scope))
      if (!selectors.length) continue
      const rule = `${selectors.join(', ')} { ${rename(body.trim(), renamed)} }`
      if (!condition) plain.push('  ' + rule)
      else media.set(condition, [...(media.get(condition) ?? []), '    ' + rule])
    }
    const sized = [...media].map(([condition, rs]) => `  @media ${condition} {\n${rs.join('\n')}\n  }`)
    if (plain.length || sized.length) layers.push(`@layer ${layer} {\n${[...plain, ...sized].join('\n')}\n}`)
  }
  const out = [...frames, ...layers]
  return out.length ? ['@layer sem.tokens, sem.hooks, sem.components, sem.variants, sem.intents;', ...out].join('\n\n') : ''
}

/** One selector of a list, started at the scope; none when it would reach outside it. */
function scopeSelector(selector: string, scope: string): string[] {
  if (/^[+~]/.test(selector) || /&|:scope(?![\w-])/i.test(selector)) return []
  if (selector === BOX) return [scope]
  if (/^:root(?![\w-])/i.test(selector)) return [scope + selector.slice(5)]
  return [`${scope} ${selector}`]
}

/** The names of renamed keyframes, renamed where an animation names them. */
function rename(body: string, renamed: Map<string, string>): string {
  if (!renamed.size) return body
  return body.replace(/(^|;\s*)(animation(?:-name)?\s*:)([^;]*)/gi, (_, before: string, property: string, value: string) =>
    before + property + value.replace(/-?[A-Za-z_][A-Za-z0-9_-]*/g, (name) => renamed.get(name) ?? name),
  )
}

const keyRule = (layer: string, condition: string, prelude: string, body: string) => `${layer}\u0000${condition}\u0000${prelude}{${body.trim()}}`
const keyKeyframes = (prelude: string, body: string) => `\u0000${prelude}{${body.trim()}}`

// The site's sheet is the same for every sandbox of a page: read once.
let lastSite: string | undefined
let lastKeys = new Set<string>()
function siteKeys(site: string): Set<string> {
  if (site === lastSite) return lastKeys
  const keys = new Set<string>()
  for (const item of items(site)) {
    if (item.body === undefined) continue
    if (item.prelude.startsWith('@keyframes')) keys.add(keyKeyframes(item.prelude, item.body))
    const layer = /^@layer\s+(sem\.\w+)$/.exec(item.prelude)?.[1]
    if (layer) for (const r of rules(item.body)) keys.add(keyRule(layer, r.condition, r.prelude, r.body))
  }
  lastSite = site
  lastKeys = keys
  return keys
}

/** The style rules of a layer's body, with the media condition each is under ('' for none). */
function rules(body: string): { condition: string; prelude: string; body: string }[] {
  return items(body).flatMap((item) => {
    if (item.body === undefined) return []
    const media = /^@media\s+([\s\S]+)$/.exec(item.prelude)
    if (!media) return [{ condition: '', prelude: item.prelude, body: item.body }]
    return items(item.body).flatMap((r) => (r.body === undefined ? [] : [{ condition: media[1]!, prelude: r.prelude, body: r.body }]))
  })
}

/** The statements and blocks of a list of rules: `prelude;` or `prelude { body }`, strings read whole. */
function items(text: string): { prelude: string; body?: string }[] {
  const out: { prelude: string; body?: string }[] = []
  let start = 0
  for (let i = 0; i < text.length; ) {
    const ch = text[i]
    if (ch === '"' || ch === "'") i = stringEnd(text, i)
    else if (ch === ';') {
      const prelude = text.slice(start, i).trim()
      if (prelude) out.push({ prelude })
      start = ++i
    } else if (ch === '{') {
      const close = blockEnd(text, i)
      out.push({ prelude: text.slice(start, i).trim(), body: text.slice(i + 1, close) })
      start = i = close + 1
    } else i++
  }
  return out
}

/** The index after the string opened at `i` (its end, when it is not closed). */
function stringEnd(text: string, i: number): number {
  const quote = text[i]
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++
    else if (text[j] === quote) return j + 1
  }
  return text.length
}

/** The index of the `}` that closes the block opened at `i`. */
function blockEnd(text: string, i: number): number {
  let depth = 0
  for (let j = i; j < text.length; ) {
    const ch = text[j]
    if (ch === '"' || ch === "'") {
      j = stringEnd(text, j)
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return j
    j++
  }
  return text.length
}

/** Split a selector list on its top-level commas (not those inside :is(), :not(), [attr="a,b"]). */
export function splitSelectors(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(list.slice(start).trim())
  return out.filter(Boolean)
}
