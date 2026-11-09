# A graph that lives elsewhere

An app's data does not have to live in the page. A team with a triple store behind a server
can keep its graph there and bind a page to the part of it the page needs. The page loads that
part, then receives the store's changes to it as they happen. Its own changes go back as
writes. The store stays the authority.

Nothing in the engines changes for this: they still leave out `SERVICE` and HTTP `LOAD`
(`rdf-engine/README.md`). What arrives from the store is an ordinary input change, applied
with `runtime.apply`. Rules and views take it in as they take in a click, so a change from the
store costs what it changes, however large the store is.

This guide covers the protocol, the reference server in the repository, and the pattern a page
follows. The example is `examples/remote/`, a shared todo list:

```bash
npx vite --config examples/remote/vite.config.ts
```

Open it in two windows. What one window changes, the other shows. A todo label longer than 40
characters is refused by the store, and the page puts back what the store holds.

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

The protocol is plain HTTP and JSON, with statements as N-Triples. The types are in
`src/source-protocol.ts`, exported from the package.

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

## The pattern

`examples/remote/main.ts` binds the page by hand, in four parts:

1. **Follow the stream.** Apply the snapshot, then each delta, with `runtime.apply`, and call
   `flush()` to patch the DOM. Keep the last cursor. Mark what you apply as coming from the
   store, so it is not sent back as a write.
2. **Reset when told.** A `reset` snapshot replaces what the page holds: remove the statements
   that match the patterns and are not in it, then add the rest.
3. **Reconnect.** When the stream breaks, wait (with backoff) and open it again with
   `after={cursor}`. The server sends what was missed, or a reset when the gap is longer than its
   log.
4. **Send writes.** `runtime.onInput` hears every change to the input. Keep the statements that
   match the patterns (a removed statement by its subject's types *before* the change), collect
   them per tick into one write, and send the writes one at a time, in order. A local change is
   shown at once (optimistic). A refused write's `repair` is applied as a change from the store.
   A write that cannot reach the server waits and is sent when the server answers again.

Each part costs what it handles. The page's engine sees a change from the store as an input
change. Matching a local change against the patterns is a lookup per statement.

## Next

The host effect `RemoteSources` does the above for every source the graph declares: the patterns
become vocabulary (`src:Source`, `src:pattern`), the host maps each source to its endpoint, and
the state of each source (loading, live, reconnecting, writes pending, a write refused) is graph
data and events. That is the second step of
[#382](https://github.com/inferal-oss/semblance/issues/382).
