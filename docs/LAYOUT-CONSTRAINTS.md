# Layout constraints: checking (and sometimes solving) "is everything aligned and fitting?"

Status: **design proposal and spike (#167)**. Nothing here is on `main`; the user approves the design
first. The spike is on branch `claude/layout-constraints-983bf0`.

## The problem

We keep fixing sizing, padding and alignment by hand: #34 (single-line controls of three heights),
#57 (the checkout's code and phone fields not lining up), #53 (nav items running out of their
list), the gallery's specimens overflowing a phone (a5fc6b7, 71686f3). Each was a broken
**invariant** that nothing checked: linkedom has no layout, and the cascade tests
(`control-heights.test.ts`, `compact.test.ts`) read CSS, not geometry.

## What CSS guarantees and what it can't

Most invariants are met **by construction**: one token for every control's block size, one grid
(or `subgrid`) for columns that must line up, `align-items` within one flex line, `min-width: 0`
and `overflow-wrap` so content shrinks. What CSS cannot do:

- **say whether it worked**: it clips or scrolls; nothing reports "this stuck out" or "these two
  controls came out 3 px apart" (a font's fallback, an engine's native select, a theme that
  forgot one component, a language whose words are longer);
- equalize sizes across **separate containers** that share no grid (the label column of two
  fieldsets in different cards, all toolbar buttons as wide as the widest);
- align **baselines across rows**, or choose between layouts by more than one constraint.

So the plan is **check first, always; solve only where CSS can't express the relation**, and feed
what a solver computes back as tokens (custom properties), never replacing browser layout (GSS
did that and fought the browser).

## Invariants as data: the `lc:` layer

`ontology/layers/constraints.ttl` (`lc: <https://semblance.dev/ns/layout-constraints#>`):

```turtle
lc:fieldRowControlsShareTops a lc:Invariant ;
    lc:relation lc:SameTop ; lc:over lc:FieldRow ;
    lc:members lc:EachChild ; lc:part lc:SingleLineControl ; lc:tolerance 1.0 .
```

- **Relations** (`lc:Relation`): `SameBlockSize`, `SameInlineSize`, `SameTop`, `SameBottom`
  (groups: spread = max − min > tolerance), `FitsInline`, `FitsWithin` (containment),
  `ContentFits` (an element's own scroll width against its client width), `NoPageOverflow`.
  Borrowed from Galen's relational predicates (with tolerances) and ReDeCheck's failure taxonomy
  (protrusion, viewport protrusion, collision, wrapping).
- **Scope** `lc:over`: a class; each instance is one group or one container. Classes may be
  **derived** from layout vocabulary that already promises the invariant: `lc:FieldRow` is
  "a `pos:direction pos:Row` with two `lc:Field`s or more" (a SPARQL `lc:derive` CONSTRUCT).
  `pos:AlignedColumns` (part N of each column on one line) is the next derivation.
- **Members** `lc:members`: `lc:EachChild` (one per child: its first `lc:part`, or its root),
  `lc:Parts` (every part of a role inside), `lc:Descendants` (every component inside, but not
  inside a scroller between).
- **Parts** `lc:Role` with `lc:selector`, and `lc:pick [ lc:atWidth sty:CompactWidth ;
  lc:selector … ]` where a width class moves the part (a Choice's control is its pill when wide,
  its select on a phone, where the caption goes above it). Selectors are the spike's stand-in:
  the real design marks the part on the component's RDF/HTML (its minted `<focus>/~control`
  node carries `lc:role lc:SingleLineControl`), so the component author says which element is
  the control and the rendered-state effect measures exactly those nodes.
- **Lines**: a group in a row that wraps is compared line by line (`rnd:line`, which the host
  measures), so fields that wrap on a phone don't count as misaligned.
