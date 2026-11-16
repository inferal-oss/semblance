/**
 * Zero-length path steps inside EXISTS that Oxigraph evaluates by scanning the store (#446, #451).
 *
 * Inside `EXISTS` / `NOT EXISTS`, Oxigraph 0.5 evaluates the zero-length step of a `*` or `?` path
 * whose start is not bound from outside the EXISTS by scanning every term of the store: tens to
 * hundreds of ms per evaluation on the demo store, however few the matches. Such a step is
 *  - a later step of a sequence (`p/q*`, `p/(q|r)*`, and the same followed by more steps), whose start is the sequence's own
 *    intermediate node, unless the path ends in a constant; or
 *  - a whole `*` / `?` path between two variables the EXISTS binds itself (`?l rdf:rest* ?s` after
 *    `$this c:legend ?l`). From or to a constant, `$this` or a variable of the enclosing query (which
 *    Oxigraph substitutes) it is fast.
 * `p/q*` is the same path as `(p|p/q+)`, which is fast on every engine.
 */
export interface ZeroStep { at: number; line: number; triple: string; path: string; pathAt: number; later: boolean }

/** The `{ … }` body of each EXISTS in `text`, with its offset. */
function existsBodies(text: string): { start: number; body: string }[] {
  const out: { start: number; body: string }[] = []
  for (const m of text.matchAll(/\bEXISTS\s*\{/g)) {
    const start = m.index! + m[0].length
    let depth = 1, j = start
    while (depth && j < text.length) depth += text[j] === '{' ? 1 : text[j] === '}' ? -1 : 0, j++
    out.push({ start, body: text.slice(start, j - 1) })
  }
  return out
}

/** The query (a `"""…"""` literal, or the whole text) around offset `at`. */
function queryAround(text: string, at: number): { start: number; end: number } {
  const quotes = [...text.matchAll(/"""/g)].map((m) => m.index!)
  for (let i = 0; i + 1 < quotes.length; i += 2) if (quotes[i]! < at && at < quotes[i + 1]!) return { start: quotes[i]!, end: quotes[i + 1]! }
  return { start: 0, end: text.length }
}

/** A path's top-level steps (split on `/` outside parentheses). */
export function steps(path: string): string[] {
  const out: string[] = []
  let depth = 0, cur = ''
  for (const ch of path) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === '/' && depth === 0) out.push(cur), cur = ''
    else cur += ch
  }
  return [...out, cur]
}

const zeroStep = (step: string) => /[\w>)][*?]$/.test(step)
const hasZeroStep = (path: string) => /[\w>)][*?](?![\w])/.test(path)

/** Every zero-length path step inside an EXISTS of `text` that Oxigraph evaluates with a store scan. */
export function zeroStepsInExists(text: string): ZeroStep[] {
  const found: ZeroStep[] = []
  const all = existsBodies(text)
  for (const { start, body: whole } of all) {
    // Each triple belongs to its innermost EXISTS: blank the nested ones (keeping offsets).
    let body = whole
    for (const n of all) if (n.start > start && n.start < start + whole.length) {
      const a = n.start - start, b = a + n.body.length
      body = body.slice(0, a) + ' '.repeat(b - a) + body.slice(b)
    }
    // subject, path, object: the path is a token with a `*` or `?` modifier, between two terms.
    const triple = /([?$]\w+|<[^>\s]*>|[\w-]*:[\w-]*|;)\s+((?:[^\s{}.;,"]|\.(?=\w))+)\s+([?$]\w+|<[^>\s]*>|[\w-]*:[\w-]*|"[^"]*")/g
    for (let m; (m = triple.exec(body)); ) {
      const [, subject0, path, object] = m as unknown as [string, string, string, string]
      triple.lastIndex = m.index + subject0.length + 1
      if (!hasZeroStep(path) || path.startsWith('?') || path.startsWith('$')) continue
      let subject = subject0
      if (subject === ';') {
        // The subject of a `;` list: the term that begins its triple.
        const before = body.slice(0, m.index)
        const begin = Math.max(before.lastIndexOf(' . '), before.lastIndexOf('{'), before.lastIndexOf('.\n'), -1)
        subject = before.slice(begin + 2).trim().split(/\s+/)[0] ?? ''
      }
      const variableEnd = /^[?$]/.test(object)
      const parts = steps(path)
      const later = parts.slice(1).some(zeroStep) && variableEnd
      let inner = false
      if (parts.length === 1 && zeroStep(parts[0]!)) {
        // From a variable the EXISTS binds itself (it occurs nowhere else in the query) to another.
        const q = queryAround(text, start)
        const outside = text.slice(q.start, start) + text.slice(start + whole.length, q.end)
        const own = (term: string) => /^\?/.test(term) && !new RegExp('[?$]' + term.slice(1) + '\\b').test(outside)
        inner = own(subject) && own(object)
      }
      if (later || inner) {
        const at = start + m.index
        found.push({ at, line: text.slice(0, at).split('\n').length, triple: `${subject} ${path} ${object}`, path, pathAt: start + m.index + m[0].indexOf(path, subject0.length), later })
      }
    }
  }
  return found
}
