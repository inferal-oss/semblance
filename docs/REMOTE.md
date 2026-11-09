# A graph that lives elsewhere

An app's data does not have to live in the page. A team with a triple store behind a server
can keep its graph there and bind a page to the part of it the page needs. The page loads that
part, then receives the store's changes to it as they happen. Its own changes go back as
writes. The store stays the authority.

This is not SPARQL `SERVICE` or `LOAD` ([below](#a-source-service-or-load)). What arrives from the
store is an ordinary input change, applied with `runtime.apply`. Rules and views take it in as
they take in a click, so a change from the store costs what it changes, however large the store
is.

The site's docs have the same guide, shorter: [Remote data](https://semblance.dev/docs/remote/)
(`demo/gallery/_docs.ttl`, `ui:doc-remote`).

This guide covers how a page declares a source, the effect that binds it, the protocol, the
reference server in the repository, and what the effect does (for a host that wants to do it
itself). The example is `examples/remote/`, a shared todo list:

```bash
npx vite --config examples/remote/vite.config.ts
```

Open it in two windows. What one window changes, the other shows. A todo label longer than 40
characters is refused by the store, and the page puts back what the store holds.

## A source, SERVICE or LOAD

SPARQL has two ways to reach data elsewhere: `SERVICE`, which sends part of a query to an
endpoint while the query runs, and `LOAD`, which fetches a document into the store. The engines
run both when the host asks ([FETCHING.md](FETCHING.md)), for a one-off question or import. A
source is for something else:

- **The store is the authority.** A `SERVICE` answer and a `LOAD`ed document are copies as of
  when they were fetched, and drift from where they came from. A source binds the page's part of
  the store for as long as the page is open: the page holds what the store holds, and a write the
  store refuses is put back to what it holds.
- **Only deltas reach the page.** After one snapshot, the store sends what changed, as it changes,
  and nothing else. Rules and views see each change incrementally; they may not use `SERVICE` or
  `LOAD`, whose results are not.
- **Nothing in the graph decides where the page connects.** A source names only what it covers;
  the host maps its IRI to a URL and credentials, and a source it does not map stays
  `src:Unbound`. `SERVICE` and `LOAD` name an IRI in the query, but only the host's own
  asynchronous calls fetch, from the IRIs its policy lists, mapped the same way. An authored graph
  cannot point a page at a server either way.
- **A change costs the change.** The server tells which pages a changed statement concerns by its
  predicate, its subject or its subject's type, one indexed lookup; the page applies it as one
  input change. Neither side re-reads the store or the page's part of it.

| | use it for |
|---|---|
| a remote source | part of a server's store the page binds to and keeps current |
| `SERVICE` | a one-off question to a SPARQL endpoint the page does not hold |
| `LOAD` | a one-off import of a document into a graph of the store |

## Declaring a source

The graph says what lives elsewhere. The host says where (`ontology/layers/source.ttl`, prefix
`src:`):

```turtle
ex:store a src:Source ;
    src:pattern [ src:class ex:Todo ] , [ src:subject ex:todos ; src:predicate c:item ] ;
    src:writable true .
ex:todos src:awaits ex:store .
```

```ts
await mount(element, {
  root: EX + 'page',
  graphs: [app],
  sources: { endpoints: { [EX + 'store']: { url: '/store/', headers: { authorization } } } },
})
```

- `src:pattern`: what the source covers (see below). The page binds to their union.
- `src:graph` (optional): the named graph its statements land in. By default they land in the
  default graph, where components read.
- `src:writable`: the page's changes to the source's statements go back to the store. Without it
  they stay in the page.
- `src:awaits` on a component: it is `st:busy` (`aria-busy`, the theme's shimmer) while the source
  loads or reconnects.

The graph never names an endpoint or credentials, so an authored graph cannot point a page at a
server. Under `mount({ authored })` the sources are read from the trusted graphs alone, so an
authored graph cannot declare one, nor widen the patterns of one the host bound or make it
writable. A source the host gives no endpoint stays `src:Unbound`. An endpoint is a URL with
headers, or any `SourceTransport` (an object with `follow` and `write`), for a store reached some
other way.

Without `mount`, the effect is `new RemoteSources(runtime, { endpoints, bus, onChange }).attach()`.

### What the page can see

What the effect knows is graph data in `urn:semblance:sources`:

- on each source: `src:state` (`src:Unbound`, `src:Loading`, `src:Live`, `src:Reconnecting`),
  `src:cursor`, `src:pending` (writes not yet answered), `src:attempts` and `src:lastError`;
- `src:SyncLog`, a bounded LDES (`logSize`, default 100) of what happened:
  - `src:Snapshot` (with `src:reset` when it replaced what the page held);
  - `src:Received`;
  - `src:Write`, `prov:wasInformedBy` the change-log member of the event that made it;
  - `src:Confirmed` and `src:Refused` (`src:of` the write, with `src:reason`).

What the page should do about it is up to its reactions. The effect emits events targeted at the
source: `src:WentLive`, `src:Lost` (with `src:lastError`) and `src:WriteRefused` (with
`src:reason`). The example's badge follows them:

```turtle
ex:ShowRefused a beh:Reaction ; beh:when src:WriteRefused ; beh:source ex:store ;
    beh:deletes """CONSTRUCT { ex:status c:label ?l ; sty:tone ?t } WHERE { … }""" ;
    beh:inserts """CONSTRUCT { ex:status c:label ?label ; sty:tone sty:Danger }
WHERE { $event src:reason ?reason BIND(IF(?reason = "stale", "Changed elsewhere: shown as it is now", ?reason) AS ?label) }""" .
```

The page's own change log stays the record of the page's events. Changes from the store are not
page events, so they are recorded in `src:SyncLog`, not in the change log.

## What a page binds to

A page names the part of the store it needs as **patterns**:

- a triple pattern: any of `subject`, `predicate` and `object` (an omitted one matches
  anything);
- a class: `{ class }` covers every statement whose subject is an instance of the class.

The todo list binds to every `ex:Todo` and the list's links to them:

```ts
const patterns = [{ class: EX + 'Todo' }, { subject: EX + 'todos', predicate: C + 'item' }]
```

A changed statement is matched by its predicate, its subject, or its subject's type (one indexed
lookup). The server can tell which pages a change concerns in constant time, and the page can
tell which of its own changes belong to the store in the same way. Statements name things by
IRI: a blank node has no identity across the wire, so a source leaves it out.

## The protocol

The protocol is plain HTTP and JSON, with statements as N-Triples, or a Jelly stream where both
ends speak it (below). The types are in `src/source-protocol.ts`, exported from the package.

**Reading.** `GET {base}changes?patterns={json}&after={cursor}` answers with a
`text/event-stream`:

| event | data | when |
|---|---|---|
| `snapshot` | `{ cursor, add, reset? }` | First, when there is no `after`, or when `after` is older than the server's log (then `reset: true`: replace what the page holds of the store, don't add to it). |
| `delta` | `{ cursor, add, remove, write? }` | Every change to the store that touches the patterns, in order. `write` is the id of the page's write it came from, if any. |
| `cursor` | `{ cursor }` | After a resumed backlog, and now and then while nothing concerns the page, so the cursor a page resumes from stays recent. |

The server's cursor is a sequence number. Every change to the store, from any client, is one
step. The client reads the stream with `fetch` rather than `EventSource`, so it can send the
headers its server needs (credentials). `serverSentEvents(body)` parses the stream.

**As Jelly.** A page asks with `Accept: application/x-jelly-rdf, text/event-stream;q=0.9`
(`httpTransport`; `jelly: false` asks for events only). A server that offers it answers with a
Jelly stream (docs/JELLY.md): one stream of triples as RDF Messages, a frame per message (a large
snapshot spans several). A delta's removals come first. The metadata of the message's last frame
says what it is: `event`, `cursor`, `remove` (how many of its statements are removals), `write`,
`reset`. One writer per subscription keeps its lookups across messages, so an IRI the stream has
named before costs a few bytes. `SourceServer` offers it; `JellyEventWriter` and
`jellySourceEvents` are the two ends. On a todo list's stream a delta is 85 bytes instead of 275,
and gzipped with a flush per event the stream is a fifth smaller (`scripts/jelly-remote-measure.ts`).

**Writing.** `POST {base}writes` with `{ id, add, remove }` answers `200 { ok: true, cursor }`, or
`409 { ok: false, reason, repair }`. The server applies a write atomically, and refuses it in
two cases:

- it is **stale**: a statement it removes is not in the store. The page made it from a state
  someone else has changed since. This is compare-and-set, and it is what keeps a single-valued
  property single-valued when two pages change it at once.
- its own **validation** refuses it.

`repair` is what the store holds of the statements the write touched: those the write added
that the store does not hold (`remove`), and those it removed that the store still holds
(`add`). Applying it puts the page back in step with the store. A change from elsewhere that
made the write stale is kept.

## The reference server

`SourceServer` (`src/node/source-server.ts`, exported from `@inferal-oss/semblance/node`) is an
in-memory store behind an HTTP handler that speaks the protocol:

```ts
import { createServer } from 'node:http'
import { SourceServer } from '@inferal-oss/semblance/node'

const store = new SourceServer({
  validate: ({ add }) => (add.some(tooLong) ? 'A todo is at most 40 characters.' : undefined),
})
store.load(turtle)
const handle = store.handler('/store/')
createServer((req, res) => void (handle(req, res) || res.writeHead(404).end())).listen(3100)
```

It keeps a bounded log of steps (`logSize`, default 1000) for pages that resume after a break.
For each step it records the types of the subjects the step touched, before and after. So a log
entry is matched against a page's patterns as of when it happened, and a subject that becomes an
instance of a bound class is sent whole. `work.checks` counts pattern checks, and the tests use
it to show a change costs the change, not the store.

It is a starting point and a test double, not a database. A deployment puts the same protocol in
front of its own triple store, and checks who may read which patterns and write which
statements.

## What the effect does

`src/remote.ts` does the following for each source. A host that binds a store some other way does
the same:

1. **It follows the stream.** It applies the snapshot, then each delta, with `runtime.apply` (or
   `runtime.write` for a `src:graph`). These changes are marked as coming from the store, so they
   are not sent back. A snapshot replaces what the page holds of the source: the statements that
   match the patterns and are not in it go. That costs the page's part, matched pattern by
   pattern, not the page.
2. **It reconnects.** When the stream breaks, it waits with doubling backoff (`backoff`), then
   opens the stream again with `after={cursor}`. The server sends what was missed, or a reset
   snapshot when the gap is longer than its log.
3. **It sends writes.** `runtime.onInput` hears every change to the input. The effect keeps the
   statements that match the patterns, judging a removed statement by its subject's types before
   the change. Everything one tick changes becomes one write. A batch is closed early when a
   change from the store arrives, so a write never spans one. Writes go one at a time, in order. A
   local change is shown at once (optimistic). A refused write's `repair` is applied as a change
   from the store. A write that cannot reach the server waits and is sent when the server answers
   again. Local changes made meanwhile keep queueing behind it.

Each step costs what it handles. The page's engine sees a change from the store as one input
change. Matching a local change against the patterns is a lookup per statement. `test/remote.test.ts`
holds the rule runs, derived output, store reads and server checks of one change from the store
equal for a store with 10 and with 20 000 statements the page does not bind to, and for a list of 3
and of 63 todos.

## Consistency, in short

- The store is the authority, and its cursor orders everything: deltas are applied in cursor
  order, and a page resumes from the cursor it last saw.
- Local changes are optimistic. A write is compare-and-set on the statements it removes, so a
  write made from a stale state is refused, and the page is repaired to what the store holds.
  When two pages change one value at once, the first write the store takes wins, and the other
  page shows it.
- Between a local change and its answer, a change from elsewhere can show beside it (two values
  of one property) until the refusal repairs it. That is the window optimism opens, and it closes
  with the answer.
- Writes made while the store is unreachable stay applied in the page, wait in order, and meet
  the same check when they are sent.