- Declared invariants in the spike: `formControlsShareHeight` (#34), `fieldRowControlsShareTops`
  and `…ShareHeight` (#57), `navItemsFit` and `navItemsShowTheirText` (#53),
  `contentStaysInCards` (cards and specimens), `pageFits`.

Where invariants are declared: on **components** (a nav list's items fit it), on **layers**
(derived from `pos:`), on **themes** (a theme may tighten a tolerance, or add `lc:atWidth`), and
on an **app** for its own pages.

## Geometry: the input

The checker reads rendered state as triples (#35, PR #100's `rnd:` layer, still open):
`?box rnd:of ?component ; rnd:x ; rnd:y ; rnd:width ; rnd:height`, in the
`urn:semblance:rendered` graph. The spike needs three additions to `rnd:`:

1. **part boxes**: `rnd:` measures component roots; the invariants compare controls and labels
   inside them (`lc:role`, `lc:index`);
2. **`rnd:parent`**, the box of the nearest observed component (PR #100 has `rnd:within`, every
   ancestor; the checker needs the nearest one for children);
3. **`rnd:scrollWidth`/`rnd:clientWidth` for any element** whose content overflows, and
   `rnd:line` for children of a wrapping row.

Precision: PR #100 rounds to whole px; the checker wants 0.01 px (a 0.5 px tolerance cannot be
checked on rounded values). Quantize the *stored* values only for churn, or keep two decimals.

## The checker

**SPARQL first**: `lc:Checker`'s `lc:select` finds every violation of every invariant over the
rendered graph, groups by `GROUP BY ?inv ?scope ?line HAVING spread > tolerance`, containment by
edge arithmetic. Its function twin is `src/layout/check.ts`, which runs a packed program (an
`Int32Array` of relation, tolerance, members) over packed boxes (`Float64Array`), and the
WASM twin `layout-solver/rust/src/check.rs` reads the same format. Findings are
`lc:Finding` (`lc:invariant`, `lc:scope`, `lc:member`, `lc:by` px).

Where checks run:

- **Tests**: `scripts/layout-check.ts` measures pages in a real browser (Chromium's headless shell
  over the DevTools protocol with Node's own WebSocket: no new dependency), across widths, themes
  and direction, and either records box trees (fixtures) or checks on the spot (`--check`).
  `test/layout-check.test.ts` runs both checkers over the recordings. A future CI job measures
  `main` at 320/375/768/1280 × every theme × en/uk/de/ar × ltr/rtl and fails on new findings.
- **Workbench**: one `sem:Query` sample, "Layout invariants broken", over the live rendered
  graph; the outline layer (`ol:`) marks the offending components on the page.
- **Live in dev**: a maintained view (IVM) of `lc:Checker`, so a box that moves re-checks only
  its groups (see cost).

## The solver

A small incremental **Cassowary** (kiwi's algorithm: edit variables and dual simplex), twice:
`src/layout/solver.ts` and `layout-solver/rust/src/solver.rs` (WASM), step for step the same
(rows and cells ordered alike, so both twins pivot identically; a parity test checks values
and pivot counts). It departs from kiwi in two places:

- **Dantzig's entering rule.** The symbol that improves the objective most enters the basis, not
  the first one that improves it. With kiwi's rule, the k-th of many constraints that share a
  variable (every row's `height ≥ control height`) re-pivoted the k before it: 10,195 pivots for
  100 fields, against 208 now. Dantzig's rule can cycle on a degenerate tableau, so after 64
  pivots in a row that make no progress, `optimize` switches to Bland's rule, which cannot cycle.
  On 200 random systems both rules reach equally good optima, and every required constraint holds.
- **A column index** (symbol → the rows that use it), so a pivot substitutes only into those rows.
  kiwi scans every row. Rows touched together are taken in the order they became basic, which is
  the order kiwi's scan would meet them in.

Together they turn the build from about n³ into about n^1.8 (2,000 fields: 0.5 s in TS). Neither
alone is enough: at 2,000 fields the rule without the index takes 7 s. What it may change: **only tokens**, written as custom properties on a scope's
root through the style layer's hooks (`--lc-label-column`, `--lc-button-width`), which CSS then
uses as it uses any token. Where it is worth it:

- one **label column across separate fieldsets** (as wide as the widest label, at most 40% of the
  page, controls keep 120 px): a `max()` over measured inputs with a cap and priorities;
- **equal widths across separate toolbars** or a dialog's footer and its body;
- **vertical rhythm** across columns that don't share a grid.

Measured inputs (a label's intrinsic width, the viewport) are edit variables: a language switch
or a resize is a handful of dual-simplex pivots, not a solve. Auto Layout's lesson holds: change
constants, never remove and re-add constraints per change.

## What the spike finds

Box trees were measured in Chromium (the cached headless shell, driven over the DevTools protocol with Node's own WebSocket, so no new dependency) on the commits before and after each fix:

| bug | before the fix | after |
|---|---|---|
| #34 controls of one form at different heights (999e2af → 19ae80a) | "A form's single-line controls are one height": the Role select is 4.5 px off in Classic and Cupertino, the date 3.5 px in Semblance | clean |
| #57 checkout code + phone (main → PR #125) | "Fields side by side line up": the Code pill's top is 27.5 px from the Phone input's, in Semblance, Doodle and RTL | clean; on a phone the row wraps and is checked line by line |
| #53 nav items out of their list (08b62ec → 27d4e65) | "Navigation items fit their list": every item is 9.3 px out at 375 px. No label on the site was long enough, so both checkouts were measured with one label lengthened, the way the issue's own theme test does it | clean |
| 320 px (70de219 → 71686f3) | Inspection: the dock panel is 43 px out of its specimen, and the page is 19 px too wide | page fits |
| 375 px (a050a46 → a5fc6b7) | Themes / Data / Type pages are 164–663 px too wide | page fits. Also caught: progress bars 8 px out of their specimens, the `c:Progress` 260 px minimum that 71686f3 fixed a day later |
| **main today, 320 px** | Components → Themes: a `c:Window` specimen 280 px wide inside a 172 px surface makes the page 51 px too wide | **open, not filed yet** |

The SPARQL checker and the function checker agree exactly on all 37 recordings. A test checks that agreement, and on its first run it caught a difference: the SPARQL side excused every scrolling container, but only `lc:Descendants` should.

## Benchmarks

Medians, measured through `scripts/test-queue.sh` on the shared machine (Node 26, Apple silicon). `layout-solver/bench.ts`; the WASM numbers include the calls across the boundary (and, for the checker, copying the boxes in).

#### Solver: form pages (one label column across fieldsets, equal buttons across toolbars)

| page | constraints | twin | full solve | resize (1 edit) | one label | all labels (language) | pivots/resize |
|---|---:|---|---:|---:|---:|---:|---:|
| small (10 fields) | 81 | ts | 0.72 ms | 7.8 µs | 1.3 µs | 19.2 µs | 2.5 |
| small (10 fields) | 81 | wasm | 0.17 ms | 1.3 µs | 0.5 µs | 6.9 µs | 2.5 |
| form (30 fields) | 227 | ts | 1.01 ms | 67.5 µs | 1.0 µs | 29.6 µs | 5.2 |
| form (30 fields) | 227 | wasm | 0.61 ms | 19.5 µs | 0.5 µs | 14.9 µs | 5.2 |
| medium (100 fields) | 735 | ts | 3.77 ms | 9.2 µs | 1.9 µs | 98.7 µs | 13.6 |
| medium (100 fields) | 735 | wasm | 1.04 ms | 3.7 µs | 0.8 µs | 41.7 µs | 13.6 |
| large (500 fields) | 3595 | ts | 42.25 ms | 95.9 µs | 1.5 µs | 0.91 ms | 51.5 |
| large (500 fields) | 3595 | wasm | 11.23 ms | 21.9 µs | 1.1 µs | 0.63 ms | 51.5 |
| huge (2000 fields) | 14185 | ts | 526.14 ms | 0.32 ms | 2.0 µs | 4.11 ms | 216.1 |
| huge (2000 fields) | 14185 | wasm | 113.44 ms | 0.16 ms | 1.3 µs | 7.97 ms | 216.1 |

Before the entering rule and the column index (kiwi's way), the full solve took 16.9 ms / 3.4 ms
(30 fields), 508 ms / 103 ms (100) and 68 s / 13 s (500), TS / WASM.

#### Checker: a whole page of boxes (cards of field rows, a nav list)

| page | boxes | invariants | findings | ts | wasm (with copy in) | sparql (wat store) |
|---|---:|---:|---:|---:|---:|---:|
| 10 cards | 454 | 112 | 3 | 17.5 µs | 5.6 µs | 4.07 ms |
| 100 cards | 4144 | 922 | 33 | 40.6 µs | 27.9 µs | 293.47 ms |
| 500 cards | 20544 | 4522 | 165 | 95.0 µs | 44.8 µs | - |

#### Size

| twin | raw | gzip | brotli | source lines |
|---|---:|---:|---:|---:|
| ts (minified) | 8.4 KiB | 3.0 KiB | 2.7 KiB | 606 |
| wasm (Rust, opt-level 3) | 58.3 KiB | 22.0 KiB | 18.2 KiB | 876 |

Reading the numbers:
- **Checking** a whole page is microseconds in TS and WASM: 20k boxes take under 0.1 ms. In SPARQL it is milliseconds: 4 ms for 450 boxes, 0.3 s for 4,000 (the `rnd:parent+` paths). Real pages have 20–140 boxes, and on those the SPARQL checker takes 0.3–9 ms per page on the WAT store. That is fine in tests and the workbench. Live checks in dev should use a maintained view. Checking is nowhere near a bottleneck in any twin. The cost that matters is measuring (one `getBoundingClientRect` batch per frame, which #35 already designs) and the browser runs in CI.
- **The solver's incremental re-solve** costs what it changes. A resize is 2.5–50 pivots (µs). A language switch, where every label is re-measured, takes 0.3 ms in TS for a 30-field form.
- **The algorithm mattered more than the language.** Kiwi's entering rule and full row scan made the build about cubic: 68 s in TS and 13 s in WASM for 500 fields. With Dantzig's rule and a column index it takes 42 ms and 11 ms, a 1,600× gain in TS against WASM's 5×. A 30-field form now builds in 1 ms (TS) or 0.6 ms (WASM), cold.
- **WASM is 1.5–4× faster than TS** for building and resizing, and about 2× for checking. Everything at realistic sizes is far below a frame in both. Relabelling all 2,000 fields of the huge page is the one case where WASM is slower (8 ms against 4 ms): Rust's column lists unlink by scan, where TS has a `Set`.
- **Size:** the TS solver and checker together are 3.0 KiB gzipped (8.4 KiB raw, 606 lines) minified; the Rust → WASM build is 22.0 KiB gzipped (58.3 KiB raw, 876 lines of Rust), plus a buffer ABI and a build step. The index and the hash map for rows' cells cost the WASM build 8 KiB gzipped. A WAT twin, following `rdf-engine/`, would be smaller, but would be a third copy of a 400-line algorithm for no measured gain.

## Recommendation

1. **Adopt the checker and the `lc:` vocabulary.** It is cheap, needs no new math, explains its findings, and has already found a live bug. Run it in CI on `main` across 320/375/768/1280 × the 10 themes × en/uk/de/ar (RTL included), failing on *new* findings, with a baseline that links known ones to their issues.
2. **Declare parts in RDF/HTML, not selectors.** The spike's `lc:selector` guesses which element is "the control". A component should say so on its minted node (`<focus>/~control lc:role lc:SingleLineControl`), so `rnd:` measures exactly those nodes.
3. **Keep the solver in TypeScript, off by default**, for the cross-container cases. It writes tokens through the style layer's hooks and nothing else. With Dantzig's rule and a column index its build is milliseconds even at 500 fields. Keep the Rust twin as the parity oracle. It is 7× the transfer size for a speedup nobody needs yet.
4. **Don't adopt Yoga or Taffy** (200–900 KB that re-implement the browser), and don't route layout through a solver (GSS).

## Follow-up issues (not filed; for your approval)

1. **`rnd:` for the checker** (on #35 / PR #100): part boxes with `lc:role` on minted part nodes, `rnd:parent`, `rnd:scrollWidth`/`clientWidth` per element, `rnd:line`, and two-decimal geometry.
2. **Parts in RDF/HTML:** `lc:role` on the control and label nodes of TextField, Choice (its pill, and its select at compact width), ShapeField, DateField, TimeField, Typeahead and NavList items. This replaces `lc:selector`.
3. **Layout CI job:** `scripts/layout-check.ts` over the site's pages × widths × themes × languages on `main` after a batch of merges (the coordinator's full-suite slot), with a baseline file of known findings.
4. **Fix:** the Themes page at 320 px. A `c:Window` specimen is 280 px wide inside a 172 px surface, so the page is 51 px too wide.
5. **Land PR #125** (#57). The checker confirms it fixes the checkout row in Semblance, Doodle and RTL, at 1280 and 375 px.
6. **Workbench sample "Layout invariants broken"**, plus outlines (`ol:`) on the offending components; a maintained view of `lc:Checker` for live checks in dev.
7. **More derived invariants:** `pos:AlignedColumns` (part N of each column on one line), a token comparison (`lc:equals tok:control-height`), baselines across a row.
8. **WebKit measurement**: `playwright install webkit` or Safari's driver. #34's 23 px select and 56c9b4e were WebKit-only, and Chromium can't see them.
9. **Solver cost tests:** `test/cost.test.ts` counts pivots and rows touched per edit, the way it counts rule firings, so a change that brings back the quadratic pivots fails there. (Dantzig's rule and the column index have landed on this branch.)
10. **Solver → tokens, only if wanted:** `lc:Solve` for one label column across fieldsets, written as `--lc-label-column`, with the strength review above.
