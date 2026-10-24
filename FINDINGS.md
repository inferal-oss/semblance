# Findings

Node v26.10.0, darwin/arm64, 2026-10-24. Each cell runs in a fresh process
(`npm run bench -- 100,1000`); raw results, including the observations as RDF,
are in `bench/results/`. Times are engine time per operation (mean of 15
updates; initial render is a single run). The browser's Performance page runs
the same matrix in fresh realms and draws these charts from the same SPARQL
views.

## Primitives

| operation | µs/op |
|---|---:|
| oxigraph: `match(s, p, ?)` | 3.17 |
| oxigraph: add + delete quad | 16.70 |
| oxigraph: read term `.value` (s, p, o) | 4.43 |
| oxigraph: CONSTRUCT, 2-pattern join, focus bound | 32.63 |
| n3: `getQuads(s, p, ?)` | 0.58 |
| n3: add + remove quad | 2.58 |
| comunica over n3: CONSTRUCT, focus bound | 1157.99 |

Crossing the WASM boundary dominates Oxigraph's pattern matching. That cost
is paid by every term an engine or function rule reads. Comunica is three
orders of magnitude too slow for per-focus rule evaluation.

## 1,000 items (ms)

| scenario | oxigraph · sparql · bulk | oxigraph · function | hybrid · sparql · bulk | hybrid · function | n3 · function |
|---|---:|---:|---:|---:|---:|
| initial render | 730 | 719 | 365 | 232 | 122 |
| toggle item | 0.51 | 0.27 | 0.49 | 0.092 | 0.060 |
| rename item | 0.47 | 0.27 | 0.42 | 0.084 | 0.076 |
| reorder item | 87.6 | 83.3 | 7.54 | 5.84 | 6.24 |
| add item | 125 | 138 | 8.71 | 6.81 | 5.74 |
| type in field | 1.12 | 0.91 | 0.75 | 0.11 | 0.041 |

At 100 items every configuration updates in under 8.3 ms. Pure N3 renders
from scratch in 28 ms; per-focus Oxigraph SPARQL takes 148 ms.

## What the numbers say

1. **Use the hybrid store.** Oxigraph runs SPARQL and an N3.js mirror answers
   pattern matches. With identical SPARQL rules, average updates at 1,000 items
   are 12× faster than on pure Oxigraph (3.6 ms vs 43 ms). Every update fits a
   60 fps frame, and reorder or add is 7–9 ms instead of 80–140 ms.
2. **SPARQL rules are affordable; functions are faster.** On the hybrid store,
   function rules render 1.2–1.6× faster from scratch. Single-item updates are
   sub-millisecond either way. SPARQL stays the readable definition, and a
   function can implement the same `sem:Rendering` slot where it matters. Tests
   check that both produce identical HTML.
3. **Evaluate SPARQL rules in bulk.** One query for all instances of a rule
   (`$this` → `?this`) beats one query per instance by 1.2–1.4× on initial render.
4. **Watch the query planner.** On Oxigraph, a correlated `OPTIONAL` costs
   ~130 µs per row and an uncorrelated `UNION` was 260× slower than the
   equivalent `LATERAL`. Rules and views use `EXISTS` and `LATERAL` instead.
5. **Initial render scales sub-linearly** from 100 to 1,000 items (3.5–6×),
   because fixed costs dominate at the small size.

## Interaction cost in the browser

The engine numbers above exclude the DOM and the demo's own views. In the
demo, a todo toggle (event, reactions, rules, DOM, the stats write-back) costs:

| view shown | per toggle | after 750 more events |
|---|---:|---:|
| Inspector | 0.47 ms | 0.46 ms |
| Activity (SPARQL aggregate over the log) | ~5 ms | ~5 ms |
| Change log (newest 8 members) | ~3.6 ms | ~3.6 ms |

These hold because of demand-driven evaluation, read tracing, a bounded change
log read from its head, and incremental retirement. Before the last two, each
event scanned the whole log and the cost grew with history (0.8 → 1.7 ms over
650 events). `test/shell.test.ts` counts rule runs, triples written, triples
read and DOM operations per toggle, and requires them to stay the same as the
app and its history grow. It fails on any scan of a growing set.

