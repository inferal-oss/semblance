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
(insertion-ordered rows and cells, so both twins pivot identically; a parity test checks values
and pivot counts). What it may change: **only tokens**, written as custom properties on a scope's
root through the style layer's hooks (`--lc-label-column`, `--lc-button-width`), which CSS then
uses as it uses any token. Where it is worth it:

- one **label column across separate fieldsets** (as wide as the widest label, at most 40% of the
  page, controls keep 120 px): a `max()` over measured inputs with a cap and priorities;
- **equal widths across separate toolbars** or a dialog's footer and its body;
- **vertical rhythm** across columns that don't share a grid.

Measured inputs (a label's intrinsic width, the viewport) are edit variables: a language switch
or a resize is a handful of dual-simplex pivots, not a solve. Auto Layout's lesson holds: change
constants, never remove and re-add constraints per change.

## Cost model

See the benchmark section of the #167 comment for numbers.

## Follow-ups

Listed in the #167 comment.
