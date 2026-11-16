// Turtle into a store's terms, apart from the runtime (src/runtime.ts re-exports it), so that views
// on their own (src/views/) parse without the rule engine.
import type { Quad, Term } from '@rdfjs/types'
import { Parser } from 'n3'
import type { GraphStore } from './store/types.ts'

/** Graphs parsed by parseTurtle: each one's blank nodes are its own. */
let parsed = 0

/** A Turtle document's triples, in the store's terms (blank nodes labelled apart from every other document's). */
export function parseTurtle(turtle: string, f: GraphStore['factory']): Quad[] {
  const term = (t: Term): Term =>
    t.termType === 'NamedNode' ? f.namedNode(t.value) : t.termType === 'Literal' ? f.literal(t.value, t.language || f.namedNode(t.datatype.value)) : t
  return new Parser({ format: 'text/turtle', blankNodePrefix: `g${++parsed}_` }).parse(turtle).map((q) => f.quad(term(q.subject as Term), term(q.predicate as Term), term(q.object as Term)))
}
