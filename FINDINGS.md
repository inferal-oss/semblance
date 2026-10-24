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
