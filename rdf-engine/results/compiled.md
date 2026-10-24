# Compiled queries: SPARQL to WebAssembly

Both engines can compile a prepared query into a WebAssembly module of its own
(ABI.md, "Optional: compiled queries"); the host compiles the bytes, instantiates
them with the engine's exports and calls the module's `run` instead of the
interpreter. This page measures whether that is worth it. Node 26, darwin/arm64,
2026-10-24.

## What compiles

The compiler emits BGPs as nested loops over index scans (most bound first),
OPTIONAL, UNION, VALUES, LATERAL, FILTER and BIND around them, and inlines the
cheap id-level expressions (BOUND, `!`, `&&`, `||`, isIRI/isBlank/isLiteral,
sameTerm, `=` with an IRI, `lang(?x) = ""`, COALESCE, IF, STR of a plain
string). Everything else calls back into the engine: other expressions
(`cq_test`, `cq_value`), property paths (`cq_path`), and patterns left to the
interpreter (`cq_eval`: GRAPH, MINUS, subqueries, triple terms, and a join's
right side that must not see the left side's row), whose rows are joined in.

| | Rust | WAT |
|---|---:|---:|
| Semblance corpus (`semblanceQueries()`) | 453 / 479 (94.6%) | 453 / 479 |
| calls made while rendering the shell and site | 569 / 569 distinct | 569 / 569 |
| W3C query-evaluation tests (sparql10/11/12) | 503 / 594 (84.7%) | 503 / 594 |

Declined, the same on both: aggregates / GROUP BY of the query itself (16 corpus,
44 W3C), its ORDER BY / LIMIT / OFFSET (10 corpus, 42 W3C), triple terms in a
CONSTRUCT template (5 W3C). Every rule Semblance renders with compiles.

## Correctness

- Recorded calls replayed interpreted and compiled (same store, same `?this`
  foci and graphs), as id rows / CONSTRUCT triples: 569 / 569 equal on both engines.
- The 80 compilable corpus queries Semblance runs unbound: 80 / 80 equal.
- W3C suites with `RDF_ENGINE_COMPILE=1` (every compilable query run both ways,
  a difference fails the test): 0 differences; `conformance/results/*.json`
  unchanged from `main` on both engines.
- `engine:check` 10/10 and `parse-check` 479/479 on both.

## Speed per query

`rdf-engine/host/compiled-bench.ts`: each distinct call of a shell + site render,
median of single runs (µs), on the store as rendered.

| | Rust interpreted | Rust compiled | WAT interpreted | WAT compiled |
|---|---:|---:|---:|---:|
| run, median | 27.5 | 26.1 | 10.5 | 9.0 |
| run, p90 | 113.8 | 93.6 | 94.6 | 94.2 |
| speed-up per call: median (p10–p90) | | 1.17× (1.00–1.40) | | 1.16× (0.92–1.43) |
| all 569 calls, total ms | 168.1 | 163.4 | 37.5 | 35.4 |

Cost of compiling one query (median / p90): Rust emit 32 / 52 µs,
`WebAssembly.compile` 126 / 172 µs, instantiate 30 / 40 µs, total **191 / 255 µs**;
WAT emit 24 / 45 µs, compile 78 / 127 µs, instantiate 27 / 41 µs, total
**136 / 201 µs**. Modules are 1.8 KB (p90 3.8–4.4 KB). Break-even: a median of
**80 runs** (Rust) and **77 runs** (WAT) of the same query with the same variables
bound; 58 (Rust) and 84 (WAT) of the 569 calls never break even (compiled is
not faster). Compiling the 41 distinct rule queries of a render costs 19 ms
(Rust) / 13 ms (WAT), against 4.7 ms / 2.1 ms saved per full render.

By query shape (calls; median µs interpreted → compiled; median speed-up; total ms):

| shape | calls | Rust | | Rust total | WAT | | WAT total |
|---|---:|---|---:|---|---|---:|---|
| BGP, OPTIONAL, UNION, BIND, FILTER only | 48 | 15.2 → 12.0 | 1.32× | 1.3 → 0.9 | 3.6 → 3.5 | 1.23× | 0.3 → 0.3 |
| with property paths | 68 | 13.0 → 11.0 | 1.16× | 1.4 → 1.3 | 4.2 → 3.0 | 1.32× | 0.5 → 0.4 |
| with EXISTS | 187 | 26.5 → 25.3 | 1.06× | 4.9 → 4.7 | 9.5 → 8.9 | 1.18× | 1.8 → 1.6 |
| with subqueries / LATERAL | 266 | 75.8 → 57.5 | 1.25× | 160.5 → 156.5 | 76.0 → 77.5 | 1.08× | 34.9 → 33.2 |

The compiled part (joins, the frame instead of row vectors, inlined conditions)
is 1.2–1.3× faster; but Semblance's query time is in what both paths share:
string expressions (CONCAT, IRI, REPLACE, ENCODE_FOR_URI), property paths, EXISTS,
and grouped subqueries, which compiled code still hands to the engine. The few
queries that dominate a render (a swatch scale's pairwise ordering subqueries,
15 ms a call on Rust) gain nothing.

## End to end

`bench/node-one.ts run "<config>" <items>`, engine ms, best of two runs (single
initial render; mean of 15 updates). Compiled configurations compile a prepared
query on its second run with the same variables bound (so one-off queries, such
as event reactions written out as text, are never compiled).

| config | items | initial render | toggle | rename | reorder | add | type |
|---|---:|---:|---:|---:|---:|---:|---:|
| rust · sparql · bulk | 100 | 37.0 | 0.07 | 0.04 | 0.08 | 0.18 | 0.06 |
| rust · sparql · compiled | 100 | 41.1 | 0.07 | 0.04 | 0.07 | 0.20 | 0.12 |
| rust · sparql · bulk | 1000 | 131.0 | 0.07 | 0.04 | 0.07 | 0.44 | 0.06 |
| rust · sparql · compiled | 1000 | 138.7 | 0.09 | 0.05 | 0.08 | 0.38 | 0.11 |
| rust · sparql · per-focus | 1000 | 158.4 | 0.07 | 0.05 | 0.08 | 0.73 | 0.05 |
| rust · sparql · per-focus · compiled | 1000 | 132.0 | 0.07 | 0.05 | 0.07 | 0.55 | 0.08 |
| wat · sparql · bulk | 100 | 34.5 | 0.05 | 0.04 | 0.06 | 0.17 | 0.07 |
| wat · sparql · compiled | 100 | 33.4 | 0.08 | 0.04 | 0.07 | 0.19 | 0.08 |
| wat · sparql · bulk | 1000 | 118.1 | 0.06 | 0.04 | 0.06 | 0.21 | 0.04 |
| wat · sparql · compiled | 1000 | 101.0 | 0.07 | 0.04 | 0.06 | 0.24 | 0.07 |
| wat · sparql · per-focus | 1000 | 113.2 | 0.06 | 0.04 | 0.08 | 0.22 | 0.07 |
| wat · sparql · per-focus · compiled | 1000 | 140.6 | 0.06 | 0.05 | 0.06 | 0.23 | 0.08 |

The differences go both ways and stay within the run-to-run spread (±15% on
initial renders, ±50% on sub-millisecond updates).

Shell pages (`rdf-engine/host/compiled-pages.ts`: mount the Playground, then
Home, Docs, Components, Examples, Playground three times; ms):

| | mount | 5 pages, first visit | 5 pages, best revisit | modules compiled |
|---|---:|---:|---:|---:|
| Rust interpreted | 208 | 177 | 26.6 | 0 |
| Rust compiled on 2nd run | 205 | 165 | 22.7 | 27 (5.2 ms) |
| Rust compiled on 1st run | 247 | 181 | 27.7 | 41 (6.6 ms) |
| WAT interpreted | 171 | 136 | 17.7 | 0 |
| WAT compiled on 2nd run | 167 | 135 | 18.0 | 27 (5.2 ms) |
| WAT compiled on 1st run | 199 | 147 | 24.3 | 41 (7.0 ms) |

## Size

| | before | with the compiler | cost |
|---|---:|---:|---:|
| Rust (raw / gzip) | 263.0 / 103.3 KiB | 294.4 / 113.7 KiB | +31.4 / +10.4 KiB (+12%) |
| WAT (raw / gzip) | 65.5 / 30.1 KiB | 74.3 / 34.4 KiB | +8.8 / +4.3 KiB (+13%) |

In Rust about 15 KiB is the code generator itself and 4 KiB the engine-side
`cq_*` exports; the rest is inlining the interpreter no longer gets.

## Verdict

Not worth merging into the default path. Compilation is correct and covers
nearly every query Semblance runs, but it buys 1.16× per query at the median and
3–6% of total query time, because the work that dominates Semblance's rules
(strings, paths, EXISTS, grouped subqueries) runs in the same engine code either
way. Compiling costs ~0.15–0.2 ms a query and pays off after ~80 runs; per-page
and bench differences are within noise. Worth it only for queries that are
mostly joins (BGP / OPTIONAL / UNION over id-level conditions, 1.2–1.3×) and run
hundreds of times with the same bindings, which is not Semblance's profile. To
change the verdict the compiler would have to own the string and numeric
expressions (typed values in locals, no allocation), not just the joins.
The bench keeps the compiled configurations so the question can be re-asked.

## Phase 2 (WAT): more of the query in the module

Measured first with `compiled-bench.ts wat --profile`, which times every
callback and names it by WAT node. Three call sites held 37.5 of the 42.2 ms of
compiled query time in a render (corpus now 539 queries, 603 distinct calls):
SHACL validation (191 calls, closure paths, LATERAL), the swatch scale (6 calls,
one `cq_eval` of GROUP BY ordering subqueries) and the tooltip layer (196 calls,
string expressions and EXISTS).

Done so far, WAT only:
- `p*` / `p+` (IRI or ^IRI) from a constant or certainly bound end: a
  breadth-first walk in the module, the reached nodes compacted on the stack.
- LATERAL compiled in line. Elements left to the interpreter inside it see a
  copy of the row as `$lat`.
- Triple patterns with a surely bound position read the store's posting lists
  in line, with no `cq_scan` and no copy. A triple found in an earlier default
  graph is skipped (`has`).

| WAT, 603 calls | interpreted | compiled |
|---|---:|---:|
| median per call | 27.3 µs | 23.5 µs |
| p90 per call | 99.7 µs | 82.8 µs |
| total | 44.6 ms | 40.0 ms (−10%) |
| SHACL site | 18.1 ms | 15.3 ms |
| tooltip site | 5.3 ms | 4.6 ms |
| swatch site | 15.5 ms | 15.3 ms |

Size: 74.3 → 77.2 KiB. Correctness: 603/603 calls replay equal; W3C with
compilation shows 0 differences.

Still to do for the 2× target, in measured order:
1. Subqueries with GROUP BY / COUNT compiled, including the single linear walk
   for list positions and ranks.
2. Typed string and number expressions: IRI, CONCAT, CAST, IF, COALESCE,
   CONTAINS, plus EXISTS as an inline loop.
