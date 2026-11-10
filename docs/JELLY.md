# Jelly: binary RDF, frame by frame

[Jelly-RDF](https://w3id.org/jelly) is a binary RDF format built on Protocol Buffers, with a
streaming protocol. A stream is a series of frames. Each frame holds a batch of statements, with
IRIs compressed through lookup tables that persist from one frame to the next. Semblance reads
Jelly-RDF 1.2 (the column layout) and 1.0/1.1 (the row layout). It writes 1.2 (#433).

## In a store

Every built-in store reads and writes Jelly:

```ts
const bytes = store.dumpJelly()                 // what the store holds, as a stream of quads
const one = store.dumpJelly(graph)              // one graph
other.loadJelly(bytes)                          // all or nothing; returns how many statements it read
other.loadJelly(triplesStream, graph)           // a stream of triples goes into `graph`

// Frame by frame: as the bytes arrive, and as the reader takes them.
await loadJellyStream(store, (await fetch('/data.jelly')).body)
return new Response(dumpJellyStream(store), { headers: { 'content-type': 'application/x-jelly-rdf' } })
```

`loadJellyStream` adds each frame once it is whole, so memory holds one frame at a time. If the
stream breaks, the frames that arrived before the break stay in the store; `loadJelly` is all or
nothing. Both use a store's `jellyReader()` / `jellyFrames()`, which the engines implement
natively and the other stores through `src/jelly/`.

The engine stores (`wat`, `rust`) do this natively, in WebAssembly (`rdf-engine/JELLY.md`, ABI.md
"Jelly"). N3.js, Oxigraph and the hybrid store go through the TypeScript codec in `src/jelly/`,
which you can also use on its own:

```ts
import { FrameSplitter, JellyReader, writeJelly } from '@inferal-oss/semblance'

const bytes = writeJelly(quads, { physical: 2 })          // a whole delimited stream
const split = new FrameSplitter()                         // a stream arriving in chunks
const reader = new JellyReader(DataFactory)
for await (const chunk of body) for (const frame of split.push(chunk)) reader.frame(frame, { quad: (q) => store.add(q) })
```

Frame by frame, memory is bounded and each frame costs what it holds. A reader keeps its
lookups, which hold at most 16,384 names, 4,096 prefixes and 256 datatypes. A writer keeps its
lookups and the frame in progress. Every writer makes the same choices (`rdf-engine/JELLY.md`,
"Decisions"), so the TypeScript codec and both engines write the same bytes from the same
statements, and a test checks it.

## Where Semblance uses it

Each use was measured (`scripts/jelly-measure.ts`, `scripts/jelly-remote-measure.ts`; the
numbers are on #433):

- **A remote source's stream** (`docs/REMOTE.md`). The page asks for
  `application/x-jelly-rdf`. A server that offers it, as `SourceServer` does, sends a Jelly
  stream: a frame per message, with the cursor and the message's kind in the frame's metadata.
  Otherwise the page reads server-sent events as before. On a todo list's stream, a delta goes
  from 275 to 85 bytes (3.2× smaller), a snapshot from 97 to 12 KiB, and the whole stream,
  gzipped with a flush per event, from 55 to 44 KiB. Reading it takes 3.6 ms instead of 8.9 ms.
  Writes stay JSON.
- **Dumps and loads of a store**: `dumpJelly` / `loadJelly`, as above.

Where it is not used, because the numbers say no:

- **The shipped graphs**: the ontology, its subset (#383), and the site's graphs, which take-over
  loads too. Jelly is 10–25% smaller than the minified Turtle shipped now, but 5–20% larger
  once gzipped or brotli'd. The ontology is mostly string literals, which Jelly stores as they
  are, and its binary identifiers compress worse than Turtle's repeated prefixed names do. The
  engines read Jelly faster (the ontology in 13 ms against 28 ms from Turtle on WAT), but on a
  slow connection the extra bytes cost more than that saves.
- **The change log** (`beh:ChangeLog`): its members live and retire in the graph. Nothing exports
  or replays them yet, so there is nothing for Jelly to replace.

## What is not supported

- Writing Jelly-RDF 1.0/1.1 (the row layout): readers of 1.2 read what Semblance writes.
- Generalized RDF (a literal subject, a blank node predicate) is refused, as RDF 1.2 refuses it.
- Namespace declarations are read and reported by the TypeScript reader (`sink.namespace`), and
  skipped by the engines; nothing writes them.
