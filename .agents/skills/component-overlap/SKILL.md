---
name: component-overlap
description: Find overlap and duplication between Semblance components (one, several, or all) - components doing the same job, SPARQL rules and function twins that repeat each other wholly or in part, style blocks copied across components and themes, repeated reactions, shapes and tests - and either report it or, when asked, refactor it (merge, subclass, compose, extract a building block, share a style) while keeping SPARQL/function parity and every theme. Use when asked to de-duplicate, consolidate, unify or find overlap between components, when a new component looks like an existing one, when the same fix had to be made in several components or themes, or when a rule or function is long enough that part of it is probably a copy.
---

# Component overlap

Semblance's rule: **say a thing once.** Two components that render the same structure, read the
same properties, react the same way or carry the same style block are one concept written twice,
and the copies drift (a padding here, a radius there: #34 unified the controls' heights after
exactly that). This skill finds those copies - whole and partial - decides what the one place is,
and, when asked, makes it so.

Read `AGENTS.md` (ground rules, test queue) before changing anything.

**How it relates to `generalize-review`.** That skill is vertical: something declared for one
component that belongs in a layer or a shared vocabulary (`c:disabled` belongs to every control; a
`min-width: 0` is a layout fact). This one is horizontal: components duplicating *each other*. They
meet: when the thing two components share is not about either of them (formatting, visibility,
validation, layout, an ARIA relationship), it is a generalization - hand that finding to
`generalize-review` (its decision table says which layer) instead of inventing a shared component
part. Run both on a large review; report each finding once, under the skill whose fix it needs.

## Modes

- **Report** (default; when the request says find, review, audit, check, look for): produce the
  report below. Change nothing.
- **Fix** (when the request says de-duplicate, consolidate, merge, extract, fix, or approves a
  report): do the refactorings, in the order of the procedure, one commit per refactoring.

The scope is what the request names: component classes (`c:TextField c:TextArea`), a prefix
(`c:Date`), files (`inputs.ttl`, `dates.ts`), or everything.

## Find candidates

1. Run the finder for leads (Markdown on stdout, about two seconds; `--demo` adds the site's own
   Turtle; arguments narrow it to findings that mention them; `--min=0.6` is the similarity
   threshold, `--top=25` the rows per section):

   ```bash
   npx tsx .agents/skills/component-overlap/scripts/overlap.ts --demo c:Choice inputs.ttl
   ```

   It reports, per kind, **copies** (95 % alike or more, grouped) and **similar** pairs:
   - rendering rules (normalized SPARQL - variables, literals, IRIs and `$this` mints erased -
     compared as 4-token shingle sets);
   - **blocks shared by rendering rules**: partial duplication, a run of 24+ normalized tokens that
     occurs in two or more rules however different the rest is. `inside` marks a block repeated
     within one component (its screen and text rules re-deriving the same data). These are the
     targets for extraction;
   - fragments repeated across many components (the label/help/error trio, option lists, ARIA
     wiring);
   - reactions (event plus deletes/inserts);
   - identical style blocks (the same declaration set under different components, parts or
     themes) and near-identical ones (with what differs: the drift);
   - components with overlapping vocabularies (properties read by their rules and reactions or
     declared with them as domain, weighted by rarity);
   - function twins and helpers in `src/components/` (copies, similar, **shared blocks** of 40+
     tokens, and helpers inlined into other functions).

2. Read the scoped files yourself. The finder sees text; it does not see meaning. Signals:
   - **Same job, two names**: the same WAI-ARIA pattern, the same vocabulary, different classes
     (`c:Segmented`, `c:Chips`, `c:Choice`, `c:RadioGroup` all pick from `c:options` bound by
     `c:controls`/`c:property`; `c:Dialog` and `c:Drawer`; `c:Alert`, `c:Toast`, `c:EmptyState`).
   - **A rule that re-derives what another rule already derived**: the screen and text renderings
     of one component sharing a long `WHERE`; several components each computing an option's label
     from `l10n:label`, `c:label`, `rdfs:label` and the IRI.
   - **A function twin that repeats another's preamble** (`target`/`property` from `c:controls`,
     label/help/error, the Text-modality early return) or re-implements a helper in `util.ts`.
   - **A style block copied per component and per theme** (control padding, border, radius,
     background, focus ring) - and the near-copies, which are where the bugs are.
   - **Reactions with the same body for several source classes** (select, fold, sort, input).
   - **Shapes and tests copied per component**: the same SHACL property shape, the same test
     written once per class.

Not every match is a duplicate. Two rules that both mint a root and a text child are the grammar,
not a copy; the finder discounts what every rule has, but read before you report.

## Decide what the one place is

Pick the least machinery that removes the copy:

