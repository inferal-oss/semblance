# Changelog

`@semblance-dev/semblance`, `@semblance-dev/semblance-react`, `@semblance-dev/rdf-engine-wat` and
`@semblance-dev/rdf-engine-rust`, released together with one version.
Versions are 0.x: a minor release may break, a patch does not ([docs/RELEASING.md](docs/RELEASING.md)).
Each entry states the engines' ABI version (`rdf-engine/ABI.md`).

## Unreleased

- Engine ABI 4: `match_batch` asks the engine several patterns in one call (`Engine.matchBatch`,
  the stores' optional `matchBatch`). Maintained views ask it for the partitions a change may
  start, once per step: the sales dashboard's batch of orders crosses into the engine 2,616
  times instead of 11,222 (#248). Serve this release's own engine builds with it.
- `semblance migrate` moves a project's Turtle across framework versions, forward and back, including the SPARQL it holds, and reports what it cannot reach; `semblance changes` says what changed and why, for people and agents ([docs/MIGRATIONS.md](docs/MIGRATIONS.md), `@semblance-dev/semblance/migrate`, #473).
- Each component has a version, and a retired term is reported at run time, moved on the way in where it was renamed.
- Retention: `ret:pinned true` on a stream's member keeps it whatever its policies say, and memory
  pressure does not take it, until it is unpinned. LDES's `ldes:PointInTimePolicy` keeps what was
  appended from its `ldes:pointInTime` on, and `ldes:LatestVersionSubset` keeps the `ldes:amount`
  newest versions of each entity (`ldes:versionOfPath`); its amount was read before as the stream's
  newest members, which let go of versions LDES keeps (#530, [docs/RETENTION.md](docs/RETENTION.md) §8.1).

- A static build writes `semblance-graphs.json` beside its pages (the graphs each page names). A
  click while the rest of the graphs arrive takes in what the page reached names first, and the
  rest in slices, instead of everything in one long task (`arrive`, `src/slices.ts`).
- An input-only rule's state goes with its owner's last input type: its output, reads, followed
  queries, member registrations and pending work, without evaluating the owner, at the cost of that
  owner's pairs. A rule that leaves drops its own pairs, held and parked work and order (#242).
- Maintained views: a template (`iv:targets`, `iv:perReferrer`) that arrives after start, before
  its referrers, now hears of the referrers rules derive.
- On a phone (`sty:CompactWidth`) a card's body, a surface's own inset, a specimen and its stage
  take one step less inset, and a dock panel's header wraps its actions below its title, so what
  they hold fits at 320px (#246).
- `c:Button` shows its `c:logo` (a component, e.g. a `c:Emblem`) before its label, as `c:Link` does.
  In an app bar a `c:Link` among the actions is a control beside its buttons (a control's height, the
  bar's text colour; an emblem alone is a square control), and on a phone a link or button with a
  logo shows the logo alone, its label kept as its name (#550). The site's bar links to its source.
- `c:AppBar` takes `c:endActions`: actions pinned to the bar's inline end, after the More button on a
  phone, at the end of the actions' row on a wider screen (follow-up to #550). The site's link to its
  source is there.

## 0.1.0 (not yet published)

Engine ABI: 3.

The first release.

- `@semblance-dev/semblance`: compiled JavaScript with declarations for `.`, `./web`, `./node`,
  `./server` and `./virtual`; the ontologies (`./ontology/*`), the Vite plugin (`semblance` from
  `./node`) and the `semblance` command.
- `@semblance-dev/rdf-engine-wat` (a dependency of the core) and `@semblance-dev/rdf-engine-rust` (an
  optional peer): the engine's two builds, each its WebAssembly (`./wasm`) and a module naming its
  kind and ABI; a page adds the rust build with `addEngine`.
- `@semblance-dev/semblance-react`: React as the library under Semblance, `.` and `./server`.
