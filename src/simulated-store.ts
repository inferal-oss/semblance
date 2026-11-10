// A simulated store for a live example (c:storeSource, ontology/components/live.ttl; docs/REMOTE.md):
// the reference server (src/node/source-server.ts) in the page's own process, holding the Turtle of
// one of the example's editors, and a transport to it that the remote-sources effect (src/remote.ts)
// takes in place of an endpoint. Nothing reaches the network: the sandbox binds its sources to this.
//
// The store refuses what its own shapes reject: a sh:NodeShape with sh:targetClass, whose
// sh:property shapes say sh:maxLength, sh:minLength, sh:minInclusive or sh:maxInclusive of a
// predicate (sh:path), refuses a write that adds a value breaking one, for its sh:message. That is
// a store's validation, simulated; the page never sees the shapes (its patterns do not cover them).
import type { Quad, Term } from '@rdfjs/types'
import { DataFactory, Parser, type Store } from 'n3'
import { NS, RDF_TYPE } from './ns.ts'
import { SourceServer } from './node/source-server.ts'
import type { SourceTransport } from './remote.ts'
import { quadKey } from './rdf.ts'
import { turtleTokens } from './turtle.ts'

const f = DataFactory
const SH = NS.sh

/** What the store's shapes refuse of a change (undefined: nothing), seeing the store before it. */
export function shapesRefuse(change: { add: Quad[]; remove: Quad[] }, store: Store): string | undefined {
  const nn = f.namedNode
  const one = (s: Term, p: string) => store.getQuads(s, nn(p), null, null)[0]?.object
  // A subject's classes once the change is made (a todo added with its type is checked).
  const types = (s: Term) => {
    const out = new Set(store.getQuads(s, nn(RDF_TYPE), null, null).map((q) => q.object.value))
    for (const q of change.remove) if (q.subject.equals(s) && q.predicate.value === RDF_TYPE) out.delete(q.object.value)
    for (const q of change.add) if (q.subject.equals(s) && q.predicate.value === RDF_TYPE) out.add(q.object.value)
    return out
  }
  for (const shape of store.getQuads(null, nn(SH + 'targetClass'), null, null)) {
    for (const { object: prop } of store.getQuads(shape.subject, nn(SH + 'property'), null, null)) {
      const path = one(prop, SH + 'path')
      if (!path) continue
      for (const q of change.add) {
        if (!q.predicate.equals(path) || !types(q.subject).has(shape.object.value)) continue
        const v = q.object.value
        const n = Number(v)
        const broken =
          (one(prop, SH + 'maxLength') && v.length > Number(one(prop, SH + 'maxLength')!.value)) ||
          (one(prop, SH + 'minLength') && v.length < Number(one(prop, SH + 'minLength')!.value)) ||
          (one(prop, SH + 'maxInclusive') && !(n <= Number(one(prop, SH + 'maxInclusive')!.value))) ||
          (one(prop, SH + 'minInclusive') && !(n >= Number(one(prop, SH + 'minInclusive')!.value)))
        if (broken) return one(prop, SH + 'message')?.value ?? one(shape.subject, SH + 'message')?.value ?? `Refused: ${q.predicate.value}`
      }
    }
  }
  return undefined
}

/** A store loaded with `quads`, refusing what its shapes reject. */
export function simulatedStore(quads: Quad[]): SourceServer {
  const server = new SourceServer({ validate: shapesRefuse })
  server.change({ add: quads, remove: [] })
  return server
}

/** Turtle as the store's statements (`preamble` declares the prefixes the text may use without declaring). Throws what the parser throws. */
export function parseStore(text: string, preamble = ''): Quad[] {
  return new Parser({ format: 'text/turtle' }).parse(preamble + text)
}

/** The change that makes the store hold `quads` (what it has and they lack goes; what they have and it lacks comes). */
export function storeDelta(server: SourceServer, quads: Quad[]): { add: Quad[]; remove: Quad[] } {
  const want = new Set(quads.map(quadKey))
  const have = server.store.getQuads(null, null, null, null)
  const had = new Set(have.map(quadKey))
  return { add: quads.filter((q) => !had.has(quadKey(q))), remove: have.filter((q) => !want.has(quadKey(q))) }
}

/** The store as Turtle: the prefixes `text` declares, then its statements, by subject, with `prefixes` to name them. */
export function storeTurtle(server: SourceServer, text: string, prefixes: Record<string, string>): string {
  const head = [...text.matchAll(/^\s*@prefix\s+[^\n]*\.\s*$/gm)].map((m) => m[0].trim()).join('\n')
  const body = turtleTokens([{ quads: server.store.getQuads(null, null, null, null) }], prefixes, undefined, false)
    .map((t) => t.text)
    .join('')
  return (head ? head + '\n\n' : '') + body.trim() + '\n'
}

/** The store in-process, as the effect's transport: its stream is a subscription, its writes are answered at once. `written` hears every write it took. */
export function localTransport(server: SourceServer, written?: () => void): SourceTransport {
  return {
    follow: (patterns, after, on, signal) =>
      new Promise<void>((resolve, reject) => {
        let stop = () => {}
        stop = server.subscribe(patterns, after, on, () => (stop(), reject(new Error('dropped'))))
        signal.addEventListener('abort', () => (stop(), resolve()), { once: true })
      }),
    async write(req) {
      await Promise.resolve()
      const result = server.write(req)
      if (result.ok) written?.()
      return result
    },
  }
}