The Activity view's cost is proportional to the log bound (`ldes:amount`,
200 by default), not to session length. A larger bound buys more history at a
higher per-event cost for that view only while it is shown.

## Keeping cost constant: what the checks found

`test/cost.test.ts` counts the work of ten interactions: rule runs, derived
triples written, triples matched, SPARQL result rows and DOM operations. It
requires those counts to stay the same after the list grows by 300 items and
the history by 250 events. When first added, it caught two problems:

- **Adding a todo** re-ran the whole list rule. Reads grew from 344 to 1,253
  triples, because the rule read every item and its sort key, and recorded
  provenance for every item. The fix is **member-wise rules**
  (`sem:forEach c:item`): one evaluation per (list, item), each placing its item
  by `sem:orderKey`, which the HTML index sorts. Adding or re-sorting an item now
  touches only that item.
- **Turning a card over to its source** rebuilt the back side on every flip:
  about 10,000 derived triples and 3,000 DOM operations. Its walk over the
  front's subtree was also traced, so after one flip, every change inside the
  card re-ran it. The back is now a `c:SourceBack` component. It is built once
  when first revealed, walks untraced, and visits each component class once.

`test/soak.test.ts` runs 3,600 mixed events and requires every structure, and
the time per event, to stay flat. It found leaks and one store problem:

- The HTML index never forgot nodes, and the engine kept read-tracking entries
  for parts that no longer existed. Both now clean up after themselves.
- **Oxigraph 0.5.13 never purges deleted quads.** Its in-memory store keeps
  them as dead versions that later lookups of the same pattern walk. A sliding
  window of 200 LDES members costs 15 µs per match when fresh, and 1.5 ms after
  20,000 retirements. Per-event time in the pure-Oxigraph configuration grew
  tenfold over 900 events. The hybrid store (the default) now rebuilds its
  Oxigraph side from the N3 mirror in idle slices (`GraphStore.maintain`, driven
  by `Runtime.warm`), with writes going to both copies until it swaps. The pure
  Oxigraph store compacts synchronously once deletions reach half its size.
  With an idle slice between interactions, the hybrid store stays at
  11–12 ms per event, including the 8 ms idle budget, across 5,000 events. The
  pure-Oxigraph configuration still degrades, which is a reason to keep it as a
  comparison only.

## Where interaction time went next

Measured in the demo (Chrome, hybrid store, functions preferred):

- **A todo toggle took 30 ms** once persistence and the gallery were loaded.
  The event bus looked up reactions by scanning every reaction and every class
  on each event (29,000 triples matched), and persistence re-read its policies
  on every input change. Both now cache what they read and drop the cache when
  a reaction, class or policy changes. The toggle is back to about 5 ms.
- **Warming everything** in idle time grew the store to 74,000 triples and the
  heap to about 160 MB. Warmth is now declared (`sem:warm`): the Playground and
  Performance pages are eager, the gallery is `sem:OnIntent`. The idle store
  is 29,000 triples.
- **Switching gallery pages** costs about 350 ms cold. Pointing at the
  navigation item first preloads the page in idle slices, and the click then
  costs 15–25 ms.
- **SPARQL against functions.** Rendering a page back in costs 1.5 s with the
  SPARQL implementations and 134 ms with the function ones (they render the
  same HTML, which the tests check). Bulk evaluation (one query with `VALUES`
  for many foci) closes part of the gap. The demo prefers functions; the Rules
  menu switches.
- **A language switch** re-ran every rule that produced text. Rules that read
  the viewer's language are now traced as reading it (`readsLanguage`), and a
  language change re-runs only those.
- **Bulk SPARQL broke ordering** at first: rows that relate two components'
  children (`ord:precedes` between nodes minted under different foci) cannot be
  split per focus. Rules whose templates are not attributable to `$this` now
  run per focus; the check is static, on the query text.
