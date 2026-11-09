// The store behind the example: Semblance's reference server (src/node/source-server.ts), an
// in-memory store, with the todos it starts with and one rule of its own: a todo's label is at
// most 40 characters. A write that breaks it is refused, and the page puts back what the store holds.
import { readFileSync } from 'node:fs'
import type { Quad } from '@rdfjs/types'
// In this repository the server is imported from its source; an app imports it from
// '@inferal-oss/semblance/node'.
import { SourceServer } from '../../src/node/source-server.ts'

const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label'
export const LIMIT = 40

export function todoStore(): SourceServer {
  const server = new SourceServer({
    validate: ({ add }: { add: Quad[] }) =>
      add.some((q) => q.predicate.value === LABEL && q.object.value.length > LIMIT) ? `A todo is at most ${LIMIT} characters.` : undefined,
  })
  server.load(readFileSync(new URL('./todos.ttl', import.meta.url), 'utf8'))
  return server
}
