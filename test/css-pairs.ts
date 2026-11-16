// A stylesheet as single-selector rules ("@layer x / @media y | selector { declarations }"), to
// compare two stylesheets rule by rule whatever selectors each groups together.
export function cssRules(css: string): Set<string> {
  const out = new Set<string>()
  const walk = (text: string, context: string) => {
    let i = 0
    while (i < text.length) {
      const open = text.indexOf('{', i)
      if (open < 0) break
      const head = text.slice(i, open).trim()
      let depth = 1
      let j = open + 1
      for (; j < text.length && depth; j++) {
        const c = text[j]
        if (c === '"' || c === "'") {
          const end = text.indexOf(c, j + 1)
          j = end < 0 ? text.length : end
        } else if (c === '{') depth++
        else if (c === '}') depth--
      }
      const body = text.slice(open + 1, j - 1)
      if (head.startsWith('@') && /[{}]/.test(body)) walk(body, context + head + ' / ')
      else if (head.startsWith('@')) out.add(context + head + ' { ' + body.trim() + ' }')
      else for (const sel of splitTop(head)) out.add(context + '| ' + sel.trim() + ' { ' + body.trim() + ' }')
      i = j
    }
  }
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), '')
  return out
}

/** Split a selector list on its top-level commas. */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) out.push(s.slice(start, i)), (start = i + 1)
  }
  out.push(s.slice(start))
  return out
}

const STATES = /::?(?:hover|focus-visible|focus-within|focus|active|visited|link|checked|disabled|enabled|placeholder-shown|placeholder|before|after|marker|selection|backdrop|first-letter|first-line|-webkit-[\w-]+|-moz-[\w-]+|file-selector-button|target|popover-open|open|modal|indeterminate|invalid|valid|user-invalid|autofill|default|read-only|read-write|empty|scrollbar[\w-]*|thumb|track)(?![\w-])/g

/**
 * The rules of `whole` that are not in `part` and select an element of `root` (states and
 * pseudo-elements left out of the selector): what a stylesheet from a subset would lose.
 */
export function lostRules(whole: Set<string>, part: Set<string>, root: { querySelector(s: string): unknown }): string[] {
  const out: string[] = []
  for (const r of whole) {
    if (part.has(r) || !r.includes('| ')) continue
    const sel = r.slice(r.indexOf('| ') + 2, r.indexOf(' { ')).replace(STATES, '').replace(/:dir\(\w+\)/g, '').replace(/:(?:is|where)\(\s*(?:,\s*)*\)/g, '')
    try {
      if (root.querySelector(sel || '*')) out.push(r)
    } catch {
      // A selector the DOM cannot evaluate: lost when every component it names is on the page.
      const named = (attr: string) => [...sel.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, '').matchAll(new RegExp(attr + '="?([\\w-]+)', 'g'))].map((m) => `[${attr}="${m[1]}"]`)
      if ([...named('data-sem-c'), ...named('data-sem-theme')].every((s) => root.querySelector(s))) out.push('(unchecked) ' + r)
    }
  }
  return out
}
