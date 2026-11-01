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
- **Parts** `lc:Role`: a component's renderings say which node they mint is which part, on the
  node itself (`<field>/~input lc:role lc:SingleLineControl`, `<field>/~label lc:role
  lc:FieldLabel`, a nav list's option buttons `lc:NavItem`), in both twins. A part that has its
  role at one width only says so (`lc:atWidth`): an inline Choice's pill is its control where it is
  wide (`sty:RegularWidth`), its select on a phone (`sty:CompactWidth`), where the caption goes
  above it. The layer (`lc:PartHooks`, over the `lc:WithParts` mixin) marks the elements
  `data-sem-part="single-line-control"` and `data-sem-part-at="compact-width"`, so the
  rendered-state effect, a recording in a browser and a server-rendered page all find exactly
  those elements (#193; the spike guessed them with CSS selectors). Which element is the control
  is the component's call: a date field's control is its row, the outlined box that holds the
  input and its button, not the input inside.
- **Lines**: a group in a row that wraps is compared line by line (`rnd:line`, which the host
  measures), so fields that wrap on a phone don't count as misaligned.
- Declared invariants in the spike: `formControlsShareHeight` (#34), `fieldRowControlsShareTops`
  and `…ShareHeight` (#57), `navItemsFit` and `navItemsShowTheirText` (#53),
  `contentStaysInCards` (cards and specimens), `pageFits`.

Where invariants are declared: on **components** (a nav list's items fit it), on **layers**
(derived from `pos:`), on **themes** (a theme may tighten a tolerance, or add `lc:atWidth`), and
on an **app** for its own pages.

## Geometry: the input

The checker reads rendered state as triples (the `rnd:` layer, ontology/layers/rendered.ttl):
`?box rnd:of ?component ; rnd:x ; rnd:y ; rnd:width ; rnd:height`, in the
`urn:semblance:rendered` graph. A component asks for what the checker needs with
`rnd:observes rnd:Layout` (#192), for itself and everything shown inside it:

1. **part boxes**: a state per part its components name (`lc:role`, shown as `data-sem-part`,
   #193), `rnd:of` the part's node, with its `lc:role`, its `lc:index` (its order among its
   component's parts of that role) and `rnd:parent` its component's state. A part named at one
   width class only (`lc:atWidth`) is measured while the viewport is in it;
2. **`rnd:parent`**, the nearest observed component (`rnd:within` lists every one);
3. **`rnd:scrolls`** where a component clips its inline overflow, and otherwise
   **`rnd:scrollWidth`/`rnd:clientWidth`** where its content is wider (a part's always);
   **`rnd:line`** for the children of a row (`pos:direction pos:Row`, `pos:layout
   pos:FieldRow`); the viewport's `rnd:scrollWidth`, the document's width;
4. **hundredths of a pixel** (`xsd:decimal`; other aspects keep whole pixels), so a 0.5 px
   tolerance can be checked and #34's 3.5 px survives;
5. **layout boxes, before transforms** (`src/layout/box.ts`): a theme that tilts a card (Doodle)
   moves no box in it. The bounding box of a rotated element drifts along it (0.23 px per nav
   item in Doodle's tilted list), its layout box does not.

`checkSparql` runs `lc:Checker` over a live store: the rendered graph with the app's graph and
its projections' (where the components rules mint, a shape form's fields, are typed), what the
derivations type in a graph of its own that is taken out after the query. `fromRendered` reads
the same rendered graph into the box tree the function checker takes, and `test/layout-live.test.ts`
keeps the twins in agreement there. `scripts/layout-check.ts --source rnd` records a page from its
own rendered state (what the shell renders); in Chromium it gives the same box tree as the DOM
recorder (`--source dom`, the default, which also measures any older checkout).

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

A small incremental **Cassowary** (kiwi's algorithm: edit variables and dual simplex), three
times: `src/layout/solver.ts`, `layout-solver/wat/` (hand-written WebAssembly) and
`layout-solver/rust/src/solver.rs` (Rust → WebAssembly), step for step the same
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
| #57 checkout code + phone (main → PR #125) | "Fields side by side line up": the Code pill's top is 27.5 px from the Phone input's, in Semblance, Doodle and RTL | clean in Semblance and RTL, at 1280 and 375 px (the row wraps on a phone and is checked line by line); Doodle shows 1.1 px, its tilted card (see below) |
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
| small (10 fields) | 81 | ts | 0.86 ms | 8.4 µs | 1.4 µs | 28.2 µs | 2.5 |
| small (10 fields) | 81 | rust | 0.21 ms | 2.3 µs | 0.6 µs | 10.4 µs | 2.5 |
| small (10 fields) | 81 | wat | 0.15 ms | 2.9 µs | 0.5 µs | 9.9 µs | 2.5 |
| form (30 fields) | 227 | ts | 1.53 ms | 66.8 µs | 0.6 µs | 32.4 µs | 5.2 |
| form (30 fields) | 227 | rust | 0.50 ms | 16.2 µs | 0.4 µs | 10.9 µs | 5.2 |
| form (30 fields) | 227 | wat | 0.27 ms | 27.6 µs | 0.3 µs | 13.6 µs | 5.2 |
| medium (100 fields) | 735 | ts | 3.17 ms | 8.8 µs | 1.7 µs | 99.4 µs | 13.6 |
| medium (100 fields) | 735 | rust | 0.87 ms | 3.3 µs | 0.4 µs | 27.1 µs | 13.6 |
| medium (100 fields) | 735 | wat | 0.72 ms | 5.6 µs | 0.5 µs | 28.0 µs | 13.6 |
| large (500 fields) | 3595 | ts | 39.90 ms | 62.8 µs | 1.4 µs | 0.82 ms | 51.5 |
| large (500 fields) | 3595 | rust | 9.01 ms | 18.0 µs | 0.7 µs | 0.18 ms | 51.5 |
| large (500 fields) | 3595 | wat | 8.16 ms | 28.7 µs | 0.7 µs | 0.19 ms | 51.5 |
| huge (2000 fields) | 14185 | ts | 561.19 ms | 0.28 ms | 2.4 µs | 3.22 ms | 216.1 |
| huge (2000 fields) | 14185 | rust | 103.33 ms | 84.4 µs | 0.8 µs | 1.00 ms | 216.1 |
| huge (2000 fields) | 14185 | wat | 105.09 ms | 0.19 ms | 0.6 µs | 0.54 ms | 216.1 |

Before the entering rule and the column index (kiwi's way), the full solve took 16.9 ms / 3.4 ms
(30 fields), 508 ms / 103 ms (100) and 68 s / 13 s (500), TS / WASM.

#### Checker: a whole page of boxes (cards of field rows, a nav list)

| page | boxes | invariants | findings | ts | rust (with copy in) | wat (with copy in) | sparql (wat store) |
|---|---:|---:|---:|---:|---:|---:|---:|
| 10 cards | 454 | 112 | 3 | 15.0 µs | 5.2 µs | 7.2 µs | 3.77 ms |
| 100 cards | 4144 | 922 | 33 | 21.8 µs | 27.0 µs | 59.6 µs | 282.12 ms |
| 500 cards | 20544 | 4522 | 165 | 94.2 µs | 44.7 µs | 35.8 µs | - |

#### Size

| twin | raw | gzip | brotli | source lines |
|---|---:|---:|---:|---:|
| ts (minified, solver and checker) | 8.4 KiB | 3.0 KiB | 2.7 KiB | 619 |
| rust (Rust, opt-level 3) | 65.0 KiB | 24.5 KiB | 20.2 KiB | 906 |
| wat (hand-written WAT) | 7.7 KiB | 3.7 KiB | 3.4 KiB | 1273 |

Reading the numbers:
- **Checking** a whole page is microseconds in TS and WASM: 20k boxes take under 0.1 ms. In SPARQL it is milliseconds: 4 ms for 450 boxes, 0.3 s for 4,000 (the `rnd:parent+` paths). Real pages have 20–140 boxes, and on those the SPARQL checker takes 0.3–9 ms per page on the WAT store. That is fine in tests and the workbench. Live checks in dev should use a maintained view. Checking is nowhere near a bottleneck in any twin. The cost that matters is measuring (one `getBoundingClientRect` batch per frame, which #35 already designs) and the browser runs in CI.
- **The solver's incremental re-solve** costs what it changes. A resize is 2.5–50 pivots (µs). A language switch, where every label is re-measured, takes 0.3 ms in TS for a 30-field form.
- **The algorithm mattered more than the language.** Kiwi's entering rule and full row scan made the build about cubic: 68 s in TS and 13 s in WASM for 500 fields. With Dantzig's rule and a column index it takes 42 ms and 11 ms, a 1,600× gain in TS against WASM's 5×. A 30-field form now builds in 1 ms (TS) or 0.6 ms (WASM), cold.
- **WASM is 1.5–5× faster than TS** for building and resizing, and about 2× for checking large pages. Everything at realistic sizes is far below a frame in all three.
- **WAT is as fast as Rust**: faster on full solves up to 500 fields (0.27 against 0.50 ms for 30 fields), level at 2,000, slower on a single resize (µs either way), twice as fast relabelling 2,000 fields. Rust's column index first removed by scan, which made that relabel slower than TS; it removes lazily now, like the WAT.
- **Size:** WAT is 3.7 KiB gzipped (7.7 KiB raw), about TypeScript's 3.0 KiB; Rust is 24.5 KiB gzipped (65 KiB raw: the standard library's hash map, sort and allocator). So **WAT is the default** (`LAYOUT_PREFERENCE` in `src/layout/engine.ts`: wat, rust, ts): Rust's speed at TypeScript's size. Rust and TypeScript stay as parity twins and backups.

## Recommendation

1. **Adopt the checker and the `lc:` vocabulary.** It is cheap, needs no new math, explains its findings, and has already found a live bug. Run it in CI on `main` across 320/375/768/1280 × the 10 themes × en/uk/de/ar (RTL included), failing on *new* findings, with a baseline that links known ones to their issues.
2. **Declare parts in RDF/HTML, not selectors.** The spike's `lc:selector` guessed which element is "the control". A component says so on its minted node (`<focus>/~control lc:role lc:SingleLineControl`), so `rnd:` measures exactly those nodes (done in #193).
3. **Solve and check in WASM by default, TypeScript as the backup.** `initLayout()` (the node and web loaders) compiles the builds present, and `createLayoutSolver()` / `checkLayout()` take the first of WAT, Rust and TypeScript that instantiates. The solver stays off by default for pages, for the cross-container cases only, and writes tokens through the style layer's hooks and nothing else. With Dantzig's rule and a column index its build is milliseconds even at 500 fields. All three twins stay under the parity tests.
4. **Don't adopt Yoga or Taffy** (200–900 KB that re-implement the browser), and don't route layout through a solver (GSS).

## Follow-up issues

- #192 the checker reads geometry from `rnd:` (part boxes, `rnd:parent`, scroll sizes, `rnd:line`, two-decimal geometry)
- #193 parts in RDF/HTML: `lc:role` on minted part nodes, replacing `lc:selector`
- #194 a layout CI job on `main`: pages × widths × themes × languages, with a baseline of known findings
- #195 fix: the Themes page at 320 px (a `c:Window` specimen 280 px wide in a 172 px surface)
- #196 workbench sample "Layout invariants broken", outlines on the offenders, a maintained view for live checks in dev
- #197 more invariants: aligned columns, token sizes, baselines
- #198 measure in WebKit (#34's select and 56c9b4e were WebKit-only)
- #199 solver cost tests: pivots and rows touched per edit, every twin
- #200 solver → tokens: `lc:Solve` for one label column across fieldsets

#57's checkout row is fixed by PR #125, now merged. The first "after" recording proved nothing: on
a loaded machine the update after "Continue to shipping" outran the watchdog's turn budget, the page
waited behind "The page is busy", and no field was measured, so the check passed with nothing to
check. `scripts/layout-check.ts` now resumes suspended updates. Re-recorded on `main`, the row is clean
in Semblance and RTL, and in Doodle it is 1.1 px off: Doodle tilts its card, and rotated boxes drift
about 0.55 px per field along a row. That recording has transformed boxes; both recorders and
`rnd:Layout` measure layout boxes since #192, so a theme's tilt is not a misalignment. The
checkout is re-recorded once it renders again (on `main` it stops at a stratification error of
`c:DescriptionPairs`, #7). #125 also
changed the field anatomy: `lc:FieldRow` now covers `pos:FieldRow`, and a Choice with its label
above is a label (its span) and a control (its select) like any field.
