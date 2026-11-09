# Data from elsewhere: SERVICE and LOAD

SPARQL has two ways to reach data that is not in the store: `SERVICE`, which sends part of a
query to another SPARQL endpoint while the query runs, and `LOAD`, which fetches a document into
a graph. Semblance's engines (WAT and Rust) run both, but only when the host asks for it, through
an asynchronous call, and only for endpoints and documents the host lists. Rules, views and
reactions never fetch.

The site's docs have the same guide, shorter: [SERVICE and LOAD](https://semblance.dev/docs/fetching/)
(`demo/gallery/_docs.ttl`, `ui:doc-fetching`). The engine side is in `rdf-engine/ABI.md`
("Optional: fetching"); the host side is `rdf-engine/host/fetching.ts`.

## A remote source, SERVICE or LOAD

| | use it for |
|---|---|
| a remote source ([REMOTE.md](REMOTE.md)) | part of a server's store the page binds to and keeps current: loaded once, then deltas both ways; rules see each change incrementally |
| `SERVICE` | a one-off question to a SPARQL endpoint the page does not hold: a lookup, a join of local rows with a public dataset, answered when asked |
| `LOAD` | a one-off import of a document (a dataset dump, a vocabulary) into a graph of the store |

A `SERVICE` answer and a `LOAD`ed document are copies as of when they were fetched; nothing keeps
them in step with where they came from. When the page should follow the data, bind a source.

## Asking

`GraphStore.fetching` is the asynchronous side of a store. The wasm engine stores (`wat`, `rust`)
have it; Oxigraph and N3 do not (it is `undefined`):

```ts
const policy: FetchPolicy = {
  endpoints: { 'urn:ex:catalog': { url: 'https://data.example.org/sparql', headers: { authorization } } },
  documents: { 'https://w3id.org/vocab/*': {} },
  deadline: Date.now() + 5000,
}

const rows = await store.fetching!.select(`
  SELECT ?item ?price WHERE {
    ?item a ex:Item ; ex:sku ?sku .
    SERVICE <urn:ex:catalog> { ?product ex:sku ?sku ; ex:price ?price }
  }`, graphs, policy)

const quads = await store.fetching!.construct(query, graphs, policy)
await store.fetching!.update(`LOAD <https://w3id.org/vocab/terms.ttl> INTO GRAPH <urn:ex:vocab>`, policy)
```

- `select` and `construct` answer as the store's synchronous `select` and `construct` do, once
  every request the query needs has been fetched.
- `update` changes the store directly. It is for a store no runtime drives: a server, a build
  step, a tool, or a store seeded before `mount`. A mounted app takes remote data in through the
  runtime, so rules see it as an input change:

```ts
const quads = await app.store.fetching!.construct(query, graphs, policy)
app.runtime.apply({ add: quads, remove: [] })
```

## The policy

Nothing is fetched unless the host lists it. The policy is code, passed with each call; no graph
can add to it, and nothing in the graph configures fetching.

```ts
interface FetchPolicy {
  endpoints?: Record<string, Remote>  // SERVICE: endpoint IRI -> how to reach it; none listed: every SERVICE fails
  documents?: Record<string, Remote>  // LOAD: document IRI, or a prefix ending in `*`; none listed: every LOAD fails
  fetch?: typeof fetch                // default globalThis.fetch
  timeoutMs?: number                  // per request, default 10 s
  maxBytes?: number                   // per response, default 16 MiB
  deadline?: number                   // Date.now() ms for the whole operation
  maxRounds?: number                  // default 8
}
interface Remote { url?: string; headers?: Record<string, string>; credentials?: RequestCredentials; timeoutMs?: number; maxBytes?: number }
```

The keys are the IRIs the query names. `url` maps one to where it really is, with headers and
credentials, as remote sources map a source's IRI to its endpoint: a query can name
`<urn:ex:catalog>` and never see a URL or a token. The list is checked for every request,
including a `SERVICE ?endpoint` whose endpoint comes from data.

## How a query waits

An engine has no network, and a run is synchronous. A browser cannot block its main thread on a
response, so the engine does not call out. A run that needs something from elsewhere stops, says
what, and is run again once the host has it:

1. The run returns "waiting" with the requests it could name. Evaluation goes on past the first
   missing answer, so one round names every request it can.
2. The host fetches them, in parallel, under the policy, and gives the engine each answer or
   failure.
3. The host runs the same query again. A request that needs an earlier answer (a
   `SERVICE ?endpoint` that another `SERVICE` binds) shows up in a later round. The rounds end
   when the run returns anything but "waiting", or at `maxRounds`.

Each round re-evaluates the local part of the query, which is small next to a network round
trip. Nothing is kept mid-evaluation, and the two engines do the same.

## SERVICE

`SERVICE [SILENT] (<iri> | ?var) { P }` sends the endpoint `SELECT * WHERE { P }` over the SPARQL
Protocol (`POST`, `application/sparql-query`; the answer is read as SPARQL results JSON, or XML).

- **Bindings go along.** The solutions joined before the `SERVICE`, restricted to `P`'s
  variables, are sent as `VALUES` after the pattern, so the endpoint answers only for the rows the
  page has. Blank nodes and triple terms cannot be sent and are left out. The endpoint joins the
  rows after evaluating `P`, so a `FILTER` inside `P` does not see them, as SPARQL scopes it.
- **The result is the same either way.** An answer row belongs to the binding row it agrees with,
  so the result equals `SERVICE` evaluated alone and joined, whatever order the evaluator takes.
- **`SILENT`**: a failed request (not listed, unreachable, a bad response, an unbound endpoint)
  gives the one empty solution, and the row passes as it is. Without `SILENT` the query fails with
  the reason.
- A query with `SERVICE` is not compiled; it runs in the interpreter.

## LOAD

`LOAD [SILENT] <iri> [INTO GRAPH <g>]` fetches the document and adds its triples to `g` (the
default graph without `INTO`), in the order of the update's operations. The update is all or
nothing, as before: while a document is missing it changes nothing.

The host parses the document by its content type: Turtle and N-Triples by the engine's own
parser; TriG and N-Quads give their default graph; anything else by a `parse` the host gives.
Blank nodes are fresh per document. A failed `LOAD` fails the update; `LOAD SILENT` does nothing.

## Budgets

Each round is an ordinary run under the engine's deadline and fuel. The waiting is the host's:
`deadline` bounds the whole operation (each round's engine deadline and each fetch's abort
signal), `timeoutMs` and `maxBytes` each request, and `maxRounds` the rounds.

## Authored content never reaches the network

- **Only the host's own asynchronous calls fetch.** Rules, views and reactions run the
  synchronous `select` and `construct`. There a "waiting" run is an error, so an authored SPARQL
  rule with `SERVICE` fails like any failing rule, and nothing is fetched.
- **Rules and views may not use SERVICE or LOAD.** Their results come from elsewhere, on no
  schedule the runtime sees, and are not incremental, so a rule over them could neither be
  maintained nor kept within a turn. A one-off query or update the host runs is where they belong;
  to keep remote data live, use a remote source.
- **The allow-list is the host's, in code**, and checked for every request.
- A Content Security Policy's `connect-src` should list the URLs the policy maps to
  ([SAFETY.md](SAFETY.md)).

## Stores

| store | `fetching` | `SERVICE` / `LOAD` in a synchronous query |
|---|---|---|
| `wat`, `rust` | yes | an error ("waiting: …") |
| Oxigraph | no: its JS build has no HTTP client | `SERVICE` errors, `SERVICE SILENT` is the empty solution; `LOAD` errors, `LOAD SILENT` does nothing |
| N3 | no | no SPARQL |
