# Views without the framework

Semblance keeps SPARQL views up to date from the changes to their inputs ([IVM.md](IVM.md)). A
change costs what it changes in a view, however large the store is or the view. The views do not
need the rest of Semblance. `@inferal-oss/semblance/views` is a store and the views over it, with
no ontology, no rule engine, no renderer and no projection. You bring your own data and your own UI
kit. Changes come in as deltas, and every view is kept current from them.

This makes a small first step for an app that has a component library already. It keeps its
components, and moves the data they show into views. Adopting the rest of Semblance later is a
separate decision ([below](#moving-on-to-the-framework)).

## A first view

```ts
import { openViews } from '@inferal-oss/semblance/views'

const views = await openViews({ kind: 'wat' }) // a store of Semblance's engine, empty
views.load(`
  @prefix ex: <https://example.org/#> .
  ex:a a ex:Todo ; ex:label "Write" .
  ex:b a ex:Todo ; ex:label "Read" ; ex:done true .
`)

const open = views.select('https://example.org/#open', `
  PREFIX ex: <https://example.org/#>
  SELECT ?todo ?label WHERE { ?todo a ex:Todo ; ex:label ?label FILTER NOT EXISTS { ?todo ex:done true } }
  ORDER BY ?label`)

open.orderedRows() // [{ todo: ex:a, label: "Write" }] (Maps of variable to term)
open.subscribe(({ rows }) => {
  // The net change of each tick that changed this view: rows with weight +1 (came) or -1 (went).
  for (const [, row, weight] of rows!.entries()) console.log(weight > 0 ? '+' : '-', row.get('label')!.value)
})

const f = views.store.factory
views.apply({ add: [f.quad(f.namedNode('https://example.org/#a'), f.namedNode('https://example.org/#done'), f.literal('true', f.namedNode('http://www.w3.org/2001/XMLSchema#boolean')))], remove: [] })
// logs "- Write"
```

`examples/views/` is a fuller example: views over a todo store on a server, drawn by React. Run it
in Node with `npx tsx examples/views/node.tsx`, or in a page with
`npx vite --config examples/views/vite.config.ts`.

## Stores

`openStore(kind)` makes an empty store of a built-in kind. `openViews({ kind })` makes one and the
views over it. `createViews(store)` puts views over a store you already have, of any `GraphStore`.

| kind | what | for views |
|---|---|---|
| `wat` (default) | Semblance's own engine, WebAssembly (136 KiB) | yes |
| `rust` | the same engine, compiled from Rust | yes |
| `oxigraph` | Oxigraph (WebAssembly, about 4 MB) | yes |
| `hybrid` | N3.js for matching, Oxigraph for SPARQL | yes |
| `n3` | N3.js, no SPARQL | no: hosting a view throws, and says which kinds have SPARQL |

A store loads only what its kind needs. In a browser the engine's `.wasm` is fetched and compiled
once. The other kinds' code is a chunk of its own, fetched only when one of them is asked for. The
entry picks its platform by export condition: `node` reads the engine from the package, and the
default (a browser bundle through Vite) fetches it.

## Hosting a view

`views.select(iri, sparql)` and `views.construct(iri, sparql)` (or `views.host(iri, sparql, form)`)
evaluate a query now and keep it current. They return a `ViewHandle`:

- `rows()`: a SELECT's rows, in no particular order. `orderedRows()` gives them in the query's
  `ORDER BY` order, with `LIMIT` and `OFFSET` applied; without an ORDER BY they are ordered by
  their values. `index(row)` gives one row's position.
- `quads()`: a CONSTRUCT's triples.
- `subscribe(fn, { replay })`: the net change of every tick that changed this view: `rows` for a
  SELECT, `quads` for a CONSTRUCT, each a Z-set (an element with a weight, +1 or -1). A tick that
  does not change the view does not call it. `replay` delivers the current result first.
- `since(tick)` and `keepHistory(n)`: everything that changed after a tick, consolidated, to bring a
  reader up to date. `snapshot()` gives the whole result as one change.
- `strategy` and `fallback`: `incremental`, or `recompute` with the reason. A query of a shape the
  compiler does not maintain (`NOW()`, `RAND()`) still works, recomputed when its inputs change.
  `createViews(store, { strict: true })` turns that into an error. It also compares every view with
  a from-scratch run after every tick, which is how the tests run.
- `figures`: the view's own work, in rows and milliseconds. `views.runtime.totals` sums every view's.

Hosting a view under an IRI that already has one replaces it. `views.unhost(iri)` stops one. The
framework's prefixes (`rdf:`, `rdfs:`, `xsd:`, `owl:`, …) need no declaration.

What is maintained is all of SPARQL SELECT and CONSTRUCT that [IVM.md](IVM.md) lists. That covers
aggregates and `GROUP BY` with `HAVING`, joins, `OPTIONAL`, `EXISTS`, `NOT EXISTS`, `MINUS`,
`UNION`, `VALUES`, `ORDER BY` with `LIMIT`, aggregate and correlated subqueries, property paths
and `GRAPH`. The W3C suites' queries are kept equal to a from-scratch run as their data arrives
([IVM-CONFORMANCE.md](IVM-CONFORMANCE.md)).

## How changes come in

Every change is a tick, and every view steps once per tick, with what the tick changed:

- `views.apply({ add, remove })` changes the default graph.
- `views.write(graph, delta)` changes a named graph the views read. Name such graphs when you
  create the views: `openViews({ graphs: [EX + 'local'] })`. A view reads the default graph and
  those, with `GRAPH <g>` where it needs to tell them apart. A graph not named is not read.
- `views.load(turtle, graph?)` parses Turtle and adds it as one change.
- `views.transaction(fn)` makes every change inside `fn` one tick, consolidated: a triple added and
  removed again is no change. The store changes at once, so `fn` reads its own writes.
- `views.advance()` is a tick with no input. Time passing is such a tick.

`apply` and `write` return the effective change: what they removed that the store held, and what
they added that it lacked. That is all the views see. A change the store already holds is no tick at
all. `views.tick` is the last tick's number, the one `since(tick)` takes. `views.onTick(fn)` hears
each tick once every view has settled.

## Data from a store elsewhere

`followSource(views, transport, { patterns })` follows a store's stream into the views, using the
protocol in [REMOTE.md](REMOTE.md), read-only:

```ts
import { followSource, httpTransport, openViews } from '@inferal-oss/semblance/views'

const views = await openViews()
const open = views.select(EX + 'open', OPEN_TODOS)
const source = followSource(views, httpTransport({ url: '/store/', headers: { authorization } }), {
  patterns: [{ class: EX + 'Todo' }],
})
await source.ready // the snapshot is in
```

- The snapshot is one change. What the views held of the patterns and the store no longer has
  goes. Data of your own beside it stays.
- Each delta is one change, applied in cursor order.
- When the stream breaks, it is opened again after a doubling backoff, from the last cursor. A gap
  longer than the server's log gets a reset snapshot.
- `onChange(event, change, cursor)` hears each message taken in, `onError` each break.
  `source.stop()` stops following, and the views keep what they hold.

Statements land in the default graph, or in `graph` (one of the views' graphs). The transport is
`httpTransport(endpoint)` (Jelly where the server offers it, else server-sent events), or any
`SourceTransport`. The reference server is `SourceServer` from `@inferal-oss/semblance/node`.

A change from the store costs what it changes in the views. `test/views-remote.test.ts` checks
that one change does the same work in a store of 10 and of 20 000 statements that are not followed.
That includes the server's pattern checks. A mounted app binds a source with the remote-sources
effect instead (`src:Source`). That effect also writes back and keeps its state as triples.

## React

`@inferal-oss/semblance-react/views` (also exported from `@inferal-oss/semblance-react`):

```tsx
import { useRows, useView } from '@inferal-oss/semblance-react/views'

function OpenTodos({ view }: { view: ViewHandle }) {
  const rows = useRows(view) // [{ todo: 'https://…#a', label: 'Write' }, …], in the view's order
  return <ul>{rows.map((r) => <li key={r.todo}>{r.label}</li>)}</ul>
}

function Count({ view }: { view: ViewHandle }) {
  const [n] = useRows(view, (row) => Number(row.get('n')!.value)) // your own shape per row
  return <p>{n} done</p>
}

function Graph({ view }: { view: ViewHandle }) {
  const { rows, quads, version } = useView(view) // terms as they are
  …
}
```

- Both hooks use `useSyncExternalStore`. Each view has one source, shared by every component that
  reads it. The source hears the view's own changes, and its snapshot stays the same object until
  the next one. So a component re-renders when its view changed, never for another view's change,
  and never for a change no view sees. `test/react-views.test.ts` counts the renders.
- `useRows(view)` gives each row as `{ variable: value }`. `useRows(view, select)` gives each row
  as `select` makes it. The array stays the same until the view changes. Pass a `select` defined
  outside the component, or memoized, to keep it so.
- The server snapshot is the same snapshot. `renderToString` over views built before rendering
  shows what they hold, and a client that builds the same views from the same data hydrates it as
  it is.
- Only types come from `@inferal-oss/semblance`, so a page that uses views and these hooks pulls
  in neither the hosted-component adapter nor the framework's main entry.

## What it costs

**A change.** `test/views-cost.test.ts` runs three views: an `ORDER BY … LIMIT 20` of open todos, a
`GROUP BY`, and a CONSTRUCT of every todo's label. It measures the work of a change in rows
processed by the views, triples matched and rows read from the store, partitions evaluated, and
rebuilds:

| change | 1 000 other statements, 50 todos | 50 000 other statements, 50 todos | 1 000 other statements, 2 000 todos |
|---|---|---|---|
| a todo done, then not (two ticks) | 6 rows, 1 match, 1 read, 2 partitions | the same | the same |
| a label changed | 8 rows, 1 match, 2 reads, 2 partitions | the same | the same |
| a statement no view reads | nothing | nothing | nothing |

The views' state grows with what they hold: 232 rows of state over 50 todos, 9 007 over 2 000.
The work of a change does not.

**What it pulls in.** `scripts/views-measure.ts` builds `examples/views` (views over the todo store,
drawn by React) and `examples/hello` (the Getting started app on `mount`, with the part of the
ontology it uses). It reports their files, then loads each page nine times in headless Chromium,
with the cache off, until it is live: the view's rows drawn for one, `mount` resolved for the
other.

| | views (`examples/views`) | `mount` (`examples/hello`) |
|---|---|---|
| JavaScript fetched before live | 487 KiB, of which React and React DOM are 221 KiB | 1 962 KiB |
| CSS fetched before live | none | 53 KiB |
| WebAssembly fetched before live | 136 KiB (the `wat` engine) | 136 KiB (the `wat` engine) |
| the build's JavaScript, every chunk | 653 KiB (200 KiB gzipped), 6 files | 6 333 KiB (1 284 KiB gzipped), 156 files |
| live after (median of 9) | 28 ms (22-85) | 85 ms (80-140) |

Measured on 2026-11-10 (Apple silicon, Node 26, Chromium headless shell, served from localhost).
The views page includes its snapshot from the store over HTTP and React's first render. The
hello page is rendered on the server beforehand, and `mount` takes it over. The views' own code is
about 155 KiB of the 487 KiB: the view runtime, its SPARQL parser and compiler. Another 107 KiB is
the engine's host, Jelly, and N3.js's parser and writer. Neither page fetches the other store
kinds' code or Oxigraph's 4 MB unless asked for it.

## What it shares with the framework

The views here and the views of a mounted app are the same code, so the two do not drift:

- the `ViewRuntime` (`src/view/runtime.ts`) and its view functions;
- how a change comes in: `applyEffective` (what a delta changes in a store) and `Consolidation`
  (a transaction's net change), in `src/view/input.ts`, which `Runtime.apply`, `Runtime.write` and
  `Runtime.transaction` also use;
- Turtle parsing (`src/parse-turtle.ts`);
- the stores (`src/web/stores.ts`, `src/web/engine-store.ts`, `src/node/stores.ts`), which
  `initWeb`, `createStore` and `loadStore` also use;
- what a snapshot replaces (`heldOf` in `src/source-protocol.ts`), and the HTTP transport
  (`src/remote-transport.ts`), both shared with the remote-sources effect.

## Moving on to the framework

The same queries are `iv:View`s in a Semblance app: declared in the graph rather than hosted from
code, read by components (a table's rows, a chart's series, a stat), and stepped in the same tick as
the rules that render them ([IVM.md](IVM.md), the site's
[Maintained views](https://semblance.dev/docs/views/) page). In a mounted app,
`runtime.views.host(iri, sparql, form)` still hosts a view from code, and the hooks above read it.
