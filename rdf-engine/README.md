# rdf-engine

An experiment: an RDF store and SPARQL 1.2 engine in plain WebAssembly, as a
third option next to Oxigraph and N3.js. It is built twice, against one ABI, so
the two can be compared on size and speed:

- `rust/`: Rust, `no_std`, compiled to `wasm32-unknown-unknown`, no wasm-bindgen.
- `wat/`: WebAssembly text, written by hand (plus whatever small macro layer
  lives in `wat/` and counts as part of that engine).

Both implement [ABI.md](ABI.md). Everything around them is shared: the host
adapter (`host/`), the W3C conformance runner (`conformance/`), and Semblance's
own tests and benchmarks.

## Commands

```bash
rdf-engine/conformance/fetch.sh               # W3C rdf-tests, pinned (gitignored)
npm run engine:build                          # build/rust.wasm, build/wat.wasm + sizes
npm run engine:check -- rust                  # term and store checks against ABI.md
npm run conformance -- --target rust          # or wat, oxigraph; --suite rdf12 --only <iri part> -v --show
npm run engine:compare                        # size and speed matrix -> results/compare.md
```

## Benchmarks

Every benchmark is a matrix of **rust × wat × oxigraph** (N3.js rides along as a
reference: it is what the hybrid store answers pattern matches with).
`npm run engine:compare` measures the stores directly on synthetic data. From
phase 2 on, Semblance's own `npm run bench` gets `rust` and `wat` store kinds
next to `oxigraph` and `hybrid`, so the same scenarios (initial render, toggle,
reorder, add, typing) run on all of them.

`npm run conformance` writes `conformance/results/<target>.json`: pass/fail/skip
counts per suite and every failing test with its reason. These files are
committed, so a regression shows up as a diff. `oxigraph.json` is the baseline;
its failures are Oxigraph's own deviations (it canonicalizes literals such as
`"01"^^xsd:integer`, and scopes graph variables in the older way), not runner bugs.

Suites: `sparql12` (with the SPARQL 1.1 tests it revises), `sparql11` (query and
update), `sparql10`, `rdf12` (Turtle, N-Triples, N-Quads, TriG, including the
RDF 1.1 tests they include). Expected results are read with Oxigraph as the
reference parser.

## Phases

The engines move in lockstep; each phase ends with both passing the same tests.

1. **Terms and store.** Interning, `add`/`remove`/`has`/`match`/`apply`,
   N-Triples and N-Quads `load`. Done when the rdf12 N-Triples and N-Quads tests pass.
2. **Turtle and TriG.** Done when all rdf12 tests pass. A `GraphStore` adapter
   then runs Semblance's function-rule tests on the engine (`sparql: false`),
   and `npm run bench` gets `rust` and `wat` columns.
3. **The SPARQL Semblance uses.** Parser, algebra, prepared queries with `bind`.
   Semblance's SPARQL rules switch from textual `$this` substitution to binding.
   Semblance also restricts one query to several foci (`VALUES ?this { … }`,
   spliced in as text), so the ABI gains binding a variable to a set of terms.
   Done when Semblance's test suite and `npm run bench` run on the engine.
4. **All of SPARQL 1.2.** Query, then Update. Done when the sparql10/11/12
   suites pass, apart from tests that need what the ABI leaves out (`SERVICE`,
   HTTP `LOAD`).
5. **Housekeeping and speed.** `collect`, and whatever the benchmarks point at.

### Where they are

| | Rust | WAT |
|---|---|---|
| 1. Terms and store | done | done |
| 2. Turtle and TriG | done: rdf12 1,055/1,055 | done: rdf12 1,055/1,055 |
| 3. Semblance's SPARQL | done: every Semblance page renders as on Oxigraph, with SPARQL and function rules | in progress: all 294 Semblance queries parse |
| 4. SPARQL 1.2 query and update | done: 2,304 of 2,317 W3C tests (Oxigraph 2,227); every failure is shared with Oxigraph | next |
| 5. Housekeeping and speed | `collect`; size pass (344 to 262 KiB); sessions flat at 17–24 ms/event | `collect` done; rest after phase 4 |

The Rust engine writes computed numbers the way XPath casts them to strings
(`"2"`, `"2.5"`), as Oxigraph does and Semblance's output relies on; seven
W3C tests expect XSD 1.0 canonical forms (`"2.0"`, `"2.5E0"`) and fail on
both engines for that reason.

## Rules for a fair comparison

- Same ABI, same host, same tests. No code is shared between the engines.
- Literals keep their lexical form; no canonicalization.
- Rust: `opt-level = "z"` (as fast as "s" or 3 here, and smallest), LTO, `panic = "abort"`, one codegen unit, stripped.
  Dependencies only when they earn their size; each one is listed here.
  (None so far.)
- Sizes are reported by `npm run engine:build` (raw, gzip, brotli) for the
  artifact as built, with no post-processing.
