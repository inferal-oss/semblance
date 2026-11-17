# Bounded memory and retention

**How an app uses it: §8.** What is built and what is not: §7. The rest is the survey and the design
behind it: everything in Semblance that grows with time, use or history (measured on `main` at
4727466), sorted into what may be dropped and what may not, and the decisions on how it is bounded
(§6, agreed on 2026-11-16).

The goal, in one line: **memory is bounded and retention is not forever, but a person never finds
their data silently gone.**

## 1. Three kinds of state

Everything that grows falls into one of three classes, and each class has its own rule.

| class | what it is | examples | the rule |
|---|---|---|---|
| **Data** | what the app or the person owns | todos, documents, sheet cells, settings, kept files, a chat, pending writes to a remote store, remembered state in storage | **Never dropped by retention.** Bounded only by the person's own deletions, and by quotas, which must be surfaced, never absorbed. |
| **History** | a record of what happened | the change log, undo and redo, `per:StateLog`, `src:SyncLog`, `net:Capture`, the stall log, palette recents, announcements | **Bounded by a policy in the graph**, with a way out: what leaves is counted, said, and where it matters archived or asked about first. |
| **Derived and ephemeral** | anything rebuildable from data and rules, or that only means something now | renderings (`urn:semblance:derived:*`), the engine's refs and parked work, the HTML index, view state, provenance, caches, term dictionaries, wasm memory, hover, focus, drag and rendered geometry | **Evicted freely**, by budget, since it can be rebuilt. The cost of eviction is time, never content. Ephemeral state is replaced in place and never accumulates. |

A fourth question cuts across all three: **where the bound lives.** Ground rule 1 says the graph says
what, and the host does it. Today some bounds are in the graph (`ldes:amount` on the change log),
some are in the graph but ignored (the state and sync logs), and many are constants in host code.

## 2. What was measured

