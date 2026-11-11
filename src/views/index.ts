// @inferal-oss/semblance/views: maintained views on their own (docs/VIEWS.md). A store and the
// views over it, kept up to date by deltas, with no ontology, no rule engine and no renderer: SPARQL
// SELECT and CONSTRUCT views over your own data, under the UI kit you already have. This module
// runs anywhere; `./web.ts` and `./node.ts` add the built-in stores (openStore, openViews), and the
// package's `./views` entry picks one by platform.

export { createViews, Views, type ViewsOptions } from './views.ts'
export { followSource, type FollowOptions, type Followed } from './remote.ts'
export { ManualClock, systemClock, type ViewChange, type ViewClock, type ViewDelta, type ViewFigures, type ViewHandle, type ViewTotals } from '../view/runtime.ts'
export { ZSet } from '../view/zset.ts'
export { type Delta, emptyDelta, quadKey, termKey } from '../rdf.ts'
export { parseTurtle } from '../parse-turtle.ts'
export type { Factory, GraphStore } from '../store/types.ts'
export type { NamedNode, Quad, Term, Literal } from '@rdfjs/types'
export { httpTransport, type Endpoint, type SourceTransport } from '../remote-transport.ts'
export type { Pattern } from '../source-protocol.ts'

/** A row of a SELECT view: each variable's value. */
export type Row = Map<string, import('@rdfjs/types').Term>
