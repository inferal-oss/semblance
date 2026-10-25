---
name: generalize-review
description: Review Semblance components and layers (one, several, or all) for properties, styles, rules and behaviour that are not really specific to them, and either report where each belongs (an existing layer or shared vocabulary, or a new one) or carry out the refactoring across ontology, rules, theme, examples, walkthroughs, docs and tests. Use when asked to generalize, de-duplicate or audit components or layers, when a fix was made for one component or example and the same need exists elsewhere, or when reviewing a change that adds a property or style to a single component.
---

# Generalize review

Semblance's rule: **fix the class of problem where it lives, not where it showed up.** A property,
style, rule or reaction declared for one component (or written into one example) that expresses a
concept wider than that component belongs in a shared vocabulary or a layer, so every component
and app gets it once. This skill finds those, decides where they go, and - when asked - moves them.

Read `AGENTS.md` (ground rules, test queue) before changing anything.

**How it relates to `component-overlap`.** This skill is vertical: a component (or example) versus
the layers and shared vocabularies. `component-overlap` is horizontal: components duplicating each
other (same-job components, rules and function twins copied wholly or in part, style blocks copied
across components and themes). When two components share something that *is* about components (a
part, a capability, a rendering), the fix is a merge, subclass, shared part or building block:
hand it to `component-overlap`. When what they share is not about either of them, it is a
generalization and stays here.

## Modes

- **Report** (default; when the request says review, audit, find, check): produce the report below.
  Change nothing.
- **Refactor** (when the request says generalize, fix, move, refactor, or approves a report): do the
  refactorings, in the order of the procedure, one commit per refactoring.

The scope is what the request names: component classes (`c:Badge`), groups (`ontology/components/
inputs.ttl`), layers (`pos:`, `val:Layer`), an example (`demo/gallery/_ex-checkout.ttl`), or
everything.

## Find candidates

1. Run the finder for leads (Markdown on stdout; `--demo` adds the site's own Turtle; arguments
   narrow it to findings that mention them):

   ```bash
   npx tsx .agents/skills/generalize-review/scripts/candidates.ts --demo c:Badge pos:
   ```

   It reports: properties used beyond their declared class; the same style declaration repeated by
   three or more classes; function-only renderings grouped by reason; look-alike properties
   declared twice; reactions repeated across classes; vocabulary the site invented for itself.

2. Read the scoped files yourself for what a query cannot see. Signals:
   - **A property with a component as its domain whose meaning does not mention the component**
     (`c:hidden`, `c:disabled`, `c:to`, a width, a side, an alignment).
   - **Style rules that say a layout or behaviour fact** (`min-width: 0`, `justify-self: start`,
     `overflow: auto`, `display: contents`, an RTL flip) rather than the component's look.
   - **Rendering logic that is not about the component**: formatting a number or date, picking a
     language, deciding visibility, validating, resolving a link, computing a count.
   - **Per-instance workarounds in examples**: a `pos:Layout` or class in the `ui:` namespace, inline
     attributes, a component wrapped only to fix spacing, a reaction copied between examples.
   - **The same reaction for several classes**: a capability, i.e. a mixin class.
   - **A theme rule for one component that every themed component needs** (focus rings, insets).
   - **`sem:functionOnly` reasons that recur**: a missing building block (put the input in the graph).
   - **A test that pins behaviour for one component** when the behaviour is general.

## Decide where it belongs

Prefer, in this order: an existing shared property or layer; widening an existing one; a new
term in an existing layer; a new layer. Never a new component-specific property for a cross-cutting
concern.

| concern | home | mechanism |
|---|---|---|
| layout: direction, gap, inset, alignment, measure, tracks, guides | `pos:` (`ontology/layers/position.ttl`) | hookable property (`sty:hookAttribute`) whose values carry `sty:declares`; theme rules in `ontology/theme/layout.ttl` |
| look: tone, emphasis, size, text style, elevation, density, theme | `sty:` (`layers/style.ttl`, `theme/*.ttl`) | hook + tokens; `sty:when` value rules; `sty:atWidth` width classes |
| content-sized vs filling, overflow, `min-width: 0` | a general rule on the classes that share the fact, or a `pos:` value | one `sty:StyleRule` per class family, commented once |
| one component's value depending on another's | `dep:` (`layers/dependency.ttl`) | `dep:follows`, `dep:takes`, `dep:case`, `dep:defaults` |
| validation, required fields, messages | `val:` (`layers/validation.ttl`), component shapes (`ontology/shapes/`) | SHACL property shapes, `val:validates`, `val:requires` |
| accessible names, roles, relationships | `a11y:` | derived ARIA by IRI |
| labels per language, direction | `l10n:` | language-tagged literals, `l10n:label` |
| keys and arrow navigation | `key:` | `key:shortcut`, `key:navigation` patterns |
| where we are, links to resources, revealing | `nav:` | `nav:Dimension`, `c:to`, `nav:reveal` on the container class |
| dragging, dropping, ordering | `dnd:` | `dnd:Draggable`, `dnd:DropTarget`, SHACL acceptance |
| remembering state | `per:` | `per:Policy` |
| hiding sensitive data | `prv:` | `prv:concealed`, `prv:sensitive` |
| busy, announcements, motion | `st:`, `ann:`, `mot:` | `st:busy`, `ann:announces`, `mot:preference` |
| aggregates kept from changes | `iv:` (`layers/view.ttl`, `docs/IVM.md`) | `iv:View` |
| a capability several components share (drag, resize, dock, flip, select) | a mixin class (`c:Draggable`, `c:Flippable`) | reactions with `beh:sourceClass` the mixin; instances opt in by type |
| binding a control to a property of a node | `c:controls` / `c:property` | shared by every control |
| showing another node's data | `c:of`, `sem:follows c:of` | shared |

