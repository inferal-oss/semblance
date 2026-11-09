# Jelly in the engines

[Jelly-RDF](https://w3id.org/jelly) is a binary RDF format on Protocol Buffers, with a streaming
protocol. Both engine builds read and write it through the same ABI (ABI.md, "Jelly"), at
parity with each other and with the TypeScript codec in `src/jelly/`. The TypeScript codec reads
and writes for the stores that have no engine (N3, Oxigraph) and serves as the oracle in tests.
Issue: #433.

## Versions

Jelly-RDF 1.2.0 (October 2026, version tag 3) stores a frame as a **column batch**: per frame,
the subjects, predicates, objects and graphs each form a column, with packed lookup entries, runs
of repeated values and per-column IRI sequences. Jelly-RDF 1.0 and 1.1 (tags 1 and 2) store a
frame as **rows**, one statement or lookup entry per row. A 1.2 reader must also read 1.0 and 1.1.

| | read | write |
|---|---|---|
| 1.2 (columns), FLAT and MESSAGES streams, TRIPLES and QUADS | yes | yes |
| 1.0 / 1.1 (rows), TRIPLES, QUADS and GRAPHS | yes | no (the current version is written) |
| RDF 1.2 triple terms, base directions | yes | yes |
| 1.1 RDF-star quoted triples (subject or object) | yes, as triple terms | as RDF 1.2 allows: object only |
| generalized statements (literal subjects, ...) | refused | refused |
| namespace declarations | read and skipped by the engines (cosmetic); reported by `src/jelly/` | not written |
| frame metadata | skipped | not written |

## Decisions

**Terms.** A triple term (1.2) or a quoted triple (1.1) is an engine triple term (kind 4). A
base direction makes an `rdf:dirLangString` literal. Language tags are lowercased, as every
engine term's tag is. Blank node labels are scoped as the spec says: a FLAT stream (and every
1.0/1.1 stream) is one scope, each RDF Message of a MESSAGES stream is its own. A reader's labels
never meet another reader's, or a `load`'s.

**Limits** (the spec's recommended defaults; a stream that asks for more is refused): 16,384
names, 4,096 prefixes, 256 datatypes; triple terms nested 100 deep; 2^27 - 1 rows per batch.

**Errors.** A frame is all or nothing: its statements reach the store only when the whole frame
has read. After an error the reader refuses every later frame (a stream cannot be picked up
again in the middle). The checks are those of the conformance suite, the SHOULD-level ones
included.

**Writer choices.** The spec leaves the writer free; ours makes every choice by a rule, so the
three implementations write the same bytes from the same statements:

- an IRI splits after its last `#` or `/` into a prefix and a name (the whole IRI is the name when
  the prefix lookup is disabled); the empty prefix is an entry like any other;
- each lookup is least recently used: a new value takes the next free identifier, and once all are
  taken, the one used longest ago; a frame ends early when a statement would evict a value the
  frame itself uses (the spec's "working set of a batch");
- a frame holds at most `frame_rows` statements (default 4,096);
- a column lists a value once per run of equal cells; a run of default-graph cells is unbound, and
  a column of only default graphs is left out;
- `kinds` only when a column mixes term types; one `prefix_ids` entry when every IRI of the column
  shares its prefix; one `literal_kinds` entry when every literal shares its kind; language tags in
  order of first use, `langtag_directions` only when one has a direction;
- packed lookup entries for each run of consecutive identifiers, with identifier 0 where it
  follows the previous entry of that lookup;
- the output is the delimited variant (a varint length before each frame): a file, an HTTP body,
  or frames a transport takes apart.

**Bounded memory, constant cost per frame.** A reader holds its three lookups (each entry a
block of its own, freed when the entry is replaced), an IRI cache per name entry, and its blank
node labels (the stream's in a FLAT stream, the message's in a MESSAGES stream); per frame, the
frame and its statements. A writer holds its three lookups (a hash table and a recency list each)
and the statements of the frame in progress. Neither does work that grows with what came before.

**Speed.** A reader resolves an IRI cell to a term id without hashing its text whenever the
(prefix, name) pair was resolved before and neither entry has changed since: each name entry
caches the last prefix it met and the term they made. A datatype entry caches its term id.

## Protobuf decoding

The wire format needs four things: varints (up to 10 bytes; Jelly's fields are 32-bit, longer
values are refused where they matter), tags (`field << 3 | wire type`), length-delimited fields
(nested messages, strings, packed repeated varints) and skipping fields of other wire types.
Unknown fields are skipped, as protobuf requires. Both engines decode in place from the input
buffer, without building message objects: a column is scanned once to find its lists (offsets
into the frame), then its run values are decoded and its layout expanded straight into the
frame's quad buffer.

- **Rust** (`rust/src/jelly.rs`): a `Proto` cursor over `&[u8]` with `varint`, `tag`, `len`,
  `skip`; the reader and writer state are structs on the heap, in a handle table.
- **WAT** (`wat/jelly.wat`): the same cursor in globals (`$jp`, `$jend`), each function reading
  from a pointer range; state in blocks from `alloc.wat`, entries as blocks of their own.

## Streaming

A host reads a delimited stream frame by frame (`src/jelly/decode.ts`, `FrameSplitter`, splits
chunks of a `fetch` body) and hands each frame to `jelly_frame`. A writer takes statements in
chunks (`jelly_write`) and gives back the frames they completed. Message boundaries
(`jelly_message` / `jelly_ends`) carry RDF Messages: one change, one delta, one LDES member.

## Conformance

`rdf-engine/conformance/jelly/` holds the Jelly-RDF test suite of jelly-protobuf v1.2.0
(Apache-2.0, `LICENSE` there): `v1_2/` (from and to Jelly) and `v1_1/from_jelly`. The runner
(`npm run conformance -- --suite jelly --target wat|rust|ts`) reads each positive test's frames
and compares the statements in order, up to blank node renaming, per message (1.2) or per frame
(1.1); a negative test must fail. A "to Jelly" test writes its input with its stream options and
reads it back. Tests that need generalized RDF are skipped (unsupported, as the suite allows).
Results go to `conformance/results/<target>.json` like the W3C suites', and the parity guard
compares the builds' failures.

## Where Semblance uses it

Each use is measured before and after (`scripts/jelly-measure.ts`, #433):

- **Shipped graphs** (the ontology, its subset, the site's graphs): **not used**. Jelly is 10-25%
  smaller raw but 5-20% larger gzipped or brotli'd than the minified Turtle shipped now: the
  ontology is mostly string literals, and binary identifiers compress worse than repeated
  prefixed names.
- **Stores**: `GraphStore.loadJelly(bytes, graph?)` and `dumpJelly(graph?, options?)`; the engines
  natively, N3 and Oxigraph through the TypeScript codec.
- **Remote-source deltas** (#382, `docs/REMOTE.md`): offered as a Jelly stream when the page asks
  for it, if the numbers show the gain the JSON/N-Triples events leave on the table.
- **The change log** (`beh:ChangeLog`): exported and replayed as a MESSAGES stream, one message per
  member.
- **SSR take-over**: the client loads the same graphs as the shipped ones (Turtle chunks), so the
  same numbers apply: not used.