| situation | choice | mechanism |
|---|---|---|
| two classes, same vocabulary and behaviour, differing in look or one option | **merge** into one component with an option | one class; the difference is a property (`c:multiple`, `c:side`) or a `sty:` hook value; keep the old class as a subclass only if apps use it |
| one is the other plus something | **subclass** | `rdfs:subClassOf`; the subclass's rendering adds its part or the parent's rendering reads the extra property under `OPTIONAL`; reactions with `beh:sourceClass` the parent apply to both |
| both contain the same part (label/help/error, an option list, a close button, a popup) | **compose** a shared part | the part is a component of its own (`c:Field` labels a control; `c:IconButton` in a date field) minted as a child (`<focus>/~part`), rendered by its own rules |
| rules (or the screen and text rules of one component) re-derive the same data | **building block** | derive it once into the graph (a rule in an earlier stratum, a maintained `iv:View`, an engine feature) and let every rendering read the triple; SPARQL has no include, so share data, not text |
| several components need the same capability (select, fold, sort, drag) | **mixin class** | a class (a new `c:Selectable`, like `c:Draggable` or `c:Flippable`) with the reaction; components opt in by type |
| a style block repeated per component or per theme | **shared style** | one `sty:StyleRule` for the family (`sty:appliesTo` several classes, or a shared slug), a `sty:` hook value, or a theme custom property (`--bv-*`, `--mac-*`) the theme's rules use |
| the shared thing is not about components at all | **generalize** | hand to `generalize-review` (a layer or shared vocabulary) |

Prefer composing and building blocks over merging when the components are different things to a
person (a dialog and a drawer are different; their close button and actions row are one part).
Merge only when a person would call them the same control.

## Refactor procedure

For each refactoring, in one commit:

1. **Vocabulary.** Add the shared class, part, mixin or property with `rdfs:label` (en, uk, de,
   ar where people see it) and an `rdfs:comment` that says what it means for any component. Remove
   the duplicate terms; a merged class stays as `owl:deprecated true` with `owl:equivalentClass`
   (or a subclass) only when an external app may use it. Update `ontology/alignments.ttl` if the
   old term was aligned. Slugs are global: a shared part needs one slug, prefixed outside the
   framework.
2. **Rules: SPARQL and function twins together.** Write the shared rendering (or the derived
   triple) once in SPARQL and once as a function, and delete the copies from every rule that had
   them, in both implementations. Shared TypeScript goes to `src/components/util.ts` (or the
   layer's module). Mind strata: a building block that a rendering reads runs before it. Keep
   templates attributable to `$this`, use `EXISTS` over correlated `OPTIONAL`, and `sem:forEach`
   for collections (ground rule 6).
3. **Parity.** The SPARQL rule and its function twin render byte-identical HTML after every step of
   an interaction: run the parity tests for every component the refactoring touched, not only the
   one you started from.
4. **Reactions.** One reaction on the shared or mixin class; delete the per-class copies; check
   `beh:sourceClass` still matches every instance (subclass inference).
5. **Shapes.** Move the shared property shapes to the shared class or part; component shapes keep
   only what is theirs.
6. **Theme, every theme.** Replace the copied blocks with the shared rule, then audit
   `theme/themes-structural.ttl` (Classic, Tracker, Doodle, Cupertino, Fluent) and `themes.ttl`:
   theme rules sit in a later cascade layer and name components by `[data-sem-c=…]` in `sty:part`,
   so a merged or renamed slug breaks them silently. Where themes copied a block per component,
   make it one `:is(…)` rule per theme, or a theme custom property.
7. **Instances.** Grep `demo/`, `examples/`, `src/examples/`, `test/` for the old classes, slugs
   and selectors and rewrite them.
8. **Walkthroughs and docs.** Update `c:Walkthrough` mentions of moved terms
   (`test/walkthrough.test.ts` checks they resolve), `README.md`, `DESIGN.md`,
   `docs/COMPONENTS.md`, the Docs page (`demo/gallery/_docs.ttl`) and the specimens' `c:help`. The
   Reference page is derived and needs no edit.
9. **Tests.** Merge copied tests into one table-driven test over the classes that share the
   behaviour; keep a test that pins the shared part. Run the affected files through the queue:

   ```bash
   scripts/test-queue.sh npx vitest run --maxWorkers=2 test/<affected>.test.ts
   ```

   plus `test/cost.test.ts` (a building block must not make an interaction cost more), and
   `npx tsc --noEmit`; check new query shapes with `npx tsx rdf-engine/host/parse-check.ts wat`.
   Look at every touched component in the browser (`npm run dev`) in several themes, light and
   dark, at phone width and in RTL.

Several agents often work at once: before fixing a cluster, check open PRs and the plan issues for
work on the same components or styles, and coordinate rather than refactor under them. Work in a
git worktree; stage only your own hunks.

## Report format

```markdown
# Component overlap: <scope>

## Findings
### <short name>
- **Copies:** where (classes, rules, functions, style rules; files and line refs), whole or partial.
- **Evidence:** finder score or shared block, and what you read that confirms it is one concept.
- **One place:** merge | subclass | compose | building block | mixin | shared style | generalize
  (→ generalize-review), and what it is called.
- **Change:** vocabulary, rules (both twins), reactions, shapes, themes, instances, docs, tests.
- **Effort / risk:** small | medium | large; what could break (parity, a theme, an app's class).
- **In flight:** open issues or PRs touching the same code.

## Not duplicates (checked)
- <candidate>: why the likeness is the grammar, or two things a person tells apart.

## Suggested order
1. ...
```

Rank findings by how much text disappears and how many components or themes stop drifting, then by
how small the change is.