Two measurements: a probe run through the test queue on the WAT store (the soak test's harness), and
the dev server in Chromium, read through the site's own status bar and SPARQL workbench.

**The shell soak is flat.** The soak test's six interactions, 6,000 events: once the change log
reaches its bound (200), triples (~181k), engine refs (~56k), index nodes (~6.6k) and views stay flat.
The engine's term count oscillates between 80k and 113k, because idle `collect` works. **Wasm memory
rises from 66.6 to 99.9 MiB in the first 1,000 events and stays there.** That is the high-water
mark, and it is never returned.

**Visiting every page multiplies everything by seven, permanently.** 58 pages (home, the reference,
every docs section, component group and example), three passes:

| | triples | engine refs | index nodes | terms | wasm |
|---|---|---|---|---|---|
| start | 147k | 25k | 475 | 79k | 67 MiB |
| after pass 1 | 1,105k | 951k | 151k | 324k | 506 MiB |
| after pass 3 | 1,105k | 951k | 151k | 327k | 506 MiB |

The document stays at 262 elements, because hidden switch cases leave it (`c:caseRetention`). Their
renderings, parked work and set-aside elements stay. The growth is bounded by the size of the site,
not by the number of visits. That is fine for a docs site and unbounded for an app whose pages are
data: a page per record, a document per tab.

In the browser the same walk takes the store from 228k to about 1M triples, and the JS heap from 157
to 530–620 MB. By graph after four passes: `derived:screen` 758k, `derived:text` ~110k, views 38k,
events 2k, persistence 723, perf ~585, rendered 40–67. `derived:text` still grows by 4–6k triples a
pass: the text projection renders more components each pass (`sem:renders` 2,808 → 3,355). That
looks like warm-up rather than per-visit residue, but it had not levelled off after five passes.

**What the guards cover.** `test/soak.test.ts` asserts that triples, the engine's, index's,
renderer's and views' footprints, and the log length stay flat over 2,772 events on one page.
`test/cost.test.ts` asserts that the work per interaction does not grow with 300 more items and 250
more events. `test/visit-cost.test.ts` asserts that a click after visiting every page costs what it
costs fresh. None of them measures term counts, wasm memory, the JS heap, host-side caches, the
footprint of a long visit (only its click cost), storage, or the other stores (N3, hybrid).

## 3. The sweep

Bound "graph" means a policy in the graph that the code honours. Bound "host" means a constant or
option in code. "-" means nothing bounds it.

### 3.1 History: logs and streams

| item | grows with | bound today | where | lost when dropped | gap |
|---|---|---|---|---|---|
| `beh:ChangeLog` (`src/behaviour/events.ts` `expired`) | every recorded event: keystrokes, clicks, timer firings, raised events | `beh:LatestMembersPolicy` `ldes:amount 200` | graph | inspection, Activity, **undo** | No policy means unbounded. `ldes:DurationAgoPolicy` is checked only on append, against `Date.now()` rather than the bus clock. The retained-member index is read once, so members added later by a restore or another writer never retire. |
| Undo and redo (`beh:asserted`/`beh:retracted` on log members, `beh:undone`) | undoable reactions | **the change log's 200**, shared with every recorded event in the app | graph, but indirect | the ability to undo | See §4.1. |
| `per:StateLog` (`src/persistence.ts` `record`) | every write and restore | 100 | **host**: the graph's `ldes:amount 100` is not read | inspection | Make it honour the graph. |
| `src:SyncLog` (`src/remote.ts`) | every sync step | `opts.logSize ?? 100` | **host**: the graph's `ldes:amount` is not read | inspection | Make it honour the graph. |
| `sem:StallLog` (`src/behaviour/stall.ts`) | stalls | `ldes:amount 50` | graph, with side buffers of 16 and 32 in host code | inspection | - |
| `net:Capture` (`src/network.ts`) | fetches, sockets, spans | `ldes:amount 250`, 16,384-char previews | graph, with a fallback of **Infinity** in host code | inspection | An entry retired while still in flight gets its response re-added under subjects no longer tracked: orphan triples that `clear()` does not reach. Reading a whole streaming body never resolves and buffers without limit (latent; the demo has no HTTP sources). |
| `iv:deltaLog`, view history (`src/view/runtime.ts`) | ticks that changed a view | the stream's `ldes:amount`, default 12 | graph, with a host default | "since" readers | Each tick mints a new IRI, which feeds the term tables below. |
| Palette recents (`c:RecentRun`) | runs | `c:recentLimit`, default 5 written into the query | graph | a convenience | - |
| Announcement toasts (`ann:RecentAnnouncements`) | announcing events | `c:limit` (3) over retained members; 50 in the function walk | graph and host | ephemeral | **Dismissing a toast writes `<region>/~ann-N c:open false` into the input graph, and nothing ever removes it**: one triple per dismissal, forever. |
| Source server step log (`src/node/source-server.ts`) | steps | count, `logSize ?? 1000` | host | resume (falls back to a reset snapshot) | Bounded by count, not bytes. POST bodies have no size limit. |
| Demo streams: `dx:orders` | the dashboard's feed buttons | - | - | demo data | No policy. `wh:movements` is a ledger, unbounded on purpose and reset explicitly: the right call for owned data. |

### 3.2 Data: storage and owned resources

| item | grows with | bound today | where | risk |
|---|---|---|---|---|
| Remembered state (`per:Policy`, `src/persistence.ts`) | use: `ui:rememberChat` grows with the conversation | the browser's quota | - | **A full storage deletes the remembered state.** A whole write calls `removeStored` before `set`. `set` can throw `QuotaExceededError`; it is not caught, and `dirty` is already cleared. The state stays in memory until reload, then it is gone. |
| `per:retention` | - | time since the **last write** (not the data's age), all or nothing per policy | graph | Expired blobs are skipped by the pre-paint script but not deleted. Keys of policies no longer declared are never swept. |
| Kept files (`src/files.ts` `restoreKept`) | uploads kept in IndexedDB | SHACL caps on `fx:store`; none on `blk:Uploads` | graph | **Suspected loss**: `restoreKept` frees every stored file whose node is not in the store when Files attaches. On a server-rendered page whose first graphs do not include the files graphs, the nodes arrive later (`loadRest`, `restoreAdded`). Needs a test to confirm. |
| Remote write queue (`src/remote.ts`) | ticks while the store is unreachable | - | - | Pending writes are owned data. They are held in memory only, retried forever, and lost on reload. |
| Owned mints from events (blocks `~b-<event>`, marks, files, todos) | person's actions | the person's deletions | - | Correctly **not** removed when the event that minted them retires. Any future "closure of a member" must not reach them by IRI prefix. |

### 3.3 Derived: engine, index, views, stores

| item | grows with | bound today | where | gap |
|---|---|---|---|---|
| Renderings of hidden pages and cases: derived triples, refs, parked work, set-aside elements, islands in detached cases | **pages visited** | the size of the site | - | The biggest item by far (×7 in §2). `c:caseRetention` decides only what stays in the document, not what stays in memory. |
| Anticipated sections (`sem:anticipates` on `ui:nav`) | idle time | every top-level section | graph, but no eviction | Owner `''` is never forgotten, so every section is evaluated and kept even if never visited. |
| All page graphs (`demo/main.ts` `loadRest`) | idle time after first paint | the size of the site | - | Graphs are never unloaded (`Runtime.load`, no unload). Turtle source texts are kept in JS for sandboxes. |
| Provenance (PROV-O per rule and focus) | - | replaced per pair | engine | Bounded, but it adds ~9+ triples per pair, so it scales the item above. |
| Text projection (`derived:text`) | visits | the size of the site | - | Kept alongside the screen projection, and still growing after five passes in the browser. |
| WAT and Rust wasm memory | peak live state | high-water mark | - | **Never shrinks.** WAT's allocator only grows, and Rust's heap says so. Free lists reuse space but never return it. |
| Engine term dictionary | distinct terms | collected in idle at `termCount > 1.5 × live + 1000` | host | Never collected on the server: `src/server/warm.ts` never calls `maintain`, and query text from URLs becomes literals. So it grows with each distinct URL served. |
| Host term caches (`rdf-engine/host/store.ts` `iris`, `literals`) | terms looked up | entries dropped by freed id | host | An IRI looked up without interning that the engine does not know keeps its entry forever. |
| N3 entity dictionary (`n3` `_ids`/`_entities`) | distinct terms | - | - | N3 never frees ids. This is the N3 store and the hybrid's mirror, which is never rebuilt. |
| Oxigraph and hybrid dead versions | deletions | rebuild at 5,000 or half of live, hybrid **only in idle** | host | With no idle time, unbounded. |
| `RuleContext.names` (`src/engine/context.ts`) | IRIs a function rule read | until rules change | host | Grows with every subject ever read, retired members included. |
| `Runtime.ownWarmth` | nodes walked in idle | cleared on `sem:warm` changes | host | Keys of nodes that are gone stay. |
| `HtmlIndex.consumers` | renderers | - | host | No unregister: a disposed island's or renderer's dirty set keeps receiving marks. |
| Exact-dependency cache (`src/engine/exact.ts`) | distinct rule texts | - | host | Keyed on N3's module-level factory for N3, Oxigraph and hybrid, so it never dies; it grows with live-edited rules. |
| `clipboardTexts` (`events.ts`) | rich-text documents copied from | - | host | One text projection per document, kept and stepped every tick. |
| `idleCompiledProfiles` (`rdf-engine/host/engine.ts`) | idle compilation | - | host | Push-only (opt-in `compile: 'idle'`). |
| View operator state | inputs | inputs only; `iv:maxState` designed, not built | - | `GROUP_CONCAT` and `DISTINCT` keep a value map per group. |
| Capped caches: rules (4096), sparql-reads (256), prepared queries (512), Jelly lookups, sandboxes (8 mounted) | - | fixed | host | Fine as they are. They are listed so the inventory is whole. |

### 3.4 Ephemeral: replaced in place

Hover, focus, pointer, drag (`dnd:Current`), rendered geometry (`rnd:`, at most 1,000 records,
forgotten on unmount), validation results, timers, clipboard and pick requests: all are replaced, not
accumulated. What remains are small leftovers. Retirement does not clean references that other nodes
hold to a retired member: `beh:previous` on the oldest member, `beh:raisedBy`, `beh:continued`,
`beh:undone` (cleaned lazily), `dnd:refusedBy`, `sem:lastHang`, and `prov:wasInformedBy` on the sync
and state logs. Each is bounded to one per node, but each dangles.

## 4. Where the code confuses the classes

1. **Undo is history kept on the change log.** Undo depth is whatever survives the log's bound, and
   the bound was chosen for something else: the log's comment trades "history for per-event cost of
   the views that aggregate it". Every recorded event takes a slot: a keystroke, a tab click, a timer
   firing, a stall report. So unrelated activity silently shortens a person's undo. A typing run is
   one undo step but many members, and when its first member retires the whole step goes. Undo is
   also global: `beh:UndoLatest` undoes the newest undoable change anywhere. Nothing tells the person
   that undo has reached its horizon.
2. **The RDF editor's `c:diff` uses history as a baseline.** "Added" and "removed" rows are derived
   from the log's recorded statements. As members retire, removed rows vanish and the baseline shifts
   silently. It also reads every component's changes, not just its own document's.
3. **Persisting the change log drops its undo.** `ui:rememberChangeLog` saves members, not their
   statement nodes or `beh:undone`. After a reload, SPARQL `UndoLatest` marks a member undone and
   changes nothing, while the function twin skips it. That is likely a parity break (untested).
4. **Remembered state treats a write as a replacement of history.** It is deleted before the new copy
   is written, so a failed write loses data (§3.2).
5. **Kept files treat "not loaded yet" as "gone"** (§3.2, suspected).
6. **Rendered pages are derived but kept like data**: never evicted, so a long visit holds the whole
   site's renderings (§2).
7. **Pending remote writes are data held like a cache**: in memory, never persisted.

## 5. Design

### 5.1 Retention as ontology

One vocabulary for every bounded thing, instead of one-offs. Streams already use LDES
(`ldes:retentionPolicy` on a `tree:Node`, `beh:LatestMembersPolicy`, `ldes:DurationAgoPolicy`). The
proposal keeps that for streams and generalizes it to anything retained, in a small `ret:` layer
(`ontology/layers/retention.ttl`):

```turtle
# What is retained, and by which policies (a stream's view, a projection, an undo history, a store).
ret:policy      a owl:ObjectProperty ; rdfs:range ret:Policy .   # ldes:retentionPolicy ⊑ ret:policy

# What a policy keeps. Several policies: kept while any keeps it (LDES semantics), within any ret:Budget.
ret:Latest            rdfs:subClassOf ret:Policy .   # ldes:amount (beh:LatestMembersPolicy ⊑ ret:Latest)
ret:Within            rdfs:subClassOf ret:Policy .   # a duration (ldes:DurationAgoPolicy ⊑ ret:Within)
ret:Budget            rdfs:subClassOf ret:Policy .   # ret:maxTriples / ret:maxBytes: a cap, evicting by ret:order
ret:UntilAcknowledged rdfs:subClassOf ret:Policy .   # kept while nothing states ret:acknowledged
ret:pinned            a owl:DatatypeProperty .       # on an item: always kept (a person kept it)

# What happens to what leaves.
ret:onExpiry  a owl:ObjectProperty .   # ret:Drop | ret:Archive | ret:Compact | ret:Ask
ret:archive   a owl:ObjectProperty .   # where: a per: scope, a src:Source, or ret:Download (Jelly)
ret:otherwise a owl:ObjectProperty .   # what ret:Ask does when nobody answers

# What the person and the app can see: maintained by the effect that retires, one node per retained thing.
ret:Horizon .  ret:dropped , ret:archived (counts) ; ret:oldestKept (time) ; ret:archivedTo .
```

What this would replace or absorb:

- `beh:LatestMembersPolicy` and `ldes:DurationAgoPolicy` stay as they are, with `ret:` superclasses
  for the code to read.
- The hard-coded 100s in the state and sync logs read their graph policy.
- `per:retention` becomes a `ret:Within` on a `per:Policy`, measured from the data's age, not the
  last write.
- Toasts become `ret:UntilAcknowledged` for errors and `ret:Latest` for the rest.
- `c:caseRetention` keeps its job (what stays in the document) and gains a sibling for memory (§5.3).
- `iv:maxState` is a `ret:Budget` on a view.

One effect enforces it for every stream: "retire what the policies no longer keep", fed by appends
and the clock. That is the operator `docs/IVM.md` §7.2 already describes. Retirement also removes
references to the member it retires (§3.4).

### 5.2 Never "my data disappeared"

Before something a person could miss leaves, it goes through one of four exits. The class decides
the default; the policy can say otherwise.

- **Archive.** What leaves is written somewhere first: a `per:` scope (IndexedDB), a remote
  `src:Source`, or a Jelly file the person downloads (the engines already dump Jelly). `ret:Horizon`
  says how much and where, and a reaction can load it back, read-only, into the inspector.
- **Compact.** A snapshot plus a tail. Persistence already does this (a base and up to 64 chunks).
  For undo it means a checkpoint: "undo stops here", and the state is untouched.
- **Notify.** Notice is constant-cost, never per item:
  - `ret:Horizon` is graph state, and components read it. The change log view says "older than 14:02
    not kept · 1,240 archived · Download". A disabled Undo says where undo history starts.
  - An `ann:` announcement fires only when a person-facing horizon is crossed for the first time in a
    session.
- **Ask.** A `ret:Pressure` event is addressed to the retained thing, when a budget is reached and the
  policy says `ret:Ask`. A reaction answers it by stating a decision (archive, drop, keep, extend), as
  reactions answer anything. The host can answer through a mount callback, `onRetention(pressure)`,
  beside `onRefused`. A person-facing prompt is a component that reads open pressures. If nobody
  answers within the turn, `ret:otherwise` applies.

**Data never gets `ret:Drop`.** The vocabulary refuses it: a SHACL shape on `per:Policy`, file
stores and owned graphs. Under pressure (a quota, a budget), owned data takes these steps:

1. The write path never deletes the old copy before the new one is written (write, then swap).
2. A failed write is a `ret:Pressure` on the policy, and the state is marked unsaved
   (`per:unsaved true`), which a component can show: "Not saved on this device".
3. The person is offered a way out: export, delete things themselves, or ask the browser for
   persistent storage (`navigator.storage.persist()`).
4. Nothing is removed on their behalf.

### 5.3 Derived state: a budget, not a policy question

Derived state is evicted, not asked about:

- **Renderings of hidden cases and pages.** A `ret:Budget` on a projection (say, `ret:maxTriples`, or a
  number of parked roots) evicts the least recently shown parked roots in idle time.
  - Eviction drops their pairs' outputs, provenance and set-aside elements, and leaves them deferred,
    as if never shown. Showing one again costs its first render.
  - Never evicted: what is shown, what is `sem:warm sem:Eager`, and cases with `c:keptHidden`.
  - Islands are torn down with their case, and document-only state (scroll, media position) goes
    with it. That is a visible cost, so islands can opt out.
- **Engine memory.** Wasm memory cannot shrink, so the only lever is re-instantiation.
  - In idle time, when live state is well below the high-water mark (say under half), the store
    dumps Jelly, starts a fresh instance, loads it and swaps. That is the hybrid store's idle rebuild,
    for the engines.
  - It is engine work (#9).
  - It is O(store) and rare, never on an interaction.
- **Host caches.** Each long-lived cache gets either a cap or an owner it dies with:
  - `names`, `ownWarmth`, the exact-dependency cache, `consumers`, the host term caches, `clipboardTexts`;
  - and the N3 dictionary, through a rebuild like Oxigraph's.
  - These are host-internal, so they need no vocabulary. Their sizes go into `footprint()`, so the
    soak test sees them.
- **The server's warm runtime.** It needs `maintain` between requests, and a recycle after N requests
  or M distinct terms.

### 5.4 Defaults per class

| class | default policy | on expiry | visible to the person | configurable per app |
|---|---|---|---|---|
| Data | none (kept) | - (refused) | quota pressure: unsaved marker, announcement, a prompt | quotas and caps as SHACL (`file:` already does this) |
| Undo | its own history per document (§6, question 1), `ret:Latest 500` steps | compact (a checkpoint) | Undo disabled, with where history starts | the amount, and whether it is remembered |
| Change log | `ret:Latest 200` | drop; archive when the app says so | the log view's horizon line; download | amount, duration, archive target |
| Inspection logs (`net:`, state, sync, stall) | as today | drop | horizon line in their views | amount |
| Announcements | errors `ret:UntilAcknowledged`, others `ret:Latest` | drop | errors stay until seen | which `ann:` severities need acknowledgement |
| Derived renderings | `ret:Budget` per projection | evict | none; a slower first show | the budget; `sem:warm` and `c:keptHidden` exempt |
| Engine and caches | high-water rule, caps | rebuild, evict | none | none (host) |

### 5.5 Testing

- **Soak, wider.**
  - The footprint gains the engine's term count, wasm bytes, the host caches above and the N3 or hybrid
    dictionary.
  - A **site soak** shows every page twice and asserts derived triples within the budget, and wasm
    memory back under a bound after compaction.
  - A soak runs on N3 and hybrid too.
- **Conservation: nothing owned is lost.**
  - A session makes owned data, persists it and runs far past every bound.
  - After a reload, every owned resource is in the store and in storage.
  - For each stream: appended = kept + archived + dropped, where `ret:Horizon` gives the last two.
- **Pressure.**
  - A backend that throws `QuotaExceededError` leaves the earlier copy intact, raises `ret:Pressure`
    and shows the unsaved marker.
  - Kept files survive a page whose files graphs arrive late.
- **Cost.**
  - Retirement costs what expires.
  - A horizon update is O(1) per tick.
  - Eviction and compaction run only in idle time. `test/cost.test.ts` counters stay equal with a
    budget that has evicted.
- **Parity.** `ret:` rules (horizon lines, pressure prompts) have SPARQL and function twins, like any
  rendering.

### 5.6 Prior art

- **Browsers' storage** distinguishes best-effort from persistent: under pressure a best-effort
  origin is evicted whole, least recently used first, and `navigator.storage.persist()` asks to be
  exempt. Owned data should ask for persistence and surface `QuotaExceededError` instead of
  swallowing it.
- **LDES retention policies** describe on the view what a client can rely on being kept. The policy
  is published data, so a reader knows what is missing. Semblance already follows this for its streams.
- **Event sourcing** keeps state as snapshots plus a tail, and moves old events to cold storage
  rather than deleting them. That is the archive and compact exits.
- **Editors' undo** is per document and limited by count (Vim's `undolevels`, VS Code's per-model
  stack). Some keep it across sessions (Vim's `undofile`). Undo should be scoped to what it edits,
  not to the whole app.
- **Git's gc and reflog expiry** prune only what is unreachable, after a grace period: 90 days for
  reflog entries, 30 for unreachable ones, and two weeks for loose objects. Reachable means owned and
  is never pruned. Expiry is for history, with time to change one's mind.

## 6. Decisions

Agreed on 2026-11-16. Where a decision changes §5, it wins.

| question | decided |
|---|---|
| Vocabulary | A `ret:` layer. Retention policies are the main mechanism, and the app states them. |
| Asking | **Callbacks are the last line of defence.** Policies decide first, then reactions to `ret:Pressure`. Only what neither settles reaches the host's `onRetention`, and what history must be asked about is asked that way. |
| Undo | It stays on the change log, with a **bigger bound**. A second policy keeps the members that recorded an undoable change longer than the rest (§6.1). |
| Memory | The app can set a **maximum memory** (`ret:MemoryBudget`, `ret:maxBytes`). The runtime measures what it can: the engines' wasm memory everywhere, and the JS heap where the browser reports it (Chromium's `performance.memory`, and `performance.measureUserAgentSpecificMemory()` when cross-origin isolated). |
| Derived budget | The renderings' budget is part of that memory budget. **Both projections, screen and text, share it.** |
| Offload | **What leaves memory can go to browser storage** (IndexedDB) and comes back **live**, into the graph, when something reaches for it. That covers history past a horizon, undo past it, and cold graphs. Dropping is for what is rebuildable. |
| Archives | They load back into the live graph, not just into a viewer. |
| Stale storage | Keys of policies no longer declared are **swept**, once every graph the app declares has loaded. |
| Horizons | Crossing a person-facing horizon **is announced** (`ann:`), once per crossing, not per item. |
| Server | The warm runtime runs maintenance between requests **and** is recycled after a number of requests or distinct terms. |
| Tooling | A **Memory tool** beside the inspector. It shows usage by class and graph, budgets, horizons and offloaded stores. It **controls pressure**: you can simulate a level, evict now, offload now and set the maximum. Tests drive pressure the same way. |

### 6.1 Undo on the log, with a bigger bound

The change log keeps two policies, and a member is kept while either keeps it (LDES semantics):

```turtle
beh:ChangeLogView ldes:retentionPolicy beh:ChangeLogRetention , beh:UndoRetention .
beh:ChangeLogRetention a beh:LatestMembersPolicy ; ldes:amount 200 .
# Members that recorded an undoable change (beh:asserted / beh:retracted) are kept longer.
beh:UndoRetention a ret:Latest ; ldes:amount 1000 ; ret:members beh:UndoableMemberShape ;
    ret:onExpiry ret:Offload .
```

`ret:members` narrows a policy to the members that conform to a shape. The views that aggregate the
log keep their constant cost, because a retirement is a −1 delta whichever policy let the member go.
Undo past 1,000 steps loads the offloaded members back, live, so in practice undo is bounded by
storage, not memory. When storage refuses, the horizon is announced and a disabled Undo says where
history starts.

### 6.2 Offload, and loading back

`ret:Offload` is an exit (`ret:onExpiry`). It does three things:

1. **Writes before it removes.** What leaves goes to an IndexedDB store of the app (a `per:Database`
   scope) as Jelly frames, keyed by the retained thing and a range (sequence numbers for a stream,
   a graph name for a cold graph). The triples leave the store only after that write succeeds. A
   refused write is `ret:Pressure` (§6.3), never a silent drop.
2. **Records what it offloaded.** `ret:Horizon` gains `ret:offloaded` (a count) and the ranges
   held. Views read them, so a log view can say "1,240 older events in this browser · Show".
3. **Loads back on demand.** A `ret:Recall` request names a range, written by a reaction (Show,
   Undo past the horizon, a navigation to a cold graph's page) or by the host. The effect reads the
   frames and applies them as an ordinary input delta. The recalled members are subject to the same
   policies, so recalling does not unbound memory: something colder is offloaded to make room.

Cold graphs are the same mechanism, applied to graphs instead of stream members. A graph not shown
for a while, under pressure, is offloaded (owned graphs) or unloaded (graphs the app can fetch
again: its own Turtle) and comes back when a page that needs it is shown.

### 6.3 Memory budget and pressure

`ret:MemoryBudget` on the app (or a `mount` option, for the host) sets `ret:maxBytes`. A pressure
effect samples what it can measure in idle time, at most once a second:

- the engines' wasm memory;
- the JS heap, where reported;
- an estimate from triple counts per graph where nothing else is reported.

It writes a level (`ret:Normal`, `ret:Elevated`, `ret:Critical`) and the figures into
`urn:semblance:retention`. Each level is answered in a fixed order, cheapest and safest first:

1. evict derived state, least recently shown first (both projections; never what is shown,
   `sem:warm sem:Eager` or `c:keptHidden`);
2. compact the engines when live state is well below their high-water mark;
3. offload history and cold graphs to browser storage;
4. raise `ret:Pressure` on what is still over, for reactions to answer;
5. call `onRetention`, and announce what it decided.

Owned data is never dropped at any step. It can only be offloaded, and it is marked unsaved when it
cannot be.

### 6.4 The earlier recommendation, in order of risk

The phases below are in order of risk, and the first does not wait on the design.

1. **Fix the losses and leaks now, as ordinary bugs.**
   - Make the persistence write a write-then-swap, and handle quota errors.
   - Make kept-file restore wait for the graphs that name the files (after a test confirms the loss).
   - Read the state and sync logs' bounds from the graph.
   - Remove a dismissed toast's `c:open false` with the toast.
   - Fix network capture's in-flight orphans.
   - Fix the uncapped host caches and `HtmlIndex.consumers`.
   - Clean dangling references at retirement.
   - Fix the change log's persisted undo statements (the parity break).
2. **Retention vocabulary and horizons.**
   - Add `ret:` with `ret:Horizon` and one retirement effect for every stream.
   - Add the horizon lines in the log views.
   - Move undo off the change log into a history per document (or per `beh:log`), with its own policy
     and a visible horizon.
   - Move `c:diff` onto a baseline the editor owns.
3. **A budget for derived state.**
   - Evict least recently shown parked renderings.
   - Add engine compaction by re-instantiation, with the engine session.
   - Add the site soak.
4. **Archive and ask.**
   - Add archive targets (`per:` and Jelly download first, remote later).
   - Add `ret:Pressure`, `onRetention` and a prompt component.
   - Handle owned-data pressure end to end.

## 7. Plan, and what is built

Tracked in #530, linked from the Plan (#8).

| piece | where | state |
|---|---|---|
| Retention policies for every stream, offload to IndexedDB, recall, horizons, announcements | `ontology/layers/retention.ttl`, `src/retention/` | built |
| Undo on the change log, bigger bound, recalled past it | `beh:UndoRetention`, `src/behaviour/events.ts` | built |
| The memory budget, pressure, eviction of hidden renderings, `onRetention` | `src/retention/pressure.ts`, `Engine.evict`, `Runtime.evict` | built |
| The Memory tool, with usage by graph, class and host structure, the engines' live estimate and Compact now | the site's Tools window (`demo/app.ttl`, `ui:memoryTab`) | built |
| The losses and leaks of §3 (remembered state on a full storage, kept files, toasts, network capture, host caches, the server's warm runtime), and network capture on the shared module | #537 | built |
| Engine compaction: giving wasm memory back | the engine (#9), `EngineStore.compact` | built; the pressure effect compacts when it would win, and `ret:CompactNow` asks for it |
| Cold graphs offloaded or unloaded under pressure; `per:retention` as `ret:Within`; toasts that wait for acknowledgement | | not yet |

## 8. Using retention

### 8.1 Declaring a policy

A stream says what it keeps through its view's policies, as in LDES. A member is kept while any
policy keeps it:

```turtle
ex:Orders a ldes:EventStream ; tree:view ex:OrdersView .
ex:OrdersView ldes:retentionPolicy ex:KeepRecent .
ex:KeepRecent a ret:Latest ;          # or beh:LatestMembersPolicy, its subclass
    ldes:amount 500 ;                 # the 500 most recent
    ret:onExpiry ret:Offload ;        # what leaves goes to this browser's storage (default ret:Drop)
    ret:storageAmount 20000 ;         # and storage keeps 20,000 of them, then drops the oldest
    ret:announce true .               # a person-facing history: the first offload or drop is announced
```

- **`ret:Within`** (or `ldes:DurationAgoPolicy`) keeps by age: `tree:value "PT10M"`.
- **`ret:having`** narrows a policy to members with one of the given properties. It extends the
  others: a member they let go is offered to it.
- **`ret:recallLimit`** on the stream bounds how many recalled members memory holds besides what the
  policies keep (default 1,000).
- **No policy** means the stream keeps everything, as LDES says. Every stream Semblance itself writes
  declares one.

Change a policy in the graph and the next append follows it. An app's own stream is retained by the
same code. From a host effect:

```ts
import { logStream } from '@semblance-dev/semblance'

const log = logStream(runtime.retention, EX + 'Orders', 'urn:example:orders', (d) => runtime.write('urn:example:orders', d))
const leaving = log.append({ iri: member.value, seq, at: Date.now() })   // what no policy keeps any more
runtime.write('urn:example:orders', { add: memberTriples, remove: leaving })
```

A stream whose members own more than their own triples (the change log's recorded changes, minted
under the member) gives `runtime.retention.stream(iri, host)` a `closure`, as `src/behaviour/events.ts`
does.

### 8.2 Offloading and recalling

What leaves by `ret:Offload` goes through three stages:

1. It is serialized as it leaves the graph, in the same write.
2. It is written to storage in chunks of 64 members (N-Triples), off the interaction.
3. Until a write succeeds, it waits in memory as text (`ret:pending`), so a refused write loses
   nothing.

The storage is `mount`'s `retention.storage`. By default it is this browser's IndexedDB (database
`semblance-offload`); `false` turns offloading off, and then `ret:Offload` drops and counts. Keys
start with `semblance:ret:<run>|`. A new page sweeps what earlier pages offloaded, because history
goes with the page that kept it.

To bring history back into the live graph:

- **From a reaction:** `?stream ret:recall 50`. The effect performs the recall, then removes the
  request.
- **From the host:** `runtime.retention.get(stream).recall(50)`.
- **From the person:** `c:HorizonList`'s Show older button.

Recalled members are members again. Views over the stream see them, and memory holds them up to
`ret:recallLimit`.

### 8.3 Undo

Undo stays where it was, on the change log's members (`beh:asserted`, `beh:retracted`), with a
bigger bound. `beh:UndoRetention` keeps the 1,000 most recent members that recorded an undoable
change, besides the log's 200 newest, and offloads past that. Raise or lower its `ldes:amount` per app.

- **Recall ahead of need.** An undo that reaches one of the 16 oldest undoable members in memory
  recalls the most recent offloaded ones (64 at a time). The next undo finds them, so undo goes
  back as far as storage holds.
- **No gaps.** What memory holds of undo history stays one contiguous run. When something must leave
  it, an undone member goes first (losing only its redo), otherwise the oldest. An undo never skips
  a step.
- **No repeats.** An undone member is stored without its recorded change, so a recall never offers
  to undo it twice.

### 8.4 Horizons and announcements

Each retained stream has a `ret:Horizon` at `<stream>/~horizon`, in `urn:semblance:retention`. It
carries:

- `ret:inMemory`, `ret:offloaded`, `ret:pending`, `ret:recalled` and `ret:dropped`;
- `ret:oldestKept`;
- `ret:refused` (why storage last refused).

It is written only when a figure changes. Rules read it like any graph state. `c:HorizonList`
(Data group) lists every horizon, or the one `c:of` names, with Show older (`c:limit` members at a
time, 50 by default). The site's Change log tool shows the log's.

The first time in a session that a person-facing policy (`ret:announce true`) offloads or drops,
the effect raises one event on the stream: `ret:Offloaded` or `ret:Dropped`. Its reaction
announces it ("Older history moved to this browser's storage", "Older history is no longer kept"),
in the viewer's language, as a toast.

### 8.5 The memory budget

```turtle
ex:memory a ret:MemoryBudget ; ret:maxMiB 512 .       # or ret:maxBytes, or ret:maxFrom a slider
```

`mount(element, { maxMemory: 512 * 2 ** 20 })` declares one for a graph that has none. The pressure
effect (`src/retention/pressure.ts`, attached by `mount`) measures in idle time, every two seconds:

- the engines' WebAssembly memory;
- the JS heap, where the browser reports it (Chromium's `performance.memory`);
- otherwise, an estimate from the store's size.

It writes `ret:level` (`ret:Normal`, `ret:Elevated` from `ret:elevatedAt`, default 0.8, `ret:Critical`
from 1) and the figures (`ret:usedMiB`, `ret:heapMiB`, `ret:wasmMiB`, `ret:liveMiB`,
`ret:compactedMiB`, `ret:triples`, `ret:derivedTriples`, `ret:evicted`) into
`urn:semblance:retention`. `ret:liveMiB` is the store's estimate of what its live state needs
(`liveBytes`): against `ret:wasmMiB`, it says what a compaction would give back. Each level is answered in this
order:

1. **Evict derived state.** What is hidden loses its renderings in both projections, screen and
   text: a quarter of them at Elevated, all at Critical (`Runtime.evict`, `Engine.evict`). Never
   evicted: what is shown, what is `sem:warm sem:Eager`, and what is always evaluated. Evicted work
   is parked as if never shown, and a page shown again renders exactly as on a fresh visit. While
   pressure is above Normal, idle time evaluates nothing hidden ahead of time.
2. **Compact the engines,** when the store can and it would win: when the live estimate is below
   three quarters of the memory at Elevated, nine tenths at Critical (`store.compact({ below })`).
3. **Offload history.** What was recalled goes back to storage, and at Critical so does the oldest
   half of what `ret:having` policies hold.
4. **Raise `ret:Pressure`** on the budget, for the app's reactions to answer: raise the budget, close
   what the app can close. Its framework reaction announces it. This happens once per crossing into
   Critical, after the effect's own steps have run twice.
5. **Ask the host** (`onRetention`) once per crossing, after a third step.

`ret:simulate` on the budget (`ret:Normal`, `ret:Elevated`, `ret:Critical`, or `ret:Measured`, the
default) makes the effect act as if a level held. `ret:request` asks for one step once, now:
`ret:Evict`, `ret:OffloadNow`, `ret:CompactNow` (whatever it would win), or `ret:Measure`.

**Usage** is measured only when `ret:Measure` asks, since it counts everything. The store's own
SPARQL does the counting, so nothing is copied out of it. Each measurement replaces the last with
`ret:Usage` nodes minted under the budget:

- `ret:GraphUsage`: the triples of each graph (`ret:graph`, `ret:DefaultGraph` for the default one);
- `ret:ClassUsage`: the classes with the most instances, in every graph (`ret:class`, `ret:name` its
  prefixed name, `ret:instances`; `ret:usageLimit` of them, default 25);
- `ret:StructureUsage`: the entries of each host structure by name (`screen.engine.refs`,
  `text.index.nodes`, `views.refs`, and the runtime's and store's where they report a `footprint()`).

`ret:measuredAt` says when. An app's own view reads them like any other triples.

Measured on the site: a visit of every page holds 1,107k triples. Evicting at Critical leaves 180k
(147k at start), and every page shown again is byte-identical to a fresh render
(`test/retention-evict.test.ts`).

### 8.6 The last line of defence: `onRetention`

```ts
mount(element, {
  root, graphs,
  maxMemory: 512 * 2 ** 20,
  onRetention: async (r) => {
    if (r.reason === 'memory') return { maxBytes: r.maxBytes * 1.5 }   // or nothing: keep what is
    if (r.reason === 'storage') return { drop: !(await askThePerson(r.stream!)) }
  },
})
```

It is called only when policies and reactions have not settled it:

- **`reason: 'memory'`.** The budget stayed exceeded after every step. Answer with a new `maxBytes`,
  which is written to the graph, or with nothing.
- **`reason: 'storage'`.** The browser keeps refusing to store a stream's offloaded history, and more
  than twice what its policies keep waits in memory (`stream`, `pending`). Answer `drop: false` to
  keep it there. Without that answer, the oldest of what waits beyond the bound is dropped, counted
  on the horizon and announced.

Nothing here ever drops owned data. The default graph, remembered state and kept files are not
retained streams.

### 8.7 The Memory tool

The site's Tools window (⌘.) has a **Memory** tab, which is a view of the same graph. It shows:

- the level and the figures (`c:Metrics` of `ui:memoryBudget`);
- the maximum, a slider the budget follows (`ret:maxFrom`);
- a choice that simulates a level;
- Evict hidden views, Offload history, Compact engine memory and Measure usage, which are
  `c:Setter`s writing `ret:request`;
- every stream's horizon, with Show older;
- what the last measurement found: tables by graph, by class and by host structure (`c:Table`s over
  the `ret:Usage` nodes).

Simulate Critical on a long visit to watch the derived triples fall and the announcement arrive.
After it, Engine memory against Engine live state shows what Compact engine memory would give back,
and Measure usage shows where what is left is.

### 8.8 Testing an app under pressure

- **Inject the measurement.** `new MemoryPressure(runtime, { sample: () => ({ wasmBytes, heapBytes }) })`,
  then `await pressure.step()`. Each step measures and acts once.
- **Simulate in the graph.** `ret:simulate ret:Critical` works in tests as in the tool.
- **Give storage you can fill.** `runtime.retention.use(backend)` takes any `Backend` with `keys`. Set
  `runtime.retention.opts.schedule` to run writes at once, and `await runtime.retention.flush()`.
- **Assert conservation.** For every stream: appended = `inMemory + offloaded + pending + dropped`
  (`RetainedStream.figures()`), and `dropped` stays 0 where the app promises it.
- **Bound the soak.** A soak test that measures "once the log is at its bound" must pass every bound,
  `beh:UndoRetention`'s too; `test/soak.test.ts` sets it smaller to do so.

`test/retention.test.ts`, `test/retention-pressure.test.ts` and `test/retention-evict.test.ts` are
worked examples of each.

## Appendix: the questions as they were asked

1. **Undo.** Should it get its own history per document (recommended), or stay on the change log with
   a larger bound, so that unrecorded and non-undoable events stop taking its slots? Should undo history
   be remembered across reloads?
2. **The derived budget.** Should it be measured in triples, bytes, or a number of parked pages? What
   should the site's default be? Should the text projection share it?
3. **Archives.** Should archived history load back into the live graph, or only be viewable and
   exportable?
4. **Ask's default** when nobody answers. The proposal: history drops with its horizon shown, and data
   is never dropped. Is there any history the person must be asked about?
5. **Stale storage keys** of undeclared policies. Sweep them, or keep them, since they may be owned
   data of a graph not loaded yet? The proposal: never sweep data scopes; list them in the inspector.
6. **Is the change log person-facing?** Should crossing its horizon announce, or only show in the log's
   own view?
7. **The server's warm runtime.** Should it run `maintain` between requests, recycle, or both?
8. **Names.** A new `ret:` layer, or an extension of `beh:` and `ldes:`?
