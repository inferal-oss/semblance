# Data from elsewhere: SERVICE and LOAD

SPARQL can reach beyond its store: `SERVICE` asks another SPARQL endpoint part of a query, and
`LOAD` imports an RDF document into a graph. Semblance's engines (WAT and Rust) run both, but only
when the host asks, through an asynchronous call, and only for endpoints and documents the host
lists. Rules, views and reactions never fetch.

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

The host configures fetching once, on the store, and then asks through the store's regular
asynchronous query call. The policy is the store's configuration: `createStore`, `mount` and a
site's config (`semblance.config.ts`) take it as `fetchPolicy`, and `store.setFetchPolicy(policy)`
replaces it later. The types (`FetchPolicy`, `Remote`, `QueryAnswer`, `QueryOptions`) are
exported from `src/store/types.ts`.

```ts
const store = createStore('wat', {
  fetchPolicy: {
    endpoints: { 'urn:ex:catalog': { url: 'https://data.example.org/sparql', headers: { authorization } } },
    documents: { 'https://w3id.org/vocab/*': {} },
  },
})

const rows = await store.query<Map<string, Term>[]>(`
  SELECT ?item ?price WHERE {
    ?item a ex:Item ; ex:sku ?sku .
    SERVICE <urn:ex:catalog> { ?product ex:sku ?sku ; ex:price ?price }
  }`)

await store.update!(`LOAD <https://w3id.org/vocab/terms.ttl> INTO GRAPH <urn:ex:vocab>`)
```

- `store.query(query, { graphs?, policy? })` answers any query: a `SELECT` with rows, an `ASK`
  with a boolean, a `CONSTRUCT` or `DESCRIBE` with quads. It fetches only when the query uses
  `SERVICE`, and resolves once every request the query needs has been fetched. `graphs` makes the
  default graph their union (absent: the store's default graph).
- `store.update(update, { policy? })` runs a SPARQL Update, with `LOAD` and `SERVICE`, and changes
  the store directly. It is for a store no runtime drives: a server, a build step, a tool, or a
  store seeded before `mount`.
- **A call's `policy` can only narrow the store's.** It keeps the endpoints and documents both list
  (of two document prefixes, one within the other, the narrower), within the smaller of each limit
  and the earlier deadline. Where and how a remote is fetched is the store's: a call that gives a
  `url`, `headers`, `credentials` or a `fetch` of its own is refused. The usual use is a deadline:
  `store.query(q, { policy: { ...store's lists, deadline: Date.now() + 5000 } })`, or a list
  narrowed to the one endpoint a call should reach.
- Calls on one store run one at a time. The policy is read when a call is made: replacing it does
  not change a call already made.
- The synchronous `select` and `construct` stay what the rule engine uses, and never fetch.

A mounted app takes the policy as `mount`'s `fetchPolicy`, and takes remote data in through the
runtime, so rules see it as an input change:

```ts
const app = await mount(element, { root, graphs, fetchPolicy: { endpoints: { 'urn:ex:catalog': { url } } } })

const quads = await app.store.query<Quad[]>(query)
app.runtime.apply({ add: quads, remove: [] })
```

## The policy

Nothing is fetched unless the host lists it: a store with no policy fetches nothing. The policy is
code, set by the host on the store; no graph can add to it, and nothing in the graph configures
fetching (authored content included: [SAFETY.md](SAFETY.md)).

```ts
interface FetchPolicy {
  endpoints?: Record<string, Remote>  // SERVICE: by the IRI the query names, exactly
  documents?: Record<string, Remote>  // LOAD: by IRI exactly, or a prefix `https://host/path/*`
  fetch?: typeof fetch                // default globalThis.fetch
  deadline?: number                   // Date.now() ms: the whole operation ends by then (usually per call)
  timeoutMs?: number                  // per request, default 10 000
  maxBytes?: number                   // per response, default 16 MiB
  maxRows?: number                    // solutions or triples per response, default 100 000
  maxRequests?: number                // per operation, default 32
  maxBindings?: number                // VALUES rows per request, default 1 000 (more: no VALUES)
  maxRounds?: number                  // default 8
  concurrency?: number                // requests in flight, default 4
}
interface Remote {
  url?: string                        // where it really is, when the IRI is a name
  headers?: Record<string, string>    // sent to this remote only
  credentials?: RequestCredentials    // default 'omit'
  bindings?: boolean                  // SERVICE: send VALUES (default true)
  timeoutMs?: number
  maxBytes?: number
}
```

The keys are the IRIs the query names. `url` maps one to where it really is, with headers and
credentials, as remote sources map a source's IRI to its endpoint: a query can name
`<urn:ex:catalog>` and never see a URL or a token.

- **Endpoints match by exact IRI**, never by prefix.
- **A document entry may be a prefix** (`https://data.example/dumps/*`): an `http(s)` URL whose
  path ends in `/`, with no query or fragment; a document under it is fetched at its own address
  (its `url` is for exact entries). A candidate must normalize (case, dot segments, `%2e`, ports) to the same
  origin under that path, so `https://allowed.example@evil.example`,
  `https://allowed.example.evil.example` and `…/../` do not pass.
- A user name in a URL, a scheme other than `http(s)`, and keys such as `__proto__` are refused.
- **A redirect is a failure** (`redirect: 'error'`), so headers never follow one to another
  origin. Credentials are omitted unless an entry says otherwise.
- **Over a limit** (size, rows, time, requests, rounds) a request fails; with `SILENT`, it is the
  empty solution.

In the browser, a Content Security Policy's `connect-src` should list the same endpoints and
document origins ([SAFETY.md](SAFETY.md)), as a second wall behind the policy.

## How a query waits

An engine has no network, and a run is synchronous. A browser cannot block its main thread on a
response, so the engine does not call out. A run that needs something from elsewhere stops, says
what, and is run again once the host has it:

1. The run returns "waiting" with the requests it could name: an endpoint, the query text (the
   pattern after the query's own `PREFIX` and `BASE`) and the binding rows, or a document's IRI.
   Evaluation goes on past the first missing answer, so one round names every request it can.
2. The host fetches them, at most `concurrency` at once, under the policy, and gives the engine
   each answer (rows of term ids, or the document's triples) or failure.
3. The host runs the same query again. A request that needs an earlier answer shows up in a later
   round. The rounds end when the run returns anything but "waiting", or at `maxRounds`.

Each round is an ordinary run under the store's query budget, and re-evaluates the local part of
the query, which is small next to a network round trip. `deadline` bounds the whole operation
(each round, each fetch), `timeoutMs` each request. A host operation fetches only the requests its
own call made: a rule's stray `SERVICE` that ran in between is not fetched for it.

## SERVICE

`SERVICE [SILENT] (<iri> | ?var) { P }` sends the endpoint `SELECT * WHERE { P }` as a SPARQL
Protocol `POST` (`application/sparql-query`), and reads the answer as SPARQL results JSON.

- **Bindings go along.** The solutions joined before the `SERVICE`, restricted to `P`'s
  variables, are sent as `VALUES` after the pattern, one request per endpoint and set of bound
  variables, so the endpoint answers only for the rows the page has. Blank nodes and triple terms
  are not sent. The endpoint joins the rows after evaluating `P`, so a `FILTER` inside `P` does
  not see them, as SPARQL scopes it.
- **Binding rows leave the page.** They are local data, so list only endpoints that may see them,
  or set `bindings: false`: the endpoint gets the bare pattern, and the engine keeps the answer
  rows compatible with its own. A request over `maxBindings` rows, or with a term that cannot be
  written exactly (an IRI holding `>` or a space), also goes without `VALUES`. Literals are
  escaped and language tags checked, so a value cannot change the query.
- **The result is the same either way.** An answer row belongs to the binding row it agrees with,
  so the result equals `SERVICE` evaluated alone and joined. WAT and Rust give the same results;
  the `VALUES` they send may differ, since each evaluator passes bindings its own way.
- **A variable endpoint** must be bound before `SERVICE` in its own group, or be a bound
  parameter: `?p ex:endpoint ?endpoint SERVICE ?endpoint { … }`. Bound only outside the group, or
  to anything but an IRI, it gives no solutions there (`SILENT`: the row passes as it is). It is
  checked against the list like any endpoint, whoever wrote the triple that bound it.
- **`SILENT`**: a failed request gives the one empty solution, and the rows around it pass as
  they are. Without `SILENT` the query fails with the reason.
- A nested `SERVICE` is sent to the endpoint as written.
- A query with `SERVICE` is never compiled (`not compilable: SERVICE`).

## LOAD

`LOAD [SILENT] <iri> [INTO GRAPH <g>]` fetches the document with a `GET` and adds its triples to
`g` (the default graph without `INTO`), in order with the update's other operations. The update
applies all or nothing: while a document is missing it changes nothing. Documents are read as
Turtle (`text/turtle`), N-Triples (`application/n-triples`) or Jelly (`application/x-jelly-rdf`,
its default graph, through `src/jelly/decode.ts`); blank nodes are fresh per document. A failed `LOAD` fails the update; `LOAD SILENT` does nothing.

## What a response may do

The body is read as a stream up to `maxBytes`, then aborted, and the request is aborted at its
timeout or the operation's deadline, whichever comes first; rows are capped at `maxRows`. A
response is parsed by its content type only, and anything else fails the request. Columns the
query did not ask for are dropped, terms are checked (language tags, directions, datatypes), and
the engine checks every id it is given.

A failure names what failed and why, never the response body: `SERVICE <iri>: <why>` or
`LOAD <iri>: <why>`, where why is one of: not an endpoint this page may query, not a document
this page may load, not a URL that may be fetched, `HTTP <status>`, timed out, could not be
reached, a response larger than the limit, an unexpected content type, a bad response, more
solutions, triples or requests than the limit, or past the deadline.

## Authored content never reaches the network

- **Only the host's own asynchronous calls fetch** (`store.query`, `store.update`). Rules, views
  and reactions run the synchronous `select` and `construct`. There, a query that needs a fetch
  fails with "SERVICE and LOAD reach the network: only store.query and store.update run them
  (docs/FETCHING.md); rules, views and reactions cannot". An authored SPARQL rule with `SERVICE`
  fails like any failing rule, and nothing is fetched, even from an endpoint the host lists.
- **Rules and views may not use SERVICE or LOAD.** Their results come from elsewhere, on no
  schedule the runtime sees, and are not incremental, so a rule over them could neither be
  maintained nor kept within a turn. Run a one-off query and apply what it returns, or bind a
  remote source.
- **The list is the host's, in code**, set on the store where the host creates it, and checked
  for every request, whatever produced the IRI: a `SERVICE ?endpoint` bound by triples someone
  else wrote is refused unless listed. No graph is read for it, so an author cannot add to it, and
  a call can only narrow it.
- **`LOAD` exists only in update text the host passes** to `store.update`: an author cannot
  issue one, or choose the graph it loads into.

`test/rdf-engine-fetching.test.ts` checks each of these on both engines, and the W3C federated
query tests run against an in-process endpoint (`rdf-engine/host/mock-endpoint.ts`;
`npm run conformance -- --suite sparql11fed`).

## Stores

| store | `query` | `SERVICE` / `LOAD` in a synchronous query |
|---|---|---|
| `wat`, `rust` | any query; `SERVICE` and `LOAD` (`update`) under the store's policy | an error ("SERVICE and LOAD reach the network: …") |
| Oxigraph, Hybrid | any query without `SERVICE`; `SERVICE` fails ("does not fetch"), `SERVICE SILENT` is the empty solution; Oxigraph's `update` fails a `LOAD`. A fetch policy is refused (its JS build has no HTTP client) | as in `query` |
| N3 | refuses: no SPARQL; a fetch policy is refused | no SPARQL |
