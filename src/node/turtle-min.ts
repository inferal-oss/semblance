// Turtle without its comments and indentation, for a bundle (the Vite plugin, src/node/vite.ts):
// the same triples, about a fifth fewer bytes over the wire. Strings and IRIs stay exactly as
// they are (a rule's SPARQL is a string: its comments are data, shown in the Reference).
export function minifyTurtle(t: string): string {
  let out = ''
  let i = 0
  while (i < t.length) {
    const c = t[i]!
    if (c === '"' || c === "'") {
      const q = t.startsWith(c.repeat(3), i) ? c.repeat(3) : c
      let j = i + q.length
      while (j < t.length && !t.startsWith(q, j)) j += t[j] === '\\' ? 2 : 1
      out += t.slice(i, j + q.length)
      i = j + q.length
      continue
    }
    if (c === '<') {
      const j = t.indexOf('>', i)
      if (j > 0 && !/\s/.test(t.slice(i, j))) {
        out += t.slice(i, j + 1)
        i = j + 1
        continue
      }
    }
    if (c === '#') {
      while (i < t.length && t[i] !== '\n') i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i
      while (j < t.length && (t[j] === ' ' || t[j] === '\t' || t[j] === '\n' || t[j] === '\r')) j++
      out += t.slice(i, j).includes('\n') ? '\n' : ' '
      i = j
      continue
    }
    out += c
    i++
  }
  return out.replace(/^\n/, '')
}
