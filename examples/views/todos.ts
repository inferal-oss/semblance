// The views the example keeps over the todo store (examples/remote/: a SourceServer with three
// todos): the open todos in the order they were made, and how many are done and open. Plain SPARQL
// over the store's own vocabulary: no ontology, no components.
import type { Pattern, ViewHandle, Views } from '@inferal-oss/semblance/views'

export const EX = 'https://example.org/remote#'

/** The part of the store the page follows: every todo. */
export const patterns: Pattern[] = [{ class: EX + 'Todo' }]

export interface TodoViews {
  open: ViewHandle
  counts: ViewHandle
}

export function todoViews(views: Views): TodoViews {
  const prefix = `PREFIX ex: <${EX}>\n`
  return {
    open: views.select(
      EX + 'open',
      prefix + `SELECT ?todo ?label ?created WHERE { ?todo a ex:Todo ; rdfs:label ?label ; ex:created ?created FILTER NOT EXISTS { ?todo ex:done true } } ORDER BY ?created`,
    ),
    counts: views.select(EX + 'counts', prefix + `SELECT ?done (COUNT(?todo) AS ?n) WHERE { ?todo a ex:Todo ; ex:done ?done } GROUP BY ?done`),
  }
}
