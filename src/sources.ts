// Source texts as data: the host records the texts worth showing - an example's own file -
// as c:SourceText nodes (ontology/components/views.ttl), so a c:SourceView can show them
// verbatim, comments included, from the graph like anything else.
import { NS, RDF_TYPE } from './ns.ts'
import type { GraphStore } from './store/types.ts'

/** The node that stands for the text at `path`. */
export const sourceIri = (path: string) => 'urn:semblance:source:' + path

/** Record each text under its path (e.g. "demo/gallery/_ex-kanban.ttl"). */
export function recordSources(store: GraphStore, sources: Record<string, string>): void {
  const f = store.factory
  const nn = (iri: string) => f.namedNode(iri)
  for (const [path, text] of Object.entries(sources)) {
    const s = nn(sourceIri(path))
    const language = path.endsWith('.ttl') ? 'turtle' : path.endsWith('.ts') ? 'typescript' : 'text'
    store.add(f.quad(s, nn(RDF_TYPE), nn(NS.c + 'SourceText')))
    store.add(f.quad(s, nn(NS.c + 'path'), f.literal(path)))
    store.add(f.quad(s, nn(NS.c + 'language'), f.literal(language)))
    store.add(f.quad(s, nn(NS.c + 'text'), f.literal(text)))
  }
}

/** Which of the demo's files are examples, shown with their source. */
export const isExampleSource = (path: string) => /(^|\/)_(ex-[\w-]+|network)\.ttl$/.test(path)
