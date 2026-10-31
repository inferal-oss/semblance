// The form of a SPARQL query and the variables it shows, read from its tokens (comments, strings
// and IRIs skipped): what a result view shows as columns, and what a run of a query (a view on
// request, src/view/runs.ts) writes as its result set's variables.
import type { Term } from '@rdfjs/types'
import { tokenizeSparql } from './sparql-tokens.ts'

/** The form of a query, read from its tokens (comments, strings and IRIs skipped). */
export function queryForm(query: string): 'SELECT' | 'CONSTRUCT' | 'DESCRIBE' | 'ASK' | undefined {
  for (const t of tokenizeSparql(query)) {
    if (t.kind === 'comment' || t.kind === 'iri' || t.kind === 'pname') continue
    for (const word of t.text.match(/[A-Za-z]+/g) ?? []) {
      const w = word.toUpperCase()
      if (w === 'SELECT' || w === 'CONSTRUCT' || w === 'DESCRIBE' || w === 'ASK') return w
      if (w !== 'PREFIX' && w !== 'BASE') return undefined
    }
  }
  return undefined
}

/** The variables a SELECT projects, in order; undefined for SELECT * (or when it can't tell). */
export function selectVariables(query: string): string[] | undefined {
  const tokens = tokenizeSparql(query).filter((t) => t.kind !== 'comment')
  let i = tokens.findIndex((t) => /\bSELECT\b/i.test(t.text) && t.kind !== 'string' && t.kind !== 'iri')
  if (i < 0) return undefined
  const vars: string[] = []
  let depth = 0
  let pendingAs = false
  for (i++; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.kind === 'var') {
      const name = t.text.slice(1)
      if ((depth === 0 || pendingAs) && !vars.includes(name)) vars.push(name)
      pendingAs = false
      continue
    }
    if (t.kind === 'keyword' || t.kind === 'text') {
      for (const m of t.text.matchAll(/\(|\)|\{|\*|[A-Za-z]+/g)) {
        const s = m[0]
        if (s === '(') depth++
        else if (s === ')') depth = Math.max(0, depth - 1)
        else if (s === '{') return vars.length ? vars : undefined
        else if (s === '*' && depth === 0) return undefined
        else if (/^AS$/i.test(s)) pendingAs = true
        else if (depth === 0 && /^(WHERE|FROM)$/i.test(s)) return vars.length ? vars : undefined
      }
    }
  }
  return vars.length ? vars : undefined
}

/**
 * The columns of a SELECT's rows: the variables it projects, in order (all of them, bound or not),
 * else (SELECT *) the variables its text names that some row binds; then any other bound one.
 */
export function resultColumns(query: string, rows: readonly Map<string, Term>[]): string[] {
  const declared = selectVariables(query)
  const bound = new Set(rows.flatMap((r) => [...r.keys()]))
  const shown = declared ? [...declared] : []
  if (!declared) for (const t of tokenizeSparql(query)) if (t.kind === 'var' && bound.has(t.text.slice(1)) && !shown.includes(t.text.slice(1))) shown.push(t.text.slice(1))
  for (const k of bound) if (!shown.includes(k)) shown.push(k)
  return shown
}