Create a **new layer** only when the concern cuts across components, needs its own rules (a
`sem:Rendering` with `sem:layer` and a stratum), and can be turned off without breaking components.
Otherwise add terms to the layer that owns the concern.

Recent generalizations to imitate (read their commits and files): `pos:measure` (a homepage's
width became a measure any component may take); content-sized components keep their size in grid
cells (a badge stretching in one specimen); `pos:guides` (showing cells for one specimen);
`c:OwnSide` (the chat composer and own messages share one side token); `dep:` (a checkout form that
follows the country became a dependency layer); `c:compactAs c:Picker` and `sty:atWidth` (phone
layouts); `c:to` on `c:AppBar` (a home link resolved like any link); label shapes accepting a
`c:Field` that labels its control.

## Refactor procedure

For each generalization, in one commit:

1. **Vocabulary.** Add or widen the term in the owning file, with `rdfs:label` (en, uk, de, ar where
   people see it) and an `rdfs:comment` that says what it means for any component. Remove the old
   component-specific term; do not leave aliases unless an external app may depend on it (then
   `owl:deprecated true` and `owl:equivalentProperty`). Update `ontology/alignments.ttl` if the old
   term was aligned.
2. **Rules.** Move the logic into the layer's rendering (SPARQL first, function twin with identical
   HTML), or into a hook's declarations. Delete it from every component rule that had it, in both
   implementations. Mind strata: a layer that a component's output depends on runs before it.
3. **Shapes.** Move constraints to the general term; update component shapes that referenced the
   old one.
4. **Theme.** Replace per-class rules with the general one; check every theme
   (`theme/themes-structural.ttl` included: theme rules sit in a later cascade layer and may have
   copied the old selector or attribute).
5. **Instances.** Grep `demo/`, `examples/`, `src/examples/`, `test/` for the old term and selectors
   and rewrite them. Remove example-level workarounds the generalization makes unnecessary.
6. **Walkthroughs.** Examples explain themselves with `c:Walkthrough` steps whose `c:Mention`s name
   resources (`c:mentions`) and link framework terms (`c:to`). Update mentions of moved terms and
   any step text that described the old place; `test/walkthrough.test.ts` checks every mention
   resolves.
7. **Docs.** Update `README.md` (layer list), `DESIGN.md` (design-system terms), `docs/COMPONENTS.md`,
   `docs/GETTING-STARTED.md`, the site's Docs page (`demo/gallery/_docs.ttl`) and the gallery
   specimen's `c:help`. The Reference page is derived from the ontology and needs no edit.
8. **Tests.** Keep or add a test that pins the general behaviour (compiled CSS, derived triples,
   SPARQL vs function parity, cost unchanged). Run the affected files through the queue:

   ```bash
   scripts/test-queue.sh npx vitest run --maxWorkers=4 test/<affected>.test.ts
   ```

   and `npx tsc --noEmit`; check new query shapes with `npx tsx rdf-engine/host/parse-check.ts wat`.
   Look at the result in the browser (`npm run dev`) in a few themes, at phone width, and in RTL.

Work in a git worktree when others share the checkout; stage only your own hunks.

## Report format

```markdown
# Generalization review: <scope>

## Findings
### <short name>
- **Now:** where it is declared or written (files, terms, line refs).
- **Why it is general:** which other components or examples need or already repeat it (evidence).
- **Belongs in:** <layer / shared term / new term>, as <property | hook value | mixin | layer rule>.
- **Change:** vocabulary, rules, theme, instances, walkthroughs, docs, tests touched.
- **Effort / risk:** small | medium | large; what could break.

## Not general (checked)
- <candidate>: why it really is specific to its component.

## Suggested order
1. ...
```

Rank findings by how many components or examples benefit, then by how small the change is.
